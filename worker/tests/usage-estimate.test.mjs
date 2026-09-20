import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateUsage } from '../src/admin/usage-model.js';

const fleet = { agents: 34, wssAgents: 31, targets: 38, pingTargets: 5, latencyNodes: 1, trafficAgents: 18, hours: 24 };

test('estimate stays within metered reality envelopes (2026-09-16 calibration)', () => {
  const r = estimateUsage(fleet);
  assert.equal(r.model_version, 'usage-model-embedded-v1.4.0');
  assert.equal(r.inputs.public_rps, 0.42);
  assert.ok(r.estimates.workers_calls > 30_000 && r.estimates.workers_calls < 42_000, `workers ${r.estimates.workers_calls}`);
  assert.ok(r.estimates.do_requests > 25_000 && r.estimates.do_requests < 38_000, `do requests ${r.estimates.do_requests}`);
  assert.ok(r.estimates.do_rows_written > 30_000 && r.estimates.do_rows_written < 55_000, `do rows ${r.estimates.do_rows_written}`);
  assert.ok(r.estimates.d1_rows_written > 45_000 && r.estimates.d1_rows_written < 75_000, `d1 written ${r.estimates.d1_rows_written}`);
  assert.ok(r.estimates.d1_rows_read > 2_200_000 && r.estimates.d1_rows_read < 3_600_000, `d1 read ${r.estimates.d1_rows_read}`);
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
