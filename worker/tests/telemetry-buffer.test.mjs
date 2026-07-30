import assert from 'node:assert/strict';
import { TelemetryBuffer } from '../src/telemetry-buffer.js';

const currentHour = Math.floor(Date.now() / 3_600_000) * 3600;
const completedHour = currentHour - 7200;
const storage = memoryStorage();
const archive = memoryR2();
const buffer = new TelemetryBuffer({ storage }, { ARCHIVE: archive });

await append(buffer, {
  agent_id: 'vps-a',
  points: [{ ts: currentHour + 10, cpu: 10 }],
  pings: [{ target_id: 'cn', ts: currentHour + 10, latency_ms: null, ok: 0 }],
});
await append(buffer, {
  agent_id: 'vps-a',
  points: [{ ts: currentHour + 10, cpu: 11 }, { ts: currentHour + 310, cpu: 20 }],
  pings: [
    { target_id: 'cn', ts: currentHour + 10, latency_ms: null, ok: 0 },
    { target_id: 'cn', ts: currentHour + 310, latency_ms: 30, ok: 1 },
  ],
});

assert.equal((await storage.list({ prefix: 'chunk:' })).size, 2, 'active data uses fixed five-minute chunks');
const live = await buffer.read(currentHour, currentHour + 3599);
assert.deepEqual(live.points.map(point => point.cpu), [11, 20], 'same-chunk retries are idempotent');
assert.deepEqual(live.pings.map(point => point.latency_ms), [null, 30], 'loss samples retain null latency');

await buffer.flushCompletedHours(currentHour + 4600);
assert.equal(archive.puts, 1, 'multiple chunks in one completed hour use one R2 write');
assert.equal((await storage.list({ prefix: 'chunk:' })).size, 0);
const payload = JSON.parse([...archive.objects.values()][0]);
assert.equal(payload.metrics.series.dt.length, 2);
assert.equal(payload.pings.series[0].dt.length, 2);
assert.deepEqual(payload.pings.series[0].latency_ms, [null, 30]);
assert.deepEqual(payload.pings.series[0].ok, [0, 1]);

const capacityStorage = memoryStorage();
const capacityBuffer = new TelemetryBuffer({ storage: capacityStorage }, { ARCHIVE: memoryR2() });
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
const legacyBuffer = new TelemetryBuffer({ storage: legacyStorage }, { ARCHIVE: legacyArchive });
assert.equal((await legacyBuffer.read(completedHour + 3600, completedHour + 7199)).points.length, 1, 'legacy hour buffers remain readable');
await legacyBuffer.flushCompletedHours(currentHour + 3600);
assert.equal(legacyArchive.puts, 1, 'legacy hour buffers migrate to compact R2');
assert.equal((await legacyStorage.list({ prefix: 'hour:' })).size, 0);

const crossStorage = memoryStorage();
const crossArchive = memoryR2();
const crossBuffer = new TelemetryBuffer({ storage: crossStorage }, { ARCHIVE: crossArchive });
await append(crossBuffer, {
  agent_id: 'vps-cross',
  points: [{ ts: completedHour + 3599, cpu: 1 }, { ts: completedHour + 3601, cpu: 2 }],
  pings: [],
});
await crossBuffer.flushCompletedHours(currentHour + 3600);
assert.equal(crossArchive.puts, 2, 'cross-hour input flushes into separate hourly objects');

const exportStorage = memoryStorage();
const exportArchive = memoryR2();
const exportBuffer = new TelemetryBuffer({ storage: exportStorage }, {
  ARCHIVE: exportArchive,
  TIMESERIES_EXPORT_URL: 'https://metrics.example.com/import',
  TIMESERIES_EXPORT_TOKEN: 'test-token-never-log',
});
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
const deleteBuffer = new TelemetryBuffer({ storage: deleteStorage }, { ARCHIVE: archive });
await append(deleteBuffer, { agent_id: 'vps-delete', points: [{ ts: currentHour + 30, cpu: 30 }], pings: [] });
await deleteStorage.put(`hour:${completedHour}`, { agent_id: 'vps-delete', hour: completedHour, points: [], pings: [] });
const deleted = await deleteBuffer.fetch(new Request('https://nie-sla.internal/delete', { method: 'POST' }));
assert.equal(deleted.ok, true);
assert.equal((await deleteStorage.list()).size, 0, 'deleting an Agent clears new and legacy telemetry');

console.log('durable telemetry buffer tests passed');

async function append(buffer, body) {
  const response = await buffer.fetch(new Request('https://nie-sla.internal/append', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
    async list({ prefix = '', limit = Number.MAX_SAFE_INTEGER } = {}) {
      return new Map([...values].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
    },
    async getAlarm() { return alarm; },
    async setAlarm(value) { alarm = value; },
    async transaction(callback) { return callback(api); },
  };
  return api;
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
