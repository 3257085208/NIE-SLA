import { ApiError, safeJson } from './auth.js';
import { assertPublicHttpUrl, nowSec, parseBoolean } from './utils.js';
import { sanitizeAnsiContent, stripAnsiSafe } from './nodequality.js';

const SETTINGS_KEY = 'nq_image_host_settings';
const TOKEN_KEY = 'nq_image_host_token';
const SECRET_PREFIX = 'enc:v1:';
const SECRET_CONTEXT = new TextEncoder().encode('NIE-SLA:nq-image-host-token:v1');
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_RENDER_LINES = 1400;
const MAX_RENDER_COLUMNS = 240;
const UPLOAD_TIMEOUT_MS = 10_000;
const CHANNELS = new Set(['', 'telegram', 'cfr2', 's3', 'discord', 'huggingface', 'webdav', 'external']);

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  endpoint: '',
  upload_channel: 'cfr2',
  channel_name: '',
  folder: 'NIE-SLA/NodeQuality',
});

const ANSI_COLORS = Object.freeze({
  30: '#111827', 31: '#f87171', 32: '#86efac', 33: '#fde047',
  34: '#93c5fd', 35: '#d8b4fe', 36: '#67e8f9', 37: '#e5e7eb',
  90: '#94a3b8', 91: '#fca5a5', 92: '#bbf7d0', 93: '#fef08a',
  94: '#bfdbfe', 95: '#e9d5ff', 96: '#a5f3fc', 97: '#f8fafc',
});

export async function getNodeQualityImageHostSettings(env, { includeSecret = false } = {}) {
  const stored = await readStoredSettings(env);
  const endpointFromEnv = String(env.NQ_IMGBED_URL || '').trim();
  const tokenFromEnv = String(env.NQ_IMGBED_TOKEN || '').trim();
  const storedToken = await readStoredToken(env);
  const settings = normalizeSettings({
    ...stored,
    endpoint: endpointFromEnv || stored.endpoint,
    upload_channel: String(env.NQ_IMGBED_CHANNEL || '').trim() || stored.upload_channel,
    channel_name: String(env.NQ_IMGBED_CHANNEL_NAME || '').trim() || stored.channel_name,
    folder: String(env.NQ_IMGBED_FOLDER || '').trim() || stored.folder,
  });
  const token = tokenFromEnv || storedToken;
  const result = {
    ok: true,
    ...settings,
    endpoint_source: endpointFromEnv ? 'env' : (settings.endpoint ? 'db' : 'none'),
    api_token_set: Boolean(token),
    api_token_source: tokenFromEnv ? 'env' : (storedToken ? 'db' : 'none'),
    compatible_api: 'MarSeventh/CloudFlare-ImgBed',
  };
  if (includeSecret) result.api_token = token;
  return result;
}

export async function updateNodeQualityImageHostSettings(request, env) {
  if (!env.DB) throw new ApiError(500, '缺少 D1 的 DB 绑定');
  const body = await safeJson(request, 32 * 1024);
  const previous = await readStoredSettings(env);
  const next = normalizeSettings({ ...previous, ...pickSettings(body) });
  if (next.enabled && !resolvedEndpoint(next, env)) throw new ApiError(400, '启用 NQ 图床前必须填写上传 API 地址');
  const currentToken = String(env.NQ_IMGBED_TOKEN || '').trim() || await readStoredToken(env);
  const clearToken = parseBoolean(body?.api_token_clear, false);
  let encryptedToken = null;
  let suppliedToken = '';
  if (Object.prototype.hasOwnProperty.call(body || {}, 'api_token')) {
    suppliedToken = String(body.api_token || '').trim();
    if (suppliedToken) {
      if (suppliedToken.length < 16 || suppliedToken.length > 512) throw new ApiError(400, '图床 API Token 长度无效');
      encryptedToken = await encryptSecret(suppliedToken, env);
    }
  }
  const effectiveToken = String(env.NQ_IMGBED_TOKEN || '').trim() || suppliedToken || (clearToken ? '' : currentToken);
  if (next.enabled && !effectiveToken) throw new ApiError(400, '启用 NQ 图床前必须配置具有 upload 权限的 API Token');

  await setMeta(env, SETTINGS_KEY, JSON.stringify(next));
  if (encryptedToken) await setMeta(env, TOKEN_KEY, encryptedToken);
  else if (clearToken) await setMeta(env, TOKEN_KEY, '');
  return getNodeQualityImageHostSettings(env);
}

export async function testNodeQualityImageHost(request, env) {
  const body = await safeJson(request, 32 * 1024).catch(() => ({}));
  const current = await getNodeQualityImageHostSettings(env, { includeSecret: true });
  const settings = normalizeSettings({ ...current, ...pickSettings(body) });
  const token = String(body?.api_token || '').trim() || current.api_token;
  if (!token) throw new ApiError(400, '请先填写或保存具有 upload 权限的 API Token');
  const svg = renderNodeQualitySvg('\u001b[36mNIE-SLA\u001b[0m 图床连接测试\n\u001b[32mCloudFlare-ImgBed API 正常\u001b[0m', {
    title: 'NodeQuality 图床连接测试',
    subtitle: new Date().toISOString(),
  });
  const imageUrl = await uploadSvg(env, settings, token, svg, `nie-sla-nq-test-${Date.now()}.svg`);
  return { ok: true, image_url: imageUrl };
}

export async function uploadNodeQualityReportImages(env, normalized, options = {}) {
  if (!normalized?.report) return { normalized, status: { enabled: false, uploaded: 0, skipped: true } };
  const settings = await getNodeQualityImageHostSettings(env, { includeSecret: true });
  if (!settings.enabled) return { normalized, status: { enabled: false, uploaded: 0, skipped: true } };
  if (!settings.endpoint || !settings.api_token) {
    return { normalized, status: { enabled: true, uploaded: 0, errors: ['图床地址或 API Token 未配置'] } };
  }

  let report;
  try { report = JSON.parse(normalized.report); } catch (_) {
    return { normalized, status: { enabled: true, uploaded: 0, errors: ['NQ 报告结构无效'] } };
  }
  const tabs = Array.isArray(report.tabs) ? report.tabs : [];
  const candidates = tabs.filter((tab) => ['network', 'route'].includes(String(tab?.id || '')) && tab?.content);
  if (!candidates.length) return { normalized, status: { enabled: true, uploaded: 0, skipped: true } };

  const agentId = safeFilePart(options.agentId || 'vps');
  const reportId = safeFilePart(extractReportId(report.link) || String(options.finishedAt || nowSec()));
  const results = await Promise.all(candidates.map(async (tab) => {
    try {
      const svg = renderNodeQualitySvg(tab.content, {
        title: tab.id === 'route' ? 'NodeQuality · 回程路由' : 'NodeQuality · 网络质量',
        subtitle: String(options.targetName || options.agentId || '').trim(),
      });
      const filename = `${agentId}-${reportId}-${safeFilePart(tab.id)}.svg`;
      const image = await uploadSvg(env, settings, settings.api_token, svg, filename);
      return { id: tab.id, image };
    } catch (error) {
      return { id: tab.id, error: safeUploadError(error) };
    }
  }));

  const byId = new Map(results.filter((item) => item.image).map((item) => [item.id, item.image]));
  report.tabs = tabs.map((tab) => byId.has(tab.id)
    ? { ...tab, kind: 'image', image: byId.get(tab.id), content: String(tab.content || '').slice(0, 60_000) }
    : tab);
  const updated = { ...normalized, report: JSON.stringify(report) };
  return {
    normalized: updated,
    status: {
      enabled: true,
      uploaded: byId.size,
      images: results.filter((item) => item.image).map((item) => item.id),
      errors: results.filter((item) => item.error).map((item) => `${item.id}: ${item.error}`),
    },
  };
}

export function renderNodeQualitySvg(content, options = {}) {
  const source = sanitizeAnsiContent(String(content || '')).replace(/\t/g, '    ');
  const originalLines = source.split('\n');
  const truncated = originalLines.length > MAX_RENDER_LINES;
  const lines = originalLines.slice(0, MAX_RENDER_LINES);
  if (truncated) lines.push(`... 报告过长，已截取前 ${MAX_RENDER_LINES} 行`);
  const columns = Math.min(MAX_RENDER_COLUMNS, Math.max(88, ...lines.map((line) => visibleColumns(stripAnsiSafe(line)))));
  const width = Math.min(2200, Math.max(760, Math.ceil(columns * 8.1 + 48)));
  const headerHeight = 58;
  const lineHeight = 18;
  const height = Math.max(150, headerHeight + 24 + lines.length * lineHeight);
  const title = xmlEscape(String(options.title || 'NodeQuality').slice(0, 120));
  const subtitle = xmlEscape(String(options.subtitle || '').slice(0, 160));
  const textLines = lines.map((line, index) => {
    const segments = ansiSegments(line);
    const spans = segments.length
      ? segments.map((segment) => `<tspan fill="${segment.color}"${segment.bold ? ' font-weight="700"' : ''}>${xmlEscape(segment.text || ' ')}</tspan>`).join('')
      : '<tspan> </tspan>';
    return `<text x="24" y="${headerHeight + 24 + index * lineHeight}" class="line" xml:space="preserve">${spans}</text>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
  <rect width="100%" height="100%" fill="#0f172a"/>
  <rect width="100%" height="${headerHeight}" fill="#162033"/>
  <circle cx="24" cy="29" r="5" fill="#2ea36d"/>
  <text x="39" y="26" class="title">${title}</text>
  ${subtitle ? `<text x="39" y="44" class="subtitle">${subtitle}</text>` : ''}
  <style>
    .title { fill:#f8fafc; font:700 14px ui-monospace,SFMono-Regular,Menlo,Consolas,"Noto Sans Mono CJK SC",monospace; }
    .subtitle { fill:#94a3b8; font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,"Noto Sans Mono CJK SC",monospace; }
    .line { fill:#dbe5f1; font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,"Noto Sans Mono CJK SC",monospace; }
  </style>
  ${textLines}
</svg>`;
}

async function uploadSvg(env, settingsValue, token, svg, filename) {
  const settings = normalizeSettings(settingsValue);
  const endpoint = resolvedEndpoint(settings, env);
  if (!endpoint) throw new Error('图床上传地址未配置');
  const uploadUrl = new URL(endpoint);
  uploadUrl.searchParams.set('returnFormat', 'full');
  uploadUrl.searchParams.set('autoRetry', 'false');
  if (settings.upload_channel) uploadUrl.searchParams.set('uploadChannel', settings.upload_channel);
  if (settings.channel_name) uploadUrl.searchParams.set('channelName', settings.channel_name);
  if (settings.folder) uploadUrl.searchParams.set('uploadFolder', settings.folder);

  const form = new FormData();
  form.append('file', new Blob([svg], { type: 'image/svg+xml' }), filename);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(uploadUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      body: form,
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const finalEndpoint = validateUploadEndpoint(response.url || uploadUrl.toString());
  const body = await readResponseTextLimited(response, MAX_RESPONSE_BYTES);
  if (!response.ok) throw new Error(`图床返回 HTTP ${response.status}`);
  let data;
  try { data = JSON.parse(body); } catch (_) { throw new Error('图床返回了无效 JSON'); }
  const item = Array.isArray(data) ? data[0] : data;
  const rawUrl = String(item?.publicUrl || item?.src || '').trim();
  if (!rawUrl) throw new Error('图床响应中没有图片地址');
  return validatePublicImageUrl(new URL(rawUrl, finalEndpoint.origin).toString());
}

function normalizeSettings(input = {}) {
  const endpoint = String(input.endpoint || '').trim();
  const uploadChannel = String(input.upload_channel ?? DEFAULT_SETTINGS.upload_channel).trim().toLowerCase();
  return {
    enabled: parseBoolean(input.enabled, DEFAULT_SETTINGS.enabled),
    endpoint: endpoint ? validateUploadEndpoint(endpoint).toString() : '',
    upload_channel: CHANNELS.has(uploadChannel) ? uploadChannel : DEFAULT_SETTINGS.upload_channel,
    channel_name: String(input.channel_name || '').trim().slice(0, 80),
    folder: normalizeFolder(input.folder ?? DEFAULT_SETTINGS.folder),
  };
}

function pickSettings(body) {
  const out = {};
  for (const key of ['enabled', 'endpoint', 'upload_channel', 'channel_name', 'folder']) {
    if (Object.prototype.hasOwnProperty.call(body || {}, key)) out[key] = body[key];
  }
  return out;
}

function resolvedEndpoint(settings, env) {
  const value = String(env.NQ_IMGBED_URL || settings.endpoint || '').trim();
  return value ? validateUploadEndpoint(value).toString() : '';
}

export function validateUploadEndpoint(value) {
  let url;
  try { url = assertPublicHttpUrl(String(value || '').trim()); } catch (error) {
    throw new ApiError(400, `图床 API 地址无效：${error.message}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw new ApiError(400, '图床 API 必须使用无凭据、无自定义端口的公网 HTTPS 地址');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/upload')) throw new ApiError(400, 'CloudFlare-ImgBed 上传 API 地址必须以 /upload 结尾');
  url.pathname = path;
  url.search = '';
  return url;
}

function validatePublicImageUrl(value) {
  const url = assertPublicHttpUrl(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 2048) {
    throw new Error('图床返回的图片地址不安全');
  }
  return url.toString();
}

function normalizeFolder(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/').replace(/[?#\u0000-\u001f]/g, '');
  if (!raw) return '';
  const segments = raw.split('/').map((part) => part.trim()).filter(Boolean);
  if (segments.some((part) => part === '.' || part === '..')) throw new ApiError(400, '图床目录不能包含 . 或 ..');
  return segments.join('/').slice(0, 160);
}

function extractReportId(value) {
  try { return new URL(String(value || '')).pathname.split('/').filter(Boolean).pop() || ''; } catch (_) { return ''; }
}

function safeFilePart(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'report';
}

function safeUploadError(error) {
  if (error?.name === 'AbortError') return '上传超时';
  const message = String(error?.message || '上传失败').replace(/https?:\/\/\S+/gi, '[URL]').slice(0, 180);
  return message || '上传失败';
}

function visibleColumns(value) {
  let width = 0;
  for (const char of String(value || '')) {
    const cp = char.codePointAt(0);
    if (cp === 9) width += 4 - (width % 4);
    else if (isCombining(cp)) continue;
    else width += isWide(cp) ? 2 : 1;
  }
  return width;
}

function isCombining(cp) {
  return (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f);
}

function isWide(cp) {
  return cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  );
}

function ansiSegments(line) {
  const source = String(line || '');
  const matcher = /\u001b\[([0-9;]*)m/g;
  const state = { color: '#dbe5f1', bold: false };
  const output = [];
  let cursor = 0;
  const append = (text) => {
    if (!text) return;
    const previous = output[output.length - 1];
    if (previous && previous.color === state.color && previous.bold === state.bold) previous.text += text;
    else output.push({ text, color: state.color, bold: state.bold });
  };
  let match;
  while ((match = matcher.exec(source))) {
    append(source.slice(cursor, match.index));
    applyAnsiCodes(state, match[1]);
    cursor = matcher.lastIndex;
  }
  append(source.slice(cursor));
  return output;
}

function applyAnsiCodes(state, value) {
  const codes = String(value || '0').split(';').map((part) => Number(part || 0));
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    if (code === 0) { state.color = '#dbe5f1'; state.bold = false; }
    else if (code === 1) state.bold = true;
    else if (code === 22) state.bold = false;
    else if (code === 39) state.color = '#dbe5f1';
    else if (ANSI_COLORS[code]) state.color = ANSI_COLORS[code];
    else if (code === 38 && codes[index + 1] === 5 && Number.isInteger(codes[index + 2])) {
      state.color = ansi256Color(codes[index + 2]);
      index += 2;
    } else if (code === 38 && codes[index + 1] === 2 && codes.slice(index + 2, index + 5).every(Number.isFinite)) {
      const [r, g, b] = codes.slice(index + 2, index + 5).map((item) => Math.max(0, Math.min(255, item)));
      state.color = `rgb(${r},${g},${b})`;
      index += 4;
    }
  }
}

function ansi256Color(value) {
  const index = Math.max(0, Math.min(255, Number(value) || 0));
  if (index < 8) return ['#111827', '#f87171', '#86efac', '#fde047', '#93c5fd', '#d8b4fe', '#67e8f9', '#e5e7eb'][index];
  if (index < 16) return ['#94a3b8', '#fca5a5', '#bbf7d0', '#fef08a', '#bfdbfe', '#e9d5ff', '#a5f3fc', '#f8fafc'][index - 8];
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level},${level},${level})`;
  }
  const cube = index - 16;
  const channel = (part) => part === 0 ? 0 : 55 + part * 40;
  const r = channel(Math.floor(cube / 36));
  const g = channel(Math.floor((cube % 36) / 6));
  const b = channel(cube % 6);
  return `rgb(${r},${g},${b})`;
}

function xmlEscape(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function readResponseTextLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('图床响应过大');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('图床响应过大');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function readStoredSettings(env) {
  if (!env.DB) return { ...DEFAULT_SETTINGS };
  const raw = await getMeta(env, SETTINGS_KEY).catch(() => null);
  try { return normalizeSettings(raw ? JSON.parse(raw) : DEFAULT_SETTINGS); } catch (_) { return { ...DEFAULT_SETTINGS }; }
}

async function readStoredToken(env) {
  if (!env.DB) return '';
  const raw = String(await getMeta(env, TOKEN_KEY).catch(() => '') || '').trim();
  if (!raw) return '';
  if (!raw.startsWith(SECRET_PREFIX)) return '';
  try { return await decryptSecret(raw, env); } catch (_) { return ''; }
}

async function getMeta(env, key) {
  const row = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?').bind(key).first();
  return row?.value ?? null;
}

async function setMeta(env, key, value) {
  await env.DB.prepare('INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, String(value), nowSec()).run();
}

async function encryptSecret(secret, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: SECRET_CONTEXT },
    await importSecretKey(secretKeyMaterials(env)[0], ['encrypt']),
    new TextEncoder().encode(secret),
  ));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv, 0);
  combined.set(encrypted, iv.length);
  return SECRET_PREFIX + bytesToBase64(combined);
}

async function decryptSecret(payload, env) {
  const combined = base64ToBytes(payload.slice(SECRET_PREFIX.length));
  if (combined.length <= 12) throw new Error('图床 API Token 密文无效');
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);
  let lastError;
  for (const material of secretKeyMaterials(env, false)) {
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: SECRET_CONTEXT },
        await importSecretKey(material, ['decrypt']),
        encrypted,
      );
      return new TextDecoder().decode(plain);
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('无法解密图床 API Token');
}

function secretKeyMaterials(env, required = true) {
  const values = [...new Set([
    String(env.NQ_IMGBED_ENCRYPTION_KEY || '').trim(),
    String(env.ALERT_ENCRYPTION_KEY || '').trim(),
    String(env.TOTP_ENCRYPTION_KEY || '').trim(),
    String(env.ADMIN_PASSWORD || '').trim(),
    String(env.ADMIN_TOKEN || '').trim(),
  ].filter(Boolean))];
  if (required && !values.length) throw new ApiError(500, '保存图床 API Token 需要配置 ADMIN_PASSWORD、TOTP_ENCRYPTION_KEY 或 NQ_IMGBED_ENCRYPTION_KEY');
  return values;
}

async function importSecretKey(material, usages) {
  if (!material) throw new Error('缺少加密材料');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, usages);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
