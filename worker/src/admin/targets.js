// Admin sub-module: target CRUD, probes, and agent target listing.
import { clamp, nowSec, sanitizeId, sanitizeAgentId, parseBoolean, normalizeTarget, parseExpectedStatus, REGION_LABELS, DEFAULT_TIMEOUT_MS, DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC } from '../utils.js';
import { normalizeTrafficMode, normalizeTrafficQuotaGb, summarizeTraffic, trafficSettingsFromTarget } from '../traffic.js';
import { safeJson } from '../auth.js';
import { removeTargetFromR2State } from '../storage.js';
import { runTargetBatch } from '../probe.js';
import { deleteAgentTelemetry } from '../metrics.js';
import { ensureV6Schema } from './schema.js';
import { setMeta } from './settings.js';
import { syncEnvTargetsMaybe, syncEnvTargets } from './sync.js';
import { normalizeTargetOrder } from './target-order.js';
import { convertPriceToCny, getExchangeRates, normalizeCurrency } from './settings.js';

const TARGET_ORDER_SQL = `CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order, group_name COLLATE NOCASE, name COLLATE NOCASE`;

function normalizeExpiresAt(value, env) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return dayStartSec(s, env);
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function normalizePrice(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

function normalizeNullableNumber(value, max = 1000000) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(Math.min(n, max) * 100) / 100;
}

function dayStartSec(dayStr, env) {
  const tzOffset = (Number(env?.TIMEZONE_OFFSET_MINUTES ?? 480) || 0) * 60;
  return Math.floor(new Date(`${dayStr}T00:00:00.000Z`).getTime() / 1000) - tzOffset;
}

// ── Target CRUD ──────────────────────────────────────────────────────────────

export async function listTargets(env) {
  await syncEnvTargetsMaybe(env);
  const rows = await env.DB.prepare(`SELECT * FROM targets ORDER BY ${TARGET_ORDER_SQL}`).all();
  const trafficRows = {};
  try {
    const result = await env.DB.prepare(`SELECT * FROM agent_traffic_monthly`).all();
    for (const row of result.results || []) trafficRows[`${sanitizeAgentId(row.agent_id)}|${row.month}`] = row;
  } catch (_) {}
  const rates = await getExchangeRates(env);
  const targets = (rows.results || []).map((target) => {
    const settings = trafficSettingsFromTarget(target, env);
    const priceCny = convertPriceToCny(target.price, target.currency, rates);
    return {
      ...target,
      ...(priceCny == null ? {} : { price_cny: priceCny }),
      traffic: summarizeTraffic(trafficRows[`${sanitizeAgentId(target.id)}|${settings.month}`], settings),
    };
  });
  return { ok: true, targets, regions: REGION_LABELS };
}

export async function createTarget(request, env) {
  const body = await safeJson(request);
  const customId = String(body?.id || '').trim();
  const id = customId ? sanitizeId(customId) : crypto.randomUUID();
  const normalized = normalizeTarget(body);
  const now = nowSec();
  const expiresAt = normalizeExpiresAt(body?.expires_at, env);
  const price = normalizePrice(body?.price);
  const billingCycle = String(body?.billing_cycle || '').trim() || null;
  const tags = String(body?.tags || '').trim() || null;
  const location = String(body?.location || '').trim() || null;
  const provider = String(body?.provider || '').trim() || null;
  const lineType = String(body?.line_type || '').trim() || null;
  const currency = normalizeCurrency(body?.currency, 'USD');
  const trafficEnabled = parseBoolean(body?.traffic_enabled, false) ? 1 : 0;
  const trafficQuotaGb = normalizeTrafficQuotaGb(body?.traffic_quota_gb ?? 0);
  const trafficMode = normalizeTrafficMode(body?.traffic_mode);
  const alertEnabled = body?.alert_enabled === undefined ? 1 : (parseBoolean(body.alert_enabled, true) ? 1 : 0);
  const alertExpiryDays = normalizeNullableNumber(body?.alert_expiry_days, 3650);
  const alertTrafficPercent = normalizeNullableNumber(body?.alert_traffic_remaining_percent, 100);
  const alertTrafficGb = normalizeNullableNumber(body?.alert_traffic_remaining_gb, 1048576);
  const maxSort = await env.DB.prepare(`SELECT MAX(sort_order) AS value FROM targets`).first().catch(() => null);
  const sortOrder = maxSort?.value == null ? null : Number(maxSort.value) + 1;
  await env.DB.prepare(`INSERT INTO targets (id, name, group_name, type, target_host, target_port, url, method, expected_status, timeout_ms, interval_sec, probe_region, enabled, sort_order, created_at, updated_at, expires_at, price, billing_cycle, tags, location, currency, traffic_enabled, traffic_quota_gb, traffic_mode, alert_enabled, alert_expiry_days, alert_traffic_remaining_percent, alert_traffic_remaining_gb, provider, line_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, normalized.name, normalized.group_name, normalized.type, normalized.target_host, normalized.target_port, normalized.url, normalized.method, normalized.expected_status, normalized.timeout_ms, normalized.interval_sec, normalized.probe_region, normalized.enabled ? 1 : 0, sortOrder, now, now, expiresAt, price, billingCycle, tags, location, currency, trafficEnabled, trafficQuotaGb, trafficMode, alertEnabled, alertExpiryDays, alertTrafficPercent, alertTrafficGb, provider, lineType).run();
  await setMeta(env, 'targets_last_sync_at', String(now));
  return { ok: true, id };
}

export async function updateTarget(id, request, env) {
  const existing = await env.DB.prepare(`SELECT * FROM targets WHERE id = ?`).bind(id).first();
  if (!existing) return { ok: false, error: 'Target not found' };
  const body = await safeJson(request);
  const merged = normalizeTarget({ ...existing, ...body }, true);
  const now = nowSec();
  const expiresAt = body?.expires_at !== undefined ? normalizeExpiresAt(body.expires_at, env) : (existing.expires_at ?? null);
  const price = body?.price !== undefined ? normalizePrice(body.price) : (existing.price ?? null);
  const billingCycle = body?.billing_cycle !== undefined ? (String(body.billing_cycle || '').trim() || null) : (existing.billing_cycle ?? null);
  const tags = body?.tags !== undefined ? (String(body.tags || '').trim() || null) : (existing.tags ?? null);
  const location = body?.location !== undefined ? (String(body.location || '').trim() || null) : (existing.location ?? null);
  const provider = body?.provider !== undefined ? (String(body.provider || '').trim() || null) : (existing.provider ?? null);
  const lineType = body?.line_type !== undefined ? (String(body.line_type || '').trim() || null) : (existing.line_type ?? null);
  const currency = body?.currency !== undefined ? normalizeCurrency(body.currency, 'USD') : normalizeCurrency(existing.currency, 'USD');
  const trafficEnabled = body?.traffic_enabled !== undefined ? (parseBoolean(body.traffic_enabled, false) ? 1 : 0) : (parseBoolean(existing.traffic_enabled, false) ? 1 : 0);
  const trafficQuotaGb = body?.traffic_quota_gb !== undefined ? normalizeTrafficQuotaGb(body.traffic_quota_gb) : normalizeTrafficQuotaGb(existing.traffic_quota_gb ?? 0);
  const trafficMode = body?.traffic_mode !== undefined ? normalizeTrafficMode(body.traffic_mode) : normalizeTrafficMode(existing.traffic_mode);
  const alertEnabled = body?.alert_enabled !== undefined ? (parseBoolean(body.alert_enabled, true) ? 1 : 0) : (existing.alert_enabled == null ? 1 : (parseBoolean(existing.alert_enabled, true) ? 1 : 0));
  const alertExpiryDays = body?.alert_expiry_days !== undefined ? normalizeNullableNumber(body.alert_expiry_days, 3650) : (existing.alert_expiry_days ?? null);
  const alertTrafficPercent = body?.alert_traffic_remaining_percent !== undefined ? normalizeNullableNumber(body.alert_traffic_remaining_percent, 100) : (existing.alert_traffic_remaining_percent ?? null);
  const alertTrafficGb = body?.alert_traffic_remaining_gb !== undefined ? normalizeNullableNumber(body.alert_traffic_remaining_gb, 1048576) : (existing.alert_traffic_remaining_gb ?? null);
  await env.DB.prepare(`UPDATE targets SET name = ?, group_name = ?, type = ?, target_host = ?, target_port = ?, url = ?, method = ?, expected_status = ?, timeout_ms = ?, interval_sec = ?, probe_region = ?, enabled = ?, updated_at = ?, expires_at = ?, price = ?, billing_cycle = ?, tags = ?, location = ?, currency = ?, traffic_enabled = ?, traffic_quota_gb = ?, traffic_mode = ?, alert_enabled = ?, alert_expiry_days = ?, alert_traffic_remaining_percent = ?, alert_traffic_remaining_gb = ?, provider = ?, line_type = ? WHERE id = ?`).bind(merged.name, merged.group_name, merged.type, merged.target_host, merged.target_port, merged.url, merged.method, merged.expected_status, merged.timeout_ms, merged.interval_sec, merged.probe_region, merged.enabled ? 1 : 0, now, expiresAt, price, billingCycle, tags, location, currency, trafficEnabled, trafficQuotaGb, trafficMode, alertEnabled, alertExpiryDays, alertTrafficPercent, alertTrafficGb, provider, lineType, id).run();
  await setMeta(env, 'targets_last_sync_at', String(now));
  return { ok: true, id };
}

export async function reorderTargets(request, env) {
  const body = await safeJson(request);
  const rows = await env.DB.prepare(`SELECT id FROM targets ORDER BY ${TARGET_ORDER_SQL}`).all();
  const existingIds = (rows.results || []).map(row => String(row.id));
  const normalized = normalizeTargetOrder(body?.ids, existingIds);
  if (!normalized.ok) return normalized;
  const orderedIds = normalized.ids;
  for (let offset = 0; offset < orderedIds.length; offset += 50) {
    const batch = orderedIds.slice(offset, offset + 50).map((id, index) =>
      env.DB.prepare(`UPDATE targets SET sort_order = ? WHERE id = ?`).bind(offset + index, id));
    if (batch.length) await env.DB.batch(batch);
  }
  await setMeta(env, 'targets_last_sync_at', String(nowSec()));
  return { ok: true, ids: orderedIds, count: orderedIds.length };
}

export async function deleteTarget(id, env) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM check_buckets WHERE target_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM latest_status WHERE target_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM incident_events WHERE target_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM alert_state WHERE target_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM targets WHERE id = ?`).bind(id),
  ]);
  await removeTargetFromR2State(env, id);
  const telemetry = await deleteAgentTelemetry(env, id);
  await setMeta(env, 'targets_last_sync_at', String(nowSec()));
  return { ok: true, id, telemetry };
}

// ── Probe now (admin) ────────────────────────────────────────────────────────

export async function probeNow(env, id) {
  if (parseBoolean(env.AUTO_SYNC_TARGETS ?? false, false)) await syncEnvTargets(env, { force: true });
  const rows = id
    ? await env.DB.prepare(`SELECT * FROM targets WHERE id = ? AND enabled = 1`).bind(id).all()
    : await env.DB.prepare(`SELECT * FROM targets WHERE enabled = 1 ORDER BY group_name, name`).all();
  const targets = rows.results || [];
  return { ok: true, count: targets.length, results: await runTargetBatch(env, targets) };
}

// ── Agent targets ───────────────────────────────────────────────────────────

export async function getAgentTargets(env, url) {
  if (parseBoolean(env.ENSURE_SCHEMA_ON_READ ?? false, false)) await ensureV6Schema(env);
  const agentId = sanitizeAgentId(url.searchParams.get('agent_id') || env.DEFAULT_AGENT_ID || 'external-agent');
  const group = String(url.searchParams.get('group') || '').trim();
  const rows = await env.DB.prepare(`SELECT id, name, group_name, type, target_host, target_port, url, method, expected_status, timeout_ms, interval_sec, probe_region, enabled FROM targets WHERE enabled = 1 ORDER BY group_name COLLATE NOCASE, name COLLATE NOCASE`).all();
  const targets = (rows.results || []).filter(row => !group || String(row.group_name || '') === group).map(row => ({
    id: row.id, name: row.name, group_name: row.group_name, type: row.type, target_host: row.target_host,
    target_port: row.target_port == null ? null : Number(row.target_port), url: row.url, method: row.method || 'GET',
    expected_status: parseExpectedStatus(row.expected_status), timeout_ms: clamp(Number(row.timeout_ms || DEFAULT_TIMEOUT_MS), 500, 30000),
    interval_sec: clamp(Number(row.interval_sec || DEFAULT_INTERVAL_SEC), MIN_INTERVAL_SEC, 86400),
  }));
  return { ok: true, agent_id: agentId, interval_sec: clamp(Number(env.AGENT_INTERVAL_SEC || DEFAULT_INTERVAL_SEC), MIN_INTERVAL_SEC, 86400), generated_at: new Date().toISOString(), targets };
}

