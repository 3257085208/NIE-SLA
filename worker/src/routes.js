import { ALLOWED_REGIONS, clamp, sanitizeId, publicCachePrivacyVersion, sha256Hex } from './utils.js';
import { requireAgentForId, requireAnyAgent, requireAgentIdentity, requireLatencyAgentForId, safeJson, json, corsPreflight, ApiError, constantTimeEqual } from './auth.js';
import { getStatusCached, getChecksCached } from './status.js';
import { submitAgentMetrics, getAgentMetricsCached, cleanupAgentMetricsR2 } from './metrics.js';
import { listTargets, createTarget, updateTarget, reorderTargets, deleteTarget, getAgentTargets, submitAgentResults, probeNow, archiveDay, ensureV6Schema, shouldEnsureSchemaForRequest, syncEnvTargets, archiveYesterdayOncePerLocalDay, getPingTargets, submitAgentPings, getAgentPings, createPingTarget, updatePingTarget, deletePingTarget, getStats, cleanupVolatileHistory, getPublicSettings, updatePublicSettings, getAgentUpdatePolicy, getAgentInstallCommand, getLatencyHealth, listLatencyAgents, createLatencyAgent, updateLatencyAgent, deleteLatencyAgent, getLatencyAgentInstallCommand, getLatencyAgentUpdatePolicy, getLatencyAgentTargets, submitLatencyAgentResults, getPublicLatency } from './admin.js';
import { enrichCfContext } from './probe.js';
import { rateLimitByIp, rateLimitGlobal, rateLimitD1 } from './ratelimit.js';
import { VERSION } from './version.js';
import { setupTOTP, verifyTOTP, disableTOTP, validateAdminSession, checkTOTP } from './totp.js';
import { getAlertSettings, updateAlertSettings, sendTestAlert, runAlertChecks } from './alerts.js';
import { isAgentApiPath } from './route-policy.js';
import { developerApiPreflight, developerApiUrl, getDeveloperApiManifest, withDeveloperApiHeaders } from './developer-api.js';
import { deleteExtension, getExtensionFile, listManagedExtensions, listManagedExtensionsByType, listPublicExtensions, updateExtension, uploadExtension } from './extensions.js';
import { publicNodeQualityReport } from './nodequality.js';
import { adminAuthConfig, completeGitHubOAuth, finishGitHubOAuth, getAdminAccount, passwordLogin, startGitHubOAuth, updateAdminAccount } from './admin-auth.js';
import { getAppUpdateInfo } from './app-update.js';
import { getCountryCities } from './location-catalog.js';

function deny() { return json({ ok: false, error: '请求过于频繁，请稍后重试。' }, 429); }
function pathParam(v) { try { return decodeURIComponent(String(v || '')); } catch (_) { return String(v || ''); } }
async function withAdmin(request, env) {
  const presentedSession = String(request.headers.get('x-admin-session') || '').trim();
  const session = presentedSession ? await validateAdminSession(env, presentedSession) : null;
  if (!session?.valid) throw new ApiError(401, '需要有效的管理会话，请重新登录');
  return session;
}

async function loginState(request, env) {
  if (!env.DB) return { totp_enabled: false, totp_required: false, session_valid: false, session_id: null, session_expires_at: null };
  const totp = await checkTOTP(env);
  const presentedSession = String(request.headers.get('x-admin-session') || '').trim();
  const session = presentedSession ? await validateAdminSession(env, presentedSession) : null;
  const sessionValid = Boolean(session?.valid);
  return {
    totp_enabled: !!totp.totp_enabled,
    totp_required: !!totp.totp_enabled,
    session_valid: sessionValid,
    session_id: sessionValid ? presentedSession : null,
    session_expires_at: sessionValid ? session.expires_at : null,
    auth_mode: sessionValid ? 'session' : 'login_required',
    provider: sessionValid ? session.provider : null,
    subject: sessionValid ? session.subject : null,
  };
}

async function loginGate(request, env) {
  const presentedSession = String(request.headers.get('x-admin-session') || '').trim();
  if (presentedSession) {
    const session = await validateAdminSession(env, presentedSession);
    if (!session?.valid) throw new ApiError(401, '会话无效或已过期');
    const totp = await checkTOTP(env);
    return {
      totp_enabled: !!totp.totp_enabled,
      totp_required: !!totp.totp_enabled,
      session_valid: true,
      session_id: presentedSession,
      session_expires_at: session.expires_at,
      auth_mode: 'session',
    };
  }
  throw new ApiError(401, '会话无效或已过期');
}

async function sessionMatches(storedSession, presentedSession) {
  const stored = String(storedSession || '');
  const presented = String(presentedSession || '');
  if (!stored || !presented) return false;
  if (stored.startsWith('sha256:')) return constantTimeEqual(stored.slice(7), await sha256Hex(presented));
  return constantTimeEqual(stored, presented);
}

// ── Route handlers (static) ──────────────────────────────────────────────────

const ROUTES = [
  // Health — no rate limit
  { method: 'GET', path: '/' },        // handled below
  { method: 'GET', path: '/api/health' },

  // Public read (best-effort rate limit)
  { method: 'GET', path: '/api/colo-echo', rl: 'public' },
  { method: 'GET', path: '/api/status', rl: 'public' },
  { method: 'GET', path: '/api/checks', rl: 'public' },
  { method: 'GET', path: '/api/agent/metrics', rl: 'public' },
  { method: 'GET', path: '/api/agent/pings', rl: 'public' },
  { method: 'GET', path: '/api/latency', rl: 'public' },
  { method: 'GET', path: '/api/v1', rl: 'public' },
  { method: 'GET', path: '/api/v1/manifest', rl: 'public' },
  { method: 'GET', path: '/api/v1/status', rl: 'public' },
  { method: 'GET', path: '/api/v1/checks', rl: 'public' },
  { method: 'GET', path: '/api/v1/metrics', rl: 'public' },
  { method: 'GET', path: '/api/v1/pings', rl: 'public' },
  { method: 'GET', path: '/api/v1/latency', rl: 'public' },
  { method: 'GET', path: '/api/extensions', rl: 'public' },
  { method: 'GET', path: '/api/nq/:id', rl: 'public' },
  { method: 'GET', path: '/api/nq/:id/image/:tab', rl: 'public' },

  // Agent endpoints
  { method: 'GET', path: '/api/agent/targets', rl: 'write' },
  { method: 'POST', path: '/api/agent/results', rl: 'write' },
  { method: 'POST', path: '/api/agent/metrics', rl: 'write' },
  { method: 'GET', path: '/api/agent/update-policy', rl: 'write' },
  { method: 'GET', path: '/api/agent/ping-targets', rl: 'write' },
  { method: 'POST', path: '/api/agent/pings', rl: 'write' },
  { method: 'GET', path: '/api/latency-agent/targets', rl: 'write' },
  { method: 'POST', path: '/api/latency-agent/results', rl: 'write' },
  { method: 'GET', path: '/api/latency-agent/update-policy', rl: 'write' },

  // TOTP
  { method: 'POST', path: '/api/totp/setup', rl: 'write' },
  { method: 'POST', path: '/api/totp/verify', rl: 'write' },
  { method: 'POST', path: '/api/totp/disable', rl: 'write' },

  // Login
  { method: 'GET', path: '/api/auth/config', rl: 'public' },
  { method: 'POST', path: '/api/auth/login', rl: 'write' },
  { method: 'GET', path: '/api/auth/account', rl: 'write' },
  { method: 'PATCH', path: '/api/auth/account', rl: 'write' },
  { method: 'GET', path: '/api/auth/github/start', rl: 'write' },
  { method: 'GET', path: '/api/auth/github/callback', rl: 'write' },
  { method: 'POST', path: '/api/auth/github/complete', rl: 'write' },
  { method: 'GET', path: '/api/login', rl: 'write' },

  // Settings & alerts
  { method: 'GET', path: '/api/settings', rl: 'write' },
  { method: 'PATCH', path: '/api/settings', rl: 'write' },
  { method: 'GET', path: '/api/alerts/settings', rl: 'write' },
  { method: 'PATCH', path: '/api/alerts/settings', rl: 'write' },
  { method: 'POST', path: '/api/alerts/test', rl: 'write' },
  { method: 'POST', path: '/api/alerts/check', rl: 'write' },
  { method: 'GET', path: '/api/system/update', rl: 'write' },
  { method: 'GET', path: '/api/catalog/cities', rl: 'write' },

  // Stats & maintenance
  { method: 'GET', path: '/api/stats', rl: 'write' },
  { method: 'GET', path: '/api/agent/install-command', rl: 'write' },
  { method: 'GET', path: '/api/latency-agent/install-command', rl: 'write' },
  { method: 'POST', path: '/api/maintenance/cleanup', rl: 'write' },
  { method: 'GET', path: '/api/extensions/manage', rl: 'write' },
  { method: 'POST', path: '/api/extensions/upload', rl: 'write' },
  { method: 'GET', path: '/api/themes/manage', rl: 'write' },
  { method: 'POST', path: '/api/themes/upload', rl: 'write' },
  { method: 'GET', path: '/api/plugins/manage', rl: 'write' },
  { method: 'POST', path: '/api/plugins/upload', rl: 'write' },

  // Admin CRUD
  { method: 'GET', path: '/api/debug-colo', rl: 'write' },
  { method: 'GET', path: '/api/debug/latency-health', rl: 'write' },
  { method: 'GET', path: '/api/targets', rl: 'write' },
  { method: 'POST', path: '/api/targets', rl: 'write' },
  { method: 'PATCH', path: '/api/targets/order', rl: 'write' },
  { method: 'POST', path: '/api/sync-targets', rl: 'write' },
  { method: 'POST', path: '/api/probe-now', rl: 'write' },
  { method: 'POST', path: '/api/archive', rl: 'write' },
  { method: 'POST', path: '/api/ping-targets', rl: 'write' },
  { method: 'GET', path: '/api/ping-targets', rl: 'write' },
  { method: 'GET', path: '/api/latency-agents', rl: 'write' },
  { method: 'POST', path: '/api/latency-agents', rl: 'write' },
];

const KEY = (method, path) => `${method} ${path}`;

async function dispatchStatic(env, url, request, ctx) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const m = request.method;

  // Health
  if (path === '/' || path === '/api/health') {
    return json({ ok: true, name: env.PUBLIC_SITE_NAME || 'NIE-SLA', version: VERSION, time: new Date().toISOString() }, 200, env);
  }

  // Public read
  if (path === '/api/colo-echo' && m === 'GET') { if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) return deny(); return json({ ok: true, colo: request.cf?.colo || null, city: request.cf?.city || null, country: request.cf?.country || null, ts: Date.now() }, 200, env); }
  if (path === '/api/status' && m === 'GET') { if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) return deny(); return getStatusCached(request, env, url, ctx); }
  if (path === '/api/checks' && m === 'GET') { if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) return deny(); return getChecksCached(request, env, url, ctx); }
  if (path === '/api/agent/metrics' && m === 'GET') { if (!await rateLimitByIp(request, env, 30, 60, { bestEffort: true })) return deny(); return getAgentMetricsCached(request, env, url, ctx); }
  if (path === '/api/agent/pings' && m === 'GET') { if (!await rateLimitByIp(request, env, 30, 60, { bestEffort: true })) return deny(); return json(await getAgentPings(env, url), 200, env, { 'cache-control': 'public, max-age=20' }); }
  if (path === '/api/latency' && m === 'GET') { if (!await rateLimitByIp(request, env, 60, 60, { bestEffort: true })) return deny(); await ensureV6Schema(env); return json(await getPublicLatency(env, url), 200, env, { 'cache-control': 'public, max-age=20' }); }
  if ((path === '/api/v1' || path === '/api/v1/manifest') && m === 'GET') { if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) return withDeveloperApiHeaders(deny(), request, env); return withDeveloperApiHeaders(json(getDeveloperApiManifest(request, env, VERSION), 200, env, { 'cache-control': 'public, max-age=300' }), request, env); }
  if (path === '/api/v1/status' && m === 'GET') { if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) return withDeveloperApiHeaders(deny(), request, env); return withDeveloperApiHeaders(await getStatusCached(request, env, developerApiUrl(url, '/api/status'), ctx), request, env); }
  if (path === '/api/v1/checks' && m === 'GET') { if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) return withDeveloperApiHeaders(deny(), request, env); return withDeveloperApiHeaders(await getChecksCached(request, env, developerApiUrl(url, '/api/checks'), ctx), request, env); }
  if (path === '/api/v1/metrics' && m === 'GET') { if (!await rateLimitByIp(request, env, 30, 60, { bestEffort: true })) return withDeveloperApiHeaders(deny(), request, env); return withDeveloperApiHeaders(await getAgentMetricsCached(request, env, developerApiUrl(url, '/api/agent/metrics'), ctx), request, env); }
  if (path === '/api/v1/pings' && m === 'GET') { if (!await rateLimitByIp(request, env, 30, 60, { bestEffort: true })) return withDeveloperApiHeaders(deny(), request, env); return withDeveloperApiHeaders(json(await getAgentPings(env, developerApiUrl(url, '/api/agent/pings')), 200, env, { 'cache-control': 'public, max-age=20' }), request, env); }
  if (path === '/api/v1/latency' && m === 'GET') { if (!await rateLimitByIp(request, env, 60, 60, { bestEffort: true })) return withDeveloperApiHeaders(deny(), request, env); await ensureV6Schema(env); return withDeveloperApiHeaders(json(await getPublicLatency(env, developerApiUrl(url, '/api/latency')), 200, env, { 'cache-control': 'public, max-age=20' }), request, env); }
  if (path === '/api/extensions' && m === 'GET') { if (!await rateLimitByIp(request, env, 60, 60, { bestEffort: true })) return deny(); return json(await listPublicExtensions(env), 200, env, { 'cache-control': 'public, max-age=20' }); }
  const nqImageMatch = path.match(/^\/api\/(?:nq|nodequality)\/([^/]+)\/image\/([^/]+)$/);
  if (nqImageMatch && m === 'GET') {
    if (!await rateLimitByIp(request, env, 60, 60, { bestEffort: true })) return deny();
    await ensureV6Schema(env);
    const id = pathParam(nqImageMatch[1]);
    const tabId = pathParam(nqImageMatch[2]);
    const target = await env.DB.prepare(`SELECT id, name, type, enabled, nq_report, nq_updated_at FROM targets WHERE id = ?`).bind(id).first().catch(() => null);
    if (!target || target.type !== 'tcp' || Number(target.enabled || 0) !== 1) return new Response('Not found', { status: 404 });
    const report = publicNodeQualityReport(target);
    const imageTab = report?.tabs?.find((tab) => tab.id === tabId && tab.kind === 'image' && tab.image);
    if (!imageTab) return new Response('Not found', { status: 404 });
    let upstream;
    try {
      upstream = await fetch(imageTab.image, {
        redirect: 'follow',
        headers: {
          accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          referer: `${url.origin}/`,
          'user-agent': 'NIE-SLA NodeQuality image proxy',
        },
      });
    } catch (_) {
      return new Response('Image upstream unavailable', { status: 502 });
    }
    const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();
    if (!upstream.ok || !contentType.startsWith('image/')) return new Response('Image upstream unavailable', { status: 502 });
    const headers = new Headers({
      'cache-control': 'public, max-age=3600',
      'content-type': contentType,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    return new Response(upstream.body, { status: 200, headers });
  }
  const nqMatch = path.match(/^\/api\/(?:nq|nodequality)\/([^/]+)$/);
  if (nqMatch && m === 'GET') {
    if (!await rateLimitByIp(request, env, 60, 60, { bestEffort: true })) return deny();
    await ensureV6Schema(env);
    const id = pathParam(nqMatch[1]);
    const target = await env.DB.prepare(`SELECT id, name, type, enabled, nq_report, nq_updated_at FROM targets WHERE id = ?`).bind(id).first().catch(() => null);
    if (!target || target.type !== 'tcp' || Number(target.enabled || 0) !== 1) return json({ ok: false, error: '未找到 NodeQuality 报告' }, 404, env);
    const report = publicNodeQualityReport(target);
    if (!report) return json({ ok: false, error: '该探针尚未上传 NodeQuality 报告' }, 404, env);
    return json(report, 200, env, { 'cache-control': 'public, max-age=30' });
  }
  const extensionFileMatch = path.match(/^\/api\/extensions\/file\/([^/]+)\/(.+)$/);
  if (extensionFileMatch && m === 'GET') { if (!await rateLimitByIp(request, env, 300, 60, { bestEffort: true })) return deny(); return getExtensionFile(env, pathParam(extensionFileMatch[1]), pathParam(extensionFileMatch[2])); }

  // Prefer cheap bearer presence check before durable D1 rate-limit tables.
  // Unauthenticated admin probes should not burn durable counters.
  const hasBearer = /^bearer\s+\S+/i.test(request.headers.get('authorization') || '');
  if (!isAgentApiPath(path)) {
    if (!hasBearer) {
      if (!await rateLimitByIp(request, env, 30, 60, { bestEffort: true })) return deny();
    } else if (!await rateLimitByIp(request, env, 60, 60, { durable: true })) {
      return deny();
    }
  }

  // Agent
  if (path === '/api/agent/targets' && m === 'GET') {
    const agentId = url.searchParams.get('agent_id') || '';
    if (agentId) await requireAgentIdentity(request, env, agentId); else await requireAnyAgent(request, env);
    if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) return deny();
    return json(await getAgentTargets(env, url), 200, env, { 'cache-control': 'no-store' });
  }
  if (path === '/api/agent/results' && m === 'POST') {
    const body = await safeJson(request);
    if (body.agent_id) await requireAgentIdentity(request, env, body.agent_id); else await requireAnyAgent(request, env);
    if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) return deny();
    return json(await submitAgentResults(request, env, body), 200, env, { 'cache-control': 'no-store' });
  }
  if (path === '/api/agent/metrics' && m === 'POST') return submitAgentMetrics(request, env);
  if (path === '/api/agent/update-policy' && m === 'GET') { const agentId = url.searchParams.get('agent_id') || ''; await requireAgentForId(request, env, agentId); if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) return deny(); return json(await getAgentUpdatePolicy(env, request), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/agent/ping-targets' && m === 'GET') { const agentId = url.searchParams.get('agent_id') || ''; if (agentId) await requireAgentForId(request, env, agentId); else await requireAnyAgent(request, env); if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) return deny(); return json(await getPingTargets(env), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/agent/pings' && m === 'POST') return json(await submitAgentPings(request, env), 200, env, { 'cache-control': 'no-store' });
  if (path === '/api/latency-agent/targets' && m === 'GET') { await ensureV6Schema(env); const nodeId = url.searchParams.get('node_id') || ''; await requireLatencyAgentForId(request, env, nodeId); return json(await getLatencyAgentTargets(env), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/latency-agent/results' && m === 'POST') { await ensureV6Schema(env); const body = await safeJson(request); await requireLatencyAgentForId(request, env, body.node_id); return json(await submitLatencyAgentResults(request, env, body), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/latency-agent/update-policy' && m === 'GET') { await ensureV6Schema(env); const nodeId = url.searchParams.get('node_id') || ''; await requireLatencyAgentForId(request, env, nodeId); if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) return deny(); return json(await getLatencyAgentUpdatePolicy(env), 200, env, { 'cache-control': 'no-store' }); }

  // TOTP
  if (path === '/api/totp/setup' && m === 'POST') { await withAdmin(request, env); return setupTOTP(env); }
  if (path === '/api/totp/verify' && m === 'POST') { await withAdmin(request, env); return verifyTOTP(request, env); }
  if (path === '/api/totp/disable' && m === 'POST') { await withAdmin(request, env); return disableTOTP(env); }

  // Login
  if (path === '/api/auth/config' && m === 'GET') return json(await adminAuthConfig(env), 200, env, { 'cache-control': 'no-store' });
  if (path === '/api/auth/login' && m === 'POST') return json(await passwordLogin(request, env), 200, env, { 'cache-control': 'no-store' });
  if (path === '/api/auth/account' && m === 'GET') { await withAdmin(request, env); return json(await getAdminAccount(env), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/auth/account' && m === 'PATCH') { await withAdmin(request, env); if (!await rateLimitD1(env, 'admin-account-update', 3, 600)) return deny(); return json(await updateAdminAccount(request, env), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/auth/github/start' && m === 'GET') return startGitHubOAuth(request, env);
  if (path === '/api/auth/github/callback' && m === 'GET') return finishGitHubOAuth(request, env);
  if (path === '/api/auth/github/complete' && m === 'POST') return json(await completeGitHubOAuth(request, env), 200, env, { 'cache-control': 'no-store' });
  if (path === '/api/login' && m === 'GET') { return json({ ok: true, ...(await loginGate(request, env)) }, 200, env); }

  // Settings
  if (path === '/api/settings' && m === 'GET') { await withAdmin(request, env); await ensureV6Schema(env); return json(await getPublicSettings(env, { includeAdmin: true }), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/settings' && m === 'PATCH') { await withAdmin(request, env); await ensureV6Schema(env); const result = await updatePublicSettings(request, env); clearStatusCaches(url, env).catch(() => {}); return json(result, 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/system/update' && m === 'GET') { await withAdmin(request, env); return json(await getAppUpdateInfo(env, { force: url.searchParams.get('refresh') === '1' }), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/catalog/cities' && m === 'GET') { await withAdmin(request, env); return json(await getCountryCities(url.searchParams.get('country')), 200, env, { 'cache-control': 'private, max-age=86400' }); }

  // Alerts
  if (path === '/api/alerts/settings' && m === 'GET') { await withAdmin(request, env); await ensureV6Schema(env); return json({ ok: true, ...(await getAlertSettings(env)) }, 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/alerts/settings' && m === 'PATCH') { await withAdmin(request, env); await ensureV6Schema(env); return json(await updateAlertSettings(request, env), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/alerts/test' && m === 'POST') { await withAdmin(request, env); await ensureV6Schema(env); return json(await sendTestAlert(request, env), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/alerts/check' && m === 'POST') { await withAdmin(request, env); await ensureV6Schema(env); return json(await runAlertChecks(env, { force: true }), 200, env, { 'cache-control': 'no-store' }); }

  // Stats & maintenance
  if (path === '/api/stats' && m === 'GET') { await withAdmin(request, env); return json(await getStats(env), 200, env); }
  if (path === '/api/agent/install-command' && m === 'GET') { await withAdmin(request, env); await ensureV6Schema(env); return json(await getAgentInstallCommand(env, url, request), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/latency-agent/install-command' && m === 'GET') { await withAdmin(request, env); await ensureV6Schema(env); return json(await getLatencyAgentInstallCommand(env, url, request), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/maintenance/cleanup' && m === 'POST') { await withAdmin(request, env); const body = await safeJson(request).catch(() => ({})); return json({ ok: true, d1: await cleanupVolatileHistory(env, body), r2: await cleanupAgentMetricsR2(env, body) }, 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/extensions/manage' && m === 'GET') { await withAdmin(request, env); return json(await listManagedExtensions(env), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/extensions/upload' && m === 'POST') { await withAdmin(request, env); return json(await uploadExtension(request, env), 201, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/themes/manage' && m === 'GET') { await withAdmin(request, env); return json(await listManagedExtensionsByType(env, 'theme'), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/themes/upload' && m === 'POST') { await withAdmin(request, env); return json(await uploadExtension(request, env, 'theme'), 201, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/plugins/manage' && m === 'GET') { await withAdmin(request, env); return json(await listManagedExtensionsByType(env, 'plugin'), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/plugins/upload' && m === 'POST') { await withAdmin(request, env); return json(await uploadExtension(request, env, 'plugin'), 201, env, { 'cache-control': 'no-store' }); }

  // Admin CRUD
  if (path === '/api/debug-colo' && m === 'GET') { await withAdmin(request, env); return debugColo(env, url); }
  if (path === '/api/debug/latency-health' && m === 'GET') { await withAdmin(request, env); return json(await getLatencyHealth(env, url), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/targets' && m === 'GET') { await withAdmin(request, env); await ensureV6Schema(env); return json(await listTargets(env), 200, env); }
  if (path === '/api/sync-targets' && m === 'POST') { await withAdmin(request, env); await ensureV6Schema(env); return json(await syncEnvTargets(env, { force: true }), 200, env); }
  if (path === '/api/targets' && m === 'POST') { await withAdmin(request, env); await ensureV6Schema(env); return json({ ok: true, id: (await createTarget(request, env)).id }, 201, env); }
  if (path === '/api/targets/order' && m === 'PATCH') { await withAdmin(request, env); await ensureV6Schema(env); const result = await reorderTargets(request, env); if (result.ok) await clearStatusCaches(url, env); return json(result, result.ok ? 200 : 400, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/probe-now' && m === 'POST') { await withAdmin(request, env); if (!await rateLimitD1(env, 'probe-now', 5, 60)) return deny(); return json(await probeNow(env, (await safeJson(request))?.id || null), 200, env); }
  if (path === '/api/archive' && m === 'POST') { await withAdmin(request, env); return json(await archiveDay(env, (await safeJson(request))?.day || archiveYesterdayLocal(env)), 200, env); }
  if (path === '/api/ping-targets' && m === 'POST') { await withAdmin(request, env); return json(await createPingTarget(request, env), 201, env); }
  if (path === '/api/ping-targets' && m === 'GET') { await withAdmin(request, env); return json(await getPingTargets(env, { enabledOnly: false }), 200, env); }
  if (path === '/api/latency-agents' && m === 'GET') { await withAdmin(request, env); await ensureV6Schema(env); return json(await listLatencyAgents(env), 200, env, { 'cache-control': 'no-store' }); }
  if (path === '/api/latency-agents' && m === 'POST') { await withAdmin(request, env); await ensureV6Schema(env); return json(await createLatencyAgent(request, env), 201, env, { 'cache-control': 'no-store' }); }

  // Parameterized routes
  const targetMatch = path.match(/^\/api\/targets\/([^/]+)$/);
  if (targetMatch && m === 'PATCH') { await withAdmin(request, env); await ensureV6Schema(env); return json(await updateTarget(pathParam(targetMatch[1]), request, env), 200, env); }
  if (targetMatch && m === 'DELETE') { await withAdmin(request, env); await ensureV6Schema(env); return json(await deleteTarget(pathParam(targetMatch[1]), env), 200, env); }

  const pingMatch = path.match(/^\/api\/ping-targets\/([^/]+)$/);
  if (pingMatch && m === 'PATCH') { await withAdmin(request, env); return json(await updatePingTarget(pathParam(pingMatch[1]), request, env), 200, env); }
  if (pingMatch && m === 'DELETE') { await withAdmin(request, env); return json(await deletePingTarget(pathParam(pingMatch[1]), env), 200, env); }

  const latencyAgentMatch = path.match(/^\/api\/latency-agents\/([^/]+)$/);
  if (latencyAgentMatch && m === 'PATCH') { await withAdmin(request, env); await ensureV6Schema(env); return json(await updateLatencyAgent(pathParam(latencyAgentMatch[1]), request, env), 200, env); }
  if (latencyAgentMatch && m === 'DELETE') { await withAdmin(request, env); await ensureV6Schema(env); return json(await deleteLatencyAgent(pathParam(latencyAgentMatch[1]), env), 200, env); }

  const extensionMatch = path.match(/^\/api\/extensions\/([^/]+)$/);
  if (extensionMatch && m === 'PATCH') { await withAdmin(request, env); return json(await updateExtension(pathParam(extensionMatch[1]), request, env), 200, env, { 'cache-control': 'no-store' }); }
  if (extensionMatch && m === 'DELETE') { await withAdmin(request, env); return json(await deleteExtension(pathParam(extensionMatch[1]), env), 200, env, { 'cache-control': 'no-store' }); }

  const managedExtensionMatch = path.match(/^\/api\/(themes|plugins)\/([^/]+)$/);
  if (managedExtensionMatch) {
    await withAdmin(request, env);
    const expectedType = managedExtensionMatch[1] === 'themes' ? 'theme' : 'plugin';
    const extensionId = pathParam(managedExtensionMatch[2]);
    if (m === 'PATCH') return json(await updateExtension(extensionId, request, env, expectedType), 200, env, { 'cache-control': 'no-store' });
    if (m === 'DELETE') return json(await deleteExtension(extensionId, env, expectedType), 200, env, { 'cache-control': 'no-store' });
  }

  return null;
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (shouldEnsureSchemaForRequest(path, request.method, env)) await ensureV6Schema(env);
  if (request.method === 'OPTIONS') return path === '/api/v1' || path.startsWith('/api/v1/') ? developerApiPreflight(request, env) : corsPreflight(env);

  // Global cap
  if (!await rateLimitGlobal(request, env, 2000, 60, { bestEffort: true })) return deny();

  const response = await dispatchStatic(env, url, request, ctx);
  if (response) return response;

  return json({ ok: false, error: '未找到请求的资源' }, 404, env);
}

function archiveYesterdayLocal(env) {
  const d = new Date((Math.floor(Date.now() / 1000) + clamp(Number(env?.TIMEZONE_OFFSET_MINUTES ?? 480), -720, 840) * 60 - 86400) * 1000);
  return d.toISOString().slice(0, 10);
}

async function clearStatusCaches(url, env) {
  if (!globalThis.caches?.default) return;
  const daysList = [1, 7, 30, 90];
  await Promise.all(daysList.flatMap((days) => [false, true].map((lite) => {
      const cacheUrl = new URL(`${url.origin}/api/status`);
      cacheUrl.searchParams.set('days', String(days));
      cacheUrl.searchParams.set('privacy', publicCachePrivacyVersion(env));
      if (lite) cacheUrl.searchParams.set('lite', '1');
      return caches.default.delete(new Request(cacheUrl.toString(), { method: 'GET' }));
    })));
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
