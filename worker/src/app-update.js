import { ApiError } from './auth.js';
import { VERSION } from './version.js';

const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/3257085208/NIE-SLA/main/update-manifest.json';
const UPDATE_WORKFLOW = 'nie-sla-update.yml';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 15 * 60 * 1000;
const MAX_MANIFEST_BYTES = 64 * 1024;
let manifestCache = null;
let manifestRequest = null;

export function compareAppVersions(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function parseAppUpdateManifest(raw) {
  const manifest = raw && typeof raw === 'object' ? raw : {};
  if (manifest.schema !== 'nie-sla-app-update-v1') throw new Error('unsupported update manifest schema');
  const version = normalizeVersion(manifest.version);
  const sourceRef = String(manifest.source_ref || '').trim();
  if (!/^app-v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(sourceRef) || sourceRef !== `app-v${version}`) throw new Error('invalid update source ref');
  const publishedAt = String(manifest.published_at || '').trim();
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error('invalid update publish time');
  const releaseUrl = safeHttpsUrl(manifest.release_url);
  const title = boundedText(manifest.title, 120) || `NIE-SLA ${version}`;
  const changelog = Array.isArray(manifest.changelog)
    ? manifest.changelog.slice(0, 30).map((item) => boundedText(item, 300)).filter(Boolean)
    : [];
  return { schema: manifest.schema, version, source_ref: sourceRef, published_at: publishedAt, release_url: releaseUrl, title, changelog };
}

export async function getAppUpdateInfo(env, { force = false, fetchImpl = fetch } = {}) {
  const manifestUrl = updateManifestUrl(env);
  const resolved = await resolveManifest(env, manifestUrl, { force, fetchImpl });
  const manifest = resolved.value;
  return {
    ok: true,
    current_version: VERSION,
    latest_version: manifest.version,
    update_available: compareAppVersions(manifest.version, VERSION) > 0,
    stale: resolved.stale,
    update_source: resolved.source,
    update_mode: 'github-actions',
    automatic_check_hours: 6,
    workflow_file: UPDATE_WORKFLOW,
    ...manifest,
  };
}

async function resolveManifest(env, url, { force, fetchImpl }) {
  const now = Date.now();
  const cached = manifestCache?.url === url ? manifestCache : null;
  if (!force && cached?.expiresAt > now) {
    return { value: cached.value, stale: false, source: 'official' };
  }
  if (cached?.retryAt > now) {
    return { value: cached.value, stale: true, source: cached.source === 'bundled' ? 'bundled' : 'cache' };
  }
  if (manifestRequest?.url === url) return manifestRequest.promise;

  const promise = refreshManifest(env, url, fetchImpl, cached);
  manifestRequest = { url, promise };
  try {
    return await promise;
  } finally {
    if (manifestRequest?.promise === promise) manifestRequest = null;
  }
}

async function refreshManifest(env, url, fetchImpl, cached) {
  try {
    const value = await fetchManifest(url, fetchImpl);
    manifestCache = {
      url,
      value,
      source: 'official',
      expiresAt: Date.now() + CACHE_TTL_MS,
      retryAt: 0,
    };
    return { value, stale: false, source: 'official' };
  } catch (error) {
    console.warn('official app update manifest unavailable:', safeManifestError(error));
    const fallback = cached?.value || await fetchBundledManifest(env);
    if (!fallback) throw new ApiError(502, '官方版本服务暂时不可用，且本地版本信息缺失');
    const source = cached?.value ? cached.source : 'bundled';
    manifestCache = {
      url,
      value: fallback,
      source,
      expiresAt: 0,
      retryAt: Date.now() + FAILURE_BACKOFF_MS,
    };
    return { value: fallback, stale: true, source: source === 'bundled' ? 'bundled' : 'cache' };
  }
}

async function fetchManifest(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('update-manifest-timeout'), 8000);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': `NIE-SLA/${VERSION}` },
      redirect: 'error',
      signal: controller.signal,
      cf: { cacheEverything: true, cacheTtl: CACHE_TTL_MS / 1000 },
    });
    return readManifestResponse(response);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBundledManifest(env) {
  if (typeof env?.ASSETS?.fetch !== 'function') return null;
  try {
    const response = await env.ASSETS.fetch(new Request('https://nie-sla.internal/update-manifest.json'));
    return await readManifestResponse(response);
  } catch (error) {
    console.warn('bundled app update manifest unavailable:', safeManifestError(error));
    return null;
  }
}

async function readManifestResponse(response) {
  if (!response?.ok) throw new Error(`HTTP ${response?.status || 0}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_MANIFEST_BYTES) throw new Error('版本清单过大');
  const text = await response.text();
  if (!text || new TextEncoder().encode(text).byteLength > MAX_MANIFEST_BYTES) throw new Error('版本清单为空或过大');
  return parseAppUpdateManifest(JSON.parse(text));
}

export function resetAppUpdateCacheForTests() {
  manifestCache = null;
  manifestRequest = null;
}

function updateManifestUrl(env) {
  const value = String(env.APP_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_URL).trim();
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new ApiError(500, 'APP_UPDATE_MANIFEST_URL 必须使用 HTTPS');
  if (url.username || url.password) throw new ApiError(500, 'APP_UPDATE_MANIFEST_URL 禁止内嵌凭据');
  return url.toString();
}

function normalizeVersion(value) {
  const version = String(value || '').trim().replace(/^v/i, '');
  parseSemver(version);
  return version;
}

function parseSemver(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/);
  if (!match) throw new Error(`invalid semantic version: ${value}`);
  const core = match.slice(1, 4).map(Number);
  if (core.some((part) => !Number.isSafeInteger(part))) throw new Error(`invalid semantic version: ${value}`);
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some((part) => /^\d+$/.test(part) && String(Number(part)) !== part)) {
    throw new Error(`invalid semantic version: ${value}`);
  }
  return { core, prerelease };
}

function comparePrerelease(left, right) {
  if (!left.length || !right.length) return left.length === right.length ? 0 : (left.length ? -1 : 1);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined || right[index] === undefined) return left[index] === undefined ? -1 : 1;
    if (left[index] === right[index]) continue;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) return Number(left[index]) > Number(right[index]) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

function safeHttpsUrl(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  try {
    const url = new URL(source);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch (_) {
    return '';
  }
}

function boundedText(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

function safeManifestError(error) {
  const message = String(error?.message || '');
  const status = message.match(/^HTTP (\d{3})$/)?.[1];
  if (status) return `HTTP ${status}`;
  if (error?.name === 'AbortError' || /timeout|aborted?/i.test(message)) return 'timeout';
  if (error instanceof SyntaxError || /manifest|清单|semantic version|source ref|publish time/i.test(message)) return 'invalid response';
  return 'request failed';
}
