import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  getAdaptiveReportInterval,
  readViewerCount,
  viewerCacheTtlSec,
  resetAdaptiveReportCacheForTests,
} from '../src/adaptive-report.js';
import { internalRequestHeaders } from '../src/auth.js';
import { processAgentMetricsPayload } from '../src/metrics.js';
import { StatusStream } from '../src/status-stream.js';
import { TelemetryBuffer } from '../src/telemetry-buffer.js';

globalThis.crypto ||= webcrypto;

const INTERNAL_SECRET = 'adaptive-test-secret';

class FakeAgentSocket {
  constructor() {
    this.sent = [];
    this.attachment = null;
  }

  send(data) { this.sent.push(JSON.parse(data)); }

  serializeAttachment(value) { this.attachment = structuredClone(value); }

  deserializeAttachment() { return this.attachment; }
}

// Minimal WebSocketPair/socket fakes must exist before any WSS test runs.
globalThis.WebSocketPair = function WebSocketPair() {
  const client = new FakeAgentSocket();
  const server = new FakeAgentSocket();
  client.server = server;
  return { 0: client, 1: server };
};

function viewerEnv(viewers, extra = {}) {
  const state = { calls: 0, fail: false };
  const env = {
    INTERNAL_CRON_SECRET: INTERNAL_SECRET,
    STATUS_STREAM: {
      idFromName: () => 'stream-id',
      get: () => ({
        fetch: async () => {
          state.calls += 1;
          if (state.fail) throw new Error('status stream unavailable');
          return Response.json({ ok: true, viewers });
        },
      }),
    },
    ...extra,
  };
  return { env, state };
}

function mockD1() {
  return {
    prepare() {
      const statement = {
        bind() { return statement; },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 0 } }; },
      };
      return statement;
    },
    async batch() { return []; },
  };
}

function memoryStorage() {
  const values = new Map();
  let alarm = null;
  const api = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    async deleteAll() { values.clear(); alarm = null; },
    async list({ prefix = '', limit = Number.MAX_SAFE_INTEGER, startAfter } = {}) {
      return new Map([...values]
        .filter(([key]) => key.startsWith(prefix) && (startAfter === undefined || key > startAfter))
        .slice(0, limit));
    },
    async getAlarm() { return alarm; },
    async setAlarm(value) { alarm = value; },
    async transaction(callback) { return callback(api); },
    async acceptWebSocket() {},
  };
  return api;
}

async function openAgentSocket(buffer, agentId) {
  // Node's undici Response rejects the 101 upgrade status and drops the
  // workerd-only webSocket init, so shim it just for the DO handshake.
  const realResponse = globalThis.Response;
  globalThis.Response = class extends realResponse {
    constructor(body, init = {}) {
      const { webSocket, ...rest } = init;
      if (webSocket !== undefined) {
        super(body, { ...rest, status: 200 });
        Object.defineProperty(this, 'status', { value: init.status });
        Object.defineProperty(this, 'webSocket', { value: webSocket });
      } else {
        super(body, rest);
      }
    }
  };
  try {
    const response = await buffer.fetch(new Request('https://nie-sla.internal/agent-metrics/ws', {
      headers: {
        upgrade: 'websocket',
        'x-nie-sla-agent-id': agentId,
        'x-nie-sla-internal-secret': INTERNAL_SECRET,
      },
    }));
    assert.equal(response.status, 101);
    return response.webSocket.server;
  } finally {
    globalThis.Response = realResponse;
  }
}

async function sendAgentMetrics(buffer, socket, payload) {
  await buffer.webSocketMessage(socket, JSON.stringify({ type: 'metrics', payload }));
}

const metricsPayload = {
  agent_id: 'vps-a',
  agent_label: 'vps-a',
  agent_version: 'v1.1.95',
  capabilities: {},
  metrics: {
    hostname: 'host-a',
    cpu_percent: 10,
    memory: { used_mb: 1, total_mb: 2 },
    disk: { used_gb: 1, total_gb: 2 },
  },
};

// 1. A live viewer makes Agents report fast (default 60s) and the DO is read
//    at most once per short TTL, not once per upload.
{
  resetAdaptiveReportCacheForTests();
  const { env, state } = viewerEnv(2);
  assert.equal(await getAdaptiveReportInterval(env), 60, 'viewers>0 must use ADAPTIVE_FAST_SEC');
  assert.equal(await getAdaptiveReportInterval(env), 60);
  assert.equal(state.calls, 1, 'repeat uploads inside the TTL must not re-read the DO');
  assert.equal(await readViewerCount(env, { now: Date.now() + 60_000 }), 2, 'expired cache must refresh');
  assert.equal(state.calls, 2);
}

// 2. No viewers falls back to the idle interval (default 300s).
{
  resetAdaptiveReportCacheForTests();
  const { env } = viewerEnv(0);
  assert.equal(await getAdaptiveReportInterval(env), 300, 'viewers=0 must use ADAPTIVE_IDLE_SEC');
}

// 3. Disabled feature omits the field entirely so the Agent keeps its interval.
{
  resetAdaptiveReportCacheForTests();
  const { env, state } = viewerEnv(5, { ADAPTIVE_REPORT_ENABLED: 'false' });
  assert.equal(await getAdaptiveReportInterval(env), null);
  assert.equal(state.calls, 0, 'disabled adaptive reporting must not probe the status stream');
  resetAdaptiveReportCacheForTests();
  const { env: enabledEnv } = viewerEnv(5, { ADAPTIVE_REPORT_ENABLED: 'true' });
  assert.equal(await getAdaptiveReportInterval(enabledEnv), 60);
}

// 4. Env overrides are clamped to 10..3600 and invalid values fall back.
{
  resetAdaptiveReportCacheForTests();
  const { env: fastEnv } = viewerEnv(1, { ADAPTIVE_FAST_SEC: '5' });
  assert.equal(await getAdaptiveReportInterval(fastEnv), 10, 'fast interval must clamp up to 10');
  resetAdaptiveReportCacheForTests();
  const { env: slowEnv } = viewerEnv(0, { ADAPTIVE_IDLE_SEC: '99999' });
  assert.equal(await getAdaptiveReportInterval(slowEnv), 3600, 'idle interval must clamp down to 3600');
  resetAdaptiveReportCacheForTests();
  const { env: invalidEnv } = viewerEnv(0, { ADAPTIVE_IDLE_SEC: 'not-a-number' });
  assert.equal(await getAdaptiveReportInterval(invalidEnv), 300, 'invalid env values must fall back');
  assert.equal(viewerCacheTtlSec({ ADAPTIVE_VIEWER_CACHE_SEC: '1' }), 5);
  assert.equal(viewerCacheTtlSec({ ADAPTIVE_VIEWER_CACHE_SEC: '999' }), 60);
  assert.equal(viewerCacheTtlSec({}), 15);
}

// 5. A failed viewer refresh keeps the last known count; a missing binding is idle.
{
  resetAdaptiveReportCacheForTests();
  const { env, state } = viewerEnv(2);
  assert.equal(await readViewerCount(env), 2);
  state.fail = true;
  assert.equal(await readViewerCount(env, { now: Date.now() + 60_000 }), 2, 'transient failures must keep the last count');
  resetAdaptiveReportCacheForTests();
  assert.equal(await getAdaptiveReportInterval({ ADAPTIVE_REPORT_ENABLED: true }), 300, 'missing STATUS_STREAM binding counts as idle');
}

// 6. HTTP metrics path: the field appears when adaptive is enabled and is
//    omitted when disabled.
{
  resetAdaptiveReportCacheForTests();
  const { env } = viewerEnv(1, { DB: mockD1() });
  const result = await processAgentMetricsPayload(env, structuredClone(metricsPayload), null, 'vps-a');
  assert.equal(result.ok, true);
  assert.equal(result.report_interval_sec, 60, 'HTTP response must carry the viewer-gated interval');
  resetAdaptiveReportCacheForTests();
  const { env: disabledEnv } = viewerEnv(1, { DB: mockD1(), ADAPTIVE_REPORT_ENABLED: 'false' });
  const disabledResult = await processAgentMetricsPayload(disabledEnv, structuredClone(metricsPayload), null, 'vps-a');
  assert.equal('report_interval_sec' in disabledResult, false, 'disabled adaptive reporting must omit the field');
}

// 7. WSS metrics path: the same value must reach the metrics_ack (top level and
//    the control snapshot), and must be absent when disabled.
{
  resetAdaptiveReportCacheForTests();
  const { env } = viewerEnv(3, { DB: mockD1() });
  const buffer = new TelemetryBuffer({ storage: memoryStorage(), acceptWebSocket() {} }, env);
  const socket = await openAgentSocket(buffer, 'vps-a');
  await sendAgentMetrics(buffer, socket, structuredClone(metricsPayload));
  const ack = socket.sent.find((message) => message.type === 'metrics_ack');
  assert.ok(ack, 'WSS metrics must be acknowledged');
  assert.equal(ack.report_interval_sec, 60, 'WSS ack must carry the viewer-gated interval');
  assert.equal(ack.control?.report_interval_sec, 60, 'WSS control snapshot must carry the same interval');

  resetAdaptiveReportCacheForTests();
  const { env: disabledEnv } = viewerEnv(3, { DB: mockD1(), ADAPTIVE_REPORT_ENABLED: 'false' });
  const disabledBuffer = new TelemetryBuffer({ storage: memoryStorage(), acceptWebSocket() {} }, disabledEnv);
  const disabledSocket = await openAgentSocket(disabledBuffer, 'vps-b');
  await sendAgentMetrics(disabledBuffer, disabledSocket, structuredClone({ ...metricsPayload, agent_id: 'vps-b' }));
  const disabledAck = disabledSocket.sent.find((message) => message.type === 'metrics_ack');
  assert.ok(disabledAck, 'WSS metrics must be acknowledged when disabled');
  assert.equal('report_interval_sec' in disabledAck, false, 'disabled adaptive reporting must omit the WSS top-level field');
  assert.equal('report_interval_sec' in (disabledAck.control || {}), false, 'disabled adaptive reporting must omit the WSS control field');
}

// 8. The StatusStream DO exposes the live viewer count to internal callers only.
{
  const sockets = [{}, {}];
  const state = {
    getWebSockets() { return sockets; },
    acceptWebSocket() {},
  };
  const streamEnv = { INTERNAL_CRON_SECRET: INTERNAL_SECRET };
  const stream = new StatusStream(state, streamEnv);
  const response = await stream.fetch(new Request('https://nie-sla.internal/viewers', {
    headers: internalRequestHeaders(streamEnv),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).viewers, 2, 'the viewers endpoint must return the live socket count');
  const denied = await stream.fetch(new Request('https://nie-sla.internal/viewers'));
  assert.equal(denied.status, 401, 'the viewers endpoint must reject internal callers without the secret');
}

console.log('adaptive report tests passed');
