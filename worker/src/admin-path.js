import { ApiError } from './auth.js';

export const DEFAULT_ADMIN_PATH = '/admin';

const ADMIN_PATH_KEY = 'admin_path';
const RESERVED_SEGMENTS = new Set([
  'api', 'assets', 'bin', 'cdn-cgi', 'functions', 'index', 'tests',
]);

export function normalizeAdminPath(value, { strict = false } = {}) {
  const source = String(value ?? '').trim();
  if (!source) return DEFAULT_ADMIN_PATH;
  const path = `/${source.replace(/^\/+|\/+$/g, '')}`;
  const segment = path.slice(1);
  const valid = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(segment)
    && !RESERVED_SEGMENTS.has(segment.toLowerCase());
  if (valid) return path;
  if (strict) {
    throw new ApiError(400, '后台路径须为 3-64 位字母、数字、连字符或下划线，且不能使用系统保留路径');
  }
  return DEFAULT_ADMIN_PATH;
}

export async function getAdminPath(env) {
  if (env?.DB) {
    try {
      const row = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?')
        .bind(ADMIN_PATH_KEY)
        .first();
      if (row?.value) return normalizeAdminPath(row.value);
    } catch (_) {}
  }
  return normalizeAdminPath(env?.ADMIN_PATH);
}

export async function setAdminPath(env, value) {
  if (!env?.DB) throw new ApiError(500, '修改后台路径需要 D1 数据库');
  const path = normalizeAdminPath(value, { strict: true });
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(ADMIN_PATH_KEY, path, Math.floor(Date.now() / 1000))
    .run();
  return path;
}
