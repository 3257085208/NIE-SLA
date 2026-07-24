import assert from 'node:assert/strict';
import { adminAuthConfig, completeGitHubOAuth, finishGitHubOAuth, getAdminAccount, passwordLogin, startGitHubOAuth, updateAdminAccount } from '../src/admin-auth.js';
import { disableTOTP, validateAdminSession } from '../src/totp.js';

function memoryDb() {
  const meta = new Map();
  return {
    meta,
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (/SELECT value FROM app_meta/i.test(sql)) {
            const value = meta.get(String(this.values[0]));
            return value === undefined ? null : { value };
          }
          return null;
        },
        async run() {
          if (/INSERT INTO app_meta/i.test(sql)) meta.set(String(this.values[0]), String(this.values[1]));
          if (/DELETE FROM app_meta/i.test(sql)) meta.delete(String(this.values[0]));
          return { success: true };
        },
      };
    },
  };
}

function jsonRequest(url, body) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

{
  const env = { DB: memoryDb(), ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'correct horse battery staple' };
  assert.deepEqual(await adminAuthConfig(env), { ok: true, password_enabled: true, github_enabled: false });
  const login = await passwordLogin(jsonRequest('https://status.example/api/auth/login', {
    username: 'owner',
    password: 'correct horse battery staple',
  }), env);
  assert.equal(login.session_valid, true);
  assert.equal(login.provider, 'password');
  assert.equal((await validateAdminSession(env, login.session_id)).valid, true);
  env.DB.meta.set('totp_secret', 'JBSWY3DPEHPK3PXP');
  const disabled = await disableTOTP(env);
  assert.equal(disabled.status, 200);
  assert.equal((await validateAdminSession(env, login.session_id)).valid, true);
  await assert.rejects(
    passwordLogin(jsonRequest('https://status.example/api/auth/login', { username: 'owner', password: 'wrong' }), env),
    /账号或密码错误/,
  );
}

{
  const env = { DB: memoryDb(), ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'correct horse battery staple' };
  const oldLogin = await passwordLogin(jsonRequest('https://status.example/api/auth/login', {
    username: 'owner',
    password: 'correct horse battery staple',
  }), env);
  const changed = await updateAdminAccount(jsonRequest('https://status.example/api/auth/account', {
    username: 'new.owner',
    current_password: 'correct horse battery staple',
    new_password: 'a much stronger replacement password',
    confirm_password: 'a much stronger replacement password',
  }), env);
  assert.equal(changed.credentials_source, 'db');
  assert.equal((await getAdminAccount(env)).username, 'new.owner');
  assert.equal((await validateAdminSession(env, oldLogin.session_id)).valid, false, 'changing credentials must revoke older sessions');
  assert.equal((await validateAdminSession(env, changed.session_id)).valid, true, 'the browser receives a replacement session');
  await assert.rejects(
    passwordLogin(jsonRequest('https://status.example/api/auth/login', {
      username: 'owner',
      password: 'correct horse battery staple',
    }), env),
    /账号或密码错误/,
  );
  const newLogin = await passwordLogin(jsonRequest('https://status.example/api/auth/login', {
    username: 'new.owner',
    password: 'a much stronger replacement password',
  }), env);
  assert.equal(newLogin.session_valid, true);
  const stored = JSON.parse(env.DB.meta.get('admin_credentials_v1'));
  assert.equal(stored.algorithm, 'pbkdf2-sha256');
  assert.ok(stored.password_hash && !JSON.stringify(stored).includes('replacement password'));
  await assert.rejects(
    updateAdminAccount(jsonRequest('https://status.example/api/auth/account', {
      username: 'new.owner',
      current_password: 'wrong password',
      new_password: 'another sufficiently long password',
      confirm_password: 'another sufficiently long password',
    }), env),
    /当前密码错误/,
  );

  env.DB.meta.set('totp_secret', 'JBSWY3DPEHPK3PXP');
  await assert.rejects(
    updateAdminAccount(jsonRequest('https://status.example/api/auth/account', {
      username: 'new.owner',
      current_password: 'a much stronger replacement password',
      new_password: 'another sufficiently long password',
      confirm_password: 'another sufficiently long password',
    }), env),
    /需要有效的 TOTP 验证码/,
  );
}

{
  const env = { DB: memoryDb(), ADMIN_TOKEN: 'legacy-password' };
  const login = await passwordLogin(jsonRequest('https://status.example/api/auth/login', {
    username: 'admin',
    password: 'legacy-password',
  }), env);
  assert.equal(login.session_valid, true);
}

{
  const env = {
    DB: memoryDb(),
    ADMIN_PASSWORD: 'password',
    GITHUB_OAUTH_CLIENT_ID: 'client-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
    GITHUB_OAUTH_ALLOWED_USERS: 'AllowedUser, second-user',
    PUBLIC_SITE_ORIGIN: 'https://status.example',
  };
  assert.equal((await adminAuthConfig(env)).github_enabled, true);
  const start = await startGitHubOAuth(new Request('https://status.example/api/auth/github/start'), env);
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('location'));
  assert.equal(authorize.origin, 'https://github.com');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'https://status.example/api/auth/github/callback');
  const state = authorize.searchParams.get('state');
  const cookie = start.headers.get('set-cookie').split(';')[0];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/login/oauth/access_token')) return Response.json({ access_token: 'github-access-token' });
    if (String(url) === 'https://api.github.com/user') return Response.json({ id: 123, login: 'AllowedUser' });
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const callback = await finishGitHubOAuth(new Request(
      `https://status.example/api/auth/github/callback?code=code&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
    ), env);
    assert.equal(callback.status, 302);
    const redirectUrl = callback.headers.get('location');
    assert.match(redirectUrl, /^https:\/\/status\.example\/admin#github_ticket=/);
    const ticket = new URLSearchParams(redirectUrl.split('#')[1]).get('github_ticket');
    const completed = await completeGitHubOAuth(jsonRequest('https://status.example/api/auth/github/complete', { ticket }), env);
    assert.equal(completed.provider, 'github');
    assert.equal(completed.subject, 'AllowedUser');
    assert.equal((await validateAdminSession(env, completed.session_id)).valid, true);
    await assert.rejects(
      completeGitHubOAuth(jsonRequest('https://status.example/api/auth/github/complete', { ticket }), env),
      /无效|过期|使用/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const env = {
    DB: memoryDb(),
    ADMIN_PASSWORD: 'password',
    GITHUB_OAUTH_CLIENT_ID: 'client-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
    GITHUB_OAUTH_ALLOWED_USERS: 'owner',
    PUBLIC_SITE_ORIGIN: 'https://status.example',
  };
  const start = await startGitHubOAuth(new Request('https://api.example/api/auth/github/start'), env);
  const authorize = new URL(start.headers.get('location'));
  assert.equal(authorize.searchParams.get('redirect_uri'), 'https://api.example/api/auth/github/callback');
}

console.log('admin auth tests passed');
