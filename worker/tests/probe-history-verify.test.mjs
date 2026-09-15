import assert from 'node:assert/strict';
import { ProbeHistoryBuffer } from '../src/probe-history-buffer.js';
import { nowSec } from '../src/utils.js';

const point = { checked_at: 1_789_000_000, ok: 1, latency_ms: 12, total: 1, ok_count: 1 };
const completedDay = '2026-09-08';

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

function flakyArchive() {
  return {
    puts: 0,
    persist: true,
    readable: true,
    objects: new Map(),
    async get(key) {
      if (!this.readable) return null;
      const body = this.objects.get(key);
      return body == null ? null : { async json() { return JSON.parse(body); } };
    },
    async put(key, body) {
      this.puts += 1;
      if (this.persist) this.objects.set(key, String(body));
    },
    async head(key) {
      const body = this.objects.get(key);
      return this.persist && body != null ? { size: new TextEncoder().encode(body).byteLength } : null;
    },
  };
}

const storage = memoryStorage();
const archive = flakyArchive();
const env = { ARCHIVE: archive, TIMEZONE_OFFSET_MINUTES: '480', PROBE_HISTORY_R2_PREFIX: 'probe-history-test' };
const buffer = new ProbeHistoryBuffer({ storage }, env);
await storage.put('meta', { target_id: 'vps-a', schema: 'nie-sla-probe-history-day-v1' });
await storage.put(`day:${completedDay}`, { target_id: 'vps-a', day: completedDay, points: [point] });

const first = await buffer.flushCompletedDays('2026-09-11');
assert.equal(first.ok, true, 'flush must succeed even while confirmation is pending');
assert.equal(archive.puts, 1, 'the first flush must attempt the archive write');
assert.equal(first.confirm_pending, true, 'a fresh archive must stay pending survival confirmation');
const kept = await storage.get(`day:${completedDay}`);
assert.ok(kept, 'the source day must be retained until the archive is confirmed');
assert.ok(kept.archived_at, 'the confirmation timestamp must be recorded');

await storage.put(`day:${completedDay}`, { ...kept, archived_at: nowSec() - 3600 });
const second = await buffer.flushCompletedDays('2026-09-11');
assert.equal(second.confirm_pending, false, 'a confirmed archive must clear the pending flag');
assert.equal(await storage.get(`day:${completedDay}`), undefined, 'a surviving archive must release the source day');
assert.equal(archive.puts, 1, 'confirmation must not rewrite when the archive persists');

archive.persist = true;
archive.readable = false;
await storage.put(`day:${completedDay}`, { target_id: 'vps-a', day: completedDay, points: [point] });
const third = await buffer.flushCompletedDays('2026-09-11');
assert.equal(archive.puts, 2, 'an unverified write must still hit the archive once');
assert.ok(await storage.get(`day:${completedDay}`), 'an unverified write must retain the source day');
assert.equal(third.confirm_pending, true, 'a failed verification must schedule a retry');

const fourth = await buffer.flushCompletedDays('2026-09-11');
const fifth = await buffer.flushCompletedDays('2026-09-11');
assert.equal(fifth.dead_letters_pending, true, 'the fresh dead-letter must await a healthy retry');
assert.equal(await storage.get(`day:${completedDay}`), undefined, 'the state day must move into the durable dead-letter');

archive.persist = true;
archive.readable = true;
const sixth = await buffer.flushCompletedDays('2026-09-11');
assert.equal(sixth.replayed, 1, 'the flush must auto-replay the dead-letter once writes persist');
assert.equal(await storage.get(`dead-letter:day:${completedDay}`), undefined, 'a successful replay must clear the dead-letter');
assert.equal(sixth.dead_letters_pending, false, 'no dead-letters may remain after recovery');

console.log('probe history verify tests passed');
