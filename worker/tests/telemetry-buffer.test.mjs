import assert from 'node:assert/strict';
import { TelemetryBuffer } from '../src/telemetry-buffer.js';

const hour = Math.floor(Date.now() / 3_600_000) * 3600;
const storage = memoryStorage();
const archive = memoryR2();
const buffer = new TelemetryBuffer({ storage }, { ARCHIVE: archive });

await append(buffer, {
  agent_id: 'vps-a',
  points: [{ ts: hour + 10, cpu: 10 }],
  pings: [{ target_id: 'cn', ts: hour + 10, latency_ms: 20, ok: 1 }],
});
await append(buffer, {
  agent_id: 'vps-a',
  points: [{ ts: hour + 20, cpu: 20 }],
  pings: [{ target_id: 'cn', ts: hour + 20, latency_ms: 30, ok: 1 }],
});

assert.equal(archive.puts, 0, 'the active hour must stay in durable storage');
const live = await buffer.read(hour, hour + 3599);
assert.deepEqual(live.points.map(point => point.cpu), [10, 20]);
assert.deepEqual(live.pings.map(point => point.latency_ms), [20, 30]);

const deleteStorage = memoryStorage();
const deleteBuffer = new TelemetryBuffer({ storage: deleteStorage }, { ARCHIVE: archive });
await append(deleteBuffer, {
  agent_id: 'vps-delete',
  points: [{ ts: hour + 30, cpu: 30 }],
  pings: [],
});
const deleted = await deleteBuffer.fetch(new Request('https://nie-sla.internal/delete', { method: 'POST' }));
assert.equal(deleted.ok, true);
assert.equal((await deleteStorage.list({ prefix: 'hour:' })).size, 0, 'deleting an Agent must clear its unflushed telemetry');

await buffer.flushCompletedHours(hour + 3600 + 600);
assert.equal(archive.puts, 1, 'one completed Agent hour must use one R2 write');
assert.equal((await storage.list({ prefix: 'hour:' })).size, 0);
const payload = JSON.parse([...archive.objects.values()][0]);
assert.equal(payload.metrics.points.length, 2);
assert.equal(payload.pings.pings.length, 2);

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
