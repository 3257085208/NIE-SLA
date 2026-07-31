import { ApiError } from './auth.js';
import { assertPublicHttpUrl, nowSec } from './utils.js';
import { sanitizeAnsiContent, stripAnsiSafe } from './nodequality.js';

const SETTINGS_KEY = 'nq_image_host_settings';
const TOKEN_KEY = 'nq_image_host_token';
const SECRET_PREFIX = 'enc:v1:';
const SECRET_CONTEXT = new TextEncoder().encode('NIE-SLA:nq-image-host-token:v1');
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_RENDER_LINES = 1400;
const MAX_RENDER_COLUMNS = 240;
const UPLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_SETTINGS = Object.freeze({
  endpoint: '',
});
const FIXED_UPLOAD_CHANNEL = 's3';

// Matches the xterm.js settings used by NodeQuality's own image export.
const TERMINAL_THEME = Object.freeze({
  foreground: '#f8dcc0',
  background: '#1d1d1e',
  normal: ['#050404', '#bd0013', '#4ab118', '#e7741e', '#0f4ac6', '#665993', '#70a598', '#f8dcc0'],
  bright: ['#4e7cbf', '#fc5f5a', '#9eff6e', '#efc11a', '#1997c6', '#9b5953', '#c8faf4', '#f6f5fb'],
});
const TERMINAL_CELL_WIDTH = 8.45;
const TERMINAL_LINE_HEIGHT = 17;
const TERMINAL_FONT_SIZE = 14;
const TERMINAL_PADDING = 20;
const TERMINAL_SCALE = 2;

async function resolveNodeQualityImageHost(env) {
  const endpointFromEnv = String(env.NQ_IMGBED_URL || '').trim();
  const tokenFromEnv = String(env.NQ_IMGBED_TOKEN || '').trim();
  const stored = endpointFromEnv ? DEFAULT_SETTINGS : await readStoredSettings(env);
  const storedToken = tokenFromEnv ? '' : await readStoredToken(env);
  const endpointValue = endpointFromEnv || stored.endpoint;
  const endpoint = endpointValue ? validateUploadEndpoint(endpointValue).toString() : '';
  const token = tokenFromEnv || storedToken;
  return {
    enabled: Boolean(endpoint && token),
    endpoint,
    api_token: token,
    channel_name: String(env.NQ_IMGBED_CHANNEL_NAME || '').trim().slice(0, 80),
  };
}

export async function uploadNodeQualityReportImages(env, normalized, options = {}) {
  if (!normalized?.report) return { normalized, status: { enabled: false, uploaded: 0, skipped: true } };
  const settings = await resolveNodeQualityImageHost(env);
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
      const svg = renderNodeQualitySvg(tab.content);
      const filename = `${agentId}-${reportId}-${safeFilePart(tab.id)}.svg`;
      const image = await uploadSvg(settings, svg, filename);
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

export function renderNodeQualitySvg(content) {
  const source = sanitizeAnsiContent(String(content || ''))
    .replace(/\t/g, '    ')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, (sequence) => sequence.endsWith('m') ? sequence : '');
  const originalLines = source.split('\n');
  const truncated = originalLines.length > MAX_RENDER_LINES;
  const lines = originalLines.slice(0, MAX_RENDER_LINES);
  if (truncated) lines.push(`... 报告过长，已截取前 ${MAX_RENDER_LINES} 行`);
  // NodeQuality resizes with spare cells, then crops them back to a symmetric
  // 20px margin before uploading. Emit the already-cropped dimensions.
  const columns = Math.min(MAX_RENDER_COLUMNS, Math.max(1, ...lines.map((line) => visibleColumns(stripAnsiSafe(line)))));
  const rows = Math.max(1, lines.length);
  const logicalWidth = columns * TERMINAL_CELL_WIDTH + TERMINAL_PADDING * 2;
  const logicalHeight = rows * TERMINAL_LINE_HEIGHT + TERMINAL_PADDING * 2;
  const width = Math.ceil(logicalWidth * TERMINAL_SCALE);
  const height = Math.ceil(logicalHeight * TERMINAL_SCALE);
  const state = defaultAnsiState();
  const renderedLines = lines.map((line, row) => renderTerminalLine(line, row, state)).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="NodeQuality terminal report">
  <rect width="100%" height="100%" fill="${TERMINAL_THEME.background}"/>
  <style>
    .cell { font-family:Consolas,"Noto Sans Mono CJK SC","Sarasa Mono SC","Courier New",monospace; font-size:${TERMINAL_FONT_SIZE}px; font-variant-ligatures:none; }
  </style>
  <g transform="scale(${TERMINAL_SCALE})">${renderedLines}</g>
</svg>`;
}

function renderTerminalLine(line, row, state) {
  const y = TERMINAL_PADDING + row * TERMINAL_LINE_HEIGHT;
  return ansiSegments(line, state).map((segment) => {
    const x = TERMINAL_PADDING + segment.column * TERMINAL_CELL_WIDTH;
    const width = Math.max(0, segment.columns * TERMINAL_CELL_WIDTH);
    const style = terminalSegmentStyle(segment);
    const background = style.background === TERMINAL_THEME.background || width === 0
      ? ''
      : `<rect x="${formatNumber(x)}" y="${formatNumber(y)}" width="${formatNumber(width)}" height="${TERMINAL_LINE_HEIGHT}" fill="${style.background}"/>`;
    const text = renderTerminalSegmentText(segment, x, y, style.foreground);
    return background + text;
  }).join('');
}

function renderTerminalSegmentText(segment, x, y, foreground) {
  if (segment.hidden) return '';
  const decorations = [segment.underline ? 'underline' : '', segment.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  const textAttributes = `${segment.bold ? ' font-weight="700"' : ''}${segment.italic ? ' font-style="italic"' : ''}${decorations ? ` text-decoration="${decorations}"` : ''}${segment.dim ? ' opacity="0.6"' : ''}`;
  const textParts = [];
  let plain = '';
  let plainColumn = 0;
  let column = 0;
  let braillePath = '';
  const flushPlain = () => {
    if (!plain) return;
    const textX = x + plainColumn * TERMINAL_CELL_WIDTH;
    textParts.push(`<text class="cell" x="${formatNumber(textX)}" y="${formatNumber(y + 13.4)}" fill="${foreground}"${textAttributes} xml:space="preserve">${xmlEscape(plain)}</text>`);
    plain = '';
  };
  for (const char of segment.text) {
    const cp = char.codePointAt(0);
    if (cp >= 0x2800 && cp <= 0x28ff) {
      flushPlain();
      braillePath += brailleSquarePath(cp - 0x2800, x + column * TERMINAL_CELL_WIDTH, y);
    } else {
      if (!plain) plainColumn = column;
      plain += char;
    }
    column += isWide(cp) ? 2 : 1;
  }
  flushPlain();
  if (braillePath) textParts.push(`<path data-nq-bar="square" fill="${foreground}"${segment.dim ? ' opacity="0.6"' : ''} d="${braillePath}"/>`);
  return textParts.join('');
}

function brailleSquarePath(bits, x, y) {
  const gap = 0.45;
  const size = 3.45;
  const left = x + 0.55;
  const top = y + 0.9;
  const positions = [
    [0, 0], [0, 1], [0, 2], [1, 0],
    [1, 1], [1, 2], [0, 3], [1, 3],
  ];
  let path = '';
  positions.forEach(([column, row], bit) => {
    if ((bits & (1 << bit)) === 0) return;
    const px = formatNumber(left + column * (size + gap));
    const py = formatNumber(top + row * (size + gap));
    path += `M${px} ${py}h${size}v${size}h-${size}z`;
  });
  return path;
}

async function uploadSvg(settings, svg, filename) {
  if (!settings.endpoint || !settings.api_token) throw new Error('图床上传配置不完整');
  const uploadUrl = new URL(settings.endpoint);
  uploadUrl.searchParams.set('returnFormat', 'full');
  uploadUrl.searchParams.set('autoRetry', 'false');
  uploadUrl.searchParams.set('serverCompress', 'false');
  uploadUrl.searchParams.set('uploadChannel', FIXED_UPLOAD_CHANNEL);
  if (settings.channel_name) uploadUrl.searchParams.set('channelName', settings.channel_name);

  const form = new FormData();
  form.append('file', new Blob([svg], { type: 'image/svg+xml' }), filename);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(uploadUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.api_token}`, accept: 'application/json' },
      body: form,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new ApiError(504, '图床上传超时，请检查所选上传渠道及其网络连接');
    }
    throw new ApiError(502, '无法连接图床上传 API，请确认地址可访问且没有发生跳转');
  } finally {
    clearTimeout(timer);
  }
  const finalEndpoint = validateUploadEndpoint(response.url || uploadUrl.toString());
  let body;
  try {
    body = await readResponseTextLimited(response, MAX_RESPONSE_BYTES);
  } catch (_) {
    throw new ApiError(502, '图床响应无法读取或超过大小限制');
  }
  if (!response.ok) throw imageHostHttpError(response.status);
  let data;
  try { data = JSON.parse(body); } catch (_) { throw new ApiError(502, '图床返回了无效 JSON'); }
  const item = Array.isArray(data) ? data[0] : data;
  const rawUrl = String(item?.publicUrl || item?.src || '').trim();
  if (!rawUrl) throw new ApiError(502, '图床响应中没有图片地址');
  try {
    return validatePublicImageUrl(new URL(rawUrl, finalEndpoint.origin).toString());
  } catch (_) {
    throw new ApiError(502, '图床返回的图片地址无效或不安全');
  }
}

function imageHostHttpError(statusValue) {
  const status = Math.max(0, Math.trunc(Number(statusValue) || 0));
  if (status >= 300 && status < 400) {
    return new ApiError(502, `图床上传 API 返回了不允许的重定向（HTTP ${status}）`);
  }
  if (status === 400 || status === 422) {
    return new ApiError(502, `图床拒绝上传（HTTP ${status}），请检查上传渠道、渠道名称及图床存储配置`);
  }
  if (status === 401) return new ApiError(502, '图床 API Token 无效或已过期（HTTP 401）');
  if (status === 403) return new ApiError(502, '图床 API Token 缺少 upload 权限（HTTP 403）');
  if (status === 404) return new ApiError(502, '图床上传 API 不存在（HTTP 404），地址应以 /upload 结尾');
  if (status === 408 || status === 504) return new ApiError(504, `图床上传超时（HTTP ${status}）`);
  if (status === 429) return new ApiError(503, '图床请求过于频繁（HTTP 429），请稍后重试');
  if (status >= 500) return new ApiError(502, `图床服务暂时不可用（HTTP ${status}）`);
  return new ApiError(502, `图床上传失败（HTTP ${status || '未知'}）`);
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

function defaultAnsiState() {
  return {
    foreground: null,
    background: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
    hidden: false,
    strike: false,
  };
}

function ansiSegments(line, state = defaultAnsiState()) {
  const source = String(line || '');
  const matcher = /\u001b\[([0-9;]*)m/g;
  const output = [];
  let column = 0;
  let cursor = 0;
  const append = (text) => {
    if (!text) return;
    const columns = visibleColumns(text);
    output.push({ text, column, columns, ...state });
    column += columns;
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
    if (code === 0) Object.assign(state, defaultAnsiState());
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4 || code === 21) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 8) state.hidden = true;
    else if (code === 9) state.strike = true;
    else if (code === 22) { state.bold = false; state.dim = false; }
    else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code === 28) state.hidden = false;
    else if (code === 29) state.strike = false;
    else if (code >= 30 && code <= 37) state.foreground = { palette: code - 30, bright: false };
    else if (code >= 90 && code <= 97) state.foreground = { palette: code - 90, bright: true };
    else if (code >= 40 && code <= 47) state.background = { palette: code - 40, bright: false };
    else if (code >= 100 && code <= 107) state.background = { palette: code - 100, bright: true };
    else if (code === 39) state.foreground = null;
    else if (code === 49) state.background = null;
    else if ((code === 38 || code === 48) && codes[index + 1] === 5 && Number.isInteger(codes[index + 2])) {
      state[code === 38 ? 'foreground' : 'background'] = { color: ansi256Color(codes[index + 2]) };
      index += 2;
    } else if ((code === 38 || code === 48) && codes[index + 1] === 2 && codes.slice(index + 2, index + 5).every(Number.isFinite)) {
      const [r, g, b] = codes.slice(index + 2, index + 5).map((item) => Math.max(0, Math.min(255, item)));
      state[code === 38 ? 'foreground' : 'background'] = { color: `rgb(${r},${g},${b})` };
      index += 4;
    }
  }
}

function terminalSegmentStyle(segment) {
  let foreground = resolveTerminalColor(segment.foreground, segment.bold, false);
  let background = resolveTerminalColor(segment.background, false, true);
  if (segment.inverse) [foreground, background] = [background, foreground];
  return { foreground, background };
}

function resolveTerminalColor(value, bold, background) {
  if (!value) return background ? TERMINAL_THEME.background : TERMINAL_THEME.foreground;
  if (value.color) return value.color;
  return (value.bright || (bold && !background) ? TERMINAL_THEME.bright : TERMINAL_THEME.normal)[value.palette];
}

function ansi256Color(value) {
  const index = Math.max(0, Math.min(255, Number(value) || 0));
  if (index < 8) return TERMINAL_THEME.normal[index];
  if (index < 16) return TERMINAL_THEME.bright[index - 8];
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

function formatNumber(value) {
  return Number(value.toFixed(2)).toString();
}

function xmlEscape(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function readResponseTextLimited(response, maxBytes) {
  return new TextDecoder().decode(await readResponseBytesLimited(response, maxBytes));
}

async function readResponseBytesLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('图床响应过大');
  if (!response.body) return new Uint8Array();
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
  return bytes;
}

async function readStoredSettings(env) {
  if (!env.DB) return { ...DEFAULT_SETTINGS };
  const raw = await getMeta(env, SETTINGS_KEY).catch(() => null);
  try {
    const value = raw ? JSON.parse(raw) : DEFAULT_SETTINGS;
    return {
      endpoint: String(value?.endpoint || '').trim(),
    };
  } catch (_) { return { ...DEFAULT_SETTINGS }; }
}

async function readStoredToken(env) {
  if (!env.DB) return '';
  const raw = String(await getMeta(env, TOKEN_KEY).catch(() => '') || '').trim();
  if (!raw) return '';
  if (!raw.startsWith(SECRET_PREFIX)) return '';
  try {
    const decrypted = await decryptSecret(raw, env);
    if (decrypted.needsMigration && primarySecretMaterial(env)) {
      await setMeta(env, TOKEN_KEY, await encryptSecret(decrypted.secret, env));
    }
    return decrypted.secret;
  } catch (_) { return ''; }
}

async function getMeta(env, key) {
  const row = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?').bind(key).first();
  return row?.value ?? null;
}

async function setMeta(env, key, value) {
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(key, String(value), Math.floor(Date.now() / 1000)).run();
}

export async function migrateNqImageHostEncryption(env) {
  if (!env.DB) return { total: 0, migrated: 0 };
  if (!primarySecretMaterial(env)) throw new Error('缺少 NQ_IMGBED_ENCRYPTION_KEY、ALERT_ENCRYPTION_KEY 或 TOTP_ENCRYPTION_KEY');
  const stored = String(await getMeta(env, TOKEN_KEY) || '').trim();
  if (!stored) return { total: 0, migrated: 0 };
  if (!stored.startsWith(SECRET_PREFIX)) throw new Error('旧版图床 Token 密文格式无效');
  const decrypted = await decryptSecret(stored, env);
  if (!decrypted.needsMigration) return { total: 1, migrated: 0 };
  await setMeta(env, TOKEN_KEY, await encryptSecret(decrypted.secret, env));
  return { total: 1, migrated: 1 };
}

async function encryptSecret(secret, env) {
  const material = primarySecretMaterial(env);
  if (!material) throw new Error('缺少长期图床 Token 加密材料');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: SECRET_CONTEXT },
    await importSecretKey(material, ['encrypt']),
    new TextEncoder().encode(secret),
  ));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv);
  combined.set(encrypted, iv.length);
  return SECRET_PREFIX + bytesToBase64(combined);
}

async function decryptSecret(payload, env) {
  const combined = base64ToBytes(payload.slice(SECRET_PREFIX.length));
  if (combined.length <= 12) throw new Error('图床 API Token 密文无效');
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);
  let lastError;
  for (const candidate of secretKeyMaterials(env, false)) {
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: SECRET_CONTEXT },
        await importSecretKey(candidate.material, ['decrypt']),
        encrypted,
      );
      return {
        secret: new TextDecoder().decode(plain),
        needsMigration: candidate.source !== 'primary',
      };
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('无法解密图床 API Token');
}

function secretKeyMaterials(env, required = true) {
  const candidates = [
    { material: primarySecretMaterial(env), source: 'primary' },
    { material: String(env.PREVIOUS_ENCRYPTION_KEY || '').trim(), source: 'previous' },
    { material: String(env.NQ_IMGBED_ENCRYPTION_KEY || '').trim(), source: 'legacy_nq' },
    { material: String(env.ALERT_ENCRYPTION_KEY || '').trim(), source: 'legacy_alert' },
    { material: String(env.TOTP_ENCRYPTION_KEY || '').trim(), source: 'legacy_totp' },
    { material: String(env.ADMIN_PASSWORD || '').trim(), source: 'legacy_admin_password' },
    { material: String(env.ADMIN_TOKEN || '').trim(), source: 'legacy_admin_token' },
  ].filter((candidate, index, all) => candidate.material
    && all.findIndex((entry) => entry.material === candidate.material) === index);
  if (required && !candidates.length) throw new ApiError(500, '缺少旧版图床 Token 的解密材料');
  return candidates;
}

function primarySecretMaterial(env) {
  return String(env.NQ_IMGBED_ENCRYPTION_KEY || env.ALERT_ENCRYPTION_KEY || env.TOTP_ENCRYPTION_KEY || '').trim();
}

async function importSecretKey(material, usages) {
  if (!material) throw new Error('缺少加密材料');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, usages);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
