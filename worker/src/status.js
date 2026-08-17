import { clamp, nowSec, parseBoolean, sanitizeAgentId, agentStatusFields, dayFromSec, dateAddLocal, timezoneOffsetMin, timezoneLabel, publicMaskIps, publicHidePorts, publicHost, publicUrl, publicError, publicCheckPoint, publicCachePrivacyVersion, sanitizePublicStatusPayload, parseExpectedStatus, REGION_LABELS, DEFAULT_STATUS_DAYS, STATUS_SNAPSHOT_SCHEMA, LEGACY_STATUS_SNAPSHOT_SCHEMA } from './utils.js';
import { json } from './auth.js';
import { validateAdminSession } from './totp.js';
import { readR2State, getSummaryRowsFromState, getStatusSnapshotGeneratedAt, getAgentSeriesForTarget, dailyPointsFromChecks } from './storage.js';
import { ensureV6Schema, syncEnvTargetsMaybe, getRecentIncidents, readCheckBuckets, getCheckBucketSummaries, getExchangeRates, convertPriceToCny, getMeta, getPublicSettings, getLatestExternalLatencyByTarget } from './admin.js';
import { summarizeTrafficWithPending, trafficPeriod, trafficSettingsFromTarget } from './traffic.js';
import { compactStatusPayload, refreshLatencySources } from './status-payload.js';
import { mergeAgentAvailabilityRows } from './agent-availability.js';

export async function getStatusCached(request, env, url, ctx = null) {
  const ttl = clamp(Number(env.STATUS_CACHE_TTL || 20), 0, 300);
  const wantsFresh = url.searchParams.get('fresh') === '1' || url.searchParams.get('cache') === '0';
  const wantsLite = url.searchParams.get('lite') === '1';
  const adminRequest = wantsFresh ? await isAdminRequest(request, env) : false;
  if (!ttl || (wantsFresh && adminRequest)) return getStatusFresh(env, url);
  const cacheUrl = new URL(url.origin + url.pathname);
  cacheUrl.searchParams.set('days', String(clamp(Number(url.searchParams.get('days') || 30), 1, 90)));
  cacheUrl.searchParams.set('privacy', publicCachePrivacyVersion(env));
  if (wantsLite) cacheUrl.searchParams.set('lite', '1');
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return withCacheState(cached, ttl, 'hit');
  const canUseSnapshot = !wantsFresh || !adminRequest;
  const res = canUseSnapshot ? (await getStatusSnapshot(env, url)) || await getStatusFresh(env, url) : await getStatusFresh(env, url);
  const cachedRes = withCacheState(res, ttl, 'miss');
  if (cachedRes.ok) await putCachedResponse(cache, cacheKey, cachedRes, ctx, 'status');
  return cachedRes;
}

function withCacheState(response, ttl, state) {
  const headers = new Headers(response.headers);
  headers.set('cache-control', `public, max-age=${ttl}`);
  headers.set('x-nie-sla-cache', state);
  headers.set('x-nstatus-cache', state);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function putCachedResponse(cache, cacheKey, response, ctx, label) {
  const task = cache.put(cacheKey, response.clone()).catch((err) => {
    console.error(`${label} cache put failed:`, String(err?.message || err));
  });
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(task);
    return;
  }
  await task;
}

async function isAdminRequest(request, env) {
  const sessionId = String(request.headers.get('x-admin-session') || '').trim();
  if (!sessionId) return false;
  return Boolean((await validateAdminSession(env, sessionId)).valid);
}

export async function getStatusFresh(env, url) {


  await ensureV6Schema(env);
  let payload = await buildStatusPayload(env, url);
  if (url?.searchParams?.get('lite') === '1') payload = compactStatusPayload(payload);
  return json(sanitizePublicStatusPayload(payload, env), 200, env);
}

async function buildStatusPayload(env, url = null) {
  const warnings = [];
  const optionalQuery = (promise, warning) => promise.catch((error) => {
    console.error(`${warning}:`, String(error?.message || error));
    warnings.push(warning);
    return { results: [] };
  });
  try {
    if (parseBoolean(env.AUTO_SYNC_TARGETS ?? false, false)) await syncEnvTargetsMaybe(env);
  } catch (error) {
    console.error('TARGETS_JSON sync failed:', String(error?.message || error));
    warnings.push('TARGETS_JSON sync failed; using last known targets');
  }
  const days = clamp(Number(url?.searchParams?.get('days') || DEFAULT_STATUS_DAYS), 1, 90);
  const startDay = dateAddLocal(env, -days + 1);
  const targetsPromise = env.DB.prepare(`SELECT t.id, t.name, t.group_name, t.type, t.target_host, t.target_port, t.url, t.method, t.expected_status, t.timeout_ms, t.interval_sec, t.probe_region, t.enabled, t.no_public_ip, t.sort_order, t.created_at, t.updated_at, t.last_checked_at, t.expires_at, t.price, t.currency, t.billing_cycle, t.tags, t.location, t.city, t.location_source, t.location_updated_at, t.provider, t.line_type, t.traffic_enabled, t.traffic_quota_gb, t.traffic_mode, t.traffic_reset_day, t.nq_updated_at, t.nq_unlock_data, t.nq_unlock_updated_at, t.unlock_data, t.unlock_updated_at, CASE WHEN t.nq_report IS NULL OR t.nq_report = '' THEN 0 ELSE 1 END AS has_nq FROM targets t WHERE t.enabled = 1 ORDER BY CASE WHEN t.sort_order IS NULL THEN 1 ELSE 0 END, t.sort_order, t.group_name COLLATE NOCASE, t.name COLLATE NOCASE`).all()
    .catch(() => env.DB.prepare(`SELECT t.id, t.name, t.group_name, t.type, t.target_host, t.target_port, t.url, t.method, t.expected_status, t.timeout_ms, t.interval_sec, t.probe_region, t.enabled, t.created_at, t.updated_at, t.last_checked_at, t.expires_at, t.price, t.currency, t.billing_cycle, t.tags, t.location, t.provider, t.line_type, t.traffic_enabled, t.traffic_quota_gb FROM targets t WHERE t.enabled = 1 ORDER BY t.group_name COLLATE NOCASE, t.name COLLATE NOCASE`).all())
    .catch(() => env.DB.prepare(`SELECT t.id, t.name, t.group_name, t.type, t.target_host, t.target_port, t.url, t.method, t.expected_status, t.timeout_ms, t.interval_sec, t.probe_region, t.enabled, t.created_at, t.updated_at, t.last_checked_at, t.expires_at, t.price, t.currency, t.billing_cycle, t.tags, t.location, t.provider, t.line_type FROM targets t WHERE t.enabled = 1 ORDER BY t.group_name COLLATE NOCASE, t.name COLLATE NOCASE`).all())
    .catch(() => env.DB.prepare(`SELECT t.id, t.name, t.group_name, t.type, t.target_host, t.target_port, t.url, t.method, t.expected_status, t.timeout_ms, t.interval_sec, t.probe_region, t.enabled, t.created_at, t.updated_at, t.last_checked_at, t.expires_at, t.price, t.currency, t.billing_cycle, t.tags, t.location FROM targets t WHERE t.enabled = 1 ORDER BY t.group_name COLLATE NOCASE, t.name COLLATE NOCASE`).all());
  const metricsPromise = optionalQuery(env.DB.prepare(`SELECT * FROM agent_metrics_state`).all(), 'Agent metrics unavailable');
  const agentAvailabilityPromise = optionalQuery(env.DB.prepare(`SELECT agent_id, day, total_sec, online_sec FROM agent_daily_availability WHERE day >= ?`).bind(startDay).all(), 'Agent availability unavailable');
  const latestPromise = optionalQuery(env.DB.prepare(`SELECT target_id, checked_at, ok, latency_ms, status_code, error, probe_region, cf_colo, uptime_24h, uptime_7d, avg_latency_24h, last_fail_at, current_outage_started_at, last_recover_at, status_changed_at FROM latest_status`).all(), 'Latest probe status unavailable');
  const pingTargetsPromise = optionalQuery(env.DB.prepare(`SELECT id, name, color FROM ping_targets WHERE enabled = 1 ORDER BY name`).all(), 'Ping target metadata unavailable');
  const [targets, metricsResult, agentAvailabilityResult, latestResult, pingTargetsResult] = await Promise.all([targetsPromise, metricsPromise, agentAvailabilityPromise, latestPromise, pingTargetsPromise]);
  const r2State = await readR2State(env).catch((error) => {
    console.error('R2 state unavailable:', String(error?.message || error));
    warnings.push('R2 state unavailable; using D1 fallback');
    return { targets: {} };
  });
  const r2SummaryRows = getSummaryRowsFromState(r2State, startDay);
  const latestMap = {};
  for (const row of latestResult.results || []) latestMap[row.target_id] = row;
  const r2SummaryKeys = new Set(r2SummaryRows.map(row => `${row.target_id}|${row.day}`));
  const fallbackTargetIds = (targets.results || []).filter((target) => {
    const id = String(target.id);
    const r2Target = r2State.targets?.[id];
    const newestAt = Math.max(Number(latestMap[id]?.checked_at || 0), Number(r2Target?.checked_at || 0));
    const newestDay = newestAt ? dayFromSec(newestAt, env) : '';
    return !newestDay || !r2SummaryKeys.has(`${id}|${newestDay}`)
      || Number(latestMap[id]?.checked_at || 0) > Number(r2Target?.checked_at || 0);
  }).map(target => String(target.id));
  const noPublicTargetIds = new Set((targets.results || []).filter(target => Number(target.no_public_ip || 0) === 1).map(target => String(target.id)));
  const summaries = mergeSummaryRows(r2SummaryRows, fallbackTargetIds.length
    ? await getCheckBucketSummaries(env, startDay, { targetIds: fallbackTargetIds })
    : [])
    .filter(summary => !noPublicTargetIds.has(String(summary.target_id)));
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(dateAddLocal(env, -i));
  const maskIps = publicMaskIps(env);
  const hidePorts = publicHidePorts(env);
  const incidents = parseBoolean(env.INCIDENTS_TO_D1 ?? true, true) ? await getRecentIncidents(env, 40, maskIps, hidePorts) : [];
  const traffic = trafficPeriod(env);
  const targetTrafficSettings = {};
  for (const t of targets.results || []) targetTrafficSettings[sanitizeAgentId(t.id)] = trafficSettingsFromTarget(t, env);
  const trafficMap = {};
  try {
    const trafficRows = await env.DB.prepare(`SELECT * FROM agent_traffic_monthly`).all();
    for (const row of trafficRows.results || []) trafficMap[`${sanitizeAgentId(row.agent_id)}|${row.month}`] = row;
  } catch (error) {
    console.error('Traffic totals unavailable:', String(error?.message || error));
    warnings.push('Traffic totals unavailable');
  }
  const metricsMap = {};

  for (const r of metricsResult.results || []) {
    if (r.updated_at) {
      const key = sanitizeAgentId(r.agent_id);
      const settings = targetTrafficSettings[key] || { enabled: false, quota_gb: 0, quota_bytes: 0, ...traffic };
      if (key) metricsMap[key] = publicAgentSummary(r, summarizeTrafficWithPending(trafficMap[`${key}|${settings.month}`], settings, r));
    }
  }
  const noPublicTargetByAgent = new Map((targets.results || [])
    .filter(target => Number(target.no_public_ip || 0) === 1)
    .map(target => [sanitizeAgentId(target.id), target.id]));
  for (const availability of mergeAgentAvailabilityRows(agentAvailabilityResult.results, metricsResult.results, env, nowSec(), targets.results)) {
    const targetId = noPublicTargetByAgent.get(availability.agent_id);
    if (!targetId || availability.day < startDay) continue;
    summaries.push({ target_id: targetId, day: availability.day, total: availability.total, ok_count: availability.ok_count, sum_latency_ms: 0, source: 'agent' });
  }

  const externalLatency = await getLatestExternalLatencyByTarget(env, (targets.results || [])
    .filter(target => Number(target.no_public_ip || 0) !== 1 && target.type === 'tcp')
    .map(target => target.id)).catch((error) => {
      console.error('External latency unavailable:', String(error?.message || error));
      warnings.push('External latency unavailable');
      return new Map();
    });

  const cloudflareColor = String(await getMeta(env, 'latency_cloudflare_color') || '#159754');
  const rows = (targets.results || []).map((targetRow) => {
    const r2Status = r2State.targets?.[targetRow.id] || {};
    const d1Status = latestMap[targetRow.id] || {};
    const noPublicIp = Number(targetRow.no_public_ip || 0) === 1;
    const status = noPublicIp ? {} : (Number(d1Status.checked_at || 0) > Number(r2Status.checked_at || 0) ? d1Status : r2Status);
    const row = { ...targetRow, ...status };
    const displayHost = row.type === 'tcp' ? publicHost(row.target_host, maskIps) : row.target_host;
    const displayUrl = row.type === 'http' ? publicUrl(row.url, env) : row.url;
    const displayTarget = row.type === 'http' ? displayUrl : displayHost;
    const agentState = metricsMap[sanitizeAgentId(targetRow.id)] || null;
    const hasNq = targetRow.type === 'tcp' && Number(targetRow.has_nq || 0) === 1;
    const unlock = publicUnlockData(targetRow.unlock_data, targetRow.nq_unlock_data);
    const publicRow = { ...row, no_public_ip: noPublicIp ? 1 : 0, target_host: displayHost, url: displayUrl, error: publicError(row.error, row.status_code), cf_colo: null, target: displayTarget, target_display: displayTarget, region_label: REGION_LABELS[row.probe_region || 'auto'] || row.probe_region || '自动', expected_status: parseExpectedStatus(row.expected_status), last_metrics_at: agentState?.updated_at || null, agent_version: agentState?.agent_version || null, machine_uptime_sec: agentState?.uptime_sec || null, agent_metrics: agentState || null, has_nq: hasNq, nq: hasNq ? { has_report: true, updated_at: targetRow.nq_updated_at ? Number(targetRow.nq_updated_at) : null } : null, unlock, ...agentStatusFields(agentState, env) };
    delete publicRow.nq_report;
    delete publicRow.unlock_data;
    delete publicRow.nq_unlock_data;
    delete publicRow.nq_unlock_updated_at;
    publicRow.latency_sources = noPublicIp ? [] : refreshLatencySources(publicRow, externalLatency.get(String(targetRow.id)) || [], cloudflareColor).latency_sources;
    if (noPublicIp) {
      Object.assign(publicRow, { status_source: 'agent', agent_online: Boolean(agentState && agentStatusFields(agentState, env).agent_online), latency_ms: null, checked_at: null, ok: null, uptime_24h: null, uptime_7d: null, avg_latency_24h: null, error: null });
    }
    delete publicRow.daily;
    if (hidePorts) delete publicRow.target_port;
    return publicRow;
  });

  const rates = await getExchangeRates(env);
  if (rates && rows.length) {
    for (const row of rows) {
      if (row.price != null && row.currency) {
        const converted = convertPriceToCny(row.price, row.currency, rates);
        if (converted != null) row.price_cny = converted;
      }
    }
  }
  const frontend = await publicFrontend(env);
  return { ok: true, name: frontend.appearance.site_name, now: new Date().toISOString(), days: dayList, regions: REGION_LABELS, region_proxy_enabled: Boolean(env.REGION_PROXY), frontend_theme: frontend.theme, frontend, traffic, ping_targets: pingTargetsResult.results || [], privacy: { mask_ips: maskIps, hide_ports: hidePorts, hide_colo: true }, storage: { mode: 'd1-check-buckets+r2-state', raw_checks_in_d1: false, raw_history_in_r2: Boolean(env.ARCHIVE), d1_regular_check_writes: true, status_cache_ttl: clamp(Number(env.STATUS_CACHE_TTL || 20), 0, 300) }, timezone: { offset_minutes: timezoneOffsetMin(env), label: timezoneLabel(env) }, targets: rows, summaries, incidents, warnings: [...new Set(warnings)] };
}

function publicUnlockData(value, nqValue = null) {
  const nq = parseUnlockPayload(nqValue);
  if (nq) return nq;
  return parseUnlockPayload(value);
}

function parseUnlockPayload(value) {
  const parsed = parseJsonSafe(value);
  const services = Array.isArray(parsed?.services) ? parsed.services.slice(0, 20).map(service => ({
    id: String(service?.id || '').slice(0, 40),
    name: String(service?.name || service?.id || '').slice(0, 40),
    status: String(service?.status || '').slice(0, 80),
    region: String(service?.region || '').slice(0, 40),
    method: String(service?.method || '').slice(0, 40),
  })).filter(service => service.name && (service.status || service.region || service.method)) : [];
  if (!services.length) return null;
  return {
    checked_at: Number(parsed.checked_at || 0) || null,
    source: String(parsed.source || 'IP.Check.Place').slice(0, 64),
    services,
  };
}

async function publicFrontend(env) {
  try {
    const settings = await getPublicSettings(env);
    return { theme: settings.frontend_theme || 'classic', appearance: settings.appearance };
  } catch (_) {
    return { theme: 'classic', appearance: { site_name: env.PUBLIC_SITE_NAME || 'NIE-SLA' } };
  }
}

function publicAgentSummary(row, traffic = null) {
  const net = parseJsonSafe(row.net);
  if (net) {
    delete net.rx_raw;
    delete net.tx_raw;
    delete net.rx_bytes;
    delete net.tx_bytes;
  }
  const vpsInfo = parseJsonSafe(row.vps_info);
  const temperatureSensors = Array.isArray(vpsInfo?.temperature_sensors)
    ? vpsInfo.temperature_sensors.slice(0, 16).map(sensor => ({
        id: String(sensor?.id || '').slice(0, 64),
        label: String(sensor?.label || '').slice(0, 64),
        kind: ['motherboard', 'disk', 'chipset', 'other'].includes(String(sensor?.kind || '')) ? String(sensor.kind) : 'other',
        temp_c: Number.isFinite(Number(sensor?.temp_c)) ? Number(sensor.temp_c) : null,
      })).filter(sensor => sensor.id && sensor.label && sensor.temp_c != null && sensor.temp_c >= 1 && sensor.temp_c <= 125)
    : [];
  if (temperatureSensors.length) vpsInfo.temperature_sensors = temperatureSensors;
  else delete vpsInfo.temperature_sensors;
  return {
    updated_at: row.updated_at || null,
    agent_version: row.agent_version || null,
    hostname: row.hostname || null,
    cpu_percent: Number(row.cpu_percent || 0) || 0,
    process_count: Number(row.process_count || 0) || 0,
    thread_count: Number(row.thread_count || row.process_count || 0) || 0,
    memory: parseJsonSafe(row.memory),
    load: parseJsonSafe(row.load),
    disk: parseJsonSafe(row.disk),
    net,
    uptime_sec: Number(row.uptime_sec || 0) || null,
    vps_info: vpsInfo && Object.keys(vpsInfo).length ? vpsInfo : null,
    cpu_temp_c: Number.isFinite(Number(vpsInfo?.cpu_temp_c)) ? Number(vpsInfo.cpu_temp_c) : null,
    gpu_temp_c: Number.isFinite(Number(vpsInfo?.gpu_temp_c)) ? Number(vpsInfo.gpu_temp_c) : null,
    gpu_util: Number.isFinite(Number(vpsInfo?.gpu_util)) ? Number(vpsInfo.gpu_util) : null,
    gpu_name: vpsInfo?.gpu_name ? String(vpsInfo.gpu_name) : null,
    motherboard_temp_c: Number.isFinite(Number(vpsInfo?.motherboard_temp_c)) ? Number(vpsInfo.motherboard_temp_c) : null,
    disk_temp_c: Number.isFinite(Number(vpsInfo?.disk_temp_c)) ? Number(vpsInfo.disk_temp_c) : null,
    chipset_temp_c: Number.isFinite(Number(vpsInfo?.chipset_temp_c)) ? Number(vpsInfo.chipset_temp_c) : null,
    temperature_sensors: temperatureSensors,
    traffic,
  };
}

function parseJsonSafe(value) {
  if (!value) return {};
  if (typeof value === 'object') return Array.isArray(value) ? {} : value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) { return {}; }
}

function mergeSummaryRows(...groups) {
  const byKey = new Map();
  for (const group of groups) {
    for (const row of group || []) {
      if (!row?.target_id || !row?.day) continue;
      byKey.set(`${row.target_id}|${row.day}`, {
        target_id: row.target_id,
        day: row.day,
        total: Number(row.total || 0),
        ok_count: Number(row.ok_count || 0),
        sum_latency_ms: Number(row.sum_latency_ms || 0),
      });
    }
  }
  return [...byKey.values()].sort((a, b) => a.day.localeCompare(b.day) || a.target_id.localeCompare(b.target_id));
}

async function overlayLiveTargetStatus(env, payload) {
  if (!env.DB || !payload || !Array.isArray(payload.targets)) return payload;
  try {
    const externalPromise = getLatestExternalLatencyByTarget(env, payload.targets
      .filter(target => Number(target.no_public_ip || 0) !== 1 && target.type === 'tcp')
      .map(target => target.id)).catch((error) => {
        console.error('Snapshot external latency overlay failed:', String(error?.message || error));
        payload.warnings = [...new Set([...(payload.warnings || []), 'External latency unavailable'])];
        return new Map();
      });
    const [rows, liveTargets, externalLatency] = await Promise.all([
      env.DB.prepare(`SELECT target_id, checked_at, ok, latency_ms, status_code, error, probe_region, cf_colo FROM latest_status`).all(),
      env.DB.prepare(`SELECT id, location, city, location_source, location_updated_at, unlock_data, unlock_updated_at, nq_unlock_data, nq_unlock_updated_at,
        CASE WHEN nq_report IS NULL OR nq_report = '' THEN 0 ELSE 1 END AS has_nq, nq_updated_at
        FROM targets WHERE enabled = 1`).all(),
      externalPromise,
    ]);
    const byId = new Map((rows.results || []).map((r) => [String(r.target_id), r]));
    const liveTargetById = new Map((liveTargets.results || []).map((target) => [String(target.id), target]));
    const cloudflareColor = String(await getMeta(env, 'latency_cloudflare_color') || '#159754');
    payload.targets = payload.targets.map((t) => {
      const liveTarget = liveTargetById.get(String(t.id));
      const currentTarget = liveTarget ? {
        ...t,
        location: liveTarget.location || '',
        city: liveTarget.city || '',
        location_source: liveTarget.location_source || null,
        location_updated_at: Number(liveTarget.location_updated_at || 0) || null,
        unlock: publicUnlockData(liveTarget.unlock_data, liveTarget.nq_unlock_data),
        has_nq: Number(liveTarget.has_nq || 0) === 1,
        nq: Number(liveTarget.has_nq || 0) === 1 ? { has_report: true, updated_at: Number(liveTarget.nq_updated_at || 0) || null } : null,
      } : t;
      if (Number(currentTarget.no_public_ip || 0) === 1) return refreshLatencySources({ ...currentTarget, status_source: 'agent', latency_ms: null, checked_at: null, ok: null, error: null }, [], cloudflareColor);
      const live = byId.get(String(t.id));
      const current = live ? {
        ...currentTarget,
        ok: Number(live.ok),
        checked_at: Number(live.checked_at || currentTarget.checked_at || 0),
        latency_ms: live.latency_ms == null ? currentTarget.latency_ms : Number(live.latency_ms),
        status_code: live.status_code == null ? currentTarget.status_code : Number(live.status_code),
        error: live.error == null ? currentTarget.error : live.error,
        probe_region: live.probe_region || currentTarget.probe_region,
        cf_colo: live.cf_colo || currentTarget.cf_colo,
        live_overlay: true,
      } : currentTarget;
      return refreshLatencySources(current, externalLatency.get(String(t.id)) || [], cloudflareColor);
    });
    payload.live_overlay_at = nowSec();
  } catch (error) {
    console.error('Snapshot live status overlay failed:', String(error?.message || error));
    payload.warnings = [...new Set([...(payload.warnings || []), 'Live status overlay unavailable'])];
  }
  return payload;
}

export async function getStatusSnapshot(env, url) {
  if (!env.ARCHIVE || !parseBoolean(env.STATUS_SNAPSHOT_TO_R2 ?? true, true)) return null;
  if (clamp(Number(url.searchParams.get('days') || DEFAULT_STATUS_DAYS), 1, 90) !== DEFAULT_STATUS_DAYS) return null;
  await ensureV6Schema(env);
  const key = String(env.STATUS_SNAPSHOT_KEY || 'status/status.json').replace(/^\/+/, '');
  try {
    const object = await env.ARCHIVE.get(key);
    if (!object) return null;
    let payload = await object.json();
    const generatedAt = Math.floor(new Date(payload?.generated_at || payload?.now || 0).getTime() / 1000);
    if (!payload?.ok || ![STATUS_SNAPSHOT_SCHEMA, LEGACY_STATUS_SNAPSHOT_SCHEMA].includes(payload?.schema) || !Number.isFinite(generatedAt) || !generatedAt || generatedAt < nowSec() - clamp(Number(env.STATUS_SNAPSHOT_MAX_AGE_SEC || 150), 60, 86400)) return null;
    payload = await overlayLiveTargetStatus(env, payload);
    const frontend = await publicFrontend(env);
    payload.frontend_theme = frontend.theme;
    payload.frontend = { ...(payload.frontend || {}), ...frontend };
    await attachAgentState(payload, env);
    if (url?.searchParams?.get('lite') === '1') payload = compactStatusPayload(payload);
    return json(sanitizePublicStatusPayload(payload, env), 200, env, { 'cache-control': `public, max-age=${clamp(Number(env.STATUS_CACHE_TTL || 20), 0, 300)}`, 'x-nie-sla-source': 'r2-status-snapshot', 'x-nstatus-source': 'r2-status-snapshot' });
  } catch (error) {
    console.error('Status snapshot read failed:', String(error?.message || error));
    return null;
  }
}

async function attachAgentState(payload, env) {
  if (!Array.isArray(payload?.targets) || !env.DB) return;
  try {
    const traffic = trafficPeriod(env);
    const targetTrafficSettings = {};
    let targetOrder = null;
    try {
      const targetRows = await env.DB.prepare(`SELECT id, traffic_enabled, traffic_quota_gb, traffic_mode, traffic_reset_day, expires_at, sort_order FROM targets ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order, group_name COLLATE NOCASE, name COLLATE NOCASE`).all();
      targetOrder = new Map((targetRows.results || []).map((row, index) => [String(row.id), index]));
      for (const row of targetRows.results || []) targetTrafficSettings[sanitizeAgentId(row.id)] = trafficSettingsFromTarget(row, env);
    } catch (_) {
      try {
        const targetRows = await env.DB.prepare(`SELECT id, traffic_enabled, traffic_quota_gb, expires_at FROM targets`).all();
        for (const row of targetRows.results || []) targetTrafficSettings[sanitizeAgentId(row.id)] = trafficSettingsFromTarget(row, env);
      } catch (_) {}
    }
    const trafficMap = {};
    const trafficRows = await env.DB.prepare(`SELECT * FROM agent_traffic_monthly`).all();
    for (const row of trafficRows.results || []) trafficMap[`${sanitizeAgentId(row.agent_id)}|${row.month}`] = row;
    const rows = await env.DB.prepare(`SELECT * FROM agent_metrics_state`).all();
    const byAgent = {};
    for (const row of rows.results || []) {
      const key = sanitizeAgentId(row.agent_id);
      const settings = targetTrafficSettings[key] || { enabled: false, quota_gb: 0, quota_bytes: 0, ...traffic };
      if (key) byAgent[key] = publicAgentSummary(row, summarizeTrafficWithPending(trafficMap[`${key}|${settings.month}`], settings, row));
    }
    for (const target of payload.targets) {
      const state = byAgent[sanitizeAgentId(target.id)];
      if (!state) {
        if (Number(target.no_public_ip || 0) === 1) Object.assign(target, { status_source: 'agent', agent_online: false, latency_ms: null, checked_at: null, ok: null, error: null });
        continue;
      }
      target.last_metrics_at = state.updated_at || null;
      target.agent_version = state.agent_version || null;
      target.machine_uptime_sec = Number(state.uptime_sec || 0) || null;
      target.agent_metrics = state;
      Object.assign(target, agentStatusFields(state, env));
      if (Number(target.no_public_ip || 0) === 1) Object.assign(target, { status_source: 'agent', latency_ms: null, checked_at: null, ok: null, error: null });
    }
    if (targetOrder) payload.targets.sort((a, b) => (targetOrder.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER) - (targetOrder.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER));
  } catch (error) {
    console.error('Snapshot Agent state overlay failed:', String(error?.message || error));
    payload.warnings = [...new Set([...(payload.warnings || []), 'Agent state overlay unavailable'])];
  }
}

export async function writeStatusSnapshot(env) {
  if (!env.ARCHIVE || !parseBoolean(env.STATUS_SNAPSHOT_TO_R2 ?? true, true)) return { ok: true, skipped: true, reason: 'disabled_or_missing_r2' };
  const every = clamp(Number(env.STATUS_SNAPSHOT_EVERY_SEC || 60), 30, 3600);
  const key = String(env.STATUS_SNAPSHOT_KEY || 'status/status.json').replace(/^\/+/, '');
  const last = await getStatusSnapshotGeneratedAt(env, key);
  if (last && last > nowSec() - every) return { ok: true, skipped: true, reason: 'too_soon', last_write_at: last };
  const url = new URL('https://nie-sla.internal/api/status');
  url.searchParams.set('days', String(DEFAULT_STATUS_DAYS));
  const payload = await buildStatusPayload(env, url);
  payload.schema = STATUS_SNAPSHOT_SCHEMA;
  payload.generated_at = new Date().toISOString();
  payload.storage = { ...(payload.storage || {}), status_snapshot_in_r2: true, status_snapshot_key: key };
  await env.ARCHIVE.put(key, JSON.stringify(payload), { httpMetadata: { contentType: 'application/json; charset=utf-8' }, customMetadata: { schema: STATUS_SNAPSHOT_SCHEMA, generated_at: payload.generated_at } });
  return { ok: true, key, targets: payload.targets?.length || 0, summaries: payload.summaries?.length || 0 };
}

export async function getChecksCached(request, env, url, ctx = null) {
  const ttl = clamp(Number(env.CHECKS_CACHE_TTL || 60), 0, 300);
  if (!ttl) return getChecks(env, url);
  const defaultLimit = clamp(Number(env.CHECKS_DEFAULT_LIMIT || 864), 24, 20000);
  const maxLimit = clamp(Number(env.CHECKS_MAX_LIMIT || 12000), 100, 20000);
  const requestedLimit = clamp(Number(url.searchParams.get('limit') || defaultLimit), 1, maxLimit);
  const requestedHours = clamp(Number(url.searchParams.get('hours') || env.CHECKS_WINDOW_HOURS || 72), 1, 24 * 30);
  const cacheUrl = new URL(url.origin + url.pathname);
  const targetId = url.searchParams.get('target_id') || '';
  if (targetId) cacheUrl.searchParams.set('target_id', targetId);
  cacheUrl.searchParams.set('limit', String(requestedLimit));
  cacheUrl.searchParams.set('hours', String(requestedHours));
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return withCacheState(cached, ttl, 'hit');
  const res = await getChecks(env, cacheUrl);
  const cachedRes = withCacheState(res, ttl, 'miss');
  if (cachedRes.ok) await putCachedResponse(cache, cacheKey, cachedRes, ctx, 'checks');
  return cachedRes;
}

async function getChecks(env, url) {
  await ensureV6Schema(env);
  const id = url.searchParams.get('target_id');
  const defaultLimit = clamp(Number(env.CHECKS_DEFAULT_LIMIT || 864), 24, 20000);
  const maxLimit = clamp(Number(env.CHECKS_MAX_LIMIT || 12000), 100, 20000);
  const limit = clamp(Number(url.searchParams.get('limit') || defaultLimit), 1, maxLimit);
  const hours = clamp(Number(url.searchParams.get('hours') || env.CHECKS_WINDOW_HOURS || 72), 1, 24 * 30);
  if (!id) return json({ ok: false, error: '必须提供 target_id' }, 400, env);
  const days = Math.ceil(hours / 24);
  const since = nowSec() - hours * 3600;
  const allPoints = await readCheckBuckets(env, id, days);
  const checks = allPoints.filter(p => Number(p.checked_at) >= since).sort((a, b) => Number(b.checked_at) - Number(a.checked_at)).slice(0, limit).map(publicCheckPoint);
  const daily = dailyPointsFromChecks(allPoints, env);
  const agentSeries = await getAgentSeriesForTarget(env, id, days, since, limit);
  return json({ ok: true, source: 'd1-check-buckets', checks, daily_points: daily, agent_series: agentSeries }, 200, env);
}
