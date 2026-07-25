import { ApiError, safeJson } from './auth.js';
import { getMeta, setMeta } from './admin/settings.js';
import { VERSION } from './version.js';

const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/3257085208/NIE-SLA/main/update-manifest.json';
const UPDATE_WORKFLOW = 'nie-sla-update.yml';
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_MANIFEST_BYTES = 64 * 1024;
let manifestCache = null;

export function compareAppVersions(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function normalizeUpdateRepository(value) {
  const repository = String(value || '').trim();
  return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) ? repository : '';
}

export function parseAppUpdateManifest(raw) {
  const manifest = raw && typeof raw === 'object' ? raw : {};
  if (manifest.schema !== 'nie-sla-app-update-v1') throw new Error('unsupported update manifest schema');
  const version = normalizeVersion(manifest.version);
  const sourceRef = String(manifest.source_ref || '').trim();
  if (!/^app-v\d+\.\d+\.\d+$/.test(sourceRef) || sourceRef !== `app-v${version}`) throw new Error('invalid update source ref');
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
  let manifest = !force && manifestCache?.url === manifestUrl && manifestCache.expiresAt > Date.now()
    ? manifestCache.value
    : null;
  let stale = false;
  if (!manifest) {
    try {
      manifest = await fetchManifest(manifestUrl, fetchImpl);
      manifestCache = { url: manifestUrl, value: manifest, expiresAt: Date.now() + CACHE_TTL_MS };
    } catch (error) {
      if (manifestCache?.url === manifestUrl) {
        manifest = manifestCache.value;
        stale = true;
      } else {
        throw new ApiError(502, `无法读取官方版本信息：${String(error?.message || error)}`);
      }
    }
  }
  const repository = normalizeUpdateRepository(await getMeta(env, 'app_update_repository').catch(() => ''));
  return {
    ok: true,
    current_version: VERSION,
    latest_version: manifest.version,
    update_available: compareAppVersions(manifest.version, VERSION) > 0,
    stale,
    repository,
    token_stored: false,
    workflow_file: UPDATE_WORKFLOW,
    ...manifest,
  };
}

export async function dispatchAppUpdate(request, env, { fetchImpl = fetch } = {}) {
  const body = await safeJson(request, 16 * 1024);
  const repository = normalizeUpdateRepository(body.repository);
  const token = String(body.github_token || '').trim();
  if (!repository) throw new ApiError(400, 'GitHub 仓库格式应为 owner/repo');
  if (token.length < 20 || token.length > 512 || /\s/.test(token)) throw new ApiError(400, '请输入有效的 GitHub 细粒度 Token');

  const update = await getAppUpdateInfo(env, { force: true, fetchImpl });
  if (!update.update_available) throw new ApiError(409, '当前已经是最新版本');

  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': `NIE-SLA/${VERSION}`,
    'x-github-api-version': '2022-11-28',
  };
  const repositoryResponse = await fetchImpl(`https://api.github.com/repos/${repository}`, { headers });
  if (!repositoryResponse.ok) throw githubApiError(repositoryResponse.status, '无法读取部署仓库，请检查仓库名和 Token 权限');
  const repositoryInfo = await repositoryResponse.json();
  const defaultBranch = String(repositoryInfo?.default_branch || 'main').trim();
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(defaultBranch)) throw new ApiError(502, '部署仓库默认分支无效');

  const dispatchResponse = await fetchImpl(`https://api.github.com/repos/${repository}/actions/workflows/${UPDATE_WORKFLOW}/dispatches`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ref: defaultBranch,
      inputs: { source_ref: update.source_ref, expected_version: update.latest_version },
    }),
  });
  if (dispatchResponse.status !== 204) throw githubApiError(dispatchResponse.status, '无法触发在线更新，请确认工作流存在且 Token 具有 Actions 写权限');
  await setMeta(env, 'app_update_repository', repository).catch(() => {});
  return {
    ok: true,
    accepted: true,
    repository,
    source_ref: update.source_ref,
    target_version: update.latest_version,
    actions_url: `https://github.com/${repository}/actions/workflows/${UPDATE_WORKFLOW}`,
  };
}

async function fetchManifest(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('update-manifest-timeout'), 8000);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': `NIE-SLA/${VERSION}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_MANIFEST_BYTES) throw new Error('版本清单过大');
    const text = await response.text();
    if (!text || new TextEncoder().encode(text).byteLength > MAX_MANIFEST_BYTES) throw new Error('版本清单为空或过大');
    return parseAppUpdateManifest(JSON.parse(text));
  } finally {
    clearTimeout(timer);
  }
}

function updateManifestUrl(env) {
  const value = String(env.APP_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_URL).trim();
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new ApiError(500, 'APP_UPDATE_MANIFEST_URL 必须使用 HTTPS');
  return url.toString();
}

function normalizeVersion(value) {
  const version = String(value || '').trim().replace(/^v/i, '');
  parseSemver(version);
  return version;
}

function parseSemver(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`invalid semantic version: ${value}`);
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error(`invalid semantic version: ${value}`);
  return parts;
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

function githubApiError(status, fallback) {
  if (status === 401 || status === 403) return new ApiError(502, `${fallback}（GitHub 返回 ${status}）`);
  if (status === 404) return new ApiError(502, `${fallback}（仓库或工作流不存在）`);
  return new ApiError(502, `${fallback}（GitHub 返回 ${status}）`);
}
