import assert from 'node:assert/strict';
import { adminAuthConfig, completeGitHubOAuth, createAdminCredentialRecord, finishGitHubOAuth, getAdminAccount, passwordLogin, startGitHubOAuth, updateAdminAccount } from '../src/admin-auth.js';
import { checkTOTP, disableTOTP, setupTOTP, validateAdminSession } from '../src/totp.js';

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
  assert.deepEqual(await checkTOTP(env), { ok: true, totp_enabled: false });
  assert.deepEqual(await adminAuthConfig(env), { ok: true, password_enabled: true, github_enabled: false, admin_path: '/admin' });
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
  const env = { DB: memoryDb(), ADMIN_PASSWORD: 'Admin-fallback1!' };
  const response = await setupTOTP(env);
  assert.equal(response.status, 200);
  assert.match(env.DB.meta.get('totp_pending_secret'), /^enc:v1:/);
  assert.deepEqual(await checkTOTP(env), { ok: true, totp_enabled: false }, 'TOTP remains disabled until the first code is verified');
}

{
  const env = { DB: memoryDb(), ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'correct horse battery staple' };
  const oldLogin = await passwordLogin(jsonRequest('https://status.example/api/auth/login', {
    username: 'owner',
    password: 'correct horse battery staple',
  }), env);
  const changed = await updateAdminAccount(jsonRequest('https://status.example/api/auth/account', {
    username: 'new.owner',
    current_username: 'owner',
    change_username: true,
    current_password: 'correct horse battery staple',
    new_password: 'A-much-stronger-replacement1',
    confirm_password: 'A-much-stronger-replacement1',
  }), env);
  assert.equal(changed.credentials_source, 'db');
  assert.equal(changed.username_changed, true);
  assert.equal(changed.logout_required, true);
  assert.equal(changed.session_valid, false);
  assert.equal(changed.message, '账号密码已更新，请重新登录');
  assert.equal((await getAdminAccount(env)).username, 'new.owner');
  assert.equal((await validateAdminSession(env, oldLogin.session_id)).valid, false, 'changing credentials must revoke older sessions');
  assert.equal(changed.session_id, undefined, 'changing credentials must not issue a replacement session');
  await assert.rejects(
    passwordLogin(jsonRequest('https://status.example/api/auth/login', {
      username: 'owner',
      password: 'correct horse battery staple',
    }), env),
    /账号或密码错误/,
  );
  const newLogin = await passwordLogin(jsonRequest('https://status.example/api/auth/login', {
    username: 'new.owner',
    password: 'A-much-stronger-replacement1',
  }), env);
  assert.equal(newLogin.session_valid, true);
  const stored = JSON.parse(env.DB.meta.get('admin_credentials_v1'));
  assert.equal(stored.algorithm, 'pbkdf2-sha256');
  assert.equal(stored.iterations, 50_000, 'password hashing must fit the free Worker CPU budget');
  assert.ok(stored.password_hash && !JSON.stringify(stored).includes('replacement password'));
  await assert.rejects(
    updateAdminAccount(jsonRequest('https://status.example/api/auth/account', {
      username: 'new.owner',
      current_password: 'wrong password',
      new_password: 'Another-sufficiently-long1!',
      confirm_password: 'Another-sufficiently-long1!',
    }), env),
    /当前密码错误/,
  );

  env.DB.meta.set('totp_secret', 'JBSWY3DPEHPK3PXP');
  await assert.rejects(
    updateAdminAccount(jsonRequest('https://status.example/api/auth/account', {
      username: 'new.owner',
      current_password: 'A-much-stronger-replacement1',
      new_password: 'Another-sufficiently-long1!',
      confirm_password: 'Another-sufficiently-long1!',
    }), env),
    /需要有效的 TOTP 验证码/,
  );
}

{
  const env = { DB: memoryDb(), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'Admin-current1!' };
  const passwordOnly = await updateAdminAccount(jsonRequest('https://status.example/api/auth/account', {
    username: 'admin',
    current_username: 'admin',
    change_username: false,
    current_password: 'Admin-current1!',
    new_password: 'Admin-replacement2!',
    confirm_password: 'Admin-replacement2!',
  }), env);
  assert.equal(passwordOnly.username, 'admin');
  assert.equal(passwordOnly.username_changed, false);
  assert.equal((await getAdminAccount(env)).username, 'admin');
  assert.equal((await passwordLogin(jsonRequest('https://status.example/api/auth/login', {
    username: 'admin',
    password: 'Admin-replacement2!',
  }), env)).session_valid, true);

  await assert.rejects(
    updateAdminAccount(jsonRequest('https://status.example/api/auth/account', {
      username: 'admin',
      current_username: 'admin',
      change_username: true,
      current_password: 'Admin-replacement2!',
      new_password: 'Another-replacement3!',
      confirm_password: 'Another-replacement3!',
    }), env),
    /新管理员账号与当前账号相同/,
  );
  await assert.rejects(
    updateAdminAccount(jsonRequest('https://status.example/api/auth/account', {
      username: 'new.admin',
      current_username: 'stale.admin',
      change_username: true,
      current_password: 'Admin-replacement2!',
      new_password: 'Another-replacement3!',
      confirm_password: 'Another-replacement3!',
    }), env),
    /管理员账号已发生变化/,
  );
}

{
  const accepted = await createAdminCredentialRecord('owner', 'Abcdef1!x');
  assert.equal(accepted.username, 'owner');
  for (const password of ['Abcd1!xy', 'abcdef1!x', 'ABCDEF1!X', 'Abcdefg!x', 'Abcdef12x']) {
    await assert.rejects(
      createAdminCredentialRecord('owner', password),
      /密码至少 9 位，且必须包含大写字母、小写字母、数字和特殊符号/,
    );
  }
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
  env.DB.meta.set('admin_path', '/console-7f3a');
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
    assert.match(redirectUrl, /^https:\/\/status\.example\/console-7f3a#github_ticket=/);
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
