export const MODEL_VERSION = 'usage-model-embedded-v1.3.4';

// Structural constants mirrored from scripts/usage-model.mjs (usage-model-v1.3.4).
// Output multipliers were fitted against five 6-hour Cloudflare dashboard
// windows on 2026-09-16 (median actual/estimated); see
// scripts/usage-model-calibration.json for the full basis. D1 rows written
// includes index rows (documented D1 billing rule), hence the separate
// indexWriteMultiplier.
const CAL = Object.freeze({
  reportSec: 300,
  taskSec: 600,
  updateSec: 900,
  pingRefreshSec: 1800,
  latencySec: 60,
  credentialTouchSec: 21600,
  publicRps: 0.42,
  maxTargetsPerRun: 20,
  handshakePerAgentDay: 1.5,
  r2PublicReadRate: 0.38,
  r2DistributionOverAb: 1.276,
  r2ClassAMultiplier: 1.37,
  indexWriteMultiplier: 3,
  queryPathMultiplier: 1.135,
  rowsReadMultiplier: 2.65,
  rowsWrittenMultiplier: 1.92,
  output: {
    workers_calls: 0.7264,
    do_requests: 2.05,
    r2_class_a: 1.43,
    r2_class_b: 2.0602,
    r2_requests: 1.5399,
    d1_queries: 1.3212,
    d1_rows_read: 1.2792,
    d1_rows_written: 0.4527,
  },
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

function periodic(seconds, interval) {
  const period = Math.max(1, Number(interval) || 1);
  return Math.ceil(Math.max(0, Number(seconds) || 0) / period);
}

export function estimateUsage({ agents = 0, wssAgents = 0, targets = 0, pingTargets = 0, latencyNodes = 0, trafficAgents = 0, hours = 24, reportSec = CAL.reportSec } = {}) {
  const h = Math.max(0.01, Number(hours) || 24);
  const seconds = h * 3600;
  const wss = Math.max(0, wssAgents);
  const legacy = Math.max(0, agents - wssAgents);
  const probeTargets = Math.max(1, targets);
  const batches = Math.max(1, Math.ceil(probeTargets / CAL.maxTargetsPerRun));

  const wssMessages = wss * periodic(seconds, reportSec);
  const legacyReports = legacy * periodic(seconds, reportSec);
  const taskPolls = agents * periodic(seconds, CAL.taskSec);
  const updateChecks = agents * periodic(seconds, CAL.updateSec);
  const geoReads = Math.ceil((seconds / 86400) * agents);
  const pingRefresh = legacy * periodic(seconds, CAL.pingRefreshSec);
  const latencyCycles = latencyNodes * periodic(seconds, CAL.latencySec);
  const latencyUpdate = latencyNodes * periodic(seconds, 3600);
  const cron = periodic(seconds, 60);
  const publicDynamic = CAL.publicRps * seconds;
  const handshake = wss * (seconds / 86400) * CAL.handshakePerAgentDay;
  const probeCycles = periodic(seconds, reportSec);

  const workersBase =
    taskPolls + updateChecks + geoReads + pingRefresh +
    latencyCycles * 2 + latencyUpdate + cron + publicDynamic + handshake;

  const telemetryFlush = agents * periodic(seconds, 3600);
  const probeStateSync = probeCycles * batches;
  const statusSnapshot = probeStateSync;
  const latencyArchive = latencyCycles;
  const archiveExpectation = probeTargets * (seconds / 86400);
  const aBase = telemetryFlush + probeStateSync + statusSnapshot + latencyArchive + archiveExpectation;
  const readback = aBase * 2;
  const publicReads = publicDynamic * CAL.r2PublicReadRate;
  const bBase = aBase + readback + publicReads;
  const classA = aBase * CAL.r2ClassAMultiplier * CAL.output.r2_class_a;
  const classB = bBase * CAL.output.r2_class_b;
  const r2Requests = (aBase * CAL.r2ClassAMultiplier + bBase) * CAL.r2DistributionOverAb * CAL.output.r2_requests;

  const d1 = { read: 0, write: 0, rowsRead: 0, rowsWritten: 0 };
  const addD1 = (count, profile) => {
    const c = Math.max(0, Number(count) || 0);
    d1.read += c * (profile.read || 0);
    d1.write += c * (profile.write || 0);
    d1.rowsRead += c * (profile.rowsRead || 0);
    d1.rowsWritten += c * (profile.rowsWritten || 0);
  };
  addD1(wssMessages, { read: 1, rowsRead: 10 });
  addD1(legacyReports, { read: 6, write: 1, rowsRead: 10, rowsWritten: 1 });
  addD1(taskPolls, { read: 8, rowsRead: 12 });
  addD1(updateChecks, { read: 12, rowsRead: 14 });
  addD1(geoReads, { read: 12, rowsRead: 16, write: 2, rowsWritten: 2 });
  addD1(pingRefresh, { read: 6, rowsRead: 8 });
  addD1(latencyCycles, { read: 5, rowsRead: 16 });
  addD1(latencyCycles, { read: 8, write: 2, rowsRead: 38, rowsWritten: 2 });
  addD1(latencyUpdate, { read: 7, rowsRead: 10 });
  addD1(cron, { read: 8, write: 3, rowsRead: 100, rowsWritten: 1 });
  addD1(agents * periodic(seconds, 300), { write: 1, rowsWritten: 1 });
  addD1(agents * periodic(seconds, 600), { read: 1, write: 1, rowsWritten: 1 });
  addD1(probeTargets * periodic(seconds, reportSec), { write: 1, rowsWritten: 1 });
  addD1(probeTargets * periodic(seconds, 1800), { write: 1, rowsWritten: 1 });
  addD1(probeStateSync, { read: 8, rowsRead: 100 });
  addD1(trafficAgents * periodic(seconds, 1800), { read: 2, rowsRead: 4, write: 1, rowsWritten: 1 });
  addD1(Math.ceil(publicDynamic * 0.06), { read: 8, rowsRead: 100 });
  addD1(periodic(seconds, 3600), { read: 8, write: 5, rowsRead: 80, rowsWritten: 5 });
  addD1((agents + latencyNodes) * periodic(seconds, CAL.credentialTouchSec), { rowsWritten: 1 });
  addD1(periodic(seconds, 3600), { read: 1, write: 2, rowsRead: probeTargets * 288, rowsWritten: probeTargets * 12 });
  addD1(cron * 2, { read: 1, rowsRead: probeTargets });

  const d1Queries = (d1.read + d1.write) * CAL.queryPathMultiplier * CAL.output.d1_queries;
  const d1RowsRead = d1.rowsRead * CAL.rowsReadMultiplier * CAL.output.d1_rows_read;
  const d1RowsWritten = d1.rowsWritten * CAL.indexWriteMultiplier * CAL.rowsWrittenMultiplier * CAL.output.d1_rows_written;

  const doBase = wssMessages + probeTargets * probeCycles + cron + cron * 0.9;
  const doRequests = doBase * CAL.output.do_requests;
  const doRowsWritten =
    wssMessages * 1.2 +
    agents * periodic(seconds, 300) * 1.2 +
    probeTargets * probeCycles * 1.5 +
    agents * periodic(seconds, 3600) * 3;

  const pct = (value, limit) => round((value / limit) * 100);
  const out = {
    model_version: MODEL_VERSION,
    window_hours: round(h),
    inputs: {
      agents,
      wss_agents: wss,
      targets,
      ping_targets: pingTargets,
      latency_nodes: latencyNodes,
      traffic_agents: trafficAgents,
      public_rps: CAL.publicRps,
    },
    estimates: {
      workers_calls: round(workersBase * CAL.output.workers_calls),
      do_requests: round(doRequests),
      do_rows_written: round(doRowsWritten),
      d1_rows_written: round(d1RowsWritten),
      d1_rows_read: round(d1RowsRead),
      r2_class_a: round(classA),
      r2_class_b: round(classB),
    },
    extras: {
      d1_queries: round(d1Queries),
      r2_requests: round(r2Requests),
    },
    quota: {},
    notes: [
      '估算与本地 scripts/usage-model.mjs（usage-model-v1.3.4）同构，并以内置校准常数输出点估计；区间请使用 scripts/usage-model.mjs。',
      `D1 行写入包含索引行（内置放大系数 ${CAL.indexWriteMultiplier}）；R2 读操作含写入后 HEAD/GET 回读校验。`,
      'Latency 节点仅计入最近 30 分钟内活跃的节点；DO SQLite 写行为近似台账，以控制台为准。',
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
    one(`SELECT COUNT(*) AS n FROM agent_metrics_state s JOIN targets t ON t.id = s.agent_id WHERE t.enabled = 1`),
    one(`SELECT COUNT(*) AS n FROM agent_metrics_state s JOIN targets t ON t.id = s.agent_id WHERE t.enabled = 1 AND s.capabilities LIKE '%"protocol"%'`),
    one(`SELECT COUNT(*) AS n FROM targets WHERE enabled = 1 AND COALESCE(no_public_ip, 0) = 0`),
    one('SELECT COUNT(*) AS n FROM ping_targets WHERE enabled = 1'),
    one(`SELECT COUNT(*) AS n FROM latency_agents WHERE enabled = 1 AND COALESCE(last_seen_at, 0) >= CAST(strftime('%s','now') AS INTEGER) - 1800`),
    one('SELECT COUNT(*) AS n FROM targets WHERE enabled = 1 AND traffic_enabled = 1'),
  ]);
  return estimateUsage({ agents, wssAgents, targets, pingTargets, latencyNodes, trafficAgents, hours });
}
