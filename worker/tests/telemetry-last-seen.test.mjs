import assert from 'node:assert/strict';
import { TelemetryBuffer, readFleetLatestAgentStates, readFleetLatestSnapshot, touchBufferedAgentLastSeen } from '../src/telemetry-buffer.js';
import { nowSec } from '../src/utils.js';

// The offline alert clock must come from a heartbeat that is recorded on every
// accepted report, independent of the 300s-throttled latest state and the
// 900s-throttled D1 mirror. These tests pin the DO-side plumbing end to end.

class FakeAgentSocket {
  constructor() {
    this.sent = [];
    this.attachment = null;
  }

  send(data) { this.sent.push(JSON.parse(data)); }

  serializeAttachment(value) { this.attachment = structuredClone(value); }

  deserializeAttachment() { return this.attachment; }
}

globalThis.WebSocketPair = function WebSocketPair() {
  const client = new FakeAgentSocket();
  const server = new FakeAgentSocket();
  client.server = server;
  return { 0: client, 1: server };
};

const SECRET = 'telemetry-test-secret';

function testEnv(extra = {}) {
  return { INTERNAL_CRON_SECRET: SECRET, ...extra };
}

function memoryStorage() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    async list({ prefix = '', limit = Number.MAX_SAFE_INTEGER, startAfter } = {}) {
      return new Map([...values]
        .filter(([key]) => key.startsWith(prefix) && (startAfter === undefined || key > startAfter))
        .slice(0, limit));
    },
    async getAlarm() { return null; },
    async setAlarm() {},
    async transaction(callback) { return callback(this); },
    async acceptWebSocket() {},
  };
}

function mockD1() {
  return {
    prepare() {
      return {
        bind() { return this; },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 0 } }; },
      };
    },
    async batch() { return []; },
  };
}

async function fleetSnapshot(buffer) {
  const response = await buffer.fetch(new Request('https://nie-sla.internal/fleet/latest', {
    headers: { 'x-nie-sla-internal-secret': SECRET },
  }));
  return response.json();
}

async function openAgentSocket(buffer, agentId) {
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
        'x-nie-sla-internal-secret': SECRET,
      },
    }));
    assert.equal(response.status, 101);
    return response.webSocket.server;
  } finally {
    globalThis.Response = realResponse;
  }
}

const storage = memoryStorage();
const buffer = new TelemetryBuffer({ storage, acceptWebSocket() {} }, testEnv({ DB: mockD1() }));

// The first heartbeat is always persisted, later ones are batched in 120s steps.
await buffer.recordAgentLastSeen('vps-a', 1000);
assert.equal(await storage.get('last:seen:vps-a'), 1000, 'the first heartbeat must persist');
await buffer.recordAgentLastSeen('vps-a', 1030);
assert.equal(await storage.get('last:seen:vps-a'), 1000, 'the durable heartbeat must be throttled');
let snapshot = await fleetSnapshot(buffer);
assert.equal(snapshot.last_seen['vps-a'], 1030, 'the in-memory heartbeat must win over the stored copy');
await buffer.recordAgentLastSeen('vps-a', 1200);
assert.equal(await storage.get('last:seen:vps-a'), 1200, 'the durable heartbeat must advance once the window elapses');

// HTTP fallback heartbeats arrive through the internal route.
const touchResponse = await buffer.fetch(new Request('https://nie-sla.internal/last-seen', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-nie-sla-internal-secret': SECRET },
  body: JSON.stringify({ agent_id: 'vps-b', seen_at: 1300 }),
}));
assert.equal(touchResponse.ok, true);
const touchBody = await touchResponse.json();
assert.deepEqual([touchBody.ok, touchBody.agent_id, touchBody.last_seen], [true, 'vps-b', 1300]);
snapshot = await fleetSnapshot(buffer);
assert.equal(snapshot.last_seen['vps-b'], 1300, 'HTTP fallback heartbeats must be visible to fleet readers');
assert.equal(snapshot.last_seen['vps-a'], 1200);

// A WSS report records its own heartbeat without waiting for the drain.
const socket = await openAgentSocket(buffer, 'vps-ws');
const before = nowSec();
await buffer.webSocketMessage(socket, JSON.stringify({
  type: 'metrics',
  payload: {
    agent_id: 'vps-ws',
    metrics: { cpu_percent: 5, memory: { used_mb: 1, total_mb: 2 }, disk: { used_gb: 1, total_gb: 2 }, net: { rx_bytes: 1, tx_bytes: 1 } },
  },
}));
snapshot = await fleetSnapshot(buffer);
assert.ok(Number(snapshot.last_seen['vps-ws']) >= before, 'a WSS report must record a heartbeat immediately');
assert.ok(await storage.get('last:seen:vps-ws') >= before, 'the WSS heartbeat must be durable right away');

// Deleting an Agent must not leave its heartbeat behind.
await buffer.fetch(new Request('https://nie-sla.internal/latest?agent_id=vps-a', {
  method: 'DELETE',
  headers: { 'x-nie-sla-internal-secret': SECRET },
}));
assert.equal(await storage.get('last:seen:vps-a'), undefined);
snapshot = await fleetSnapshot(buffer);
assert.equal(snapshot.last_seen['vps-a'], undefined, 'fleet readers must not see a deleted Agent heartbeat');

// Worker-side helper: one internal request per HTTP report, no retries.
const calls = [];
const env = {
  INTERNAL_CRON_SECRET: SECRET,
  TELEMETRY_BUFFER: {
    idFromName(name) { return { name }; },
    get() {
      return {
        async fetch(url, init) {
          calls.push({ url: String(url), body: JSON.parse(init.body) });
          return Response.json({ ok: true, agent_id: 'vps-b', last_seen: 999 });
        },
      };
    },
  },
};
assert.equal(await touchBufferedAgentLastSeen(env, 'vps-b', 999), true);
assert.match(calls[0].url, /\/last-seen$/);
assert.deepEqual(calls[0].body, { agent_id: 'vps-b', seen_at: 999 });

const fleetEnv = {
  INTERNAL_CRON_SECRET: SECRET,
  TELEMETRY_BUFFER: {
    idFromName(name) { return { name }; },
    get() {
      return {
        async fetch() {
          return Response.json({ ok: true, states: { 'vps-a': { agent_id: 'vps-a', updated_at: 1 } }, last_seen: { 'vps-a': 1234 } });
        },
      };
    },
  },
};
const parsed = await readFleetLatestSnapshot(fleetEnv);
assert.equal(parsed.states['vps-a'].updated_at, 1);
assert.equal(parsed.lastSeen['vps-a'], 1234);
assert.deepEqual(await readFleetLatestAgentStates(fleetEnv), parsed.states, 'the legacy helper keeps returning states only');
assert.deepEqual(await readFleetLatestSnapshot({}), { states: {}, lastSeen: {} }, 'missing DO bindings must degrade safely');

const failingEnv = {
  INTERNAL_CRON_SECRET: SECRET,
  TELEMETRY_BUFFER: {
    idFromName(name) { return { name }; },
    get() { return { async fetch() { return new Response('boom', { status: 500 }); } }; },
  },
};
assert.deepEqual(await readFleetLatestSnapshot(failingEnv), { states: {}, lastSeen: {} });
assert.equal(await touchBufferedAgentLastSeen({}, 'vps-a'), false, 'no DO binding means no heartbeat request');

console.log('telemetry last-seen tests passed');
