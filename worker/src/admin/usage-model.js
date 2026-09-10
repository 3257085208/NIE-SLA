// Embedded CF usage estimator — a compact port of scripts/usage-model.mjs
// (usage-model-v1.3.3 calibration). Numbers are model estimates for the
// admin dashboard, not Cloudflare metering; the console stays the truth.
export const MODEL_VERSION = 'usage-model-embedded-v1.3.3';

const CAL = Object.freeze({
  reportSec: 300,
  taskSec: 600,
  updateSec: 900,
  pingRefreshSec: 1800,
  latencySec: 60,
  publicRps: 0.42,
  d1QueryMultiplier: 1.135,
  d1RowsWritten: 1.92,
  d1RowsRead: 2.65,
  probeEvent: 1.15,
  r2ClassA: 1.37,
  r2PublicReadRate: 0.38,
  freeTier: {
    workers_calls: 100_000,
    do_requests: 100_000,
    do_rows_written: 100_000,
    d1_rows_written: 100_000,
    d1_rows_read: 5_000_000,
    r2_class_a: 1_000_000,
    r2_class_b: 10_000_000,
  },
});

function round(value) {
  return Math.round(value * 10) / 10;
}

export function estimateUsage({ agents = 0, wssAgents = 0, targets = 0, pingTargets = 0, latencyNodes = 0, trafficAgents = 0, hours = 24, reportSec = CAL.reportSec } = {}) {
  const h = Math.max(0.01, Number(hours) || 24);
  const wss = Math.max(0, wssAgents);
  const legacy = Math.max(0, agents - wssAgents);
  const minutes = h * 60;
  const messages = Math.max(wss + legacy, 1) * h * (3600 / reportSec);
  const drains = messages; // one telemetry append per reported message batch

  // --- event counts (per window) ---
  const ev = {
    wss_messages: wss * h * (3600 / reportSec),
    http_metrics: legacy * h * (3600 / reportSec),
    task_polls: agents * h * (3600 / CAL.taskSec),
    update_checks: agents * h * (3600 / CAL.updateSec),
    ping_refresh: legacy * h * (3600 / CAL.pingRefreshSec),
    latency_calls: latencyNodes * h * (3600 / CAL.latencySec),
    cron: minutes,
    public_dynamic: CAL.publicRps * 3600 * h,
  };

  // --- D1 (query paths mirrored from usage-model.mjs D1_PROFILES) ---
  const d1QueryBase =
    ev.task_polls * 8 + ev.update_checks * 12 + ev.latency_calls * 13 +
    ev.http_metrics * 6 + ev.ping_refresh * 6 + ev.cron * 8 + ev.public_dynamic * 0;
  const d1Queries = d1QueryBase * CAL.d1QueryMultiplier;
  const d1ReadQueries = d1Queries + ev.wss_messages * 0;
  const d1WriteQueries =
    ev.task_polls * 1 + ev.update_checks * 1 + ev.latency_calls * 3 +
    ev.http_metrics * 1 + ev.ping_refresh * 1 + ev.cron * 3;
  // Latest-state throttle (300s per agent) and no-public-ip availability.
  const stateUpserts = agents * h * (3600 / 300);
  const d1RowsWritten = (d1WriteQueries + stateUpserts * 1.5) * CAL.d1RowsWritten;
  const d1RowsRead = d1ReadQueries * CAL.d1RowsRead + d1Queries * 4.7;

  // --- Durable Objects ---
  // Probe history appends are per-target on the 5-minute healthy cadence;
  // the multiplier folds in region-batch DOs, fast status and visitor streams
  // calibrated against the 2026-09-06 metered day (76,129 DO requests).
  const probeEvents = targets * h * (3600 / 300) * CAL.probeEvent;
  const doRequests =
    (ev.wss_messages +
      drains * 1.05 +
      probeEvents +
      minutes * 2) * 2.25;

  // SQLite rows written: telemetry chunks, latest-state mirror, probe day
  // buckets, hourly flush bookkeeping. Approximation of the post-201-incident
  // memory-first layout.
  const doRowsWritten =
    drains * 1.2 +
    stateUpserts * 1.2 +
    targets * 48 * 1.5 +
    agents * 24 * 3;

  // --- Workers ---
  const workersCalls =
    ev.task_polls + ev.update_checks + ev.latency_calls * 2 + ev.ping_refresh +
    ev.http_metrics + ev.cron + ev.public_dynamic + latencyNodes * 8;

  // --- R2 ---
  const r2ClassA = (agents * h * (2 + 24 / h) + latencyNodes * h * 30) * CAL.r2ClassA;
  const r2ClassB = (agents * h * 8 + ev.public_dynamic * CAL.r2PublicReadRate) * CAL.r2ClassA;

  const pct = (value, limit) => round((value / limit) * 100);
  const out = {
    model_version: MODEL_VERSION,
    window_hours: round(h),
    inputs: { agents, wss_agents: wss, targets, ping_targets: pingTargets, latency_nodes: latencyNodes, traffic_agents: trafficAgents, public_rps: CAL.publicRps },
    estimates: {
      workers_calls: round(workersCalls),
      do_requests: round(doRequests),
      do_rows_written: round(doRowsWritten),
      d1_rows_written: round(d1RowsWritten),
      d1_rows_read: round(d1RowsRead),
      r2_class_a: round(r2ClassA),
      r2_class_b: round(r2ClassB),
    },
    quota: {},
    notes: [
      '估算基于当前探针规模与内置校准（usage-model-v1.3.3），非 Cloudflare 实测计量；实际以控制台为准。',
      '公开流量按内置校准点 0.42 req/s 估算；此嵌入版只返回点估计，区间请使用 scripts/usage-model.mjs。',
      'DO SQLite 写行为内存优先布局下的近似台账。',
    ],
  };
  for (const [key, value] of Object.entries(out.estimates)) {
    const limit = CAL.freeTier[key];
    if (limit) out.quota[key] = { used: value, limit, pct: pct(value, limit) };
  }
  return out;
}

export async function estimateUsageFromEnv(env, hours = 24) {
  const one = async (sql) => {
    try {
      const row = await env.DB.prepare(sql).first();
      return Number(Object.values(row || {})[0] || 0);
    } catch (_) {
      return 0;
    }
  };
  const [agents, wssAgents, targets, pingTargets, latencyNodes, trafficAgents] = await Promise.all([
    one('SELECT COUNT(*) AS n FROM agent_metrics_state'),
    one(`SELECT COUNT(*) AS n FROM agent_metrics_state WHERE capabilities LIKE '%"protocol"%'`),
    one('SELECT COUNT(*) AS n FROM targets WHERE enabled = 1'),
    one('SELECT COUNT(*) AS n FROM ping_targets WHERE enabled = 1'),
    one('SELECT COUNT(*) AS n FROM latency_agents WHERE enabled = 1'),
    one('SELECT COUNT(*) AS n FROM targets WHERE traffic_enabled = 1'),
  ]);
  return estimateUsage({ agents, wssAgents, targets, pingTargets, latencyNodes, trafficAgents, hours });
}
