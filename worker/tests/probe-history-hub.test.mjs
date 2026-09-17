import assert from 'node:assert/strict';
import { ProbeHistoryBuffer, PROBE_HISTORY_HUB_INSTANCE } from '../src/probe-history-buffer.js';
import { dayFromSec, nowSec } from '../src/utils.js';

const now = nowSec();
const env = { INTERNAL_CRON_SECRET: 'hub-test-secret', TIMEZONE_OFFSET_MINUTES: '480', PROBE_HISTORY_R2_PREFIX: 'probe-history-hub-test' };
const currentDay = dayFromSec(now, env);

const storage = memoryStorage();
const archive = memoryR2();
const hub = new ProbeHistoryBuffer({ storage, id: { name: PROBE_HISTORY_HUB_INSTANCE } }, { ...env, ARCHIVE: archive });

// One batch append carries every due target; storage stays per target.
await hub.append({
  targets: [
    { target_id: 'vps-a', writes: [{ day: currentDay, point: { checked_at: now - 10, ok: 1, latency_ms: 11, total: 1, ok_count: 1 } }] },
    { target_id: 'vps-b', writes: [{ day: currentDay, point: { checked_at: now - 10, ok: 0, error: '连接失败', total: 1, ok_count: 0 } }] },
  ],
});
assert.equal(hub.memDays.size, 2, 'hub buffers one in-memory entry per target');
await hub.alarm();
const storageKeys = [...(await storage.list({ prefix: 'd:' })).keys()];
assert.equal(storageKeys.length, 2, 'hub persists one scoped key per target');
assert.ok(storageKeys.every(key => key.includes('|')), 'hub day keys embed the target id');
const readA = await hub.read({ targetId: 'vps-a', fromDay: currentDay, toDay: currentDay, since: now - 3600, until: now });
const readB = await hub.read({ targetId: 'vps-b', fromDay: currentDay, toDay: currentDay, since: now - 3600, until: now });
assert.deepEqual(readA.points.map(point => point.latency_ms), [11], 'a hub read must only return the requested target');
assert.deepEqual(readB.points.map(point => point.ok), [0]);
assert.equal((await hub.read({ fromDay: currentDay, toDay: currentDay, since: now - 3600, until: now })).points.length, 0, 'hub reads require an explicit target');

// A completed day archives one R2 object per target and releases the keys.
const previousDay = dayFromSec(now - 86400, env);
await hub.append({
  targets: [
    { target_id: 'vps-a', writes: [{ day: previousDay, point: { checked_at: now - 86400 + 60, ok: 1, latency_ms: 20, total: 1, ok_count: 1 } }] },
    { target_id: 'vps-b', writes: [{ day: previousDay, point: { checked_at: now - 86400 + 60, ok: 1, latency_ms: 30, total: 1, ok_count: 1 } }] },
  ],
});
await hub.alarm();
assert.equal(archive.puts, 2, 'each target archives its own completed-day object');
assert.match([...archive.objects.keys()].sort()[0], /probe-history-hub-test\/vps-a\//);
for (const key of [...(await storage.list({ prefix: 'd:' })).keys()]) {
  const value = await storage.get(key);
  await storage.put(key, { ...value, archived_at: nowSec() - 3600 });
}
await hub.alarm();
assert.equal((await storage.list({ prefix: 'd:' })).size, 4, 'archived hub days stay hot inside the public read window');
const stillReadable = await hub.read({ targetId: 'vps-a', fromDay: previousDay, toDay: currentDay, since: now - 3 * 86400, until: now });
assert.deepEqual(stillReadable.points.map(point => point.latency_ms), [20, 11], 'hub history reads merge archived and hot days per target');

// Migration: the first hub use imports the legacy per-target storage, then
// drops the legacy instance; later calls must not export again.
const migrationStorage = memoryStorage();
const migrationArchive = memoryR2();
const legacyStorage = memoryStorage();
const legacyBuffer = new ProbeHistoryBuffer({ storage: legacyStorage }, env);
await legacyBuffer.append({
  target_id: 'vps-old',
  writes: [{ day: currentDay, point: { checked_at: now - 30, ok: 1, latency_ms: 42, total: 1, ok_count: 1 } }],
});
await legacyStorage.put(`dead-letter:day:${previousDay}`, {
  target_id: 'vps-old', day: previousDay, points: [{ checked_at: now - 86400 + 90, ok: 0, error: '连接失败', total: 1, ok_count: 0 }], dead_letter: true, saved_at: '2026-09-16T00:00:00.000Z',
});
let exportCalls = 0;
const migrationHub = new ProbeHistoryBuffer(
  { storage: migrationStorage, id: { name: PROBE_HISTORY_HUB_INSTANCE } },
  {
    ...env,
    ARCHIVE: migrationArchive,
    PROBE_HISTORY: {
      idFromName(name) { return name; },
      get() {
        return {
          fetch(input, init) {
            const request = input instanceof Request ? input : new Request(input, init);
            if (new URL(request.url).pathname === '/export') exportCalls += 1;
            return legacyBuffer.fetch(request);
          },
        };
      },
    },
  },
);
await migrationHub.append({
  target_id: 'vps-old',
  writes: [{ day: currentDay, point: { checked_at: now - 40, ok: 1, latency_ms: 43, total: 1, ok_count: 1 } }],
});
const migrated = await migrationHub.read({ targetId: 'vps-old', fromDay: currentDay, toDay: currentDay, since: now - 3600, until: now });
assert.deepEqual(migrated.points.map(point => point.latency_ms), [43, 42], 'legacy points must migrate into the hub before new appends read back');
assert.equal(exportCalls, 1, 'migration runs once per target');
assert.equal((await legacyStorage.list()).size, 0, 'the legacy per-target buffer is dropped after migration');
const migratedDead = await migrationHub.listDeadLetters('vps-old');
assert.equal(migratedDead.dead_letters.length, 1, 'legacy dead-letters migrate with the target buffer');
assert.equal(migratedDead.dead_letters[0].target_id, 'vps-old');
await migrationHub.append({
  target_id: 'vps-old',
  writes: [{ day: currentDay, point: { checked_at: now - 50, ok: 1, latency_ms: 44, total: 1, ok_count: 1 } }],
});
assert.equal(exportCalls, 1, 'a migrated target must not export again');

console.log('probe history hub tests passed');

function memoryStorage() {
  const values = new Map();
  let alarm = null;
  return {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    async deleteAll() { values.clear(); alarm = null; },
    async list({ prefix = '', limit = Number.MAX_SAFE_INTEGER } = {}) {
      return new Map([...values].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
    },
    async getAlarm() { return alarm; },
    async setAlarm(value) { alarm = value; },
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
    async head(key) {
      const body = this.objects.get(key);
      return body == null ? null : { size: new TextEncoder().encode(body).byteLength };
    },
  };
}
