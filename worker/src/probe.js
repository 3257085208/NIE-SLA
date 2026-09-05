import { connect } from 'cloudflare:sockets';
import { clamp, nowSec, parseBoolean, sanitizeId, dayFromSec, parseExpectedStatus, withTimeout, ALLOWED_REGIONS, DEFAULT_TIMEOUT_MS, DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC, BUCKET_SEC, isPrivateHost, buildMissedPoints, lastPersistedCheckAt } from './utils.js';
import { internalRequestHeaders } from './auth.js';
import { readR2State, mergeR2StateUpdates, setDailySummary, cachedDailySummaryBefore, dailySummaryFromPoints, statsFromDailySummaries } from './storage.js';
import { applyProbeWriteBatch, readCheckBucketDaySummary, latestStatusToD1Enabled, upsertLatestStatus } from './admin.js';
import { compactStatusEvents } from './status-stream.js';

const daySummaryCache = new Map();

export function groupTargetsByRegion(targets = []) {
  const groups = new Map();
  for (const target of targets || []) {
    const region = String(target?.probe_region || 'auto');
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region).push(target);
  }
  return [...groups.entries()].map(([region, regionTargets]) => ({ region, targets: regionTargets }));
}

export function alignRegionBatchResults(targets = [], results = []) {
  const expected = new Map();
  for (const target of targets || []) {
    const id = String(target?.id || '').trim();
    if (!id || expected.has(id)) throw new Error('region batch input has a duplicate or missing target id');
    expected.set(id, target);
  }
  if (!Array.isArray(results) || results.length !== expected.size) {
    throw new Error('region batch returned an incomplete target mapping');
  }
  const received = new Map();
  for (const result of results) {
    const id = String(result?.target_id || '').trim();
    if (!id || !expected.has(id) || received.has(id)) throw new Error('region batch returned an invalid target mapping');
    received.set(id, result);
  }
  if (received.size !== expected.size) throw new Error('region batch returned an incomplete target mapping');
  return (targets || []).map(target => received.get(String(target.id).trim()));
}

function regionBatchEnabled(env = {}) {
  return parseBoolean(env.REGION_PROXY_BATCH_ENABLED ?? true, true);
}

function regionBatchObjectId(region, env = {}) {
  const version = sanitizeId(env.REGION_PROXY_VERSION || 'v9');
  return `probe-region-batch-${sanitizeId(region)}-${version}`;
}

function regionBatchTimeoutMs(env = {}, targets = []) {
  const maxTimeout = (targets || []).reduce((max, target) => Math.max(max, clamp(Number(target?.timeout_ms || DEFAULT_TIMEOUT_MS), 500, 30000)), 0);
  const extra = clamp(Number(env.REGION_PROXY_EXTRA_TIMEOUT_MS || 1500), 250, 10000);
  return clamp(maxTimeout + extra + 3000, 5000, 65000);
}

function previousStateMapObject(previousById) {
  if (!previousById) return {};
  if (previousById instanceof Map) return Object.fromEntries(previousById);
  if (typeof previousById === 'object' && !Array.isArray(previousById)) return previousById;
  return {};
}

export async function probeTarget(target, cf = {}) {
  if (Number(target?.no_public_ip || 0) === 1) {
    return { ok: false, latency_ms: null, status_code: null, error: null, cf_colo: cf.colo || null, skipped: true };
  }
  if (target.type === 'http') return probeHttp(target, cf);
  if (target.type === 'tcp') return probeTcp(target, cf);
  return { ok: false, latency_ms: null, status_code: null, error: `Unknown target type: ${target.type}`, cf_colo: cf.colo || null };
}

async function probeHttp(target, cf) {
  const timeoutMs = clamp(Number(target.timeout_ms || DEFAULT_TIMEOUT_MS), 500, 30000);
  const method = (target.method || 'GET').toUpperCase();
  const expected = parseExpectedStatus(target.expected_status);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const started = Date.now();
  try {
    const followRedirects = target.follow_redirects !== false && target.follow_redirects !== 0 && String(target.follow_redirects ?? 'true') !== 'false';
    const res = await fetch(target.url, { method, redirect: followRedirects ? 'follow' : 'manual', cache: 'no-store', signal: controller.signal, headers: { 'user-agent': 'NIE-SLA/0.1 Cloudflare Worker Monitor', 'accept': '*/*' } });
    const latency = Date.now() - started;
    const ok = expected.length ? expected.includes(res.status) : res.status >= 200 && res.status < 400;
    return { ok, latency_ms: latency, status_code: res.status, error: ok ? null : `Unexpected HTTP ${res.status}`, cf_colo: cf.colo || null };
  } catch (err) {
    return { ok: false, latency_ms: null, status_code: null, error: String(err?.message || err), cf_colo: cf.colo || null };
  } finally { clearTimeout(timeout); }
}

async function probeTcp(target, cf) {
  if (isPrivateHost(target.target_host)) return { ok: false, latency_ms: null, status_code: null, error: 'Private host — agent monitored', cf_colo: cf.colo || null, skipped: true };
  const timeoutMs = clamp(Number(target.timeout_ms || DEFAULT_TIMEOUT_MS), 500, 30000);
  const host = target.target_host;
  const port = Number(target.target_port);
  const started = Date.now();
  let socket;
  try {
    socket = connect({ hostname: host, port }, { secureTransport: 'off' });
    await withTimeout(socket.opened, timeoutMs, () => socket?.close?.());
    const latency = Date.now() - started;
    try { await socket.close(); } catch (_) {}
    return { ok: true, latency_ms: latency, status_code: null, error: null, cf_colo: cf.colo || null };
  } catch (err) {
    try { await socket?.close?.(); } catch (_) {}
    return { ok: false, latency_ms: null, status_code: null, error: String(err?.message || err), cf_colo: cf.colo || null };
  }
}



export async function probeAndSaveTargetsViaRegionBatch(env, targets, previousById = null, checkedAt = nowSec()) {
  const region = String(targets?.[0]?.probe_region || 'auto');
  const id = env.REGION_PROXY.idFromName(regionBatchObjectId(region, env));
  const stub = env.REGION_PROXY.get(id, { locationHint: region });
  const response = await withTimeout(
    stub.fetch('https://nie-sla.internal/batch-probe-and-save', {
      method: 'POST',
      headers: internalRequestHeaders(env),
      body: JSON.stringify({ targets, previous: previousStateMapObject(previousById), checked_at: checkedAt }),
    }),
    regionBatchTimeoutMs(env, targets),
  );
  if (!response.ok) throw new Error(`Region batch proxy error: HTTP ${response.status}`);
  const body = await response.json();
  if (!body?.ok || !Array.isArray(body?.results)) throw new Error('Region batch proxy returned an invalid response');
  return body.results;
}

export async function probeCurrentStatusTargetsViaRegionBatch(env, targets) {
  const region = String(targets?.[0]?.probe_region || 'auto');
  const id = env.REGION_PROXY.idFromName(regionBatchObjectId(region, env));
  const stub = env.REGION_PROXY.get(id, { locationHint: region });
  const response = await withTimeout(
    stub.fetch('https://nie-sla.internal/batch-current-status', {
      method: 'POST',
      headers: internalRequestHeaders(env),
      body: JSON.stringify({ targets }),
    }),
    regionBatchTimeoutMs(env, targets),
  );
  if (!response.ok) throw new Error(`Region batch proxy error: HTTP ${response.status}`);
  const body = await response.json();
  if (!body?.ok || !Array.isArray(body?.results)) throw new Error('Region batch proxy returned an invalid response');
  return body.results;
}

export async function probeAndSaveTargetViaRegion(env, target, checkedAt, previousState = null) {
  if (Number(target?.no_public_ip || 0) === 1) {
    const result = await probeTarget(target);
    const saved = await saveCheck(env, target, checkedAt, result, previousState);
    return { target_id: target.id, name: target.name, ...result, saved, state_update: null };
  }
  const region = target.probe_region || 'auto';
  if (region !== 'auto' && env.REGION_PROXY && ALLOWED_REGIONS.has(region)) {
    const version = sanitizeId(env.REGION_PROXY_VERSION || 'v9');
    const targetKey = sanitizeId(target.id || target.name || target.target_host || target.url || 'target');
    const id = env.REGION_PROXY.idFromName(`probe-region-${region}-${version}-${targetKey}`);
    const stub = env.REGION_PROXY.get(id, { locationHint: region });
    const timeoutMs = clamp(Number(target.timeout_ms || DEFAULT_TIMEOUT_MS), 500, 30000) + clamp(Number(env.REGION_PROXY_EXTRA_TIMEOUT_MS || 1500), 250, 10000);
    const res = await withTimeout(
      stub.fetch('https://nie-sla.internal/probe-and-save', { method: 'POST', headers: internalRequestHeaders(env), body: JSON.stringify({ target, checked_at: checkedAt, previous: previousState }) }),
      timeoutMs,
    );
    if (!res.ok) { throw new Error(`Region proxy error: HTTP ${res.status}`); }
    return { ...(await res.json()), region_proxy_version: version };
  }
  const result = await probeTarget(target, await enrichCfContext({}, env));
  const saved = await saveCheck(env, target, checkedAt, result, previousState);
  return { target_id: target.id, name: target.name, ...result, saved, state_update: saved.state_update };
}



export async function enrichCfContext(cf = {}, env = {}) {
  const requestColo = String(cf?.colo || '').trim().toUpperCase();
  const echoColo = await getExecutionColoViaEcho(env);
  const finalColo = echoColo || requestColo;
  return { ...cf, colo: finalColo || null, request_colo: requestColo || null, trace_colo: null, echo_colo: echoColo || null };
}

async function getExecutionColoViaEcho(env = {}) {
  if (!parseBoolean(env.ENABLE_COLO_ECHO ?? false, false)) return '';
  const base = publicWorkerUrl(env);
  if (!base) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('colo-echo-timeout'), clamp(Number(env.COLO_ECHO_TIMEOUT_MS || 800), 100, 3000));
  try {
    const res = await fetch(`${base}/api/colo-echo?t=${Date.now()}`, { cache: 'no-store', signal: controller.signal, headers: { 'user-agent': 'NIE-SLA-Colo-Echo/1.0', 'accept': 'application/json' } });
    if (!res.ok) return '';
    const data = await res.json().catch(() => null);
    const colo = String(data?.colo || '').trim().toUpperCase();
    return /^[A-Z0-9]{3,8}$/.test(colo) ? colo : '';
  } catch (_) { return ''; } finally { clearTimeout(timer); }
}

function publicWorkerUrl(env = {}) {
  return String(env.PUBLIC_WORKER_URL || '').trim().replace(/\/+$/, '');
}

export async function getRuntimeColo(env) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('trace-timeout'), clamp(Number(env?.TRACE_COLO_TIMEOUT_MS || 800), 100, 3000));
  try {
    const res = await fetch(`https://www.cloudflare.com/cdn-cgi/trace?t=${Date.now()}`, { cache: 'no-store', signal: controller.signal, headers: { 'user-agent': 'NIE-SLA-Colo-Probe/1.2' } });
    const m = (await res.text()).match(/^colo=([A-Z0-9]+)$/m);
    return m ? m[1] : '';
  } catch (_) { return ''; } finally { clearTimeout(timer); }
}



export async function saveCheck(env, target, checkedAt, result, previous = null) {
  const bucketAt = Math.floor(checkedAt / BUCKET_SEC) * BUCKET_SEC;
  const day = dayFromSec(bucketAt, env);
  const okInt = result.ok ? 1 : 0;
  const latency = Number.isFinite(result.latency_ms) ? Math.round(result.latency_ms) : null;
  const statusCode = result.status_code == null ? null : Number(result.status_code);
  const error = result.error ? String(result.error).slice(0, 500) : null;
  const probeRegion = target.probe_region || 'auto';
  const cfColo = result.cf_colo || null;


  const scheduleFlush = scheduleFlushDue(target, checkedAt, env);
  if (result.skipped) {
    await applyProbeWriteBatch(env, target.id, bucketAt, [], null, null, bucketAt + historyDueIntervalSec(target, env, previous), scheduleFlush);
    return { history_points: 0, uptime_24h: previous?.uptime_24h ?? null, uptime_7d: previous?.uptime_7d ?? null, incident: null, storage: 'skipped', state_update: null };
  }

  const point = { checked_at: bucketAt, ok: okInt, latency_ms: latency, status_code: statusCode, error, probe_region: probeRegion, cf_colo: cfColo, total: 1, ok_count: okInt };
  const missedPoints = buildMissedPoints(env, previous, bucketAt, okInt, probeRegion, missedBackfillWriteLimit(env));
  const bucketWrites = [...missedPoints, point].map(p => ({ day: dayFromSec(p.checked_at, env), point: p }));
  const incomingDayPoints = bucketWrites.map(item => item.point).filter(p => dayFromSec(p.checked_at, env) === day);
  const firstIncomingAt = Math.min(...incomingDayPoints.map(point => Number(point.checked_at || bucketAt)));
  let storedSummary = cachedDailySummaryBefore(previous, day, firstIncomingAt);
  if (!storedSummary) {
    const daySummaryKey = `${target.id}|${day}`;
    storedSummary = missedPoints.length
      ? await readCheckBucketDaySummary(env, target.id, day, firstIncomingAt)
      : daySummaryCache.get(daySummaryKey) || await readCheckBucketDaySummary(env, target.id, day, firstIncomingAt);
    if (daySummaryCache.size > 5000) daySummaryCache.clear();
    daySummaryCache.set(daySummaryKey, storedSummary);
  }
  const incomingSummary = dailySummaryFromPoints(incomingDayPoints);
  const dailySummary = {
    ...incomingSummary,
    total: storedSummary.total + incomingSummary.total,
    ok_count: storedSummary.ok_count + incomingSummary.ok_count,
    sum_latency_ms: storedSummary.sum_latency_ms + incomingSummary.sum_latency_ms,
  };
  daySummaryCache.set(`${target.id}|${day}`, dailySummary);
  const daily = setDailySummary(previous?.daily || {}, day, dailySummary);
  const stats24 = statsFromDailySummaries(daily, day, 1);
  const stats7 = statsFromDailySummaries(daily, day, 7);
  const statusChangedAt = previous && Number(previous.ok) === okInt ? (previous.status_changed_at || checkedAt) : checkedAt;
  const outage = buildIncidentUpdate(target, checkedAt, okInt, error, cfColo, previous);
  const stateUpdate = { target_id: target.id, checked_at: checkedAt, ok: okInt, latency_ms: latency, status_code: statusCode, error, probe_region: probeRegion, cf_colo: cfColo, uptime_24h: stats24.uptime, uptime_7d: stats7.uptime, avg_latency_24h: stats24.avgLatency, last_fail_at: okInt ? (previous?.last_fail_at || null) : checkedAt, current_outage_started_at: outage.currentOutageStartedAt, last_recover_at: outage.lastRecoverAt, status_changed_at: statusChangedAt, daily };
  const writeResult = await applyProbeWriteBatch(env, target.id, checkedAt, bucketWrites, stateUpdate, outage.write, checkedAt + historyDueIntervalSec(target, env, { ...previous, ok: okInt }), scheduleFlush);
  return { history_points: Number(daily[day]?.total || 0), missed_points: missedPoints.length, uptime_24h: stats24.uptime, uptime_7d: stats7.uptime, incident: outage.action, storage: writeResult.bucket_storage || 'd1', state_update: stateUpdate };
}

function missedBackfillWriteLimit(env) {
  const raw = env.MISSED_WRITE_BACKFILL_MAX_BUCKETS ?? env.MISSED_BACKFILL_WRITE_MAX_BUCKETS ?? 6;
  return clamp(Number(raw), 0, 48);
}



function buildIncidentUpdate(target, checkedAt, okInt, error, cfColo, previous) {
  const wasDown = previous && Number(previous.ok) === 0;
  const isDown = okInt === 0;
  if (isDown && !wasDown) {
    return { action: 'started', currentOutageStartedAt: checkedAt, lastRecoverAt: previous?.last_recover_at || null, write: { action: 'started', started_at: checkedAt, recovered_at: null, colo: cfColo, error } };
  }
  if (isDown && wasDown) return { action: 'still_down', currentOutageStartedAt: previous?.current_outage_started_at || checkedAt, lastRecoverAt: previous?.last_recover_at || null, write: { action: 'still_down', started_at: previous?.current_outage_started_at || checkedAt, recovered_at: null, colo: cfColo, error } };
  if (!isDown && wasDown) {
    return { action: 'recovered', currentOutageStartedAt: null, lastRecoverAt: checkedAt, write: { action: 'recovered', started_at: previous?.current_outage_started_at || checkedAt, recovered_at: checkedAt, colo: cfColo, error: null } };
  }
  return { action: 'none', currentOutageStartedAt: null, lastRecoverAt: previous?.last_recover_at || null, write: null };
}



export async function runDueTargets(env, options = {}) {
  const maxTargets = clamp(Number(env.MAX_TARGETS_PER_RUN || 20), 1, 200);
  const now = nowSec();
  // Schedule bookkeeping lives in the R2 status state (lastCheckedAt gate
  // below); next_probe_at in D1 is only a coarse crash-recovery mirror, so the
  // selection intentionally does not filter on it.
  const rows = await env.DB.prepare(
     `SELECT t.*, t.last_checked_at AS last_checked_at
      FROM targets t
      WHERE t.enabled = 1
        AND COALESCE(t.no_public_ip, 0) = 0
      ORDER BY t.group_name, t.name`
  ).all();
  const allTargets = rows.results || [];
  if (!allTargets.length) return { ok: true, count: 0, results: [] };
  const lease = options.skipLease ? null : await acquireProbeRunLease(env);
  if (!options.skipLease && !lease) return { ok: true, count: 0, results: [], skipped: true, reason: 'probe_run_in_progress' };
  try {
    const state = await readR2State(env);
    const d1Latest = await readLatestStatusMap(env, allTargets.map(target => target.id));
    const previousById = buildHistoryPreviousStateMap(allTargets, state, d1Latest);
    const targets = allTargets
      .map(target => ({ target, lastCheckedAt: lastPersistedCheckAt(target, d1Latest.get(String(target.id))) }))
      .filter(item => item.lastCheckedAt <= now - historyDueIntervalSec(item.target, env, previousById.get(item.target.id)))
      .sort((a, b) => a.lastCheckedAt - b.lastCheckedAt).slice(0, maxTargets).map(item => item.target);
    if (!targets.length) return { ok: true, count: 0, results: [] };
    const results = await runTargetBatch(env, targets, previousById);
    return { ok: true, count: targets.length, results, events: compactStatusEvents(results) };
  } finally {
    if (!options.skipLease) await releaseProbeRunLease(env, lease);
  }
}

// Plan-A schedule throttling: the per-probe targets UPDATE (last_checked_at /
// next_probe_at mirror) only runs once per target per flush window; probing
// cadence itself is governed by the R2 status state, not by this row.
export function scheduleFlushDue(target, checkedAt, env = {}) {
  const min = clamp(Number(env.TARGET_SCHEDULE_FLUSH_SEC ?? 1800), 60, 86400);
  const last = Number(target?.last_checked_at || 0);
  if (!Number.isFinite(last) || last <= 0) return true;
  return checkedAt - last >= min;
}

export function historyDueIntervalSec(target, env = {}, previous = null) {
  const base = clamp(Number(target?.interval_sec || DEFAULT_INTERVAL_SEC), MIN_INTERVAL_SEC, 86400);
  if (previous && Number(previous.ok) === 0) {
    return clamp(Number(env.HISTORY_PROBE_DOWN_INTERVAL_SEC || 120), 60, 3600);
  }
  const healthy = clamp(Number(env.HISTORY_PROBE_HEALTHY_INTERVAL_SEC || 300), MIN_INTERVAL_SEC, 86400);
  const region = String(target?.probe_region || 'auto') === 'auto'
    ? MIN_INTERVAL_SEC
    : clamp(Number(env.HISTORY_PROBE_REGION_INTERVAL_SEC || 300), MIN_INTERVAL_SEC, 3600);
  return Math.max(base, healthy, region);
}

export function fastStatusDueInterval(target, previous, now, baseIntervalSec, env = {}) {
  const base = clamp(Number(baseIntervalSec || 300), 60, 3600);
  let dueSec = base;
  const region = String(target?.probe_region || 'auto');
  if (region !== 'auto') {
      dueSec = Math.max(dueSec, clamp(Number(env.FAST_STATUS_REGION_INTERVAL_SEC || 300), 60, 3600));
  }
  if (previous && Number(previous.ok) === 0) {
    const outageAt = Number(previous.current_outage_started_at || 0);
    const downAfterSec = clamp(Number(env.FAST_STATUS_DOWN_AFTER_SEC ?? 0), 0, 7200);
    if (!downAfterSec || (outageAt && Number(now || 0) - outageAt >= downAfterSec)) {
      dueSec = Math.min(dueSec, clamp(Number(env.FAST_STATUS_DOWN_INTERVAL_SEC || 120), 60, 1800));
    }
  }
  return dueSec;
}

export async function runFastStatusTargets(env, options = {}) {
  if (!parseBoolean(env.FAST_STATUS_ENABLED ?? true, true)) return { ok: true, skipped: true, reason: 'disabled', count: 0, results: [] };
  if (!env.DB || !env.ARCHIVE) return { ok: true, skipped: true, reason: 'r2_required', count: 0, results: [] };
  const intervalSec = clamp(Number(env.FAST_STATUS_INTERVAL_SEC || 300), 60, 3600);
  // Keep the fast-status scheduler useful once the fleet grows beyond the
  // original 50-target ceiling. The interval and per-target probe cadence are
  // unchanged; this only prevents a larger enabled fleet from being silently
  // truncated.
  const maxTargets = clamp(Number(env.FAST_STATUS_MAX_TARGETS || 100), 1, 200);
  const now = nowSec();
  const rows = await env.DB.prepare(`SELECT * FROM targets WHERE enabled = 1 AND COALESCE(no_public_ip, 0) = 0 ORDER BY group_name, name`).all();
  const state = await readR2State(env);
  const d1Latest = await readLatestStatusMap(env, (rows.results || []).map((target) => target.id));
  const previousById = buildPreviousStateMap(rows.results || [], state, d1Latest);
  const targets = (rows.results || [])
    .filter((target) => {
      const previous = previousById.get(target.id);
      const dueSec = fastStatusDueInterval(target, previous, now, intervalSec, env);
      return Number(previous?.checked_at || 0) <= now - dueSec;
    })
    .sort((a, b) => Number(previousById.get(a.id)?.checked_at || 0) - Number(previousById.get(b.id)?.checked_at || 0))
    .slice(0, maxTargets);
  if (!targets.length) return { ok: true, count: 0, results: [] };

  const lease = options.skipLease ? null : await acquireProbeRunLease(env, 120);
  if (!options.skipLease && !lease) return { ok: true, count: 0, results: [], skipped: true, reason: 'probe_run_in_progress' };
  try {
    const concurrency = clamp(Number(env.CONCURRENCY || 40), 1, 40);
    const results = [];
    const checkedAt = nowSec();
    for (const group of groupTargetsByRegion(targets)) {
      if (regionBatchEnabled(env) && group.region !== 'auto' && env.REGION_PROXY && ALLOWED_REGIONS.has(group.region)) {
        try {
          const alignedResults = alignRegionBatchResults(group.targets, await probeCurrentStatusTargetsViaRegionBatch(env, group.targets));
          for (let index = 0; index < alignedResults.length; index += 1) {
            const target = group.targets[index];
            results.push(buildFastStatusResult(target, previousById.get(target.id) || null, alignedResults[index], checkedAt));
          }
          continue;
        } catch (error) {
          console.error('region batch fast-status failed, falling back per target:', String(error?.message || error));
        }
      }
      for (let i = 0; i < group.targets.length; i += concurrency) {
        const chunk = group.targets.slice(i, i + concurrency);
        const settled = await Promise.allSettled(chunk.map((target) => runFastStatusTarget(env, target, previousById.get(target.id) || null)));
        for (const item of settled) results.push(item.status === 'fulfilled' ? item.value : { ok: false, error: String(item.reason?.message || item.reason) });
      }
    }
    let stateSyncWarning = '';
    const stateUpdates = results.map((item) => item.state_update).filter(Boolean);
    try {
      const stateSync = await mergeR2StateUpdates(env, stateUpdates);
      if (!stateSync?.ok) {
        stateSyncWarning = 'r2_state_sync_failed';
        const fallback = await fallbackLatestStatusToD1(env, stateUpdates);
        if (!fallback.ok) stateSyncWarning = 'r2_state_sync_and_d1_fallback_failed';
      }
    } catch (error) {
      stateSyncWarning = 'r2_state_sync_failed';
      console.error('fast-status R2 state sync failed:', String(error?.message || error));
      const fallback = await fallbackLatestStatusToD1(env, stateUpdates);
      if (!fallback.ok) stateSyncWarning = 'r2_state_sync_and_d1_fallback_failed';
    }
    const response = {
      ok: true,
      count: targets.length,
      interval_sec: intervalSec,
      results: results.map(({ state_update, ...result }) => result),
      events: compactStatusEvents(results),
    };
    if (stateSyncWarning) response.warning = stateSyncWarning;
    return response;
  } finally {
    if (!options.skipLease) await releaseProbeRunLease(env, lease);
  }
}

async function runFastStatusTarget(env, target, previous) {
  const checkedAt = nowSec();
  const result = await probeTargetForCurrentStatus(env, target);
  return buildFastStatusResult(target, previous, result, checkedAt);
}

function buildFastStatusResult(target, previous, result, checkedAt) {
  const ok = result.ok ? 1 : 0;
  const wasDown = previous && Number(previous.ok) === 0;
  const isDown = ok === 0;
  const stateUpdate = {
    ...(previous || {}),
    target_id: target.id,
    checked_at: checkedAt,
    ok,
    latency_ms: Number.isFinite(result.latency_ms) ? Math.round(result.latency_ms) : null,
    status_code: result.status_code == null ? null : Number(result.status_code),
    error: result.error ? String(result.error).slice(0, 500) : null,
    probe_region: target.probe_region || 'auto',
    cf_colo: result.cf_colo || null,
    last_fail_at: isDown ? (wasDown ? previous?.last_fail_at || checkedAt : checkedAt) : previous?.last_fail_at || null,
    current_outage_started_at: isDown ? (wasDown ? previous?.current_outage_started_at || checkedAt : checkedAt) : null,
    last_recover_at: !isDown && wasDown ? checkedAt : previous?.last_recover_at || null,
    status_changed_at: previous && Number(previous.ok) === ok ? previous.status_changed_at || checkedAt : checkedAt,
  };
  return { target_id: target.id, name: target.name, ...result, state_update: stateUpdate, storage: 'r2-current-status' };
}

async function probeTargetForCurrentStatus(env, target) {
  const region = target.probe_region || 'auto';
  if (region !== 'auto' && env.REGION_PROXY && ALLOWED_REGIONS.has(region)) {
    const version = sanitizeId(env.REGION_PROXY_VERSION || 'v9');
    const targetKey = sanitizeId(target.id || target.name || target.target_host || target.url || 'target');
    const id = env.REGION_PROXY.idFromName(`probe-region-${region}-${version}-${targetKey}`);
    const stub = env.REGION_PROXY.get(id, { locationHint: region });
    const timeoutMs = clamp(Number(target.timeout_ms || DEFAULT_TIMEOUT_MS), 500, 30000) + clamp(Number(env.REGION_PROXY_EXTRA_TIMEOUT_MS || 1500), 250, 10000);
    const response = await withTimeout(
      stub.fetch('https://nie-sla.internal/probe-current-status', { method: 'POST', headers: internalRequestHeaders(env), body: JSON.stringify({ target }) }),
      timeoutMs,
    );
    if (!response.ok) throw new Error(`Region proxy error: HTTP ${response.status}`);
    return response.json();
  }
  return probeTarget(target, await enrichCfContext({}, env));
}

async function acquireProbeRunLease(env, ttlSec = 180) {
  if (!env.DB) return null;
  const key = 'probe:run:lease';
  const now = nowSec();
  const token = `${now + ttlSec}:${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    WHERE CAST(substr(app_meta.value, 1, instr(app_meta.value, ':') - 1) AS INTEGER) < ?`)
    .bind(key, token, now, now).run();
  const row = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(key).first();
  return row?.value === token ? { key, token } : null;
}

async function releaseProbeRunLease(env, lease) {
  if (!env.DB || !lease) return;
  await env.DB.prepare(`DELETE FROM app_meta WHERE key = ? AND value = ?`).bind(lease.key, lease.token).run().catch((error) => {
    console.error('release probe lease failed:', String(error?.message || error));
  });
}

export async function runTargetBatch(env, targets, previousById = null) {
  const concurrency = clamp(Number(env.CONCURRENCY || 20), 1, 40);
  if (!previousById) {
    const state = await readR2State(env);
    previousById = buildPreviousStateMap(targets, state, await readLatestStatusMap(env, targets.map(target => target.id)));
  }
  const out = [];
  const checkedAt = nowSec();
  for (const group of groupTargetsByRegion(targets)) {
    if (regionBatchEnabled(env) && group.region !== 'auto' && env.REGION_PROXY && ALLOWED_REGIONS.has(group.region)) {
      try {
        const rawResults = await probeAndSaveTargetsViaRegionBatch(env, group.targets, previousById, checkedAt);
        out.push(...alignRegionBatchResults(group.targets, rawResults));
        continue;
      } catch (error) {
        console.error('region batch probe failed, falling back per target:', String(error?.message || error));
      }
    }
    for (let i = 0; i < group.targets.length; i += concurrency) {
      const chunk = group.targets.slice(i, i + concurrency);
      const settled = await Promise.allSettled(chunk.map(target => runSingleTarget(env, target, previousById.get(target.id) || null)));
      for (const item of settled) out.push(item.status === 'fulfilled' ? item.value : { ok: false, error: String(item.reason?.message || item.reason) });
    }
  }
  let stateSyncWarning = '';
  try {
    const stateSync = await mergeR2StateUpdates(env, out.map(item => item.state_update).filter(Boolean));
    if (!stateSync?.ok) {
      stateSyncWarning = 'r2_state_sync_failed';
      const fallback = await fallbackLatestStatusToD1(env, out.map(item => item.state_update).filter(Boolean));
      if (!fallback.ok) stateSyncWarning = 'r2_state_sync_and_d1_fallback_failed';
    }
  } catch (error) {
    stateSyncWarning = 'r2_state_sync_failed';
    console.error('probe R2 state sync failed:', String(error?.message || error));
    const fallback = await fallbackLatestStatusToD1(env, out.map(item => item.state_update).filter(Boolean));
    if (!fallback.ok) stateSyncWarning = 'r2_state_sync_and_d1_fallback_failed';
  }
  return out.map(({ state_update, ...publicResult }) => stateSyncWarning
    ? { ...publicResult, warning: stateSyncWarning }
    : publicResult);
}

async function fallbackLatestStatusToD1(env, updates = []) {
  if (latestStatusToD1Enabled(env) || !updates.length) return { ok: true, skipped: true };
  const results = await Promise.allSettled(updates.filter(Boolean).map(update => upsertLatestStatus(env, update)));
  return {
    ok: results.every(result => result.status === 'fulfilled' && result.value?.ok),
    count: results.filter(result => result.status === 'fulfilled' && result.value?.ok).length,
  };
}

async function runSingleTarget(env, target, previousState = null) {
  const checkedAt = nowSec();
  try { return await probeAndSaveTargetViaRegion(env, target, checkedAt, previousState); }
  catch (err) {
    const result = await probeTarget(target, await enrichCfContext({}, env));
    const saved = await saveCheck(env, target, checkedAt, result, previousState);
    return { target_id: target.id, name: target.name, ...result, saved, state_update: saved.state_update, fallback: 'local' };
  }
}

async function readLatestStatusMap(env, targetIds) {
  const map = new Map();
  if (!env.DB) return map;
  const ids = [...new Set((targetIds || []).map(id => String(id || '').trim()).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const marks = chunk.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT target_id, checked_at, ok, latency_ms, status_code, error, probe_region, cf_colo, uptime_24h, uptime_7d, avg_latency_24h, last_fail_at, current_outage_started_at, last_recover_at, status_changed_at
       FROM latest_status
       WHERE target_id IN (${marks})`
    ).bind(...chunk).all();
    for (const row of rows.results || []) map.set(String(row.target_id), row);
  }
  return map;
}

function buildPreviousStateMap(targets, r2State, d1Latest) {
  const map = new Map();
  for (const target of targets || []) {
    const r2 = r2State?.targets?.[target.id] || null;
    const d1 = d1Latest?.get(String(target.id)) || null;
    map.set(target.id, mergePreviousState(r2, d1));
  }
  return map;
}

function buildHistoryPreviousStateMap(targets, r2State, d1Latest) {
  const map = buildPreviousStateMap(targets, r2State, d1Latest);
  for (const target of targets || []) {
    const previous = map.get(target.id);
    if (!previous) continue;
    map.set(target.id, {
      ...previous,
      checked_at: lastPersistedCheckAt(target, d1Latest?.get(String(target.id))),
    });
  }
  return map;
}

function mergePreviousState(r2, d1) {
  if (!d1) return r2 || null;
  if (!r2 || Number(d1.checked_at || 0) > Number(r2.checked_at || 0)) return { ...(r2 || {}), ...d1, daily: r2?.daily || {} };
  return r2;
}
