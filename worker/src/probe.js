import { connect } from 'cloudflare:sockets';
import { clamp, nowSec, parseBoolean, sanitizeId, dayFromSec, parseExpectedStatus, withTimeout, ALLOWED_REGIONS, DEFAULT_TIMEOUT_MS, DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC, BUCKET_SEC, isPrivateHost, buildMissedPoints } from './utils.js';
import { readR2State, mergeR2StateUpdates, setDailySummary, cachedDailySummaryBefore, dailySummaryFromPoints, statsFromDailySummaries } from './storage.js';
import { applyProbeWriteBatch, readCheckBucketDaySummary } from './admin.js';

// ── HTTP/TCP probe ───────────────────────────────────────────────────────────

export async function probeTarget(target, cf = {}) {
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
    const res = await fetch(target.url, { method, redirect: followRedirects ? 'follow' : 'manual', cache: 'no-store', signal: controller.signal, headers: { 'user-agent': 'NStatus/0.1 Cloudflare Worker Monitor', 'accept': '*/*' } });
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

// ── Region probe via Durable Object ──────────────────────────────────────────

export async function probeAndSaveTargetViaRegion(env, target, checkedAt, previousState = null) {
  const region = target.probe_region || 'auto';
  if (region !== 'auto' && env.REGION_PROXY && ALLOWED_REGIONS.has(region)) {
    const version = sanitizeId(env.REGION_PROXY_VERSION || 'v9');
    const targetKey = sanitizeId(target.id || target.name || target.target_host || target.url || 'target');
    const id = env.REGION_PROXY.idFromName(`probe-region-${region}-${version}-${targetKey}`);
    const stub = env.REGION_PROXY.get(id, { locationHint: region });
    const timeoutMs = clamp(Number(target.timeout_ms || DEFAULT_TIMEOUT_MS), 500, 30000) + clamp(Number(env.REGION_PROXY_EXTRA_TIMEOUT_MS || 1500), 250, 10000);
    const res = await withTimeout(
      stub.fetch('https://nstatus.internal/probe-and-save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, checked_at: checkedAt, previous: previousState }) }),
      timeoutMs,
    );
    if (!res.ok) { throw new Error(`Region proxy error: HTTP ${res.status}`); }
    return { ...(await res.json()), region_proxy_version: version };
  }
  const result = await probeTarget(target, await enrichCfContext({}, env));
  const saved = await saveCheck(env, target, checkedAt, result, previousState);
  return { target_id: target.id, name: target.name, ...result, saved, state_update: saved.state_update };
}

// ── Colo detection ───────────────────────────────────────────────────────────

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
    const res = await fetch(`${base}/api/colo-echo?t=${Date.now()}`, { cache: 'no-store', signal: controller.signal, headers: { 'user-agent': 'NStatus-Colo-Echo/1.0', 'accept': 'application/json' } });
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
    const res = await fetch(`https://www.cloudflare.com/cdn-cgi/trace?t=${Date.now()}`, { cache: 'no-store', signal: controller.signal, headers: { 'user-agent': 'NStatus-Colo-Probe/1.2' } });
    const m = (await res.text()).match(/^colo=([A-Z0-9]+)$/m);
    return m ? m[1] : '';
  } catch (_) { return ''; } finally { clearTimeout(timer); }
}

// ── Save check ───────────────────────────────────────────────────────────────

export async function saveCheck(env, target, checkedAt, result, previous = null) {
  const bucketAt = Math.floor(checkedAt / BUCKET_SEC) * BUCKET_SEC;
  const day = dayFromSec(bucketAt, env);
  const okInt = result.ok ? 1 : 0;
  const latency = Number.isFinite(result.latency_ms) ? Math.round(result.latency_ms) : null;
  const statusCode = result.status_code == null ? null : Number(result.status_code);
  const error = result.error ? String(result.error).slice(0, 500) : null;
  const probeRegion = target.probe_region || 'auto';
  const cfColo = result.cf_colo || null;

  // Skipped probes (private IP, agent-monitored): don't record as failure
  if (result.skipped) {
    await applyProbeWriteBatch(env, target.id, bucketAt, [], null, null);
    return { history_points: 0, uptime_24h: previous?.uptime_24h ?? null, uptime_7d: previous?.uptime_7d ?? null, incident: null, storage: 'skipped', state_update: null };
  }

  const point = { checked_at: bucketAt, ok: okInt, latency_ms: latency, status_code: statusCode, error, probe_region: probeRegion, cf_colo: cfColo, total: 1, ok_count: okInt };
  const missedPoints = buildMissedPoints(env, previous, bucketAt, okInt, probeRegion, missedBackfillWriteLimit(env));
  const bucketWrites = [...missedPoints, point].map(p => ({ day: dayFromSec(p.checked_at, env), point: p }));
  const incomingDayPoints = bucketWrites.map(item => item.point).filter(p => dayFromSec(p.checked_at, env) === day);
  const firstIncomingAt = Math.min(...incomingDayPoints.map(point => Number(point.checked_at || bucketAt)));
  const storedSummary = cachedDailySummaryBefore(previous, day, firstIncomingAt)
    || await readCheckBucketDaySummary(env, target.id, day, firstIncomingAt);
  const incomingSummary = dailySummaryFromPoints(incomingDayPoints);
  const dailySummary = {
    ...incomingSummary,
    total: storedSummary.total + incomingSummary.total,
    ok_count: storedSummary.ok_count + incomingSummary.ok_count,
    sum_latency_ms: storedSummary.sum_latency_ms + incomingSummary.sum_latency_ms,
  };
  const daily = setDailySummary(previous?.daily || {}, day, dailySummary);
  const stats24 = statsFromDailySummaries(daily, day, 1);
  const stats7 = statsFromDailySummaries(daily, day, 7);
  const statusChangedAt = previous && Number(previous.ok) === okInt ? (previous.status_changed_at || checkedAt) : checkedAt;
  const outage = buildIncidentUpdate(target, checkedAt, okInt, error, cfColo, previous);
  const stateUpdate = { target_id: target.id, checked_at: bucketAt, ok: okInt, latency_ms: latency, status_code: statusCode, error, probe_region: probeRegion, cf_colo: cfColo, uptime_24h: stats24.uptime, uptime_7d: stats7.uptime, avg_latency_24h: stats24.avgLatency, last_fail_at: okInt ? (previous?.last_fail_at || null) : checkedAt, current_outage_started_at: outage.currentOutageStartedAt, last_recover_at: outage.lastRecoverAt, status_changed_at: statusChangedAt, daily };
  await applyProbeWriteBatch(env, target.id, bucketAt, bucketWrites, stateUpdate, outage.write);
  return { history_points: Number(daily[day]?.total || 0), missed_points: missedPoints.length, uptime_24h: stats24.uptime, uptime_7d: stats7.uptime, incident: outage.action, storage: 'd1', state_update: stateUpdate };
}

function missedBackfillWriteLimit(env) {
  const raw = env.MISSED_WRITE_BACKFILL_MAX_BUCKETS ?? env.MISSED_BACKFILL_WRITE_MAX_BUCKETS ?? 6;
  return clamp(Number(raw), 0, 48);
}

// ── Incident tracking ────────────────────────────────────────────────────────

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

// ── Batch runner ─────────────────────────────────────────────────────────────

export async function runDueTargets(env) {
  const maxTargets = clamp(Number(env.MAX_TARGETS_PER_RUN || 60), 1, 200);
  const now = nowSec();
  const rows = await env.DB.prepare(`SELECT * FROM targets WHERE enabled = 1 ORDER BY group_name, name`).all();
  const state = await readR2State(env);
  const allTargets = rows.results || [];
  const d1Latest = await readLatestStatusMap(env, allTargets.map(target => target.id));
  const previousById = buildPreviousStateMap(allTargets, state, d1Latest);
  const targets = allTargets
    .map(target => ({ target, lastCheckedAt: Math.max(Number(previousById.get(target.id)?.checked_at || 0), Number(target.last_checked_at || 0)) }))
    .filter(item => item.lastCheckedAt <= now - Math.max(Number(item.target.interval_sec || DEFAULT_INTERVAL_SEC), MIN_INTERVAL_SEC))
    .sort((a, b) => a.lastCheckedAt - b.lastCheckedAt).slice(0, maxTargets).map(item => item.target);
  if (!targets.length) return { ok: true, count: 0, results: [] };
  return { ok: true, count: targets.length, results: await runTargetBatch(env, targets, previousById) };
}

export async function runTargetBatch(env, targets, previousById = null) {
  const concurrency = clamp(Number(env.CONCURRENCY || 20), 1, 40);
  if (!previousById) {
    const state = await readR2State(env);
    previousById = buildPreviousStateMap(targets, state, await readLatestStatusMap(env, targets.map(target => target.id)));
  }
  const out = [];
  for (let i = 0; i < targets.length; i += concurrency) {
    const chunk = targets.slice(i, i + concurrency);
    const settled = await Promise.allSettled(chunk.map(target => runSingleTarget(env, target, previousById.get(target.id) || null)));
    for (const item of settled) out.push(item.status === 'fulfilled' ? item.value : { ok: false, error: String(item.reason?.message || item.reason) });
  }
  try { await mergeR2StateUpdates(env, out.map(item => item.state_update).filter(Boolean)); } catch (_) {}
  return out.map(({ state_update, ...publicResult }) => publicResult);
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
    ).bind(...chunk).all().catch(() => ({ results: [] }));
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

function mergePreviousState(r2, d1) {
  if (!d1) return r2 || null;
  if (!r2 || Number(d1.checked_at || 0) > Number(r2.checked_at || 0)) return { ...(r2 || {}), ...d1, daily: r2?.daily || {} };
  return r2;
}
