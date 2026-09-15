import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPingTarget, getAgentPings, getPingTargets, resolvePublicPingQuery, updatePingTarget } from '../src/admin/ping-targets.js';
import { getPingIntervalSec, updatePingConfig } from '../src/ping-config.js';
import { ensureV6Schema } from '../src/admin/schema.js';

globalThis.crypto ||= webcrypto;

const database = new DatabaseSync(':memory:');
const env = { DB: d1(database) };
await ensureV6Schema(env);

assert.equal(await getPingIntervalSec(env), 20);
await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES ('agent_ping_interval_sec', '1', 1)`).run();
assert.equal(await getPingIntervalSec(env), 20, 'obsolete one-second settings must fall back to the 20-second default');
const oneHourQuery = resolvePublicPingQuery(new URL('https://api.example.test/api/agent/pings?hours=1&max_points_per_target=2000'));
assert.equal(oneHourQuery.maxPerTarget, null, 'raw TCP Ping must not expose a compaction limit');
assert.equal(oneHourQuery.raw, true);
assert.equal(resolvePublicPingQuery(new URL('https://api.example.test/api/agent/pings?max_points_per_target=0')).maxPerTarget, null, 'legacy compaction parameters must be ignored');
assert.equal(resolvePublicPingQuery(new URL('https://api.example.test/api/agent/pings?max_points_per_target=9000')).maxPerTarget, null, 'legacy compaction parameters must be ignored');
const saved = await updatePingConfig(jsonRequest({ ping_interval_sec: 5 }), env);
assert.equal(saved.ping_interval_sec, 5);
assert.equal(saved.min_interval_sec, 5);
assert.equal(saved.max_interval_sec, 300);
assert.equal('one_second_max_targets' in saved, false);

for (let index = 1; index <= 5; index++) {
  await createPingTarget(jsonRequest({ id: `target-${index}`, name: `Target ${index}`, target: `127.0.0.1:${index}` }), env);
}
await createPingTarget(jsonRequest({ id: 'target-6', name: 'Target 6', target: '127.0.0.1:6' }), env);
await assert.rejects(createPingTarget(jsonRequest({ id: 'icmp', name: 'ICMP', target: 'icmp://127.0.0.1' }), env), /不再支持/);
await env.DB.prepare(`INSERT INTO ping_targets (id, name, target, color, enabled, created_at, updated_at) VALUES ('legacy-icmp', 'Legacy ICMP', 'icmp://127.0.0.1', '#159754', 1, 1, 1)`).run();

const payload = await getPingTargets(env, { enabledOnly: false });
assert.equal(payload.ping_interval_sec, 5);
assert.equal(payload.targets.length, 7);
assert.equal(payload.targets.find(target => target.id === 'legacy-icmp')?.protocol, 'icmp');
const agentPayload = await getPingTargets(env, { protocols: 'tcp,http,icmp' });
assert.equal(agentPayload.targets.some(target => target.id === 'legacy-icmp'), false, 'legacy ICMP rows must never be sent to Agents');
await assert.rejects(updatePingConfig(jsonRequest({ ping_interval_sec: 1 }), env), /5-300 秒/);
await assert.rejects(updatePingConfig(jsonRequest({ ping_interval_sec: 4 }), env), /5-300 秒/);
await assert.rejects(updatePingConfig(jsonRequest({ ping_interval_sec: 301 }), env), /5-300 秒/);
await assert.rejects(updatePingConfig(jsonRequest({ ping_interval_sec: 5.5 }), env), /5-300 秒/);

await updatePingConfig(jsonRequest({ ping_interval_sec: 20 }), env);

const rawPingNow = Math.floor(Date.now() / 1000);
for (let index = 0; index < 500; index += 1) {
  database.prepare(`INSERT INTO ping_history (target_id, agent_id, ts, latency_ms, ok) VALUES (?, ?, ?, ?, 1)`)
    .run('target-1', 'agent-raw', rawPingNow - index * 20, 10 + (index % 5));
}
const rawPingPayload = await getAgentPings(env, new URL('https://api.example.test/api/agent/pings?agent_id=agent-raw&hours=24&format=series&max_points_per_target=10'));
assert.equal(rawPingPayload.pings_raw_count, 500);
assert.equal(rawPingPayload.pings_downsampled, false);
assert.equal(rawPingPayload.pings_raw, true);
assert.equal(rawPingPayload.pings.length, 0);
assert.equal(rawPingPayload.series[0].dt.length, 500, 'public TCP Ping must return all raw points');

await updatePingTarget('target-5', jsonRequest({ enabled: false }), env);
assert.equal(database.prepare(`SELECT enabled FROM ping_targets WHERE id = 'target-5'`).get().enabled, 0);
await updatePingTarget('target-5', jsonRequest({ enabled: 'false' }), env);
assert.equal(database.prepare(`SELECT enabled FROM ping_targets WHERE id = 'target-5'`).get().enabled, 0, 'string false must not become truthy');
await assert.rejects(updatePingTarget('target-5', jsonRequest({ enabled: 'not-a-boolean' }), env), /enabled 必须是布尔值/);
await updatePingTarget('target-5', jsonRequest({ enabled: true }), env);
assert.equal(database.prepare(`SELECT enabled FROM ping_targets WHERE id = 'target-5'`).get().enabled, 1);

console.log('Ping configuration tests passed');

function jsonRequest(body) {
  return new Request('https://api.example.test/api/ping-config', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function d1(db) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async run() { return db.prepare(sql).run(...values); },
        async all() { return { results: db.prepare(sql).all(...values) }; },
        async first() { return db.prepare(sql).get(...values) || null; },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}
