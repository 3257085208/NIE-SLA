import { clamp, nowSec, sanitizeId, sanitizeAgentId, parseBoolean, normalizeTarget, stableTargetId, sha256Hex, dayFromSec, dayStartSec, yesterdayLocal, timezoneOffsetMin, publicCheckPoint, publicError, publicHost, publicUrl, parseExpectedStatus, REGION_LABELS, DEFAULT_TIMEOUT_MS, DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC, BUCKET_SEC, isMissedMonitorPoint, buildMissedPoints, buildOpenMissedPoints, retentionSeconds } from './utils.js';
import { normalizeTrafficMode, normalizeTrafficQuotaGb, summarizeTraffic, trafficPeriod, trafficSettingsFromTarget } from './traffic.js';
import { agentScopedToken, requireAgentForId, safeJson } from './auth.js';
import { removeTargetFromR2State, readR2State, mergeR2StateUpdates, appendAgentR2HistoryPoints, setDailySummary, dailySummaryFromPoints, statsFromDailySummaries, summaryRowsFromChecks } from './storage.js';
import { runTargetBatch } from './probe.js';
import { compactPingPointsByTarget, loadAgentPingsR2History, pingPointsToSeries, writeAgentTelemetryR2History } from './metrics.js';

// D1 schema.

let schemaEnsured = false;
let schemaPromise = null;

async function runOptionalSchemaChange(env, statement) {
  try {
    await env.DB.prepare(statement).run();
  } catch (err) {
    if (isAlreadyAppliedSchemaChange(err)) return;
    console.error('schema migration failed:', statement, String(err?.message || err));
    throw err;
  }
}

function isAlreadyAppliedSchemaChange(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return message.includes('duplicate column name') || message.includes('already exists');
}

export async function ensureV6Schema(env) {
  if (schemaEnsured || !env.DB) return;
  if (schemaPromise) { await schemaPromise; return; }
  schemaPromise = (async () => {
  try {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS targets (id TEXT PRIMARY KEY, name TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT 'Default', type TEXT NOT NULL CHECK (type IN ('tcp', 'http')), target_host TEXT, target_port INTEGER, url TEXT, method TEXT DEFAULT 'GET', expected_status TEXT DEFAULT '', timeout_ms INTEGER NOT NULL DEFAULT 5000, interval_sec INTEGER NOT NULL DEFAULT 300, probe_region TEXT NOT NULL DEFAULT 'auto', enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_checked_at INTEGER, expires_at INTEGER, price REAL, billing_cycle TEXT DEFAULT '', tags TEXT DEFAULT '', location TEXT DEFAULT '', currency TEXT DEFAULT 'USD', traffic_enabled INTEGER NOT NULL DEFAULT 0, traffic_quota_gb REAL NOT NULL DEFAULT 0, traffic_mode TEXT DEFAULT 'total', alert_enabled INTEGER NOT NULL DEFAULT 1, alert_expiry_days INTEGER, alert_traffic_remaining_percent REAL, alert_traffic_remaining_gb REAL)`).run();
  // Add new columns to existing tables while surfacing real migration errors.
  for (const stmt of ['ALTER TABLE targets ADD COLUMN expires_at INTEGER', 'ALTER TABLE targets ADD COLUMN price REAL', 'ALTER TABLE targets ADD COLUMN billing_cycle TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN tags TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN location TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN currency TEXT DEFAULT \'USD\'', 'ALTER TABLE targets ADD COLUMN traffic_enabled INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE targets ADD COLUMN traffic_quota_gb REAL NOT NULL DEFAULT 0', 'ALTER TABLE targets ADD COLUMN traffic_mode TEXT DEFAULT \'total\'', 'ALTER TABLE targets ADD COLUMN alert_enabled INTEGER NOT NULL DEFAULT 1', 'ALTER TABLE targets ADD COLUMN alert_expiry_days INTEGER', 'ALTER TABLE targets ADD COLUMN alert_traffic_remaining_percent REAL', 'ALTER TABLE targets ADD COLUMN alert_traffic_remaining_gb REAL']) {
    await runOptionalSchemaChange(env, stmt);
  }
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_targets_due ON targets(enabled, last_checked_at, interval_sec)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_targets_group ON targets(group_name, name)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS latest_status (target_id TEXT PRIMARY KEY, checked_at INTEGER NOT NULL, ok INTEGER NOT NULL CHECK (ok IN (0, 1)), latency_ms INTEGER, status_code INTEGER, error TEXT, probe_region TEXT DEFAULT 'auto', cf_colo TEXT, uptime_24h REAL, uptime_7d REAL, avg_latency_24h INTEGER, last_fail_at INTEGER, history_json TEXT DEFAULT '[]', current_outage_started_at INTEGER, last_recover_at INTEGER, status_changed_at INTEGER)`).run();
  for (const stmt of ['ALTER TABLE latest_status ADD COLUMN probe_region TEXT DEFAULT \'auto\'', 'ALTER TABLE latest_status ADD COLUMN cf_colo TEXT', 'ALTER TABLE latest_status ADD COLUMN uptime_24h REAL', 'ALTER TABLE latest_status ADD COLUMN uptime_7d REAL', 'ALTER TABLE latest_status ADD COLUMN avg_latency_24h INTEGER', 'ALTER TABLE latest_status ADD COLUMN last_fail_at INTEGER', 'ALTER TABLE latest_status ADD COLUMN current_outage_started_at INTEGER', 'ALTER TABLE latest_status ADD COLUMN last_recover_at INTEGER', 'ALTER TABLE latest_status ADD COLUMN status_changed_at INTEGER']) {
    await runOptionalSchemaChange(env, stmt);
  }
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS check_buckets (target_id TEXT NOT NULL, bucket_at INTEGER NOT NULL, day TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, ok_count INTEGER NOT NULL DEFAULT 0, sum_latency_ms INTEGER NOT NULL DEFAULT 0, last_ok INTEGER NOT NULL CHECK (last_ok IN (0, 1)), last_latency_ms INTEGER, last_status_code INTEGER, last_error TEXT, probe_region TEXT DEFAULT 'auto', cf_colo TEXT, PRIMARY KEY (target_id, bucket_at))`).run();
  for (const stmt of ['ALTER TABLE check_buckets ADD COLUMN day TEXT DEFAULT \'\'', 'ALTER TABLE check_buckets ADD COLUMN total INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE check_buckets ADD COLUMN ok_count INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE check_buckets ADD COLUMN sum_latency_ms INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE check_buckets ADD COLUMN last_ok INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE check_buckets ADD COLUMN last_latency_ms INTEGER', 'ALTER TABLE check_buckets ADD COLUMN last_status_code INTEGER', 'ALTER TABLE check_buckets ADD COLUMN last_error TEXT', 'ALTER TABLE check_buckets ADD COLUMN probe_region TEXT DEFAULT \'auto\'', 'ALTER TABLE check_buckets ADD COLUMN cf_colo TEXT']) {
    await runOptionalSchemaChange(env, stmt);
  }
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_check_buckets_day ON check_buckets(day)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_check_buckets_target_time ON check_buckets(target_id, bucket_at DESC)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS incident_events (id TEXT PRIMARY KEY, target_id TEXT NOT NULL, started_at INTEGER NOT NULL, recovered_at INTEGER, last_checked_at INTEGER, start_colo TEXT, recover_colo TEXT, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`).run();
  for (const stmt of ['ALTER TABLE incident_events ADD COLUMN recovered_at INTEGER', 'ALTER TABLE incident_events ADD COLUMN last_checked_at INTEGER', 'ALTER TABLE incident_events ADD COLUMN start_colo TEXT', 'ALTER TABLE incident_events ADD COLUMN recover_colo TEXT', 'ALTER TABLE incident_events ADD COLUMN last_error TEXT']) {
    await runOptionalSchemaChange(env, stmt);
  }
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_incident_target_active ON incident_events(target_id, recovered_at)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_incident_started ON incident_events(started_at DESC)`).run();
  await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_one_active ON incident_events(target_id) WHERE recovered_at IS NULL`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rate_limits (key TEXT NOT NULL, ts INTEGER NOT NULL)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_rate_limits_key_ts ON rate_limits(key, ts)`).run();

  // Agent latest state stays in D1; high-frequency history stays in R2 by default.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS agent_metrics_state (
    agent_id TEXT PRIMARY KEY,
    agent_label TEXT,
    agent_version TEXT,
    updated_at TEXT,
    hostname TEXT,
    cpu_percent REAL,
    memory TEXT,
    load TEXT,
    disk TEXT,
    net TEXT,
    diskio TEXT,
    stats TEXT,
    uptime_sec INTEGER,
    vps_info TEXT,
    process_count INTEGER,
    thread_count INTEGER,
    pings TEXT
  )`).run();
  await runOptionalSchemaChange(env, `ALTER TABLE agent_metrics_state ADD COLUMN agent_version TEXT`);
  await runOptionalSchemaChange(env, `ALTER TABLE agent_metrics_state ADD COLUMN process_count INTEGER`);
  await runOptionalSchemaChange(env, `ALTER TABLE agent_metrics_state ADD COLUMN thread_count INTEGER`);
  await runOptionalSchemaChange(env, `ALTER TABLE agent_metrics_state ADD COLUMN pings TEXT`);

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS agent_metrics_history (
    agent_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    data TEXT,
    PRIMARY KEY (agent_id, ts)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_history_ts ON agent_metrics_history(agent_id, ts DESC)`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS agent_traffic_monthly (
    agent_id TEXT NOT NULL,
    month TEXT NOT NULL,
    rx_bytes INTEGER NOT NULL DEFAULT 0,
    tx_bytes INTEGER NOT NULL DEFAULT 0,
    last_rx_bytes INTEGER,
    last_tx_bytes INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, month)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_traffic_month ON agent_traffic_monthly(month)`).run();

  // TCP Ping targets (managed via D1 console)
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ping_targets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    target TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER,
    updated_at INTEGER
  )`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ping_history (
    target_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    latency_ms REAL,
    ok INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (target_id, agent_id, ts)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ping_history_agent_ts ON ping_history(agent_id, ts DESC)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS alert_state (
    target_id TEXT NOT NULL,
    rule_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    last_value REAL,
    opened_at INTEGER,
    resolved_at INTEGER,
    last_sent_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (target_id, rule_key)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_alert_state_updated ON alert_state(updated_at DESC)`).run();
  schemaEnsured = true;
  } catch (e) { schemaPromise = null; throw e; }
  })();
  await schemaPromise;
}

export function shouldEnsureSchemaForRequest(path, method, env) {
  if (method === 'OPTIONS') return false;
  if (path === '/api/colo-echo' || path === '/' || path === '/api/health' || path === '/api/login') return false;
  if (path === '/api/status' || path === '/api/checks') return parseBoolean(env?.ENSURE_SCHEMA_ON_READ, false);
  if (path === '/api/agent/metrics' && method === 'POST') return parseBoolean(env?.ENSURE_SCHEMA_ON_AGENT_WRITE, false);
  // Schema migrations are handled by the cron task; do not block admin reads or auth failures.
  return parseBoolean(env?.ENSURE_SCHEMA_ON_REQUEST, false);
}

// Exchange rates.

export async function fetchExchangeRates(env) {
  if (!env.DB) return;
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/CNY', { headers: { 'User-Agent': 'NStatus/1.0' } });
    if (!res.ok) return;
    const data = await res.json();
    if (data?.rates) {
      await setMeta(env, 'exchange_rates', JSON.stringify(data.rates));
      await setMeta(env, 'exchange_rates_updated', String(nowSec()));
    }
  } catch (_) {}
}

export async function getExchangeRates(env) {
  try {
    const raw = await getMeta(env, 'exchange_rates');
    const updated = Number(await getMeta(env, 'exchange_rates_updated') || 0);
    if (!raw || updated < nowSec() - 86400) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

// ── Meta ─────────────────────────────────────────────────────────────────────

export async function getMeta(env, key) {
  const row = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(key).first();
  return row?.value ?? null;
}

export async function setMeta(env, key, value) {
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(key, String(value), nowSec()).run();
}

const FRONTEND_THEMES = new Set(['classic', 'cards']);

function normalizeFrontendTheme(value) {
  const theme = String(value || 'classic').trim().toLowerCase();
  return FRONTEND_THEMES.has(theme) ? theme : 'classic';
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

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

export async function getPublicSettings(env) {
  let saved = null;
  try { saved = await getMeta(env, 'frontend_theme'); } catch (_) {}
  const frontendTheme = normalizeFrontendTheme(saved || env.PUBLIC_FRONTEND_THEME || 'classic');
  return {
    ok: true,
    frontend_theme: frontendTheme,
    traffic: trafficPeriod(env),
    themes: [
      { id: 'classic', name: '原版列表' },
      { id: 'cards', name: '卡片风格' },
    ],
  };
}

export async function updatePublicSettings(request, env) {
  const body = await safeJson(request);
  if (hasOwn(body, 'frontend_theme') || hasOwn(body, 'theme')) {
    await setMeta(env, 'frontend_theme', normalizeFrontendTheme(body?.frontend_theme ?? body?.theme));
  }
  return getPublicSettings(env);
}

// ── Target CRUD ──────────────────────────────────────────────────────────────

export async function listTargets(env) {
  await syncEnvTargetsMaybe(env);
  const rows = await env.DB.prepare(`SELECT * FROM targets ORDER BY group_name, name`).all();
  const trafficRows = {};
  try {
    const result = await env.DB.prepare(`SELECT * FROM agent_traffic_monthly`).all();
    for (const row of result.results || []) trafficRows[`${sanitizeAgentId(row.agent_id)}|${row.month}`] = row;
  } catch (_) {}
  const targets = (rows.results || []).map((target) => {
    const settings = trafficSettingsFromTarget(target, env);
    return { ...target, traffic: summarizeTraffic(trafficRows[`${sanitizeAgentId(target.id)}|${settings.month}`], settings) };
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
  const currency = String(body?.currency || 'USD').trim().toUpperCase() || 'USD';
  const trafficEnabled = parseBoolean(body?.traffic_enabled, false) ? 1 : 0;
  const trafficQuotaGb = normalizeTrafficQuotaGb(body?.traffic_quota_gb ?? 0);
  const trafficMode = normalizeTrafficMode(body?.traffic_mode);
  const alertEnabled = body?.alert_enabled === undefined ? 1 : (parseBoolean(body.alert_enabled, true) ? 1 : 0);
  const alertExpiryDays = normalizeNullableNumber(body?.alert_expiry_days, 3650);
  const alertTrafficPercent = normalizeNullableNumber(body?.alert_traffic_remaining_percent, 100);
  const alertTrafficGb = normalizeNullableNumber(body?.alert_traffic_remaining_gb, 1048576);
  await env.DB.prepare(`INSERT INTO targets (id, name, group_name, type, target_host, target_port, url, method, expected_status, timeout_ms, interval_sec, probe_region, enabled, created_at, updated_at, expires_at, price, billing_cycle, tags, location, currency, traffic_enabled, traffic_quota_gb, traffic_mode, alert_enabled, alert_expiry_days, alert_traffic_remaining_percent, alert_traffic_remaining_gb) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, normalized.name, normalized.group_name, normalized.type, normalized.target_host, normalized.target_port, normalized.url, normalized.method, normalized.expected_status, normalized.timeout_ms, normalized.interval_sec, normalized.probe_region, normalized.enabled ? 1 : 0, now, now, expiresAt, price, billingCycle, tags, location, currency, trafficEnabled, trafficQuotaGb, trafficMode, alertEnabled, alertExpiryDays, alertTrafficPercent, alertTrafficGb).run();
  await setMeta(env, 'targets_last_sync_at', String(now));
  return { ok: true, id };
}

export async function updateTarget(id, request, env) {
  const existing = await env.DB.prepare(`SELECT * FROM targets WHERE id = ?`).bind(id).first();
  if (!existing) return { ok: false, error: 'Target not found' };
  const body = await safeJson(request);
  const merged = normalizeTarget({ ...existing, ...body }, true);
  const now = nowSec();
  // Merge optional fields: use body value if present, else existing
  const expiresAt = body?.expires_at !== undefined ? normalizeExpiresAt(body.expires_at, env) : (existing.expires_at ?? null);
  const price = body?.price !== undefined ? normalizePrice(body.price) : (existing.price ?? null);
  const billingCycle = body?.billing_cycle !== undefined ? (String(body.billing_cycle || '').trim() || null) : (existing.billing_cycle ?? null);
  const tags = body?.tags !== undefined ? (String(body.tags || '').trim() || null) : (existing.tags ?? null);
  const location = body?.location !== undefined ? (String(body.location || '').trim() || null) : (existing.location ?? null);
  const currency = body?.currency !== undefined ? (String(body.currency || 'USD').trim().toUpperCase() || 'USD') : (existing.currency ?? 'USD');
  const trafficEnabled = body?.traffic_enabled !== undefined ? (parseBoolean(body.traffic_enabled, false) ? 1 : 0) : (parseBoolean(existing.traffic_enabled, false) ? 1 : 0);
  const trafficQuotaGb = body?.traffic_quota_gb !== undefined ? normalizeTrafficQuotaGb(body.traffic_quota_gb) : normalizeTrafficQuotaGb(existing.traffic_quota_gb ?? 0);
  const trafficMode = body?.traffic_mode !== undefined ? normalizeTrafficMode(body.traffic_mode) : normalizeTrafficMode(existing.traffic_mode);
  const alertEnabled = body?.alert_enabled !== undefined ? (parseBoolean(body.alert_enabled, true) ? 1 : 0) : (existing.alert_enabled == null ? 1 : (parseBoolean(existing.alert_enabled, true) ? 1 : 0));
  const alertExpiryDays = body?.alert_expiry_days !== undefined ? normalizeNullableNumber(body.alert_expiry_days, 3650) : (existing.alert_expiry_days ?? null);
  const alertTrafficPercent = body?.alert_traffic_remaining_percent !== undefined ? normalizeNullableNumber(body.alert_traffic_remaining_percent, 100) : (existing.alert_traffic_remaining_percent ?? null);
  const alertTrafficGb = body?.alert_traffic_remaining_gb !== undefined ? normalizeNullableNumber(body.alert_traffic_remaining_gb, 1048576) : (existing.alert_traffic_remaining_gb ?? null);
  await env.DB.prepare(`UPDATE targets SET name = ?, group_name = ?, type = ?, target_host = ?, target_port = ?, url = ?, method = ?, expected_status = ?, timeout_ms = ?, interval_sec = ?, probe_region = ?, enabled = ?, updated_at = ?, expires_at = ?, price = ?, billing_cycle = ?, tags = ?, location = ?, currency = ?, traffic_enabled = ?, traffic_quota_gb = ?, traffic_mode = ?, alert_enabled = ?, alert_expiry_days = ?, alert_traffic_remaining_percent = ?, alert_traffic_remaining_gb = ? WHERE id = ?`).bind(merged.name, merged.group_name, merged.type, merged.target_host, merged.target_port, merged.url, merged.method, merged.expected_status, merged.timeout_ms, merged.interval_sec, merged.probe_region, merged.enabled ? 1 : 0, now, expiresAt, price, billingCycle, tags, location, currency, trafficEnabled, trafficQuotaGb, trafficMode, alertEnabled, alertExpiryDays, alertTrafficPercent, alertTrafficGb, id).run();
  await setMeta(env, 'targets_last_sync_at', String(now));
  return { ok: true, id };
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
  await setMeta(env, 'targets_last_sync_at', String(nowSec()));
  return { ok: true, id };
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

// ── Agent targets & results ──────────────────────────────────────────────────

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

export async function submitAgentResults(request, env) {
  if (!env.ARCHIVE) return { ok: false, error: 'R2 binding ARCHIVE is required' };
  const body = await safeJson(request);
  const agentId = sanitizeAgentId(body?.agent_id || env.DEFAULT_AGENT_ID || 'external-agent');
  const agentLabel = String(body?.agent_label || env.DEFAULT_AGENT_LABEL || 'External Agent').trim().slice(0, 64) || 'External Agent';
  const submittedAt = clampAgentTimestamp(Number(body?.submitted_at || nowSec()));
  const results = Array.isArray(body?.results) ? body.results : [];
  const maxResults = clamp(Number(env.AGENT_MAX_RESULTS_PER_BATCH || 200), 1, 1000);
  if (!results.length) return { ok: false, error: 'results must be a non-empty array' };
  if (results.length > maxResults) return { ok: false, error: `too many results; max ${maxResults}` };
  const targets = await getTargetsById(env, results.map(r => r?.target_id));
  const acceptedByTarget = new Map();
  const rejected = [];
  for (const item of results) {
    const targetId = String(item?.target_id || '').trim();
    const target = targets.get(targetId);
    if (!target) { rejected.push({ target_id: targetId || null, error: 'unknown target_id' }); continue; }
    const point = normalizeAgentResultPoint(item, target, agentId, agentLabel, submittedAt);
    if (!point) { rejected.push({ target_id: targetId, error: 'invalid result' }); continue; }
    const day = dayFromSec(point.checked_at, env);
    const key = `${targetId}:${day}`;
    const bucket = acceptedByTarget.get(key) || { target, day, points: [] };
    bucket.points.push(point);
    acceptedByTarget.set(key, bucket);
  }
  let accepted = 0;
  const writes = [];
  const r2State = await readR2State(env);
  const mergedBuckets = [];
  const bucketWritesByTarget = new Map();
  for (const bucket of acceptedByTarget.values()) {
    const merged = await appendAgentR2HistoryPoints(env, agentId, bucket.target, bucket.day, bucket.points);
    accepted += bucket.points.length;
    writes.push({ target_id: bucket.target.id, day: bucket.day, points: bucket.points.length, stored: merged.length });
    const latestPoint = latestHistoryPoint(merged);
    if (latestPoint) mergedBuckets.push({ target: bucket.target, day: bucket.day, points: merged, latestPoint });
    const targetWrites = bucketWritesByTarget.get(bucket.target.id) || [];
    for (const point of bucket.points) targetWrites.push({ day: dayFromSec(point.checked_at, env), point });
    bucketWritesByTarget.set(bucket.target.id, targetWrites);
  }
  mergedBuckets.sort((a, b) => String(a.target.id).localeCompare(String(b.target.id)) || Number(a.latestPoint.checked_at) - Number(b.latestPoint.checked_at));
  const latestUpdates = new Map();
  for (const bucket of mergedBuckets) {
    const previous = latestUpdates.get(bucket.target.id) || r2State.targets?.[bucket.target.id] || null;
    const d1Points = await readCheckBuckets(env, bucket.target.id, 2);
    const mergedForDaily = mergeCheckPointsByBucket(d1Points, bucket.points);
    latestUpdates.set(bucket.target.id, buildAgentStateUpdate(env, bucket.target, bucket.latestPoint, mergedForDaily, previous));
  }
  const stateUpdates = [...latestUpdates.values()];
  if (stateUpdates.length) {
    await mergeR2StateUpdates(env, stateUpdates);
    for (const update of stateUpdates) {
      await applyProbeWriteBatch(env, update.target_id, update.checked_at, bucketWritesByTarget.get(update.target_id) || [], update, null);
    }
  }
  return { ok: true, agent_id: agentId, accepted, rejected, writes, state_updates: stateUpdates.length };
}

async function getTargetsById(env, ids) {
  const cleanIds = [...new Set((ids || []).map(id => String(id || '').trim()).filter(Boolean))].slice(0, 1000);
  const map = new Map();
  if (!cleanIds.length) return map;
  for (let i = 0; i < cleanIds.length; i += 80) {
    const chunk = cleanIds.slice(i, i + 80);
    const marks = chunk.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT * FROM targets WHERE enabled = 1 AND id IN (${marks})`).bind(...chunk).all();
    for (const row of rows.results || []) map.set(String(row.id), row);
  }
  return map;
}

function normalizeAgentResultPoint(item, target, agentId, agentLabel, submittedAt) {
  const targetId = String(item?.target_id || '').trim();
  if (!targetId || targetId !== String(target.id)) return null;
  const rawCheckedAt = Number(item?.checked_at || item?.t || submittedAt || nowSec());
  const checkedAt = Math.floor(rawCheckedAt / BUCKET_SEC) * BUCKET_SEC;
  if (!isAgentTimestampAllowed(checkedAt)) return null;
  const latency = item?.latency_ms == null ? null : Math.round(Number(item.latency_ms));
  const statusCode = item?.status_code == null ? null : Number(item.status_code);
  const ok = item?.ok === undefined ? inferAgentResultOk(target, latency, statusCode) : normalizeOkInt(item.ok);
  const error = ok ? null : String(item?.error || 'Check failed').slice(0, 500);
  return publicCheckPoint({ checked_at: checkedAt, ok: ok ? 1 : 0, latency_ms: Number.isFinite(latency) && latency >= 0 ? latency : null, status_code: Number.isFinite(statusCode) ? statusCode : null, error, probe_region: agentId, cf_colo: null, total: 1, ok_count: ok ? 1 : 0, bucket: true, agent_id: agentId, agent_label: agentLabel });
}

function inferAgentResultOk(target, latency, statusCode) {
  if (String(target?.type || '').toLowerCase() === 'http' && Number.isFinite(statusCode)) {
    const expected = parseExpectedStatus(target.expected_status);
    return expected.length ? (expected.includes(Number(statusCode)) ? 1 : 0) : (statusCode >= 200 && statusCode < 400 ? 1 : 0);
  }
  return Number.isFinite(latency) && latency >= 0 ? 1 : 0;
}

function latestHistoryPoint(points) {
  const rows = (points || []).filter(p => Number(p?.checked_at || 0) > 0).sort((a, b) => Number(a.checked_at) - Number(b.checked_at));
  return rows.length ? rows[rows.length - 1] : null;
}

function mergeCheckPointsByBucket(...groups) {
  const byBucket = new Map();
  for (const group of groups) {
    for (const point of group || []) {
      const checkedAt = Number(point?.checked_at || 0);
      if (!checkedAt) continue;
      byBucket.set(checkedAt, point);
    }
  }
  return [...byBucket.values()].sort((a, b) => Number(a.checked_at || 0) - Number(b.checked_at || 0));
}

function buildAgentStateUpdate(env, target, latestPoint, dayPoints, previous) {
  const pointCheckedAt = Number(latestPoint.checked_at || 0);
  const previousCheckedAt = Number(previous?.checked_at || 0);
  const checkedAt = Math.max(pointCheckedAt, previousCheckedAt);
  const day = dayFromSec(pointCheckedAt, env);
  const daily = setDailySummary(previous?.daily || {}, day, dailySummaryFromPoints((dayPoints || []).filter(p => dayFromSec(p.checked_at, env) === day)));
  const endDay = dayFromSec(checkedAt || pointCheckedAt, env);
  const stats24 = statsFromDailySummaries(daily, endDay, 1);
  const stats7 = statsFromDailySummaries(daily, endDay, 7);
  if (previousCheckedAt > pointCheckedAt) {
    return {
      target_id: target.id,
      checked_at: previousCheckedAt,
      ok: Number(previous?.ok) ? 1 : 0,
      latency_ms: previous?.latency_ms == null ? null : Number(previous.latency_ms),
      status_code: previous?.status_code == null ? null : Number(previous.status_code),
      error: previous?.error || null,
      probe_region: previous?.probe_region || target.probe_region || 'auto',
      cf_colo: previous?.cf_colo || null,
      uptime_24h: stats24.uptime,
      uptime_7d: stats7.uptime,
      avg_latency_24h: stats24.avgLatency,
      last_fail_at: previous?.last_fail_at || null,
      current_outage_started_at: previous?.current_outage_started_at || null,
      last_recover_at: previous?.last_recover_at || null,
      status_changed_at: previous?.status_changed_at || previousCheckedAt,
      daily,
    };
  }
  const okInt = Number(latestPoint.ok) ? 1 : 0;
  const wasDown = previous && Number(previous.ok) === 0;
  const isDown = okInt === 0;
  const latency = latestPoint.latency_ms == null ? null : Math.round(Number(latestPoint.latency_ms));
  const statusCode = latestPoint.status_code == null ? null : Number(latestPoint.status_code);
  return {
    target_id: target.id,
    checked_at: checkedAt,
    ok: okInt,
    latency_ms: Number.isFinite(latency) ? latency : null,
    status_code: Number.isFinite(statusCode) ? statusCode : null,
    error: okInt ? null : (latestPoint.error || 'Check failed'),
    probe_region: latestPoint.probe_region || target.probe_region || 'auto',
    cf_colo: null,
    uptime_24h: stats24.uptime,
    uptime_7d: stats7.uptime,
    avg_latency_24h: stats24.avgLatency,
    last_fail_at: okInt ? (previous?.last_fail_at || null) : pointCheckedAt,
    current_outage_started_at: isDown ? (wasDown ? (previous?.current_outage_started_at || pointCheckedAt) : pointCheckedAt) : null,
    last_recover_at: !isDown && wasDown ? pointCheckedAt : (previous?.last_recover_at || null),
    status_changed_at: previous && Number(previous.ok) === okInt ? (previous.status_changed_at || pointCheckedAt) : pointCheckedAt,
    daily,
  };
}

function isAgentTimestampAllowed(checkedAt) {
  const ts = Number(checkedAt || 0);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return ts >= nowSec() - 86400 && ts <= nowSec() + 900;
}

function clampAgentTimestamp(ts) {
  const now = nowSec();
  if (!Number.isFinite(ts) || ts <= 0) return now;
  return clamp(Math.floor(ts), now - 86400, now + 900);
}

// ── Agent TCP Ping ──────────────────────────────────────────────────────────

export async function getPingTargets(env, options = {}) {
  const enabledOnly = options.enabledOnly !== false;
  const rows = await env.DB.prepare(`SELECT * FROM ping_targets ${enabledOnly ? 'WHERE enabled = 1 ' : ''}ORDER BY name`).all();
  return { ok: true, targets: rows.results || [] };
}

export async function submitAgentPings(request, env) {
  if (!env.DB) return { ok: false, error: 'D1 binding DB is required' };
  const body = await safeJson(request);
  const agentId = sanitizeAgentId(body?.agent_id || '');
  if (!agentId) return { ok: false, error: 'agent_id is required' };
  await requireAgentForId(request, env, agentId);
  const pings = Array.isArray(body?.pings) ? body.pings : [];
  if (!pings.length) return { ok: false, error: 'pings must be a non-empty array' };
  if (pings.length > 100) return { ok: false, error: 'max 100 pings per batch' };

  const now = nowSec();
  const accepted = [];
  const stmts = [];
  for (const p of pings) {
    const targetId = String(p?.target_id || '').trim();
    const ts = Math.floor(Number(p?.ts || Math.floor(now)));
    const latency = p?.latency_ms == null ? null : Math.round(Number(p.latency_ms));
    const ok = p?.ok === undefined ? (Number.isFinite(latency) && latency >= 0 ? 1 : 0) : normalizeOkInt(p.ok);
    if (!targetId || !Number.isFinite(ts)) continue;
    accepted.push({ target_id: targetId, ts, latency_ms: Number.isFinite(latency) && latency >= 0 ? latency : null, ok });
  }
  if (accepted.length && env.ARCHIVE) await writeAgentTelemetryR2History(env, agentId, [], accepted);
  if (accepted.length && parseBoolean(env.AGENT_PINGS_TO_D1 ?? !env.ARCHIVE, !env.ARCHIVE)) {
    for (const p of accepted) {
      const bucketTs = Math.floor(Number(p.ts || now) / 60) * 60;
      stmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO ping_history (target_id, agent_id, ts, latency_ms, ok) VALUES (?, ?, ?, ?, ?)`
      ).bind(p.target_id, agentId, bucketTs, p.latency_ms, p.ok));
    }
  }
  if (stmts.length) {
    for (let i = 0; i < stmts.length; i += 50) {
      await env.DB.batch(stmts.slice(i, i + 50));
    }
    await env.DB.prepare(`DELETE FROM ping_history WHERE agent_id = ? AND ts < ?`)
      .bind(agentId, now - retentionSeconds(env, 'PING_HISTORY_RETENTION_HOURS', 6, 1, 72)).run();
  }
  return { ok: true, stored: accepted.length, storage: env.ARCHIVE ? 'r2' : 'd1', d1_rows: stmts.length };
}

export async function getAgentPings(env, url, ctx = null) {
  if (!env.DB) return { ok: true, targets: [], pings: [] };
  const agentId = sanitizeAgentId(url.searchParams.get('agent_id') || '');
  const hours = clamp(Number(url.searchParams.get('hours') || 24), 1, 168);
  const maxPerTargetRaw = url.searchParams.has('max_points_per_target') ? Number(url.searchParams.get('max_points_per_target')) : Number(env.AGENT_PINGS_MAX_POINTS_PER_TARGET || 360);
  const maxPerTarget = maxPerTargetRaw <= 0 ? 0 : clamp(maxPerTargetRaw, 30, 5000);
  const responseFormat = String(url.searchParams.get('format') || '').toLowerCase();
  const requestedUntil = nowSec();
  const since = requestedUntil - hours * 3600;
  let until = requestedUntil;
  try {
    const row = await env.DB.prepare(`SELECT updated_at FROM agent_metrics_state WHERE agent_id = ?`).bind(agentId).first();
    const latestTs = Math.floor(new Date(row?.updated_at || 0).getTime() / 1000);
    if (latestTs > 0) until = Math.min(requestedUntil, latestTs + 600);
  } catch (_) {}
  const byKey = new Map();
  const targets = await env.DB.prepare(`SELECT id, name FROM ping_targets WHERE enabled = 1`).all();
  const enabledTargetIds = new Set((targets.results || []).map(t => String(t.id)));
  const r2 = await loadAgentPingsR2History(env, agentId, since, until, [], ctx);
  for (const p of r2.pings || []) if (enabledTargetIds.has(String(p.target_id))) byKey.set(`${p.target_id}:${p.ts}`, p);
  try {
    const pings = await env.DB.prepare(
      `SELECT target_id, ts, latency_ms, ok FROM ping_history WHERE agent_id = ? AND ts >= ? ORDER BY ts ASC`
    ).bind(agentId, since).all();
    for (const p of pings.results || []) if (enabledTargetIds.has(String(p.target_id))) byKey.set(`${p.target_id}:${p.ts}`, {
      target_id: p.target_id,
      ts: Number(p.ts),
      latency_ms: p.latency_ms == null ? null : Number(p.latency_ms),
      ok: Number(p.ok || 0),
    });
  } catch (_) {}
  const rawPings = [...byKey.values()].sort((a, b) => a.ts - b.ts || a.target_id.localeCompare(b.target_id));
  const pings = maxPerTarget > 0 ? compactPingPointsByTarget(rawPings, maxPerTarget) : rawPings;
  const payload = {
    ok: true,
    targets: targets.results || [],
    pings: responseFormat === 'series' ? [] : pings,
    pings_raw_count: rawPings.length,
    pings_downsampled: rawPings.length > pings.length,
    source: r2.loaded ? 'r2+d1-fallback' : 'd1',
  };
  if (responseFormat === 'series') payload.series = pingPointsToSeries(pings);
  return payload;
}

function normalizeOkInt(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0 || value == null) return 0;
  const text = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'ok', 'up'].includes(text) ? 1 : 0;
}

// ── Ping targets CRUD ───────────────────────────────────────────────────────

export async function createPingTarget(request, env) {
  const body = await safeJson(request);
  const name = String(body?.name || '').trim();
  const target = String(body?.target || '').trim();
  if (!name || !target) return { ok: false, error: 'name and target (host:port) are required' };
  const id = sanitizeId(body?.id || name);
  const now = nowSec();
  await env.DB.prepare(`INSERT INTO ping_targets (id, name, target, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, target=excluded.target, updated_at=excluded.updated_at`).bind(id, name, target, now, now).run();
  return { ok: true, id };
}

export async function updatePingTarget(id, request, env) {
  const existing = await env.DB.prepare(`SELECT * FROM ping_targets WHERE id = ?`).bind(id).first();
  if (!existing) return { ok: false, error: 'Ping target not found' };
  const body = await safeJson(request);
  const name = body?.name !== undefined ? String(body.name || '').trim() : existing.name;
  const target = body?.target !== undefined ? String(body.target || '').trim() : existing.target;
  const enabled = body?.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled;
  await env.DB.prepare(`UPDATE ping_targets SET name = ?, target = ?, enabled = ?, updated_at = ? WHERE id = ?`).bind(name, target, enabled, nowSec(), id).run();
  return { ok: true, id };
}

export async function deletePingTarget(id, env) {
  await env.DB.prepare(`DELETE FROM ping_targets WHERE id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM ping_history WHERE target_id = ?`).bind(id).run();
  return { ok: true, id };
}

// ── Stats / diagnostics ──────────────────────────────────────────────────────

export async function getStats(env) {
  if (!env.DB) return { ok: true, note: 'No D1 binding' };
  const results = {};
  try {
    const tables = ['targets', 'check_buckets', 'latest_status', 'incident_events', 'agent_metrics_state', 'agent_metrics_history', 'agent_traffic_monthly', 'ping_targets', 'ping_history', 'rate_limits', 'app_meta'];
    for (const table of tables) {
      try {
        const row = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).first();
        results[table] = { rows: row?.cnt || 0 };
      } catch (_) { results[table] = { error: 'not found' }; }
    }
    // Check for probe gaps in the last hour
    const targetsCount = (await env.DB.prepare(`SELECT COUNT(*) as cnt FROM targets WHERE enabled = 1`).first())?.cnt || 0;
    const recentProbes = await env.DB.prepare(`SELECT target_id, COUNT(*) as cnt FROM check_buckets WHERE bucket_at >= ? GROUP BY target_id ORDER BY cnt ASC LIMIT 20`).bind(nowSec() - 3600).all();
    results.probe_status = { enabled_targets: targetsCount, recent_buckets_per_target: recentProbes.results || [] };
    // Agent metrics activity
    const agentState = await env.DB.prepare(`SELECT agent_id, updated_at FROM agent_metrics_state`).all();
    const now = nowSec();
    results.agent_status = (agentState.results || []).map(r => ({
      agent_id: r.agent_id,
      seconds_since_update: now - Math.floor(new Date(r.updated_at || 0).getTime() / 1000),
      online: (now - Math.floor(new Date(r.updated_at || 0).getTime() / 1000)) < 600
    }));
    // Estimated daily writes (rough estimate from recent data)
    const agentCount = agentState.results?.length || 0;
    const metricsPointsPerReport = clamp(Number(env.AGENT_METRICS_POINTS_PER_REPORT || 6), 1, 60);
    const metricsToD1 = parseBoolean(env.AGENT_METRICS_TO_D1 ?? !env.ARCHIVE, !env.ARCHIVE);
    const pingsToD1 = parseBoolean(env.AGENT_PINGS_TO_D1 ?? !env.ARCHIVE, !env.ARCHIVE);
    const pingTargetsCount = (await env.DB.prepare(`SELECT COUNT(*) as cnt FROM ping_targets WHERE enabled = 1`).first())?.cnt || 0;
    const agentReportsPerDay = agentCount * 288;
    const pingIntervalSec = clamp(Number(env.NSTATUS_PING_SEC || env.AGENT_PING_SEC || 20), 5, 600);
    results.estimated_daily = {
      check_bucket_writes: targetsCount * 288,
      agent_state_writes: agentReportsPerDay,
      agent_history_d1_writes: metricsToD1 ? agentReportsPerDay : 0,
      ping_history_d1_writes: pingsToD1 ? Math.ceil(agentCount * pingTargetsCount * 86400 / pingIntervalSec) : 0,
      agent_history_points_in_d1: metricsToD1 ? agentCount * metricsPointsPerReport * 288 : 0,
      agent_metric_points_in_r2: agentCount * 300 * 288,
      ping_points_in_r2: Math.ceil(agentCount * pingTargetsCount * 86400 / pingIntervalSec),
      r2_class_a_writes_month: agentReportsPerDay * 30,
      d1_rows_written_limit_per_day: 100000,
      storage_mode: env.ARCHIVE ? 'r2-primary' : 'd1-fallback',
      notes: 'R2-primary keeps high-frequency metric and ping history out of D1 unless AGENT_METRICS_TO_D1/AGENT_PINGS_TO_D1 are enabled.'
    };
  } catch (e) { results.error = String(e?.message || e); }
  return { ok: true, stats: results };
}

// ── Sync targets from env ────────────────────────────────────────────────────

export async function syncEnvTargetsMaybe(env) {
  const every = clamp(Number(env.TARGETS_SYNC_EVERY_SEC || 3600), 60, 86400);
  const last = Number(await getMeta(env, 'targets_last_sync_at') || 0);
  if (!last || last <= nowSec() - every) return syncEnvTargets(env, { force: false });
  return { ok: true, source: 'cache', last_sync_at: last };
}

export async function syncEnvTargets(env, opts = {}) {
  if (!env.TARGETS_JSON || !env.DB) return { ok: true, source: 'db', count: 0 };
  let parsed;
  try { parsed = JSON.parse(env.TARGETS_JSON); } catch (err) { throw new Error(`TARGETS_JSON parse failed: ${String(err?.message || err)}`); }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.targets) ? parsed.targets : null;
  if (!list) throw new Error('TARGETS_JSON must be an array or an object with a targets array');
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
    if (seenIds.has(id)) throw new Error(`Duplicate target id in TARGETS_JSON: ${id}`);
    const hasTrafficEnabled = hasOwn(item, 'traffic_enabled');
    const hasTrafficQuota = hasOwn(item, 'traffic_quota_gb');
    const hasTrafficMode = hasOwn(item, 'traffic_mode');
    seenIds.add(id); ids.push(id); normalizedItems.push({
      id,
      normalized,
      hasTrafficEnabled,
      trafficEnabled: hasTrafficEnabled ? (parseBoolean(item.traffic_enabled, false) ? 1 : 0) : 0,
      hasTrafficQuota,
      trafficQuotaGb: hasTrafficQuota ? normalizeTrafficQuotaGb(item.traffic_quota_gb) : 0,
      hasTrafficMode,
      trafficMode: hasTrafficMode ? normalizeTrafficMode(item.traffic_mode) : 'total',
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

// ── Archive ──────────────────────────────────────────────────────────────────

export async function archiveYesterdayOncePerLocalDay(env) {
  const afterSec = clamp(Number(env.DAILY_ARCHIVE_AFTER_SEC || 300), 0, 6 * 3600);
  const localNow = nowSec() + timezoneOffsetMin(env) * 60;
  const secInLocalDay = ((localNow % 86400) + 86400) % 86400;
  if (secInLocalDay < afterSec) return { ok: true, skipped: true, reason: 'too_early', after_sec: afterSec };
  const day = yesterdayLocal(env);
  const key = `daily_archive_done:${day}`;
  const done = await getMeta(env, key);
  if (done) return { ok: true, skipped: true, reason: 'already_done', day, done_at: done };
  const result = await archiveDay(env, day);
  if (result?.ok) await setMeta(env, key, String(nowSec()));
  return result;
}

export async function archiveDay(env, day) {
  if (!env.ARCHIVE) return { ok: false, error: 'R2 binding ARCHIVE is missing' };
  const targetRows = await env.DB.prepare(`SELECT * FROM targets WHERE enabled = 1 ORDER BY group_name, name`).all();
  const summaries = [];
  for (const target of targetRows.results || []) {
    const points = await readCheckBuckets(env, target.id, 2);
    summaries.push(...summaryRowsFromChecks(target.id, points, env).filter(row => row.day === day));
  }
  const dayStart = dayStartSecValue(day, env);
  const dayEnd = dayStart + 86400;
  const incidents = await env.DB.prepare(`SELECT * FROM incident_events WHERE (started_at >= ? AND started_at < ?) OR (recovered_at >= ? AND recovered_at < ?) OR (started_at < ? AND recovered_at IS NULL) ORDER BY COALESCE(recovered_at, started_at) ASC`).bind(dayStart, dayEnd, dayStart, dayEnd, dayEnd).all();
  const key = `daily-summary/${day}.json`;
  await env.ARCHIVE.put(key, JSON.stringify({ schema: 'nstatus-daily-summary-v6', day, exported_at: new Date().toISOString(), summaries, incidents: incidents.results || [] }), { httpMetadata: { contentType: 'application/json; charset=utf-8' }, customMetadata: { day, rows: String(summaries.length) } });
  return { ok: true, key, summary_rows: summaries.length, incident_rows: (incidents.results || []).length };
}

function dayStartSecValue(day, env) { return Math.floor(new Date(`${day}T00:00:00.000Z`).getTime() / 1000) - timezoneOffsetMin(env) * 60; }

// ── Incidents ────────────────────────────────────────────────────────────────

export async function getRecentIncidents(env, limit, maskIps, hidePorts = true) {
  const rows = await env.DB.prepare(`SELECT i.id, i.target_id, i.started_at, i.recovered_at, i.last_checked_at, i.start_colo, i.recover_colo, i.last_error, t.name, t.group_name, t.type, t.target_host, t.target_port, t.url, t.probe_region FROM incident_events i LEFT JOIN targets t ON t.id = i.target_id ORDER BY COALESCE(i.recovered_at, i.started_at) DESC LIMIT ?`).bind(limit).all();
  return (rows.results || []).map(row => {
    const displayHost = row.type === 'tcp' ? publicHost(row.target_host, maskIps) : row.target_host;
    const displayUrl = row.type === 'http' ? publicUrl(row.url, env) : row.url;
    const publicRow = { ...row, target_host: row.type === 'tcp' ? displayHost : row.target_host, url: row.type === 'http' ? displayUrl : row.url, target: row.type === 'http' ? displayUrl : displayHost, last_error: publicError(row.last_error, null), start_colo: null, recover_colo: null, region_label: REGION_LABELS[row.probe_region || 'auto'] || row.probe_region || 'Auto' };
    if (hidePorts) delete publicRow.target_port;
    return publicRow;
  });
}

// ── D1 state write ───────────────────────────────────────────────────────────

function latestStatusStatement(env, s) {
  return env.DB.prepare(`
    INSERT INTO latest_status (target_id, checked_at, ok, latency_ms, status_code, error, probe_region, cf_colo, uptime_24h, uptime_7d, avg_latency_24h, last_fail_at, current_outage_started_at, last_recover_at, status_changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(target_id) DO UPDATE SET
      checked_at=excluded.checked_at, ok=excluded.ok, latency_ms=excluded.latency_ms,
      status_code=excluded.status_code, error=excluded.error, probe_region=excluded.probe_region, cf_colo=excluded.cf_colo,
      uptime_24h=excluded.uptime_24h, uptime_7d=excluded.uptime_7d, avg_latency_24h=excluded.avg_latency_24h,
      last_fail_at=excluded.last_fail_at, current_outage_started_at=excluded.current_outage_started_at,
      last_recover_at=excluded.last_recover_at, status_changed_at=excluded.status_changed_at
    WHERE excluded.checked_at >= latest_status.checked_at
  `).bind(
    s.target_id, s.checked_at, s.ok, s.latency_ms, s.status_code,
    s.error ? String(s.error).slice(0, 500) : null,
    s.probe_region || 'auto', s.cf_colo || null, s.uptime_24h, s.uptime_7d, s.avg_latency_24h,
    s.last_fail_at, s.current_outage_started_at, s.last_recover_at, s.status_changed_at
  );
}

export async function upsertLatestStatus(env, s) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  try {
    await latestStatusStatement(env, s).run();
    return { ok: true };
  } catch (err) {
    console.error('upsertLatestStatus failed', err);
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function writeIncidentEvent(env, targetId, action, startedAt, recoveredAt, colo, error) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  try {
    const stmt = incidentEventStatement(env, targetId, action, startedAt, recoveredAt, colo, error);
    if (stmt) await stmt.run();
    return { ok: true };
  } catch (err) {
    console.error('writeIncidentEvent failed', err);
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function touchActiveIncident(env, targetId, checkedAt, colo, error) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  try {
    await touchActiveIncidentStatement(env, targetId, checkedAt, colo, error).run();
    return { ok: true };
  } catch (err) {
    console.error('touchActiveIncident failed', err);
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function upsertTargetLastCheckedAt(env, targetId, checkedAt) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  const ts = Number.isFinite(Number(checkedAt)) ? Math.floor(Number(checkedAt)) : null;
  if (!ts) return { ok: false, skipped: true, reason: 'invalid_timestamp' };
  try {
    await targetLastCheckedStatement(env, targetId, ts).run();
    return { ok: true };
  } catch (err) {
    console.error('upsertTargetLastCheckedAt failed', err);
    return { ok: false, error: String(err?.message || err) };
  }
}

// ── D1 check buckets ────────────────────────────────────────────────────────

function incidentEventStatement(env, targetId, action, startedAt, recoveredAt, colo, error) {
  const now = nowSec();
  if (action === 'started') {
    return env.DB.prepare(`INSERT OR IGNORE INTO incident_events (id, target_id, started_at, last_checked_at, start_colo, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(`${targetId}-${startedAt}`, targetId, startedAt, startedAt, colo || null, error ? String(error).slice(0, 500) : null, now, now);
  }
  if (action === 'recovered') {
    return env.DB.prepare(`UPDATE incident_events SET recovered_at = ?, last_checked_at = ?, recover_colo = ?, last_error = NULL, updated_at = ? WHERE target_id = ? AND recovered_at IS NULL`)
      .bind(recoveredAt, recoveredAt || startedAt || null, colo || null, now, targetId);
  }
  return null;
}

function touchActiveIncidentStatement(env, targetId, checkedAt, colo, error) {
  return env.DB.prepare(`UPDATE incident_events SET last_checked_at = ?, last_error = ?, updated_at = ? WHERE target_id = ? AND recovered_at IS NULL`)
    .bind(checkedAt, error ? String(error).slice(0, 500) : null, nowSec(), targetId);
}

function targetLastCheckedStatement(env, targetId, checkedAt) {
  return env.DB.prepare(`UPDATE targets SET last_checked_at = CASE WHEN last_checked_at IS NULL OR last_checked_at < ? THEN ? ELSE last_checked_at END WHERE id = ?`).bind(checkedAt, checkedAt, targetId);
}

function normalizeCheckBucketPoint(point) {
  const missed = isMissedMonitorPoint(point);
  const total = point.total == null ? 1 : Math.max(0, Number(point.total || 0));
  const okCount = point.ok_count == null ? (point.ok ? 1 : 0) : Math.max(0, Number(point.ok_count || 0));
  return {
    missed,
    total: missed ? Math.max(1, total || 1) : total,
    okCount: missed ? 0 : okCount,
    ok: missed ? 0 : (point.ok == null ? 0 : Number(point.ok)),
    latencyMs: missed ? null : (point.latency_ms == null ? null : Number(point.latency_ms)),
    statusCode: missed ? null : (point.status_code == null ? null : Number(point.status_code)),
    error: point.error == null ? null : String(point.error).slice(0, 500),
    probeRegion: point.probe_region || 'auto',
    cfColo: point.cf_colo || null,
  };
}

function checkBucketStatement(env, targetId, day, point) {
  const normalized = normalizeCheckBucketPoint(point);
  return env.DB.prepare(`
      INSERT INTO check_buckets (target_id, bucket_at, day, total, ok_count, sum_latency_ms, last_ok, last_latency_ms, last_status_code, last_error, probe_region, cf_colo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_id, bucket_at) DO UPDATE SET
        day=excluded.day, 
        total=excluded.total, 
        ok_count=excluded.ok_count, 
        sum_latency_ms=excluded.sum_latency_ms,
        last_ok=excluded.last_ok, last_latency_ms=excluded.last_latency_ms,
        last_status_code=excluded.last_status_code, last_error=excluded.last_error,
        probe_region=excluded.probe_region, cf_colo=excluded.cf_colo
    `).bind(
      targetId, point.checked_at, day,
      normalized.total,
      normalized.okCount,
      normalized.latencyMs == null ? 0 : Number(normalized.latencyMs),
      normalized.ok,
      normalized.latencyMs,
      normalized.statusCode,
      normalized.error,
      normalized.probeRegion,
      normalized.cfColo
    );
}

export async function upsertCheckBucket(env, targetId, day, point) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  try {
    await checkBucketStatement(env, targetId, day, point).run();
    return { ok: true };
  } catch (err) {
    console.error('upsertCheckBucket failed', err);
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function readCheckBuckets(env, targetId, days) {
  if (!env.DB) return [];
  try {
    const rows = await env.DB.prepare(
      `SELECT bucket_at as checked_at, last_ok as ok, last_latency_ms as latency_ms, last_status_code as status_code, last_error as error, probe_region, total, ok_count FROM check_buckets WHERE target_id = ? AND bucket_at >= ? ORDER BY bucket_at ASC`
    ).bind(targetId, nowSec() - days * 86400).all();
    const stored = (rows.results || []).map(r => ({
      missed: isMissedMonitorPoint(r) || (Number(r.total || 0) === 0 && Number(r.ok_count || 0) === 0),
      checked_at: Number(r.checked_at || 0),
      ok: isMissedMonitorPoint(r) ? 0 : Number(r.ok || 0),
      latency_ms: isMissedMonitorPoint(r) ? null : (r.latency_ms == null ? null : Number(r.latency_ms)),
      status_code: isMissedMonitorPoint(r) ? null : (r.status_code == null ? null : Number(r.status_code)),
      error: r.error == null ? null : String(r.error),
      probe_region: r.probe_region || 'auto',
      total: isMissedMonitorPoint(r) ? Math.max(1, Number(r.total || 0) || 1) : Number(r.total || 0),
      ok_count: isMissedMonitorPoint(r) ? 0 : Number(r.ok_count || 0),
      bucket: true,
    })).filter(r => Number(r.checked_at) > 0);
    if (!stored.length) return stored;
    const out = [stored[0]];
    for (let i = 1; i < stored.length; i++) {
      const previous = out[out.length - 1];
      const current = stored[i];
      const missed = buildMissedPoints(env, previous, current.checked_at, current.ok, current.probe_region);
      if (missed.length) out.push(...missed);
      out.push(current);
    }
    const tail = buildOpenMissedPoints(env, out[out.length - 1], nowSec(), out[out.length - 1]?.probe_region);
    if (tail.length) out.push(...tail);
    return out;
  } catch (_) { return []; }
}

export async function getCheckBucketSummaries(env, startDay) {
  if (!env.DB) return [];
  try {
    const rows = await env.DB.prepare(
      `SELECT target_id, day,
              SUM(CASE WHEN last_error LIKE '%monitor missed this 5-minute check%' THEN 1 ELSE total END) as total,
              SUM(CASE WHEN last_error LIKE '%monitor missed this 5-minute check%' THEN 0 ELSE ok_count END) as ok_count,
              SUM(CASE WHEN last_error LIKE '%monitor missed this 5-minute check%' THEN 0 ELSE sum_latency_ms END) as sum_latency_ms
       FROM check_buckets
       WHERE day >= ?
       GROUP BY target_id, day
       ORDER BY day ASC, target_id ASC`
    ).bind(startDay).all();
    const byKey = new Map();
    for (const row of rows.results || []) {
      byKey.set(`${row.target_id}|${row.day}`, {
        target_id: row.target_id,
        day: row.day,
        total: Number(row.total || 0),
        ok_count: Number(row.ok_count || 0),
        sum_latency_ms: Number(row.sum_latency_ms || 0),
      });
    }
    const latestRows = await env.DB.prepare(`SELECT target_id, checked_at, ok, latency_ms, status_code, error, probe_region FROM latest_status`).all().catch(() => ({ results: [] }));
    for (const row of latestRows.results || []) {
      if (Number(row.ok || 0) !== 1 || !Number(row.checked_at || 0)) continue;
      const synthetic = buildOpenMissedPoints(env, row, nowSec(), row.probe_region || 'auto');
      if (!synthetic.length) continue;
      const summaries = summaryRowsFromChecks(row.target_id, synthetic, env);
      for (const summary of summaries) {
        if (summary.day < startDay) continue;
        const key = `${summary.target_id}|${summary.day}`;
        const existing = byKey.get(key) || { target_id: summary.target_id, day: summary.day, total: 0, ok_count: 0, sum_latency_ms: 0 };
        existing.total += Number(summary.total || 0);
        existing.ok_count += Number(summary.ok_count || 0);
        existing.sum_latency_ms += Number(summary.sum_latency_ms || 0);
        byKey.set(key, existing);
      }
    }
    return [...byKey.values()].sort((a, b) => a.day.localeCompare(b.day) || a.target_id.localeCompare(b.target_id));
  } catch (_) { return []; }
}

export async function applyProbeWriteBatch(env, targetId, checkedAt, bucketWrites, latestStatus, incidentWrite = null) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  const stmts = [];
  for (const item of bucketWrites || []) {
    if (!item?.point || !item.day) continue;
    stmts.push(checkBucketStatement(env, targetId, item.day, item.point));
  }
  if (latestStatus) stmts.push(latestStatusStatement(env, latestStatus));
  if (incidentWrite) {
    const incidentStmt = incidentEventStatement(env, targetId, incidentWrite.action, incidentWrite.started_at, incidentWrite.recovered_at, incidentWrite.colo, incidentWrite.error);
    if (incidentStmt) stmts.push(incidentStmt);
  }
  if (incidentWrite?.action === 'still_down') stmts.push(touchActiveIncidentStatement(env, targetId, checkedAt, incidentWrite.colo, incidentWrite.error));
  stmts.push(targetLastCheckedStatement(env, targetId, checkedAt));
  await env.DB.batch(stmts);
  return { ok: true, writes: stmts.length };
}

export async function cleanupOldCheckBuckets(env, daysToKeep = 31) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(`DELETE FROM check_buckets WHERE bucket_at < ?`).bind(nowSec() - daysToKeep * 86400).run();
  } catch (_) { console.error('cleanupOldCheckBuckets failed'); }
}

export async function getAgentInstallCommand(env, url, request = null) {
  const globalAgentToken = String(env.AGENT_TOKEN || '').trim();
  if (!globalAgentToken) return { ok: false, error: 'AGENT_TOKEN is not configured on Worker' };

  const targetId = sanitizeAgentId(url.searchParams.get('target_id') || '');
  if (!targetId) return { ok: false, error: 'target_id is required' };

  const target = await env.DB.prepare(`SELECT id, name FROM targets WHERE id = ?`).bind(targetId).first().catch(() => null);
  const label = String(target?.name || targetId).trim() || targetId;
  const agentToken = await agentScopedToken(env, targetId);
  if (!agentToken) return { ok: false, error: 'failed to generate scoped agent token' };
  const installBase = agentInstallBase(env, request);
  if (!installBase) return { ok: false, error: 'Agent install base is unavailable. Open admin from the public frontend domain or set PUBLIC_AGENT_INSTALL_BASE.' };
  const apiBase = agentApiBase(env, request, url, installBase);
  const pingTargets = String(env.NSTATUS_PING_TARGETS || env.AGENT_PING_TARGETS || '*').trim() || '*';
  const pingSec = String(clamp(Number(env.NSTATUS_PING_SEC || env.AGENT_PING_SEC || 20), 5, 600));
  const unlockCheckEnabled = String(env.NSTATUS_UNLOCK_CHECK_ENABLED ?? env.AGENT_UNLOCK_CHECK_ENABLED ?? '1').trim() || '1';
  const unlockCheckSec = String(clamp(Number(env.NSTATUS_UNLOCK_CHECK_SEC || env.AGENT_UNLOCK_CHECK_SEC || 300), 60, 86400));
  const unlockCheckUrl = String(env.NSTATUS_UNLOCK_CHECK_URL || env.AGENT_UNLOCK_CHECK_URL || 'https://IP.Check.Place').trim() || 'https://IP.Check.Place';
  const unlockCheckTimeout = String(clamp(Number(env.NSTATUS_UNLOCK_CHECK_TIMEOUT_SEC || env.AGENT_UNLOCK_CHECK_TIMEOUT_SEC || 90), 15, 300));
  const sha256SumsSha256 = String(env.NSTATUS_SHA256SUMS_SHA256 || 'e9ca6fa4a31f91efaacfc8e3dfcf65c524f1a2e8c5024babc6b67883b46a58be').trim();

  const linuxEnvNames = [
    'NSTATUS_AGENT_BASE_URL',
    'DOWNLOAD_BASE',
    'CFTZ_URL_BASE',
    'NSTATUS_API_BASE',
    'NSTATUS_AGENT_TOKEN',
    'NSTATUS_AGENT_ID',
    'NSTATUS_AGENT_LABEL',
    'NSTATUS_PING_TARGETS',
    'NSTATUS_PING_SEC',
    'NSTATUS_UNLOCK_CHECK_ENABLED',
    'NSTATUS_UNLOCK_CHECK_SEC',
    'NSTATUS_UNLOCK_CHECK_URL',
    'NSTATUS_UNLOCK_CHECK_TIMEOUT_SEC',
    'NSTATUS_SHA256SUMS_SHA256',
  ];
  const linuxEnv = [
    ['NSTATUS_AGENT_BASE_URL', installBase],
    ['DOWNLOAD_BASE', installBase],
    ['CFTZ_URL_BASE', installBase],
    ['NSTATUS_API_BASE', apiBase],
    ['NSTATUS_AGENT_TOKEN', agentToken],
    ['NSTATUS_AGENT_ID', targetId],
    ['NSTATUS_AGENT_LABEL', label],
    ['NSTATUS_PING_TARGETS', pingTargets],
    ['NSTATUS_PING_SEC', pingSec],
    ['NSTATUS_UNLOCK_CHECK_ENABLED', unlockCheckEnabled],
    ['NSTATUS_UNLOCK_CHECK_SEC', unlockCheckSec],
    ['NSTATUS_UNLOCK_CHECK_URL', unlockCheckUrl],
    ['NSTATUS_UNLOCK_CHECK_TIMEOUT_SEC', unlockCheckTimeout],
    ['NSTATUS_SHA256SUMS_SHA256', sha256SumsSha256],
  ].map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
  const linuxPreserveEnv = linuxEnvNames.join(',');
  const linuxRunner = `(if [ "$(id -u)" -eq 0 ]; then sh "$tmp" --non-interactive; else sudo --preserve-env=${linuxPreserveEnv} sh "$tmp" --non-interactive; fi)`;
  const linuxCommand = [
    `${linuxEnv}; export ${linuxEnvNames.join(' ')}`,
    `tmp=$(mktemp)`,
    `trap 'rm -f "$tmp"' EXIT`,
    `curl -fsSL ${shellQuote(`${installBase}/install.sh`)} -o "$tmp"`,
    linuxRunner,
  ].join(' && ');

  const windowsCommand = [
    `$env:NSTATUS_API_BASE=${psQuote(apiBase)}`,
    `$env:NSTATUS_AGENT_TOKEN=${psQuote(agentToken)}`,
    `$env:NSTATUS_AGENT_ID=${psQuote(targetId)}`,
    `$env:NSTATUS_AGENT_LABEL=${psQuote(label)}`,
    `$env:NSTATUS_PING_TARGETS=${psQuote(pingTargets)}`,
    `$env:NSTATUS_PING_SEC=${psQuote(pingSec)}`,
    `$env:DOWNLOAD_BASE=${psQuote(installBase)}`,
    `$env:NSTATUS_SHA256SUMS_SHA256=${psQuote(sha256SumsSha256)}`,
    `$installer=Join-Path $env:TEMP 'nstatus-install.ps1'`,
    `Invoke-WebRequest -UseBasicParsing ${psQuote(`${installBase}/install.ps1`)} -OutFile $installer`,
    `powershell -ExecutionPolicy RemoteSigned -File $installer`,
    `Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue`,
  ].join('; ');

  return {
    ok: true,
    target_id: targetId,
    target_label: label,
    api_base: apiBase,
    install_base: installBase,
    linux_command: linuxCommand,
    windows_command: windowsCommand,
  };
}

function agentApiBase(env, request = null, url = null, installBase = '') {
  const explicit = String(env.PUBLIC_AGENT_API_BASE || env.AGENT_API_BASE || env.PUBLIC_API_BASE || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const publicOrigin = publicRequestOrigin(request);
  if (publicOrigin) return publicOrigin.replace(/\/+$/, '');

  const workerUrl = String(env.PUBLIC_WORKER_URL || '').trim();
  if (workerUrl) return workerUrl.replace(/\/+$/, '');

  if (installBase) return installBase.replace(/\/+$/, '');
  return String(url ? `${url.protocol}//${url.host}` : '').replace(/\/+$/, '');
}

function agentInstallBase(env, request = null) {
  const explicit = String(env.PUBLIC_AGENT_INSTALL_BASE || env.AGENT_INSTALL_BASE || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const origin = publicRequestOrigin(request);
  return origin ? origin.replace(/\/+$/, '') : '';
}

function publicRequestOrigin(request = null) {
  const origin = String(request?.headers?.get?.('origin') || '').trim();
  if (isPublicHttpOrigin(origin)) return origin;

  const referer = String(request?.headers?.get?.('referer') || '').trim();
  try {
    const u = new URL(referer);
    const value = `${u.protocol}//${u.host}`;
    if (isPublicHttpOrigin(value)) return value;
  } catch (_) {}

  return '';
}

function isPublicHttpOrigin(value) {
  try {
    const u = new URL(String(value || ''));
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
  } catch (_) {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function psQuote(value) {
  return `"${String(value ?? '').replace(/`/g, '``').replace(/"/g, '`"')}"`;
}

export async function cleanupVolatileHistory(env, options = {}) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  const now = nowSec();
  const agentRetention = clamp(Number(options.agent_hours || env.AGENT_METRICS_RETENTION_HOURS || 6), 1, 72) * 3600;
  const pingRetention = clamp(Number(options.ping_hours || env.PING_HISTORY_RETENTION_HOURS || 6), 1, 72) * 3600;
  const agentCutoff = now - agentRetention;
  const pingCutoff = now - pingRetention;
  const results = { ok: true, agent_cutoff: agentCutoff, ping_cutoff: pingCutoff, agent_changes: 0, ping_changes: 0, errors: [] };

  const agentIds = new Set();
  const pingAgentIds = new Set();
  try {
    const rows = await env.DB.prepare(`SELECT agent_id FROM agent_metrics_state`).all();
    for (const row of rows.results || []) {
      if (!row.agent_id) continue;
      agentIds.add(String(row.agent_id));
      pingAgentIds.add(String(row.agent_id));
    }
  } catch (err) { results.errors.push(`agent id list: ${String(err?.message || err)}`); }
  if (parseBoolean(env.AGENT_PINGS_TO_D1 ?? !env.ARCHIVE, !env.ARCHIVE)) {
    try {
      const rows = await env.DB.prepare(`SELECT DISTINCT agent_id FROM ping_history WHERE ts < ? LIMIT 200`).bind(pingCutoff).all();
      for (const row of rows.results || []) if (row.agent_id) pingAgentIds.add(String(row.agent_id));
    } catch (err) { results.errors.push(`ping id list: ${String(err?.message || err)}`); }
  }

  if (parseBoolean(env.AGENT_METRICS_TO_D1 ?? !env.ARCHIVE, !env.ARCHIVE)) {
    for (const agentId of agentIds) {
      try {
        const res = await env.DB.prepare(`DELETE FROM agent_metrics_history WHERE agent_id = ? AND ts < ?`).bind(agentId, agentCutoff).run();
        results.agent_changes += Number(res?.meta?.changes || 0);
      } catch (err) { results.errors.push(`agent ${agentId}: ${String(err?.message || err)}`); }
    }
  }
  if (parseBoolean(env.AGENT_PINGS_TO_D1 ?? !env.ARCHIVE, !env.ARCHIVE)) {
    for (const agentId of pingAgentIds) {
      try {
        const res = await env.DB.prepare(`DELETE FROM ping_history WHERE agent_id = ? AND ts < ?`).bind(agentId, pingCutoff).run();
        results.ping_changes += Number(res?.meta?.changes || 0);
      } catch (err) { results.errors.push(`ping ${agentId}: ${String(err?.message || err)}`); }
    }
  }
  results.ok = results.errors.length === 0;
  return results;
}
