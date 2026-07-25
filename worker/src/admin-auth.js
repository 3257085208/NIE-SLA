import { ApiError, constantTimeEqual, json, safeJson } from './auth.js';
import { sha256Hex } from './utils.js';
import { checkTOTP, createAdminSession, revokeAllAdminSessions, verifyActiveTOTP } from './totp.js';
import { getAdminPath } from './admin-path.js';

const OAUTH_STATES_KEY = 'github_oauth_states';
const OAUTH_TICKETS_KEY = 'github_oauth_tickets';
const OAUTH_STATE_COOKIE = 'nstatus_oauth_state';
const OAUTH_STATE_TTL_SEC = 600;
const OAUTH_TICKET_TTL_SEC = 300;
const MAX_PENDING_OAUTH = 10;
const ADMIN_CREDENTIALS_KEY = 'admin_credentials_v1';
const PASSWORD_ALGORITHM = 'pbkdf2-sha256';
const PASSWORD_ITERATIONS = 210_000;
const MIN_PASSWORD_LENGTH = 9;
const MAX_PASSWORD_LENGTH = 256;
const PASSWORD_POLICY_MESSAGE = '密码至少 9 位，且必须包含大写字母、小写字母、数字和特殊符号';

export async function adminAuthConfig(env) {
  const credentials = await resolveAdminCredentials(env);
  return {
    ok: true,
    password_enabled: Boolean(credentials),
    github_enabled: githubEnabled(env),
    admin_path: await getAdminPath(env),
  };
}

export async function passwordLogin(request, env) {
  if (!env.DB) throw new ApiError(500, '登录需要 D1 数据库');
  const body = await safeJson(request, 8_192);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const credentials = await resolveAdminCredentials(env);
  const usernameValid = credentials && constantTimeEqual(username, credentials.username);
  const passwordValid = credentials && await verifyPassword(password, credentials);
  if (!usernameValid || !passwordValid) throw new ApiError(401, '账号或密码错误');

  const totp = await checkTOTP(env);
  if (totp.totp_enabled) {
    const code = String(body.totp || '').trim();
    if (!code) return { ok: true, totp_required: true };
    if (!await verifyActiveTOTP(env, code)) throw new ApiError(401, 'TOTP 验证码无效');
  }

  const session = await createAdminSession(env, { provider: 'password', subject: username });
  return loginResult(session, totp.totp_enabled, 'password', username);
}

export async function getAdminAccount(env) {
  const credentials = await resolveAdminCredentials(env);
  if (!credentials) throw new ApiError(503, '尚未配置管理员账号密码');
  return {
    ok: true,
    username: credentials.username,
    credentials_source: credentials.source,
    password_min_length: MIN_PASSWORD_LENGTH,
  };
}

export async function updateAdminAccount(request, env) {
  if (!env.DB) throw new ApiError(500, '修改账号需要 D1 数据库');
  const body = await safeJson(request, 16_384);
  const currentPassword = String(body.current_password || '');
  const username = normalizeUsername(body.username);
  const password = String(body.new_password || '');
  const confirmPassword = String(body.confirm_password || '');
  const current = await resolveAdminCredentials(env);

  if (!current || !await verifyPassword(currentPassword, current)) throw new ApiError(401, '当前密码错误');
  validateNewCredentials(username, password, confirmPassword);

  const totp = await checkTOTP(env);
  if (totp.totp_enabled && !await verifyActiveTOTP(env, String(body.totp || '').trim())) {
    throw new ApiError(401, '需要有效的 TOTP 验证码');
  }

  const record = await createAdminCredentialRecord(username, password);
  await setMeta(env, ADMIN_CREDENTIALS_KEY, JSON.stringify(record));
  await revokeAllAdminSessions(env);
  await Promise.all([
    writePending(env, OAUTH_STATES_KEY, []),
    writePending(env, OAUTH_TICKETS_KEY, []),
  ]);
  const session = await createAdminSession(env, { provider: 'password-reset', subject: username });
  return {
    ...loginResult(session, totp.totp_enabled, 'password-reset', username),
    credentials_source: 'db',
  };
}

export async function createAdminCredentialRecord(username, password) {
  const normalizedUsername = normalizeUsername(username);
  validateNewCredentials(normalizedUsername, String(password || ''), String(password || ''));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordHash = await derivePasswordHash(password, salt, PASSWORD_ITERATIONS);
  return {
    version: 1,
    username: normalizedUsername,
    algorithm: PASSWORD_ALGORITHM,
    iterations: PASSWORD_ITERATIONS,
    salt: bytesToBase64(salt),
    password_hash: bytesToBase64(passwordHash),
    updated_at: nowSec(),
  };
}

export async function startGitHubOAuth(request, env) {
  assertGitHubEnabled(env);
  if (!env.DB) throw new ApiError(500, 'GitHub 登录需要 D1 数据库');

  const state = randomToken();
  const now = nowSec();
  const states = (await readPending(env, OAUTH_STATES_KEY))
    .filter((entry) => Number(entry.expires_at || 0) > now)
    .slice(-(MAX_PENDING_OAUTH - 1));
  states.push({ token_hash: await sha256Hex(state), expires_at: now + OAUTH_STATE_TTL_SEC });
  await writePending(env, OAUTH_STATES_KEY, states);

  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', String(env.GITHUB_OAUTH_CLIENT_ID).trim());
  authorizeUrl.searchParams.set('redirect_uri', githubCallbackUrl(request, env));
  authorizeUrl.searchParams.set('scope', 'read:user');
  authorizeUrl.searchParams.set('state', state);

  return redirect(authorizeUrl.toString(), {
    'set-cookie': `${OAUTH_STATE_COOKIE}=${state}; Path=/api/auth/github; HttpOnly; Secure; SameSite=Lax; Max-Age=${OAUTH_STATE_TTL_SEC}`,
  });
}

export async function finishGitHubOAuth(request, env) {
  const site = publicSiteOrigin(request, env);
  try {
    assertGitHubEnabled(env);
    if (!env.DB) throw new ApiError(500, 'GitHub 登录需要 D1 数据库');
    const url = new URL(request.url);
    const error = String(url.searchParams.get('error') || '').trim();
    if (error) throw new ApiError(401, 'GitHub 授权已取消');

    const state = String(url.searchParams.get('state') || '').trim();
    const code = String(url.searchParams.get('code') || '').trim();
    const cookieState = readCookie(request, OAUTH_STATE_COOKIE);
    if (!state || !code || !cookieState || !constantTimeEqual(state, cookieState)) {
      throw new ApiError(401, 'GitHub 登录状态无效或已过期');
    }
    if (!await consumePendingToken(env, OAUTH_STATES_KEY, state)) {
      throw new ApiError(401, 'GitHub 登录状态无效或已过期');
    }

    const accessToken = await exchangeGitHubCode(code, request, env);
    const profile = await fetchGitHubProfile(accessToken);
    const login = String(profile.login || '').trim();
    if (!login || !allowedGitHubUsers(env).includes(login.toLowerCase())) {
      throw new ApiError(403, '此 GitHub 账号没有后台访问权限');
    }

    const ticket = randomToken();
    const now = nowSec();
    const tickets = (await readPending(env, OAUTH_TICKETS_KEY))
      .filter((entry) => Number(entry.expires_at || 0) > now)
      .slice(-(MAX_PENDING_OAUTH - 1));
    tickets.push({
      token_hash: await sha256Hex(ticket),
      expires_at: now + OAUTH_TICKET_TTL_SEC,
      subject: login,
    });
    await writePending(env, OAUTH_TICKETS_KEY, tickets);
    const adminPath = await getAdminPath(env);
    return redirect(`${site}${adminPath}#github_ticket=${encodeURIComponent(ticket)}`, { 'set-cookie': clearOAuthCookie() });
  } catch (error) {
    const message = error instanceof ApiError ? error.message : 'GitHub 登录暂时不可用';
    const adminPath = await getAdminPath(env);
    return redirect(`${site}${adminPath}#github_error=${encodeURIComponent(message)}`, { 'set-cookie': clearOAuthCookie() });
  }
}

export async function completeGitHubOAuth(request, env) {
  assertGitHubEnabled(env);
  if (!env.DB) throw new ApiError(500, 'GitHub 登录需要 D1 数据库');
  const body = await safeJson(request, 8_192);
  const ticket = String(body.ticket || '').trim();
  const entry = await findPendingToken(env, OAUTH_TICKETS_KEY, ticket);
  if (!entry) throw new ApiError(401, 'GitHub 登录票据无效或已过期');

  const totp = await checkTOTP(env);
  if (totp.totp_enabled) {
    const code = String(body.totp || '').trim();
    if (!code) return { ok: true, totp_required: true };
    if (!await verifyActiveTOTP(env, code)) throw new ApiError(401, 'TOTP 验证码无效');
  }

  const consumed = await consumePendingToken(env, OAUTH_TICKETS_KEY, ticket);
  if (!consumed) throw new ApiError(401, 'GitHub 登录票据已被使用');
  const subject = String(entry.subject || '').trim();
  const session = await createAdminSession(env, { provider: 'github', subject });
  return loginResult(session, totp.totp_enabled, 'github', subject);
}

function loginResult(session, totpEnabled, provider, subject) {
  return {
    ok: true,
    totp_enabled: Boolean(totpEnabled),
    totp_required: false,
    session_valid: true,
    session_id: session.session_id,
    session_expires_at: session.expires_at,
    auth_mode: 'session',
    provider,
    subject,
  };
}

function envAdminUsername(env) {
  return String(env.ADMIN_USERNAME || 'admin').trim() || 'admin';
}

function envAdminPassword(env) {
  return String(env.ADMIN_PASSWORD || env.ADMIN_TOKEN || '');
}

async function resolveAdminCredentials(env) {
  if (env.DB) {
    const row = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?').bind(ADMIN_CREDENTIALS_KEY).first().catch(() => null);
    if (row?.value) {
      try {
        const record = JSON.parse(row.value);
        if (validCredentialRecord(record)) return { ...record, source: 'db' };
      } catch (_) {}
    }
  }
  const password = envAdminPassword(env);
  return password ? { username: envAdminUsername(env), password, source: 'env' } : null;
}

async function verifyPassword(password, credentials) {
  const candidate = String(password || '');
  if (credentials?.source === 'db') {
    try {
      const salt = base64ToBytes(credentials.salt);
      const expected = base64ToBytes(credentials.password_hash);
      const actual = await derivePasswordHash(candidate, salt, Number(credentials.iterations));
      return constantTimeEqual(bytesToBase64(actual), bytesToBase64(expected));
    } catch (_) {
      return false;
    }
  }
  return Boolean(credentials?.password) && constantTimeEqual(candidate, credentials.password);
}

async function derivePasswordHash(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password || '')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  ));
}

function validCredentialRecord(record) {
  return record
    && record.version === 1
    && record.algorithm === PASSWORD_ALGORITHM
    && normalizeUsername(record.username) === record.username
    && Number.isInteger(record.iterations)
    && record.iterations >= 100_000
    && record.iterations <= 1_000_000
    && /^[A-Za-z0-9+/]{20,}={0,2}$/.test(String(record.salt || ''))
    && /^[A-Za-z0-9+/]{40,}={0,2}$/.test(String(record.password_hash || ''));
}

function validateNewCredentials(username, password, confirmation) {
  if (!username) throw new ApiError(400, '账号需为 3-64 位字母、数字或 . _ @ -');
  if (password.length < MIN_PASSWORD_LENGTH
    || password.length > MAX_PASSWORD_LENGTH
    || !/[a-z]/.test(password)
    || !/[A-Z]/.test(password)
    || !/[0-9]/.test(password)
    || !/[^A-Za-z0-9]/.test(password)) throw new ApiError(400, PASSWORD_POLICY_MESSAGE);
  if (password !== confirmation) throw new ApiError(400, '两次输入的新密码不一致');
  if (constantTimeEqual(username.toLowerCase(), password.toLowerCase())) throw new ApiError(400, '密码不能与账号相同');
}

function normalizeUsername(value) {
  const username = String(value || '').trim();
  return /^[A-Za-z0-9._@-]{3,64}$/.test(username) ? username : '';
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function githubEnabled(env) {
  return Boolean(
    String(env.GITHUB_OAUTH_CLIENT_ID || '').trim()
    && String(env.GITHUB_OAUTH_CLIENT_SECRET || '').trim()
    && allowedGitHubUsers(env).length,
  );
}

function assertGitHubEnabled(env) {
  if (!githubEnabled(env)) throw new ApiError(503, 'GitHub 登录尚未配置');
}

function allowedGitHubUsers(env) {
  return String(env.GITHUB_OAUTH_ALLOWED_USERS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 50);
}

async function exchangeGitHubCode(code, request, env) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'NIE-SLA' },
    body: JSON.stringify({
      client_id: String(env.GITHUB_OAUTH_CLIENT_ID).trim(),
      client_secret: String(env.GITHUB_OAUTH_CLIENT_SECRET).trim(),
      code,
      redirect_uri: githubCallbackUrl(request, env),
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new ApiError(502, 'GitHub 授权令牌交换失败');
  return String(data.access_token);
}

async function fetchGitHubProfile(accessToken) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'NIE-SLA',
      'x-github-api-version': '2022-11-28',
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.login) throw new ApiError(502, '无法读取 GitHub 用户信息');
  return data;
}

function publicSiteOrigin(request, env) {
  const configured = String(env.PUBLIC_SITE_ORIGIN || env.ALLOWED_ORIGIN || '').trim().replace(/\/+$/, '');
  if (configured) {
    try { return new URL(configured).origin; } catch (_) {}
  }
  return new URL(request.url).origin;
}

function githubCallbackUrl(request, env) {
  const configured = String(env.GITHUB_OAUTH_CALLBACK_ORIGIN || '').trim().replace(/\/+$/, '');
  if (configured) {
    try { return `${new URL(configured).origin}/api/auth/github/callback`; } catch (_) {}
  }
  return `${new URL(request.url).origin}/api/auth/github/callback`;
}

function randomToken() {
  return `${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
}

function readCookie(request, name) {
  const cookie = String(request.headers.get('cookie') || '');
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

function clearOAuthCookie() {
  return `${OAUTH_STATE_COOKIE}=; Path=/api/auth/github; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function redirect(location, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers },
  });
}

async function findPendingToken(env, key, token) {
  const hash = await sha256Hex(String(token || ''));
  const now = nowSec();
  return (await readPending(env, key)).find((entry) => (
    Number(entry.expires_at || 0) > now && constantTimeEqual(String(entry.token_hash || ''), hash)
  )) || null;
}

async function consumePendingToken(env, key, token) {
  const hash = await sha256Hex(String(token || ''));
  const now = nowSec();
  const pending = await readPending(env, key);
  let found = null;
  const remaining = [];
  for (const entry of pending) {
    if (Number(entry.expires_at || 0) <= now) continue;
    if (!found && constantTimeEqual(String(entry.token_hash || ''), hash)) {
      found = entry;
      continue;
    }
    remaining.push(entry);
  }
  await writePending(env, key, remaining);
  return found;
}

async function readPending(env, key) {
  const row = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?').bind(key).first();
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && entry.token_hash) : [];
  } catch (_) {
    return [];
  }
}

async function writePending(env, key, entries) {
  await env.DB.prepare('INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
    .bind(key, JSON.stringify(entries.slice(-MAX_PENDING_OAUTH)), nowSec())
    .run();
}

async function setMeta(env, key, value) {
  await env.DB.prepare('INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
    .bind(key, String(value), nowSec())
    .run();
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}
