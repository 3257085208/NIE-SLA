import { parseBoolean, nowSec } from '../utils.js';
import { bufferedAgentStateEnabled, agentStateTimestamp } from '../agent-state.js';
import { readFleetLatestAgentStates } from '../telemetry-buffer.js';

export const MODEL_VERSION = 'usage-model-embedded-v1.4.2';

// Structural constants mirrored from scripts/usage-model.mjs (usage-model-v1.4.2).
// Output multipliers were fitted against five 6-hour Cloudflare dashboard
// windows on 2026-09-16 (median actual/estimated); see
// scripts/usage-model-calibration.json for the full basis. D1 rows written
// includes index rows (documented D1 billing rule), hence the separate
// indexWriteMultiplier. v1.4.2 gates the latest_status component on
// PROBE_LATEST_STATUS_TO_D1 and adds the R2 state lock churn component using
// the 2026-09-21→09-22 D1 window (7,475 write queries/day, of which 5,760
// came from the old double merge).
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
  probeD1FallbackRate: 0.01,
  latestStatusMinIntervalSec: 900,
  indexWriteMultiplier: 3,
  queryPathMultiplier: 1.135,
  rowsReadMultiplier: 2.65,
  rowsWrittenMultiplier: 1.92,
  output: {
    workers_calls: 0.7308,
    do_requests: 1.32,
    r2_class_a: 0.86,
    r2_class_b: 1.26,
    r2_requests: 0.92,
    d1_queries: 1.3623,
    d1_rows_read: 0.769,
    d1_rows_written: 0.4331,
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

export function estimateUsage({ agents = 0, wssAgents = 0, targets = 0, pingTargets = 0, latencyNodes = 0, trafficAgents = 0, hours = 24, reportSec = CAL.reportSec, latestStatusToD1 = true } = {}) {
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
  addD1(latencyCycles, { read: 8, write: 2, rowsRead: 38, rowsWritten: 0.4 });
  addD1(latencyUpdate, { read: 7, rowsRead: 10 });
  addD1(cron, { read: 8, write: 3, rowsRead: 100, rowsWritten: 1 });
  addD1(agents * periodic(seconds, 900), { write: 1, rowsWritten: 1 });
  addD1(agents * periodic(seconds, 1800), { read: 1, write: 1, rowsWritten: 1 });
  addD1(probeTargets * periodic(seconds, reportSec) * CAL.probeD1FallbackRate, { write: 1, rowsWritten: 1 });
  addD1(probeTargets * periodic(seconds, 7200), { write: 1, rowsWritten: 1 });
  // latest_status only bills when the D1 mirror is enabled; the production
  // wrangler.toml sets PROBE_LATEST_STATUS_TO_D1="false", and the probe path
  // then neither reads nor writes the table.
  addD1(latestStatusToD1 ? probeTargets * periodic(seconds, CAL.latestStatusMinIntervalSec) : 0, { write: 1, rowsWritten: 1 });
  addD1(probeStateSync, { read: 8, rowsRead: 100 });
  // R2 state lock churn after the single-merge round: one acquire (INSERT)
  // and one release (DELETE) per cron minute, each billing one app_meta row
  // written, plus the token SELECT. The measured 2026-09-21→09-22 window
  // showed 7,475 write queries/day, of which 5,760 (2 rounds/min x 2 writes)
  // were the old per-scheduler double merge.
  addD1(cron, { read: 1, write: 2, rowsRead: 1, rowsWritten: 2 });
  addD1(trafficAgents * periodic(seconds, 1800), { read: 2, rowsRead: 4, write: 1, rowsWritten: 1 });
  addD1(Math.ceil(publicDynamic * 0.06), { read: 8, rowsRead: 100 });
  addD1(periodic(seconds, 3600), { read: 8, write: 5, rowsRead: 80, rowsWritten: 5 });
  addD1((agents + latencyNodes) * periodic(seconds, CAL.credentialTouchSec), { rowsWritten: 1 });
  addD1(periodic(seconds, 86400), { read: 1, write: 2, rowsRead: probeTargets * 288, rowsWritten: Math.max(1, Math.round(probeTargets * 12 * CAL.probeD1FallbackRate)) });
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
      latest_status_to_d1: Boolean(latestStatusToD1),
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
      '估算与本地 scripts/usage-model.mjs（usage-model-v1.4.2）同构，并以内置校准常数输出点估计；区间请使用 scripts/usage-model.mjs。',
      `D1 行写入包含索引行（内置放大系数 ${CAL.indexWriteMultiplier}）；R2 读操作默认只在抽样（每 50 次写入 1 次）回读校验。`,
      `latest_status ${latestStatusToD1 ? `按 ${CAL.latestStatusMinIntervalSec}s 下限写入（状态/错误码变化即时写入）` : '在 PROBE_LATEST_STATUS_TO_D1=false 时读与写均不计（生产 wrangler.toml 已关闭）'}；R2 状态锁按每轮 cron 1 次 acquire(INSERT)+release(DELETE)+token SELECT 计（2026-09-21→09-22 实测写查询 7,475/日，其中双次合并占 5,760）；读行乘子已按 2026-09-21→09-22 实测窗口（nie-sla-db 1,415,503 行）重拟合，写行乘子待上线后复验。`,
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
  return estimateUsage({ ...(await usageInputsFromEnv(env)), hours });
}

// WSS capability heuristic kept in sync with scripts/usage-model.mjs: WS
// transport landed in v1.1.16, so newer versions are treated as WSS agents.
function versionAtLeast(value, minimum) {
  const parse = (input) => String(input || '').replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const current = parse(value);
  const floor = parse(minimum);
  for (let index = 0; index < 3; index += 1) {
    if ((current[index] || 0) !== (floor[index] || 0)) return (current[index] || 0) > (floor[index] || 0);
  }
  return true;
}

export async function usageInputsFromEnv(env) {
  const one = async (sql, ...binds) => {
    try {
      const row = await env.DB.prepare(sql).bind(...binds).first();
      return Number(Object.values(row || {})[0] || 0);
    } catch (_) {
      return 0;
    }
  };
  // Only agents that reported within the offline window generate traffic; the
  // fleet keeps roughly 40% of registered agents offline, and counting them all
  // was the main source of the old overestimation.
  const offlineAfterSec = Math.max(120, Math.min(3600, Number(env.AGENT_OFFLINE_AFTER_SEC || 1800)));
  const onlineFilter = `s.updated_at IS NOT NULL AND CAST(strftime('%s', s.updated_at) AS INTEGER) >= CAST(strftime('%s','now') AS INTEGER) - ?`;
  // Production disables the D1 latest-state mirror, so agent_metrics_state is
  // not maintained there. Read the buffered fleet snapshot (TelemetryBuffer DO)
  // first and keep the D1 rows as the fallback instead of silently feeding the
  // model zeros.
  let bufferedStates = null;
  if (bufferedAgentStateEnabled(env)) {
    try {
      const states = await readFleetLatestAgentStates(env);
      if (states && Object.keys(states).length) bufferedStates = states;
    } catch (_) {
      bufferedStates = null;
    }
  }
  let agents = 0;
  let wssAgents = 0;
  let targets = 0;
  let pingTargets = 0;
  let latencyNodes = 0;
  let trafficAgents = 0;
  if (bufferedStates) {
    const targetRows = await env.DB.prepare('SELECT id, traffic_enabled, no_public_ip FROM targets WHERE enabled = 1')
      .all().catch(() => ({ results: [] }));
    const enabledTargets = targetRows.results || [];
    const targetById = new Map(enabledTargets.map((row) => [String(row.id), row]));
    const freshAfter = nowSec() - offlineAfterSec;
    for (const [agentId, state] of Object.entries(bufferedStates)) {
      const updatedAt = agentStateTimestamp(state?.updated_at);
      if (!updatedAt || updatedAt < freshAfter) continue;
      const target = targetById.get(String(agentId));
      if (!target) continue;
      agents += 1;
      if (versionAtLeast(state?.agent_version, '1.1.16')) wssAgents += 1;
      if (Number(target.traffic_enabled || 0) === 1) trafficAgents += 1;
    }
    targets = enabledTargets.filter((row) => Number(row.no_public_ip || 0) === 0).length;
    [pingTargets, latencyNodes] = await Promise.all([
      one('SELECT COUNT(*) AS n FROM ping_targets WHERE enabled = 1'),
      one(`SELECT COUNT(*) AS n FROM latency_agents WHERE enabled = 1 AND COALESCE(last_seen_at, 0) >= CAST(strftime('%s','now') AS INTEGER) - 1800`),
    ]);
  } else {
    [agents, wssAgents, targets, pingTargets, latencyNodes, trafficAgents] = await Promise.all([
      one(`SELECT COUNT(*) AS n FROM agent_metrics_state s JOIN targets t ON t.id = s.agent_id WHERE t.enabled = 1 AND ${onlineFilter}`, offlineAfterSec),
      one(`SELECT COUNT(*) AS n FROM agent_metrics_state s JOIN targets t ON t.id = s.agent_id WHERE t.enabled = 1 AND s.capabilities LIKE '%"protocol"%' AND ${onlineFilter}`, offlineAfterSec),
      one('SELECT COUNT(*) AS n FROM targets WHERE enabled = 1 AND COALESCE(no_public_ip, 0) = 0'),
      one('SELECT COUNT(*) AS n FROM ping_targets WHERE enabled = 1'),
      one(`SELECT COUNT(*) AS n FROM latency_agents WHERE enabled = 1 AND COALESCE(last_seen_at, 0) >= CAST(strftime('%s','now') AS INTEGER) - 1800`),
      one(`SELECT COUNT(*) AS n FROM agent_metrics_state s JOIN targets t ON t.id = s.agent_id WHERE t.enabled = 1 AND t.traffic_enabled = 1 AND ${onlineFilter}`, offlineAfterSec),
    ]);
  }
  // Production disables the latest_status mirror; the estimate must follow
  // the deployment flag instead of assuming the default-on path.
  const latestStatusToD1 = parseBoolean(env.PROBE_LATEST_STATUS_TO_D1 ?? true, true);
  return { agents, wssAgents, targets, pingTargets, latencyNodes, trafficAgents, latestStatusToD1 };
}

export const CAPACITY_QUOTAS = ['workers_calls', 'do_requests', 'd1_rows_read', 'd1_rows_written', 'r2_class_a', 'r2_class_b'];

function capacityEstimateAt(base, perNode, extra) {
  return estimateUsage({
    agents: base.agents + perNode.agents * extra,
    wssAgents: base.wssAgents + perNode.wssAgents * extra,
    targets: base.targets + perNode.targets * extra,
    pingTargets: base.pingTargets + perNode.pingTargets * extra,
    latencyNodes: base.latencyNodes + perNode.latencyNodes * extra,
    trafficAgents: base.trafficAgents + perNode.trafficAgents * extra,
    hours: base.hours,
    latestStatusToD1: base.latestStatusToD1,
  });
}

function maxExtraNodesFor(key, base, perNode, target) {
  const valueAt = (extra) => capacityEstimateAt(base, perNode, extra).estimates[key];
  if (valueAt(0) > target) return 0;
  const ceiling = 100_000;
  let hi = 8;
  while (hi < ceiling && valueAt(hi) <= target) hi *= 2;
  if (hi > ceiling) hi = ceiling;
  if (valueAt(ceiling) <= target) return ceiling;
  let lo = 0;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (valueAt(mid) <= target) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function estimateCapacity(inputs = {}, options = {}) {
  const base = {
    agents: Math.max(0, Number(inputs.agents) || 0),
    wssAgents: Math.max(0, Number(inputs.wssAgents) || 0),
    targets: Math.max(0, Number(inputs.targets) || 0),
    pingTargets: Math.max(0, Number(inputs.pingTargets) || 0),
    latencyNodes: Math.max(0, Number(inputs.latencyNodes) || 0),
    trafficAgents: Math.max(0, Number(inputs.trafficAgents) || 0),
    hours: Math.max(0.01, Number(inputs.hours) || 24),
    latestStatusToD1: inputs.latestStatusToD1 !== false,
  };
  const perNode = {
    agents: 1,
    wssAgents: base.agents > 0 && base.wssAgents >= base.agents * 0.5 ? 1 : 0,
    targets: 1,
    pingTargets: 0,
    latencyNodes: 0,
    trafficAgents: 0,
    ...(options.perNode || {}),
  };
  const current = capacityEstimateAt(base, perNode, 0);
  const quotas = {};
  for (const key of CAPACITY_QUOTAS) {
    const limit = CAL.freeTier[key];
    const used = current.estimates[key];
    const remaining = Math.max(0, limit - used);
    quotas[key] = {
      limit,
      used,
      remaining: round(remaining),
      headroom_pct: round((remaining / limit) * 100),
      extra_nodes_80: maxExtraNodesFor(key, base, perNode, limit * 0.8),
      extra_nodes_100: maxExtraNodesFor(key, base, perNode, limit),
    };
  }
  return {
    model_version: MODEL_VERSION,
    window_hours: round(base.hours),
    inputs: {
      agents: base.agents,
      wss_agents: base.wssAgents,
      targets: base.targets,
      ping_targets: base.pingTargets,
      latency_nodes: base.latencyNodes,
      traffic_agents: base.trafficAgents,
      latest_status_to_d1: base.latestStatusToD1,
    },
    per_node: {
      agents: perNode.agents,
      wss_agents: perNode.wssAgents,
      targets: perNode.targets,
      ping_targets: perNode.pingTargets,
      latency_nodes: perNode.latencyNodes,
      traffic_agents: perNode.trafficAgents,
    },
    quotas,
    notes: [
      '每新增一台 VPS 按 1 个 Agent + 1 个探针目标估算；当前舰队以 WSS 上报为主时，新节点也按 1 个 WSS Agent 计。',
      'extra_nodes_80 / extra_nodes_100 表示保持当前配置与上报频率不变时，估算值不超过免费额度 80% / 100% 的可新增台数。',
      `容量由 ${MODEL_VERSION} 点估计线性外推，实际以 Cloudflare 账单为准。`,
    ],
  };
}
