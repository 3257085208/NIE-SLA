import { internalRequestHeaders } from './auth.js';
import { parseBoolean } from './utils.js';

const DEFAULT_FAST_SEC = 60;
const DEFAULT_IDLE_SEC = 300;
const MIN_REPORT_SEC = 10;
const MAX_REPORT_SEC = 3600;
const DEFAULT_VIEWER_CACHE_SEC = 15;
const MIN_VIEWER_CACHE_SEC = 5;
const MAX_VIEWER_CACHE_SEC = 60;
const VIEWER_FETCH_TIMEOUT_MS = 3000;
const STATUS_STREAM_INSTANCE = 'public-status-stream';

let viewerCache = { viewers: 0, expiresAtMs: 0 };
let viewerInflight = null;

export function resetAdaptiveReportCacheForTests() {
  viewerCache = { viewers: 0, expiresAtMs: 0 };
  viewerInflight = null;
}

export function adaptiveReportEnabled(env) {
  return parseBoolean(env?.ADAPTIVE_REPORT_ENABLED ?? true, true);
}

export function clampReportInterval(value, fallback) {
  const seconds = Math.floor(Number(value));
  if (!Number.isFinite(seconds)) return fallback;
  return Math.min(MAX_REPORT_SEC, Math.max(MIN_REPORT_SEC, seconds));
}

export function viewerCacheTtlSec(env) {
  const seconds = Math.floor(Number(env?.ADAPTIVE_VIEWER_CACHE_SEC || DEFAULT_VIEWER_CACHE_SEC));
  if (!Number.isFinite(seconds)) return DEFAULT_VIEWER_CACHE_SEC;
  return Math.min(MAX_VIEWER_CACHE_SEC, Math.max(MIN_VIEWER_CACHE_SEC, seconds));
}

/**
 * Live public-status viewer count with a short-TTL in-isolate cache. A missing
 * binding counts as idle (quota-safe); a failed refresh keeps the last known
 * count for one more TTL instead of flapping between fast and idle.
 */
export async function readViewerCount(env, options = {}) {
  const now = Number(options.now) || Date.now();
  if (!env?.STATUS_STREAM) return 0;
  if (viewerCache.expiresAtMs > now) return viewerCache.viewers;
  if (viewerInflight) return viewerInflight;
  viewerInflight = (async () => {
    const ttlMs = viewerCacheTtlSec(env) * 1000;
    try {
      const id = env.STATUS_STREAM.idFromName(STATUS_STREAM_INSTANCE);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort('viewer count timeout'), VIEWER_FETCH_TIMEOUT_MS);
      let response;
      try {
        response = await env.STATUS_STREAM.get(id).fetch('https://nie-sla.internal/viewers', {
          method: 'GET',
          headers: internalRequestHeaders(env),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const body = response?.ok ? await response.json().catch(() => null) : null;
      const raw = Math.floor(Number(body?.viewers));
      const viewers = Number.isFinite(raw) && raw > 0 ? raw : 0;
      viewerCache = { viewers, expiresAtMs: Date.now() + ttlMs };
      return viewers;
    } catch (error) {
      console.error('viewer count read failed:', String(error?.message || error));
      viewerCache = { viewers: viewerCache.viewers, expiresAtMs: Date.now() + ttlMs };
      return viewerCache.viewers;
    }
  })();
  try {
    return await viewerInflight;
  } finally {
    viewerInflight = null;
  }
}

export async function getAdaptiveReportInterval(env) {
  if (!adaptiveReportEnabled(env)) return null;
  const viewers = await readViewerCount(env);
  const fallback = viewers > 0 ? DEFAULT_FAST_SEC : DEFAULT_IDLE_SEC;
  const configured = viewers > 0 ? env?.ADAPTIVE_FAST_SEC : env?.ADAPTIVE_IDLE_SEC;
  return clampReportInterval(configured ?? fallback, fallback);
}
