let activeTheme = null;
let latestStatus = null;
let canvasRecord = null;
const THEME_API_RESOURCES = new Set(['status', 'checks', 'metrics', 'pings', 'latency']);

export async function initializeFrontendTheme() {
  try {
    const data = window.NIE_SLA_THEME_BOOTSTRAP
      ? await window.NIE_SLA_THEME_BOOTSTRAP
      : await fetchThemeRegistry();
    if (!data?.ok) throw new Error(data?.error || '主题注册表不可用');
    activeTheme = data.active_theme || null;
    await mountTheme(activeTheme);
  } catch (error) {
    console.warn('NIE-SLA theme unavailable:', error);
    activeTheme = null;
    await mountTheme(null);
  } finally {
    finishThemeBootstrap();
  }
  return activeTheme;
}

export function publishThemeStatus(status) {
  latestStatus = status;
  sendThemeStatus();
}

async function mountTheme(theme) {
  document.querySelectorAll('link[data-nie-sla-theme]').forEach(node => node.remove());
  document.body.dataset.extensionTheme = theme?.id || '';
  document.body.dataset.extensionThemeMode = '';
  canvasRecord = null;
  const canvas = document.getElementById('themeCanvas');
  if (canvas) {
    canvas.hidden = true;
    canvas.replaceChildren();
  }
  if (!theme) return;
  if (theme.mode === 'canvas') {
    if (!canvas || !theme.entry) throw new Error('交互主题缺少入口文件');
    const frame = document.createElement('iframe');
    frame.title = theme.name || '第三方主题';
    frame.sandbox = 'allow-scripts';
    frame.referrerPolicy = 'no-referrer';
    frame.height = String(clampCanvasHeight(theme.height));
    frame.src = themeFileUrl(theme, theme.entry);
    const loaded = waitForElementLoad(frame, 4000);
    frame.addEventListener('load', sendThemeStatus);
    canvas.appendChild(frame);
    canvas.hidden = false;
    document.body.dataset.extensionThemeMode = 'canvas';
    canvasRecord = { frame, theme, window: frame.contentWindow };
    await loaded;
    return;
  }
  await Promise.all((theme.styles || []).map(path => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.nieSlaTheme = theme.id;
    link.href = themeFileUrl(theme, path);
    const loaded = waitForElementLoad(link, 3000);
    document.head.appendChild(link);
    return loaded;
  }));
}

window.addEventListener('message', event => {
  const record = canvasRecord && event.source === canvasRecord.window ? canvasRecord : null;
  if (!record || !event.data || typeof event.data !== 'object') return;
  const type = String(event.data.type || '');
  if (type === 'nie-sla:ready' || type === 'nstatus:ready') sendThemeStatus();
  if (type === 'nie-sla:resize' || type === 'nstatus:resize') {
    record.frame.height = String(clampCanvasHeight(event.data.height));
  }
  if (type === 'nie-sla:request' || type === 'nstatus:request') handleThemeRequest(record, event.data);
});

function sendThemeStatus() {
  if (!canvasRecord?.window || !latestStatus) return;
  const message = { api_version: 'v1', payload: latestStatus };
  canvasRecord.window.postMessage({ type: 'nie-sla:status', ...message }, '*');
  canvasRecord.window.postMessage({ type: 'nstatus:status', ...message }, '*');
}

async function handleThemeRequest(record, message) {
  const requestId = String(message.request_id || '').slice(0, 80);
  const resource = String(message.resource || '').trim().toLowerCase();
  if (!requestId || !THEME_API_RESOURCES.has(resource) || !record.theme.permissions?.includes('status:read')) {
    sendThemeResponse(record, requestId, false, null, '不允许的只读主题请求');
    return;
  }
  try {
    const query = new URLSearchParams();
    const entries = Object.entries(message.query && typeof message.query === 'object' ? message.query : {}).slice(0, 20);
    for (const [key, value] of entries) {
      if (!/^[a-z][a-z0-9_]{0,39}$/i.test(key) || !['string', 'number', 'boolean'].includes(typeof value)) continue;
      query.set(key, String(value).slice(0, 200));
    }
    const suffix = query.size ? `?${query}` : '';
    const apiBase = String(window.NIE_SLA_API_BASE || window.NSTATUS_API_BASE || '').replace(/\/+$/, '');
    const response = await fetch(`${apiBase}/api/v1/${resource}${suffix}`, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { accept: 'application/json' },
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    sendThemeResponse(record, requestId, true, payload, '');
  } catch (error) {
    sendThemeResponse(record, requestId, false, null, String(error?.message || error).slice(0, 240));
  }
}

function sendThemeResponse(record, requestId, ok, payload, error) {
  const response = {
    api_version: 'v1',
    request_id: requestId,
    ok,
    ...(ok ? { payload } : { error }),
  };
  record.window?.postMessage({ type: 'nie-sla:response', ...response }, '*');
  record.window?.postMessage({ type: 'nstatus:response', ...response }, '*');
}

function themeFileUrl(theme, path) {
  const encodedPath = String(path || '').split('/').map(encodeURIComponent).join('/');
  const revision = `@${encodeURIComponent(theme.revision)}`;
  return `/api/themes/file/${encodeURIComponent(theme.id)}/${revision}/${encodedPath}`;
}

function clampCanvasHeight(value) {
  return Math.max(400, Math.min(12000, Number(value || 900)));
}

async function fetchThemeRegistry() {
  const response = await fetch('/api/themes', { cache: 'no-store', credentials: 'omit' });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function waitForElementLoad(element, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = window.setTimeout(() => finish(new Error('主题资源加载超时')), timeoutMs);
    element.addEventListener('load', () => finish(), { once: true });
    element.addEventListener('error', () => finish(new Error('主题资源加载失败')), { once: true });
  });
}

function finishThemeBootstrap() {
  window.clearTimeout(window.NIE_SLA_THEME_BOOT_FALLBACK);
  requestAnimationFrame(() => {
    document.body.classList.remove('theme-pending');
    document.body.classList.add('theme-ready');
  });
}
