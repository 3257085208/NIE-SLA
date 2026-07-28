import { sanitizeAgentId, sha256Hex } from './utils.js';

const CIPHERTEXT_PREFIX = 'enc:v1:';
const TOKEN_PREFIX = 'nst_';
const TOKEN_BYTES = 32;
const SUBJECT_TYPES = new Set(['agent', 'latency']);

export async function getOrCreateAgentToken(env, subjectType, subjectId) {
  const subject = normalizeSubject(subjectType, subjectId);
  if (!env.DB) throw new Error('生成节点 Token 需要 D1 数据库');

  const existing = await readCredential(env, subject.type, subject.id);
  if (existing?.token_hash && existing?.token_ciphertext) return decryptCredential(existing, env, subject);

  const legacy = await legacyScopedToken(env, subject.type, subject.id);
  if (legacy) return legacy;

  const token = randomToken();
  const now = nowSec();
  const ciphertext = await encryptToken(token, env, subject);
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(`INSERT OR IGNORE INTO agent_credentials
    (subject_type, subject_id, token_hash, token_ciphertext, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(subject.type, subject.id, tokenHash, ciphertext, now, now)
    .run();

  const stored = await readCredential(env, subject.type, subject.id);
  if (!stored) throw new Error('保存节点 Token 失败');
  return decryptCredential(stored, env, subject);
}

export async function verifyAgentCredential(env, subjectType, subjectId, token) {
  const subject = normalizeSubject(subjectType, subjectId);
  const presented = String(token || '').trim();
  if (!presented || !env.DB) return false;
  const hash = await sha256Hex(presented);
  const row = await env.DB.prepare(`SELECT token_hash FROM agent_credentials
    WHERE subject_type = ? AND subject_id = ?`)
    .bind(subject.type, subject.id)
    .first()
    .catch(() => null);
  if (!row?.token_hash || !constantTimeEqual(hash, row.token_hash)) return false;
  await touchCredential(env, subject.type, subject.id);
  return true;
}

export async function findAgentCredential(env, token) {
  const presented = String(token || '').trim();
  if (!presented || !env.DB) return null;
  const hash = await sha256Hex(presented);
  const row = await env.DB.prepare(`SELECT subject_id, token_hash FROM agent_credentials
    WHERE subject_type = 'agent' AND token_hash = ? LIMIT 1`)
    .bind(hash)
    .first()
    .catch(() => null);
  if (!row?.subject_id || !constantTimeEqual(hash, row.token_hash)) return null;
  await touchCredential(env, 'agent', row.subject_id);
  return { agent_id: String(row.subject_id) };
}

export async function legacyScopedToken(env, subjectType, subjectId) {
  const configured = String(env.AGENT_TOKEN || '').trim();
  if (!configured) return '';
  const subject = normalizeSubject(subjectType, subjectId);
  const scopedId = subject.type === 'latency' ? `latency:${subject.id}` : subject.id;
  return `${TOKEN_PREFIX}${(await sha256Hex(`${configured}:${scopedId}`)).slice(0, 48)}`;
}

async function readCredential(env, subjectType, subjectId) {
  return env.DB.prepare(`SELECT token_hash, token_ciphertext FROM agent_credentials
    WHERE subject_type = ? AND subject_id = ?`)
    .bind(subjectType, subjectId)
    .first()
    .catch(() => null);
}

async function decryptCredential(row, env, subject) {
  try {
    const token = await decryptToken(row.token_ciphertext, env, subject);
    const hash = await sha256Hex(token);
    if (!constantTimeEqual(hash, row.token_hash)) throw new Error('节点 Token 完整性校验失败');
    return token;
  } catch (err) {
    throw new Error(`无法读取现有节点 Token，请检查节点凭据加密密钥或管理员密码；为避免在线节点失效，系统未自动轮换 Token。${err?.message ? ` ${err.message}` : ''}`);
  }
}

async function encryptToken(token, env, subject) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: subjectBytes(subject) },
    await encryptionKey(encryptionMaterial(env), ['encrypt']),
    new TextEncoder().encode(token),
  ));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv, 0);
  combined.set(encrypted, iv.length);
  return CIPHERTEXT_PREFIX + bytesToBase64(combined);
}

async function decryptToken(value, env, subject) {
  const stored = String(value || '');
  if (!stored.startsWith(CIPHERTEXT_PREFIX)) throw new Error('节点 Token 密文格式无效');
  const combined = base64ToBytes(stored.slice(CIPHERTEXT_PREFIX.length));
  if (combined.length <= 12) throw new Error('节点 Token 密文无效');
  let lastError = null;
  for (const material of encryptionMaterials(env)) {
    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: combined.slice(0, 12), additionalData: subjectBytes(subject) },
        await encryptionKey(material, ['decrypt']),
        combined.slice(12),
      );
      return new TextDecoder().decode(decrypted);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('没有可用的节点凭据加密材料');
}

function encryptionMaterial(env) {
  const material = encryptionMaterials(env)[0];
  if (!material) throw new Error('需要配置 ADMIN_PASSWORD 或 TOTP_ENCRYPTION_KEY');
  return material;
}

function encryptionMaterials(env) {
  return [...new Set([
    String(env.TOTP_ENCRYPTION_KEY || '').trim(),
    String(env.ADMIN_PASSWORD || '').trim(),
    String(env.ADMIN_TOKEN || '').trim(),
  ].filter(Boolean))];
}

async function encryptionKey(material, usages) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, usages);
}

function normalizeSubject(subjectType, subjectId) {
  const type = String(subjectType || '').trim().toLowerCase();
  const id = sanitizeAgentId(subjectId);
  if (!SUBJECT_TYPES.has(type) || !id) throw new Error('节点凭据标识无效');
  return { type, id };
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return TOKEN_PREFIX + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function subjectBytes(subject) {
  return new TextEncoder().encode(`nie-sla:${subject.type}:${subject.id}`);
}

async function touchCredential(env, subjectType, subjectId) {
  const now = nowSec();
  const interval = Math.max(3600, Math.min(86400, Number(env.AGENT_CREDENTIAL_TOUCH_SEC || 21600)));
  await env.DB.prepare(`UPDATE agent_credentials SET last_used_at = ?
    WHERE subject_type = ? AND subject_id = ?
      AND (last_used_at IS NULL OR last_used_at <= ?)`)
    .bind(now, subjectType, subjectId, now - interval)
    .run()
    .catch(() => {});
}

function constantTimeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return diff === 0;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}
