import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { scheduleFlushDue, saveCheck } from '../src/probe.js';

const NOW = 1_800_000_000;

test('schedule flush is throttled per target with a configurable window', () => {
  assert.equal(scheduleFlushDue({ last_checked_at: NOW - 60 }, NOW, {}), false);
  assert.equal(scheduleFlushDue({ last_checked_at: NOW - 1800 }, NOW, {}), true);
  assert.equal(scheduleFlushDue({ last_checked_at: NOW - 3600 }, NOW, {}), true);
  assert.equal(scheduleFlushDue({}, NOW, {}), true);
  assert.equal(scheduleFlushDue({ last_checked_at: 0 }, NOW, {}), true);
  assert.equal(scheduleFlushDue({ last_checked_at: NOW - 60 }, NOW, { TARGET_SCHEDULE_FLUSH_SEC: 300 }), false);
  assert.equal(scheduleFlushDue({ last_checked_at: NOW - 360 }, NOW, { TARGET_SCHEDULE_FLUSH_SEC: 300 }), true);
});

test('selection no longer pre-filters on the stale next_probe_at mirror', async () => {
  const probeSource = await readFile(new URL('../src/probe.js', import.meta.url), 'utf8');
  const selection = probeSource.slice(probeSource.indexOf('export async function runDueTargets'), probeSource.indexOf('export function historyDueIntervalSec'));
  assert.doesNotMatch(selection, /next_probe_at <= \?/, 'the always-true next_probe_at pre-filter must stay out of the sweep query');
  assert.match(probeSource, /scheduleFlushDue\(/, 'probe writes must consult the schedule flush throttle');
});

test('throttled probes skip the targets schedule UPDATE entirely', async () => {
  const executed = [];
  const stmt = (sql) => {
    const handle = {
      sql,
      bind: (...args) => { executed.push({ sql: sql.slice(0, 60), args }); return handle; },
      run: async () => ({ meta: { changes: 1 } }),
      first: async () => null,
      all: async () => ({ results: [] }),
    };
    return handle;
  };
  const env = {
    DB: { prepare: stmt, batch: async (stmts) => stmts.map(() => ({ meta: { changes: 1 } })) },
    ARCHIVE: null,
    HISTORY_PROBE_HEALTHY_INTERVAL_SEC: 300,
  };
  const target = { id: 'vps-a', name: 'VPS A', type: 'tcp', target_host: 'vps-a.example.test', target_port: 443, interval_sec: 300, last_checked_at: NOW - 60, probe_region: 'auto' };
  const result = await saveCheck(env, target, NOW, { ok: true, latency_ms: 12, status_code: null, error: null, cf_colo: null }, null);
  assert.equal(result.storage, 'd1');
  const targetUpdates = executed.filter((item) => /UPDATE targets/i.test(item.sql));
  assert.equal(targetUpdates.length, 0, 'throttled probe must not write the targets schedule mirror');

  const staleTarget = { ...target, last_checked_at: NOW - 3600 };
  await saveCheck(env, staleTarget, NOW, { ok: true, latency_ms: 12, status_code: null, error: null, cf_colo: null }, null);
  const staleUpdates = executed.filter((item) => /UPDATE targets/i.test(item.sql));
  assert.equal(staleUpdates.length, 1, 'stale schedule mirror must be flushed once');
});
