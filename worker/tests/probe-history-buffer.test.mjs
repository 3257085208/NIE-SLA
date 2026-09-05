import assert from 'node:assert/strict';
import { ProbeHistoryBuffer } from '../src/probe-history-buffer.js';
import { dayFromSec, nowSec } from '../src/utils.js';

const now = nowSec();
const currentDay = dayFromSec(now, { TIMEZONE_OFFSET_MINUTES: '480' });
const previousDay = dayFromSec(now - 86400, { TIMEZONE_OFFSET_MINUTES: '480' });
const storage = memoryStorage();
const archive = memoryR2();
const env = { ARCHIVE: archive, TIMEZONE_OFFSET_MINUTES: '480', PROBE_HISTORY_R2_PREFIX: 'probe-history-test' };
const buffer = new ProbeHistoryBuffer({ storage }, env);

await buffer.append({
  target_id: 'vps-a',
  writes: [
    { day: currentDay, point: { checked_at: now - 20, ok: 1, latency_ms: 20, total: 1, ok_count: 1, probe_region: 'auto' } },
    { day: currentDay, point: { checked_at: now - 20, ok: 1, latency_ms: 22, total: 1, ok_count: 1, probe_region: 'auto' } },
  ],
});

const current = await buffer.read({ fromDay: currentDay, toDay: currentDay, since: now - 3600, until: now });
assert.equal(current.points.length, 1, 'same bucket retries must replace the previous point');
assert.equal(current.points[0].latency_ms, 22);

await buffer.append({
  target_id: 'vps-a',
  writes: [{ day: previousDay, point: { checked_at: now - 86400 + 60, ok: 0, error: '连接失败', total: 1, ok_count: 0 } }],
});
assert.equal(archive.puts, 1, 'completed days must use one R2 object');
assert.equal((await storage.list({ prefix: 'day:' })).size, 1, 'only the current day remains hot');

const history = await buffer.read({ fromDay: previousDay, toDay: currentDay, since: now - 2 * 86400, until: now });
assert.deepEqual(history.points.map(point => point.checked_at), [now - 86400 + 60, now - 20]);
assert.equal(history.points[0].missed, false);

const summary = await buffer.summary(currentDay, now);
assert.deepEqual(summary, { ok: true, day: currentDay, total: 1, ok_count: 1, sum_latency_ms: 22 });

const corruptStorage = memoryStorage();
const corruptArchive = memoryR2();
corruptArchive.objects.set(`probe-history-test/vps-corrupt/${previousDay}.json`, '{bad-json');
const corruptBuffer = new ProbeHistoryBuffer({ storage: corruptStorage }, { ...env, ARCHIVE: corruptArchive });
await assert.rejects(() => corruptBuffer.append({
  target_id: 'vps-corrupt',
  writes: [{ day: previousDay, point: { checked_at: now - 86400 + 120, ok: 1, latency_ms: 10 } }],
}), /R2 probe history read failed/);
assert.equal(corruptArchive.puts, 0, 'corrupt history must not be overwritten');

console.log('probe history buffer tests passed');

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
  };
}
