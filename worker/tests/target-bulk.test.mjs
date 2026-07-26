import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyBulkTargetColumns, normalizeBulkTargetUpdate } from '../src/admin/target-bulk.js';
import { readFile } from 'node:fs/promises';

const valid = normalizeBulkTargetUpdate({
  ids: ['vps-a', ' vps-b ', 'vps-a'],
  changes: {
    provider: ' DediRock ',
    line_type: '线路机',
    expires_at: '2028-03-10',
    price: 12.5,
    currency: 'usd',
    billing_cycle: 'yearly',
    traffic_enabled: true,
    traffic_quota_gb: 2048,
    traffic_mode: 'RX',
    traffic_reset_day: 24,
    alert_enabled: false,
    alert_expiry_days: null,
    alert_traffic_remaining_percent: 10,
    alert_traffic_remaining_gb: '',
  },
});
assert.equal(valid.ok, true);
assert.deepEqual(valid.ids, ['vps-a', 'vps-b']);
assert.equal(valid.changes.provider, 'DediRock');
assert.equal(valid.changes.currency, 'USD');
assert.equal(valid.changes.traffic_mode, 'rx');

assert.equal(normalizeBulkTargetUpdate({ ids: [], changes: { provider: 'A' } }).ok, false);
assert.equal(normalizeBulkTargetUpdate({ ids: ['a'], changes: {} }).ok, false);
assert.match(normalizeBulkTargetUpdate({ ids: ['a'], changes: { name: 'forbidden' } }).error, /不支持/);
assert.match(normalizeBulkTargetUpdate({ ids: ['a'], changes: { traffic_reset_day: 32 } }).error, /1–31/);
assert.match(normalizeBulkTargetUpdate({ ids: ['a'], changes: { traffic_enabled: 'true' } }).error, /开启或关闭/);
assert.match(normalizeBulkTargetUpdate({ ids: ['a'], changes: { expires_at: '2026-02-31' } }).error, /到期时间/);
assert.match(normalizeBulkTargetUpdate({ ids: ['a'], changes: { alert_traffic_remaining_percent: 101 } }).error, /0–100/);
assert.match(normalizeBulkTargetUpdate({
  ids: Array.from({ length: 101 }, (_, index) => `vps-${index}`),
  changes: { provider: 'A' },
}).error, /100/);
assert.equal(normalizeBulkTargetUpdate({
  ids: Array.from({ length: 100 }, (_, index) => `vps-${index}`),
  changes: { provider: 'A', traffic_quota_gb: 1024 },
}).ok, true);
assert.match(normalizeBulkTargetUpdate({
  ids: Array.from({ length: 16 }, (_, index) => `vps-${index}`),
  changes: { traffic_reset_day: 24 },
}).error, /15/);

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`
  CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE targets (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, provider TEXT, line_type TEXT, expires_at INTEGER,
    price REAL, currency TEXT, billing_cycle TEXT, traffic_enabled INTEGER, traffic_quota_gb REAL,
    traffic_mode TEXT, traffic_reset_day INTEGER, alert_enabled INTEGER, alert_expiry_days INTEGER,
    alert_traffic_remaining_percent REAL, alert_traffic_remaining_gb REAL, updated_at INTEGER
  );
  CREATE TABLE nodes (
    id TEXT PRIMARY KEY, provider TEXT, machine_type TEXT, expires_at INTEGER, price REAL,
    currency TEXT, billing_cycle TEXT, traffic_enabled INTEGER, traffic_quota_gb REAL,
    traffic_mode TEXT, traffic_reset_day INTEGER, alert_enabled INTEGER, alert_expiry_days INTEGER,
    alert_traffic_remaining_percent REAL, alert_traffic_remaining_gb REAL, updated_at INTEGER
  );
  INSERT INTO targets (id, type, provider, price, expires_at, updated_at) VALUES
    ('vps-a', 'tcp', 'Old', 10, 100, 1), ('vps-b', 'tcp', 'Old', 20, 200, 1),
    ('web-a', 'http', 'Web', 30, 300, 1);
  INSERT INTO nodes (id, provider, price, expires_at, updated_at) VALUES
    ('vps-a', 'Old', 10, 100, 1), ('vps-b', 'Old', 20, 200, 1);
`);
const env = { DB: d1(sqlite), TIMEZONE_OFFSET_MINUTES: '480' };
const result = await applyBulkTargetColumns(env, ['vps-a', 'vps-b'], {
  provider: null, price: null, expires_at: null, traffic_enabled: 1,
}, 12345);
assert.equal(result.ok, true);
assert.equal(result.count, 2);
for (const id of ['vps-a', 'vps-b']) {
  const target = sqlite.prepare(`SELECT provider, price, expires_at, traffic_enabled FROM targets WHERE id = ?`).get(id);
  assert.deepEqual({ ...target }, { provider: null, price: null, expires_at: null, traffic_enabled: 1 });
  const node = sqlite.prepare(`SELECT provider, price, expires_at, traffic_enabled FROM nodes WHERE id = ?`).get(id);
  assert.deepEqual({ ...node }, { provider: '', price: null, expires_at: null, traffic_enabled: 1 });
}
const rejected = await applyBulkTargetColumns(env, ['vps-a', 'web-a'], { provider: 'New' }, 12346);
assert.equal(rejected.ok, false);
assert.equal(sqlite.prepare(`SELECT provider FROM targets WHERE id = 'vps-a'`).get().provider, null,
  'a mixed VPS/Web request must not update any row');

const routeSource = await readFile(new URL('../src/routes.js', import.meta.url), 'utf8');
assert.match(routeSource, /\{ method: 'PATCH', path: '\/api\/targets\/bulk', rl: 'write' \}/,
  'the protected route allowlist must include bulk target updates');
assert.ok(routeSource.indexOf("path === '/api/targets/bulk'") < routeSource.indexOf("path.match(/^\\/api\\/targets\\/([^/]+)$/)"),
  'the exact bulk route must run before the parameterized target route');
assert.match(routeSource, /path === '\/api\/targets\/bulk'[\s\S]*withAdmin\(request, env\)[\s\S]*bulkUpdateTargets\(request, env\)[\s\S]*clearStatusCaches/,
  'bulk target updates must require an admin session and clear public status caches');

console.log('target bulk update validation tests passed');

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
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
