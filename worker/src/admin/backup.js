import { ApiError, safeJson } from '../auth.js';

const BACKUP_SCHEMA = 'nie-sla-backup-v1';
const PORTABLE_TABLES = ['targets', 'ping_targets', 'latency_agents'];
const SENSITIVE_TABLES = ['agent_credentials'];
const SENSITIVE_META_KEYS = new Set([
  'admin_credentials_v1',
  'totp_secret',
  'totp_pending_secret',
  'alert_telegram_bot_token',
  'alert_resend_api_key',
]);
const OMIT_META_KEYS = new Set([
  'totp_session_id', 'totp_session_expires', 'totp_sessions',
  'github_oauth_states', 'github_oauth_tickets',
]);

export async function exportBackup(request, env) {
  const body = request.method === 'POST' ? await safeJson(request, 32 * 1024).catch(() => ({})) : {};
  const includeSecrets = body?.include_secrets === true;
  const password = String(body?.password || '');
  if (includeSecrets && password.length < 10) throw new ApiError(400, '敏感备份密码至少需要 10 位');

  const portable = {};
  for (const table of PORTABLE_TABLES) portable[table] = await tableRows(env, table);
  const metaRows = await tableRows(env, 'app_meta');
  portable.app_meta = metaRows.filter(row => isPortableMetaKey(row.key));
  const archive = {
    schema: BACKUP_SCHEMA,
    version: 1,
    created_at: new Date().toISOString(),
    source: 'NIE-SLA',
    portable,
    history: {
      included: false,
      note: 'D1/R2 历史数据未写入便携 JSON；同账号迁移请复用原 D1 与 R2 绑定。',
    },
  };
  if (includeSecrets) {
    const sensitive = {};
    for (const table of SENSITIVE_TABLES) sensitive[table] = await tableRows(env, table);
    sensitive.app_meta = metaRows.filter(row => SENSITIVE_META_KEYS.has(String(row.key || '')));
    archive.sensitive = await encryptJson(sensitive, password);
    archive.sensitive.compatibility = '恢复后必须保留原 TOTP_ENCRYPTION_KEY，或原 ADMIN_PASSWORD/ADMIN_TOKEN 加密材料。';
  }
  return { ok: true, backup: archive };
}

export async function previewBackup(request) {
  const body = await safeJson(request, 2 * 1024 * 1024);
  const archive = normalizeArchive(body?.backup ?? body);
  const sensitive = archive.sensitive ? await decryptJson(archive.sensitive, String(body?.password || '')) : null;
  return {
    ok: true,
    preview: backupPreview(archive, sensitive),
  };
}

export async function restoreBackup(request, env) {
  const body = await safeJson(request, 2 * 1024 * 1024);
  const archive = normalizeArchive(body?.backup);
  const mode = body?.mode === 'replace' ? 'replace' : 'merge';
  if (body?.confirm !== 'RESTORE') throw new ApiError(400, '恢复前必须明确确认 RESTORE');
  const sensitive = archive.sensitive ? await decryptJson(archive.sensitive, String(body?.password || '')) : null;
  const snapshot = await createRestoreSnapshot(env);
  const restored = {};
  try {
    if (mode === 'replace') {
      for (const table of [...PORTABLE_TABLES].reverse()) await env.DB.prepare(`DELETE FROM ${table}`).run();
      const keys = (archive.portable?.app_meta || []).map(row => String(row.key || '')).filter(isPortableMetaKey);
      for (const key of keys) await env.DB.prepare(`DELETE FROM app_meta WHERE key = ?`).bind(key).run();
    }
    for (const table of PORTABLE_TABLES) restored[table] = await restoreRows(env, table, archive.portable?.[table]);
    restored.app_meta = await restoreRows(env, 'app_meta', (archive.portable?.app_meta || []).filter(row => isPortableMetaKey(row.key)));
    if (sensitive) {
      for (const table of SENSITIVE_TABLES) restored[table] = await restoreRows(env, table, sensitive?.[table]);
      restored.sensitive_meta = await restoreRows(env, 'app_meta', (sensitive?.app_meta || []).filter(row => SENSITIVE_META_KEYS.has(String(row.key || ''))));
    }
    await rebuildCompatibilityTables(env);
  } catch (error) {
    throw new ApiError(500, `恢复失败；恢复前快照已保存在 R2：${snapshot.key || '不可用'}。${String(error?.message || error)}`);
  }
  return { ok: true, mode, restored, restore_snapshot: snapshot };
}

async function rebuildCompatibilityTables(env) {
  await env.DB.prepare(`DELETE FROM checks`).run();
  await env.DB.prepare(`DELETE FROM nodes`).run();
  await env.DB.prepare(`INSERT INTO nodes (
    id, legacy_target_id, name, group_name, enabled, sort_order, provider, machine_type, tags,
    ipv4, ipv6, country_code, country, city, location_source, location_updated_at,
    expires_at, price, billing_cycle, currency, traffic_enabled, traffic_quota_gb, traffic_mode,
    traffic_reset_day, alert_enabled, alert_expiry_days, alert_traffic_remaining_percent,
    alert_traffic_remaining_gb, created_at, updated_at
  ) SELECT
    id, id, name, group_name, enabled, sort_order, provider, line_type, tags,
    ipv4, ipv6, CASE WHEN length(location) = 2 THEN upper(location) ELSE '' END,
    location, city, location_source, location_updated_at,
    expires_at, price, billing_cycle, currency, traffic_enabled, traffic_quota_gb, traffic_mode,
    traffic_reset_day, alert_enabled, alert_expiry_days, alert_traffic_remaining_percent,
    alert_traffic_remaining_gb, created_at, updated_at
  FROM targets WHERE type = 'tcp'`).run();
  await env.DB.prepare(`INSERT INTO checks (
    id, legacy_target_id, node_id, name, group_name, type, target_host, target_port, url,
    method, expected_status, timeout_ms, interval_sec, probe_region, enabled, sort_order,
    created_at, updated_at
  ) SELECT
    id, id, CASE WHEN type = 'tcp' THEN id ELSE NULL END, name, group_name, type,
    target_host, target_port, url, method, expected_status, timeout_ms, interval_sec,
    probe_region, enabled, sort_order, created_at, updated_at
  FROM targets WHERE type = 'http' OR COALESCE(no_public_ip, 0) = 0`).run();
}

export async function createRestoreSnapshot(env) {
  if (!env.ARCHIVE) return { stored: false, reason: 'missing_r2' };
  const portable = {};
  for (const table of [...PORTABLE_TABLES, ...SENSITIVE_TABLES]) portable[table] = await tableRows(env, table);
  portable.app_meta = await tableRows(env, 'app_meta');
  const key = `backups/pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await env.ARCHIVE.put(key, JSON.stringify({ schema: 'nie-sla-internal-snapshot-v1', created_at: new Date().toISOString(), data: portable }), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { schema: 'nie-sla-internal-snapshot-v1' },
  });
  return { stored: true, key };
}

function normalizeArchive(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, '备份文件格式无效');
  if (value.schema !== BACKUP_SCHEMA || Number(value.version) !== 1 || !value.portable) throw new ApiError(400, '不支持的备份版本');
  return value;
}

function backupPreview(archive, sensitive) {
  const counts = {};
  for (const table of [...PORTABLE_TABLES, 'app_meta']) counts[table] = Array.isArray(archive.portable?.[table]) ? archive.portable[table].length : 0;
  const sensitiveCounts = {};
  if (sensitive) for (const table of [...SENSITIVE_TABLES, 'app_meta']) sensitiveCounts[table] = Array.isArray(sensitive?.[table]) ? sensitive[table].length : 0;
  return {
    schema: archive.schema,
    created_at: archive.created_at || null,
    counts,
    sensitive: Boolean(archive.sensitive),
    sensitive_counts: sensitiveCounts,
    history_included: false,
  };
}

async function tableRows(env, table) {
  const result = await env.DB.prepare(`SELECT * FROM ${table}`).all().catch(() => ({ results: [] }));
  return result.results || [];
}

async function restoreRows(env, table, rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  let count = 0;
  for (const row of rows.slice(0, 10_000)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const columns = Object.keys(row).filter(column => /^[a-z][a-z0-9_]*$/i.test(column));
    if (!columns.length) continue;
    const quoted = columns.map(column => `"${column}"`).join(', ');
    const marks = columns.map(() => '?').join(', ');
    await env.DB.prepare(`INSERT OR REPLACE INTO ${table} (${quoted}) VALUES (${marks})`).bind(...columns.map(column => row[column])).run();
    count += 1;
  }
  return count;
}

function isPortableMetaKey(keyValue) {
  const key = String(keyValue || '');
  if (!key || OMIT_META_KEYS.has(key) || SENSITIVE_META_KEYS.has(key) || key.startsWith('schema:')) return false;
  if (key.startsWith('app_update_') || key.startsWith('agent_history_lock:') || key.startsWith('scheduled:')) return false;
  return true;
}

async function encryptJson(value, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(password, salt, ['encrypt']);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    algorithm: 'PBKDF2-SHA256+A256GCM',
    iterations: 310000,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptJson(envelope, password) {
  if (!password) throw new ApiError(400, '该备份包含敏感数据，请输入备份密码');
  if (envelope?.algorithm !== 'PBKDF2-SHA256+A256GCM') throw new ApiError(400, '不支持的敏感备份加密格式');
  try {
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const ciphertext = base64ToBytes(envelope.ciphertext);
    const key = await deriveBackupKey(password, salt, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (_) {
    throw new ApiError(400, '备份密码错误或敏感数据已损坏');
  }
}

async function deriveBackupKey(password, salt, usages) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 310000 }, material, { name: 'AES-GCM', length: 256 }, false, usages);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
