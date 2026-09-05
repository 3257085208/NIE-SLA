
import { clamp } from '../utils.js';
import { ensureV6Schema } from './schema.js';

const LOG_LEVEL = 'debug';
const RETENTION_DAYS = 30;
const SUMMARY_MAX_HOURS = 24;
const SUMMARY_GROUP_LIMIT = 512;
const DEBUG_ROUTE_BUCKETS = [
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
];

// Keep this expression deliberately independent of user input.  It converts
// dynamic target/task paths into a small, bounded set before aggregation, so
// the diagnostic endpoint cannot return one row per ID or expose log details.
const DEBUG_ROUTE_CASE_SQL = `CASE
    WHEN path = '/api/agent/tasks' AND method = 'GET' THEN 'agent_tasks'
    WHEN path LIKE '/api/agent/tasks/%' THEN 'agent_task_action'
    WHEN path = '/api/agent/update-policy' THEN 'agent_update_policy'
    WHEN path = '/api/agent/config' THEN 'agent_config'
    WHEN path = '/api/agent/location' THEN 'agent_location'
    WHEN path = '/api/agent/ping-targets' THEN 'agent_ping_targets'
    WHEN path = '/api/latency-agent/update-policy' THEN 'latency_update_policy'
    WHEN path = '/api/latency-agent/targets' THEN 'latency_targets'
    WHEN path = '/api/latency-agent/results' THEN 'latency_results'
    WHEN path = '/api/agent-tasks' OR path LIKE '/api/agent-tasks/%' THEN 'admin_agent_tasks'
    ELSE 'other_debug'
  END`;
const DEBUG_ROUTES = [
  { match: /^\/api\/auth\/login$/, methods: ['POST'], summary: '管理员登录' },
  { match: /^\/api\/auth\/account$/, summary: '管理员账号' },
  { match: /^\/api\/auth\/github\//, summary: 'GitHub 登录' },
  { match: /^\/api\/totp\//, summary: 'TOTP 操作' },
  { match: /^\/api\/settings(?:\/|$)/, summary: '公开设置' },
  { match: /^\/api\/alerts\//, summary: '报警设置' },
  { match: /^\/api\/system\//, summary: '系统更新' },
  { match: /^\/api\/security\//, summary: '安全密钥' },
  { match: /^\/api\/agent-tasks(?:\/|$)/, summary: 'Agent 任务' },
  { match: /^\/api\/backup\//, summary: '备份恢复' },
  { match: /^\/api\/maintenance\//, summary: '维护清理' },
  { match: /^\/api\/themes(?:\/|$)/, summary: '主题管理' },
  { match: /^\/api\/targets(?:\/|$)/, summary: '探针配置' },
  { match: /^\/api\/sync-targets$/, summary: '探针同步' },
  { match: /^\/api\/ping-targets(?:\/|$)/, summary: 'Ping 探针' },
  { match: /^\/api\/ping-config$/, summary: 'Ping 配置' },
  { match: /^\/api\/latency-agents(?:\/|$)/, summary: 'Latency 节点' },
  { match: /^\/api\/probe-now$/, summary: '手动探测' },
  { match: /^\/api\/archive$/, summary: '手动归档' },
  { match: /^\/api\/stats$/, summary: '统计查询' },
  { match: /^\/api\/debug-colo$/, summary: '调试查询' },
  { match: /^\/api\/debug\/latency-health$/, summary: '调试查询' },
  { match: /^\/api\/agent\/install-script$/, summary: 'Agent 安装脚本' },
  { match: /^\/api\/latency-agent\/install-script$/, summary: 'Latency 安装脚本' },
  { match: /^\/api\/agent\/config$/, summary: 'Agent 配置' },
  { match: /^\/api\/agent\/location$/, summary: 'Agent 地理位置' },
  { match: /^\/api\/agent\/tasks(?:\/|$)/, summary: 'Agent 任务' },
  { match: /^\/api\/latency-agent\/update-policy$/, summary: 'Latency 更新策略' },
];

function cleanText(value, max, fallback = '') {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : fallback;
}

function cleanPath(value, max = 200) {
  const path = String(value ?? '').split(/[?#]/)[0];
  return cleanText(path, max, '/') || '/';
}

function boundedParam(url, name, fallback, min, max) {
  const value = Number(url?.searchParams?.get(name) ?? fallback);
  return Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function parseTimestamp(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const number = Number(raw);
    if (!Number.isFinite(number)) return 0;
    return Math.floor(number > 1e12 ? number / 1000 : number);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function summaryWindow(url) {
  const now = Math.floor(Date.now() / 1000);
  const requestedTo = parseTimestamp(url?.searchParams?.get('to'));
  const to = requestedTo > 0 ? Math.min(requestedTo, now) : now;
  const requestedFrom = parseTimestamp(url?.searchParams?.get('from'));
  const requestedHours = boundedParam(url, 'hours', SUMMARY_MAX_HOURS, 1, SUMMARY_MAX_HOURS);
  const maxFrom = Math.max(0, to - SUMMARY_MAX_HOURS * 3600);
  let from = requestedFrom > 0 ? requestedFrom : to - requestedHours * 3600;
  const clampedFrom = from < maxFrom;
  const invalidOrder = from >= to;
  if (clampedFrom) from = maxFrom;
  if (invalidOrder) from = Math.max(0, to - 1);
  return {
    from,
    to,
    hours: (to - from) / 3600,
    clamped_to_now: requestedTo > now,
    clamped_window: clampedFrom || invalidOrder,
  };
}

function integerCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

// 调试日志只保留两类（用户定义的范围）：
//  1. 登录与账号安全（/api/auth/*、/api/totp/*，成功与失败都记录）
//  2. Agent 任务失败详情（/api/agent/tasks 的失败完成或错误）
// 其余操作（Agent 轮询、配置读取、管理列表等）不再写 debug_logs。
export function shouldLogDebugOperation(path, method, failed = false) {
  if (path === '/api/debug/logs') return false;
  if (path === '/api/auth/' || path.startsWith('/api/auth/') || path.startsWith('/api/totp/')) return true;
  if (failed !== true) return false;
  const upper = String(method || 'GET').toUpperCase();
  return path === '/api/agent/tasks' || path.startsWith('/api/agent/tasks/')
    ? DEBUG_ROUTES.some(route => route.match.test(path)
      && (!route.methods || route.methods.includes(upper)))
    : false;
}

export function debugSummary(path, method) {
  const upper = String(method || 'GET').toUpperCase();
  const route = DEBUG_ROUTES.find(item => item.match.test(path)
    && (!item.methods || item.methods.includes(upper)));
  return route?.summary || '管理操作';
}

export function debugClientIp(request) {
  if (!request) return 'unknown';
  const ip = request.headers?.get?.('cf-connecting-ip')
    || request.headers?.get?.('x-real-ip');
  return cleanText(ip, 80, 'unknown');
}

export function sanitizeDebugLogEntry(entry = {}) {
  const now = Math.floor(Date.now() / 1000);
  const rawTs = Number(entry?.ts || now);
  const id = String(entry?.id || globalThis.crypto?.randomUUID?.() || `d${now}-${Math.random().toString(36).slice(2, 12)}`);
  return {
    id: cleanText(id, 80, `d${now}-${Math.random().toString(36).slice(2, 12)}`),
    ts: Number.isFinite(rawTs) ? clamp(Math.floor(rawTs), 0, now + 300) : now,
    level: LOG_LEVEL,
    ip: cleanText(entry?.ip, 80, 'unknown'),
    method: cleanText(entry?.method, 12, '').toUpperCase(),
    path: cleanPath(entry?.path, 200),
    actor: cleanText(entry?.actor, 120),
    summary: cleanText(entry?.summary, 300),
    status: Number.isInteger(Number(entry?.status)) ? clamp(Number(entry.status), 100, 599) : 0,
    ref: cleanText(entry?.ref, 120),
  };
}

export async function recordDebugLog(env, entry) {
  if (!env?.DB) return null;
  const clean = sanitizeDebugLogEntry(entry);
  const sql = `INSERT INTO debug_logs (id, ts, level, ip, method, path, actor, summary, status, ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const values = [clean.id, clean.ts, clean.level, clean.ip, clean.method, clean.path, clean.actor, clean.summary, clean.status, clean.ref];
  try {
    await env.DB.prepare(sql).bind(...values).run();
    return clean.id;
  } catch (error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (!message.includes('no such table')) {
      console.error('debug log write failed:', String(error?.message || error));
      return null;
    }
    try {
      await ensureV6Schema(env);
      await env.DB.prepare(sql).bind(...values).run();
      return clean.id;
    } catch (retryError) {
      console.error('debug log schema retry failed:', String(retryError?.message || retryError));
      return null;
    }
  }
}

export async function listDebugLogs(env, url = new URL('https://status.example/api/debug/logs')) {
  if (!env?.DB) return { ok: true, logs: [], total: 0, limit: 200, offset: 0 };
  const limit = boundedParam(url, 'limit', 200, 1, 500);
  const offset = boundedParam(url, 'offset', 0, 0, 10000);
  const actor = cleanText(url?.searchParams?.get('actor'), 120);
  const where = actor ? 'WHERE actor = ?' : '';
  const rowsResult = await env.DB.prepare(`SELECT id, ts, level, ip, method, path, actor, summary, status, ref
    FROM debug_logs ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...(actor ? [actor, limit, offset] : [limit, offset]))
    .all()
    .catch(() => ({ results: [] }));
  const rows = Array.isArray(rowsResult) ? rowsResult : (rowsResult?.results || []);
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM debug_logs ${where}`)
    .bind(...(actor ? [actor] : []))
    .first()
    .catch(() => ({ total: 0 }));
  return {
    ok: true,
    logs: rows,
    total: Number(countRow?.total || 0),
    limit,
    offset,
  };
}

export async function getDebugLogSummary(env, url = new URL('https://status.example/api/debug/usage-summary')) {
  const window = summaryWindow(url);
  const routeCounts = Object.fromEntries(DEBUG_ROUTE_BUCKETS.map((route) => [route, 0]));
  const empty = {
    ok: true,
    schema: 'nie-sla-debug-summary-v1',
    source: 'debug_logs',
    available: Boolean(env?.DB),
    window: {
      from: window.from,
      to: window.to,
      from_iso: new Date(window.from * 1000).toISOString(),
      to_iso: new Date(window.to * 1000).toISOString(),
      hours: Number(window.hours.toFixed(3)),
      clamped_to_now: window.clamped_to_now,
      clamped_window: window.clamped_window,
      timezone: 'UTC',
    },
    total: 0,
    route_counts: routeCounts,
    status_counts: {},
    method_counts: {},
    groups: [],
    complete: Boolean(env?.DB),
    truncated: false,
    query: {
      statements: 0,
      raw_rows_returned: 0,
      aggregate_rows_returned: 0,
      max_hours: SUMMARY_MAX_HOURS,
      max_groups: SUMMARY_GROUP_LIMIT,
      mode: 'bounded_aggregate',
      time_index: 'idx_debug_logs_ts',
    },
  };
  if (!env?.DB) return empty;

  const result = await env.DB.prepare(`
    SELECT ${DEBUG_ROUTE_CASE_SQL} AS route, method, status, COUNT(*) AS total
    FROM debug_logs
    WHERE ts >= ? AND ts < ?
    GROUP BY route, method, status
    ORDER BY total DESC, route ASC, method ASC, status ASC
    LIMIT ?`)
    .bind(window.from, window.to, SUMMARY_GROUP_LIMIT)
    .all();
  const rows = Array.isArray(result) ? result : (result?.results || []);
  const statusCounts = {};
  const methodCounts = {};
  const groups = [];
  let total = 0;
  for (const row of rows) {
    const route = DEBUG_ROUTE_BUCKETS.includes(String(row?.route || '')) ? String(row.route) : 'other_debug';
    const method = cleanText(row?.method, 12, '');
    const status = integerCount(row?.status);
    const count = integerCount(row?.total);
    if (!count) continue;
    routeCounts[route] += count;
    const statusKey = String(status || 0);
    statusCounts[statusKey] = integerCount(statusCounts[statusKey]) + count;
    const methodKey = method || 'UNKNOWN';
    methodCounts[methodKey] = integerCount(methodCounts[methodKey]) + count;
    total += count;
    groups.push({ route, method, status, count });
  }
  const truncated = rows.length >= SUMMARY_GROUP_LIMIT;
  return {
    ...empty,
    available: true,
    total,
    route_counts: routeCounts,
    status_counts: statusCounts,
    method_counts: methodCounts,
    groups,
    complete: !truncated,
    truncated,
    query: {
      ...empty.query,
      statements: 1,
      aggregate_rows_returned: groups.length,
    },
  };
}

export async function cleanupDebugLogs(env, retentionDays = RETENTION_DAYS) {
  if (!env?.DB) return { ok: true, skipped: true };
  const days = Number.isFinite(Number(retentionDays)) ? clamp(Number(retentionDays), 1, 365) : RETENTION_DAYS;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const result = await env.DB.prepare(`DELETE FROM debug_logs WHERE ts < ?`)
    .bind(cutoff)
    .run()
    .catch(error => {
      console.error('debug log cleanup failed:', String(error?.message || error));
      return { meta: { changes: 0 } };
    });
  return {
    ok: true,
    deleted: Number(result?.meta?.changes || 0),
    retention_days: days,
    cutoff,
  };
}
