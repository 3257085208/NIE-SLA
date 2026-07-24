import { ApiError, constantTimeEqual, json, safeJson } from './auth.js';
import { sha256Hex } from './utils.js';
import { checkTOTP, createAdminSession, verifyActiveTOTP } from './totp.js';

const OAUTH_STATES_KEY = 'github_oauth_states';
const OAUTH_TICKETS_KEY = 'github_oauth_tickets';
const OAUTH_STATE_COOKIE = 'nstatus_oauth_state';
const OAUTH_STATE_TTL_SEC = 600;
const OAUTH_TICKET_TTL_SEC = 300;
const MAX_PENDING_OAUTH = 10;

export function adminAuthConfig(env) {
  return {
    ok: true,
    password_enabled: Boolean(adminPassword(env)),
    github_enabled: githubEnabled(env),
  };
}

export async function passwordLogin(request, env) {
  if (!env.DB) throw new ApiError(500, '登录需要 D1 数据库');
  const body = await safeJson(request, 8_192);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const expectedUsername = adminUsername(env);
  const expectedPassword = adminPassword(env);

  const usernameValid = constantTimeEqual(username, expectedUsername);
  const passwordValid = expectedPassword && constantTimeEqual(password, expectedPassword);
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
    return redirect(`${site}/admin#github_ticket=${encodeURIComponent(ticket)}`, { 'set-cookie': clearOAuthCookie() });
  } catch (error) {
    const message = error instanceof ApiError ? error.message : 'GitHub 登录暂时不可用';
    return redirect(`${site}/admin#github_error=${encodeURIComponent(message)}`, { 'set-cookie': clearOAuthCookie() });
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

function adminUsername(env) {
  return String(env.ADMIN_USERNAME || 'admin').trim() || 'admin';
}

function adminPassword(env) {
  return String(env.ADMIN_PASSWORD || env.ADMIN_TOKEN || '');
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

function nowSec() {
  return Math.floor(Date.now() / 1000);
}
