import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adminSessionHeaders,
  classifyLogRoute,
  DEFAULT_CALIBRATION,
  estimateUsage,
  fetchDebugLogSummary,
  fitCalibration,
  normalizeLogs,
  normalizeStatus,
  usageSummaryTokenHeaders,
} from '../scripts/usage-model.mjs';

const FROM = 1_700_000_000;
const TO = FROM + 86_400;

function target(id, type, version, extra = {}) {
  return {
    id,
    type,
    enabled: 1,
    agent_version: version,
    agent_online: type === 'tcp',
    last_metrics_at: type === 'tcp' ? new Date((TO - 30) * 1000).toISOString() : null,
    agent_metrics: type === 'tcp' ? { updated_at: new Date((TO - 30) * 1000).toISOString() } : null,
    interval_sec: 300,
    latency_sources: [{ id: 'cloudflare', kind: 'cloudflare' }, { id: 'latency-a', kind: 'external' }],
    ...extra,
  };
}

const STATUS = {
  now: new Date(TO * 1000).toISOString(),
  targets: [
    target('tcp-new', 'tcp', 'v1.1.23'),
    target('tcp-old', 'tcp', 'v1.1.12'),
    target('tcp-mid', 'tcp', 'v1.1.16'),
    target('web', 'http', null, { agent_online: false, agent_metrics: null, latency_sources: [] }),
  ],
  ping_targets: [{ id: 'ping-a', enabled: 1 }],
};

const LOGS = normalizeLogs([
  { ts: FROM + 10, method: 'GET', path: '/api/agent/tasks', status: 200, actor: 'agent-a' },
  { ts: FROM + 20, method: 'GET', path: '/api/agent/tasks', status: 200, actor: 'agent-b' },
  { ts: FROM + 30, method: 'POST', path: '/api/agent/tasks/task-1', status: 200, actor: 'agent-a' },
  { ts: FROM + 40, method: 'GET', path: '/api/agent/update-policy', status: 200, actor: 'agent-a' },
  { ts: FROM + 50, method: 'GET', path: '/api/agent/config', status: 200, actor: 'agent-a' },
  { ts: FROM + 60, method: 'POST', path: '/api/agent/location', status: 200, actor: 'agent-a' },
  { ts: FROM + 70, method: 'GET', path: '/api/latency-agent/update-policy', status: 401, actor: 'latency-a' },
  { ts: FROM + 80, method: 'GET', path: '/api/agent-tasks?limit=100', status: 200, actor: 'admin' },
  { ts: FROM + 90, method: 'GET', path: '/api/targets', status: 200, actor: 'admin' },
], { from: FROM, to: TO });

test('route classification separates task polling from task actions', () => {
  assert.equal(classifyLogRoute('/api/agent/tasks', 'GET'), 'agent_tasks');
  assert.equal(classifyLogRoute('/api/agent/tasks/id-1', 'POST'), 'agent_task_action');
  assert.equal(classifyLogRoute('/api/agent-tasks', 'GET'), 'admin_agent_tasks');
  assert.equal(classifyLogRoute('/api/agent/config?agent_id=x', 'GET'), 'agent_config');
});

test('status normalization uses current topology without exposing target data', () => {
  assert.deepEqual(normalizeStatus(STATUS), {
    target_count: 4,
    tcp_target_count: 3,
    http_target_count: 1,
    probe_target_count: 4,
    agent_count: 3,
    online_agent_count: 3,
    wss_capable_agent_count: 2,
    legacy_or_unknown_agent_count: 1,
    unknown_version_agent_count: 0,
    version_buckets: { 'v1.1.23': 1, 'v1.1.12': 1, 'v1.1.16': 1 },
    latency_node_count: 1,
    ping_target_count: 1,
    traffic_agent_count: 0,
    target_intervals: [300],
  });
});

test('v1.3 uses the paired-window public request and the current-state D1 write calibration', () => {
  assert.equal(DEFAULT_CALIBRATION.model_version, 'usage-model-v1.3.3');
  assert.equal(DEFAULT_CALIBRATION.factors.workers_public_rps.point, 0.42);
  assert.equal(DEFAULT_CALIBRATION.factors.r2_public_read_rate.point, 0.38);
  assert.equal(DEFAULT_CALIBRATION.factors.d1_rows_read_multiplier.point, 2.65);
  assert.equal(DEFAULT_CALIBRATION.factors.d1_rows_written_multiplier.point, 1.92);

  const result = estimateUsage({ status: STATUS, from: FROM, to: TO });
  assert.equal(result.model_version, 'usage-model-v1.3.3');
  assert.equal(result.workers.assumptions.public_rps.point, 0.42);
  assert.equal(result.d1.assumptions.rows_read_multiplier.point, 2.65);
  assert.equal(result.d1.assumptions.rows_written_multiplier.point, 1.92);
  assert.match(result.workers.excluded[0], /Asset/);
  assert.match(result.workers.excluded[1], /WSS/);
});

test('v1.3.2 adds a Durable Object request ledger and coarse schedule writes', () => {
  const result = estimateUsage({ status: STATUS, from: FROM, to: TO });
  const wss = result.do.components.find((item) => item.id === 'do_telemetry_wss');
  const probeAppend = result.do.components.find((item) => item.id === 'do_probe_history_append');
  const scheduled = result.do.components.find((item) => item.id === 'do_probe_region_scheduled');
  const stream = result.do.components.find((item) => item.id === 'do_status_stream_publish');
  assert.ok(wss && probeAppend && scheduled && stream);
  assert.deepEqual(wss.count, { estimate: 576, low: 490, high: 605 });
  assert.deepEqual(wss.do.requests, wss.count);
  assert.deepEqual(probeAppend.do.requests, { estimate: 1_152, low: 1_152, high: 1_152 });
  assert.deepEqual(scheduled.do.requests, { estimate: 1_440, low: 1_440, high: 1_440 });
  assert.ok(stream.do.requests.low <= stream.do.requests.estimate && stream.do.requests.estimate <= stream.do.requests.high);
  assert.ok(result.do.requests.estimate > 2_000);
  assert.ok(result.do.requests.low <= result.do.requests.estimate && result.do.requests.estimate <= result.do.requests.high);
  assert.equal(result.do.assumptions.free_tier_limit_requests_per_day, 100_000);
  const schedule = result.d1.components.find((item) => item.id === 'd1_probe_persist');
  assert.ok(schedule, 'coarse schedule flush event must exist');
  assert.equal(schedule.count.estimate, Math.round(4 * 48 * 1.15));
  assert.match(schedule.label, /30/);
  const withoutRegionProxy = estimateUsage({ status: STATUS, from: FROM, to: TO, options: { regionProxy: false } });
  const scheduledWithoutProxy = withoutRegionProxy.do.components.find((item) => item.id === 'do_probe_region_scheduled');
  assert.deepEqual(scheduledWithoutProxy.count, { estimate: 0, low: 0, high: 0 });
});

test('probe history archive expectation is linear with window length', () => {
  const sixHours = estimateUsage({ status: STATUS, from: FROM, to: FROM + 6 * 3_600 });
  const archive = sixHours.r2.components.find((item) => item.id === 'probe_history_archive');
  assert.deepEqual(archive.count, { estimate: 1, low: 0, high: 8 });
  assert.equal(archive.r2.class_a.estimate, 1);
  const fullDay = estimateUsage({ status: STATUS, from: FROM, to: TO });
  const fullArchive = fullDay.r2.components.find((item) => item.id === 'probe_history_archive');
  assert.equal(fullArchive.count.estimate, 4);
});

test('usage summary metadata backfills window records from route counts', () => {
  const logs = {
    available: true,
    complete: true,
    route_counts: { agent_tasks: 12, other_debug: 3 },
    status_counts: {},
    window_from: new Date(FROM * 1000).toISOString(),
    window_to: new Date(TO * 1000).toISOString(),
  };
  const result = estimateUsage({ status: STATUS, logs, from: FROM, to: TO });
  assert.equal(result.input.logs_window_records, 15);
});

test('complete site logs replace derived selected-route counts and remain bounded', () => {
  assert.equal(LOGS.complete, true);
  assert.equal(LOGS.route_counts.agent_tasks, 2);
  assert.equal(LOGS.route_counts.agent_task_action, 1);
  assert.equal(LOGS.route_counts.other_debug, 1);
  assert.equal(LOGS.status_counts['401'], 1);
  const result = estimateUsage({ status: STATUS, logs: LOGS, from: FROM, to: TO });
  const taskPoll = result.workers.components.find((item) => item.id === 'agent_tasks');
  const taskAction = result.workers.components.find((item) => item.id === 'agent_task_action');
  const ws = result.workers.components.find((item) => item.id === 'agent_metrics_ws');
  assert.deepEqual(taskPoll.worker_calls, { estimate: 2, low: 2, high: 2 });
  assert.deepEqual(taskAction.worker_calls, { estimate: 1, low: 1, high: 1 });
  assert.deepEqual(ws.worker_calls, { estimate: 0, low: 0, high: 0 });
  assert.ok(result.workers.function_calls.estimate > 2_000);
  assert.ok(result.r2.class_a.estimate > 0);
  assert.ok(result.r2.class_b.estimate > result.r2.class_a.estimate);
  assert.ok(result.d1.queries.estimate > 0);
  for (const metric of [result.workers.function_calls, result.r2.class_a, result.r2.class_b, result.d1.queries, result.d1.rows_read, result.d1.rows_written]) {
    assert.ok(metric.low <= metric.estimate && metric.estimate <= metric.high);
  }
  assert.equal(result.input.logs_complete, true);
  assert.equal(result.observability.confidence, 'medium');
});

test('aggregate debug summary has the same route semantics without raw records', () => {
  const summary = {
    ok: true,
    available: true,
    complete: true,
    total: 4,
    route_counts: {
      agent_tasks: 1,
      agent_task_action: 1,
      admin_agent_tasks: 1,
      other_debug: 1,
    },
    status_counts: { '200': 3, '500': 1 },
    query: { statements: 1, aggregate_rows_returned: 4, raw_rows_returned: 0 },
  };
  const logs = normalizeLogs(summary, { from: FROM, to: TO });
  assert.equal(logs.available, true);
  assert.equal(logs.complete, true);
  assert.equal(logs.records, 4);
  assert.equal(logs.route_counts.agent_tasks, 1);
  assert.equal(logs.route_counts.agent_task_action, 1);
  assert.equal(logs.route_counts.admin_agent_tasks, 1);
  assert.equal(logs.status_counts['500'], 1);
  assert.equal(logs.aggregation.statements, 1);
});

test('debug summary uses the Worker x-admin-session contract and never rewrites it as Cookie or Bearer auth', async () => {
  const originalFetch = globalThis.fetch;
  const session = 'aA1_bB2-cC3dD4eE5fF6gG7hH8iI9jJ0';
  let observed = null;
  globalThis.fetch = async (url, options = {}) => {
    observed = { url: String(url), headers: options.headers || {}, cache: options.cache, redirect: options.redirect };
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          available: true,
          complete: true,
          total: 1,
          route_counts: { agent_tasks: 1 },
          status_counts: { '200': 1 },
          window: { from: FROM, to: TO },
          query: { statements: 1, aggregate_rows_returned: 1 },
        };
      },
    };
  };
  try {
    const summary = await fetchDebugLogSummary('https://status.example.com', session, FROM, TO);
    assert.equal(summary.available, true);
    assert.equal(summary.route_counts.agent_tasks, 1);
    assert.equal(observed.headers['x-admin-session'], session);
    assert.equal('cookie' in observed.headers, false);
    assert.equal('authorization' in observed.headers, false);
    assert.match(observed.url, /\/api\/debug\/usage-summary\?from=1700000000&to=1700086400&hours=24$/);
    assert.equal(observed.cache, 'no-store');
    assert.equal(observed.redirect, 'error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('debug summary accepts only a raw x-admin-session value', () => {
  const value = 'aA1_bB2-cC3dD4eE5fF6gG7hH8iI9jJ0';
  assert.deepEqual(adminSessionHeaders(value), { 'x-admin-session': value });
  assert.deepEqual(adminSessionHeaders(`x-admin-session: ${value}`), { 'x-admin-session': value });
  assert.throws(() => adminSessionHeaders('Cookie: session=example'), /raw x-admin-session value/i);
  assert.throws(() => adminSessionHeaders('Bearer example'), /raw x-admin-session value/i);
  assert.throws(() => adminSessionHeaders(`${value}\nCookie: injected`), /raw x-admin-session value/i);
});

test('debug summary prefers the narrow nsu_ token and never sends an administrator session with it', async () => {
  const originalFetch = globalThis.fetch;
  const token = `nsu_${'a'.repeat(64)}`;
  const session = 'aA1_bB2-cC3dD4eE5fF6gG7hH8iI9jJ0';
  let observed = null;
  globalThis.fetch = async (_url, options = {}) => {
    observed = { headers: options.headers || {} };
    return { ok: true, status: 200, async json() { return { ok: true, available: true, complete: true, total: 0, route_counts: {}, status_counts: {}, query: { statements: 1, aggregate_rows_returned: 0 } }; } };
  };
  try {
    await fetchDebugLogSummary('https://status.example.com', { usageToken: token, adminSession: session }, FROM, TO);
    assert.deepEqual(observed.headers, { authorization: `Bearer ${token}` });
    assert.equal('x-admin-session' in observed.headers, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(usageSummaryTokenHeaders(token), { authorization: `Bearer ${token}` });
  assert.throws(() => usageSummaryTokenHeaders(`Bearer ${token}`), /raw nsu_ read-only/i);
  assert.throws(() => usageSummaryTokenHeaders('nsu_short'), /raw nsu_ read-only/i);
});

test('unavailable aggregate summaries remain incomplete', () => {
  const logs = normalizeLogs({
    ok: true,
    available: false,
    complete: true,
    route_counts: {},
    status_counts: {},
    total: 0,
    query: { statements: 0, aggregate_rows_returned: 0 },
  }, { from: FROM, to: TO });
  assert.equal(logs.available, false);
  assert.equal(logs.complete, false);
});

test('a fetched page crossing the window boundary is complete even when older rows remain', () => {
  const logs = normalizeLogs({
    logs: [
      { ts: FROM + 10, method: 'GET', path: '/api/agent/tasks', status: 200 },
      { ts: FROM - 10, method: 'GET', path: '/api/agent/tasks', status: 200 },
    ],
    total: 1000,
    fetched: 2,
    complete: true,
  }, { from: FROM, to: TO });
  assert.equal(logs.records, 1);
  assert.equal(logs.complete, true);
});

test('unavailable logs are explicit and do not make WSS telemetry look like HTTP calls', () => {
  const result = estimateUsage({
    status: STATUS,
    logs: { available: false, complete: false, route_counts: {} },
    from: FROM,
    to: TO,
  });
  const ws = result.workers.components.find((item) => item.id === 'agent_metrics_ws');
  const http = result.workers.components.find((item) => item.id === 'agent_metrics_http');
  assert.equal(result.input.logs_available, false);
  assert.equal(result.observability.confidence, 'low');
  assert.equal(ws.worker_calls.estimate, 0);
  assert.equal(http.worker_calls.estimate, 288);
  assert.ok(result.workers.function_calls.estimate > 0);
  assert.ok(result.observability.missing.some((item) => item.includes('公开 status/detail')));
});

test('offline calibration uses median ratios and never needs a Cloudflare API', () => {
  const calibration = fitCalibration([
    { estimate: { workers_calls: 100 }, actual: { workers_calls: 120 } },
    { estimate: { workers_calls: 100 }, actual: { workers_calls: 100 } },
    { estimate: { workers_calls: 100 }, actual: { workers_calls: 110 } },
  ]);
  assert.equal(calibration.calibration_mode, 'offline-paired-fit');
  assert.equal(calibration.fitted_pairs, 3);
  assert.equal(calibration.output_multipliers.workers_calls.point, 1.1);
  assert.equal(calibration.output_multipliers.workers_calls.low, 1.02);
  assert.equal(calibration.output_multipliers.workers_calls.high, 1.18);
});

test('operational ranges are point envelopes while stress keeps the wider composition', () => {
  const operational = estimateUsage({ status: STATUS, from: FROM, to: TO });
  const stress = estimateUsage({
    status: STATUS,
    from: FROM,
    to: TO,
    calibration: { ...DEFAULT_CALIBRATION, range_mode: 'stress' },
  });
  assert.equal(operational.range_mode, 'operational');
  assert.equal(stress.range_mode, 'stress');
  assert.equal(operational.workers.function_calls.estimate, stress.workers.function_calls.estimate);
  assert.ok(
    operational.workers.function_calls.high - operational.workers.function_calls.low
      < stress.workers.function_calls.high - stress.workers.function_calls.low,
  );
  assert.ok(
    operational.r2.class_b.high - operational.r2.class_b.low
      < stress.r2.class_b.high - stress.r2.class_b.low,
  );
});
