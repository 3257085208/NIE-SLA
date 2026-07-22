import { resolveCorsOrigin } from './auth.js';

export const DEVELOPER_API_VERSION = 'v1';

const ENDPOINTS = [
  { path: '/status', description: 'Public status, targets, summaries, incidents, and current telemetry' },
  { path: '/checks', description: 'Availability and Cloudflare latency history for one target' },
  { path: '/metrics', description: 'Public VPS metric history for one Agent target' },
  { path: '/pings', description: 'Public Agent TCP Ping history' },
  { path: '/latency', description: 'External Latency Agent history for one target' },
];

export function getDeveloperApiManifest(request, env, workerVersion) {
  const baseUrl = `${new URL(request.url).origin}/api/${DEVELOPER_API_VERSION}`;
  return {
    ok: true,
    api_version: DEVELOPER_API_VERSION,
    worker_version: workerVersion,
    stability: 'stable',
    base_url: baseUrl,
    authentication: { read: 'none', write: 'not_available' },
    cors: { mode: 'explicit-origin-allowlist', environment: 'DEVELOPER_API_ORIGINS' },
    extensions: {
      alternate_frontends: true,
      themes: true,
      read_only_plugins: true,
      privileged_plugins: false,
    },
    endpoints: ENDPOINTS.map(endpoint => ({ method: 'GET', url: baseUrl + endpoint.path, ...endpoint })),
  };
}

export function developerApiUrl(url, canonicalPath) {
  const result = new URL(url);
  result.pathname = canonicalPath;
  return result;
}

export function withDeveloperApiHeaders(response, request, env) {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', resolveDeveloperApiOrigin(request, env) || 'null');
  headers.set('access-control-allow-methods', 'GET,OPTIONS');
  headers.set('access-control-allow-headers', 'content-type');
  headers.set('x-nstatus-api-version', DEVELOPER_API_VERSION);
  headers.append('vary', 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function developerApiPreflight(request, env) {
  return withDeveloperApiHeaders(new Response(null, { status: 204 }), request, env);
}

export function resolveDeveloperApiOrigin(request, env) {
  const requested = String(request?.headers?.get('origin') || '').replace(/\/+$/, '');
  const defaults = [resolveCorsOrigin(env)].filter(Boolean);
  const configured = String(env?.DEVELOPER_API_ORIGINS || '').split(',').map(value => value.trim().replace(/\/+$/, '')).filter(Boolean);
  const allowed = new Set([...defaults, ...configured].filter(isSafeOrigin));
  if (requested && allowed.has(requested)) return requested;
  return defaults[0] || '';
}

function isSafeOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch (_) {
    return false;
  }
}
