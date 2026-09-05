import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import { ensureV6Schema } from '../src/admin/schema.js';
import { submitAgentPings } from '../src/admin/ping-targets.js';

globalThis.crypto ||= webcrypto;

const sqlite = new DatabaseSync(':memory:');
const env = {
  DB: d1(sqlite),
  AGENT_TOKEN: 'global-ping-token',
  TIMEZONE_OFFSET_MINUTES: '480',
};
await ensureV6Schema(env);

const now = Math.floor(Date.now() / 1000);
sqlite.prepare(`INSERT INTO targets (id, name, type, enabled, created_at, updated_at) VALUES ('ping-vps', 'Ping VPS', 'tcp', 1, ?, ?)`).run(now, now);

function pingRequest(pings, agentId = 'ping-vps') {
  return new Request('https://example.test/api/agent/pings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer global-ping-token' },
    body: JSON.stringify({ agent_id: agentId, pings }),
  });
}

function historyCount() {
  return sqlite.prepare(`SELECT COUNT(*) AS count FROM ping_history`).get().count;
}

// Normal samples inside the window are stored untouched.
{
  const result = await submitAgentPings(pingRequest([
    { target_id: 'ping-target', ts: now - 120, latency_ms: 12.4, ok: 1 },
    { target_id: 'ping-target', ts: now - 60, latency_ms: 0 },
    { target_id: 'ping-target', ts: now, latency_ms: 30, ok: true },
  ]), env);
  assert.equal(result.ok, true);
  assert.equal(result.stored, 3);
  assert.equal(result.dropped, 0);
  assert.equal(result.storage, 'd1');
  assert.equal(result.d1_rows, 3);
  assert.equal(historyCount(), 3);
}

// Window edges stay inclusive: exactly 7 days old and exactly now+300 are accepted.
{
  const result = await submitAgentPings(pingRequest([
    { target_id: 'ping-target', ts: now - 7 * 86400, latency_ms: 20, ok: 1 },
    { target_id: 'ping-target', ts: now + 300, latency_ms: 21, ok: 1 },
    { target_id: 'ping-target', latency_ms: 22 }, // missing ts defaults to now
  ]), env);
  assert.equal(result.ok, true);
  assert.equal(result.stored, 3);
  assert.equal(result.dropped, 0);
}

// Out-of-window and malformed samples are dropped and counted, in-window ones still stored.
{
  const result = await submitAgentPings(pingRequest([
    { target_id: 'ping-target', ts: now - 60, latency_ms: 10, ok: 1 },
    { target_id: 'ping-target', ts: now - 8 * 86400, latency_ms: 10, ok: 1 },
    { target_id: 'ping-target', ts: now + 301, latency_ms: 10, ok: 1 },
    { target_id: 'ping-target', ts: now + 86400, latency_ms: 10, ok: 1 },
    { target_id: 'ping-target', ts: 'not-a-number', latency_ms: 10, ok: 1 },
    { target_id: '', ts: now - 60, latency_ms: 10, ok: 1 },
  ]), env);
  assert.equal(result.ok, true);
  assert.equal(result.stored, 1);
  assert.equal(result.dropped, 5);
  assert.equal(result.d1_rows, 1);
  const outOfWindow = sqlite.prepare(`SELECT COUNT(*) AS count FROM ping_history WHERE ts < ? OR ts > ?`)
    .get(now - 7 * 86400, now + 300).count;
  assert.equal(outOfWindow, 0, 'dropped samples must not reach ping_history');
}

// More than 25 distinct hourly buckets after dedup rejects the whole batch with 400 and writes nothing.
{
  const before = historyCount();
  const spread = Array.from({ length: 26 }, (_, hour) => ({
    target_id: 'ping-target',
    ts: now - hour * 3600 - 60,
    latency_ms: 5,
    ok: 1,
  }));
  await assert.rejects(
    () => submitAgentPings(pingRequest(spread), env),
    error => error?.status === 400 && /小时桶/.test(error.message),
  );
  assert.equal(historyCount(), before, 'a rejected batch must not write any ping rows');
}

// Exactly 25 distinct hourly buckets is still accepted.
{
  const spread = Array.from({ length: 25 }, (_, hour) => ({
    target_id: 'ping-target',
    ts: now - hour * 3600 - 60,
    latency_ms: 5,
    ok: 1,
  }));
  const result = await submitAgentPings(pingRequest(spread), env);
  assert.equal(result.ok, true);
  assert.equal(result.stored, 25);
  assert.equal(result.dropped, 0);
  assert.equal(result.d1_rows, 25);
}

console.log('ping target window tests passed');

function d1(database) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async run() {
          const result = database.prepare(sql).run(...values);
          return { meta: { changes: Number(result.changes || 0) } };
        },
        async all() { return { results: database.prepare(sql).all(...values) }; },
        async first() { return database.prepare(sql).get(...values) || null; },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}
