import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateUsage } from '../src/admin/usage-model.js';
import { getStorageUsage } from '../src/admin/usage-storage.js';

const fleet = { agents: 34, wssAgents: 31, targets: 38, pingTargets: 5, latencyNodes: 1, trafficAgents: 18, hours: 24 };

test('estimate stays within metered reality envelopes (2026-09-16 calibration)', () => {
  const r = estimateUsage(fleet);
  assert.equal(r.model_version, 'usage-model-embedded-v1.4.0');
  assert.equal(r.inputs.public_rps, 0.42);
  assert.ok(r.estimates.workers_calls > 30_000 && r.estimates.workers_calls < 42_000, `workers ${r.estimates.workers_calls}`);
  assert.ok(r.estimates.do_requests > 25_000 && r.estimates.do_requests < 38_000, `do requests ${r.estimates.do_requests}`);
  assert.ok(r.estimates.do_rows_written > 30_000 && r.estimates.do_rows_written < 55_000, `do rows ${r.estimates.do_rows_written}`);
  assert.ok(r.estimates.d1_rows_written > 18_000 && r.estimates.d1_rows_written < 32_000, `d1 written ${r.estimates.d1_rows_written}`);
  assert.ok(r.estimates.d1_rows_read > 1_800_000 && r.estimates.d1_rows_read < 2_800_000, `d1 read ${r.estimates.d1_rows_read}`);
  assert.ok(r.estimates.r2_class_b > r.estimates.r2_class_a * 3, 'r2 b must stay far above a');
  assert.ok(r.estimates.d1_rows_read > r.estimates.d1_rows_written * 20, 'row reads must dwarf row writes');
  assert.ok(r.quota.do_requests.pct > 20 && r.quota.do_requests.pct < 70, 'do request quota pct visible');
  assert.ok(r.notes.some((note) => note.includes('索引行')), 'index amplification must be documented');
});

test('zero-fleet and tiny windows do not explode', () => {
  const r = estimateUsage({ agents: 0, wssAgents: 0, targets: 0, hours: 0.1 });
  for (const value of Object.values(r.estimates)) assert.ok(Number.isFinite(value));
  assert.ok(r.window_hours > 0);
});

function storageEnv() {
  const counts = { targets: 12, latest_status: 12, alert_state: 3 };
  return {
    DB: {
      prepare(sql) {
        return {
          values: [],
          bind(...values) { this.values = values; return this; },
          async first() {
            if (/PRAGMA page_count/i.test(sql)) return { page_count: 10 };
            if (/PRAGMA page_size/i.test(sql)) return { page_size: 4096 };
            const match = sql.match(/FROM\s+([a-z_]+)/i);
            if (match && counts[match[1]] !== undefined) return { n: counts[match[1]] };
            return { n: 0 };
          },
          async all() {
            if (/sqlite_master/i.test(sql)) return { results: Object.keys(counts).map((name) => ({ name })) };
            return { results: [] };
          },
          async run() { return { success: true }; },
        };
      },
    },
    ARCHIVE: {
      async list({ cursor } = {}) {
        if (cursor) return { objects: [], truncated: false, cursor: null };
        return { objects: [{ key: 'k1', size: 10 }, { key: 'k2', size: 20 }], truncated: false, cursor: null };
      },
    },
  };
}

test('storage usage reports D1 table rows, R2 totals and capacity projection', async () => {
  const result = await getStorageUsage(storageEnv());
  assert.equal(result.ok, true);
  assert.equal(result.d1.available, true);
  assert.equal(result.d1.table_count, 3);
  assert.equal(result.d1.total_rows, 27);
  assert.equal(result.d1.tables.find((row) => row.table === 'targets').rows, 12);
  assert.deepEqual(result.d1.tables.map((row) => row.table), ['targets', 'latest_status', 'alert_state']);
  assert.equal(result.d1.database_bytes, 10 * 4096);
  assert.equal(result.d1.database_size_available, true);
  assert.equal(result.r2.available, true);
  assert.equal(result.r2.objects, 2);
  assert.equal(result.r2.bytes, 30);
  assert.equal(result.r2.truncated, false);
  assert.equal(result.capacity.quotas.d1_rows_read.limit, 5_000_000);
  assert.ok(result.capacity.quotas.d1_rows_read.extra_nodes_100 > 0);
  assert.ok(Number.isInteger(result.capacity.quotas.r2_class_b.extra_nodes_80));
});

test('storage usage degrades safely without D1 or R2 bindings', async () => {
  const result = await getStorageUsage({});
  assert.equal(result.d1.available, false);
  assert.match(result.d1.error, /D1/);
  assert.equal(result.r2.available, false);
  assert.match(result.r2.error, /ARCHIVE/);
  assert.equal(result.capacity.quotas.workers_calls.limit, 100_000);
});
