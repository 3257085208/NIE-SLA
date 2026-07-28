import { unzipSync } from 'fflate';
import { ApiError, resolveCorsOrigin, safeJson } from './auth.js';
import { getMeta, setMeta } from './admin/settings.js';
import { nowSec, parseBoolean } from './utils.js';

const REGISTRY_KEY = 'themes:registry:v1';
const LEGACY_REGISTRY_KEY = 'extensions:registry:v1';
const ZIP_MAX_BYTES = 8 * 1024 * 1024;
const EXPANDED_MAX_BYTES = 16 * 1024 * 1024;
const FILE_MAX_BYTES = 4 * 1024 * 1024;
const FILE_MAX_COUNT = 300;
const MANIFEST_MAX_BYTES = 64 * 1024;
const PATH_MAX_DEPTH = 8;
const ZIP_CONTENT_TYPES = new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream']);
const RESERVED_THEME_IDS = new Set(['admin', 'api', 'classic', 'extensions', 'plugins', 'themes']);
const ALLOWED_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2']);

export async function getPublicTheme(env) {
  let themes = [];
  if (env?.DB) {
    try { themes = await loadRegistry(env); }
    catch (error) {
      if (!/no such table:\s*app_meta/i.test(String(error?.message || error))) throw error;
    }
  }
  const activeTheme = themes.find(theme => theme.enabled) || null;
  return {
    ok: true,
    schema: 'nie-sla-themes-v1',
    active_theme: activeTheme ? publicTheme(activeTheme) : null,
  };
}

export async function listManagedThemes(env) {
  return {
    ok: true,
    schema: 'nie-sla-themes-v1',
    themes: await loadRegistry(env),
  };
}

export async function uploadTheme(request, env) {
  requireThemeStorage(env);
  const uploadType = String(request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!ZIP_CONTENT_TYPES.has(uploadType)) throw new ApiError(415, '主题上传必须使用 ZIP Content-Type');
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > ZIP_MAX_BYTES) throw new ApiError(413, '主题 ZIP 不能超过 8 MB');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > ZIP_MAX_BYTES) throw new ApiError(413, '主题 ZIP 不能为空且不能超过 8 MB');
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new ApiError(400, '上传文件不是有效的非空 ZIP 包');
  }
  const expectedSha256 = String(request.headers.get('x-theme-sha256') || request.headers.get('x-extension-sha256') || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new ApiError(400, '缺少有效的主题 ZIP SHA-256');
  const packageSha256 = await sha256Bytes(bytes);
  if (packageSha256 !== expectedSha256) throw new ApiError(400, '主题 ZIP SHA-256 校验失败');

  let expandedBytes = 0;
  let fileCount = 0;
  const archiveNames = new Set();
  let files;
  try {
    files = unzipSync(bytes, {
      filter(file) {
        const archivePath = String(file.name || '');
        if (archiveNames.has(archivePath)) throw new Error(`ZIP 包含重复路径：${archivePath}`);
        archiveNames.add(archivePath);
        fileCount += 1;
        expandedBytes += Number(file.originalSize || 0);
        if (fileCount > FILE_MAX_COUNT) throw new Error(`文件数不能超过 ${FILE_MAX_COUNT}`);
        if (file.originalSize > FILE_MAX_BYTES) throw new Error('单个文件不能超过 4 MB');
        if (expandedBytes > EXPANDED_MAX_BYTES) throw new Error('解压后不能超过 16 MB');
        validatePackagePath(archivePath.endsWith('/') ? archivePath.slice(0, -1) : archivePath);
        return !archivePath.endsWith('/');
      },
    });
  } catch (error) {
    throw new ApiError(400, `主题 ZIP 无效：${String(error?.message || error)}`);
  }

  const entries = Object.entries(files || {});
  if (!entries.length || !files['manifest.json']) throw new ApiError(400, 'ZIP 根目录必须包含 manifest.json');
  let actualExpandedBytes = 0;
  for (const [path, data] of entries) {
    validatePackageFile(path, data);
    actualExpandedBytes += data.length;
    if (actualExpandedBytes > EXPANDED_MAX_BYTES) throw new ApiError(400, '主题解压后不能超过 16 MB');
  }
  if (files['manifest.json'].length > MANIFEST_MAX_BYTES) throw new ApiError(400, 'manifest.json 不能超过 64 KiB');

  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files['manifest.json']));
  } catch (_) {
    throw new ApiError(400, 'manifest.json 必须是有效 UTF-8 JSON');
  }
  const theme = validateManifest(manifest, files);
  theme.package_sha256 = packageSha256;
  const registry = await loadRegistry(env);
  const previous = registry.find(item => item.id === theme.id);
  const revision = crypto.randomUUID().replaceAll('-', '');
  const prefix = `themes/v1/${theme.id}/${revision}/`;
  const record = {
    ...theme,
    revision,
    storage_root: 'themes/v1',
    enabled: false,
    uploaded_at: nowSec(),
  };
  const next = [...registry.filter(item => item.id !== record.id), record]
    .sort((a, b) => a.name.localeCompare(b.name));

  try {
    for (let offset = 0; offset < entries.length; offset += 20) {
      const writes = await Promise.allSettled(entries.slice(offset, offset + 20).map(([path, data]) => env.ARCHIVE.put(prefix + path, data, {
        httpMetadata: { contentType: contentType(path) },
        customMetadata: { theme_id: theme.id, revision },
      })));
      const failure = writes.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
    await saveRegistry(env, next);
  } catch (error) {
    const registryState = await registryContainsRevision(env, record.id, revision).catch(() => null);
    if (registryState !== true) {
      if (registryState === false) await deletePrefix(env, prefix).catch(() => {});
      throw error;
    }
  }
  if (previous?.revision) {
    await deletePrefix(env, themePrefix(previous)).catch(error => console.warn('failed to remove old theme revision', error));
  }
  return { ok: true, theme: record };
}

export async function updateTheme(id, request, env) {
  const cleanId = cleanThemeId(id);
  const body = await safeJson(request, 16_000);
  const registry = await loadRegistry(env);
  const current = registry.find(item => item.id === cleanId);
  if (!current) throw new ApiError(404, '主题不存在');
  const enabled = parseBoolean(body.enabled, current.enabled);
  const next = registry.map(item => ({
    ...item,
    enabled: item.id === cleanId ? enabled : (enabled ? false : item.enabled),
  }));
  await saveRegistry(env, next);
  return { ok: true, theme: next.find(item => item.id === cleanId) };
}

export async function deleteTheme(id, env) {
  const cleanId = cleanThemeId(id);
  const registry = await loadRegistry(env);
  const current = registry.find(item => item.id === cleanId);
  if (!current) throw new ApiError(404, '主题不存在');
  await saveRegistry(env, registry.filter(item => item.id !== cleanId));
  await deletePrefix(env, themePrefix(current));
  return { ok: true, id: cleanId };
}

export async function getThemeFile(env, id, path, revision = '') {
  requireThemeStorage(env);
  const cleanId = cleanThemeId(id);
  const cleanPath = cleanPackagePath(path);
  const registry = await loadRegistry(env);
  const theme = registry.find(item => item.id === cleanId && item.enabled);
  if (revision && theme?.revision !== revision) throw new ApiError(404, '主题版本不存在或已停用');
  if (!theme || !theme.files.includes(cleanPath)) throw new ApiError(404, '主题文件不存在');
  let object = await env.ARCHIVE.get(`${themePrefix(theme)}${cleanPath}`);
  if (!object && theme.storage_root === 'themes/v1') {
    object = await env.ARCHIVE.get(`extensions/v1/${theme.id}/${theme.revision}/${cleanPath}`);
  }
  if (!object) throw new ApiError(404, '主题文件不存在');
  const headers = new Headers({
    'content-type': contentType(cleanPath),
    'cache-control': revision ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'cross-origin',
  });
  if (cleanPath.endsWith('.html')) {
    const frameOrigin = resolveCorsOrigin(env);
    headers.set('content-security-policy', `sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; child-src 'none'; worker-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'${frameOrigin ? ` ${frameOrigin}` : ''}`);
    headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=()');
  } else if (cleanPath.endsWith('.svg')) {
    headers.set('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  }
  return new Response(object.body, { headers });
}

function validateManifest(value, files) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'manifest.json 必须是对象');
  if (!['nie-sla-theme-v1', 'nstatus-extension-v1'].includes(value.schema)) {
    throw new ApiError(400, 'manifest schema 必须是 nie-sla-theme-v1');
  }
  const id = cleanThemeId(value.id);
  const name = String(value.name || '').trim().slice(0, 64);
  const version = String(value.version || '').trim();
  const description = String(value.description || '').trim().slice(0, 240);
  const author = String(value.author || '').trim().slice(0, 64);
  if (String(value.type || 'theme').trim() !== 'theme') throw new ApiError(400, '上传包类型必须是 theme');
  if (!name) throw new ApiError(400, '主题名称不能为空');
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version)) throw new ApiError(400, '主题版本必须使用 SemVer');
  const repository = themeUrl(value.repository);
  const homepage = themeUrl(value.homepage);
  const license = String(value.license || '').trim().slice(0, 32);
  if (license && !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(license)) throw new ApiError(400, 'license 必须使用 SPDX 风格标识');
  const preview = value.preview ? cleanPackagePath(value.preview) : '';
  if (preview && (!files[preview] || !/\.(?:png|jpe?g|gif|webp|svg)$/i.test(preview))) {
    throw new ApiError(400, 'preview 必须指向包内图片');
  }
  const fileNames = Object.keys(files).sort();
  if (Array.isArray(value.files)) {
    const declared = [...new Set([...value.files.map(cleanPackagePath), 'manifest.json'])].sort();
    if (declared.length !== fileNames.length || declared.some((name, index) => name !== fileNames[index])) {
      throw new ApiError(400, 'files 清单必须与 ZIP 文件完全一致');
    }
  }
  const mode = value.mode === 'canvas' ? 'canvas' : 'css';
  const record = {
    id,
    name,
    version,
    description,
    author,
    type: 'theme',
    mode,
    repository,
    homepage,
    license,
    preview,
    files: fileNames,
  };
  if (mode === 'canvas') {
    const entry = cleanPackagePath(value.entry || 'index.html');
    if (!entry.endsWith('.html') || !files[entry]) throw new ApiError(400, '交互主题 entry 必须指向 ZIP 内的 HTML 文件');
    const permissions = Array.isArray(value.permissions) ? value.permissions.map(String) : [];
    if (permissions.some(permission => permission !== 'status:read') || !permissions.includes('status:read')) {
      throw new ApiError(400, '交互主题必须且只能声明 status:read 权限');
    }
    const requestedHeight = Number(value.height || 900);
    record.entry = entry;
    record.permissions = ['status:read'];
    record.height = Number.isFinite(requestedHeight) ? Math.max(400, Math.min(12000, requestedHeight)) : 900;
    record.styles = [];
  } else {
    const styles = Array.isArray(value.styles) ? value.styles.map(cleanPackagePath) : [];
    if (!styles.length || styles.length > 4 || styles.some(path => !path.endsWith('.css') || !files[path])) {
      throw new ApiError(400, 'CSS 主题必须声明 1 到 4 个有效 styles');
    }
    record.styles = [...new Set(styles)];
  }
  return record;
}

function validatePackageFile(path, data) {
  const clean = cleanPackagePath(path);
  if (clean !== path || !data?.length || data.length > FILE_MAX_BYTES) throw new ApiError(400, `主题文件无效：${path}`);
  const dot = clean.lastIndexOf('.');
  const extension = dot >= 0 ? clean.slice(dot).toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new ApiError(400, `不允许的主题文件类型：${path}`);
}

function cleanThemeId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{2,48}$/.test(id)) throw new ApiError(400, '主题 ID 必须是 3-49 位小写字母、数字或连字符');
  if (RESERVED_THEME_IDS.has(id)) throw new ApiError(400, `主题 ID ${id} 为系统保留名称`);
  return id;
}

function cleanPackagePath(value) {
  return validatePackagePath(value);
}

function validatePackagePath(value) {
  const path = String(value || '');
  const parts = path.split('/');
  if (!path || path !== path.normalize('NFC') || path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f-\u009f]/u.test(path)
    || parts.length > PATH_MAX_DEPTH || parts.some(part => !part || part === '.' || part === '..' || /[ .]$/u.test(part)) || path.length > 180) {
    throw new ApiError(400, `主题路径无效：${path}`);
  }
  return path;
}

function publicTheme(theme) {
  return {
    id: theme.id,
    name: theme.name,
    version: theme.version,
    description: theme.description,
    author: theme.author,
    repository: theme.repository || '',
    homepage: theme.homepage || '',
    license: theme.license || '',
    preview: theme.preview || '',
    package_sha256: theme.package_sha256 || '',
    type: 'theme',
    mode: theme.mode || 'css',
    styles: theme.styles || [],
    revision: theme.revision,
    ...(theme.mode === 'canvas' ? {
      entry: theme.entry,
      permissions: theme.permissions || [],
      height: theme.height,
    } : {}),
  };
}

async function loadRegistry(env) {
  const raw = await getMeta(env, REGISTRY_KEY);
  if (raw) return parseRegistry(raw);
  const legacyRaw = await getMeta(env, LEGACY_REGISTRY_KEY);
  if (!legacyRaw) return [];
  const legacyThemes = parseRegistry(legacyRaw).filter(item => item?.type === 'theme');
  if (legacyThemes.length) await saveRegistry(env, legacyThemes);
  return legacyThemes;
}

function parseRegistry(raw) {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error();
    return value.filter(item => item && item.type === 'theme');
  } catch (_) {
    throw new ApiError(500, '主题注册表损坏，已拒绝自动覆盖');
  }
}

async function saveRegistry(env, registry) {
  await setMeta(env, REGISTRY_KEY, JSON.stringify(registry));
}

async function registryContainsRevision(env, id, revision) {
  return parseRegistry(await getMeta(env, REGISTRY_KEY) || '[]')
    .some(item => item.id === id && item.revision === revision);
}

async function deletePrefix(env, prefix) {
  while (true) {
    const listed = await env.ARCHIVE.list({ prefix, limit: 1000 });
    const keys = (listed.objects || []).map(item => item.key);
    if (!keys.length) return;
    for (let offset = 0; offset < keys.length; offset += 100) await env.ARCHIVE.delete(keys.slice(offset, offset + 100));
  }
}

function themePrefix(theme) {
  const root = String(theme?.storage_root || '').trim() || 'extensions/v1';
  return `${root}/${theme.id}/${theme.revision}/`;
}

function requireThemeStorage(env) {
  if (!env.DB || !env.ARCHIVE) throw new ApiError(503, '主题存储未配置，需要 D1 与 R2');
}

function contentType(path) {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  return ({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  })[extension] || 'application/octet-stream';
}

function themeUrl(value) {
  const raw = String(value || '').trim().slice(0, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    return url.toString();
  } catch (_) {
    throw new ApiError(400, '主题主页与仓库地址必须使用 HTTPS');
  }
}

async function sha256Bytes(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
}
