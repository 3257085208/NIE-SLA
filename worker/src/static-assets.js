import { DEFAULT_ADMIN_PATH, getAdminPath } from './admin-path.js';

const ADMIN_HTML_PATH = '/admin.html';
const ADMIN_CANDIDATE = /^\/[A-Za-z0-9][A-Za-z0-9_-]{2,63}\/?$/;

export async function routeStaticAssets(request, env) {
  if (!env?.ASSETS || !['GET', 'HEAD'].includes(request.method)) return null;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const shouldResolveAdminPath = pathname === ADMIN_HTML_PATH
    || pathname === DEFAULT_ADMIN_PATH
    || pathname === `${DEFAULT_ADMIN_PATH}/`
    || ADMIN_CANDIDATE.test(pathname);

  if (shouldResolveAdminPath) {
    const adminPath = await getAdminPath(env);
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
  // Static Assets canonicalizes /admin.html to /admin. Fetching the canonical
  // URL internally avoids returning that redirect to /admin in a loop.
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
