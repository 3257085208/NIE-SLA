import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureV6Schema } from '../src/admin/schema.js';
import { deleteTarget } from '../src/admin/targets.js';
import { sanitizeAgentId } from '../src/utils.js';

const sqlite = new DatabaseSync(':memory:');
const env = { DB: d1(sqlite), TIMEZONE_OFFSET_MINUTES: '480' };
await ensureV6Schema(env);

const rawId = 'orphan&agent';
const agentId = sanitizeAgentId(rawId);
const now = Math.floor(Date.now() / 1000);
sqlite.prepare(`INSERT INTO targets (id, name, group_name, type, enabled, no_public_ip, created_at, updated_at, traffic_reset_day)
  VALUES (?, ?, 'Default', 'tcp', 1, 1, ?, ?, 1)`).run(rawId, 'Orphan Agent', now, now);
sqlite.prepare(`INSERT INTO agent_daily_availability (agent_id, day, total_sec, online_sec, updated_at) VALUES (?, ?, 100, 90, ?)`)
  .run(agentId, '2026-09-10', now);
sqlite.prepare(`INSERT INTO check_bucket_days (day, target_id, total, ok_count, sum_latency_ms, updated_at) VALUES (?, ?, 1, 1, 20, ?), (?, ?, 1, 0, 0, ?)`)
  .run('2026-09-10', rawId, now, '2026-09-11', agentId, now);
sqlite.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)`)
  .run(`traffic_corr:${agentId}`, JSON.stringify({ rx_bytes: 1, tx_bytes: 2 }), now);
sqlite.prepare(`INSERT INTO agent_metrics_state (agent_id, updated_at) VALUES (?, ?)`)
  .run(agentId, new Date(now * 1000).toISOString());
sqlite.prepare(`INSERT INTO agent_metrics_history (agent_id, ts, data) VALUES (?, ?, ?)`)
  .run(agentId, now, '{}');
sqlite.prepare(`INSERT INTO agent_traffic_monthly (agent_id, month, updated_at) VALUES (?, ?, ?)`)
  .run(agentId, '2026-09', now);
sqlite.prepare(`INSERT INTO agent_traffic_daily (agent_id, day, updated_at) VALUES (?, ?, ?)`)
  .run(agentId, '2026-09-10', now);
sqlite.prepare(`INSERT INTO ping_history (target_id, agent_id, ts, latency_ms, ok) VALUES (?, ?, ?, ?, 1)`)
  .run('dns', agentId, now, 20);

await deleteTarget(rawId, env);

assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM targets WHERE id = ?`).get(rawId).count, 0);
assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM agent_daily_availability WHERE agent_id = ?`).get(agentId).count, 0);
assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM agent_metrics_state WHERE agent_id = ?`).get(agentId).count, 0);
assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM agent_metrics_history WHERE agent_id = ?`).get(agentId).count, 0);
assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM agent_traffic_monthly WHERE agent_id = ?`).get(agentId).count, 0);
assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM agent_traffic_daily WHERE agent_id = ?`).get(agentId).count, 0);
assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ping_history WHERE agent_id = ?`).get(agentId).count, 0);
assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM check_bucket_days WHERE target_id IN (?, ?)`).get(rawId, agentId).count, 0);
assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM app_meta WHERE key = ?`).get(`traffic_corr:${agentId}`).count, 0);

console.log('target deletion orphan cleanup tests passed');

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
