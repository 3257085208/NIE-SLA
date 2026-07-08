import { ApiError, constantTimeEqual, json, safeJson } from './auth.js';
import { ensureV6Schema } from './admin.js';
import { isTOTPEnabled, validateTOTPCode } from './totp.js';
import { sha256Hex } from './utils.js';

export const ADMIN_COOKIE = '__Host-nstatus-admin';
const SESSION_PREFIX = 'admin_session:';
const SESSION_TTL_SEC = 86400;

export async function hasAdminCookieSession(request, env) {
  return Boolean(await readAdminCookieSession(request, env));
}

export async function requireAdminTokenOrCookie(request, env, { enforceTotp = true } = {}) {
  if (await hasAdminCookieSession(request, env)) return { type: 'cookie' };
  const configured = String(env.ADMIN_TOKEN || '');
  if (!configured) throw new ApiError(500, 'Authentication not configured');
  const token = bearerToken(request);
  if (!token || !constantTimeEqual(token, configured)) throw new ApiError(401, 'Unauthorized');
  if (enforceTotp && await isTOTPEnabled(env)) {
    const legacyState = await legacyTotpSessionState(request, env);
    if (!legacyState.session_valid) throw new ApiError(401, 'TOTP code required or invalid');
  }
  return { type: 'bearer' };
}

export async function handleAdminSessionApi(request, env) {
  await ensureV6Schema(env);
  if (request.method === 'GET') {
    const session = await readAdminCookieSession(request, env);
    if (!session) return json({ ok: false, authenticated: false }, 401, env, noStoreHeaders());
    return json({ ok: true, authenticated: true, expires_at: session.expires_at, totp_enabled: await isTOTPEnabled(env) }, 200, env, noStoreHeaders());
  }

  if (request.method === 'DELETE') {
    await deletePresentedSession(request, env);
    return json({ ok: true }, 200, env, { ...noStoreHeaders(), 'set-cookie': expiredCookie() });
  }

  if (request.method !== 'POST') throw new ApiError(405, 'Method not allowed');

  const configured = String(env.ADMIN_TOKEN || '');
  if (!configured) throw new ApiError(500, 'Authentication not configured');
  const body = await safeJson(request);
  const token = String(body.token || '').trim();
  if (!token || !constantTimeEqual(token, configured)) throw new ApiError(401, 'Unauthorized');

  const totpEnabled = await isTOTPEnabled(env);
  if (totpEnabled) {
    const code = String(body.code || '').trim();
    if (!code) return json({ ok: false, error: 'TOTP code required', totp_required: true }, 401, env, noStoreHeaders());
    const verified = await validateTOTPCode(env, code);
    if (!verified.ok) return json({ ok: false, error: verified.error || 'TOTP code is invalid', totp_required: true }, 401, env, noStoreHeaders());
  }

  const session = await createAdminCookieSession(env);
  return json(
    { ok: true, authenticated: true, expires_at: session.expires_at, totp_enabled: totpEnabled },
    200,
    env,
    { ...noStoreHeaders(), 'set-cookie': sessionCookie(session.session_id, session.expires_at) },
  );
}

export async function adminLoginState(request, env) {
  if (await hasAdminCookieSession(request, env)) {
    return { totp_enabled: await isTOTPEnabled(env), totp_required: false, session_valid: true, session_id: null, session_expires_at: null };
  }
  return legacyTotpSessionState(request, env);
}

export function noStoreHeaders(extra = {}) {
  return {
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
    ...extra,
  };
}

async function createAdminCookieSession(env) {
  const sessionId = randomSessionId();
  const hash = await sha256Hex(sessionId);
  const expiresAt = nowSec() + SESSION_TTL_SEC;
  const payload = JSON.stringify({ expires_at: expiresAt, created_at: nowSec() });
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .bind(SESSION_PREFIX + hash, payload, nowSec())
    .run();
  return { session_id: sessionId, expires_at: expiresAt };
}

async function readAdminCookieSession(request, env) {
  if (!env.DB) return null;
  const sessionId = cookieValue(request, ADMIN_COOKIE);
  if (!looksLikeSessionId(sessionId)) return null;
  const hash = await sha256Hex(sessionId);
  const row = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(SESSION_PREFIX + hash).first().catch(() => null);
  if (!row?.value) return null;
  let payload = null;
  try { payload = JSON.parse(row.value); } catch (_) { return null; }
  const expiresAt = Number(payload.expires_at || 0);
  if (!expiresAt || expiresAt <= nowSec()) {
    await env.DB.prepare(`DELETE FROM app_meta WHERE key = ?`).bind(SESSION_PREFIX + hash).run().catch(() => {});
    return null;
  }
  return { session_id: sessionId, expires_at: expiresAt };
}

async function deletePresentedSession(request, env) {
  const sessionId = cookieValue(request, ADMIN_COOKIE);
  if (!env.DB || !looksLikeSessionId(sessionId)) return;
  await env.DB.prepare(`DELETE FROM app_meta WHERE key = ?`).bind(SESSION_PREFIX + await sha256Hex(sessionId)).run().catch(() => {});
}

async function legacyTotpSessionState(request, env) {
  if (!env.DB) return { totp_enabled: false, totp_required: false, session_valid: false, session_id: null, session_expires_at: null };
  const rows = await env.DB.prepare(`SELECT key, value FROM app_meta WHERE key IN ('totp_secret', 'totp_session_id', 'totp_session_expires')`).all().catch(() => ({ results: [] }));
  const meta = Object.fromEntries((rows.results || []).map(row => [row.key, row.value]));
  const secret = meta.totp_secret || '';
  const storedSession = meta.totp_session_id || '';
  const sessionExpires = Number(meta.totp_session_expires || 0);
  const presentedSession = String(request.headers.get('x-admin-session') || '').trim();
  const sessionValid = !!(secret && storedSession && sessionExpires > nowSec() && presentedSession && await sessionMatches(storedSession, presentedSession));
  return { totp_enabled: !!secret, totp_required: !!secret, session_valid: sessionValid, session_id: sessionValid ? presentedSession : null, session_expires_at: sessionValid ? sessionExpires : null };
}

async function sessionMatches(storedSession, presentedSession) {
  const stored = String(storedSession || '');
  const presented = String(presentedSession || '');
  if (!stored || !presented) return false;
  if (stored.startsWith('sha256:')) return constantTimeEqual(stored.slice(7), await sha256Hex(presented));
  return constantTimeEqual(stored, presented);
}

function bearerToken(request) {
  const auth = request.headers.get('authorization') || '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
}

function cookieValue(request, name) {
  const cookie = request.headers.get('cookie') || '';
  const prefix = `${name}=`;
  for (const part of cookie.split(';')) {
    const item = part.trim();
    if (item.startsWith(prefix)) return decodeURIComponent(item.slice(prefix.length));
  }
  return '';
}

function sessionCookie(sessionId, expiresAt) {
  return `${ADMIN_COOKIE}=${encodeURIComponent(sessionId)}; Max-Age=${Math.max(1, expiresAt - nowSec())}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function expiredCookie() {
  return `${ADMIN_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function randomSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function looksLikeSessionId(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ''));
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}
