let registry = { active_theme: null, plugins: [] };
let latestStatus = null;
const pluginFrames = new Map();
let themeFrameRecord = null;
const THEME_API_RESOURCES = new Set(['status', 'checks', 'metrics', 'pings', 'latency']);

export async function initializeFrontendExtensions() {
  try {
    const data = window.NSTATUS_EXTENSION_BOOTSTRAP
      ? await window.NSTATUS_EXTENSION_BOOTSTRAP
      : await fetchExtensionRegistry();
    if (!data?.ok) throw new Error(data?.error || '扩展注册表不可用');
    registry = data;
    await mountTheme(data.active_theme);
    mountPlugins(data.plugins || []);
  } catch (error) {
    console.warn('NStatus extensions unavailable:', error);
  } finally {
    finishThemeBootstrap();
  }
  return registry;
}

export function extensionBaseTheme() {
  return registry.active_theme?.mode === 'canvas' ? '' : (registry.active_theme?.base_theme || '');
}

export function publishExtensionStatus(status) {
  latestStatus = status;
  for (const frame of pluginFrames.keys()) sendStatus(frame);
  sendThemeStatus();
}

async function mountTheme(theme) {
  document.querySelectorAll('link[data-nstatus-extension-theme]').forEach(node => node.remove());
  document.body.dataset.extensionTheme = theme?.id || '';
  document.body.dataset.extensionThemeMode = '';
  themeFrameRecord = null;
  const canvas = document.getElementById('themeCanvas');
  if (canvas) {
    canvas.hidden = true;
    canvas.replaceChildren();
  }
  if (!theme) return;
  if (theme.mode === 'canvas') {
    if (!canvas || !theme.entry) return;
    const frame = document.createElement('iframe');
    frame.title = theme.name;
    frame.sandbox = 'allow-scripts';
    frame.referrerPolicy = 'no-referrer';
    frame.height = String(clampCanvasHeight(theme.height));
    const loaded = waitForElementLoad(frame, 3500);
    frame.addEventListener('load', () => sendThemeStatus());
    frame.src = extensionFileUrl(theme, theme.entry);
    canvas.appendChild(frame);
    canvas.hidden = false;
    document.body.dataset.extensionThemeMode = 'canvas';
    themeFrameRecord = { frame, theme, window: frame.contentWindow };
    await loaded;
    return;
  }
  await Promise.all((theme.styles || []).map(path => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.nstatusExtensionTheme = theme.id;
    link.href = extensionFileUrl(theme, path);
    const loaded = waitForElementLoad(link, 2500);
    document.head.appendChild(link);
    return loaded;
  }));
}

function mountPlugins(plugins) {
  const root = document.getElementById('pluginPanels');
  if (!root) return;
  pluginFrames.clear();
  root.replaceChildren();
  root.hidden = !plugins.length;
  for (const plugin of plugins) {
    const panel = document.createElement('section');
    panel.className = 'extension-plugin-panel';
    panel.dataset.pluginId = plugin.id;
    const heading = document.createElement('div');
    heading.className = 'extension-plugin-heading';
    const title = document.createElement('strong');
    title.textContent = plugin.name;
    const version = document.createElement('span');
    version.textContent = `v${plugin.version}`;
    heading.append(title, version);
    const frame = document.createElement('iframe');
    frame.title = plugin.name;
    frame.sandbox = 'allow-scripts';
    frame.loading = 'lazy';
    frame.referrerPolicy = 'no-referrer';
    frame.height = String(clampHeight(plugin.height));
    frame.src = extensionFileUrl(plugin, plugin.entry);
    frame.addEventListener('load', () => {
      pluginFrames.delete(null);
      pluginFrames.set(frame.contentWindow, { frame, plugin });
      sendStatus(frame.contentWindow);
    });
    panel.append(heading, frame);
    root.appendChild(panel);
    pluginFrames.set(frame.contentWindow, { frame, plugin });
  }
}

window.addEventListener('message', event => {
  const themeRecord = themeFrameRecord && event.source === themeFrameRecord.window ? themeFrameRecord : null;
  if (themeRecord && event.data && typeof event.data === 'object') {
    if (event.data.type === 'nstatus:ready') sendThemeStatus();
    if (event.data.type === 'nstatus:resize') themeRecord.frame.height = String(clampCanvasHeight(event.data.height));
    if (event.data.type === 'nstatus:request') handleThemeRequest(themeRecord, event.data);
    return;
  }
  const record = pluginFrames.get(event.source);
  if (!record || !event.data || typeof event.data !== 'object') return;
  if (event.data.type === 'nstatus:ready') sendStatus(event.source);
  if (event.data.type === 'nstatus:resize') record.frame.height = String(clampHeight(event.data.height));
});

function sendThemeStatus() {
  if (!themeFrameRecord?.window || !latestStatus) return;
  themeFrameRecord.window.postMessage({
    type: 'nstatus:status',
    api_version: 'v1',
    payload: latestStatus,
  }, '*');
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
    const apiBase = String(window.NSTATUS_API_BASE || '').replace(/\/+$/, '');
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
  record.window?.postMessage({
    type: 'nstatus:response',
    api_version: 'v1',
    request_id: requestId,
    ok,
    ...(ok ? { payload } : { error }),
  }, '*');
}

function sendStatus(targetWindow) {
  if (!targetWindow || !latestStatus) return;
  targetWindow.postMessage({
    type: 'nstatus:status',
    api_version: 'v1',
    payload: latestStatus,
  }, '*');
}

function extensionFileUrl(extension, path) {
  const encodedPath = String(path || '').split('/').map(encodeURIComponent).join('/');
  return `/api/extensions/file/${encodeURIComponent(extension.id)}/${encodedPath}?revision=${encodeURIComponent(extension.revision)}`;
}

function clampHeight(value) {
  return Math.max(200, Math.min(1200, Number(value || 360)));
}

function clampCanvasHeight(value) {
  return Math.max(400, Math.min(12000, Number(value || 900)));
}

async function fetchExtensionRegistry() {
  const response = await fetch('/api/extensions', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function waitForElementLoad(element, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    element.addEventListener('load', finish, { once: true });
    element.addEventListener('error', finish, { once: true });
  });
}

function finishThemeBootstrap() {
  window.clearTimeout(window.NSTATUS_THEME_BOOT_FALLBACK);
  requestAnimationFrame(() => {
    document.body.classList.remove('theme-pending');
    document.body.classList.add('theme-ready');
  });
}
