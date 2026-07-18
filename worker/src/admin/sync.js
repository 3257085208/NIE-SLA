// Admin sub-module: target sync from TARGETS_JSON env.
import { nowSec, parseBoolean, normalizeTarget, stableTargetId, sha256Hex } from '../utils.js';
import { normalizeTrafficMode, normalizeTrafficQuotaGb } from '../traffic.js';
import { getMeta, setMeta, hasOwn } from './settings.js';

export async function syncEnvTargetsMaybe(env) {
  const every = 3600;
  const last = Number(await getMeta(env, 'targets_last_sync_at') || 0);
  if (!last || last <= nowSec() - every) return syncEnvTargets(env, { force: false });
  return { ok: true, source: 'cache', last_sync_at: last };
}

export async function syncEnvTargets(env, opts = {}) {
  if (!env.TARGETS_JSON || !env.DB) return { ok: true, source: 'db', count: 0 };
  let parsed;
  try { parsed = JSON.parse(env.TARGETS_JSON); } catch (err) { throw new Error(`TARGETS_JSON 解析失败：${String(err?.message || err)}`); }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.targets) ? parsed.targets : null;
  if (!list) throw new Error('TARGETS_JSON 必须是数组，或包含 targets 数组的对象');
  const signature = await sha256Hex(JSON.stringify(list));
  const previousSignature = opts.force ? null : await getMeta(env, 'targets_last_sync_hash');
  if (!opts.force && previousSignature === signature) { await setMeta(env, 'targets_last_sync_at', String(nowSec())); return { ok: true, source: 'env', count: list.length, unchanged: true }; }
  const now = nowSec();
  const ids = [];
  const normalizedItems = [];
  const seenIds = new Set();
  for (const item of list) {
    const normalized = normalizeTarget(item);
    const id = stableTargetId(item, normalized);
    if (seenIds.has(id)) throw new Error(`TARGETS_JSON 中存在重复的目标 ID：${id}`);
    const hasTrafficEnabled = hasOwn(item, 'traffic_enabled');
    const hasTrafficQuota = hasOwn(item, 'traffic_quota_gb');
    const hasTrafficMode = hasOwn(item, 'traffic_mode');
    seenIds.add(id); ids.push(id); normalizedItems.push({
      id, normalized,
      hasTrafficEnabled, trafficEnabled: hasTrafficEnabled ? (parseBoolean(item.traffic_enabled, false) ? 1 : 0) : 0,
      hasTrafficQuota, trafficQuotaGb: hasTrafficQuota ? normalizeTrafficQuotaGb(item.traffic_quota_gb) : 0,
      hasTrafficMode, trafficMode: hasTrafficMode ? normalizeTrafficMode(item.traffic_mode) : 'total',
    });
  }
  for (const { id, normalized, hasTrafficEnabled, trafficEnabled, hasTrafficQuota, trafficQuotaGb, hasTrafficMode, trafficMode } of normalizedItems) {
    await env.DB.prepare(`INSERT INTO targets (id, name, group_name, type, target_host, target_port, url, method, expected_status, timeout_ms, interval_sec, probe_region, enabled, created_at, updated_at, traffic_enabled, traffic_quota_gb, traffic_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, group_name = excluded.group_name, type = excluded.type, target_host = excluded.target_host, target_port = excluded.target_port, url = excluded.url, method = excluded.method, expected_status = excluded.expected_status, timeout_ms = excluded.timeout_ms, interval_sec = excluded.interval_sec, probe_region = excluded.probe_region, enabled = excluded.enabled, updated_at = excluded.updated_at, traffic_enabled = CASE WHEN ? THEN excluded.traffic_enabled ELSE traffic_enabled END, traffic_quota_gb = CASE WHEN ? THEN excluded.traffic_quota_gb ELSE traffic_quota_gb END, traffic_mode = CASE WHEN ? THEN excluded.traffic_mode ELSE traffic_mode END`).bind(id, normalized.name, normalized.group_name, normalized.type, normalized.target_host, normalized.target_port, normalized.url, normalized.method, normalized.expected_status, normalized.timeout_ms, normalized.interval_sec, normalized.probe_region, normalized.enabled ? 1 : 0, now, now, trafficEnabled, trafficQuotaGb, trafficMode, hasTrafficEnabled ? 1 : 0, hasTrafficQuota ? 1 : 0, hasTrafficMode ? 1 : 0).run();
  }
  if (['1', 'true', 'yes', 'replace'].includes(String(env.TARGETS_REPLACE || '').toLowerCase())) {
    if (ids.length) { const marks = ids.map(() => '?').join(','); await env.DB.prepare(`UPDATE targets SET enabled = 0, updated_at = ? WHERE id NOT IN (${marks})`).bind(now, ...ids).run(); }
    else await env.DB.prepare(`UPDATE targets SET enabled = 0, updated_at = ?`).bind(now).run();
  }
  await setMeta(env, 'targets_last_sync_at', String(now));
  await setMeta(env, 'targets_last_sync_count', String(ids.length));
  await setMeta(env, 'targets_last_sync_hash', signature);
  return { ok: true, source: 'env', count: ids.length, forced: Boolean(opts.force) };
}
