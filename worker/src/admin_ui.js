import { ADMIN_CSS, ADMIN_JS, INSTALL_COMMAND_JS } from './admin_assets.js';
import { ApiError } from './auth.js';
import { handleAdminSessionApi, hasAdminCookieSession, noStoreHeaders } from './admin_session.js';

const ADMIN_VERSION = '20260708-backend-admin';

export async function handleAdminUiRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/admin/api/session') return handleAdminSessionApi(request, env);
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'Method not allowed');

  if (path === '/admin') {
    const loggedIn = await hasAdminCookieSession(request, env);
    return html(loggedIn ? adminAppHtml(env) : adminLoginHtml(env));
  }

  if (path === '/admin/assets/admin.css') return protectedAsset(request, env, ADMIN_CSS, 'text/css; charset=utf-8');
  if (path === '/admin/assets/admin.js') return protectedAsset(request, env, ADMIN_JS, 'text/javascript; charset=utf-8');
  if (path === '/admin/assets/install-command.js') return protectedAsset(request, env, INSTALL_COMMAND_JS, 'text/javascript; charset=utf-8');

  return new Response('Not found', { status: 404, headers: noStoreHeaders({ 'content-type': 'text/plain; charset=utf-8' }) });
}

async function protectedAsset(request, env, body, contentType) {
  if (!await hasAdminCookieSession(request, env)) {
    return new Response('Unauthorized', { status: 401, headers: noStoreHeaders({ 'content-type': 'text/plain; charset=utf-8' }) });
  }
  return new Response(body, {
    headers: {
      ...noStoreHeaders({
        'content-type': contentType,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      }),
    },
  });
}

function html(body) {
  return new Response(body, {
    headers: {
      ...noStoreHeaders({
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      }),
    },
  });
}

function adminLoginHtml(env) {
  const siteName = escapeHtml(env.PUBLIC_SITE_NAME || 'NStatus');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${siteName} Admin</title>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:22px;background:radial-gradient(circle at 15% 0,#d1fae5,#eef2f6 42%,#e2e8f0);font:14px/1.5 "Noto Sans SC","Microsoft YaHei",Segoe UI,sans-serif;color:#172033}.box{width:min(390px,94vw);background:#fff;border:1px solid #dfe7ef;border-radius:20px;padding:30px;box-shadow:0 24px 70px rgba(15,23,42,.13)}h1{margin:0 0 6px;text-align:center;font-size:24px}.sub{margin:0 0 22px;text-align:center;color:#64748b}.f{margin:0 0 13px}.f label{display:block;margin-bottom:5px;color:#64748b;font-size:12px;font-weight:800}.f input{width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:11px;font:inherit}.totp{display:none}.btn{width:100%;margin-top:4px;padding:11px 14px;border:0;border-radius:12px;background:#059669;color:#fff;font-weight:900;cursor:pointer}.btn[disabled]{opacity:.65;cursor:not-allowed}.err{display:none;margin:0 0 12px;padding:10px 12px;border-radius:11px;background:#fee2e2;color:#b91c1c;font-weight:800}.hint{display:none;margin:0 0 12px;color:#047857;text-align:center;font-weight:800}
  </style>
</head>
<body>
  <main class="box">
    <h1>${siteName} Admin</h1>
    <p class="sub">后台由 Worker 提供，登录后使用 HttpOnly 会话。</p>
    <div class="err" id="err"></div>
    <div class="f"><label>Admin Token</label><input id="token" type="password" autocomplete="current-password" placeholder="输入 ADMIN_TOKEN"></div>
    <div class="f totp" id="totpRow"><label>TOTP 验证码</label><input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6 位数字"></div>
    <p class="hint" id="hint">需要 TOTP 验证码</p>
    <button class="btn" id="login">登录</button>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    let tokenCache = '';
    async function submit() {
      const token = $('token').value.trim() || tokenCache;
      const code = $('code').value.trim();
      if (!token) return showError('请输入 ADMIN_TOKEN');
      $('login').disabled = true;
      $('err').style.display = 'none';
      try {
        const res = await fetch('/admin/api/session', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, code })
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 && data.totp_required) {
          tokenCache = token;
          $('totpRow').style.display = 'block';
          $('hint').style.display = 'block';
          $('code').focus();
          return;
        }
        if (!res.ok || data.ok === false) throw new Error(data.error || '登录失败');
        location.replace('/admin');
      } catch (err) {
        showError(err.message || '登录失败');
      } finally {
        $('login').disabled = false;
      }
    }
    function showError(message) {
      $('err').textContent = message;
      $('err').style.display = 'block';
    }
    $('login').addEventListener('click', submit);
    $('token').addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
    $('code').addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
  </script>
</body>
</html>`;
}

function adminAppHtml(env) {
  const siteName = escapeHtml(env.PUBLIC_SITE_NAME || 'NStatus');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${siteName} Admin</title>
  <link rel="stylesheet" href="/admin/assets/admin.css?v=${ADMIN_VERSION}">
</head>
<body>
  <div class="login-bg" id="loginPage" style="display:none">
    <div class="login-box">
      <h2>${siteName} Admin</h2>
      <div class="err" id="loginErr"></div>
      <div class="f"><label>Admin Token</label><input type="password" id="loginToken" placeholder="输入 ADMIN_TOKEN"></div>
      <div class="f" id="totpRow" style="display:none"><label>TOTP 验证码</label><input type="text" id="loginTotp" placeholder="6 位数字" maxlength="6" inputmode="numeric"></div>
      <div id="loginMsg" class="hint" style="display:none;text-align:center"></div>
      <button class="btn btn-primary" style="width:100%;padding:10px" id="loginBtn">登录</button>
    </div>
  </div>
  <div id="app">
    <header class="topbar">
      <div class="wrap">
        <a class="brand" href="/admin">${siteName}</a>
        <nav class="nav" id="nav">
          <a href="#" class="on" data-p="dash">仪表盘</a>
          <a href="#" data-p="targets">探针</a>
          <a href="#" data-p="pings">Ping</a>
          <a href="#" data-p="settings">设置</a>
        </nav>
        <div class="right"><button class="btn btn-sm btn-danger" id="logoutBtn">退出</button></div>
      </div>
    </header>
    <main class="wrap">
      <section class="page on" id="pg-dash">
        <h2>仪表盘</h2>
        <div class="stats" id="dStats"></div>
        <div class="row">
          <div class="col"><div class="card"><h3>系统指标</h3><div class="grid" id="dMetrics"></div></div></div>
          <div class="col"><div class="card"><h3>VPS 信息</h3><div class="vg" id="dVps" style="display:none"></div><div id="dVpsN" class="empty">暂无数据</div></div></div>
        </div>
        <div class="card"><h3>事件日志</h3><div id="dIncidents"></div></div>
      </section>
      <section class="page" id="pg-targets">
        <div class="top-actions"><h2>探针管理</h2><div><button class="btn btn-blue btn-sm" id="probeBtn">手动探测</button> <button class="btn btn-primary" id="addTargetBtn">+ 新增</button></div></div>
        <div id="tTable"><div class="loading">加载中...</div></div>
      </section>
      <section class="page" id="pg-pings">
        <div class="top-actions"><h2>Ping 管理</h2><button class="btn btn-primary" id="addPingBtn">+ 新增</button></div>
        <div id="pTable"><div class="loading">加载中...</div></div>
      </section>
      <section class="page" id="pg-settings">
        <h2>系统设置</h2>
        <div class="row">
          <div class="col"><div class="card"><h3>前端样式</h3><div id="sTheme">加载中...</div></div></div>
          <div class="col"><div class="card"><h3>流量统计</h3><div id="sTraffic">加载中...</div></div></div>
          <div class="col col-wide"><div class="card"><h3>Telegram 报警</h3><div id="sAlerts">加载中...</div></div></div>
          <div class="col"><div class="card"><h3>TOTP</h3><div id="sTotp">检查中...</div></div></div>
          <div class="col"><div class="card"><h3>归档</h3><p class="hint">手动触发昨日数据归档。</p><button class="btn btn-blue" id="archiveBtn">立即归档</button></div></div>
          <div class="col"><div class="card"><h3>系统信息</h3><div id="sInfo">加载中...</div></div></div>
          <div class="col"><div class="card"><h3>同步</h3><p class="hint">从 TARGETS_JSON 同步探针。</p><button class="btn" id="syncBtn">立即同步</button></div></div>
        </div>
      </section>
    </main>
  </div>
  <div class="overlay" id="overlay"><div class="modal" id="modal"></div></div>
  <div class="toast" id="toast"></div>
  <script type="module" src="/admin/assets/admin.js?v=${ADMIN_VERSION}"></script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}
