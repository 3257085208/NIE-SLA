import { DEFAULT_ADMIN_PATH, getAdminPath } from './admin-path.js';
import { clamp } from './utils.js';

const ADMIN_HTML_PATH = '/admin.html';
const ADMIN_CANDIDATE = /^\/[A-Za-z0-9][A-Za-z0-9_-]{2,63}\/?$/;

// Anonymous scanners hit every single-segment path, so resolving the custom
// admin path straight from D1 made each probe a database read. A short-lived
// isolate cache keeps the routing correct while collapsing that traffic.
let adminPathCache = { value: null, expiresAt: 0 };

async function resolveAdminPath(env) {
  const ttlSec = clamp(Number(env.ADMIN_PATH_CACHE_SEC || 60), 0, 3600);
  const now = Date.now();
  if (ttlSec > 0 && adminPathCache.value && adminPathCache.expiresAt > now) return adminPathCache.value;
  const value = await getAdminPath(env);
  adminPathCache = { value, expiresAt: now + ttlSec * 1000 };
  return value;
}

export async function routeStaticAssets(request, env) {
  if (!env?.ASSETS || !['GET', 'HEAD'].includes(request.method)) return null;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const shouldResolveAdminPath = pathname === ADMIN_HTML_PATH
    || pathname === DEFAULT_ADMIN_PATH
    || pathname === `${DEFAULT_ADMIN_PATH}/`
    || ADMIN_CANDIDATE.test(pathname);

  if (shouldResolveAdminPath) {
    const adminPath = await resolveAdminPath(env);
    if (pathname === `${adminPath}/`) {
      url.pathname = adminPath;
      return Response.redirect(url.toString(), 308);
    }
    if (pathname === adminPath) return adminAssetResponse(request, env);
    if (adminPath !== DEFAULT_ADMIN_PATH && isLegacyAdminPath(pathname)) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  }

  return env.ASSETS.fetch(request);
}

function isLegacyAdminPath(pathname) {
  return pathname === DEFAULT_ADMIN_PATH
    || pathname === `${DEFAULT_ADMIN_PATH}/`
    || pathname === ADMIN_HTML_PATH;
}

async function adminAssetResponse(request, env) {
  const assetUrl = new URL(request.url);


  assetUrl.pathname = DEFAULT_ADMIN_PATH;
  assetUrl.search = '';
  const response = await env.ASSETS.fetch(new Request(assetUrl, request));
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
