import { nowSec } from '../utils.js';
import { estimateCapacity, usageInputsFromEnv, MODEL_VERSION } from './usage-model.js';

// Fixed allowlist so the admin endpoint cannot be pointed at arbitrary tables
// and so the per-request D1 query count stays bounded on the free plan.
export const D1_STORAGE_TABLES = Object.freeze([
  'targets',
  'latest_status',
  'check_buckets',
  'check_bucket_days',
  'checks',
  'nodes',
  'incident_events',
  'app_meta',
  'rate_limits',
  'agent_metrics_state',
  'agent_metrics_history',
  'agent_daily_availability',
  'agent_traffic_monthly',
  'agent_traffic_daily',
  'ping_targets',
  'ping_history',
  'proxy_targets',
  'proxy_target_secrets',
  'latency_agents',
  'latency_results',
  'agent_credentials',
  'agent_install_tickets',
  'debug_logs',
  'alert_state',
]);

const R2_LIST_LIMIT = 10_000;
const R2_PAGE_SIZE = 1_000;

export async function getStorageUsage(env) {
  const [d1, r2] = await Promise.all([readD1Storage(env), readR2Storage(env)]);
  let capacity = null;
  let capacityError = '';
  try {
    capacity = estimateCapacity(await usageInputsFromEnv(env));
  } catch (error) {
    capacityError = String(error?.message || error);
  }
  return {
    ok: true,
    model_version: MODEL_VERSION,
    d1,
    r2,
    capacity,
    ...(capacityError ? { capacity_error: capacityError } : {}),
    generated_at: nowSec(),
  };
}

async function readD1Storage(env) {
  if (!env.DB) {
    return { available: false, error: '缺少 D1 的 DB 绑定', tables: [], table_count: 0, total_rows: 0, errors: [] };
  }
  const errors = [];
  let present = null;
  try {
    const rows = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all();
    present = new Set((rows?.results || []).map((row) => String(row?.name || '')));
  } catch (error) {
    errors.push(`读取表列表失败：${String(error?.message || error)}`);
  }
  const tables = [];
  for (const table of D1_STORAGE_TABLES) {
    if (present && !present.has(table)) continue;
    try {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first();
      tables.push({ table, rows: Number(Object.values(row || {})[0] || 0) });
    } catch (error) {
      tables.push({ table, rows: null });
      errors.push(`${table}: ${String(error?.message || error)}`);
    }
  }
  const totalRows = tables.reduce((sum, item) => sum + (Number(item.rows) || 0), 0);
  const pageCount = await pragmaNumber(env, 'PRAGMA page_count');
  const pageSize = await pragmaNumber(env, 'PRAGMA page_size');
  const databaseBytes = pageCount > 0 && pageSize > 0 ? pageCount * pageSize : null;
  return {
    available: true,
    tables: tables.slice().sort((a, b) => (Number(b.rows) || 0) - (Number(a.rows) || 0)),
    table_count: tables.length,
    total_rows: totalRows,
    page_count: pageCount || null,
    page_size: pageSize || null,
    database_bytes: databaseBytes,
    database_size_available: databaseBytes != null,
    errors,
  };
}

async function pragmaNumber(env, sql) {
  try {
    const row = await env.DB.prepare(sql).first();
    return Number(Object.values(row || {})[0] || 0);
  } catch (_) {
    return 0;
  }
}

async function readR2Storage(env) {
  const bucket = env.ARCHIVE;
  if (!bucket || typeof bucket.list !== 'function') {
    return { available: false, error: '缺少 R2 的 ARCHIVE 绑定', objects: 0, bytes: 0, truncated: false, list_limit: R2_LIST_LIMIT };
  }
  let cursor;
  let objects = 0;
  let bytes = 0;
  let truncated = false;
  let error = '';
  try {
    while (true) {
      const page = await bucket.list({ cursor, limit: R2_PAGE_SIZE });
      for (const item of page?.objects || []) {
        objects += 1;
        bytes += Math.max(0, Number(item?.size || 0));
      }
      if (!page?.truncated || !page?.cursor) break;
      if (objects >= R2_LIST_LIMIT) {
        truncated = true;
        break;
      }
      cursor = page.cursor;
    }
  } catch (err) {
    error = String(err?.message || err);
  }
  return {
    available: true,
    objects,
    bytes,
    truncated: truncated || objects >= R2_LIST_LIMIT,
    list_limit: R2_LIST_LIMIT,
    ...(error ? { error } : {}),
  };
}
