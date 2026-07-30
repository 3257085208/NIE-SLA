// Admin sub-module: target CRUD, probes, and agent target listing.
import { clamp, nowSec, sanitizeId, sanitizeAgentId, parseBoolean, normalizeTarget, parseExpectedStatus, REGION_LABELS, DEFAULT_TIMEOUT_MS, DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC } from '../utils.js';
import { normalizeTrafficMode, normalizeTrafficQuotaGb, normalizeTrafficResetDay, summarizeTrafficWithPending, trafficSettingsFromTarget } from '../traffic.js';
import { safeJson } from '../auth.js';
import { removeTargetFromR2State } from '../storage.js';
import { runTargetBatch } from '../probe.js';
import { deleteAgentTelemetry, rebuildAgentTrafficPeriod } from '../metrics.js';
import { ensureV6Schema, isMissingAgentCapabilitiesColumn } from './schema.js';
import { setMeta } from './settings.js';
import { syncEnvTargetsMaybe, syncEnvTargets } from './sync.js';
import { normalizeTargetOrder } from './target-order.js';
import { convertPriceToCny, getExchangeRates, normalizeCurrency } from './settings.js';
import { normalizeNodeQualityReport, normalizeNodeQualityReportUrl, publicNodeQualitySummary } from '../nodequality.js';
import { applyBulkTargetColumns, normalizeBulkTargetUpdate } from './target-bulk.js';

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
  const rows = await env.DB.prepare(`SELECT t.*, COALESCE(s.checked_at, t.last_checked_at) AS last_checked_at
    FROM targets t LEFT JOIN latest_status s ON s.target_id = t.id
    ORDER BY CASE WHEN t.sort_order IS NULL THEN 1 ELSE 0 END, t.sort_order, t.group_name COLLATE NOCASE, t.name COLLATE NOCASE`).all();
  const trafficRows = {};
  const agentStates = {};
  const agentTrafficStates = {};
  try {
    const result = await env.DB.prepare(`SELECT * FROM agent_traffic_monthly`).all();
    for (const row of result.results || []) trafficRows[`${sanitizeAgentId(row.agent_id)}|${row.month}`] = row;
  } catch (_) {}
  try {
    let result;
    try {
      result = await env.DB.prepare(`SELECT agent_id, agent_version, updated_at, capabilities, net FROM agent_metrics_state`).all();
    } catch (err) {
      if (!isMissingAgentCapabilitiesColumn(err)) throw err;
      result = await env.DB.prepare(`SELECT agent_id, agent_version, updated_at, NULL AS capabilities FROM agent_metrics_state`).all();
    }
    for (const row of result.results || []) {
      agentStates[sanitizeAgentId(row.agent_id)] = {
        agent_version: row.agent_version || null,
        last_metrics_at: row.updated_at || null,
        capabilities: parseJsonObject(row.capabilities),
      };
      agentTrafficStates[sanitizeAgentId(row.agent_id)] = { net: row.net, updated_at: row.updated_at };
    }
  } catch (_) {}
  const rates = await getExchangeRates(env);
  const targets = (rows.results || []).map((target) => {
    const settings = trafficSettingsFromTarget(target, env);
    const priceCny = convertPriceToCny(target.price, target.currency, rates);
    const nq = publicNodeQualitySummary(target);
    const nqUrl = normalizeNodeQualityReportUrl(target.nq_url) || normalizeNodeQualityReportUrl(nq?.link);
    const unlock = parseJsonObject(target.unlock_data);
    return {
      ...target,
      ...(priceCny == null ? {} : { price_cny: priceCny }),
      traffic: summarizeTrafficWithPending(trafficRows[`${sanitizeAgentId(target.id)}|${settings.month}`], settings, agentTrafficStates[sanitizeAgentId(target.id)]),
      nq,
      nq_url: nqUrl || null,
      has_nq: Boolean(nq?.has_report || nqUrl),
      unlock: Array.isArray(unlock?.services) ? unlock : null,
      agent_runtime: agentStates[sanitizeAgentId(target.id)] || null,
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
  const city = String(body?.city || '').trim().slice(0, 64) || null;
  const provider = String(body?.provider || '').trim() || null;
  const lineType = String(body?.line_type || '').trim() || null;
  const nq = body?.nq_report !== undefined
    ? normalizeNodeQualityReport(body.nq_report)
    : { report: null, updatedAt: null };
  const currency = normalizeCurrency(body?.currency, 'USD');
  const trafficEnabled = parseBoolean(body?.traffic_enabled, false) ? 1 : 0;
  const trafficQuotaGb = normalizeTrafficQuotaGb(body?.traffic_quota_gb ?? 0);
  const trafficMode = normalizeTrafficMode(body?.traffic_mode);
  const trafficResetDay = normalizeTrafficResetDay(body?.traffic_reset_day ?? 1);
  const alertEnabled = body?.alert_enabled === undefined ? 1 : (parseBoolean(body.alert_enabled, true) ? 1 : 0);
  const alertExpiryDays = normalizeNullableNumber(body?.alert_expiry_days, 3650);
  const alertTrafficPercent = normalizeNullableNumber(body?.alert_traffic_remaining_percent, 100);
  const alertTrafficGb = normalizeNullableNumber(body?.alert_traffic_remaining_gb, 1048576);
  const maxSort = await env.DB.prepare(`SELECT MAX(sort_order) AS value FROM targets`).first().catch(() => null);
  const sortOrder = maxSort?.value == null ? null : Number(maxSort.value) + 1;
  await env.DB.prepare(`INSERT INTO targets (id, name, group_name, type, target_host, target_port, url, method, expected_status, timeout_ms, interval_sec, probe_region, enabled, no_public_ip, sort_order, created_at, updated_at, expires_at, price, billing_cycle, tags, location, city, currency, traffic_enabled, traffic_quota_gb, traffic_mode, traffic_reset_day, alert_enabled, alert_expiry_days, alert_traffic_remaining_percent, alert_traffic_remaining_gb, provider, line_type, nq_report, nq_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, normalized.name, normalized.group_name, normalized.type, normalized.target_host, normalized.target_port, normalized.url, normalized.method, normalized.expected_status, normalized.timeout_ms, normalized.interval_sec, normalized.probe_region, normalized.enabled ? 1 : 0, normalized.no_public_ip ? 1 : 0, sortOrder, now, now, expiresAt, price, billingCycle, tags, location, city, currency, trafficEnabled, trafficQuotaGb, trafficMode, trafficResetDay, alertEnabled, alertExpiryDays, alertTrafficPercent, alertTrafficGb, provider, lineType, nq.report, nq.updatedAt).run();
  await syncTargetCompatibility(env, id);
  await setMeta(env, 'targets_last_sync_at', String(now));
  return { ok: true, id };
}

export async function updateTarget(id, request, env) {
  const existing = await env.DB.prepare(`SELECT * FROM targets WHERE id = ?`).bind(id).first();
  if (!existing) return { ok: false, error: 'Target not found' };
  const body = await safeJson(request);
  return updateTargetRecord(id, body, existing, env);
}

export async function bulkUpdateTargets(request, env) {
  const normalized = normalizeBulkTargetUpdate(await safeJson(request));
  if (!normalized.ok) return normalized;
  const now = nowSec();
  const changes = normalizeBulkTargetColumns(normalized.changes, env);
  const applied = await applyBulkTargetColumns(env, normalized.ids, changes, now);
  if (!applied.ok) return { ok: false, error: applied.error };

  if ('traffic_reset_day' in changes) {
    for (const id of normalized.ids) {
      await rebuildAgentTrafficPeriod(env, sanitizeAgentId(id), { ...applied.byId.get(id), ...changes }, now);
    }
  }
  await setMeta(env, 'targets_last_sync_at', String(now));
  return { ok: true, count: normalized.ids.length, ids: normalized.ids, fields: Object.keys(normalized.changes) };
}

function normalizeBulkTargetColumns(changes, env) {
  const normalized = {};
  if ('provider' in changes) normalized.provider = String(changes.provider || '').trim() || null;
  if ('line_type' in changes) normalized.line_type = String(changes.line_type || '').trim() || null;
  if ('expires_at' in changes) normalized.expires_at = normalizeExpiresAt(changes.expires_at, env);
  if ('price' in changes) normalized.price = normalizePrice(changes.price);
  if ('currency' in changes) normalized.currency = normalizeCurrency(changes.currency, 'USD');
  if ('billing_cycle' in changes) normalized.billing_cycle = String(changes.billing_cycle || '').trim() || null;
  if ('traffic_enabled' in changes) normalized.traffic_enabled = parseBoolean(changes.traffic_enabled, false) ? 1 : 0;
  if ('traffic_quota_gb' in changes) normalized.traffic_quota_gb = normalizeTrafficQuotaGb(changes.traffic_quota_gb);
  if ('traffic_mode' in changes) normalized.traffic_mode = normalizeTrafficMode(changes.traffic_mode);
  if ('traffic_reset_day' in changes) normalized.traffic_reset_day = normalizeTrafficResetDay(changes.traffic_reset_day);
  if ('alert_enabled' in changes) normalized.alert_enabled = parseBoolean(changes.alert_enabled, true) ? 1 : 0;
  if ('alert_expiry_days' in changes) normalized.alert_expiry_days = normalizeNullableNumber(changes.alert_expiry_days, 3650);
  if ('alert_traffic_remaining_percent' in changes) normalized.alert_traffic_remaining_percent = normalizeNullableNumber(changes.alert_traffic_remaining_percent, 100);
  if ('alert_traffic_remaining_gb' in changes) normalized.alert_traffic_remaining_gb = normalizeNullableNumber(changes.alert_traffic_remaining_gb, 1048576);
  return normalized;
}

async function updateTargetRecord(id, body, existing, env, { updateMeta = true } = {}) {
  const merged = normalizeTarget({ ...existing, ...body }, true);
  const now = nowSec();
  const expiresAt = body?.expires_at !== undefined ? normalizeExpiresAt(body.expires_at, env) : (existing.expires_at ?? null);
  const price = body?.price !== undefined ? normalizePrice(body.price) : (existing.price ?? null);
  const billingCycle = body?.billing_cycle !== undefined ? (String(body.billing_cycle || '').trim() || null) : (existing.billing_cycle ?? null);
  const tags = body?.tags !== undefined ? (String(body.tags || '').trim() || null) : (existing.tags ?? null);
  const location = body?.location !== undefined ? (String(body.location || '').trim() || null) : (existing.location ?? null);
  const city = body?.city !== undefined ? (String(body.city || '').trim().slice(0, 64) || null) : (existing.city ?? null);
  const provider = body?.provider !== undefined ? (String(body.provider || '').trim() || null) : (existing.provider ?? null);
  const lineType = body?.line_type !== undefined ? (String(body.line_type || '').trim() || null) : (existing.line_type ?? null);
  let nqReport = existing.nq_report ?? null;
  let nqUpdatedAt = existing.nq_updated_at ?? null;
  if (body?.nq_report !== undefined) {
    const nq = normalizeNodeQualityReport(body.nq_report);
    nqReport = nq.report;
    nqUpdatedAt = nq.updatedAt;
  }
  const currency = body?.currency !== undefined ? normalizeCurrency(body.currency, 'USD') : normalizeCurrency(existing.currency, 'USD');
  const trafficEnabled = body?.traffic_enabled !== undefined ? (parseBoolean(body.traffic_enabled, false) ? 1 : 0) : (parseBoolean(existing.traffic_enabled, false) ? 1 : 0);
  const trafficQuotaGb = body?.traffic_quota_gb !== undefined ? normalizeTrafficQuotaGb(body.traffic_quota_gb) : normalizeTrafficQuotaGb(existing.traffic_quota_gb ?? 0);
  const trafficMode = body?.traffic_mode !== undefined ? normalizeTrafficMode(body.traffic_mode) : normalizeTrafficMode(existing.traffic_mode);
  const trafficResetDay = body?.traffic_reset_day !== undefined ? normalizeTrafficResetDay(body.traffic_reset_day) : normalizeTrafficResetDay(existing.traffic_reset_day ?? 1);
  const trafficResetDayChanged = trafficResetDay !== normalizeTrafficResetDay(existing.traffic_reset_day ?? 1);
  const alertEnabled = body?.alert_enabled !== undefined ? (parseBoolean(body.alert_enabled, true) ? 1 : 0) : (existing.alert_enabled == null ? 1 : (parseBoolean(existing.alert_enabled, true) ? 1 : 0));
  const alertExpiryDays = body?.alert_expiry_days !== undefined ? normalizeNullableNumber(body.alert_expiry_days, 3650) : (existing.alert_expiry_days ?? null);
  const alertTrafficPercent = body?.alert_traffic_remaining_percent !== undefined ? normalizeNullableNumber(body.alert_traffic_remaining_percent, 100) : (existing.alert_traffic_remaining_percent ?? null);
  const alertTrafficGb = body?.alert_traffic_remaining_gb !== undefined ? normalizeNullableNumber(body.alert_traffic_remaining_gb, 1048576) : (existing.alert_traffic_remaining_gb ?? null);
  await env.DB.prepare(`UPDATE targets SET name = ?, group_name = ?, type = ?, target_host = ?, target_port = ?, url = ?, method = ?, expected_status = ?, timeout_ms = ?, interval_sec = ?, probe_region = ?, enabled = ?, no_public_ip = ?, updated_at = ?, expires_at = ?, price = ?, billing_cycle = ?, tags = ?, location = ?, city = ?, currency = ?, traffic_enabled = ?, traffic_quota_gb = ?, traffic_mode = ?, traffic_reset_day = ?, alert_enabled = ?, alert_expiry_days = ?, alert_traffic_remaining_percent = ?, alert_traffic_remaining_gb = ?, provider = ?, line_type = ?, nq_report = ?, nq_updated_at = ? WHERE id = ?`).bind(merged.name, merged.group_name, merged.type, merged.target_host, merged.target_port, merged.url, merged.method, merged.expected_status, merged.timeout_ms, merged.interval_sec, merged.probe_region, merged.enabled ? 1 : 0, merged.no_public_ip ? 1 : 0, now, expiresAt, price, billingCycle, tags, location, city, currency, trafficEnabled, trafficQuotaGb, trafficMode, trafficResetDay, alertEnabled, alertExpiryDays, alertTrafficPercent, alertTrafficGb, provider, lineType, nqReport, nqUpdatedAt, id).run();
  await syncTargetCompatibility(env, id);
  if (trafficResetDayChanged) {
    await rebuildAgentTrafficPeriod(env, sanitizeAgentId(id), {
      ...existing,
      traffic_enabled: trafficEnabled,
      traffic_quota_gb: trafficQuotaGb,
      traffic_mode: trafficMode,
      traffic_reset_day: trafficResetDay,
    }, now);
  }
  if (updateMeta) await setMeta(env, 'targets_last_sync_at', String(now));
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
  for (const id of orderedIds) await syncTargetCompatibility(env, id);
  return { ok: true, ids: orderedIds, count: orderedIds.length };
}

export async function deleteTarget(id, env) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM check_buckets WHERE target_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM latest_status WHERE target_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM incident_events WHERE target_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM alert_state WHERE target_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM agent_credentials WHERE subject_type = 'agent' AND subject_id = ?`).bind(sanitizeAgentId(id)),
    env.DB.prepare(`DELETE FROM agent_install_tickets WHERE target_id = ?`).bind(sanitizeAgentId(id)),
    env.DB.prepare(`DELETE FROM agent_tasks WHERE agent_id = ?`).bind(sanitizeAgentId(id)),
    env.DB.prepare(`DELETE FROM checks WHERE legacy_target_id = ? OR node_id = ?`).bind(id, id),
    env.DB.prepare(`DELETE FROM nodes WHERE legacy_target_id = ? OR id = ?`).bind(id, id),
    env.DB.prepare(`DELETE FROM targets WHERE id = ?`).bind(id),
  ]);
  await removeTargetFromR2State(env, id);
  const telemetry = await deleteAgentTelemetry(env, id);
  await setMeta(env, 'targets_last_sync_at', String(nowSec()));
  return { ok: true, id, telemetry };
}

export async function syncTargetCompatibility(env, id) {
  const target = await env.DB.prepare(`SELECT * FROM targets WHERE id = ?`).bind(id).first();
  if (!target) return;
  if (target.type === 'tcp') {
    await env.DB.prepare(`INSERT INTO nodes (
      id, legacy_target_id, name, group_name, enabled, sort_order, provider, machine_type, tags,
      ipv4, ipv6, country_code, country, city, location_source, location_updated_at,
      expires_at, price, billing_cycle, currency, traffic_enabled, traffic_quota_gb, traffic_mode,
      traffic_reset_day, alert_enabled, alert_expiry_days, alert_traffic_remaining_percent,
      alert_traffic_remaining_gb, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      legacy_target_id=excluded.legacy_target_id, name=excluded.name, group_name=excluded.group_name,
      enabled=excluded.enabled, sort_order=excluded.sort_order, provider=excluded.provider,
      machine_type=excluded.machine_type, tags=excluded.tags, ipv4=excluded.ipv4, ipv6=excluded.ipv6,
      country_code=excluded.country_code, country=excluded.country, city=excluded.city,
      location_source=excluded.location_source, location_updated_at=excluded.location_updated_at,
      expires_at=excluded.expires_at, price=excluded.price, billing_cycle=excluded.billing_cycle,
      currency=excluded.currency, traffic_enabled=excluded.traffic_enabled,
      traffic_quota_gb=excluded.traffic_quota_gb, traffic_mode=excluded.traffic_mode,
      traffic_reset_day=excluded.traffic_reset_day, alert_enabled=excluded.alert_enabled,
      alert_expiry_days=excluded.alert_expiry_days,
      alert_traffic_remaining_percent=excluded.alert_traffic_remaining_percent,
      alert_traffic_remaining_gb=excluded.alert_traffic_remaining_gb, updated_at=excluded.updated_at`)
      .bind(
        target.id, target.id, target.name, target.group_name, target.enabled, target.sort_order,
        target.provider || '', target.line_type || '', target.tags || '', target.ipv4 || null,
        target.ipv6 || null, /^[A-Za-z]{2}$/.test(target.location || '') ? String(target.location).toUpperCase() : '',
        target.location || '', target.city || '', target.location_source || null, target.location_updated_at || null,
        target.expires_at || null, target.price ?? null, target.billing_cycle || '', target.currency || 'USD',
        target.traffic_enabled || 0, target.traffic_quota_gb || 0, target.traffic_mode || 'total',
        target.traffic_reset_day || 1, target.alert_enabled == null ? 1 : target.alert_enabled,
        target.alert_expiry_days ?? null, target.alert_traffic_remaining_percent ?? null,
        target.alert_traffic_remaining_gb ?? null, target.created_at, target.updated_at,
      ).run();
  } else {
    await env.DB.prepare(`DELETE FROM nodes WHERE legacy_target_id = ?`).bind(target.id).run();
  }

  if (target.type === 'http' || Number(target.no_public_ip || 0) === 0) {
    await env.DB.prepare(`INSERT INTO checks (
      id, legacy_target_id, node_id, name, group_name, type, target_host, target_port, url,
      method, expected_status, timeout_ms, interval_sec, probe_region, enabled, sort_order,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      legacy_target_id=excluded.legacy_target_id, node_id=excluded.node_id, name=excluded.name,
      group_name=excluded.group_name, type=excluded.type, target_host=excluded.target_host,
      target_port=excluded.target_port, url=excluded.url, method=excluded.method,
      expected_status=excluded.expected_status, timeout_ms=excluded.timeout_ms,
      interval_sec=excluded.interval_sec, probe_region=excluded.probe_region,
      enabled=excluded.enabled, sort_order=excluded.sort_order, updated_at=excluded.updated_at`)
      .bind(
        target.id, target.id, target.type === 'tcp' ? target.id : null, target.name,
        target.group_name, target.type, target.target_host, target.target_port, target.url,
        target.method || 'GET', target.expected_status || '', target.timeout_ms,
        target.interval_sec, target.probe_region || 'auto', target.enabled, target.sort_order,
        target.created_at, target.updated_at,
      ).run();
  } else {
    await env.DB.prepare(`DELETE FROM checks WHERE legacy_target_id = ?`).bind(target.id).run();
  }
}

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
}

// ── Probe now (admin) ────────────────────────────────────────────────────────

export async function probeNow(env, id) {
  if (parseBoolean(env.AUTO_SYNC_TARGETS ?? false, false)) await syncEnvTargets(env, { force: true });
  const rows = id
    ? await env.DB.prepare(`SELECT * FROM targets WHERE id = ? AND enabled = 1 AND COALESCE(no_public_ip, 0) = 0`).bind(id).all()
    : await env.DB.prepare(`SELECT * FROM targets WHERE enabled = 1 AND COALESCE(no_public_ip, 0) = 0 ORDER BY group_name, name`).all();
  const targets = rows.results || [];
  return { ok: true, count: targets.length, results: await runTargetBatch(env, targets) };
}

// ── Agent targets ───────────────────────────────────────────────────────────

export async function getAgentTargets(env, url) {
  if (parseBoolean(env.ENSURE_SCHEMA_ON_READ ?? false, false)) await ensureV6Schema(env);
  const agentId = sanitizeAgentId(url.searchParams.get('agent_id') || env.DEFAULT_AGENT_ID || 'external-agent');
  const group = String(url.searchParams.get('group') || '').trim();
  const rows = await env.DB.prepare(`SELECT id, name, group_name, type, target_host, target_port, url, method, expected_status, timeout_ms, interval_sec, probe_region, enabled, no_public_ip FROM targets WHERE enabled = 1 ORDER BY group_name COLLATE NOCASE, name COLLATE NOCASE`).all();
  const targets = (rows.results || []).filter(row => !group || String(row.group_name || '') === group).map(row => ({
    id: row.id, name: row.name, group_name: row.group_name, type: row.type, target_host: row.target_host,
    target_port: row.target_port == null ? null : Number(row.target_port), url: row.url, method: row.method || 'GET',
    expected_status: parseExpectedStatus(row.expected_status), timeout_ms: clamp(Number(row.timeout_ms || DEFAULT_TIMEOUT_MS), 500, 30000),
    interval_sec: clamp(Number(row.interval_sec || DEFAULT_INTERVAL_SEC), MIN_INTERVAL_SEC, 86400), no_public_ip: Boolean(row.no_public_ip),
  }));
  return { ok: true, agent_id: agentId, interval_sec: clamp(Number(env.AGENT_INTERVAL_SEC || DEFAULT_INTERVAL_SEC), MIN_INTERVAL_SEC, 86400), generated_at: new Date().toISOString(), targets };
}
