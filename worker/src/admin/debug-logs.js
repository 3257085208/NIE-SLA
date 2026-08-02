// Admin sub-module: sanitized debug operation logs with 30-day retention.
import { clamp } from '../utils.js';
import { ensureV6Schema } from './schema.js';

const LOG_LEVEL = 'debug';
const RETENTION_DAYS = 30;
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

export function shouldLogDebugOperation(path, method) {
  if (path === '/api/debug/logs') return false;
  const upper = String(method || 'GET').toUpperCase();
  return DEBUG_ROUTES.some(route => route.match.test(path)
    && (!route.methods || route.methods.includes(upper)));
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
