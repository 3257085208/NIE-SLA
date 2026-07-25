import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ensureV6Schema } from '../src/admin/schema.js';
import { persistAgentTraffic, rebuildAgentTrafficPeriod } from '../src/metrics.js';
import { trafficSettingsFromTarget } from '../src/traffic.js';

globalThis.crypto ||= webcrypto;

const database = new DatabaseSync(':memory:');
database.exec(`
  CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE targets (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT 'Default',
    type TEXT NOT NULL CHECK (type IN ('tcp', 'http')), target_host TEXT, target_port INTEGER,
    url TEXT, method TEXT DEFAULT 'GET', expected_status TEXT DEFAULT '', timeout_ms INTEGER NOT NULL DEFAULT 5000,
    interval_sec INTEGER NOT NULL DEFAULT 300, probe_region TEXT NOT NULL DEFAULT 'auto', enabled INTEGER NOT NULL DEFAULT 1,
    no_public_ip INTEGER NOT NULL DEFAULT 0, sort_order INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_checked_at INTEGER, expires_at INTEGER, price REAL, billing_cycle TEXT DEFAULT '', tags TEXT DEFAULT '',
    location TEXT DEFAULT '', city TEXT DEFAULT '', currency TEXT DEFAULT 'USD', traffic_enabled INTEGER NOT NULL DEFAULT 0,
    traffic_quota_gb REAL NOT NULL DEFAULT 0, traffic_mode TEXT DEFAULT 'total', alert_enabled INTEGER NOT NULL DEFAULT 1,
    alert_expiry_days INTEGER, alert_traffic_remaining_percent REAL, alert_traffic_remaining_gb REAL,
    provider TEXT DEFAULT '', line_type TEXT DEFAULT '', nq_report TEXT DEFAULT '', nq_updated_at INTEGER
  );
  CREATE TABLE agent_traffic_monthly (
    agent_id TEXT NOT NULL, month TEXT NOT NULL, rx_bytes INTEGER NOT NULL DEFAULT 0,
    tx_bytes INTEGER NOT NULL DEFAULT 0, last_rx_bytes INTEGER, last_tx_bytes INTEGER,
    updated_at INTEGER NOT NULL, PRIMARY KEY (agent_id, month)
  );
`);

const oldExpiry = Date.parse('2027-01-26T16:00:00.000Z') / 1000; // 27th in UTC+8.
database.prepare(`INSERT INTO targets
  (id, name, group_name, type, target_host, target_port, timeout_ms, interval_sec, probe_region, enabled, created_at, updated_at, expires_at, traffic_enabled)
  VALUES ('legacy-vps', 'Legacy VPS', 'VPS', 'tcp', '203.0.113.10', 443, 5000, 300, 'auto', 1, 1, 1, ?, 1)`)
  .run(oldExpiry);
database.prepare(`INSERT INTO agent_traffic_monthly
  (agent_id, month, rx_bytes, tx_bytes, last_rx_bytes, last_tx_bytes, updated_at)
  VALUES ('legacy-vps', '2026-06-27', 100, 200, 1000, 2000, 1)`).run();

const env = { DB: d1(database), TIMEZONE_OFFSET_MINUTES: '480' };
const originalDateNow = Date.now;
Date.now = () => Date.parse('2026-07-19T04:00:00.000Z');
await ensureV6Schema(env);

assert.equal(database.prepare(`SELECT traffic_reset_day FROM targets WHERE id = 'legacy-vps'`).get().traffic_reset_day, 27,
  'migration must freeze the legacy expiry-derived reset day');
assert.deepEqual(
  { ...database.prepare(`SELECT day, rx_bytes, tx_bytes FROM agent_traffic_daily WHERE agent_id = 'legacy-vps'`).get() },
  { day: '2026-07-19', rx_bytes: 100, tx_bytes: 200 },
  'migration must preserve an indivisible legacy total on the upgrade day',
);

await persistAgentTraffic(env, 'legacy-vps', { net: { rx_bytes: 1100, tx_bytes: 2200 } }, Date.parse('2026-07-19T05:00:00Z') / 1000);
await persistAgentTraffic(env, 'legacy-vps', { net: { rx_bytes: 1300, tx_bytes: 2500 } }, Date.parse('2026-07-21T05:00:00Z') / 1000);
await persistAgentTraffic(env, 'legacy-vps', { net: { rx_bytes: 1400, tx_bytes: 2600 } }, Date.parse('2026-07-21T06:00:00Z') / 1000);
assert.deepEqual(
  { ...database.prepare(`SELECT rx_bytes, tx_bytes FROM agent_traffic_daily WHERE agent_id = 'legacy-vps' AND day = '2026-07-19'`).get() },
  { rx_bytes: 200, tx_bytes: 400 },
  'crossing into a new day must finalize the previous day exactly once',
);
assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM agent_traffic_daily WHERE agent_id = 'legacy-vps'`).get().count, 1,
  'same-day reports must not add daily rows');

Date.now = () => Date.parse('2026-07-25T04:00:00.000Z');
database.prepare(`UPDATE targets SET expires_at = ? WHERE id = 'legacy-vps'`)
  .run(Date.parse('2027-02-18T00:00:00Z') / 1000);
let legacy = database.prepare(`SELECT expires_at, traffic_reset_day FROM targets WHERE id = 'legacy-vps'`).get();
assert.equal(legacy.traffic_reset_day, 27, 'changing expiry must not change the traffic reset day');

database.prepare(`UPDATE targets SET traffic_reset_day = 20 WHERE id = 'legacy-vps'`).run();
await rebuildAgentTrafficPeriod(env, 'legacy-vps', database.prepare(`SELECT * FROM targets WHERE id = 'legacy-vps'`).get());
legacy = database.prepare(`SELECT expires_at, traffic_reset_day FROM targets WHERE id = 'legacy-vps'`).get();
assert.equal(legacy.traffic_reset_day, 20);
assert.deepEqual(
  { ...database.prepare(`SELECT rx_bytes, tx_bytes, last_rx_bytes, last_tx_bytes, active_day, day_rx_bytes, day_tx_bytes FROM agent_traffic_monthly WHERE agent_id = 'legacy-vps' AND month = '2026-07-20'`).get() },
  { rx_bytes: 300, tx_bytes: 400, last_rx_bytes: 1400, last_tx_bytes: 2600, active_day: '2026-07-21', day_rx_bytes: 300, day_tx_bytes: 400 },
  'changing reset day must rebuild the current period from finalized days plus the active day',
);
assert.equal(trafficSettingsFromTarget(legacy, env, Date.parse('2026-07-21T00:00:00Z') / 1000).period_start, '2026-07-20');

await persistAgentTraffic(env, 'legacy-vps', { net: { rx_bytes: 1500, tx_bytes: 2800 } }, Date.parse('2026-07-26T05:00:00Z') / 1000);
Date.now = () => Date.parse('2026-07-26T05:00:00.000Z');
database.prepare(`UPDATE targets SET traffic_reset_day = 24 WHERE id = 'legacy-vps'`).run();
await rebuildAgentTrafficPeriod(env, 'legacy-vps', database.prepare(`SELECT * FROM targets WHERE id = 'legacy-vps'`).get());
assert.deepEqual(
  { ...database.prepare(`SELECT rx_bytes, tx_bytes FROM agent_traffic_monthly WHERE agent_id = 'legacy-vps' AND month = '2026-07-24'`).get() },
  { rx_bytes: 100, tx_bytes: 200 },
  'moving the reset day forward must exclude daily traffic before the new period',
);
database.prepare(`UPDATE targets SET traffic_reset_day = 20 WHERE id = 'legacy-vps'`).run();
await rebuildAgentTrafficPeriod(env, 'legacy-vps', database.prepare(`SELECT * FROM targets WHERE id = 'legacy-vps'`).get());
database.prepare(`UPDATE targets SET traffic_reset_day = 22 WHERE id = 'legacy-vps'`).run();
await rebuildAgentTrafficPeriod(env, 'legacy-vps', database.prepare(`SELECT * FROM targets WHERE id = 'legacy-vps'`).get());
assert.deepEqual(
  { ...database.prepare(`SELECT month, rx_bytes, tx_bytes FROM agent_traffic_monthly WHERE agent_id = 'legacy-vps' ORDER BY updated_at DESC LIMIT 1`).get() },
  { month: '2026-07-22', rx_bytes: 100, tx_bytes: 200 },
  'repeated reset-day changes in the same second must keep the newest period active',
);
assert.deepEqual(
  database.prepare(`SELECT day, rx_bytes, tx_bytes FROM agent_traffic_daily WHERE agent_id = 'legacy-vps' ORDER BY day`).all().map(row => ({ ...row })),
  [
    { day: '2026-07-19', rx_bytes: 200, tx_bytes: 400 },
    { day: '2026-07-21', rx_bytes: 300, tx_bytes: 400 },
  ],
  'daily history must remain available for later period recalculation',
);

Date.now = originalDateNow;
console.log('independent traffic reset day tests passed');

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
    async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
  };
}
