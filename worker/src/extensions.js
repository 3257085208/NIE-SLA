import { strFromU8, unzipSync } from 'fflate';
import { ApiError, resolveCorsOrigin, safeJson } from './auth.js';
import { getMeta, setMeta } from './admin/settings.js';
import { nowSec, parseBoolean } from './utils.js';

const REGISTRY_KEY = 'extensions:registry:v1';
const ZIP_MAX_BYTES = 8 * 1024 * 1024;
const EXPANDED_MAX_BYTES = 16 * 1024 * 1024;
const FILE_MAX_BYTES = 4 * 1024 * 1024;
const FILE_MAX_COUNT = 300;
const ALLOWED_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2']);

export async function listPublicExtensions(env) {
  const registry = await loadRegistry(env);
  const enabled = registry.filter(item => item.enabled);
  const theme = enabled.find(item => item.type === 'theme') || null;
  return {
    ok: true,
    schema: 'nstatus-extensions-v1',
    active_theme: theme ? publicExtension(theme) : null,
    plugins: enabled.filter(item => item.type === 'plugin').map(publicExtension),
  };
}

export async function listManagedExtensions(env) {
  return { ok: true, schema: 'nstatus-extensions-v1', extensions: await loadRegistry(env) };
}

export async function listManagedExtensionsByType(env, type) {
  const expectedType = cleanExtensionType(type);
  return {
    ok: true,
    schema: 'nstatus-extensions-v1',
    type: expectedType,
    extensions: (await loadRegistry(env)).filter(item => item.type === expectedType),
  };
}

export async function uploadExtension(request, env, expectedType = '') {
  requireExtensionStorage(env);
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > ZIP_MAX_BYTES) throw new ApiError(413, `扩展 ZIP 不能超过 ${ZIP_MAX_BYTES / 1024 / 1024} MB`);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > ZIP_MAX_BYTES) throw new ApiError(413, `扩展 ZIP 不能为空且不能超过 ${ZIP_MAX_BYTES / 1024 / 1024} MB`);

  let expandedBytes = 0;
  let fileCount = 0;
  let files;
  try {
    files = unzipSync(bytes, {
      filter(file) {
        fileCount += 1;
        expandedBytes += Number(file.originalSize || 0);
        if (fileCount > FILE_MAX_COUNT) throw new Error(`文件数不能超过 ${FILE_MAX_COUNT}`);
        if (file.originalSize > FILE_MAX_BYTES) throw new Error(`单个文件不能超过 ${FILE_MAX_BYTES / 1024 / 1024} MB`);
        if (expandedBytes > EXPANDED_MAX_BYTES) throw new Error(`解压后不能超过 ${EXPANDED_MAX_BYTES / 1024 / 1024} MB`);
        return !file.name.endsWith('/');
      },
    });
  } catch (error) {
    throw new ApiError(400, `扩展 ZIP 无效：${String(error?.message || error)}`);
  }

  const entries = Object.entries(files || {});
  if (!entries.length || !files['manifest.json']) throw new ApiError(400, 'ZIP 根目录必须包含 manifest.json');
  for (const [path, data] of entries) validatePackageFile(path, data);

  let manifest;
  try { manifest = JSON.parse(strFromU8(files['manifest.json'])); }
  catch (_) { throw new ApiError(400, 'manifest.json 不是有效 JSON'); }
  const extension = validateManifest(manifest, files);
  extension.package_sha256 = await sha256Bytes(bytes);
  const requiredType = expectedType ? cleanExtensionType(expectedType) : '';
  if (requiredType && extension.type !== requiredType) {
    throw new ApiError(400, requiredType === 'theme' ? '主题上传入口只接受 theme 包' : '插件上传入口只接受 plugin 包');
  }
  const registry = await loadRegistry(env);
  const previous = registry.find(item => item.id === extension.id);
  if (previous && previous.type !== extension.type) {
    throw new ApiError(409, `扩展 ID ${extension.id} 已被${previous.type === 'theme' ? '主题' : '插件'}使用`);
  }
  const revision = crypto.randomUUID().replaceAll('-', '');
  const storageRoot = extensionStorageRoot(extension.type);
  const prefix = `${storageRoot}/${extension.id}/${revision}/`;
  for (let offset = 0; offset < entries.length; offset += 20) {
    await Promise.all(entries.slice(offset, offset + 20).map(([path, data]) => env.ARCHIVE.put(prefix + path, data, {
      httpMetadata: { contentType: contentType(path) },
      customMetadata: { extension_id: extension.id, revision },
    })));
  }

  const record = { ...extension, revision, storage_root: storageRoot, enabled: previous?.enabled || false, uploaded_at: nowSec() };
  const next = [...registry.filter(item => item.id !== record.id), record].sort((a, b) => a.name.localeCompare(b.name));
  await saveRegistry(env, next);
  if (previous?.revision) await deletePrefix(env, extensionPrefix(previous));
  return { ok: true, extension: record };
}

export async function updateExtension(id, request, env, expectedType = '') {
  const cleanId = cleanExtensionId(id);
  const body = await safeJson(request, 16_000);
  const registry = await loadRegistry(env);
  const current = registry.find(item => item.id === cleanId);
  if (!current) throw new ApiError(404, '扩展不存在');
  assertExpectedType(current, expectedType);
  const enabled = parseBoolean(body.enabled, current.enabled);
  const next = registry.map(item => ({
    ...item,
    enabled: item.id === cleanId ? enabled : (enabled && current.type === 'theme' && item.type === 'theme' ? false : item.enabled),
  }));
  await saveRegistry(env, next);
  return { ok: true, extension: next.find(item => item.id === cleanId) };
}

export async function deleteExtension(id, env, expectedType = '') {
  const cleanId = cleanExtensionId(id);
  const registry = await loadRegistry(env);
  const current = registry.find(item => item.id === cleanId);
  if (!current) throw new ApiError(404, '扩展不存在');
  assertExpectedType(current, expectedType);
  await saveRegistry(env, registry.filter(item => item.id !== cleanId));
  await deletePrefix(env, extensionPrefix(current));
  return { ok: true, id: cleanId };
}

export async function getExtensionFile(env, id, path) {
  requireExtensionStorage(env);
  const cleanId = cleanExtensionId(id);
  const cleanPath = cleanPackagePath(path);
  const registry = await loadRegistry(env);
  const extension = registry.find(item => item.id === cleanId && item.enabled);
  if (!extension || !extension.files.includes(cleanPath)) throw new ApiError(404, '扩展文件不存在');
  let object = await env.ARCHIVE.get(`${extensionPrefix(extension)}${cleanPath}`);
  if (!object && extension.storage_root) {
    object = await env.ARCHIVE.get(`extensions/v1/${extension.id}/${extension.revision}/${cleanPath}`);
  }
  if (!object) throw new ApiError(404, '扩展文件不存在');
  const headers = new Headers({
    'content-type': contentType(cleanPath),
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  if (cleanPath.endsWith('.html')) {
    const frameOrigin = resolveCorsOrigin(env);
    headers.set('content-security-policy', `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'${frameOrigin ? ` ${frameOrigin}` : ''}`);
  }
  return new Response(object.body, { headers });
}

function validateManifest(value, files) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'manifest.json 必须是对象');
  if (value.schema !== 'nstatus-extension-v1') throw new ApiError(400, 'manifest schema 必须是 nstatus-extension-v1');
  const id = cleanExtensionId(value.id);
  const name = String(value.name || '').trim().slice(0, 64);
  const version = String(value.version || '').trim();
  const description = String(value.description || '').trim().slice(0, 240);
  const author = String(value.author || '').trim().slice(0, 64);
  const type = String(value.type || '').trim();
  if (!name) throw new ApiError(400, '扩展名称不能为空');
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version)) throw new ApiError(400, '扩展版本必须使用 SemVer');
  if (!['theme', 'plugin'].includes(type)) throw new ApiError(400, '扩展类型只能是 theme 或 plugin');
  const repository = extensionUrl(value.repository);
  const homepage = extensionUrl(value.homepage);
  const license = String(value.license || '').trim().slice(0, 32);
  if (license && !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(license)) throw new ApiError(400, 'license 必须使用 SPDX 风格标识');
  const preview = value.preview ? cleanPackagePath(value.preview) : '';
  if (preview && (!files[preview] || !/\.(?:png|jpe?g|gif|webp|svg)$/i.test(preview))) throw new ApiError(400, 'preview 必须指向包内图片');
  const fileNames = Object.keys(files).sort();
  if (Array.isArray(value.files)) {
    const declared = [...new Set([...value.files.map(cleanPackagePath), 'manifest.json'])].sort();
    if (declared.length !== fileNames.length || declared.some((name, index) => name !== fileNames[index])) throw new ApiError(400, 'files 清单必须与 ZIP 文件完全一致');
  }
  const record = { id, name, version, description, author, type, repository, homepage, license, preview, files: fileNames };
  if (type === 'theme') {
    if (value.mode != null && !['css', 'canvas'].includes(String(value.mode))) throw new ApiError(400, '主题 mode 只能是 css 或 canvas');
    const mode = value.mode === 'canvas' ? 'canvas' : 'css';
    record.mode = mode;
    if (mode === 'canvas') {
      const entry = cleanPackagePath(value.entry || 'index.html');
      if (!entry.endsWith('.html') || !files[entry]) throw new ApiError(400, '交互主题 entry 必须指向 ZIP 内的 HTML 文件');
      const permissions = Array.isArray(value.permissions) ? value.permissions.map(String) : [];
      if (permissions.some(permission => permission !== 'status:read')) throw new ApiError(400, '交互主题只支持 status:read 权限');
      if (!permissions.includes('status:read')) throw new ApiError(400, '交互主题必须声明 status:read 权限');
      record.entry = entry;
      record.permissions = [...new Set(permissions)];
      const requestedHeight = Number(value.height || 900);
      record.height = Number.isFinite(requestedHeight) ? Math.max(400, Math.min(12000, requestedHeight)) : 900;
      record.base_theme = 'classic';
      record.styles = [];
    } else {
      const styles = Array.isArray(value.styles) ? value.styles.map(cleanPackagePath) : [];
      if (!styles.length || styles.length > 4 || styles.some(path => !path.endsWith('.css') || !files[path])) throw new ApiError(400, 'CSS 主题必须声明 1 到 4 个有效 styles');
      record.styles = [...new Set(styles)];
      record.base_theme = value.base_theme === 'cards' ? 'cards' : 'classic';
    }
  } else {
    const entry = cleanPackagePath(value.entry || 'index.html');
    if (!entry.endsWith('.html') || !files[entry]) throw new ApiError(400, '插件 entry 必须指向 ZIP 内的 HTML 文件');
    const permissions = Array.isArray(value.permissions) ? value.permissions.map(String) : [];
    if (permissions.some(permission => permission !== 'status:read')) throw new ApiError(400, 'v1 插件只支持 status:read 权限');
    if (!permissions.includes('status:read')) throw new ApiError(400, 'v1 插件必须声明 status:read 权限');
    record.entry = entry;
    record.permissions = [...new Set(permissions)];
    const requestedHeight = Number(value.height || 360);
    record.height = Number.isFinite(requestedHeight) ? Math.max(200, Math.min(1200, requestedHeight)) : 360;
  }
  return record;
}

function validatePackageFile(path, data) {
  const clean = cleanPackagePath(path);
  if (clean !== path || !data?.length || data.length > FILE_MAX_BYTES) throw new ApiError(400, `扩展文件无效：${path}`);
  const dot = clean.lastIndexOf('.');
  const extension = dot >= 0 ? clean.slice(dot).toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new ApiError(400, `不允许的扩展文件类型：${path}`);
}

function cleanExtensionId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{2,48}$/.test(id)) throw new ApiError(400, '扩展 ID 必须是 3-49 位小写字母、数字或连字符');
  return id;
}

function cleanExtensionType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!['theme', 'plugin'].includes(type)) throw new ApiError(400, '扩展类型只能是 theme 或 plugin');
  return type;
}

function extensionStorageRoot(type) {
  return cleanExtensionType(type) === 'theme' ? 'themes/v1' : 'plugins/v1';
}

function extensionPrefix(extension) {
  const root = String(extension?.storage_root || '').trim() || 'extensions/v1';
  return `${root}/${extension.id}/${extension.revision}/`;
}

function assertExpectedType(extension, expectedType) {
  if (!expectedType) return;
  const requiredType = cleanExtensionType(expectedType);
  if (extension.type !== requiredType) throw new ApiError(404, requiredType === 'theme' ? '主题不存在' : '插件不存在');
}

function cleanPackagePath(value) {
  const path = String(value || '').replaceAll('\\', '/');
  if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..') || path.length > 180) throw new ApiError(400, `扩展路径无效：${path}`);
  return path;
}

function publicExtension(item) {
  return {
    id: item.id,
    name: item.name,
    version: item.version,
    description: item.description,
    author: item.author,
    repository: item.repository || '',
    homepage: item.homepage || '',
    license: item.license || '',
    preview: item.preview || '',
    package_sha256: item.package_sha256 || '',
    type: item.type,
    revision: item.revision,
    ...(item.type === 'theme'
      ? {
          mode: item.mode || 'css',
          styles: item.styles || [],
          base_theme: item.base_theme || 'classic',
          ...(item.mode === 'canvas' ? { entry: item.entry, permissions: item.permissions || [], height: item.height } : {}),
        }
      : { entry: item.entry, permissions: item.permissions, height: item.height }),
  };
}

async function loadRegistry(env) {
  try {
    const value = JSON.parse(await getMeta(env, REGISTRY_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch (_) { return []; }
}

async function saveRegistry(env, registry) {
  await setMeta(env, REGISTRY_KEY, JSON.stringify(registry));
}

async function deletePrefix(env, prefix) {
  while (true) {
    const listed = await env.ARCHIVE.list({ prefix, limit: 1000 });
    const keys = (listed.objects || []).map(item => item.key);
    if (!keys.length) return;
    for (let offset = 0; offset < keys.length; offset += 100) await env.ARCHIVE.delete(keys.slice(offset, offset + 100));
  }
}

function requireExtensionStorage(env) {
  if (!env.DB || !env.ARCHIVE) throw new ApiError(503, '扩展存储未配置');
}

function contentType(path) {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  return ({
    '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
  })[extension] || 'application/octet-stream';
}

function extensionUrl(value) {
  const raw = String(value || '').trim().slice(0, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    return url.toString();
  } catch (_) {
    throw new ApiError(400, '扩展主页与仓库地址必须使用 HTTPS');
  }
}

async function sha256Bytes(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
}
