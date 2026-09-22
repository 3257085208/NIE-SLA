import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { persistAgentTraffic, rebuildAgentTrafficPeriod } from '../src/metrics.js';
import { hasTrafficBaseline, summarizeTraffic, summarizeTrafficWithPending, trafficSettingsFromTarget } from '../src/traffic.js';

// Production incident replay: a target had traffic tracking enabled for the
// first time while its reset day was set in the same save. The rebuild path
// wrote a NULL counter baseline, and Number(null) === 0 made the next Agent
// report credit the whole boot-lifetime counter to the new billing period
// (VMISS HK: 801.6 GiB rx / 834.8 GiB tx shown as 163.6% of a 1000 GB quota).

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE targets (
      id TEXT PRIMARY KEY, traffic_enabled INTEGER NOT NULL DEFAULT 0, traffic_quota_gb REAL NOT NULL DEFAULT 0,
      traffic_mode TEXT DEFAULT 'total', traffic_reset_day INTEGER NOT NULL DEFAULT 1, expires_at INTEGER
    );
    CREATE TABLE agent_traffic_monthly (
      agent_id TEXT NOT NULL, month TEXT NOT NULL, rx_bytes INTEGER NOT NULL DEFAULT 0,
      tx_bytes INTEGER NOT NULL DEFAULT 0, last_rx_bytes INTEGER, last_tx_bytes INTEGER,
      active_day TEXT, day_rx_bytes INTEGER NOT NULL DEFAULT 0, day_tx_bytes INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, PRIMARY KEY (agent_id, month)
    );
    CREATE TABLE agent_traffic_daily (
      agent_id TEXT NOT NULL, day TEXT NOT NULL, rx_bytes INTEGER NOT NULL DEFAULT 0,
      tx_bytes INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (agent_id, day)
    );
    CREATE TABLE agent_metrics_state (agent_id TEXT PRIMARY KEY, net TEXT, updated_at TEXT);
  `);
  return db;
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
    async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
  };
}

function monthlyRow(db, agentId, month) {
  const row = db.prepare(`SELECT * FROM agent_traffic_monthly WHERE agent_id = ? AND month = ?`).get(agentId, month);
  return row ? { ...row } : null;
}

function targetRow(db, agentId) {
  const row = db.prepare(`SELECT * FROM targets WHERE id = ?`).get(agentId);
  return row ? { ...row } : null;
}

function addTarget(db, id, { resetDay = 1, quotaGb = 0, mode = 'total' } = {}) {
  db.prepare(`INSERT INTO targets (id, traffic_enabled, traffic_quota_gb, traffic_mode, traffic_reset_day, expires_at)
    VALUES (?, 1, ?, ?, ?, NULL)`).run(id, quotaGb, mode, resetDay);
}

// 1. NULL is not a zero baseline: the helper and every display path agree.
assert.equal(hasTrafficBaseline(null), false);
assert.equal(hasTrafficBaseline(undefined), false);
assert.equal(hasTrafficBaseline(''), false);
assert.equal(hasTrafficBaseline('  '), false);
assert.equal(hasTrafficBaseline(0), true);
assert.equal(hasTrafficBaseline('0'), true);

assert.deepEqual(summarizeTrafficWithPending(
  { rx_bytes: 0, tx_bytes: 0, last_rx_bytes: null, last_tx_bytes: null, updated_at: 1 },
  { enabled: true, mode: 'total', month: '2026-09-19', quota_bytes: 1_000_000 },
  { net: JSON.stringify({ rx_bytes: 860_677_498_921, tx_bytes: 896_365_854_658 }), updated_at: '2026-09-22T16:00:30.000Z' },
).total_bytes, 0, 'a NULL baseline must not surface the whole Agent counter as pending traffic');

// 2. Production replay: enable tracking + set the reset day, then feed the
//    Agent's boot-lifetime counter. Nothing may be credited in one jump.
{
  const db = createDatabase();
  addTarget(db, 'vmiss-hk', { resetDay: 19, quotaGb: 1000 });
  const env = { DB: d1(db), TIMEZONE_OFFSET_MINUTES: '480' };
  const enableTs = Date.parse('2026-09-20T10:00:51Z') / 1000;
  const settings = trafficSettingsFromTarget(targetRow(db, 'vmiss-hk'), env, enableTs);
  assert.equal(settings.period_start, '2026-09-19');
  assert.equal(settings.month, '2026-09-19');

  await rebuildAgentTrafficPeriod(env, 'vmiss-hk', targetRow(db, 'vmiss-hk'), enableTs);
  const afterRebuild = monthlyRow(db, 'vmiss-hk', '2026-09-19');
  assert.equal(afterRebuild.rx_bytes, 0);
  assert.equal(afterRebuild.tx_bytes, 0);
  assert.equal(afterRebuild.last_rx_bytes, null, 'without any known counter the rebuild keeps a NULL baseline');
  assert.deepEqual(
    summarizeTrafficWithPending(afterRebuild, settings, { net: JSON.stringify({ rx_bytes: 851_753_354_741, tx_bytes: 887_334_620_721 }), updated_at: 'x' }).total_bytes,
    0,
    'pending display stays at zero while the baseline is unknown',
  );

  await persistAgentTraffic(env, 'vmiss-hk', { net: { rx_bytes: 851_753_354_741, tx_bytes: 887_334_620_721 } }, enableTs + 60);
  const adopted = monthlyRow(db, 'vmiss-hk', '2026-09-19');
  assert.equal(adopted.rx_bytes, 0, 'the boot-lifetime counter must not be credited on the first report');
  assert.equal(adopted.tx_bytes, 0);
  assert.equal(adopted.last_rx_bytes, 851_753_354_741, 'the first report only adopts the baseline');
  assert.equal(adopted.last_tx_bytes, 887_334_620_721);

  await persistAgentTraffic(env, 'vmiss-hk', { net: { rx_bytes: 860_502_026_629, tx_bytes: 896_194_543_681 } }, enableTs + 5400);
  const counted = monthlyRow(db, 'vmiss-hk', '2026-09-19');
  assert.equal(counted.rx_bytes, 8_748_671_888, 'only traffic after the adopted baseline is counted');
  assert.equal(counted.tx_bytes, 8_859_922_960);
}

// 3. Rebuild with a known counter adopts it as the baseline instead of NULL.
{
  const db = createDatabase();
  addTarget(db, 'fresh-vps', { resetDay: 19, quotaGb: 1000 });
  const env = { DB: d1(db), TIMEZONE_OFFSET_MINUTES: '480' };
  const enableTs = Date.parse('2026-09-20T10:00:51Z') / 1000;
  db.prepare(`INSERT INTO agent_metrics_state (agent_id, net, updated_at) VALUES (?, ?, ?)`)
    .run('fresh-vps', JSON.stringify({ rx_bytes: 5_000_000_000, tx_bytes: 6_000_000_000 }), '2026-09-20T10:00:40.000Z');

  await rebuildAgentTrafficPeriod(env, 'fresh-vps', targetRow(db, 'fresh-vps'), enableTs);
  const row = monthlyRow(db, 'fresh-vps', '2026-09-19');
  assert.equal(row.rx_bytes, 0);
  assert.equal(row.last_rx_bytes, 5_000_000_000, 'rebuild adopts the last known counter as baseline');
  assert.equal(row.last_tx_bytes, 6_000_000_000);
  const settings = trafficSettingsFromTarget(targetRow(db, 'fresh-vps'), env, enableTs);
  assert.equal(summarizeTrafficWithPending(row, settings, {
    net: JSON.stringify({ rx_bytes: 5_000_000_000, tx_bytes: 6_000_000_000 }), updated_at: 'x',
  }).total_bytes, 0, 'no phantom pending right after the rebuild');

  await persistAgentTraffic(env, 'fresh-vps', { net: { rx_bytes: 5_000_000_500, tx_bytes: 6_000_000_700 } }, enableTs + 3600);
  const counted = monthlyRow(db, 'fresh-vps', '2026-09-19');
  assert.equal(counted.rx_bytes, 500);
  assert.equal(counted.tx_bytes, 700);
}

// 4. Counter resets (Agent reboot) must not repeat history, and rx/tx stay
//    independent so the double-direction billable total is summed exactly once.
{
  const db = createDatabase();
  addTarget(db, 'reboot-vps', { resetDay: 1 });
  const env = { DB: d1(db), TIMEZONE_OFFSET_MINUTES: '0' };
  const t0 = Date.parse('2026-09-10T00:00:00Z') / 1000;

  await persistAgentTraffic(env, 'reboot-vps', { net: { rx_bytes: 1_000_000, tx_bytes: 2_000_000 } }, t0);
  let row = monthlyRow(db, 'reboot-vps', '2026-09-01');
  assert.equal(row.rx_bytes, 0, 'first ever report adopts the baseline without crediting the counter');
  assert.equal(row.tx_bytes, 0);
  assert.equal(row.last_rx_bytes, 1_000_000);
  assert.equal(row.last_tx_bytes, 2_000_000);

  await persistAgentTraffic(env, 'reboot-vps', { net: { rx_bytes: 1_500_000, tx_bytes: 2_200_000 } }, t0 + 3600);
  row = monthlyRow(db, 'reboot-vps', '2026-09-01');
  assert.equal(row.rx_bytes, 500_000);
  assert.equal(row.tx_bytes, 200_000);

  await persistAgentTraffic(env, 'reboot-vps', { net: { rx_bytes: 100, tx_bytes: 50 } }, t0 + 7200);
  row = monthlyRow(db, 'reboot-vps', '2026-09-01');
  assert.equal(row.rx_bytes, 500_000, 'a counter reset does not subtract or re-add history');
  assert.equal(row.tx_bytes, 200_000);
  assert.equal(row.last_rx_bytes, 100, 'the baseline rebases onto the reset counter');

  await persistAgentTraffic(env, 'reboot-vps', { net: { rx_bytes: 400, tx_bytes: 150 } }, t0 + 10800);
  row = monthlyRow(db, 'reboot-vps', '2026-09-01');
  assert.equal(row.rx_bytes, 500_300, 'only post-reset growth is counted');
  assert.equal(row.tx_bytes, 200_100);

  const settings = trafficSettingsFromTarget(targetRow(db, 'reboot-vps'), env, t0 + 10800);
  const summary = summarizeTrafficWithPending(row, settings, {
    net: JSON.stringify({ rx_bytes: 400, tx_bytes: 150 }), updated_at: 'x',
  });
  assert.equal(summary.raw_total_bytes, 500_300 + 200_100, 'rx and tx are summed independently');
  assert.equal(summary.total_bytes, 700_400, 'double-direction billing adds rx + tx exactly once');
  assert.equal(
    summarizeTraffic({ rx_bytes: 500_300, tx_bytes: 200_100 }, { ...settings, mode: 'tx' }).total_bytes,
    200_100,
    'mode filtering still selects one direction only',
  );
  assert.equal(
    summarizeTraffic({ rx_bytes: 500_300, tx_bytes: 200_100 }, { ...settings, mode: 'max' }).total_bytes,
    500_300,
    'max mode still selects the larger direction',
  );
}

// 5. Rebuild keeps carrying the not-yet-persisted delta for an existing row.
{
  const db = createDatabase();
  addTarget(db, 'tracked-vps', { resetDay: 1 });
  const env = { DB: d1(db), TIMEZONE_OFFSET_MINUTES: '0' };
  const t0 = Date.parse('2026-09-10T00:00:00Z') / 1000;
  await persistAgentTraffic(env, 'tracked-vps', { net: { rx_bytes: 1_000_000, tx_bytes: 1_000_000 } }, t0);
  await persistAgentTraffic(env, 'tracked-vps', { net: { rx_bytes: 1_400_000, tx_bytes: 1_300_000 } }, t0 + 3600);
  db.prepare(`INSERT INTO agent_metrics_state (agent_id, net, updated_at) VALUES (?, ?, ?)`)
    .run('tracked-vps', JSON.stringify({ rx_bytes: 1_700_000, tx_bytes: 1_600_000 }), '2026-09-10T02:00:00.000Z');

  db.prepare(`UPDATE targets SET traffic_reset_day = 2 WHERE id = 'tracked-vps'`).run();
  await rebuildAgentTrafficPeriod(env, 'tracked-vps', targetRow(db, 'tracked-vps'), t0 + 7200);
  const row = monthlyRow(db, 'tracked-vps', '2026-09-02');
  assert.equal(row.rx_bytes, 700_000, 'daily ledger plus the pending delta is carried into the new period');
  assert.equal(row.tx_bytes, 600_000);
  assert.equal(row.last_rx_bytes, 1_700_000);
  assert.equal(
    summarizeTrafficWithPending(row, trafficSettingsFromTarget(targetRow(db, 'tracked-vps'), env, t0 + 7200), {
      net: JSON.stringify({ rx_bytes: 1_700_000, tx_bytes: 1_600_000 }), updated_at: 'x',
    }).total_bytes,
    1_300_000,
    'display does not double-add the carried delta',
  );
}

console.log('traffic counter baseline tests passed');
