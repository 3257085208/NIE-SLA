import assert from 'node:assert/strict';
import { TelemetryBuffer } from '../src/telemetry-buffer.js';
import { nowSec } from '../src/utils.js';

class FakeAgentSocket {
  constructor() {
    this.sent = [];
    this.attachment = null;
    this.server = null;
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

const currentHour = Math.floor(Date.now() / 3_600_000) * 3600;
const completedHour = currentHour - 7200;
const storage = memoryStorage();
const archive = memoryR2();
const buffer = new TelemetryBuffer({ storage }, testEnv({ ARCHIVE: archive }));

await append(buffer, {
  agent_id: 'vps-a',
  points: [{
    ts: currentHour + 10,
    cpu: 10,
    temperature_sensors: [{ id: 'pch:temp1', label: 'PCH', kind: 'chipset', temp_c: 34 }],
  }],
  pings: [{ target_id: 'cn', ts: currentHour + 10, latency_ms: null, ok: 0 }],
});
await append(buffer, {
  agent_id: 'vps-a',
  points: [
    {
      ts: currentHour + 10,
      cpu: 11,
      temperature_sensors: [{ id: 'pch:temp1', label: 'PCH', kind: 'chipset', temp_c: 35 }],
    },
    {
      ts: currentHour + 310,
      cpu: 20,
      temperature_sensors: [{ id: 'pch:temp1', label: 'PCH', kind: 'chipset', temp_c: 36 }],
    },
  ],
  pings: [
    { target_id: 'cn', ts: currentHour + 10, latency_ms: null, ok: 0 },
    { target_id: 'cn', ts: currentHour + 310, latency_ms: 30, ok: 1 },
  ],
});

assert.equal((await storage.list({ prefix: 'chunk:' })).size, 2, 'active data uses fixed five-minute chunks');
const live = await buffer.read(currentHour, currentHour + 3599);
assert.deepEqual(live.points.map(point => point.cpu), [11, 20], 'same-chunk retries are idempotent');
assert.deepEqual(live.points.map(point => point.temperature_sensors), [
  [{ id: 'pch:temp1', label: 'PCH', kind: 'chipset', temp_c: 35 }],
  [{ id: 'pch:temp1', label: 'PCH', kind: 'chipset', temp_c: 36 }],
], 'dynamic temperature sensors must survive buffered retries');
assert.deepEqual(live.pings.map(point => point.latency_ms), [null, 30], 'loss samples retain null latency');

const latestState = {
  schema: 'nie-sla-agent-metrics-v1',
  agent_id: 'vps-a',
  updated_at: new Date((currentHour + 20) * 1000).toISOString(),
  cpu_percent: 42,
};
await storage.put('latest:state:vps-a', latestState);
const latestResponse = await buffer.fetch(new Request('https://nie-sla.internal/latest?agent_id=vps-a', {
  headers: { 'x-nie-sla-internal-secret': 'telemetry-test-secret' },
}));
assert.deepEqual((await latestResponse.json()).state, latestState, 'per-Agent latest state is readable from the buffer');
const latestWithoutAgent = await buffer.fetch(new Request('https://nie-sla.internal/latest', {
  headers: { 'x-nie-sla-internal-secret': 'telemetry-test-secret' },
}));
assert.equal(latestWithoutAgent.status, 400, 'the internal /latest endpoint must require an agent_id parameter');

const fleetRead = await buffer.fetch(new Request('https://nie-sla.internal/fleet/latest', {
  headers: { 'x-nie-sla-internal-secret': 'telemetry-test-secret' },
}));
assert.deepEqual((await fleetRead.json()).states['vps-a'], latestState, 'fleet latest state is readable for status aggregation');

async function readLatest(bufferInstance, agentId) {
  const response = await bufferInstance.fetch(new Request(`https://nie-sla.internal/latest?agent_id=${agentId}`, {
    headers: { 'x-nie-sla-internal-secret': 'telemetry-test-secret' },
  }));
  assert.equal(response.ok, true);
  return (await response.json()).state;
}

// All Agent WebSockets share one Durable Object instance: per-Agent latest
// states must be keyed per Agent and previousState must be the Agent's own.
const wssStorage = memoryStorage();
const wssBuffer = new TelemetryBuffer(
  { storage: wssStorage, acceptWebSocket() {} },
  testEnv({ DB: mockD1() }),
);
const socketA = await openAgentSocket(wssBuffer, 'vps-a');
const socketB = await openAgentSocket(wssBuffer, 'vps-b');
const reportTs = currentHour + 30;
await sendAgentMetrics(wssBuffer, socketA, {
  agent_id: 'vps-a',
  metrics: {
    hostname: 'host-a',
    cpu_percent: 11,
    memory: { used_mb: 1, total_mb: 2 },
    disk: { used_gb: 1, total_gb: 2 },
    net: { rx_bytes: 100, tx_bytes: 100 },
    vps_info: { os: 'A-OS' },
    pings: [{ target_id: 'target-a', ts: reportTs, latency_ms: 10, ok: 1 }],
  },
});
await sendAgentMetrics(wssBuffer, socketB, {
  agent_id: 'vps-b',
  metrics: {
    cpu_percent: 22,
    memory: { used_mb: 2, total_mb: 4 },
    disk: { used_gb: 2, total_gb: 4 },
    net: { rx_bytes: 200, tx_bytes: 200 },
    pings: [{ target_id: 'target-b', ts: reportTs, latency_ms: 20, ok: 1 }],
  },
});
const stateA = await readLatest(wssBuffer, 'vps-a');
const stateB = await readLatest(wssBuffer, 'vps-b');
assert.equal(stateA.cpu_percent, 11);
assert.equal(stateB.cpu_percent, 22, 'Agents sharing one WSS instance must not overwrite each other');
assert.deepEqual(stateA.pings.map(ping => ping.target_id), ['target-a']);
assert.deepEqual(stateB.pings.map(ping => ping.target_id), ['target-b'], 'an Agent must never merge another Agent\'s pings');
assert.equal(stateA.vps_info?.os, 'A-OS');
assert.equal(stateB.vps_info, null, 'an Agent must never inherit another Agent\'s vps_info');
assert.equal(stateA.hostname, 'host-a');
assert.equal(stateB.hostname, '', 'an Agent must never inherit another Agent\'s hostname');
assert.deepEqual(socketA.sent.map(message => message.type), ['ready', 'metrics_ack']);
assert.equal(socketA.sent[1].ok, true);
assert.equal('latest_state' in socketA.sent[1], false, 'the WSS ack must not expose the internal latest_state field');

await sendAgentMetrics(wssBuffer, socketA, {
  agent_id: 'vps-a',
  metrics: {
    cpu_percent: 12,
    memory: { used_mb: 1, total_mb: 2 },
    disk: { used_gb: 1, total_gb: 2 },
    net: { rx_bytes: 100, tx_bytes: 100 },
  },
});
const stateASecond = await readLatest(wssBuffer, 'vps-a');
assert.equal(stateASecond.cpu_percent, 12);
assert.deepEqual(stateASecond.pings.map(ping => ping.target_id), ['target-a'], 'follow-up reports merge against the Agent\'s own previous state');
assert.deepEqual((await readLatest(wssBuffer, 'vps-b')).pings.map(ping => ping.target_id), ['target-b'], 'an Agent\'s follow-up report must not touch other Agents');

const futureUpdated = new Date((nowSec() + 3600) * 1000).toISOString();
await wssStorage.put('latest:state:vps-b', { agent_id: 'vps-b', updated_at: futureUpdated, cpu_percent: 99 });
await sendAgentMetrics(wssBuffer, socketB, {
  agent_id: 'vps-b',
  metrics: {
    cpu_percent: 5,
    memory: { used_mb: 1, total_mb: 2 },
    disk: { used_gb: 1, total_gb: 2 },
    net: { rx_bytes: 1, tx_bytes: 1 },
  },
});
assert.equal((await readLatest(wssBuffer, 'vps-b')).cpu_percent, 99, 'a stale WSS message must not overwrite a newer latest state');

await buffer.flushCompletedHours(currentHour + 4600);
assert.equal(archive.puts, 1, 'multiple chunks in one completed hour use one R2 write');
assert.equal((await storage.list({ prefix: 'chunk:' })).size, 0);
const payload = JSON.parse([...archive.objects.values()][0]);
assert.equal(payload.metrics.series.dt.length, 2);
assert.deepEqual(payload.metrics.series.temperature_sensors, [{
  id: 'pch:temp1', label: 'PCH', kind: 'chipset', temp_c: [35, 36],
}], 'dynamic temperature sensors must survive buffered R2 flush');
assert.equal(payload.pings.series[0].dt.length, 2);
assert.deepEqual(payload.pings.series[0].latency_ms, [null, 30]);
assert.deepEqual(payload.pings.series[0].ok, [0, 1]);

const capacityStorage = memoryStorage();
const capacityBuffer = new TelemetryBuffer({ storage: capacityStorage }, testEnv({ ARCHIVE: memoryR2() }));
await append(capacityBuffer, {
  agent_id: 'vps-capacity',
  points: Array.from({ length: 300 }, (_, index) => ({ ts: currentHour + index, cpu: index % 100, mem: 50 })),
  pings: Array.from({ length: 5 }, (_, target) => Array.from({ length: 300 }, (_, index) => ({
    target_id: `target-${target}`,
    ts: currentHour + index,
    latency_ms: index % 19 === 0 ? null : 20 + index % 10,
    ok: index % 19 === 0 ? 0 : 1,
  }))).flat(),
});
const storedChunks = await capacityStorage.list({ prefix: 'chunk:' });
assert.equal(storedChunks.size, 1);
assert.ok(Math.max(...[...storedChunks.values()].map(value => JSON.stringify(value).length)) < 128 * 1024,
  'a full 1-second five-target chunk must stay below the Durable Object value limit');

const legacyStorage = memoryStorage();
await legacyStorage.put(`hour:${completedHour + 3600}`, {
  schema: 'nie-sla-telemetry-buffer-v1',
  agent_id: 'vps-legacy',
  hour: completedHour + 3600,
  points: [{ ts: completedHour + 3610, cpu: 40 }],
  pings: [{ target_id: 'legacy', ts: completedHour + 3610, latency_ms: 50, ok: 1 }],
});
const legacyArchive = memoryR2();
const legacyBuffer = new TelemetryBuffer({ storage: legacyStorage }, testEnv({ ARCHIVE: legacyArchive }));
assert.equal((await legacyBuffer.read(completedHour + 3600, completedHour + 7199)).points.length, 1, 'legacy hour buffers remain readable');
await legacyBuffer.flushCompletedHours(currentHour + 3600);
assert.equal(legacyArchive.puts, 1, 'legacy hour buffers migrate to compact R2');
assert.equal((await legacyStorage.list({ prefix: 'hour:' })).size, 0);

const crossStorage = memoryStorage();
const crossArchive = memoryR2();
const crossBuffer = new TelemetryBuffer({ storage: crossStorage }, testEnv({ ARCHIVE: crossArchive }));
await append(crossBuffer, {
  agent_id: 'vps-cross',
  points: [{ ts: completedHour + 3599, cpu: 1 }, { ts: completedHour + 3601, cpu: 2 }],
  pings: [],
});
await crossBuffer.flushCompletedHours(currentHour + 3600);
assert.equal(crossArchive.puts, 2, 'cross-hour input flushes into separate hourly objects');

const corruptStorage = memoryStorage();
const corruptArchive = memoryR2();
const corruptBuffer = new TelemetryBuffer({ storage: corruptStorage }, testEnv({ ARCHIVE: corruptArchive }));
await append(corruptBuffer, {
  agent_id: 'vps-corrupt',
  points: [{ ts: currentHour + 10, cpu: 99 }],
  pings: [],
});
const corruptDate = new Date(currentHour * 1000).toISOString();
const corruptKey = `agent-metrics-v1/vps-corrupt/${corruptDate.slice(0, 10)}/${corruptDate.slice(11, 13)}/telemetry.json`;
corruptArchive.objects.set(corruptKey, '{not-json');
await corruptBuffer.flushCompletedHours(currentHour + 4600);
assert.equal(corruptArchive.puts, 0, 'corrupt R2 telemetry must not be overwritten');
assert.equal((await corruptStorage.list({ prefix: 'chunk:' })).size, 1, 'failed corrupt-object flush must retain buffered chunks for retry');

const exportStorage = memoryStorage();
const exportArchive = memoryR2();
const exportBuffer = new TelemetryBuffer({ storage: exportStorage }, testEnv({
  ARCHIVE: exportArchive,
  TIMESERIES_EXPORT_URL: 'https://metrics.example.com/import',
  TIMESERIES_EXPORT_TOKEN: 'test-token-never-log',
}));
await append(exportBuffer, {
  agent_id: 'vps-export',
  points: [],
  pings: [{ target_id: 'edge', ts: currentHour + 10, latency_ms: null, ok: 0 }],
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('export temporarily unavailable'); };
await exportBuffer.flushCompletedHours(currentHour + 4600);
globalThis.fetch = originalFetch;
assert.equal(exportArchive.puts, 1, 'R2 remains authoritative when optional export fails');
assert.equal((await exportStorage.list({ prefix: 'chunk:' })).size, 0, 'export failure must not retain acknowledged ingest chunks');
const exportRetries = await exportStorage.list({ prefix: 'export:' });
assert.equal(exportRetries.size, 1, 'export failure retains an independent retry marker');
assert.equal([...exportRetries.values()][0].attempts, 1);
assert.doesNotMatch([...exportRetries.values()][0].last_error, /metrics\.example|test-token/, 'retry metadata must not expose endpoint or token');

const deleteStorage = memoryStorage();
const deleteBuffer = new TelemetryBuffer({ storage: deleteStorage }, testEnv({ ARCHIVE: archive }));
await append(deleteBuffer, { agent_id: 'vps-delete', points: [{ ts: currentHour + 30, cpu: 30 }], pings: [] });
await deleteStorage.put(`hour:${completedHour}`, { agent_id: 'vps-delete', hour: completedHour, points: [], pings: [] });
const deleted = await deleteBuffer.fetch(new Request('https://nie-sla.internal/delete', { method: 'POST', headers: { 'x-nie-sla-internal-secret': 'telemetry-test-secret' } }));
assert.equal(deleted.ok, true);
assert.equal((await deleteStorage.list()).size, 0, 'deleting an Agent clears new and legacy telemetry');

const controlStorage = memoryStorage();
let controlQueries = 0;
const controlBuffer = new TelemetryBuffer({ storage: controlStorage }, testEnv({
  DB: {
    prepare(sql) {
      controlQueries += 1;
      return {
        bind() { return this; },
        async first() { return null; },
        async all() { return { results: [{ id: 'dns', target: '1.1.1.1:53', enabled: 1 }] }; },
      };
    },
  },
}));
const firstControl = await controlBuffer.readControlSnapshot();
const secondControl = await controlBuffer.readControlSnapshot();
assert.deepEqual(secondControl, firstControl, 'WSS control snapshots must be cached in the DO');
assert.equal(firstControl.ping_targets[0].protocol, 'tcp');
assert.equal(controlQueries, 2, 'a cached WSS control snapshot should read D1 only once for targets and once for interval');

const pagedStorage = memoryStorage();
const pagedBuffer = new TelemetryBuffer({ storage: pagedStorage }, testEnv());
for (let index = 0; index < 1100; index++) {
  const id = `agent-${String(index).padStart(4, '0')}`;
  await pagedStorage.put(`latest:state:${id}`, { agent_id: id, updated_at: 1, cpu_percent: index });
}
const pagedFleet = await pagedBuffer.fetch(new Request('https://nie-sla.internal/fleet/latest', {
  headers: { 'x-nie-sla-internal-secret': 'telemetry-test-secret' },
}));
const pagedStates = (await pagedFleet.json()).states;
assert.equal(Object.keys(pagedStates).length, 1100, 'fleet aggregation must page past the storage.list() truncation limit');
assert.equal(pagedStates['agent-0000']?.cpu_percent, 0);
assert.equal(pagedStates['agent-1099']?.cpu_percent, 1099);

console.log('durable telemetry buffer tests passed');

function testEnv(extra = {}) {
  return { INTERNAL_CRON_SECRET: 'telemetry-test-secret', ...extra };
}

async function append(buffer, body) {
  const response = await buffer.fetch(new Request('https://nie-sla.internal/append', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nie-sla-internal-secret': 'telemetry-test-secret' },
    body: JSON.stringify(body),
  }));
  assert.equal(response.ok, true);
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
        'x-nie-sla-internal-secret': 'telemetry-test-secret',
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

function memoryR2() {
  return {
    objects: new Map(),
    puts: 0,
    async get(key) {
      const body = this.objects.get(key);
      return body == null ? null : { async json() { return JSON.parse(body); } };
    },
    async put(key, body) {
      this.puts += 1;
      this.objects.set(key, String(body));
    },
  };
}
