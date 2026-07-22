let registry = { active_theme: null, plugins: [] };
let latestStatus = null;
const pluginFrames = new Map();

export async function initializeFrontendExtensions() {
  try {
    const response = await fetch('/api/extensions', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    registry = data;
    mountTheme(data.active_theme);
    mountPlugins(data.plugins || []);
  } catch (error) {
    console.warn('NStatus extensions unavailable:', error);
  }
  return registry;
}

export function extensionBaseTheme() {
  return registry.active_theme?.base_theme || '';
}

export function publishExtensionStatus(status) {
  latestStatus = status;
  for (const frame of pluginFrames.keys()) sendStatus(frame);
}

function mountTheme(theme) {
  document.querySelectorAll('link[data-nstatus-extension-theme]').forEach(node => node.remove());
  document.body.dataset.extensionTheme = theme?.id || '';
  if (!theme) return;
  for (const path of theme.styles || []) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.nstatusExtensionTheme = theme.id;
    link.href = extensionFileUrl(theme, path);
    document.head.appendChild(link);
  }
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
  const record = pluginFrames.get(event.source);
  if (!record || !event.data || typeof event.data !== 'object') return;
  if (event.data.type === 'nstatus:ready') sendStatus(event.source);
  if (event.data.type === 'nstatus:resize') record.frame.height = String(clampHeight(event.data.height));
});

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
