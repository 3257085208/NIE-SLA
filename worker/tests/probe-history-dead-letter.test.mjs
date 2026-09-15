import assert from 'node:assert/strict';
import { ProbeHistoryBuffer } from '../src/probe-history-buffer.js';
import { internalRequestHeaders } from '../src/auth.js';
import { getPublicAppearanceScript } from '../src/admin/settings.js';
import { drainProbeHistoryDeadLetters, listProbeHistoryDeadLetters, replayProbeHistoryDeadLetter } from '../src/admin/probe-history-dead-letter.js';

const day = '2026-09-10';
const point = { checked_at: 1_789_000_000, ok: 1, latency_ms: 12, total: 1, ok_count: 1 };
const storage = memoryStorage();
const archive = memoryArchive();
const env = { ARCHIVE: archive, INTERNAL_CRON_SECRET: 'test-secret', TIMEZONE_OFFSET_MINUTES: '480', PROBE_HISTORY_R2_PREFIX: 'probe-history-test' };
const buffer = new ProbeHistoryBuffer({ storage }, env);

await storage.put('meta', { target_id: 'vps-a' });
await storage.put(`dead-letter:day:${day}`, { target_id: 'vps-a', day, points: [point], dead_letter: true, saved_at: '2026-09-11T00:00:00.000Z' });

const headers = internalRequestHeaders(env);
const listed = await buffer.fetch(new Request('https://nie-sla.internal/dead-letter?limit=10', { headers }));
assert.equal(listed.status, 200);
assert.deepEqual(await listed.json(), {
  ok: true,
  target_id: 'vps-a',
  dead_letters: [{ day, target_id: 'vps-a', points: 1, saved_at: '2026-09-11T00:00:00.000Z' }],
});

const replayed = await buffer.fetch(new Request('https://nie-sla.internal/dead-letter/replay', {
  method: 'POST',
  headers,
  body: JSON.stringify({ day }),
}));
assert.equal(replayed.status, 200);
assert.deepEqual(await replayed.json(), { ok: true, day, replayed: true, points: 1 });
assert.equal(await storage.get(`dead-letter:day:${day}`), undefined, 'successful replay must remove the durable dead-letter');
assert.equal(archive.puts, 1, 'successful replay must write the merged archive object');

await storage.put(`dead-letter:day:${day}`, { target_id: 'vps-a', day, points: [point], dead_letter: true, saved_at: '2026-09-11T00:00:00.000Z' });
archive.fail = true;
const failedDrain = await buffer.fetch(new Request('https://nie-sla.internal/dead-letter/drain', {
  method: 'POST',
  headers,
  body: JSON.stringify({ limit: 10 }),
}));
assert.equal(failedDrain.status, 200, 'bounded drain reports per-day failures instead of failing the whole request');
assert.deepEqual((await failedDrain.json()).failed, [{ day, error: '重放失败，原记录仍保留' }]);
assert.ok(await storage.get(`dead-letter:day:${day}`), 'failed replay must retain the source record');

const unauthorized = await buffer.fetch(new Request('https://nie-sla.internal/dead-letter'));
assert.equal(unauthorized.status, 401, 'dead-letter DO endpoints must remain internal-only');

const db = {
  prepare(sql) {
    return {
      values: [],
      bind(...values) { this.values = values; return this; },
      async first() {
        return this.values[0] === 'frontend_appearance'
          ? { value: JSON.stringify({ custom_script: 'window.__custom = true;' }) }
          : null;
      },
    };
  },
};
assert.equal(await getPublicAppearanceScript({ DB: db }), 'window.__custom = true;');

const adminStorage = memoryStorage();
const adminArchive = memoryArchive();
const adminEnv = { ...env, DB: targetDb(), ARCHIVE: adminArchive, PROBE_HISTORY: null };
const adminBuffer = new ProbeHistoryBuffer({ storage: adminStorage }, adminEnv);
await adminStorage.put('meta', { target_id: 'vps-a' });
await adminStorage.put(`dead-letter:day:${day}`, { target_id: 'vps-a', day, points: [point], dead_letter: true, saved_at: '2026-09-11T00:00:00.000Z' });
adminEnv.PROBE_HISTORY = namespaceFor(adminBuffer);

const adminList = await listProbeHistoryDeadLetters(adminEnv, new URL('https://admin.test/api/probe-history/dead-letter?limit=10'));
assert.equal(adminList.dead_letters.length, 1, 'admin list must discover dead-letters through current target IDs');
assert.equal(adminList.dead_letters[0].target_name, 'VPS A');
const adminReplay = await replayProbeHistoryDeadLetter(new Request('https://admin.test/api/probe-history/dead-letter/replay', { method: 'POST', body: JSON.stringify({ target_id: 'vps-a', day }) }), adminEnv);
assert.equal(adminReplay.replayed, true, 'admin replay must call the scoped DO');
assert.equal(await adminStorage.get(`dead-letter:day:${day}`), undefined);

await adminStorage.put(`dead-letter:day:${day}`, { target_id: 'vps-a', day, points: [point], dead_letter: true, saved_at: '2026-09-11T00:00:00.000Z' });
const adminDrain = await drainProbeHistoryDeadLetters(new Request('https://admin.test/api/probe-history/dead-letter/drain', { method: 'POST', body: JSON.stringify({ target_id: 'vps-a', limit: 25 }) }), adminEnv);
assert.equal(adminDrain.drained.length, 1, 'admin drain must replay a bounded list');
console.log('probe history dead-letter tests passed');

function memoryStorage() {
  const values = new Map();
  return {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    async list({ prefix = '', limit = Number.MAX_SAFE_INTEGER } = {}) {
      return new Map([...values].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
    },
  };
}

function memoryArchive() {
  return {
    puts: 0,
    fail: false,
    objects: new Map(),
    async get(key) {
      const value = this.objects.get(key);
      if (value == null) return null;
      return { json: async () => JSON.parse(value), size: new TextEncoder().encode(value).byteLength };
    },
    async head(key) {
      const value = this.objects.get(key);
      return value == null ? null : { size: new TextEncoder().encode(value).byteLength };
    },
    async put(key, value) {
      if (this.fail) throw new Error('injected archive failure');
      this.puts += 1;
      this.objects.set(key, value);
    },
  };
}

function targetDb() {
  return {
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async all() {
          if (/WHERE id = \?/i.test(sql)) return { results: this.values[0] === 'vps-a' ? [{ id: 'vps-a', name: 'VPS A', enabled: 1 }] : [] };
          return { results: [{ id: 'vps-a', name: 'VPS A', enabled: 1 }] };
        },
      };
    },
  };
}

function namespaceFor(buffer) {
  return {
    idFromName(name) { return name; },
    get() { return { fetch(input, init) { return buffer.fetch(input instanceof Request ? input : new Request(input, init)); } }; },
  };
}
