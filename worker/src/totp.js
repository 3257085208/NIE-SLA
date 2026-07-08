import { json, safeJson, constantTimeEqual } from './auth.js';
import { sha256Hex } from './utils.js';

const ACTIVE_SECRET_KEY = 'totp_secret';
const PENDING_SECRET_KEY = 'totp_pending_secret';
const SESSION_ID_KEY = 'totp_session_id';
const SESSION_EXPIRES_KEY = 'totp_session_expires';
const ENCRYPTED_SECRET_PREFIX = 'enc:v1:';
const HASHED_SESSION_PREFIX = 'sha256:';

export async function setupTOTP(env) {
  if (!env.DB) return json({ ok: false, error: 'D1 required' }, 500, env);

  const activeSecret = await getMeta(env, ACTIVE_SECRET_KEY);
  if (activeSecret) {
    return json({ ok: false, error: 'TOTP already configured. Disable first.' }, 400, env);
  }

  const secret = generateSecret();
  await setMeta(env, PENDING_SECRET_KEY, await encryptSecret(secret, env));
  return json({ ok: true, secret, uri: totpUri(secret, env) }, 200, env);
}

export async function verifyTOTP(request, env) {
  if (!env.DB) return json({ ok: false, error: 'D1 required' }, 500, env);

  const activeStored = await getMeta(env, ACTIVE_SECRET_KEY);
  const pendingStored = activeStored ? null : await getMeta(env, PENDING_SECRET_KEY);
  const storedSecret = activeStored || pendingStored;
  if (!storedSecret) return json({ ok: false, error: 'TOTP not configured' }, 400, env);

  const code = await readCode(request);
  if (!/^\d{6}$/.test(code)) {
    return json({ ok: false, error: 'TOTP code must be 6 digits' }, 400, env);
  }

  try {
    const stored = await readStoredSecret(storedSecret, env);
    const secret = stored.secret;
    const valid = await verifyCode(secret, code);
    if (!valid) return json({ ok: false, error: 'TOTP code is invalid' }, 401, env);

    if (pendingStored || stored.needsMigration) {
      await setMeta(env, ACTIVE_SECRET_KEY, await encryptSecret(secret, env));
      await deleteMeta(env, PENDING_SECRET_KEY);
    }

    const session = await createSession(env);
    return json({ ok: true, totp_enabled: true, session_id: session.session_id, expires_at: session.expires_at }, 200, env);
  } catch (err) {
    console.error('verifyTOTP error:', String(err?.message || err));
    return json({ ok: false, error: 'TOTP verification failed' }, 400, env);
  }
}

export async function disableTOTP(env) {
  if (!env.DB) return json({ ok: false, error: 'D1 required' }, 500, env);

  const activeSecret = await getMeta(env, ACTIVE_SECRET_KEY);
  const pendingSecret = await getMeta(env, PENDING_SECRET_KEY);
  if (!activeSecret && !pendingSecret) return json({ ok: false, error: 'TOTP not enabled' }, 400, env);

  await deleteMeta(env, ACTIVE_SECRET_KEY);
  await deleteMeta(env, PENDING_SECRET_KEY);
  await deleteMeta(env, SESSION_ID_KEY);
  await deleteMeta(env, SESSION_EXPIRES_KEY);
  return json({ ok: true }, 200, env);
}

export async function checkTOTP(env) {
  if (!env.DB) return { ok: false, totp_enabled: false };
  const secret = await getMeta(env, ACTIVE_SECRET_KEY);
  return { ok: true, totp_enabled: !!secret };
}

export async function isTOTPEnabled(env) {
  if (!env.DB) return false;
  return Boolean(await getMeta(env, ACTIVE_SECRET_KEY));
}

export async function validateTOTPCode(env, code) {
  if (!env.DB) return { ok: false, error: 'D1 required' };
  if (!/^\d{6}$/.test(String(code || '').trim())) return { ok: false, error: 'TOTP code must be 6 digits' };
  const activeStored = await getMeta(env, ACTIVE_SECRET_KEY);
  if (!activeStored) return { ok: true, totp_enabled: false };
  const stored = await readStoredSecret(activeStored, env);
  const valid = await verifyCode(stored.secret, String(code).trim());
  if (valid && stored.needsMigration) await setMeta(env, ACTIVE_SECRET_KEY, await encryptSecret(stored.secret, env));
  return valid ? { ok: true, totp_enabled: true } : { ok: false, totp_enabled: true, error: 'TOTP code is invalid' };
}

async function createSession(env) {
  const sessionId = crypto.randomUUID().replace(/-/g, '');
  const expiresAt = nowSec() + 86400;
  await setMeta(env, SESSION_ID_KEY, HASHED_SESSION_PREFIX + await sha256Hex(sessionId));
  await setMeta(env, SESSION_EXPIRES_KEY, String(expiresAt));
  return { session_id: sessionId, expires_at: expiresAt };
}

async function readCode(request) {
  const body = await safeJson(request);
  return String(body?.code || request.headers.get('x-totp-code') || '').trim();
}

function totpUri(secret, env) {
  const issuer = encodeURIComponent(env.PUBLIC_SITE_NAME || 'NStatus');
  return `otpauth://totp/${issuer}:admin?secret=${secret}&issuer=${issuer}`;
}

async function readStoredSecret(value, env) {
  const stored = String(value || '').trim();
  if (!stored) throw new Error('Missing TOTP secret');
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
  if (combined.length <= 12) throw new Error('Invalid encrypted TOTP secret');
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
  const primary = String(env.TOTP_ENCRYPTION_KEY || '').trim();
  if (primary) return { material: primary, source: 'primary' };
  if (allowAdminTokenTotpKey(env)) {
    const legacy = String(env.ADMIN_TOKEN || '').trim();
    if (legacy) return { material: legacy, source: 'legacy-admin-token' };
  }
  throw new Error('TOTP_ENCRYPTION_KEY is required for TOTP secret encryption');
}

function encryptionKeyMaterials(env) {
  const out = [];
  const primary = String(env.TOTP_ENCRYPTION_KEY || '').trim();
  if (primary) out.push({ material: primary, source: 'primary' });
  const legacy = String(env.ADMIN_TOKEN || '').trim();
  if (legacy && legacy !== primary) out.push({ material: legacy, source: 'legacy-admin-token' });
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
