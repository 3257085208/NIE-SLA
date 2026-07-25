const API_BASE_KEYS = ['NSTATUS_API_BASE', 'API_BASE', 'WORKER_URL'];
const DEFAULT_ADMIN_PATH = '/admin';
const ADMIN_HTML_PATH = '/admin.html';
const ADMIN_CANDIDATE = /^\/[A-Za-z0-9][A-Za-z0-9_-]{2,63}\/?$/;

function getApiBase(env) {
  for (const key of API_BASE_KEYS) {
    const value = String(env?.[key] || '').trim().replace(/\/+$/, '');
    if (value) return value;
  }
  return '';
}

function normalizedRemotePath(value) {
  const path = String(value || '').trim();
  return /^\/[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(path) ? path : DEFAULT_ADMIN_PATH;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!['GET', 'HEAD'].includes(request.method)) return context.next();
  const url = new URL(request.url);
  const pathname = url.pathname;
  const candidate = pathname === ADMIN_HTML_PATH
    || pathname === DEFAULT_ADMIN_PATH
    || pathname === `${DEFAULT_ADMIN_PATH}/`
    || ADMIN_CANDIDATE.test(pathname);
  if (!candidate) return context.next();

  const apiBase = getApiBase(env);
  if (!apiBase) return context.next();
  let config;
  try {
    const response = await fetch(`${apiBase}/api/auth/config`, {
      headers: { accept: 'application/json' },
      cf: { cacheTtl: 0 },
    });
    if (!response.ok) return context.next();
    config = await response.json();
  } catch (_) {
    return context.next();
  }

  const adminPath = normalizedRemotePath(config?.admin_path);
  if (pathname === `${adminPath}/`) {
    url.pathname = adminPath;
    return Response.redirect(url.toString(), 308);
  }
  if (pathname === adminPath) return adminAsset(context);
  if (adminPath !== DEFAULT_ADMIN_PATH && isLegacyAdminPath(pathname)) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return context.next();
}

function isLegacyAdminPath(pathname) {
  return pathname === DEFAULT_ADMIN_PATH
    || pathname === `${DEFAULT_ADMIN_PATH}/`
    || pathname === ADMIN_HTML_PATH;
}

async function adminAsset(context) {
  const assetUrl = new URL(context.request.url);
  // Pages canonicalizes /admin.html to /admin. Use that canonical URL for the
  // internal asset lookup so a custom route never leaks a redirect loop.
  assetUrl.pathname = DEFAULT_ADMIN_PATH;
  assetUrl.search = '';
  const assetRequest = new Request(assetUrl, context.request);
  const response = context.env?.ASSETS
    ? await context.env.ASSETS.fetch(assetRequest)
    : await context.next(assetRequest);
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  headers.set('x-frame-options', 'DENY');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
