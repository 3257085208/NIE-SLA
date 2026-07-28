import { sanitizeAgentId, clamp, dayFromSec, nowSec, retentionSeconds, parseBoolean } from './utils.js';
import { summarizeTraffic, summarizeTrafficWithPending, trafficSettingsFromTarget } from './traffic.js';
import { requireAgentForId, safeJson, json } from './auth.js';
import { readR2Json, writeR2Json } from './storage.js';
import { rateLimitByIp } from './ratelimit.js';
import { recordAgentAvailability } from './agent-availability.js';
import { ensureAgentCapabilitiesColumn, isMissingAgentCapabilitiesColumn } from './admin/schema.js';
import { appendBufferedAgentTelemetry, deleteBufferedAgentTelemetry, readBufferedAgentTelemetry } from './telemetry-buffer.js';

const MAX_AGENT_SAMPLES_PER_REPORT = 310;
const MAX_AGENT_PINGS_PER_REPORT = 5_000;
const MAX_TELEMETRY_HOURS_PER_REPORT = 25;
const MAX_TELEMETRY_AGE_SEC = 7 * 86400;
const MAX_TELEMETRY_FUTURE_SEC = 300;
const AGENT_ACTIONS = new Set(['nodequality', 'ip_unlock']);

export function normalizeAgentCapabilities(value, observedAt = nowSec()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Number(value.protocol) !== 1) return null;
  const mode = ['manager', 'compatibility', 'telemetry_only'].includes(String(value.mode || ''))
    ? String(value.mode)
    : 'telemetry_only';
  let actions = Array.isArray(value.actions)
    ? [...new Set(value.actions.map(action => String(action || '').trim()).filter(action => AGENT_ACTIONS.has(action)))].slice(0, 8)
    : [];
  if (mode === 'compatibility') actions = actions.filter(action => action === 'ip_unlock');
  if (mode === 'telemetry_only') actions = [];
  const privileged = mode === 'manager' && value.privileged === true;
  if (!privileged) actions = actions.filter(action => action !== 'nodequality');
  const managerVersion = /^v?\d+\.\d+\.\d+$/.test(String(value.manager_version || ''))
    ? String(value.manager_version).slice(0, 32)
    : null;
  const updateState = ['current', 'restarting'].includes(String(value.update_state || ''))
    ? String(value.update_state)
    : null;
  return {
    protocol: 1,
    mode,
    manager_version: managerVersion,
    privileged,
    actions,
    service_schema: privileged ? clamp(Number(value.service_schema || 0), 0, 1000) : 0,
    update_state: updateState,
    observed_at: Math.floor(Number(observedAt) || nowSec()),
  };
}

export async function submitAgentMetrics(request, env, ctx = null) {
  if (!env.DB) return json({ ok: false, error: '缺少 D1 的 DB 绑定' }, 500, env);

  const body = await safeJson(request);
  const agentId = sanitizeAgentId(body?.agent_id || env.DEFAULT_AGENT_ID || 'vps');
  await requireAgentForId(request, env, agentId);
  if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) {
    return json({ ok: false, error: '请求过于频繁，请稍后重试。' }, 429, env);
  }
  const agentLabel = String(body?.agent_label || agentId).trim().slice(0, 64) || agentId;
  const agentVersion = String(body?.agent_version || '').trim().slice(0, 32) || null;
  const capabilities = normalizeAgentCapabilities(body?.capabilities);
  const metrics = body?.metrics;
  if (!metrics || typeof metrics !== 'object') return json({ ok: false, error: '必须提供 metrics 对象' }, 400, env);
  const rawSamples = Array.isArray(metrics.samples) ? metrics.samples : [];
  if (rawSamples.length > MAX_AGENT_SAMPLES_PER_REPORT) return json({ ok: false, error: `too many samples; max ${MAX_AGENT_SAMPLES_PER_REPORT}` }, 400, env);
  const serialized = JSON.stringify(metrics);
  if (serialized.length > 200_000) return json({ ok: false, error: 'metrics 数据过大' }, 400, env);

  const ts = nowSec();

  const state = {
    cpu_percent: Number(metrics.cpu_percent) || 0,
    process_count: Number(metrics.process_count) || 0,
    thread_count: Number(metrics.thread_count ?? metrics.process_count) || 0,
    memory: metrics.memory || {},
    load: metrics.load || {},
    disk: metrics.disk || {},
    net: metrics.net || {},
    diskio: metrics.diskio || {},
    stats: metrics.stats || null,
    uptime_sec: Number(metrics.uptime_sec) || 0,
  };

  const vpsInfo = metrics.vps_info && typeof metrics.vps_info === 'object' ? metrics.vps_info : null;
  const pings = Array.isArray(metrics.pings) ? metrics.pings : [];
  const telemetryError = validateTelemetryBatch(rawSamples, pings, ts);
  if (telemetryError) return json({ ok: false, error: telemetryError }, 400, env);

  try {
    await persistAgentMetrics(env, { agentId, agentLabel, agentVersion, capabilities, metrics, state, vpsInfo, rawSamples, pings, ts });
  } catch (err) {
    console.error('persistAgentMetrics failed:', String(err?.message || err));
    return json({ ok: false, error: '保存 Agent 监控数据失败' }, 500, env, { 'cache-control': 'no-store' });
  }

  const trafficTask = persistAgentTraffic(env, agentId, metrics, ts)
    .catch((err) => console.error('persistAgentTraffic failed:', String(err?.message || err)));
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(trafficTask);
  else await trafficTask;

  return json({
    ok: true,
    agent_id: agentId,
  }, 200, env, { 'cache-control': 'no-store' });
}

export async function getAgentMetrics(env, url, ctx = null) {
  if (!env.DB) return json({ ok: true, latest: null, history: [] }, 200, env);

  const agentId = sanitizeAgentId(url.searchParams.get('agent_id') || env.DEFAULT_AGENT_ID || 'vps');
  const { hours, maxPoints } = resolvePublicMetricsQuery(url, env);
  const includeHistory = url.searchParams.get('history') !== '0';
  const responseFormat = String(url.searchParams.get('format') || '').toLowerCase();
  const fields = metricFieldsForRequest(url.searchParams.get('metric') || url.searchParams.get('fields') || '');

  let latest = null;
  let latestTs = 0;
  try {
    const row = await env.DB.prepare(`SELECT * FROM agent_metrics_state WHERE agent_id = ?`).bind(agentId).first();
    if (row) {
      const net = parseJsonSafe(row.net);
      if (net) { delete net.rx_raw; delete net.tx_raw; delete net.rx_bytes; delete net.tx_bytes; }
      latest = {
        schema: 'nstatus-agent-metrics-v1', agent_id: row.agent_id, agent_label: row.agent_label,
        agent_version: row.agent_version || null,
        updated_at: row.updated_at, cpu_percent: row.cpu_percent,
        process_count: Number(row.process_count || 0) || 0,
        thread_count: Number(row.thread_count || row.process_count || 0) || 0,
        memory: parseJsonSafe(row.memory), load: parseJsonSafe(row.load), disk: parseJsonSafe(row.disk),
        net, diskio: parseJsonSafe(row.diskio),
        stats: row.stats ? parseJsonSafe(row.stats) : null, uptime_sec: row.uptime_sec,
        vps_info: row.vps_info ? parseJsonSafe(row.vps_info) : null,
        pings: row.pings ? parseJsonSafe(row.pings) : [],
      };
      latest.traffic = await readAgentTraffic(env, agentId);
      latestTs = Math.floor(new Date(latest.updated_at || 0).getTime() / 1000);
    }
  } catch (_) {}

  const requestedUntil = nowSec();
  const until = includeHistory && latestTs > 0 ? Math.min(requestedUntil, latestTs + 600) : requestedUntil;
  const since = requestedUntil - hours * 3600;
  const historyByTs = new Map();
  const r2 = includeHistory ? await loadAgentMetricsR2History(env, agentId, since, until, historyByTs, fields, ctx) : { loaded: false, count: 0 };
  const d1Fallback = includeHistory && parseBoolean(env.AGENT_METRICS_D1_FALLBACK ?? !env.ARCHIVE, !env.ARCHIVE);
  if (includeHistory && d1Fallback) {
    await loadAgentMetricsD1History(env, agentId, since, historyByTs);
  }
  const rawHistory = [...historyByTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, pt]) => selectMetricFields(pt, fields));
  const history = compactMetricPoints(rawHistory, maxPoints);
  const source = env.ARCHIVE
    ? (r2.loaded ? (d1Fallback ? 'r2+d1-fallback' : 'r2') : (d1Fallback ? 'd1-fallback' : 'r2-empty'))
    : 'd1';
  const payload = {
    ok: true,
    latest,
    history: responseFormat === 'columns' ? [] : history,
    history_raw_count: rawHistory.length,
    history_downsampled: rawHistory.length > history.length,
    source,
    traffic: await readAgentTraffic(env, agentId),
  };
  if (responseFormat === 'columns') payload.series = metricPointsToColumns(history, fields);

  return json(payload, 200, env, { 'cache-control': 'public, max-age=15' });
}

export async function getAgentMetricsCached(request, env, url, ctx = null) {
  if (!globalThis.caches?.default || request.method !== 'GET') return getAgentMetrics(env, url, ctx);
  const cacheUrl = normalizedMetricsCacheUrl(url, env);
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;
  const response = await getAgentMetrics(env, url, ctx);
  if (response.ok) {
    const task = caches.default.put(cacheKey, response.clone());
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
    else await task;
  }
  return response;
}

function normalizedMetricsCacheUrl(url, env) {
  const normalized = new URL(url.origin + '/api/agent/metrics');
  const { hours, maxPoints } = resolvePublicMetricsQuery(url, env);
  normalized.searchParams.set('agent_id', sanitizeAgentId(url.searchParams.get('agent_id') || env.DEFAULT_AGENT_ID || 'vps'));
  normalized.searchParams.set('hours', String(hours));
  normalized.searchParams.set('max_points', String(maxPoints));
  normalized.searchParams.set('history', url.searchParams.get('history') === '0' ? '0' : '1');
  normalized.searchParams.set('format', String(url.searchParams.get('format') || '').toLowerCase() === 'columns' ? 'columns' : 'rows');
  normalized.searchParams.set('fields', (metricFieldsForRequest(url.searchParams.get('metric') || url.searchParams.get('fields') || '') || []).join(','));
  return normalized;
}

/** Public metrics query hard caps: never allow unlimited (max_points<=0) raw history. */
export function resolvePublicMetricsQuery(url, env = {}) {
  const publicMaxHours = clamp(Number(env.AGENT_METRICS_PUBLIC_MAX_HOURS || 72), 1, 168);
  const hours = clamp(Math.floor(Number(url.searchParams.get('hours') || 24)), 1, publicMaxHours);
  const hardMax = clamp(Number(env.AGENT_METRICS_HARD_MAX_POINTS || 4000), 60, 10000);
  const defaultMax = defaultMetricsMaxPointsForHours(hours, env);
  let maxPointsRaw = url.searchParams.has('max_points')
    ? Number(url.searchParams.get('max_points'))
    : defaultMax;
  if (!Number.isFinite(maxPointsRaw) || maxPointsRaw <= 0) maxPointsRaw = defaultMax;
  const maxPoints = clamp(Math.floor(maxPointsRaw), 60, hardMax);
  return { hours, maxPoints, defaultMax, hardMax, publicMaxHours };
}

export function defaultMetricsMaxPointsForHours(hours, env = {}) {
  const h = Number(hours) || 24;
  if (h <= 1) return clamp(Number(env.AGENT_METRICS_MAX_POINTS_1H || 3600), 60, 10000);
  if (h <= 6) return clamp(Number(env.AGENT_METRICS_MAX_POINTS_6H || 1800), 60, 10000);
  if (h <= 24) return clamp(Number(env.AGENT_METRICS_MAX_POINTS_24H || 1200), 60, 10000);
  return clamp(Number(env.AGENT_METRICS_MAX_POINTS || 900), 60, 10000);
}

function validateTelemetryBatch(samples, pings, now) {
  if (pings.length > MAX_AGENT_PINGS_PER_REPORT) return `too many pings; max ${MAX_AGENT_PINGS_PER_REPORT}`;
  const hours = new Set();
  const validatePoint = (point, kind) => {
    const ts = Math.floor(Number(point?.ts || 0));
    if (!Number.isFinite(ts) || ts <= 0) return `${kind} has an invalid timestamp`;
    if (ts < now - MAX_TELEMETRY_AGE_SEC) return `${kind} timestamp is too old`;
    if (ts > now + MAX_TELEMETRY_FUTURE_SEC) return `${kind} timestamp is in the future`;
    hours.add(hourStartSec(ts));
    return '';
  };
  for (const point of samples) {
    const error = validatePoint(point, 'sample');
    if (error) return error;
  }
  for (const point of pings) {
    const error = validatePoint(point, 'ping');
    if (error) return error;
  }
  if (hours.size > MAX_TELEMETRY_HOURS_PER_REPORT) {
    return `telemetry spans too many hourly buckets; max ${MAX_TELEMETRY_HOURS_PER_REPORT}`;
  }
  return '';
}

async function agentTrafficSettings(env, agentId, ts = nowSec()) {
  let row = null;
  try {
    row = await env.DB.prepare(`SELECT traffic_enabled, traffic_quota_gb, traffic_mode, traffic_reset_day, expires_at FROM targets WHERE id = ?`).bind(agentId).first();
  } catch (_) {
    try {
      row = await env.DB.prepare(`SELECT traffic_enabled, traffic_quota_gb, expires_at FROM targets WHERE id = ?`).bind(agentId).first();
    } catch (_) {}
  }
  if (!row) {
    try {
      const rows = await env.DB.prepare(`SELECT id, traffic_enabled, traffic_quota_gb, traffic_mode, traffic_reset_day, expires_at FROM targets`).all();
      row = (rows.results || []).find((item) => sanitizeAgentId(item.id) === agentId) || null;
    } catch (_) {
      try {
        const rows = await env.DB.prepare(`SELECT id, traffic_enabled, traffic_quota_gb, expires_at FROM targets`).all();
        row = (rows.results || []).find((item) => sanitizeAgentId(item.id) === agentId) || null;
      } catch (_) {}
    }
  }
  return trafficSettingsFromTarget(row, env, ts);
}

async function readAgentTraffic(env, agentId) {
  const settings = await agentTrafficSettings(env, agentId);
  if (!settings.enabled || !agentId) return summarizeTraffic(null, settings);
  try {
    const [row, metric] = await Promise.all([
      env.DB.prepare(`SELECT * FROM agent_traffic_monthly WHERE agent_id = ? AND month = ?`).bind(agentId, settings.month).first(),
      env.DB.prepare(`SELECT net, updated_at FROM agent_metrics_state WHERE agent_id = ?`).bind(agentId).first(),
    ]);
    return summarizeTrafficWithPending(row, settings, metric);
  } catch (_) {
    return summarizeTraffic(null, settings);
  }
}

async function dailyTrafficSum(env, agentId, periodStart, periodEnd) {
  const row = await env.DB.prepare(`SELECT COALESCE(SUM(rx_bytes), 0) AS rx_bytes, COALESCE(SUM(tx_bytes), 0) AS tx_bytes
    FROM agent_traffic_daily WHERE agent_id = ? AND day >= ? AND day < ?`)
    .bind(agentId, periodStart, periodEnd).first();
  return {
    rx: Math.max(0, Number(row?.rx_bytes || 0) || 0),
    tx: Math.max(0, Number(row?.tx_bytes || 0) || 0),
  };
}

function rawTrafficDelta(raw, previous) {
  const last = Number(previous);
  return Number.isFinite(last) && raw >= last ? Math.floor(raw - last) : 0;
}

function dayInTrafficPeriod(day, settings) {
  return Boolean(day && day >= settings.period_start && day < settings.period_end);
}

function finalizeTrafficDayStatement(env, agentId, row, ts) {
  if (!row?.active_day) return null;
  const rx = Math.max(0, Number(row.day_rx_bytes || 0) || 0);
  const tx = Math.max(0, Number(row.day_tx_bytes || 0) || 0);
  if (rx === 0 && tx === 0) return null;
  return env.DB.prepare(`INSERT INTO agent_traffic_daily (agent_id, day, rx_bytes, tx_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, day) DO UPDATE SET
      rx_bytes = agent_traffic_daily.rx_bytes + excluded.rx_bytes,
      tx_bytes = agent_traffic_daily.tx_bytes + excluded.tx_bytes,
      updated_at = excluded.updated_at`)
    .bind(agentId, row.active_day, rx, tx, ts);
}

export async function rebuildAgentTrafficPeriod(env, agentId, target = null, ts = nowSec()) {
  const id = sanitizeAgentId(agentId);
  if (!env.DB || !id) return null;
  let source = target;
  if (!source) {
    source = await env.DB.prepare(`SELECT traffic_enabled, traffic_quota_gb, traffic_mode, traffic_reset_day, expires_at FROM targets WHERE id = ?`)
      .bind(agentId).first();
  }
  const settings = trafficSettingsFromTarget(source, env, ts);
  const [latest, metric] = await Promise.all([
    env.DB.prepare(`SELECT * FROM agent_traffic_monthly WHERE agent_id = ? ORDER BY updated_at DESC, month DESC LIMIT 1`).bind(id).first(),
    env.DB.prepare(`SELECT net FROM agent_metrics_state WHERE agent_id = ?`).bind(id).first().catch(() => null),
  ]);
  const daily = await dailyTrafficSum(env, id, settings.period_start, settings.period_end);
  const includeActive = dayInTrafficPeriod(latest?.active_day, settings);
  const net = parseJsonSafe(metric?.net);
  const currentRxRaw = Number(net?.rx_bytes);
  const currentTxRaw = Number(net?.tx_bytes);
  const pendingRx = includeActive && Number.isFinite(currentRxRaw) ? rawTrafficDelta(currentRxRaw, latest?.last_rx_bytes) : 0;
  const pendingTx = includeActive && Number.isFinite(currentTxRaw) ? rawTrafficDelta(currentTxRaw, latest?.last_tx_bytes) : 0;
  const activeRx = includeActive ? Math.max(0, Number(latest?.day_rx_bytes || 0) || 0) + pendingRx : 0;
  const activeTx = includeActive ? Math.max(0, Number(latest?.day_tx_bytes || 0) || 0) + pendingTx : 0;
  const latestUpdatedAt = Number(latest?.updated_at || 0) || 0;
  const updatedAt = Math.max(ts, latestUpdatedAt + (latest && latest.month !== settings.month ? 1 : 0));
  await env.DB.prepare(`INSERT INTO agent_traffic_monthly
    (agent_id, month, rx_bytes, tx_bytes, last_rx_bytes, last_tx_bytes, active_day, day_rx_bytes, day_tx_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, month) DO UPDATE SET
      rx_bytes = excluded.rx_bytes,
      tx_bytes = excluded.tx_bytes,
      last_rx_bytes = excluded.last_rx_bytes,
      last_tx_bytes = excluded.last_tx_bytes,
      active_day = excluded.active_day,
      day_rx_bytes = excluded.day_rx_bytes,
      day_tx_bytes = excluded.day_tx_bytes,
      updated_at = excluded.updated_at`)
    .bind(
      id, settings.month, Math.floor(daily.rx + activeRx), Math.floor(daily.tx + activeTx),
      pendingRx > 0 ? Math.floor(currentRxRaw) : (latest?.last_rx_bytes ?? null),
      pendingTx > 0 ? Math.floor(currentTxRaw) : (latest?.last_tx_bytes ?? null),
      latest?.active_day || dayFromSec(ts, env), activeRx, activeTx, updatedAt,
    ).run();
  return summarizeTraffic({
    rx_bytes: daily.rx + activeRx,
    tx_bytes: daily.tx + activeTx,
    updated_at: updatedAt,
  }, settings);
}

export async function persistAgentTraffic(env, agentId, metrics, ts) {
  const settings = await agentTrafficSettings(env, agentId, ts);
  if (!settings.enabled || !env.DB || !agentId) return;
  const rxRaw = Number(metrics?.net?.rx_bytes);
  const txRaw = Number(metrics?.net?.tx_bytes);
  if (!Number.isFinite(rxRaw) || !Number.isFinite(txRaw) || rxRaw < 0 || txRaw < 0) return;
  const month = settings.month;
  const row = await env.DB.prepare(`SELECT * FROM agent_traffic_monthly WHERE agent_id = ? AND month = ?`)
    .bind(agentId, month).first();
  const latest = row || await env.DB.prepare(`SELECT * FROM agent_traffic_monthly WHERE agent_id = ? ORDER BY updated_at DESC, month DESC LIMIT 1`)
    .bind(agentId).first();
  const deltaRx = rawTrafficDelta(rxRaw, latest?.last_rx_bytes);
  const deltaTx = rawTrafficDelta(txRaw, latest?.last_tx_bytes);
  const today = dayFromSec(ts, env);
  const flushInterval = clamp(Number(env.TRAFFIC_PERSIST_INTERVAL_SEC || 1800), 300, 3600);
  const countersContinuous = latest?.last_rx_bytes != null && latest?.last_tx_bytes != null
    && rxRaw >= Number(latest.last_rx_bytes) && txRaw >= Number(latest.last_tx_bytes);
  if (row && row.active_day === today && countersContinuous && Number(row.updated_at || 0) > ts - flushInterval) return;

  if (row) {
    const crossedDay = Boolean(row.active_day && row.active_day !== today);
    const statements = [];
    if (crossedDay) {
      const finalize = finalizeTrafficDayStatement(env, agentId, row, ts);
      if (finalize) statements.push(finalize);
    }
    statements.push(env.DB.prepare(`UPDATE agent_traffic_monthly SET
      rx_bytes = rx_bytes + ?, tx_bytes = tx_bytes + ?, last_rx_bytes = ?, last_tx_bytes = ?,
      active_day = ?, day_rx_bytes = ?, day_tx_bytes = ?, updated_at = ?
      WHERE agent_id = ? AND month = ?`)
      .bind(
        deltaRx, deltaTx, Math.floor(rxRaw), Math.floor(txRaw), today,
        crossedDay || !row.active_day ? deltaRx : Math.max(0, Number(row.day_rx_bytes || 0) || 0) + deltaRx,
        crossedDay || !row.active_day ? deltaTx : Math.max(0, Number(row.day_tx_bytes || 0) || 0) + deltaTx,
        ts, agentId, month,
      ));
    await env.DB.batch(statements);
  } else {
    const daily = await dailyTrafficSum(env, agentId, settings.period_start, settings.period_end);
    const carryActive = dayInTrafficPeriod(latest?.active_day, settings);
    const carriedRx = carryActive ? Math.max(0, Number(latest?.day_rx_bytes || 0) || 0) : 0;
    const carriedTx = carryActive ? Math.max(0, Number(latest?.day_tx_bytes || 0) || 0) : 0;
    const activeRx = latest?.active_day === today ? carriedRx + deltaRx : deltaRx;
    const activeTx = latest?.active_day === today ? carriedTx + deltaTx : deltaTx;
    const statements = [];
    if (latest?.active_day && latest.active_day !== today) {
      const finalize = finalizeTrafficDayStatement(env, agentId, latest, ts);
      if (finalize) statements.push(finalize);
    }
    const updatedAt = Math.max(ts, (Number(latest?.updated_at || 0) || 0) + (latest ? 1 : 0));
    statements.push(env.DB.prepare(`INSERT INTO agent_traffic_monthly
      (agent_id, month, rx_bytes, tx_bytes, last_rx_bytes, last_tx_bytes, active_day, day_rx_bytes, day_tx_bytes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        agentId, month, Math.floor(daily.rx + carriedRx + deltaRx), Math.floor(daily.tx + carriedTx + deltaTx),
        Math.floor(rxRaw), Math.floor(txRaw), today, activeRx, activeTx, updatedAt,
      ));
    await env.DB.batch(statements);
  }
  if (latest?.active_day !== today) {
    try {
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM agent_traffic_monthly WHERE agent_id = ? AND updated_at < ?`).bind(agentId, ts - 400 * 86400),
        env.DB.prepare(`DELETE FROM agent_traffic_daily WHERE agent_id = ? AND day < ?`).bind(agentId, dayFromSec(ts - 400 * 86400, env)),
      ]);
    } catch (_) {}
  }
}

async function loadAgentMetricsD1History(env, agentId, since, historyByTs) {
  try {
    const rows = await env.DB.prepare(`SELECT ts, data FROM agent_metrics_history WHERE agent_id = ? AND ts >= ? ORDER BY ts ASC`)
      .bind(agentId, since).all();
    for (const r of rows.results || []) {
      const d = parseJsonSafe(r.data);
      if (Array.isArray(d)) {
        for (const pt of d) {
          pt.ts = pt.ts || r.ts;
          historyByTs.set(Number(pt.ts) || Number(r.ts), pt);
        }
      } else {
        d.ts = d.ts || r.ts;
        historyByTs.set(Number(d.ts) || Number(r.ts), d);
      }
    }
  } catch (_) {}
}

async function loadAgentMetricsR2History(env, agentId, since, until, historyByTs, fields = null, ctx = null) {
  if (!env.ARCHIVE) return { loaded: false, count: 0 };
  const counts = await mapWithConcurrency(historyHours(since, until), 24, async (hour) => {
    let localCount = 0;
    const telemetry = await readR2Json(env, agentTelemetryHourKey(env, agentId, hour), null);
    const payload = telemetry?.metrics || await readR2Json(env, agentMetricsHourKey(env, agentId, hour), null);
    if (!telemetry) scheduleMetricPayloadUpgrade(env, agentId, hour, payload, ctx);
    const points = metricPointsFromPayload(payload, fields);
    for (const point of points) {
      const ts = Number(point?.ts || 0);
      if (ts >= since && ts <= until) {
        historyByTs.set(ts, selectMetricFields(point, fields));
        localCount++;
      }
    }
    return localCount;
  });
  const buffered = await readBufferedAgentTelemetry(env, agentId, since, until).catch(() => ({ points: [] }));
  for (const point of buffered.points || []) {
    const ts = Number(point?.ts || 0);
    if (ts >= since && ts <= until) historyByTs.set(ts, selectMetricFields(point, fields));
  }
  const count = counts.reduce((a, b) => a + b, 0) + (buffered.points?.length || 0);
  return { loaded: count > 0, count };
}

export async function writeAgentTelemetryR2History(env, agentId, points = [], pings = []) {
  if (!env.ARCHIVE || (!points?.length && !pings?.length)) return { ok: true, skipped: true };
  const buffered = await appendBufferedAgentTelemetry(env, agentId, points, pings);
  if (buffered) return buffered;
  const lock = await acquireAgentHistoryLock(env, agentId);
  if (env.DB && !lock) throw new Error('Agent 历史数据正在写入，请重试本次上报');
  try {
  const byHour = new Map();
  const ensureHour = (hour) => {
    const bucket = byHour.get(hour) || { points: [], pings: [] };
    byHour.set(hour, bucket);
    return bucket;
  };
  for (const point of points) {
    const normalized = normalizeMetricPoint(point);
    const ts = Number(normalized.ts || 0);
    if (!ts) continue;
    const hour = hourStartSec(ts);
    ensureHour(hour).points.push(normalized);
  }
  for (const ping of pings || []) {
    const normalized = normalizePingPoint(ping);
    const ts = Number(normalized.ts || 0);
    if (!ts || !normalized.target_id) continue;
    ensureHour(hourStartSec(ts)).pings.push(normalized);
  }

  let written = 0;
  let pingWritten = 0;
  for (const [hour, hourData] of byHour.entries()) {
    const telemetryKey = agentTelemetryHourKey(env, agentId, hour);
    const existingTelemetry = await readR2Json(env, telemetryKey, null);
    const [legacyMetrics, legacyPings] = existingTelemetry ? [null, null] : await Promise.all([
      readR2Json(env, agentMetricsHourKey(env, agentId, hour), null),
      readR2Json(env, agentPingsHourKey(env, agentId, hour), null),
    ]);
    const existingMetrics = existingTelemetry?.metrics || legacyMetrics;
    const existingMetricPoints = metricPointsFromPayload(existingMetrics);
    const byTs = new Map();
    for (const point of existingMetricPoints) {
      const ts = Number(point?.ts || 0);
      if (ts >= hour && ts < hour + 3600) byTs.set(ts, normalizeMetricPoint(point));
    }
    for (const point of hourData.points) byTs.set(Number(point.ts), point);
    const merged = [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([, point]) => point);
    const byPing = new Map();
    const existingPings = existingTelemetry?.pings || legacyPings;
    const existingPingPoints = pingPointsFromPayload(existingPings);
    for (const ping of existingPingPoints) {
      const normalized = normalizePingPoint(ping);
      const ts = Number(normalized.ts || 0);
      if (ts >= hour && ts < hour + 3600 && normalized.target_id) byPing.set(pingKey(normalized), normalized);
    }
    for (const ping of hourData.pings) byPing.set(pingKey(ping), ping);
    const mergedPings = [...byPing.values()].sort((a, b) => a.ts - b.ts || a.target_id.localeCompare(b.target_id));
    const dayHour = utcDayHour(hour);
    await writeR2Json(env, telemetryKey, {
      schema: 'nstatus-agent-telemetry-hour-v1',
      agent_id: sanitizeAgentId(agentId),
      day: dayHour.day,
      hour: dayHour.hour,
      updated_at: new Date().toISOString(),
      metrics: { schema: 'nstatus-agent-metrics-hour-v2', series: metricPointsToColumns(merged) },
      pings: { schema: 'nstatus-agent-pings-hour-v2', series: pingPointsToSeries(mergedPings) },
    }, { schema: 'nstatus-agent-telemetry-hour-v1', agent_id: sanitizeAgentId(agentId), day: dayHour.day, hour: dayHour.hour });
    written += merged.length;
    pingWritten += mergedPings.length;
  }
  return { ok: true, hours: byHour.size, points: written, pings: pingWritten };
  } finally {
    await releaseAgentHistoryLock(env, lock);
  }
}

async function acquireAgentHistoryLock(env, agentId, ttlSec = 90) {
  if (!env.DB) return null;
  const key = `agent_history_lock:${sanitizeAgentId(agentId)}`;
  const now = nowSec();
  const token = `${now + ttlSec}:${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    WHERE CAST(substr(app_meta.value, 1, instr(app_meta.value, ':') - 1) AS INTEGER) < ?`)
    .bind(key, token, now, now).run();
  const row = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(key).first();
  return row?.value === token ? { key, token } : null;
}

async function releaseAgentHistoryLock(env, lock) {
  if (!env.DB || !lock) return;
  await env.DB.prepare(`DELETE FROM app_meta WHERE key = ? AND value = ?`).bind(lock.key, lock.token).run().catch(() => {});
}

export async function deleteAgentTelemetry(env, agentId) {
  const id = sanitizeAgentId(agentId);
  if (!id) return { d1: 0, r2: 0 };
  let d1 = 0;
  for (const table of ['agent_metrics_state', 'agent_metrics_history', 'agent_traffic_monthly', 'agent_traffic_daily', 'ping_history']) {
    const result = await env.DB.prepare(`DELETE FROM ${table} WHERE agent_id = ?`).bind(id).run().catch(() => null);
    d1 += Number(result?.meta?.changes || 0);
  }
  let r2 = 0;
  if (env.ARCHIVE) {
    let cursor;
    const prefix = `${agentMetricsR2Prefix(env)}/${id}/`;
    do {
      const listed = await env.ARCHIVE.list({ prefix, cursor, limit: 1000 });
      const keys = (listed.objects || []).map(item => item.key);
      for (let i = 0; i < keys.length; i += 100) await env.ARCHIVE.delete(keys.slice(i, i + 100));
      r2 += keys.length;
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
  await deleteBufferedAgentTelemetry(env, id).catch((error) => {
    console.error('delete telemetry buffer failed:', String(error?.message || error));
  });
  return { d1, r2 };
}

export async function cleanupAgentMetricsR2(env, options = {}) {
  if (!env.ARCHIVE || !env.DB) return { ok: true, skipped: true };
  const retentionHours = options.hours == null ? Number(env.AGENT_METRICS_R2_RETENTION_HOURS || 72) : Number(options.hours);
  const retention = clamp(retentionHours, 1, 720) * 3600;
  const cutoffHour = hourStartSec(nowSec() - retention);
  const maxDeletes = clamp(Number(options.max_deletes || 500), 1, 5000);
  const agentIds = new Set();
  if (options.agent_id) agentIds.add(sanitizeAgentId(options.agent_id));
  try {
    const rows = await env.DB.prepare(`SELECT agent_id FROM agent_metrics_state`).all();
    for (const row of rows.results || []) if (row.agent_id) agentIds.add(sanitizeAgentId(row.agent_id));
  } catch (_) {}

  let deleted = 0;
  const errors = [];
  for (const agentId of [...agentIds].filter(Boolean)) {
    let cursor = undefined;
    const prefix = `${agentMetricsR2Prefix(env)}/${agentId}/`;
    do {
      try {
        const listed = await env.ARCHIVE.list({ prefix, cursor, limit: 1000 });
        const stale = (listed.objects || []).map(obj => obj.key).filter(key => {
          const hour = hourFromAgentMetricsKey(key);
          return hour && hour < cutoffHour;
        }).slice(0, Math.max(0, maxDeletes - deleted));
        for (let i = 0; i < stale.length; i += 100) await env.ARCHIVE.delete(stale.slice(i, i + 100));
        deleted += stale.length;
        cursor = listed.truncated && deleted < maxDeletes ? listed.cursor : undefined;
      } catch (err) {
        errors.push(`${agentId}: ${String(err?.message || err)}`);
        cursor = undefined;
      }
    } while (cursor && deleted < maxDeletes);
    if (deleted >= maxDeletes) break;
  }
  return { ok: errors.length === 0, deleted, cutoff_hour: cutoffHour, errors };
}

function agentMetricsR2Prefix(env) {
  return String(env.AGENT_METRICS_R2_PREFIX || 'agent-metrics-v1').replace(/^\/+|\/+$/g, '');
}

function agentMetricsHourKey(env, agentId, hourStart) {
  const dh = utcDayHour(hourStart);
  return `${agentMetricsR2Prefix(env)}/${sanitizeAgentId(agentId)}/${dh.day}/${dh.hour}/metrics.json`;
}

function agentPingsHourKey(env, agentId, hourStart) {
  const dh = utcDayHour(hourStart);
  return `${agentMetricsR2Prefix(env)}/${sanitizeAgentId(agentId)}/${dh.day}/${dh.hour}/pings.json`;
}

function agentTelemetryHourKey(env, agentId, hourStart) {
  const dh = utcDayHour(hourStart);
  return `${agentMetricsR2Prefix(env)}/${sanitizeAgentId(agentId)}/${dh.day}/${dh.hour}/telemetry.json`;
}

function hourFromAgentMetricsKey(key) {
  const match = String(key || '').match(/\/(\d{4}-\d{2}-\d{2})\/(\d{2})(?:\/(?:metrics|pings|telemetry))?\.json$/);
  if (!match) return 0;
  const ts = Math.floor(Date.parse(`${match[1]}T${match[2]}:00:00.000Z`) / 1000);
  return Number.isFinite(ts) ? ts : 0;
}

function utcDayHour(ts) {
  const iso = new Date(hourStartSec(ts) * 1000).toISOString();
  return { day: iso.slice(0, 10), hour: iso.slice(11, 13) };
}

function hourStartSec(ts) {
  return Math.floor(Number(ts || 0) / 3600) * 3600;
}

function scheduleMetricPayloadUpgrade(env, agentId, hour, payload, ctx = null) {
  if (!ctx || typeof ctx.waitUntil !== 'function' || !Array.isArray(payload?.points) || payload.series || hour >= hourStartSec(nowSec())) return;
  const dh = utcDayHour(hour);
  const task = writeR2Json(env, agentMetricsHourKey(env, agentId, hour), {
    schema: 'nstatus-agent-metrics-hour-v2',
    agent_id: sanitizeAgentId(agentId),
    day: dh.day,
    hour: dh.hour,
    updated_at: new Date().toISOString(),
    series: metricPointsToColumns(payload.points),
  }, { schema: 'nstatus-agent-metrics-hour-v2', agent_id: sanitizeAgentId(agentId), day: dh.day, hour: dh.hour }).catch(() => {});
  ctx.waitUntil(task);
}

function schedulePingPayloadUpgrade(env, agentId, hour, payload, ctx = null) {
  if (!ctx || typeof ctx.waitUntil !== 'function' || !Array.isArray(payload?.pings) || payload.series || hour >= hourStartSec(nowSec())) return;
  const dh = utcDayHour(hour);
  const task = writeR2Json(env, agentPingsHourKey(env, agentId, hour), {
    schema: 'nstatus-agent-pings-hour-v2',
    agent_id: sanitizeAgentId(agentId),
    day: dh.day,
    hour: dh.hour,
    updated_at: new Date().toISOString(),
    series: pingPointsToSeries(payload.pings),
  }, { schema: 'nstatus-agent-pings-hour-v2', agent_id: sanitizeAgentId(agentId), day: dh.day, hour: dh.hour }).catch(() => {});
  ctx.waitUntil(task);
}

function historyHours(since, until) {
  const out = [];
  const startHour = hourStartSec(since);
  const endHour = hourStartSec(until);
  for (let hour = startHour; hour <= endHour; hour += 3600) out.push(hour);
  return out;
}

async function mapWithConcurrency(items, limit, fn) {
  const out = [];
  const batchSize = clamp(Number(limit || 1), 1, 50);
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(...await Promise.all(items.slice(i, i + batchSize).map(fn)));
  }
  return out;
}

const METRIC_FIELDS = ['cpu', 'mem', 'disk', 'load1', 'net_rx', 'net_tx', 'tcp_conns', 'udp_conns', 'disk_read', 'disk_write', 'cpu_temp', 'gpu_temp', 'gpu_util', 'motherboard_temp', 'disk_temp', 'chipset_temp'];
const METRIC_FIELD_GROUPS = {
  cpu: ['cpu'],
  mem: ['mem'],
  disk: ['disk'],
  load: ['load1'],
  net: ['net_rx', 'net_tx'],
  conns: ['tcp_conns', 'udp_conns'],
  diskio: ['disk_read', 'disk_write'],
  temp: ['cpu_temp', 'gpu_temp', 'motherboard_temp', 'disk_temp', 'chipset_temp'],
  gpu: ['gpu_util', 'gpu_temp'],
};

export function metricFieldsForRequest(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (METRIC_FIELD_GROUPS[raw]) return METRIC_FIELD_GROUPS[raw];
  const fields = raw.split(',').map(item => item.trim()).filter(item => METRIC_FIELDS.includes(item));
  return fields.length ? [...new Set(fields)] : null;
}

export function selectMetricFields(point, fields = null) {
  const normalized = normalizeMetricPoint(point);
  if (!Array.isArray(fields) || !fields.length) return normalized;
  const out = { ts: normalized.ts };
  for (const field of fields) out[field] = normalized[field];
  return out;
}

export function metricPointsToColumns(points, fields = null) {
  const list = (points || []).map(point => selectMetricFields(point, fields)).filter(p => Number(p.ts) > 0).sort((a, b) => a.ts - b.ts);
  const usedFields = Array.isArray(fields) && fields.length
    ? fields
    : METRIC_FIELDS.filter(field => list.some(point => point[field] !== undefined));
  const t0 = Number(list[0]?.ts || 0);
  const values = Object.fromEntries(usedFields.map(field => [field, []]));
  const dt = [];
  for (const point of list) {
    dt.push(Number(point.ts) - t0);
    for (const field of usedFields) values[field].push(roundMetric(point[field]));
  }
  return { t0, dt, fields: usedFields, values };
}

export function metricPointsFromPayload(payload, fields = null) {
  if (!payload) return [];
  if (payload.series && Array.isArray(payload.series.dt)) return metricColumnsToPoints(payload.series, fields);
  return (Array.isArray(payload.points) ? payload.points : []).map(point => selectMetricFields(point, fields));
}

function metricColumnsToPoints(series, fields = null) {
  const values = series?.values || {};
  const usedFields = Array.isArray(fields) && fields.length
    ? fields
    : Array.isArray(series?.fields) ? series.fields : Object.keys(values);
  const t0 = Number(series?.t0 || 0);
  return (series?.dt || []).map((delta, index) => {
    const point = { ts: t0 + Number(delta || 0) };
    for (const field of usedFields) point[field] = Number(values?.[field]?.[index] || 0);
    return point;
  });
}

export function compactMetricPoints(points, maxPoints = 900) {
  const list = (points || []).map(normalizeMetricPoint).filter(p => Number(p.ts) > 0).sort((a, b) => a.ts - b.ts);
  const max = clamp(Number(maxPoints || 0), 2, 5000);
  if (list.length <= max) return list;
  const step = Math.ceil(list.length / max);
  const out = [];
  for (let i = 0; i < list.length; i += step) out.push(averageMetricChunk(list.slice(i, i + step)));
  out[0] = list[0];
  out[out.length - 1] = list[list.length - 1];
  return out;
}

function averageMetricChunk(chunk) {
  const keys = ['cpu', 'mem', 'disk', 'load1', 'net_rx', 'net_tx', 'tcp_conns', 'udp_conns', 'disk_read', 'disk_write', 'cpu_temp', 'gpu_temp', 'gpu_util', 'motherboard_temp', 'disk_temp', 'chipset_temp'];
  const out = { ts: Math.round(avgNumber(chunk, 'ts')) };
  for (const key of keys) {
    const avg = avgNumberOptional(chunk, key);
    if (avg != null) out[key] = roundMetric(avg);
    else if (!['cpu_temp', 'gpu_temp', 'gpu_util', 'motherboard_temp', 'disk_temp', 'chipset_temp'].includes(key)) out[key] = 0;
  }
  return out;
}

function avgNumber(items, key) {
  const vals = items.map(item => Number(item?.[key])).filter(Number.isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

function avgNumberOptional(items, key) {
  const vals = items.map(item => Number(item?.[key])).filter(Number.isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function roundMetric(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizeMetricPoint(point) {
  const out = {
    ts: Number(point?.ts || 0),
    cpu: Number(point?.cpu) || 0,
    mem: Number(point?.mem) || 0,
    disk: Number(point?.disk) || 0,
    load1: Number(point?.load1 ?? point?.load) || 0,
    net_rx: Number(point?.net_rx) || 0,
    net_tx: Number(point?.net_tx) || 0,
    tcp_conns: Number(point?.tcp_conns) || 0,
    udp_conns: Number(point?.udp_conns) || 0,
    disk_read: Number(point?.disk_read) || 0,
    disk_write: Number(point?.disk_write) || 0,
  };
  for (const key of ['cpu_temp', 'gpu_temp', 'gpu_util', 'motherboard_temp', 'disk_temp', 'chipset_temp']) {
    const n = Number(point?.[key]);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

function normalizePingPoint(point, fallbackTs = 0) {
  const rawLatency = point?.latency_ms == null ? null : Math.round(Number(point.latency_ms));
  const latency = Number.isFinite(rawLatency) && rawLatency >= 0 && rawLatency <= 1000 ? rawLatency : null;
  return {
    target_id: String(point?.target_id || '').trim().slice(0, 128),
    ts: Math.floor(Number(point?.ts || fallbackTs || 0)),
    latency_ms: Number.isFinite(latency) && latency >= 0 ? latency : null,
    ok: normalizeOkInt(latency == null ? false : (point?.ok === undefined ? true : point.ok)),
  };
}

function pingKey(point) {
  return `${point.target_id}:${point.ts}`;
}

export async function loadAgentPingsR2History(env, agentId, since, until, out = [], ctx = null) {
  if (!env.ARCHIVE) return { loaded: false, count: 0, pings: out };
  const id = sanitizeAgentId(agentId);
  const counts = await mapWithConcurrency(historyHours(since, until), 24, async (hour) => {
    let localCount = 0;
    const telemetry = await readR2Json(env, agentTelemetryHourKey(env, id, hour), null);
    const payload = telemetry?.pings || await readR2Json(env, agentPingsHourKey(env, id, hour), null);
    if (!telemetry) schedulePingPayloadUpgrade(env, id, hour, payload, ctx);
    for (const ping of pingPointsFromPayload(payload)) {
      const normalized = normalizePingPoint(ping);
      if (normalized.target_id && normalized.ts >= since && normalized.ts <= until) {
        out.push(normalized);
        localCount++;
      }
    }
    return localCount;
  });
  const buffered = await readBufferedAgentTelemetry(env, id, since, until).catch(() => ({ pings: [] }));
  for (const ping of buffered.pings || []) {
    const normalized = normalizePingPoint(ping);
    if (normalized.target_id && normalized.ts >= since && normalized.ts <= until) out.push(normalized);
  }
  const unique = new Map();
  for (const ping of out) unique.set(pingKey(ping), ping);
  out.splice(0, out.length, ...[...unique.values()].sort((a, b) => a.ts - b.ts || a.target_id.localeCompare(b.target_id)));
  const count = out.length;
  return { loaded: count > 0, count, pings: out };
}

export function compactPingPointsByTarget(pings, maxPerTarget = 360) {
  const max = clamp(Number(maxPerTarget || 0), 2, 5000);
  const grouped = new Map();
  for (const ping of pings || []) {
    const point = normalizePingPoint(ping);
    if (!point.target_id || !point.ts) continue;
    const list = grouped.get(point.target_id) || [];
    list.push(point);
    grouped.set(point.target_id, list);
  }
  const out = [];
  for (const list of grouped.values()) {
    list.sort((a, b) => a.ts - b.ts);
    out.push(...compactPingSeries(list, max));
  }
  return out.sort((a, b) => a.ts - b.ts || a.target_id.localeCompare(b.target_id));
}

export function summarizePingPointsByTarget(pings) {
  const grouped = new Map();
  for (const ping of pings || []) {
    const point = normalizePingPoint(ping);
    if (!point.target_id || !point.ts) continue;
    const item = grouped.get(point.target_id) || { target_id: point.target_id, total: 0, ok: 0 };
    item.total += 1;
    item.ok += Number(point.ok) === 1 ? 1 : 0;
    grouped.set(point.target_id, item);
  }
  return [...grouped.values()].sort((a, b) => a.target_id.localeCompare(b.target_id)).map(item => ({
    ...item,
    lost: item.total - item.ok,
    loss_rate: item.total ? Number((((item.total - item.ok) / item.total) * 100).toFixed(4)) : null,
  }));
}

export function pingPointsToSeries(pings) {
  const grouped = new Map();
  for (const ping of pings || []) {
    const point = normalizePingPoint(ping);
    if (!point.target_id || !point.ts) continue;
    const list = grouped.get(point.target_id) || [];
    list.push(point);
    grouped.set(point.target_id, list);
  }
  return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([targetId, list]) => {
    list.sort((a, b) => a.ts - b.ts);
    const t0 = Number(list[0]?.ts || 0);
    return {
      target_id: targetId,
      t0,
      dt: list.map(point => point.ts - t0),
      latency_ms: list.map(point => point.latency_ms),
      ok: list.map(point => Number(point.ok || 0)),
    };
  });
}

export function pingPointsFromPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.series)) return pingSeriesToPoints(payload.series);
  return (Array.isArray(payload.pings) ? payload.pings : []).map(ping => normalizePingPoint(ping));
}

function pingSeriesToPoints(seriesList) {
  const out = [];
  for (const series of seriesList || []) {
    const targetId = String(series?.target_id || '').trim();
    const t0 = Number(series?.t0 || 0);
    const dt = Array.isArray(series?.dt) ? series.dt : [];
    for (let i = 0; i < dt.length; i++) {
      out.push(normalizePingPoint({
        target_id: targetId,
        ts: t0 + Number(dt[i] || 0),
        latency_ms: series?.latency_ms?.[i],
        ok: series?.ok?.[i],
      }));
    }
  }
  return out;
}

function compactPingSeries(list, maxPoints) {
  if (list.length <= maxPoints) return list;
  const step = Math.ceil(list.length / maxPoints);
  const out = [];
  for (let i = 0; i < list.length; i += step) out.push(averagePingChunk(list.slice(i, i + step)));
  out[0] = list[0];
  out[out.length - 1] = list[list.length - 1];
  return out;
}

function averagePingChunk(chunk) {
  const okPoints = chunk.filter(p => Number(p.ok) === 1 && Number.isFinite(Number(p.latency_ms)));
  const failed = chunk.some(p => Number(p.ok) !== 1);
  return {
    target_id: chunk[0]?.target_id || '',
    ts: Math.round(avgNumber(chunk, 'ts')),
    latency_ms: okPoints.length ? Math.round(avgNumber(okPoints, 'latency_ms')) : null,
    ok: failed ? 0 : 1,
  };
}

function mapSamples(samples) {
  return samples.map(s => {
    const point = {
      ts: Number(s.ts) || 0, cpu: Number(s.cpu) || 0, mem: Number(s.mem) || 0,
      disk: Number(s.disk) || 0, load1: Number(s.load) || 0,
      net_rx: Number(s.net_rx) || 0, net_tx: Number(s.net_tx) || 0,
      tcp_conns: Number(s.tcp_conns) || 0, udp_conns: Number(s.udp_conns) || 0,
      disk_read: Number(s.disk_read) || 0, disk_write: Number(s.disk_write) || 0,
    };
    for (const key of ['cpu_temp', 'gpu_temp', 'gpu_util', 'motherboard_temp', 'disk_temp', 'chipset_temp']) {
      const n = Number(s?.[key]);
      if (Number.isFinite(n)) point[key] = n;
    }
    return point;
  });
}

function limitSeries(points, maxPoints) {
  const list = (points || []).filter(p => Number(p?.ts || 0) > 0);
  const max = clamp(Number(maxPoints || 0), 1, 60);
  if (list.length <= max) return list;
  if (max === 1) return [list[list.length - 1]];
  const out = [];
  const last = list.length - 1;
  for (let i = 0; i < max; i++) out.push(list[Math.round((i * last) / (max - 1))]);
  return out;
}

function toPoint(state) {
  return {
    ts: nowSec(), cpu: state.cpu_percent, mem: state.memory?.percent ?? 0,
    disk: state.disk?.percent ?? 0, load1: state.load?.load1 ?? 0,
    net_rx: state.net?.rx_bytes_sec ?? 0, net_tx: state.net?.tx_bytes_sec ?? 0,
    tcp_conns: state.net?.tcp_conns ?? 0, udp_conns: state.net?.udp_conns ?? 0,
    disk_read: state.diskio?.read_bytes_sec ?? 0, disk_write: state.diskio?.write_bytes_sec ?? 0,
  };
}

function parseJsonSafe(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return {}; }
}

function normalizeOkInt(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0 || value == null) return 0;
  const text = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'ok', 'up'].includes(text) ? 1 : 0;
}

async function persistAgentMetrics(env, data) {
  const { agentId, agentLabel, agentVersion, capabilities, metrics, state, vpsInfo, rawSamples, pings, ts } = data;
  const rawPings = mapPings(pings, ts);
  const statePings = await mergeStatePings(env, agentId, rawPings);
  const previousState = await env.DB.prepare(`SELECT s.updated_at,
    COALESCE((SELECT no_public_ip FROM targets WHERE id = ?), 0) AS no_public_ip
    FROM agent_metrics_state s WHERE s.agent_id = ?`)
    .bind(agentId, agentId).first().catch(() => null);
  if (Number(previousState?.no_public_ip || 0) === 1) {
    await recordAgentAvailability(env, agentId, previousState?.updated_at, ts)
      .catch(err => console.error('recordAgentAvailability failed:', String(err?.message || err)));
  }
  const writeState = () => env.DB.prepare(`
    INSERT INTO agent_metrics_state (agent_id, agent_label, agent_version, updated_at, hostname, cpu_percent, process_count, thread_count, memory, load, disk, net, diskio, stats, uptime_sec, vps_info, pings, capabilities)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      agent_label=excluded.agent_label,
      agent_version=COALESCE(excluded.agent_version, agent_version),
      updated_at=excluded.updated_at, hostname=excluded.hostname,
      cpu_percent=excluded.cpu_percent, process_count=excluded.process_count, thread_count=excluded.thread_count, memory=excluded.memory, load=excluded.load,
      disk=excluded.disk, net=excluded.net, diskio=excluded.diskio,
      stats=excluded.stats, uptime_sec=excluded.uptime_sec,
      vps_info=CASE WHEN excluded.vps_info IS NOT NULL THEN excluded.vps_info ELSE vps_info END,
      pings=excluded.pings,
      capabilities=CASE WHEN excluded.capabilities IS NOT NULL THEN excluded.capabilities ELSE capabilities END
  `).bind(
    agentId, agentLabel, agentVersion, new Date().toISOString(),
    String(metrics.hostname || '').slice(0, 128), state.cpu_percent, state.process_count, state.thread_count,
    JSON.stringify(state.memory), JSON.stringify(state.load), JSON.stringify(state.disk),
    JSON.stringify(state.net), JSON.stringify(state.diskio),
    state.stats ? JSON.stringify(state.stats) : null, state.uptime_sec,
    vpsInfo ? JSON.stringify(vpsInfo) : null,
    JSON.stringify(statePings),
    capabilities ? JSON.stringify(capabilities) : null
  ).run();
  try {
    await writeState();
  } catch (err) {
    if (!isMissingAgentCapabilitiesColumn(err)) throw err;
    await ensureAgentCapabilitiesColumn(env);
    await writeState();
  }

  const rawPoints = mapSamples(rawSamples);
  if (!rawPoints.length) rawPoints.push(toPoint(state));
  if (env.ARCHIVE) {
    // Do not acknowledge the report until its high-frequency history is durable.
    // The Agent keeps unacknowledged samples and retries them on the next upload.
    await writeAgentTelemetryR2History(env, agentId, rawPoints, rawPings);
  }

  if (rawPings.length > 0 && parseBoolean(env.AGENT_PINGS_TO_D1 ?? !env.ARCHIVE, !env.ARCHIVE)) await writePingHistory(env, agentId, rawPings, ts);

  if (parseBoolean(env.AGENT_METRICS_TO_D1 ?? !env.ARCHIVE, !env.ARCHIVE)) {
    const allPoints = limitSeries(rawPoints, Number(env.AGENT_METRICS_POINTS_PER_REPORT || 6));
    try {
      await env.DB.prepare(`INSERT OR REPLACE INTO agent_metrics_history (agent_id, ts, data) VALUES (?, ?, ?)`)
        .bind(agentId, ts, JSON.stringify(allPoints)).run();
    } catch (_) {}
    try { await env.DB.prepare(`DELETE FROM agent_metrics_history WHERE agent_id = ? AND ts < ?`).bind(agentId, ts - retentionSeconds(env, 'AGENT_METRICS_RETENTION_HOURS', 6, 1, 72)).run(); } catch (_) {}
  }
}

async function mergeStatePings(env, agentId, incoming, maxPerTarget = 60, maxTotal = 600) {
  const byKey = new Map();
  const cutoff = nowSec() - retentionSeconds(env, 'PING_HISTORY_RETENTION_HOURS', 6, 1, 168);
  try {
    const row = await env.DB.prepare(`SELECT pings FROM agent_metrics_state WHERE agent_id = ?`).bind(agentId).first();
    const previous = parseJsonSafe(row?.pings);
    if (Array.isArray(previous)) {
      for (const ping of previous) {
        const point = normalizePingPoint(ping);
        if (point.target_id && point.ts >= cutoff) byKey.set(pingKey(point), point);
      }
    }
  } catch (_) {}
  for (const ping of incoming || []) {
    const point = normalizePingPoint(ping);
    if (point.target_id && point.ts >= cutoff) byKey.set(pingKey(point), point);
  }
  const grouped = new Map();
  for (const point of byKey.values()) {
    const list = grouped.get(point.target_id) || [];
    list.push(point);
    grouped.set(point.target_id, list);
  }
  const out = [];
  for (const list of grouped.values()) {
    list.sort((a, b) => a.ts - b.ts);
    out.push(...list.slice(-maxPerTarget));
  }
  return out.sort((a, b) => a.ts - b.ts || a.target_id.localeCompare(b.target_id)).slice(-maxTotal);
}

async function writePingHistory(env, agentId, pings, fallbackTs) {
  const statements = [];
  for (const p of pings) {
    const point = normalizePingPoint(p, fallbackTs);
    const tid = point.target_id;
    const pts = Math.floor(Number(point.ts || fallbackTs) / 60) * 60;
    if (!tid || !Number.isFinite(pts)) continue;
    statements.push(env.DB.prepare(`INSERT OR REPLACE INTO ping_history (target_id, agent_id, ts, latency_ms, ok) VALUES (?, ?, ?, ?, ?)`)
      .bind(tid, agentId, pts, point.latency_ms, point.ok));
  }
  if (!statements.length) return;
  if (typeof env.DB.batch === 'function') {
    for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  } else {
    for (const stmt of statements) await stmt.run();
  }
  try { await env.DB.prepare(`DELETE FROM ping_history WHERE agent_id = ? AND ts < ?`).bind(agentId, fallbackTs - retentionSeconds(env, 'PING_HISTORY_RETENTION_HOURS', 6, 1, 72)).run(); } catch (_) {}
}

function mapPings(pings, fallbackTs) {
  const byKey = new Map();
  for (const ping of pings || []) {
    const normalized = normalizePingPoint(ping, fallbackTs);
    if (normalized.target_id && normalized.ts > 0) byKey.set(pingKey(normalized), normalized);
  }
  return [...byKey.values()].sort((a, b) => a.ts - b.ts || a.target_id.localeCompare(b.target_id));
}

