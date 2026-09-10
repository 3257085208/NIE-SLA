#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const MODEL_VERSION = 'usage-model-v1.3.3';
export const DEFAULT_BASE_URL = 'https://status.example.com';
export const DEFAULT_CALIBRATION_FILE = new URL('./usage-model-calibration.json', import.meta.url);

const DAY_SEC = 86_400;
const HOUR_SEC = 3_600;
const MINUTE_SEC = 60;
const DEFAULT_REPORT_SEC = 300;
const DEFAULT_TASK_SEC = 600;
const DEFAULT_UPDATE_SEC = 900;
const DEFAULT_PING_REFRESH_SEC = 1_800;
const DEFAULT_LATENCY_SEC = 60;
const DEFAULT_SNAPSHOT_SEC = 300;
const DEFAULT_MAX_TARGETS_PER_RUN = 20;
const DEFAULT_CREDENTIAL_TOUCH_SEC = 21_600;
// This is the empirically calibrated rate of incoming dynamic Worker
// requests that are not represented by the bounded site debug log.  It is
// deliberately separate from R2/D1 public-read factors: an incoming Worker
// request may be served from cache and therefore need not cause a storage or
// database operation.
const DEFAULT_PUBLIC_RPS = 0.42;
const DEFAULT_PUBLIC_RPS_LOW = 0.15;
const DEFAULT_PUBLIC_RPS_HIGH = 0.65;

const D1_PROFILES = Object.freeze({
  agent_metrics_ws: { read: 1, write: 0, rowsRead: 10, rowsWritten: 0 },
  agent_metrics_http: { read: 6, write: 1, authTouch: 1, rowsRead: 10, rowsWritten: 1 },
  agent_tasks: { read: 8, authTouch: 1, debugLog: 0, rowsRead: 12, rowsWritten: 0 },
  agent_task_action: { read: 6, write: 2, authTouch: 1, debugLog: 0, rowsRead: 10, rowsWritten: 2 },
  agent_update_policy: { read: 12, authTouch: 1, debugLog: 0, rowsRead: 14, rowsWritten: 0 },
  agent_config: { read: 6, authTouch: 1, debugLog: 0, rowsRead: 8, rowsWritten: 0 },
  agent_location: { read: 6, write: 2, authTouch: 1, debugLog: 0, rowsRead: 8, rowsWritten: 2 },
  agent_ping_targets: { read: 6, authTouch: 1, rowsRead: 8, rowsWritten: 0 },
  latency_targets: { read: 5, authTouch: 1, rowsRead: 16, rowsWritten: 0 },
  latency_results: { read: 8, write: 2, authTouch: 1, rowsRead: 38, rowsWritten: 2 },
  latency_update_policy: { read: 7, authTouch: 1, debugLog: 0, rowsRead: 10, rowsWritten: 0 },
  admin_agent_tasks: { read: 3, debugLog: 0, rowsRead: 40, rowsWritten: 0 },
  other_debug: { read: 5, debugLog: 1, rowsRead: 20, rowsWritten: 0 },
  scheduled_sweep: { read: 8, write: 3, rowsRead: 100, rowsWritten: 1 },
  probe_persist: { write: 1, rowsRead: 0, rowsWritten: 1 },
  status_snapshot: { read: 8, rowsRead: 100, rowsWritten: 0 },
  public_cache_miss: { read: 8, rowsRead: 100, rowsWritten: 0 },
  maintenance: { read: 8, write: 5, rowsRead: 80, rowsWritten: 5 },
});

const ROUTE_CLASSES = Object.freeze([
  'agent_tasks',
  'agent_task_action',
  'agent_update_policy',
  'agent_config',
  'agent_location',
  'agent_ping_targets',
  'latency_update_policy',
  'latency_targets',
  'latency_results',
  'admin_agent_tasks',
  'other_debug',
]);

export const DEFAULT_CALIBRATION = {
  schema: 'nie-sla-usage-calibration-v2',
  model_version: MODEL_VERSION,
  calibration_mode: 'built-in',
  range_mode: 'operational',
  range_strategy: 'point-envelope',
  factors: {
    workers_public_rps: { point: DEFAULT_PUBLIC_RPS, low: 0.36, high: 0.48 },
    workers_wss_handshake_per_agent_day: { point: 1.5, low: 1, high: 2 },
    workers_wss_http_fallback_rate: { point: 0, low: 0, high: 0.02 },
    r2_class_a_multiplier: { point: 1.37, low: 1.22, high: 1.52 },
    r2_public_read_rate: { point: 0.38, low: 0.28, high: 0.50 },
    r2_distribution_over_ab: { point: 1.276, low: 1.17, high: 1.38 },
    d1_query_path_multiplier: { point: 1.135, low: 1.05, high: 1.23 },
    d1_rows_read_multiplier: { point: 2.65, low: 2.05, high: 3.25 },
    d1_rows_written_multiplier: { point: 1.92, low: 1.55, high: 2.30 },
    probe_event_multiplier: { point: 1.15, low: 1.05, high: 1.25 },
    public_cache_miss_rate: { point: 0.06, low: 0.04, high: 0.09 },
  },
  stress_factors: {
    workers_public_rps: { point: DEFAULT_PUBLIC_RPS, low: DEFAULT_PUBLIC_RPS_LOW, high: DEFAULT_PUBLIC_RPS_HIGH },
    workers_wss_handshake_per_agent_day: { point: 1.5, low: 1, high: 3 },
    workers_wss_http_fallback_rate: { point: 0, low: 0, high: 0.05 },
    r2_class_a_multiplier: { point: 1.37, low: 1, high: 2 },
    r2_public_read_rate: { point: 0.38, low: 0.2, high: 0.7 },
    r2_distribution_over_ab: { point: 1.276, low: 1.05, high: 1.5 },
    d1_query_path_multiplier: { point: 1.135, low: 0.9, high: 1.5 },
    d1_rows_read_multiplier: { point: 2.65, low: 0.85, high: 4 },
    d1_rows_written_multiplier: { point: 1.92, low: 1, high: 3.5 },
    probe_event_multiplier: { point: 1.15, low: 1, high: 1.4 },
    public_cache_miss_rate: { point: 0.06, low: 0.02, high: 0.15 },
  },
  output_multipliers: {
    workers_calls: { point: 1, low: 0.90, high: 1.10 },
    r2_class_a: { point: 1, low: 0.95, high: 1.05 },
    r2_class_b: { point: 1, low: 0.94, high: 1.06 },
    r2_requests: { point: 1, low: 0.92, high: 1.08 },
    d1_queries: { point: 1, low: 0.95, high: 1.05 },
    d1_rows_read: { point: 1, low: 0.80, high: 1.25 },
    d1_rows_written: { point: 1, low: 0.85, high: 1.15 },
  },
  stress_output_multipliers: {
    workers_calls: { point: 1, low: 0.9, high: 1.1 },
    r2_class_a: { point: 1, low: 0.9, high: 1.1 },
    r2_class_b: { point: 1, low: 0.9, high: 1.1 },
    r2_requests: { point: 1, low: 0.9, high: 1.1 },
    d1_queries: { point: 1, low: 0.9, high: 1.1 },
    d1_rows_read: { point: 1, low: 0.9, high: 1.1 },
    d1_rows_written: { point: 1, low: 0.9, high: 1.1 },
  },
};

const SOURCE_NOTES = Object.freeze({
  agent_metrics_ws: 'WSS 消息进入 TelemetryBuffer Durable Object；当前状态写 DO，每条消息仅保留一次无条件的 D1 状态查询（previousState/no_public_ip），D1 写入只在 DO/R2 失败回退时发生，不按每条消息计。',
  agent_metrics_http: '只有旧 Agent 或 WSS fallback 才按 HTTP metrics 上报计 Worker 请求。',
  agent_tasks: 'Rust Manager 默认每 600 秒轮询一次 /api/agent/tasks。',
  agent_update_policy: 'Manager 默认每 900 秒检查一次 /api/agent/update-policy。',
  agent_config: 'Agent 地理位置配置默认按天读取一次。',
  agent_location: 'Agent 地理位置结果默认按天回传一次。',
  agent_ping_targets: '旧路径按 1,800 秒刷新；WSS Agent 通常从 metrics ack 携带的 control 获取，已避免重复计入。',
  latency_targets: '每个外部 Latency 节点默认每 60 秒读取一次目标列表。',
  latency_results: '每个外部 Latency 节点默认每 60 秒提交一次结果批次。',
  latency_update_policy: 'Latency 节点默认每 3,600 秒读取一次更新策略。',
  scheduled_sweep: 'Workers Cron 默认每分钟触发；这里估算调度入口和锁/状态读取。',
  probe_persist: '探测节奏由 R2 状态承载；D1 仅按每目标每 30 分钟回写调度镜像（TARGET_SCHEDULE_FLUSH_SEC，默认 1800 秒）。',
  status_snapshot: '状态快照只在有探测结果的 scheduled run 中生成，默认按探测批次估算。',
  public_cache_miss: '公开动态接口和详情接口不在当前 debug_logs 范围内，只能用缓存未命中先验估算。',
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

function integer(value, fallback = 0) {
  return Math.max(0, Math.round(finiteNumber(value, fallback)));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function range(estimate, low = estimate, high = estimate) {
  const values = [estimate, low, high].map((value) => Math.max(0, finiteNumber(value)));
  const ordered = [Math.min(...values), Math.max(...values)];
  return {
    estimate: integer(values[0]),
    low: integer(ordered[0]),
    high: integer(ordered[1]),
  };
}

function exact(value) {
  return range(value, value, value);
}

function sumRanges(values = []) {
  return range(
    values.reduce((sum, value) => sum + finiteNumber(value?.estimate), 0),
    values.reduce((sum, value) => sum + finiteNumber(value?.low), 0),
    values.reduce((sum, value) => sum + finiteNumber(value?.high), 0),
  );
}

function multiplyRange(value, multiplier) {
  const factor = typeof multiplier === 'object'
    ? {
      estimate: finiteNumber(multiplier.point ?? multiplier.estimate, 1),
      low: finiteNumber(multiplier.low, finiteNumber(multiplier.point ?? multiplier.estimate, 1)),
      high: finiteNumber(multiplier.high, finiteNumber(multiplier.point ?? multiplier.estimate, 1)),
    }
    : { estimate: finiteNumber(multiplier, 1), low: finiteNumber(multiplier, 1), high: finiteNumber(multiplier, 1) };
  return range(
    finiteNumber(value?.estimate) * factor.estimate,
    finiteNumber(value?.low) * factor.low,
    finiteNumber(value?.high) * factor.high,
  );
}

function addRanges(left, right) {
  return range(
    finiteNumber(left?.estimate) + finiteNumber(right?.estimate),
    finiteNumber(left?.low) + finiteNumber(right?.low),
    finiteNumber(left?.high) + finiteNumber(right?.high),
  );
}

function periodicCount(seconds, interval) {
  const duration = Math.max(0, finiteNumber(seconds));
  const period = Math.max(1, finiteNumber(interval, 1));
  return duration > 0 ? Math.ceil(duration / period) : 0;
}

function isoFromSeconds(seconds) {
  return new Date(Math.floor(seconds) * 1000).toISOString();
}

function parseTimestamp(value) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value ?? '').trim())) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.floor(number > 1e12 ? number / 1000 : number);
  }
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function normalizePath(value) {
  const raw = String(value ?? '').split(/[?#]/)[0].trim();
  if (!raw) return '/';
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).pathname || '/';
  } catch (_) {
    return '/';
  }
  return raw.startsWith('/') ? raw : `/${raw}`;
}

export function classifyLogRoute(pathValue, method = 'GET') {
  const pathName = normalizePath(pathValue);
  const upper = String(method || 'GET').toUpperCase();
  if (pathName === '/api/agent/tasks' && upper === 'GET') return 'agent_tasks';
  if (/^\/api\/agent\/tasks\/.+/.test(pathName)) return 'agent_task_action';
  if (pathName === '/api/agent/update-policy') return 'agent_update_policy';
  if (pathName === '/api/agent/config') return 'agent_config';
  if (pathName === '/api/agent/location') return 'agent_location';
  if (pathName === '/api/agent/ping-targets') return 'agent_ping_targets';
  if (pathName === '/api/latency-agent/update-policy') return 'latency_update_policy';
  if (pathName === '/api/latency-agent/targets') return 'latency_targets';
  if (pathName === '/api/latency-agent/results') return 'latency_results';
  if (/^\/api\/agent-tasks(?:\/|$)/.test(pathName)) return 'admin_agent_tasks';
  if (pathName.startsWith('/api/')) return 'other_debug';
  return upper === 'GET' ? 'other_debug' : 'other_debug';
}

function logItems(input) {
  if (Array.isArray(input)) return { items: input, metadata: {} };
  if (!input || typeof input !== 'object') return { items: [], metadata: {} };
  if (Array.isArray(input.logs)) return { items: input.logs, metadata: input };
  if (Array.isArray(input.results)) return { items: input.results, metadata: input };
  return { items: [], metadata: input };
}

function normalizedLogEntry(entry) {
  const ts = parseTimestamp(entry?.ts ?? entry?.timestamp ?? entry?.time ?? entry?.created_at);
  const method = String(entry?.method || 'GET').toUpperCase().slice(0, 12);
  const pathName = normalizePath(entry?.path ?? entry?.url);
  return {
    ts,
    method,
    path: pathName,
    route: classifyLogRoute(pathName, method),
    status: integer(entry?.status, 0),
    actor: String(entry?.actor || '').trim().slice(0, 120),
  };
}

export function normalizeLogs(input, { from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
  const aggregate = normalizeAggregateLogs(input);
  if (aggregate) return aggregate;
  const { items, metadata } = logItems(input);
  const records = items.map(normalizedLogEntry).filter((entry) => entry.ts >= from && entry.ts < to);
  const allEntries = items.map(normalizedLogEntry).filter((entry) => entry.ts > 0);
  const routeCounts = Object.fromEntries(ROUTE_CLASSES.map((name) => [name, 0]));
  const statusCounts = {};
  const actorCounts = new Map();
  for (const record of records) {
    routeCounts[record.route] = integer(routeCounts[record.route]) + 1;
    const status = String(record.status || 0);
    statusCounts[status] = integer(statusCounts[status]) + 1;
    if (record.actor) actorCounts.set(record.actor, integer(actorCounts.get(record.actor)) + 1);
  }
  const sortedActors = [...actorCounts.values()].sort((a, b) => b - a);
  const declaredTotal = Number.isFinite(Number(metadata.total)) ? integer(metadata.total) : null;
  const declaredComplete = metadata.complete !== false;
  const fetched = integer(metadata.fetched ?? items.length);
  const crossedWindowStart = allEntries.some((entry) => entry.ts < from);
  const complete = declaredComplete && (declaredTotal == null || fetched >= declaredTotal || crossedWindowStart);
  return {
    available: true,
    complete,
    records: records.length,
    fetched,
    declared_total: declaredTotal,
    route_counts: routeCounts,
    status_counts: statusCounts,
    actor_count: actorCounts.size,
    max_records_per_actor: sortedActors[0] || 0,
    window_from: from,
    window_to: to,
  };
}

function normalizeAggregateLogs(input) {
  const summary = input?.summary && typeof input.summary === 'object' && !Array.isArray(input.summary)
    ? { ...input, ...input.summary }
    : input;
  if (!summary || typeof summary !== 'object' || !summary.route_counts || Array.isArray(summary.route_counts)) return null;
  const routeCounts = Object.fromEntries(ROUTE_CLASSES.map((name) => [name, integer(summary.route_counts?.[name], 0)]));
  const statusCounts = {};
  for (const [status, count] of Object.entries(summary.status_counts || {})) statusCounts[String(status)] = integer(count);
  const groupedRows = integer(summary.query?.aggregate_rows_returned ?? summary.aggregate_rows_returned);
  const total = integer(summary.total);
  const routeTotal = routeCounts ? Object.values(routeCounts).reduce((sum, value) => sum + value, 0) : 0;
  const available = summary.available !== false && summary.ok !== false;
  return {
    available,
    complete: available && summary.complete !== false && summary.truncated !== true,
    records: total > 0 ? total : routeTotal,
    fetched: groupedRows,
    declared_total: null,
    route_counts: routeCounts,
    status_counts: statusCounts,
    actor_count: 0,
    max_records_per_actor: 0,
    window_from: parseTimestamp(summary.window?.from ?? summary.from),
    window_to: parseTimestamp(summary.window?.to ?? summary.to),
    aggregation: {
      source: String(summary.source || 'debug_logs'),
      groups: groupedRows,
      statements: integer(summary.query?.statements ?? summary.statements),
    },
  };
}

function versionTuple(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/i);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersion(left, right) {
  const a = versionTuple(left) || [0, 0, 0];
  const b = versionTuple(right) || [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function hasAgentState(target) {
  return Boolean(target?.agent_metrics || target?.agent_version || target?.last_metrics_at || target?.agent_online || target?.nq?.has_report);
}

function enabled(value) {
  return value !== false && Number(value ?? 1) !== 0;
}

export function normalizeStatus(status = {}) {
  const targets = Array.isArray(status?.targets) ? status.targets : [];
  const enabledTargets = targets.filter((target) => enabled(target?.enabled));
  const probeTargets = enabledTargets.filter((target) => Number(target?.no_public_ip || 0) !== 1);
  const agentTargets = enabledTargets.filter((target) => String(target?.type || '').toLowerCase() === 'tcp' && hasAgentState(target));
  const wssAgents = agentTargets.filter((target) => compareVersion(target?.agent_version, '1.1.16') >= 0);
  const versions = {};
  for (const target of agentTargets) {
    const version = String(target?.agent_version || 'unknown').trim() || 'unknown';
    versions[version] = integer(versions[version]) + 1;
  }
  const latencyNodeIds = new Set();
  for (const target of enabledTargets) {
    for (const source of Array.isArray(target?.latency_sources) ? target.latency_sources : []) {
      if (String(source?.kind || '').toLowerCase() === 'external' && source?.id) latencyNodeIds.add(String(source.id));
    }
  }
  const trafficAgents = enabledTargets.filter((target) => Number(target?.traffic_enabled || 0) === 1 && hasAgentState(target));
  const pingTargets = Array.isArray(status?.ping_targets) ? status.ping_targets.filter((target) => enabled(target?.enabled)) : [];
  const onlineAgents = agentTargets.filter((target) => target?.agent_online === true);
  return {
    target_count: enabledTargets.length,
    tcp_target_count: enabledTargets.filter((target) => String(target?.type || '').toLowerCase() === 'tcp').length,
    http_target_count: enabledTargets.filter((target) => String(target?.type || '').toLowerCase() === 'http').length,
    probe_target_count: probeTargets.length,
    agent_count: agentTargets.length,
    online_agent_count: onlineAgents.length,
    wss_capable_agent_count: wssAgents.length,
    legacy_or_unknown_agent_count: Math.max(0, agentTargets.length - wssAgents.length),
    unknown_version_agent_count: agentTargets.filter((target) => !versionTuple(target?.agent_version)).length,
    version_buckets: versions,
    latency_node_count: latencyNodeIds.size,
    ping_target_count: pingTargets.length,
    traffic_agent_count: trafficAgents.length,
    target_intervals: [...new Set(probeTargets.map((target) => positiveNumber(target?.interval_sec, DEFAULT_REPORT_SEC)))].sort((a, b) => a - b),
  };
}

function calibratedFactor(calibration, name, fallback) {
  const profile = calibration?.range_mode === 'stress' ? calibration?.stress_factors : calibration?.factors;
  const value = profile?.[name];
  if (!value || typeof value !== 'object') return { point: fallback, low: fallback, high: fallback };
  const point = finiteNumber(value.point, fallback);
  return {
    point,
    low: finiteNumber(value.low, point),
    high: finiteNumber(value.high, point),
  };
}

function routeCount(logs, route, derived, uncertainty = 0.12) {
  if (logs?.available && logs.complete) {
    const count = integer(logs.route_counts?.[route], 0);
    return { count: exact(count), source: 'observed', note: '完整 debug_logs 窗口内按路由直接计数。' };
  }
  const observed = integer(logs?.route_counts?.[route], 0);
  if (logs?.available && observed > 0) {
    const point = Math.max(observed, integer(derived));
    return {
      count: range(point, observed, Math.max(point, point * (1 + uncertainty * 4))),
      source: 'observed+derived',
      note: '日志不完整；观测值作为下界，缺失部分由周期模型补齐。',
    };
  }
  return {
    count: range(derived, derived * (1 - uncertainty), derived * (1 + uncertainty)),
    source: 'derived',
    note: 'debug_logs 不可用，按源码默认周期推导。',
  };
}

function addEvent(events, {
  id,
  label,
  count,
  source = 'derived',
  note = '',
  worker = false,
  profile = null,
  r2A = 0,
  r2B = 0,
  doRequests = 0,
}) {
  const selectedProfile = typeof profile === 'string' ? D1_PROFILES[profile] : profile;
  const d1 = selectedProfile || {};
  const writePer = finiteNumber(d1.write) + finiteNumber(d1.authTouch) + finiteNumber(d1.debugLog);
  const rowsWrittenPer = finiteNumber(d1.rowsWritten) + finiteNumber(d1.debugLog);
  const item = {
    id,
    label,
    source,
    note: note || SOURCE_NOTES[id] || '',
    count,
    worker_calls: worker ? count : exact(0),
    do: { requests: multiplyRange(count, doRequests) },
    r2: {
      class_a: multiplyRange(count, r2A),
      class_b: multiplyRange(count, r2B),
    },
    d1: {
      read_queries: multiplyRange(count, finiteNumber(d1.read)),
      write_queries: multiplyRange(count, writePer),
      rows_read: multiplyRange(count, finiteNumber(d1.rowsRead)),
      rows_written: multiplyRange(count, rowsWrittenPer),
    },
  };
  events.push(item);
  return item;
}

function sumEventMetric(events, key) {
  return sumRanges(events.map((event) => (Array.isArray(key)
    ? key.reduce((value, part) => value?.[part], event)
    : event[key])));
}

function routeEvent(events, logs, route, derived, details) {
  const observed = routeCount(logs, route, derived, details.uncertainty ?? 0.12);
  return addEvent(events, { ...details, count: observed.count, source: observed.source, note: `${observed.note} ${details.note || SOURCE_NOTES[details.id] || ''}` });
}

function estimateWorkers(status, logs, duration, options, calibration) {
  const fleet = normalizeStatus(status);
  const events = [];
  const reportSec = positiveNumber(options.reportSec, DEFAULT_REPORT_SEC);
  const taskSec = positiveNumber(options.taskSec, DEFAULT_TASK_SEC);
  const updateSec = positiveNumber(options.updateSec, DEFAULT_UPDATE_SEC);
  const pingRefreshSec = positiveNumber(options.pingRefreshSec, DEFAULT_PING_REFRESH_SEC);
  const latencySec = positiveNumber(options.latencySec, DEFAULT_LATENCY_SEC);
  const factor = (name, fallback) => calibratedFactor(calibration, name, fallback);

  const wsReports = periodicCount(duration, reportSec) * fleet.wss_capable_agent_count;
  addEvent(events, {
    id: 'agent_metrics_ws',
    label: 'WSS Agent 遥测消息（DO 内处理）',
    count: range(wsReports, wsReports * 0.85, wsReports * 1.05),
    source: 'derived',
    note: SOURCE_NOTES.agent_metrics_ws,
    worker: false,
    profile: 'agent_metrics_ws',
    doRequests: 1,
  });

  const legacyReports = periodicCount(duration, reportSec) * fleet.legacy_or_unknown_agent_count;
  addEvent(events, {
    id: 'agent_metrics_http',
    label: '旧 Agent / WSS fallback HTTP 遥测',
    count: range(legacyReports, legacyReports * 0.8, legacyReports + periodicCount(duration, reportSec) * fleet.wss_capable_agent_count * factor('workers_wss_http_fallback_rate', 0.05).high),
    source: 'derived',
    note: `${SOURCE_NOTES.agent_metrics_http} 当前点估计只把旧/未知版本计入；WSS fallback 仅进入上界。`,
    worker: true,
    profile: 'agent_metrics_http',
  });

  const taskDerived = periodicCount(duration, taskSec) * fleet.agent_count;
  routeEvent(events, logs, 'agent_tasks', taskDerived, {
    id: 'agent_tasks',
    label: 'Agent Manager 任务轮询',
    worker: true,
    profile: 'agent_tasks',
  });
  routeEvent(events, logs, 'agent_task_action', 0, {
    id: 'agent_task_action',
    label: 'Agent 任务结果/取消请求',
    worker: true,
    profile: 'agent_task_action',
  });

  const updateDerived = periodicCount(duration, updateSec) * fleet.agent_count;
  routeEvent(events, logs, 'agent_update_policy', updateDerived, {
    id: 'agent_update_policy',
    label: 'Agent 自动更新策略检查',
    worker: true,
    profile: 'agent_update_policy',
  });

  const geoConfigDerived = Math.ceil((duration / DAY_SEC) * fleet.agent_count);
  routeEvent(events, logs, 'agent_config', geoConfigDerived, {
    id: 'agent_config',
    label: 'Agent 地理位置配置读取',
    worker: true,
    profile: 'agent_config',
  });
  routeEvent(events, logs, 'agent_location', geoConfigDerived, {
    id: 'agent_location',
    label: 'Agent 地理位置回传',
    worker: true,
    profile: 'agent_location',
  });

  const pingRefreshDerived = periodicCount(duration, pingRefreshSec) * fleet.legacy_or_unknown_agent_count;
  addEvent(events, {
    id: 'agent_ping_targets',
    label: '旧 Agent Ping 目标刷新',
    count: range(pingRefreshDerived, pingRefreshDerived * 0.7, pingRefreshDerived * 1.3),
    source: 'derived',
    note: SOURCE_NOTES.agent_ping_targets,
    worker: true,
    profile: 'agent_ping_targets',
  });

  const latencyCycles = periodicCount(duration, latencySec) * fleet.latency_node_count;
  addEvent(events, {
    id: 'latency_targets',
    label: 'Latency 节点目标列表读取',
    count: range(latencyCycles, latencyCycles * 0.9, latencyCycles * 1.1),
    source: 'derived',
    note: SOURCE_NOTES.latency_targets,
    worker: true,
    profile: 'latency_targets',
  });
  addEvent(events, {
    id: 'latency_results',
    label: 'Latency 节点结果提交',
    count: range(latencyCycles, latencyCycles * 0.9, latencyCycles * 1.1),
    source: 'derived',
    note: SOURCE_NOTES.latency_results,
    worker: true,
    profile: 'latency_results',
  });
  const latencyUpdateDerived = periodicCount(duration, 3_600) * fleet.latency_node_count;
  routeEvent(events, logs, 'latency_update_policy', latencyUpdateDerived, {
    id: 'latency_update_policy',
    label: 'Latency 节点更新策略读取',
    worker: true,
    profile: 'latency_update_policy',
  });
  routeEvent(events, logs, 'admin_agent_tasks', 0, {
    id: 'admin_agent_tasks',
    label: '后台任务列表轮询',
    worker: true,
    profile: 'admin_agent_tasks',
  });
  routeEvent(events, logs, 'other_debug', 0, {
    id: 'other_debug',
    label: '其他已记录 API 请求',
    worker: true,
    profile: 'other_debug',
  });

  const scheduled = periodicCount(duration, MINUTE_SEC);
  addEvent(events, {
    id: 'scheduled_sweep',
    label: 'Workers Cron 调度入口',
    count: exact(scheduled),
    source: 'derived',
    note: SOURCE_NOTES.scheduled_sweep,
    worker: true,
    profile: 'scheduled_sweep',
  });

  const publicRps = factor('workers_public_rps', DEFAULT_PUBLIC_RPS);
  addEvent(events, {
    id: 'public_dynamic',
    label: '公开动态接口（未进入 debug_logs）',
    count: range(duration * publicRps.point, duration * publicRps.low, duration * publicRps.high),
    source: 'assumption',
    note: '仅估算 Functions 请求；静态 Pages Asset 请求不计入此项。可用 --public-rps 覆盖点估计。',
    worker: true,
  });

  const handshake = fleet.wss_capable_agent_count * (duration / DAY_SEC);
  addEvent(events, {
    id: 'wss_handshake',
    label: 'WSS 建连/重连握手',
    count: range(handshake * factor('workers_wss_handshake_per_agent_day', 1.5).point, handshake * factor('workers_wss_handshake_per_agent_day', 1.5).low, handshake * factor('workers_wss_handshake_per_agent_day', 1.5).high),
    source: 'assumption',
    note: '站点日志没有记录 Durable Object WebSocket 握手的完整生命周期，因此按每 Agent 每天的握手先验估算。',
    worker: true,
  });

  const calls = sumEventMetric(events, 'worker_calls');
  return {
    function_calls_base: calls,
    events,
    fleet,
    assumptions: {
      report_sec: reportSec,
      task_sec: taskSec,
      update_sec: updateSec,
      ping_refresh_sec: pingRefreshSec,
      latency_sec: latencySec,
      public_rps: publicRps,
      public_rps_source: options.publicRpsExplicit ? 'cli' : 'calibration-prior',
    },
  };
}

function estimateR2(workers, duration, options, calibration) {
  const fleet = workers.fleet;
  const factor = (name, fallback) => calibratedFactor(calibration, name, fallback);
  const events = [];
  const latencyCycles = periodicCount(duration, options.latencySec) * fleet.latency_node_count;
  addEvent(events, {
    id: 'latency_archive',
    label: 'Latency R2 结果段读改写',
    count: range(latencyCycles, latencyCycles * 0.9, latencyCycles * 1.1),
    source: 'derived',
    note: '每个结果批次通常先读当前小时段，再写回一个合并对象。',
    r2A: 1,
    r2B: 1,
  });

  const telemetryFlushes = fleet.agent_count * Math.ceil(duration / HOUR_SEC);
  addEvent(events, {
    id: 'telemetry_flush',
    label: 'Agent 遥测缓冲按小时落 R2',
    count: exact(telemetryFlushes),
    source: 'derived',
    note: 'TelemetryBuffer 默认约每小时为每个 Agent 读/写一个遥测对象；DO 内的每条 WSS 消息不直接产生 R2 操作。',
    r2A: 1,
    r2B: 1,
  });

  const intervals = periodicCount(duration, DEFAULT_REPORT_SEC);
  const batchesPerInterval = Math.max(1, Math.ceil(Math.max(1, fleet.probe_target_count) / positiveNumber(options.maxTargetsPerRun, DEFAULT_MAX_TARGETS_PER_RUN)));
  const probeBatches = intervals * batchesPerInterval;
  addEvent(events, {
    id: 'probe_state_sync',
    label: '探测 R2 状态合并',
    count: range(probeBatches, probeBatches * 0.85, probeBatches * 1.2),
    source: 'derived',
    note: '按每个 300 秒周期需要的批次数估算一次 state/status.json 读写；失败重试进入上界。',
    r2A: 1,
    r2B: 1,
  });
  addEvent(events, {
    id: 'status_snapshot',
    label: '状态快照 R2 读写',
    count: range(probeBatches, probeBatches * 0.75, probeBatches * 1.3),
    source: 'derived',
    note: '当前源码只在有探测结果的 scheduled run 中写快照；实际是否每分钟/每五分钟由 Worker 环境变量决定。',
    r2A: 1,
    r2B: 1,
  });

  const archiveDays = duration / DAY_SEC;
  const archiveExpected = fleet.probe_target_count * archiveDays;
  const archiveBurst = fleet.probe_target_count * Math.max(1, Math.ceil(archiveDays));
  addEvent(events, {
    id: 'probe_history_archive',
    label: '探测历史日归档',
    count: range(archiveExpected, 0, archiveBurst * 2),
    source: 'derived',
    note: '每个目标对每个完成日做一次 R2 读改写（读旧日对象 + 写合并对象）；点估计按窗口时长线性取期望，low=0 覆盖不含日界的短窗口或未启用归档的情形，high 覆盖日界突发与失败重试。',
    r2A: 1,
    r2B: 1,
  });

  const publicDynamic = workers.events.find((event) => event.id === 'public_dynamic')?.count || exact(0);
  const publicReadRate = factor('r2_public_read_rate', 0.55);
  addEvent(events, {
    id: 'public_r2_reads',
    label: '公开请求触发的 R2 读取',
    count: multiplyRange(publicDynamic, publicReadRate),
    source: 'assumption',
    note: '公开接口未在当前 debug_logs 中记录；按动态请求中会读取状态/快照的比例估算。',
    r2B: 1,
  });

  const baseA = sumEventMetric(events, ['r2', 'class_a']);
  const baseB = sumEventMetric(events, ['r2', 'class_b']);
  const classA = multiplyRange(baseA, factor('r2_class_a_multiplier', 1.37));
  const classB = baseB;
  const ab = addRanges(classA, classB);
  const distribution = multiplyRange(ab, factor('r2_distribution_over_ab', 1.276));
  return {
    class_a: classA,
    class_b: classB,
    requests_distribution: distribution,
    base_class_a: baseA,
    base_class_b: baseB,
    events,
    assumptions: {
      public_read_rate: publicReadRate,
      class_a_multiplier: factor('r2_class_a_multiplier', 1.37),
      distribution_over_ab: factor('r2_distribution_over_ab', 1.276),
      probe_batches: probeBatches,
      max_targets_per_run: positiveNumber(options.maxTargetsPerRun, DEFAULT_MAX_TARGETS_PER_RUN),
    },
  };
}

function estimateD1(workers, duration, options, calibration) {
  const fleet = workers.fleet;
  const events = [];
  const reportSec = workers.assumptions.report_sec;
  const taskSec = workers.assumptions.task_sec;
  const updateSec = workers.assumptions.update_sec;
  const latencySec = workers.assumptions.latency_sec;
  const activeReportCycles = periodicCount(duration, reportSec);
  for (const event of workers.events.filter((item) => ['agent_metrics_ws', 'agent_metrics_http', 'agent_tasks', 'agent_task_action', 'agent_update_policy', 'agent_config', 'agent_location', 'latency_update_policy', 'admin_agent_tasks', 'other_debug'].includes(item.id))) {
    events.push({
      ...event,
      id: `d1_${event.id}`,
      label: `${event.label} · D1`,
      worker_calls: exact(0),
      r2: { class_a: exact(0), class_b: exact(0) },
    });
  }

  const latencyCycles = periodicCount(duration, latencySec) * fleet.latency_node_count;
  addEvent(events, {
    id: 'd1_latency_targets',
    label: 'Latency 目标查询 · D1',
    count: exact(latencyCycles),
    source: 'derived',
    note: '目标列表每次请求都会查询启用 TCP 目标并校验节点身份。',
    profile: 'latency_targets',
  });
  addEvent(events, {
    id: 'd1_latency_results',
    label: 'Latency 结果处理 · D1',
    count: exact(latencyCycles),
    source: 'derived',
    note: '包括允许目标查询、节点状态更新和清理；结果明细优先归档到 R2。',
    profile: 'latency_results',
  });

  const schedulerCount = periodicCount(duration, MINUTE_SEC);
  addEvent(events, {
    id: 'd1_scheduled_sweep',
    label: '定时调度/锁/状态读取 · D1',
    count: exact(schedulerCount),
    source: 'derived',
    note: SOURCE_NOTES.scheduled_sweep,
    profile: 'scheduled_sweep',
  });

  // Plan-A coarse schedule bookkeeping: the per-probe targets UPDATE is
  // throttled to one flush per target per TARGET_SCHEDULE_FLUSH_SEC (default
  // 30 minutes); probing cadence lives in the R2 status state.
  const scheduleFlushes = fleet.probe_target_count * periodicCount(duration, 1_800);
  const probeFactor = calibratedFactor(calibration, 'probe_event_multiplier', 1.15);
  const probeWrites = multiplyRange(exact(scheduleFlushes), probeFactor);
  addEvent(events, {
    id: 'd1_probe_persist',
    label: '调度粗粒度回写 · D1（每目标每 30 分钟）',
    count: probeWrites,
    source: 'derived',
    note: '探测节奏由 R2 状态承载；D1 仅按每目标每 30 分钟（TARGET_SCHEDULE_FLUSH_SEC）回写 last_checked_at/next_probe_at 作为崩溃恢复镜像。',
    profile: 'probe_persist',
  });

  const batchesPerInterval = Math.max(1, Math.ceil(Math.max(1, fleet.probe_target_count) / positiveNumber(options.maxTargetsPerRun, DEFAULT_MAX_TARGETS_PER_RUN)));
  const probeBatches = activeReportCycles * batchesPerInterval;
  addEvent(events, {
    id: 'd1_status_snapshot',
    label: '状态快照生成 · D1',
    count: range(probeBatches, probeBatches * 0.75, probeBatches * 1.3),
    source: 'derived',
    note: '构建快照会读取 targets、metrics、latest 和可用性等集合。',
    profile: 'status_snapshot',
  });

  const trafficReports = activeReportCycles * fleet.traffic_agent_count;
  addEvent(events, {
    id: 'd1_traffic_read',
    label: '流量设置/月份读取 · D1',
    count: exact(trafficReports),
    source: 'derived',
    note: '仅计入 status 中明确标记 traffic_enabled 的 Agent。',
    profile: { read: 2, rowsRead: 4 },
  });
  addEvent(events, {
    id: 'd1_traffic_period_write',
    label: '流量半小时累计写入 · D1',
    count: exact(fleet.traffic_agent_count * periodicCount(duration, 1_800)),
    source: 'derived',
    note: 'persistAgentTraffic 的周期性月度累计更新。',
    profile: { write: 1, rowsWritten: 1 },
  });

  const cacheMiss = calibratedFactor(calibration, 'public_cache_miss_rate', 0.06);
  const publicDynamic = workers.events.find((event) => event.id === 'public_dynamic')?.count || exact(0);
  addEvent(events, {
    id: 'd1_public_cache_miss',
    label: '公开动态请求缓存未命中 · D1',
    count: multiplyRange(publicDynamic, cacheMiss),
    source: 'assumption',
    note: '公开 status/detail 路径不在当前 debug_logs 中，按缓存未命中率估算。',
    profile: 'public_cache_miss',
  });

  addEvent(events, {
    id: 'd1_maintenance',
    label: '小时维护/清理 · D1',
    count: exact(Math.ceil(duration / HOUR_SEC)),
    source: 'derived',
    note: '按每小时维护槽位执行一次；具体表大小只能从 D1 自身统计得到。',
    profile: 'maintenance',
  });

  const credentialSubjects = fleet.agent_count + fleet.latency_node_count;
  addEvent(events, {
    id: 'd1_credential_effective_rows',
    label: '凭据 last_used_at 实际受影响行',
    count: exact(credentialSubjects * periodicCount(duration, positiveNumber(options.credentialTouchSec, DEFAULT_CREDENTIAL_TOUCH_SEC))),
    source: 'derived',
    note: '每次认证查询和实际更新行是两个概念；这里单独估算触摸节流真正改变的行数。',
    profile: { rowsWritten: 1 },
  });

  const readBase = sumEventMetric(events, ['d1', 'read_queries']);
  const writeBase = sumEventMetric(events, ['d1', 'write_queries']);
  const rowsReadBase = sumEventMetric(events, ['d1', 'rows_read']);
  const rowsWrittenBase = sumEventMetric(events, ['d1', 'rows_written']);
  const queryMultiplier = calibratedFactor(calibration, 'd1_query_path_multiplier', 1.135);
  const rowsReadMultiplier = calibratedFactor(calibration, 'd1_rows_read_multiplier', 2.65);
  const rowsWrittenMultiplier = calibratedFactor(calibration, 'd1_rows_written_multiplier', 1.92);
  const queries = multiplyRange(addRanges(readBase, writeBase), queryMultiplier);
  return {
    read_queries: multiplyRange(readBase, queryMultiplier),
    write_queries: multiplyRange(writeBase, queryMultiplier),
    queries,
    rows_read: multiplyRange(rowsReadBase, rowsReadMultiplier),
    rows_written: multiplyRange(rowsWrittenBase, rowsWrittenMultiplier),
    base: {
      read_queries: readBase,
      write_queries: writeBase,
      rows_read: rowsReadBase,
      rows_written: rowsWrittenBase,
    },
    events,
    assumptions: {
      query_path_multiplier: queryMultiplier,
      rows_read_multiplier: rowsReadMultiplier,
      rows_written_multiplier: rowsWrittenMultiplier,
      credential_touch_sec: positiveNumber(options.credentialTouchSec, DEFAULT_CREDENTIAL_TOUCH_SEC),
      observed_debug_route_events: workers.events
        .filter((event) => ['agent_tasks', 'agent_task_action', 'agent_update_policy', 'agent_config', 'agent_location', 'latency_update_policy', 'admin_agent_tasks', 'other_debug'].includes(event.id))
        .reduce((sum, event) => sum + finiteNumber(event.count?.estimate), 0),
      unused_parameters: { task_sec: taskSec, update_sec: updateSec },
    },
  };
}

function estimateDurableObjects(workers, duration, options = {}) {
  const fleet = workers.fleet;
  const events = [];
  const scheduled = periodicCount(duration, MINUTE_SEC);
  const wssMessages = workers.events.find((event) => event.id === 'agent_metrics_ws')?.count || exact(0);
  addEvent(events, {
    id: 'do_telemetry_wss',
    label: 'TelemetryBuffer WSS 消息唤醒',
    count: wssMessages,
    source: 'derived',
    note: 'Hibernation 模式下每条入站 WebSocket 消息唤醒 DO 一次，计入 DO 请求配额；消息内部的存储读写不是额外请求。',
    doRequests: 1,
  });
  const probeAppends = fleet.probe_target_count * periodicCount(duration, workers.assumptions.report_sec);
  addEvent(events, {
    id: 'do_probe_history_append',
    label: 'ProbeHistoryBuffer 探测追加',
    count: exact(probeAppends),
    source: 'derived',
    note: '每次探测保存请求目标独立的 ProbeHistoryBuffer DO 实例一次；日归档刷盘在实例内部/alarm 完成，不额外计请求。',
    doRequests: 1,
  });
  addEvent(events, {
    id: 'do_probe_region_scheduled',
    label: 'ProbeRegion 定时调度执行',
    count: options.regionProxy === false ? exact(0) : exact(scheduled),
    source: 'derived',
    note: '配置 REGION_PROXY 时每分钟 cron 调度在 ProbeRegion DO 内执行（--no-region-proxy 可关）；未配置时探测在 Worker 内运行，计 0。',
    doRequests: 1,
  });
  addEvent(events, {
    id: 'do_status_stream_publish',
    label: 'StatusStream 状态事件发布',
    count: range(scheduled * 0.9, scheduled * 0.5, scheduled),
    source: 'derived',
    note: '有探测事件的调度分钟会向 StatusStream DO 发布一次；公开 WS 扇出在 DO 内部完成，不按观众计请求。',
    doRequests: 1,
  });
  const requests = sumEventMetric(events, ['do', 'requests']);
  return {
    requests,
    components: events,
    assumptions: {
      free_tier_limit_requests_per_day: 100_000,
      note: 'v1.3 把高频当前状态写入从 D1 迁移到 DO 后，DO 请求配额（账户级 100k/日）成为新的观测项；Hibernation 下 DO 时长按活跃处理毫秒级计，13k GB-s/日 的时长限额当前规模可忽略。DO 内部 SQLite 存储操作不计入请求配额。',
    },
  };
}

function applyOutputCalibration(result, calibration) {
  const factors = calibration?.range_mode === 'stress'
    ? calibration?.stress_output_multipliers || calibration?.output_multipliers || {}
    : calibration?.output_multipliers || {};
  const pointEnvelope = calibration?.range_mode !== 'stress'
    && (calibration?.range_strategy || 'point-envelope') === 'point-envelope';
  const apply = (value, name) => {
    const factor = factors[name] || { point: 1, low: 1, high: 1 };
    if (!pointEnvelope) return multiplyRange(value, factor);
    const point = finiteNumber(factor.point ?? factor.estimate, 1);
    const low = finiteNumber(factor.low, point);
    const high = finiteNumber(factor.high, point);
    const base = finiteNumber(value?.estimate);
    return range(base * point, base * low, base * high);
  };
  const output = clone(result);
  output.workers.function_calls = apply(output.workers.function_calls, 'workers_calls');
  output.r2.class_a = apply(output.r2.class_a, 'r2_class_a');
  output.r2.class_b = apply(output.r2.class_b, 'r2_class_b');
  output.r2.requests_distribution = apply(output.r2.requests_distribution, 'r2_requests');
  output.d1.queries = apply(output.d1.queries, 'd1_queries');
  output.d1.rows_read = apply(output.d1.rows_read, 'd1_rows_read');
  output.d1.rows_written = apply(output.d1.rows_written, 'd1_rows_written');
  return output;
}

export function estimateUsage({
  status = {},
  logs = null,
  from,
  to,
  options = {},
  calibration = DEFAULT_CALIBRATION,
} = {}) {
  const end = parseTimestamp(to) || Math.floor(Date.now() / 1000);
  const start = parseTimestamp(from) || end - DAY_SEC;
  const duration = Math.max(1, end - start);
  let normalizedLogs = logs?.available === true && logs?.route_counts
    ? logs
    : logs?.available === false
      ? { ...logs, available: false, complete: false, route_counts: logs.route_counts || {} }
      : logs == null ? { available: false, complete: false, route_counts: {} } : normalizeLogs(logs, { from: start, to: end });
  if (normalizedLogs?.available && !integer(normalizedLogs.records)) {
    const routeTotal = Object.values(normalizedLogs.route_counts || {}).reduce((sum, value) => sum + integer(value), 0);
    if (routeTotal > 0) normalizedLogs = { ...normalizedLogs, records: routeTotal };
  }
  const workerModel = estimateWorkers(status, normalizedLogs, duration, options, calibration);
  const r2Model = estimateR2(workerModel, duration, { ...options, latencySec: positiveNumber(options.latencySec, DEFAULT_LATENCY_SEC), maxTargetsPerRun: positiveNumber(options.maxTargetsPerRun, DEFAULT_MAX_TARGETS_PER_RUN) }, calibration);
  const d1Model = estimateD1(workerModel, duration, options, calibration);
  const doModel = estimateDurableObjects(workerModel, duration, options);
  const result = {
    model_version: MODEL_VERSION,
    calibration_mode: calibration?.calibration_mode || 'unknown',
    range_mode: calibration?.range_mode === 'stress' ? 'stress' : 'operational',
    range_semantics: calibration?.range_mode === 'stress'
      ? '压力上界：把来源不完整时的重连、fallback、缓存失效和路径放大作为可叠加风险估计。'
      : '运营区间：围绕点估计给出稳定窗口的对账范围，不是保证值；异常压力请切换 stress。',
    window: {
      from: Math.floor(start),
      to: Math.floor(end),
      from_iso: isoFromSeconds(start),
      to_iso: isoFromSeconds(end),
      seconds: duration,
      hours: Number((duration / HOUR_SEC).toFixed(3)),
      timezone: 'UTC',
    },
    input: {
      status_source: options.statusSource || 'provided',
      logs_source: options.logsSource || (normalizedLogs.available ? 'provided' : 'unavailable'),
      calibration_source: options.calibrationSource || 'code-default',
      logs_available: Boolean(normalizedLogs.available),
      logs_complete: Boolean(normalizedLogs.complete),
      logs_window_records: integer(normalizedLogs.records),
      logs_fetched: integer(normalizedLogs.fetched),
      logs_declared_total: normalizedLogs.declared_total == null ? null : integer(normalizedLogs.declared_total),
    },
    fleet: workerModel.fleet,
    workers: {
      function_calls: workerModel.function_calls_base,
      components: workerModel.events,
      assumptions: workerModel.assumptions,
      excluded: ['静态 Pages Asset 请求不在 Workers Functions 调用估算内。', 'WSS metrics 消息不按 HTTP request 计，但其 D1/R2/DO 后端处理仍单独估算。'],
    },
    r2: {
      class_a: r2Model.class_a,
      class_b: r2Model.class_b,
      requests_distribution: r2Model.requests_distribution,
      base_class_a: r2Model.base_class_a,
      base_class_b: r2Model.base_class_b,
      components: r2Model.events,
      assumptions: r2Model.assumptions,
    },
    d1: {
      queries: d1Model.queries,
      read_queries: d1Model.read_queries,
      write_queries: d1Model.write_queries,
      rows_read: d1Model.rows_read,
      rows_written: d1Model.rows_written,
      base: d1Model.base,
      components: d1Model.events,
      assumptions: d1Model.assumptions,
    },
    do: doModel,
    observability: {
      exact: normalizedLogs.complete ? ['完整窗口内的已记录 debug 路由请求数', 'debug 路由的 HTTP 状态分布'] : [],
      inferred: ['WSS 建连/重连', 'HTTP fallback 比例', '公开动态请求量', 'R2 公开读取比例', 'D1 扫描行数和分支放大'],
      missing: [
        '当前 debug 摘要只覆盖选定管理/Agent 路由，不记录所有公开 status/detail 请求。',
        'WSS 的每次握手、DO 重连和 isolate 生命周期不能仅靠公开状态精确恢复。',
        'CF 的 rolling 24h 边界、失败请求计费口径和 dashboard 聚合延迟需要人工对照。',
      ],
      confidence: normalizedLogs.complete ? 'medium' : 'low',
    },
  };
  return applyOutputCalibration(result, calibration);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = clamp((sorted.length - 1) * fraction, 0, sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function actualMetric(pair, key) {
  const estimate = finiteNumber(pair?.estimate?.[key] ?? pair?.estimated?.[key]);
  const actual = finiteNumber(pair?.actual?.[key]);
  if (estimate <= 0 || actual < 0) return null;
  return actual / estimate;
}

export function fitCalibration(pairs, baseCalibration = DEFAULT_CALIBRATION) {
  const list = Array.isArray(pairs) ? pairs : Array.isArray(pairs?.observations) ? pairs.observations : [];
  const keys = ['workers_calls', 'r2_class_a', 'r2_class_b', 'r2_requests', 'd1_queries', 'd1_rows_read', 'd1_rows_written'];
  const output = clone(baseCalibration);
  output.model_version = MODEL_VERSION;
  output.calibration_mode = 'offline-paired-fit';
  output.fitted_pairs = list.length;
  const outputProfile = output.range_mode === 'stress'
    ? output.stress_output_multipliers || output.output_multipliers
    : output.output_multipliers;
  for (const key of keys) {
    const ratios = list.map((pair) => actualMetric(pair, key)).filter((value) => value != null);
    if (!ratios.length) continue;
    const point = median([...ratios]);
    outputProfile[key] = {
      point,
      low: quantile(ratios, 0.1) ?? point,
      high: quantile(ratios, 0.9) ?? point,
    };
  }
  return output;
}

async function readJsonFile(fileName) {
  return JSON.parse(await fs.readFile(fileName, 'utf8'));
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers, cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}`);
  return response.json();
}

const ADMIN_SESSION_VALUE = /^[A-Za-z0-9_-]{16,256}$/;
const USAGE_SUMMARY_TOKEN_VALUE = /^nsu_[a-f0-9]{64}$/;

// The Worker deliberately accepts admin sessions only through this header.
// Do not turn a session value into a Cookie or Authorization credential here:
// that would both diverge from the Worker contract and risk widening the
// credential's scope beyond the bounded usage-summary endpoint.
export function adminSessionHeaders(session) {
  const supplied = String(session || '').trim();
  if (!supplied) return {};
  const value = supplied.replace(/^x-admin-session\s*:\s*/i, '').trim();
  if (!ADMIN_SESSION_VALUE.test(value)) {
    throw new Error('NIE_SLA_ADMIN_SESSION must be a raw x-admin-session value, not a Cookie or Bearer credential');
  }
  return { 'x-admin-session': value };
}

export function usageSummaryTokenHeaders(token) {
  const value = String(token || '').trim();
  if (!USAGE_SUMMARY_TOKEN_VALUE.test(value)) {
    throw new Error('NIE_SLA_USAGE_TOKEN must be a raw nsu_ read-only usage token');
  }
  return { authorization: `Bearer ${value}` };
}

export function usageSummaryAuthHeaders({ usageToken = '', adminSession = '' } = {}) {
  if (String(usageToken || '').trim()) return usageSummaryTokenHeaders(usageToken);
  return adminSessionHeaders(adminSession);
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function assertSafeUsageCredentialUrl(baseUrl) {
  const url = new URL(baseUrl);
  const hostname = url.hostname.toLowerCase();
  const allowedProductionHost = hostname === 'status.example.com' || hostname === 'api.example.com';
  const loopback = isLoopbackHost(hostname);
  if (!loopback && url.protocol !== 'https:') throw new Error('refusing to send a usage credential over non-HTTPS URL');
  if (!allowedProductionHost && !loopback) throw new Error(`refusing to send admin session to untrusted host ${hostname}`);
  if (!loopback && url.port && url.port !== '443') throw new Error('refusing to send admin session to a non-standard production port');
  if (url.username || url.password) throw new Error('refusing a base URL containing embedded credentials');
}

export async function fetchDebugLogSummary(baseUrl, credentials, from, to) {
  const headers = typeof credentials === 'string'
    ? adminSessionHeaders(credentials)
    : usageSummaryAuthHeaders(credentials);
  if (!Object.keys(headers).length) return null;
  if (to - from > DAY_SEC) throw new Error('debug usage summary only supports a maximum 24-hour window');
  assertSafeUsageCredentialUrl(baseUrl);
  const url = new URL('/api/debug/usage-summary', baseUrl);
  url.searchParams.set('from', String(Math.floor(from)));
  url.searchParams.set('to', String(Math.floor(to)));
  url.searchParams.set('hours', String(Math.max(1, Math.min(24, Math.ceil((to - from) / HOUR_SEC)))));
  const body = await fetchJson(url, headers);
  const normalized = normalizeAggregateLogs(body);
  if (!normalized) throw new Error('debug usage summary response is invalid');
  return {
    ...normalized,
    source: 'site:/api/debug/usage-summary',
  };
}

function parseArgs(argv) {
  const options = {};
  const booleanFlags = new Set(['json', 'help']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replaceAll('-', '_');
    if (booleanFlags.has(key)) {
      options[key] = true;
      continue;
    }
    options[key] = argv[index + 1];
    index += 1;
  }
  return options;
}

function usageText() {
  return [
    'NIE-SLA site-only usage model v1.3',
    '',
    'Estimate:',
    '  node agent/scripts/usage-model.mjs [--status-file FILE] [--logs-file FILE]',
    '    [--from ISO] [--to ISO] [--hours 24] [--json]',
    '    [--public-rps 0.42] [--report-sec 300] [--latency-sec 60]',
    '    [--range-mode operational|stress]',
    '',
    'Online inputs:',
    '  Without --status-file, fetches the public /api/status endpoint.',
    '  Prefer NIE_SLA_USAGE_TOKEN (a raw nsu_ read-only token) to fetch /api/debug/usage-summary.',
    '  NIE_SLA_ADMIN_SESSION remains a legacy fallback and must be a raw x-admin-session value.',
    '  The summary endpoint makes one bounded aggregate D1 query; it never paginates raw logs.',
    '',
    'Offline calibration:',
    '  node agent/scripts/usage-model.mjs --fit-calibration PAIRS.json --json',
    '  Add --write-calibration PATH to save the fitted JSON.',
  ].join('\n');
}

function humanRange(value) {
  if (!value) return '—';
  const format = (number) => new Intl.NumberFormat('en-US').format(integer(number));
  return `${format(value.estimate)} (${format(value.low)}–${format(value.high)})`;
}

function printHuman(result) {
  const lines = [
    `NIE-SLA 用量模型 ${result.model_version} · ${result.window.from_iso} → ${result.window.to_iso} UTC`,
    `输入：status=${result.input.status_source}；debug_logs=${result.input.logs_source}；calibration=${result.input.calibration_source}；完整=${result.input.logs_complete ? '是' : '否'}；置信度=${result.observability.confidence}；区间=${result.range_mode === 'stress' ? 'stress 压力' : 'operational 运营'}`,
    `Fleet：目标 ${result.fleet.target_count}（TCP ${result.fleet.tcp_target_count}/HTTP ${result.fleet.http_target_count}），Agent ${result.fleet.agent_count}（在线 ${result.fleet.online_agent_count}，WSS-capable ${result.fleet.wss_capable_agent_count}），Latency ${result.fleet.latency_node_count}，Ping ${result.fleet.ping_target_count}`,
    '',
    '指标                         估计（低–高）',
    `Workers Functions 调用      ${humanRange(result.workers.function_calls)}`,
    `R2 A 类操作                 ${humanRange(result.r2.class_a)}`,
    `R2 B 类操作                 ${humanRange(result.r2.class_b)}`,
    `R2 请求分布                ${humanRange(result.r2.requests_distribution)}`,
    `D1 查询总数                 ${humanRange(result.d1.queries)}`,
    `D1 读取查询                 ${humanRange(result.d1.read_queries)}`,
    `D1 写入查询                 ${humanRange(result.d1.write_queries)}`,
    `D1 已读取行                 ${humanRange(result.d1.rows_read)}`,
    `D1 已写入行                 ${humanRange(result.d1.rows_written)}`,
    '',
    'Workers 主要组件：',
  ];
  for (const item of result.workers.components.filter((event) => event.worker_calls?.estimate > 0)) {
    lines.push(`  ${item.label.padEnd(28, ' ')} ${humanRange(item.worker_calls)} [${item.source}]`);
  }
  lines.push('', '硬边界：公开 status/detail 请求、WSS 重连和 CF dashboard 聚合不在站点公开日志中可完全识别；请把点估计与区间一起对照。');
  console.log(lines.join('\n'));
}

async function loadCalibration(fileName) {
  const calibrationPath = fileName ? path.resolve(fileName) : fileURLToPath(DEFAULT_CALIBRATION_FILE);
  const value = await readJsonFile(calibrationPath);
  return {
    ...clone(DEFAULT_CALIBRATION),
    ...value,
    factors: { ...clone(DEFAULT_CALIBRATION).factors, ...(value?.factors || {}) },
    stress_factors: { ...clone(DEFAULT_CALIBRATION).stress_factors, ...(value?.stress_factors || {}) },
    output_multipliers: { ...clone(DEFAULT_CALIBRATION).output_multipliers, ...(value?.output_multipliers || {}) },
    stress_output_multipliers: {
      ...clone(DEFAULT_CALIBRATION).stress_output_multipliers,
      ...(value?.stress_output_multipliers || {}),
    },
  };
}

async function runCli(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usageText());
    return;
  }
  if (args.fit_calibration) {
    const pairs = await readJsonFile(args.fit_calibration);
    const calibration = fitCalibration(pairs, await loadCalibration(args.calibration_file));
    const serialized = `${JSON.stringify(calibration, null, 2)}\n`;
    if (args.write_calibration) await fs.writeFile(path.resolve(args.write_calibration), serialized, { mode: 0o600 });
    console.log(serialized);
    return;
  }

  const baseUrl = String(args.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const statusFile = args.status_file ? path.resolve(args.status_file) : '';
  const status = statusFile
    ? await readJsonFile(statusFile)
    : await fetchJson(new URL('/api/status?fresh=1&days=1&lite=1', `${baseUrl}/`).toString());
  const end = parseTimestamp(args.to || status?.now) || Math.floor(Date.now() / 1000);
  const start = parseTimestamp(args.from) || end - positiveNumber(args.hours, 24) * HOUR_SEC;
  let logsInput = null;
  let logsSource = 'unavailable';
  if (args.logs_file) {
    logsInput = await readJsonFile(path.resolve(args.logs_file));
    logsSource = `file:${path.basename(args.logs_file)}`;
  } else if (process.env.NIE_SLA_USAGE_TOKEN || process.env.NIE_SLA_ADMIN_SESSION) {
    logsInput = await fetchDebugLogSummary(baseUrl, {
      usageToken: process.env.NIE_SLA_USAGE_TOKEN,
      adminSession: process.env.NIE_SLA_ADMIN_SESSION,
    }, start, end);
    logsSource = logsInput?.source || 'site:/api/debug/usage-summary';
  }
  const logs = logsInput ? normalizeLogs(logsInput, { from: start, to: end }) : { available: false, complete: false, route_counts: {} };
  const calibration = await loadCalibration(args.calibration_file);
  const requestedRangeMode = String(args.range_mode || calibration.range_mode || 'operational').toLowerCase();
  calibration.range_mode = requestedRangeMode === 'stress' ? 'stress' : 'operational';
  const explicitPublicRps = args.public_rps !== undefined;
  const options = {
    reportSec: positiveNumber(args.report_sec, DEFAULT_REPORT_SEC),
    taskSec: positiveNumber(args.task_sec, DEFAULT_TASK_SEC),
    updateSec: positiveNumber(args.update_sec, DEFAULT_UPDATE_SEC),
    pingRefreshSec: positiveNumber(args.ping_refresh_sec, DEFAULT_PING_REFRESH_SEC),
    latencySec: positiveNumber(args.latency_sec, DEFAULT_LATENCY_SEC),
    maxTargetsPerRun: positiveNumber(args.max_targets_per_run, DEFAULT_MAX_TARGETS_PER_RUN),
    credentialTouchSec: positiveNumber(args.credential_touch_sec, DEFAULT_CREDENTIAL_TOUCH_SEC),
    publicRpsExplicit: explicitPublicRps,
    statusSource: statusFile ? `file:${path.basename(statusFile)}` : 'site:/api/status',
    logsSource,
    calibrationSource: args.calibration_file
      ? `file:${path.basename(path.resolve(args.calibration_file))}`
      : 'bundled:scripts/usage-model-calibration.json',
  };
  if (explicitPublicRps) {
    const publicRps = positiveNumber(args.public_rps, DEFAULT_PUBLIC_RPS);
    const factorProfile = calibration.range_mode === 'stress' ? calibration.stress_factors : calibration.factors;
    factorProfile.workers_public_rps = { point: publicRps, low: publicRps, high: publicRps };
  }
  const result = estimateUsage({ status, logs, from: start, to: end, options, calibration });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runCli(process.argv.slice(2)).catch((error) => {
  console.error(`usage model failed: ${String(error?.message || error)}`);
  process.exitCode = 1;
});
