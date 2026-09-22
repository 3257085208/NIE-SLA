import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPACITY_QUOTAS, estimateCapacity, estimateUsage } from '../src/admin/usage-model.js';

const fleet = { agents: 34, wssAgents: 31, targets: 38, pingTargets: 5, latencyNodes: 1, trafficAgents: 18, hours: 24 };

test('capacity fixture follows the embedded model point estimate', () => {
  const capacity = estimateCapacity(fleet);
  const estimate = estimateUsage(fleet);
  assert.equal(capacity.model_version, 'usage-model-embedded-v1.4.2');
  assert.equal(capacity.window_hours, 24);
  assert.deepEqual(capacity.per_node, { agents: 1, wss_agents: 1, targets: 1, ping_targets: 0, latency_nodes: 0, traffic_agents: 0 });

  for (const key of CAPACITY_QUOTAS) {
    const quota = capacity.quotas[key];
    assert.ok(quota, `${key} quota must exist`);
    assert.equal(quota.limit, estimate.quota[key].limit, `${key} limit`);
    assert.equal(quota.used, estimate.estimates[key], `${key} used`);
    assert.ok(Number.isFinite(quota.remaining) && quota.remaining >= 0, `${key} remaining`);
    assert.ok(quota.headroom_pct >= 0 && quota.headroom_pct <= 100, `${key} headroom`);
    assert.ok(Number.isInteger(quota.extra_nodes_80) && quota.extra_nodes_80 >= 0, `${key} extra 80`);
    assert.ok(Number.isInteger(quota.extra_nodes_100) && quota.extra_nodes_100 >= 0, `${key} extra 100`);
    assert.ok(quota.extra_nodes_80 <= quota.extra_nodes_100, `${key} 80% must be at most 100%`);
  }

  // Known fixture values (usage-model-embedded-v1.4.2, 24h window).
  assert.equal(capacity.quotas.workers_calls.extra_nodes_80, 249);
  assert.equal(capacity.quotas.workers_calls.extra_nodes_100, 362);
  assert.equal(capacity.quotas.do_requests.extra_nodes_80, 65);
  assert.equal(capacity.quotas.do_requests.extra_nodes_100, 92);
  assert.equal(capacity.quotas.d1_rows_read.extra_nodes_80, 105);
  assert.equal(capacity.quotas.d1_rows_read.extra_nodes_100, 152);
  assert.equal(capacity.quotas.d1_rows_written.extra_nodes_80, 61);
  assert.equal(capacity.quotas.d1_rows_written.extra_nodes_100, 92);
  assert.equal(capacity.quotas.r2_class_a.extra_nodes_100, 15702);
  assert.equal(capacity.quotas.r2_class_b.extra_nodes_100, 49022);
  assert.equal(capacity.inputs.latest_status_to_d1, true);
  assert.ok(capacity.notes.some((note) => note.includes('80%')), 'capacity notes must explain the 80% watermark');
});

test('capacity follows the deployment latest_status gate', () => {
  const capacity = estimateCapacity({ ...fleet, latestStatusToD1: false });
  assert.equal(capacity.inputs.latest_status_to_d1, false);
  assert.equal(capacity.quotas.d1_rows_written.extra_nodes_80, 119);
  assert.equal(capacity.quotas.d1_rows_written.extra_nodes_100, 167);
  const migrated = estimateCapacity({ ...fleet, latestStatusToD1: false });
  assert.ok(migrated.quotas.d1_rows_written.used < estimateCapacity(fleet).quotas.d1_rows_written.used, 'the disabled mirror must free D1 write headroom');
});

test('capacity shrinks monotonically as the fleet grows', () => {
  const base = estimateCapacity(fleet);
  const bigger = estimateCapacity({ ...fleet, agents: fleet.agents + 10, wssAgents: fleet.wssAgents + 10, targets: fleet.targets + 10 });
  for (const key of CAPACITY_QUOTAS) {
    assert.ok(bigger.quotas[key].extra_nodes_100 <= base.quotas[key].extra_nodes_100, `${key} extra 100 must not grow`);
    assert.ok(bigger.quotas[key].extra_nodes_80 <= base.quotas[key].extra_nodes_80, `${key} extra 80 must not grow`);
    assert.ok(bigger.quotas[key].remaining <= base.quotas[key].remaining, `${key} remaining must not grow`);
  }

  const empty = estimateCapacity({ agents: 0, wssAgents: 0, targets: 0, hours: 24 });
  for (const key of CAPACITY_QUOTAS) assert.ok(Number.isInteger(empty.quotas[key].extra_nodes_100), `${key} integer for empty fleet`);
  const emptyWss = estimateCapacity({}, { perNode: { agents: 1, wssAgents: 1, targets: 1 } });
  assert.ok(emptyWss.quotas.workers_calls.extra_nodes_100 >= base.quotas.workers_calls.extra_nodes_100, 'a smaller fleet must leave more room');
});

test('a per-node override changes the projection', () => {
  const wssDefault = estimateCapacity(fleet);
  const legacyNodes = estimateCapacity(fleet, { perNode: { wssAgents: 0 } });
  assert.equal(legacyNodes.per_node.wss_agents, 0);
  assert.ok(legacyNodes.quotas.workers_calls.extra_nodes_100 < wssDefault.quotas.workers_calls.extra_nodes_100, 'legacy nodes use more Workers calls');
  assert.ok(legacyNodes.quotas.do_requests.extra_nodes_100 > wssDefault.quotas.do_requests.extra_nodes_100, 'legacy nodes use fewer DO requests');
});
