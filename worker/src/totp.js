import { json, safeJson, constantTimeEqual } from './auth.js';
import { sha256Hex } from './utils.js';

const ACTIVE_SECRET_KEY = 'totp_secret';
const PENDING_SECRET_KEY = 'totp_pending_secret';
const SESSION_ID_KEY = 'totp_session_id';
const SESSION_EXPIRES_KEY = 'totp_session_expires';
const SESSIONS_KEY = 'totp_sessions';
const ENCRYPTED_SECRET_PREFIX = 'enc:v1:';
const HASHED_SESSION_PREFIX = 'sha256:';
const MAX_ADMIN_SESSIONS = 5;

export async function setupTOTP(env) {
  if (!env.DB) return json({ ok: false, error: '需要 D1 数据库' }, 500, env);

  const activeSecret = await getMeta(env, ACTIVE_SECRET_KEY);
  if (activeSecret) {
    return json({ ok: false, error: 'TOTP 已配置，请先关闭现有配置。' }, 400, env);
  }

  const secret = generateSecret();
  await setMeta(env, PENDING_SECRET_KEY, await encryptSecret(secret, env));
  return json({ ok: true, secret, uri: totpUri(secret, env) }, 200, env);
}

export async function verifyTOTP(request, env) {
  if (!env.DB) return json({ ok: false, error: '需要 D1 数据库' }, 500, env);

  const activeStored = await getMeta(env, ACTIVE_SECRET_KEY);
  const pendingStored = activeStored ? null : await getMeta(env, PENDING_SECRET_KEY);
  const storedSecret = activeStored || pendingStored;
  if (!storedSecret) return json({ ok: false, error: '尚未配置 TOTP' }, 400, env);

  const code = await readCode(request);
  if (!/^\d{6}$/.test(code)) {
    return json({ ok: false, error: 'TOTP 验证码必须是 6 位数字' }, 400, env);
  }

  try {
    const stored = await readStoredSecret(storedSecret, env);
    const secret = stored.secret;
    const valid = await verifyCode(secret, code);
    if (!valid) return json({ ok: false, error: 'TOTP 验证码无效' }, 401, env);

    if (pendingStored || stored.needsMigration) {
      await setMeta(env, ACTIVE_SECRET_KEY, await encryptSecret(secret, env));
      await deleteMeta(env, PENDING_SECRET_KEY);
    }

    const session = await createAdminSession(env, { provider: 'totp-setup', subject: 'admin' });
    return json({ ok: true, totp_enabled: true, session_id: session.session_id, expires_at: session.expires_at }, 200, env);
  } catch (err) {
    console.error('verifyTOTP error:', String(err?.message || err));
    return json({ ok: false, error: 'TOTP 验证失败' }, 400, env);
  }
}

export async function disableTOTP(env) {
  if (!env.DB) return json({ ok: false, error: '需要 D1 数据库' }, 500, env);

  const activeSecret = await getMeta(env, ACTIVE_SECRET_KEY);
  const pendingSecret = await getMeta(env, PENDING_SECRET_KEY);
  if (!activeSecret && !pendingSecret) return json({ ok: false, error: 'TOTP not enabled' }, 400, env);

  await deleteMeta(env, ACTIVE_SECRET_KEY);
  await deleteMeta(env, PENDING_SECRET_KEY);
  return json({ ok: true }, 200, env);
}

export async function checkTOTP(env) {
  if (!env.DB) return { ok: false, totp_enabled: false };
  const secret = await getMeta(env, ACTIVE_SECRET_KEY);
  return { ok: true, totp_enabled: !!secret };
}

export async function createAdminSession(env, { provider = 'password', subject = 'admin' } = {}) {
  const sessionId = crypto.randomUUID().replace(/-/g, '');
  const expiresAt = nowSec() + 86400;
  const tokenHash = HASHED_SESSION_PREFIX + await sha256Hex(sessionId);
  const now = nowSec();
  let sessions = await readSessions(env);
  sessions = sessions.filter((s) => Number(s.expires_at || 0) > now);
  sessions.push({
    token_hash: tokenHash,
    expires_at: expiresAt,
    created_at: now,
    provider: String(provider || 'password').slice(0, 32),
    subject: String(subject || 'admin').slice(0, 100),
  });
  while (sessions.length > MAX_ADMIN_SESSIONS) sessions.shift();
  await setMeta(env, SESSIONS_KEY, JSON.stringify(sessions));
  // Keep legacy single-session keys pointing at the newest session for older clients.
  await setMeta(env, SESSION_ID_KEY, tokenHash);
  await setMeta(env, SESSION_EXPIRES_KEY, String(expiresAt));
  return { session_id: sessionId, expires_at: expiresAt };
}

async function readSessions(env) {
  const raw = await getMeta(env, SESSIONS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((s) => s && s.token_hash);
    } catch (_) {}
  }
  const legacyId = await getMeta(env, SESSION_ID_KEY);
  const legacyExp = Number(await getMeta(env, SESSION_EXPIRES_KEY) || 0);
  if (legacyId && legacyExp > nowSec()) {
    return [{ token_hash: legacyId, expires_at: legacyExp, created_at: legacyExp - 86400 }];
  }
  return [];
}

export async function validateAdminSession(env, sessionId) {
  const presented = String(sessionId || '').trim();
  if (!presented || !env.DB) return { valid: false, expires_at: null };
  const presentedHash = HASHED_SESSION_PREFIX + await sha256Hex(presented);
  const now = nowSec();
  const sessions = await readSessions(env);
  for (const entry of sessions) {
    const exp = Number(entry.expires_at || 0);
    if (exp <= now) continue;
    const stored = String(entry.token_hash || '');
    if (!stored) continue;
    if (stored.startsWith(HASHED_SESSION_PREFIX)) {
      if (stored === presentedHash) return { valid: true, expires_at: exp, provider: entry.provider || 'legacy', subject: entry.subject || 'admin' };
    } else if (stored === presented) {
      return { valid: true, expires_at: exp, provider: entry.provider || 'legacy', subject: entry.subject || 'admin' };
    }
  }
  return { valid: false, expires_at: null };
}

export async function revokeAllAdminSessions(env) {
  if (!env.DB) return;
  await Promise.all([
    deleteMeta(env, SESSIONS_KEY),
    deleteMeta(env, SESSION_ID_KEY),
    deleteMeta(env, SESSION_EXPIRES_KEY),
  ]);
}

export async function verifyActiveTOTP(env, code) {
  const normalized = String(code || '').trim();
  if (!/^\d{6}$/.test(normalized) || !env.DB) return false;
  const storedSecret = await getMeta(env, ACTIVE_SECRET_KEY);
  if (!storedSecret) return false;
  const stored = await readStoredSecret(storedSecret, env);
  if (stored.needsMigration) {
    await setMeta(env, ACTIVE_SECRET_KEY, await encryptSecret(stored.secret, env));
  }
  return verifyCode(stored.secret, normalized);
}

async function readCode(request) {
  const body = await safeJson(request);
  return String(body?.code || request.headers.get('x-totp-code') || '').trim();
}

function totpUri(secret, env) {
  const issuer = encodeURIComponent(env.PUBLIC_SITE_NAME || 'NIE-SLA');
  return `otpauth://totp/${issuer}:admin?secret=${secret}&issuer=${issuer}`;
}

async function readStoredSecret(value, env) {
  const stored = String(value || '').trim();
  if (!stored) throw new Error('缺少 TOTP 密钥');
  if (isEncryptedSecret(stored)) return decryptSecret(stored.slice(ENCRYPTED_SECRET_PREFIX.length), env);
  if (looksLikePlainSecret(stored)) return { secret: stored.toUpperCase(), needsMigration: true };

  // Compatibility for older encrypted rows that were stored before a prefix was added.
  const legacy = await decryptSecret(stored, env);
  return { ...legacy, needsMigration: true };
}

function isEncryptedSecret(value) {
  return String(value || '').startsWith(ENCRYPTED_SECRET_PREFIX);
}

function looksLikePlainSecret(value) {
  return /^[A-Z2-7]{16,80}$/i.test(String(value || '').trim());
}

async function encryptSecret(secret, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const primary = primaryEncryptionMaterial(env);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(primary.material, ['encrypt']),
    new TextEncoder().encode(secret),
  ));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv, 0);
  combined.set(encrypted, iv.length);
  return ENCRYPTED_SECRET_PREFIX + bytesToBase64(combined);
}

async function decryptSecret(payload, env) {
  const combined = base64ToBytes(payload);
  if (combined.length <= 12) throw new Error('加密的 TOTP 密钥无效');
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);
  const candidates = encryptionKeyMaterials(env);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        await encryptionKey(candidate.material, ['decrypt']),
        encrypted,
      );
      return {
        secret: new TextDecoder().decode(decrypted),
        needsMigration: candidate.source !== 'primary',
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Unable to decrypt TOTP secret');
}

async function encryptionKey(material, usages) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, usages);
}

function primaryEncryptionMaterial(env) {
  const dedicated = String(env.TOTP_ENCRYPTION_KEY || '').trim();
  if (dedicated) return { material: dedicated, source: 'primary' };
  const adminPassword = String(env.ADMIN_PASSWORD || '').trim();
  if (adminPassword) return { material: adminPassword, source: 'primary' };
  if (allowAdminTokenTotpKey(env)) {
    const legacy = String(env.ADMIN_TOKEN || '').trim();
    if (legacy) return { material: legacy, source: 'primary' };
  }
  throw new Error('启用 TOTP 需要配置 ADMIN_PASSWORD 或 TOTP_ENCRYPTION_KEY');
}

function encryptionKeyMaterials(env) {
  const out = [];
  let primary = null;
  try { primary = primaryEncryptionMaterial(env); } catch (_) {}
  if (primary) out.push(primary);
  for (const candidate of [
    String(env.TOTP_ENCRYPTION_KEY || '').trim(),
    String(env.ADMIN_PASSWORD || '').trim(),
    String(env.ADMIN_TOKEN || '').trim(),
  ]) {
    if (candidate && !out.some((entry) => entry.material === candidate)) {
      out.push({ material: candidate, source: 'legacy' });
    }
  }
  return out;
}

function allowAdminTokenTotpKey(env) {
  const value = String(env.ALLOW_ADMIN_TOKEN_TOTP_KEY || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

async function verifyCode(secret, code) {
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let offset = -1; offset <= 1; offset++) {
    if (constantTimeEqual(await generateCode(secret, counter + offset), code)) return true;
  }
  return false;
}

async function generateCode(secret, counter) {
  const key = base32ToBytes(secret);
  const msg = new ArrayBuffer(8);
  new DataView(msg).setUint32(4, counter, false);
  const hmacKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, msg));
  const offset = hmac[19] & 0xf;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % 1000000).padStart(6, '0');
}

function base32ToBytes(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [];
  for (const ch of String(base32 || '').toUpperCase().replace(/=+$/g, '')) {
    const value = alphabet.indexOf(ch);
    if (value === -1) continue;
    for (let bit = 4; bit >= 0; bit--) bits.push((value >> bit) & 1);
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) value = (value << 1) | (bits[i * 8 + bit] || 0);
    bytes[i] = value;
  }
  return bytes;
}

function generateSecret() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (byte) => alphabet[byte % 32]).join('');
}

async function getMeta(env, key) {
  const row = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(key).first();
  return row?.value || null;
}

async function setMeta(env, key, value) {
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .bind(key, String(value), nowSec())
    .run();
}

async function deleteMeta(env, key) {
  await env.DB.prepare(`DELETE FROM app_meta WHERE key = ?`).bind(key).run();
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}
