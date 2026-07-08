import { ALLOWED_REGIONS, clamp, sanitizeId, publicCachePrivacyVersion } from './utils.js';
import { requireAgent, requireAgentForId, requireAnyAgent, safeJson, json, corsPreflight, ApiError } from './auth.js';
import { getStatusCached, getChecksCached } from './status.js';
import { submitAgentMetrics, getAgentMetrics, cleanupAgentMetricsR2 } from './metrics.js';
import { listTargets, createTarget, updateTarget, deleteTarget, getAgentTargets, submitAgentResults, probeNow, archiveDay, ensureV6Schema, shouldEnsureSchemaForRequest, syncEnvTargets, archiveYesterdayOncePerLocalDay, getPingTargets, submitAgentPings, getAgentPings, createPingTarget, updatePingTarget, deletePingTarget, getStats, cleanupVolatileHistory, getPublicSettings, updatePublicSettings, getAgentInstallCommand } from './admin.js';
import { enrichCfContext } from './probe.js';
import { rateLimitByIp, rateLimitGlobal, rateLimitD1 } from './ratelimit.js';
import { VERSION } from './version.js';
import { setupTOTP, verifyTOTP, disableTOTP } from './totp.js';
import { getAlertSettings, updateAlertSettings, sendTestAlert, runAlertChecks } from './alerts.js';
import { adminLoginState, requireAdminTokenOrCookie } from './admin_session.js';
import { handleAdminUiRequest } from './admin_ui.js';

function deny() { return json({ ok: false, error: 'Rate limit exceeded. Try again later.' }, 429); }

function pathParam(value) {
  try { return decodeURIComponent(String(value || '')); } catch (_) { return String(value || ''); }
}

async function withAdmin(request, env) {
  await requireAdminTokenOrCookie(request, env);
}

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (shouldEnsureSchemaForRequest(path, request.method, env)) await ensureV6Schema(env);
  if (request.method === 'OPTIONS') return corsPreflight(env);

  // Health
  if (path === '/' || path === '/api/health') return json({ ok: true, name: env.PUBLIC_SITE_NAME || 'NStatus', version: VERSION, time: new Date().toISOString() }, 200, env);

  // Global cap: 2000 req/min across all IPs
  if (!await rateLimitGlobal(request, env, 2000, 60, { bestEffort: true })) return deny();
  if (path === '/admin' || path.startsWith('/admin/')) {
    if (path === '/admin/api/session' && !await rateLimitByIp(request, env, 20, 60, { durable: true })) return deny();
    return handleAdminUiRequest(request, env);
  }

  // Public read endpoints: 120 req/min per IP (status cached 5min, checks cached 2min)
  if (path === '/api/colo-echo' && request.method === 'GET') { if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) return deny(); return json({ ok: true, colo: request.cf?.colo || null, city: request.cf?.city || null, country: request.cf?.country || null, ts: Date.now() }, 200, env); }
  if (path === '/api/status' && request.method === 'GET') { if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) return deny(); return getStatusCached(request, env, url); }
  if (path === '/api/checks' && request.method === 'GET') { if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) return deny(); return getChecksCached(request, env, url); }
  if (path === '/api/agent/metrics' && request.method === 'GET') { if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) return deny(); return getAgentMetrics(env, url, ctx); }
  if (path === '/api/agent/pings' && request.method === 'GET') { if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) return deny(); return json(await getAgentPings(env, url, ctx), 200, env, { 'cache-control': 'public, max-age=20' }); }

  // All write/authenticated endpoints: 60 req/min per IP, enforced through D1.
  if (!await rateLimitByIp(request, env, 60, 60, { durable: true })) return deny();

  // Agent endpoints
  if (path === '/api/agent/targets' && request.method === 'GET') { requireAgent(request, env); return json(await getAgentTargets(env, url), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/agent/results' && request.method === 'POST') { requireAgent(request, env); return json(await submitAgentResults(request, env), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/agent/metrics' && request.method === 'POST') return submitAgentMetrics(request, env, ctx);
  if (path === '/api/agent/ping-targets' && request.method === 'GET') {
    const agentId = url.searchParams.get('agent_id') || '';
    if (agentId) await requireAgentForId(request, env, agentId);
    else await requireAnyAgent(request, env);
    return json(await getPingTargets(env), 200, env, { 'cache-control': 'no-store' });
  }
  if (path === '/api/agent/pings' && request.method === 'POST') return json(await submitAgentPings(request, env), 200, env, { 'cache-control': 'no-store' });

  // TOTP setup (admin token required, but TOTP not enforced)
  if (path === '/api/totp/setup' && request.method === 'POST') { await requireAdminTokenOrCookie(request, env, { enforceTotp: false }); return setupTOTP(env); }
  if (path === '/api/totp/verify' && request.method === 'POST') { await requireAdminTokenOrCookie(request, env, { enforceTotp: false }); return verifyTOTP(request, env); }
  if (path === '/api/totp/disable' && request.method === 'POST') { await withAdmin(request, env); return disableTOTP(env); }

  // Login verify (token only, no TOTP — lets frontend detect if TOTP is needed)
  if (path === '/api/login' && request.method === 'GET') {
    await requireAdminTokenOrCookie(request, env, { enforceTotp: false });
    return json({ ok: true, ...(await adminLoginState(request, env)) }, 200, env);
  }

  // Stats / diagnostics (admin only)
  if (path === '/api/settings' && request.method === 'GET') { await withAdmin(request, env); await ensureV6Schema(env); return json(await getPublicSettings(env), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/settings' && request.method === 'PATCH') {
    await withAdmin(request, env);
    await ensureV6Schema(env);
    const result = await updatePublicSettings(request, env);
    const cleanup = clearStatusCaches(url, env).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(cleanup);
    else await cleanup;
    return json(result, 200, env, { 'cache-control': 'no-store' });
  }
  if (path === '/api/alerts/settings' && request.method === 'GET') { await withAdmin(request, env); await ensureV6Schema(env); return json({ ok: true, ...(await getAlertSettings(env)) }, 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/alerts/settings' && request.method === 'PATCH') { await withAdmin(request, env); await ensureV6Schema(env); return json(await updateAlertSettings(request, env), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/alerts/test' && request.method === 'POST') { await withAdmin(request, env); await ensureV6Schema(env); return json(await sendTestAlert(request, env), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/alerts/check' && request.method === 'POST') { await withAdmin(request, env); await ensureV6Schema(env); return json(await runAlertChecks(env, { force: true }), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/stats' && request.method === 'GET') { await withAdmin(request, env); return json(await getStats(env), 200, env); }
  if (path === '/api/agent/install-command' && request.method === 'GET') { await withAdmin(request, env); return json(await getAgentInstallCommand(env, url, request), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/maintenance/cleanup' && request.method === 'POST') {
    await withAdmin(request, env);
    const body = await safeJson(request).catch(() => ({}));
    return json({ ok: true, d1: await cleanupVolatileHistory(env, body), r2: await cleanupAgentMetricsR2(env, body) }, 200, env, { 'cache-control': 'no-store' });
  }

  // Admin endpoints (TOTP enforced if configured)
  if (path === '/api/debug-colo' && request.method === 'GET') { await withAdmin(request, env); return debugColo(env, url); }
  if (path === '/api/targets' && request.method === 'GET') { await withAdmin(request, env); await ensureV6Schema(env); return json(await listTargets(env), 200, env); }
  if (path === '/api/sync-targets' && request.method === 'POST') { await withAdmin(request, env); await ensureV6Schema(env); return json(await syncEnvTargets(env, { force: true }), 200, env); }
  if (path === '/api/targets' && request.method === 'POST') {
    await withAdmin(request, env);
    await ensureV6Schema(env);
    return json({ ok: true, id: (await createTarget(request, env)).id }, 201, env);
  }
  const targetMatch = path.match(/^\/api\/targets\/([^/]+)$/);
  if (targetMatch && request.method === 'PATCH') { await withAdmin(request, env); await ensureV6Schema(env); return json(await updateTarget(pathParam(targetMatch[1]), request, env), 200, env); }
  if (targetMatch && request.method === 'DELETE') { await withAdmin(request, env); await ensureV6Schema(env); return json(await deleteTarget(pathParam(targetMatch[1]), env), 200, env); }
  if (path === '/api/probe-now' && request.method === 'POST') { await withAdmin(request, env); if (!await rateLimitD1(env, 'probe-now', 5, 60)) return deny(); return json(await probeNow(env, (await safeJson(request))?.id || null), 200, env); }
  if (path === '/api/archive' && request.method === 'POST') { await withAdmin(request, env); return json(await archiveDay(env, (await safeJson(request))?.day || archiveYesterdayLocal(env)), 200, env); }
  if (path === '/api/ping-targets' && request.method === 'POST') { await withAdmin(request, env); return json(await createPingTarget(request, env), 201, env); }
  if (path === '/api/ping-targets' && request.method === 'GET') { await withAdmin(request, env); return json(await getPingTargets(env, { enabledOnly: false }), 200, env); }
  const pingMatch = path.match(/^\/api\/ping-targets\/([^/]+)$/);
  if (pingMatch && request.method === 'PATCH') { await withAdmin(request, env); return json(await updatePingTarget(pathParam(pingMatch[1]), request, env), 200, env); }
  if (pingMatch && request.method === 'DELETE') { await withAdmin(request, env); return json(await deletePingTarget(pathParam(pingMatch[1]), env), 200, env); }

  return json({ ok: false, error: 'Not found' }, 404, env);
}

function archiveYesterdayLocal(env) {
  const d = new Date((Math.floor(Date.now() / 1000) + clamp(Number(env?.TIMEZONE_OFFSET_MINUTES ?? 480), -720, 840) * 60 - 86400) * 1000);
  return d.toISOString().slice(0, 10);
}

async function clearStatusCaches(url, env) {
  if (!globalThis.caches?.default) return;
  const daysList = [1, 7, 30, 90];
  await Promise.all(daysList.map((days) => {
    const cacheUrl = new URL(`${url.origin}/api/status`);
    cacheUrl.searchParams.set('days', String(days));
    cacheUrl.searchParams.set('privacy', publicCachePrivacyVersion(env));
    return caches.default.delete(new Request(cacheUrl.toString(), { method: 'GET' }));
  }));
}

async function debugColo(env, url) {
  const region = url.searchParams.get('region') || 'auto';
  const targetId = url.searchParams.get('target_id') || '';
  const version = sanitizeId(env.REGION_PROXY_VERSION || 'v9');
  if (region !== 'auto' && env.REGION_PROXY && ALLOWED_REGIONS.has(region)) {
    const targetKey = sanitizeId(targetId || 'debug');
    const objectName = `probe-region-${region}-${version}-${targetKey}`;
    const id = env.REGION_PROXY.idFromName(objectName);
    const stub = env.REGION_PROXY.get(id, { locationHint: region });
    const res = await stub.fetch('https://nstatus.internal/debug-colo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ region, version, objectName }) });
    const body = await res.json();
    return json({ ok: true, region, version, objectName, via: 'durable_object', ...body }, 200, env);
  }
  const cf = await enrichCfContext({}, env);
  return json({ ok: true, region, version, via: 'worker', colo: cf.colo, echo_colo: cf.echo_colo, trace_colo: cf.trace_colo, request_colo: cf.request_colo }, 200, env);
}
