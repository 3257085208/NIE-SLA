import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import { ensureV6Schema } from '../src/admin/schema.js';
import { submitAgentPings, createPingTarget, updatePingTarget, getPingTargets, normalizePingExpectedStatus } from '../src/admin/ping-targets.js';

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

// More than 25 distinct hourly buckets keeps only the newest 25 buckets
// (rejecting the batch would make a replaying Agent retry the same payload
// forever, so the oldest buckets are dropped instead).
{
  const before = historyCount();
  const spread = Array.from({ length: 26 }, (_, hour) => ({
    target_id: 'ping-target',
    ts: now - hour * 3600 - 60,
    latency_ms: 5,
    ok: 1,
  }));
  const result = await submitAgentPings(pingRequest(spread), env);
  assert.equal(result.ok, true);
  assert.equal(result.stored, 25, 'only the newest 25 buckets survive');
  assert.equal(result.dropped, 1, 'the oldest bucket is dropped');
  void before;
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

// Agent-side HTTP ping targets store an optional exact expected status; empty
// or invalid values fall back to NULL, which keeps the legacy 2xx/3xx rule.
{
  const created = await createPingTarget(new Request('https://example.test/api/ping-targets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'web-expected',
      name: 'Web Expected',
      target: 'https://example.com/health',
      expected_status: '200, 301,301,999,abc',
    }),
  }), env);
  assert.equal(created.ok, true);
  assert.equal(
    sqlite.prepare(`SELECT expected_status FROM ping_targets WHERE id = 'web-expected'`).get().expected_status,
    '200,301',
    'expected status must be deduplicated and limited to 100..599',
  );

  const cleared = await updatePingTarget('web-expected', new Request('https://example.test/api/ping-targets/web-expected', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_status: '' }),
  }), env);
  assert.equal(cleared.ok, true);
  assert.equal(
    sqlite.prepare(`SELECT expected_status FROM ping_targets WHERE id = 'web-expected'`).get().expected_status,
    null,
    'an empty expected status must clear the exact match',
  );

  await updatePingTarget('web-expected', new Request('https://example.test/api/ping-targets/web-expected', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_status: '404' }),
  }), env);
  await updatePingTarget('web-expected', new Request('https://example.test/api/ping-targets/web-expected', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Web Expected 2' }),
  }), env);
  assert.equal(
    sqlite.prepare(`SELECT expected_status FROM ping_targets WHERE id = 'web-expected'`).get().expected_status,
    '404',
    'an update that omits expected_status must keep the stored value',
  );

  const listed = await getPingTargets(env, { enabledOnly: false });
  const row = listed.targets.find(target => target.id === 'web-expected');
  assert.equal(row.expected_status, '404', 'the Agent payload must expose the expected status');
  assert.equal(row.protocol, 'http');

  assert.equal(normalizePingExpectedStatus(undefined), undefined);
  assert.equal(normalizePingExpectedStatus(''), null);
  assert.equal(normalizePingExpectedStatus('200,200'), '200');
  assert.equal(normalizePingExpectedStatus([200, 404]), '200,404');
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
