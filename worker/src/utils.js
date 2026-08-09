

export const REGION_LABELS = {
  auto: '自动',
  apac: '亚太',
  weur: '西欧',
  eeur: '东欧',
  enam: '北美东部',
  wnam: '北美西部',
  sam: '南美',
  oc: '大洋洲',
  afr: '非洲',
  me: '中东',
};

export const ALLOWED_REGIONS = new Set(Object.keys(REGION_LABELS));
export const DEFAULT_TIMEOUT_MS = 3000;
export const DEFAULT_INTERVAL_SEC = 300;
export const MIN_INTERVAL_SEC = 300;
export const BUCKET_SEC = 300;
export const DEFAULT_STATUS_DAYS = 30;
export const STATUS_SNAPSHOT_SCHEMA = 'nstatus-status-snapshot-v1';
export const R2_STATE_SCHEMA = 'nstatus-r2-state-v1';
export const R2_HISTORY_SCHEMA = 'nstatus-r2-history-v1';
export const DEFAULT_PUBLIC_WORKER_URL = '';



export function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function retentionSeconds(env, key, defaultHours, minHours = 1, maxHours = 168) {
  return clamp(Number(env?.[key] || defaultHours), minHours, maxHours) * 3600;
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function shouldRunScheduledFollowups(probe) {
  return Number(probe?.count || 0) > 0;
}

export function lastPersistedCheckAt(target, latestStatus) {
  return Math.max(
    Number(target?.last_checked_at || 0),
    Number(latestStatus?.checked_at || 0),
  );
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (s === '1' || s === 'true') return true;
  if (s === '0' || s === 'false') return false;
  return fallback;
}



export function timezoneOffsetMin(env) {
  const raw = env?.TIMEZONE_OFFSET_MINUTES ?? env?.PUBLIC_TIMEZONE_OFFSET_MINUTES ?? 480;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 480;
  return clamp(n, -720, 840);
}

export function timezoneLabel(env) {
  const offset = timezoneOffsetMin(env);
  if (String(env?.TIMEZONE_LABEL || '').trim()) return String(env.TIMEZONE_LABEL).trim();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

export function dayFromSec(sec, env) {
  const d = new Date((Number(sec || nowSec()) + timezoneOffsetMin(env) * 60) * 1000);
  return d.toISOString().slice(0, 10);
}

function localDateParts(sec, env) {
  const d = new Date((Number(sec || nowSec()) + timezoneOffsetMin(env) * 60) * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthShift(year, month, delta) {
  const zeroBased = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}

function dateKey(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function trafficPeriodFromResetDay(env, resetDay = 1, ts = nowSec()) {
  const current = localDateParts(ts, env);
  const normalizedResetDay = clamp(Number(resetDay || 1), 1, 31);
  let start = { year: current.year, month: current.month };
  let startDay = Math.min(normalizedResetDay, daysInMonth(start.year, start.month));
  if (current.day < startDay) {
    start = monthShift(current.year, current.month, -1);
    startDay = Math.min(normalizedResetDay, daysInMonth(start.year, start.month));
  }
  const end = monthShift(start.year, start.month, 1);
  const endDay = Math.min(normalizedResetDay, daysInMonth(end.year, end.month));
  const startKey = dateKey(start.year, start.month, startDay);
  return {
    month: startKey,
    reset: normalizedResetDay === 1 ? 'calendar-month' : 'reset-day',
    reset_day: normalizedResetDay,
    period_start: startKey,
    period_end: dateKey(end.year, end.month, endDay),
  };
}

export function dateAddLocal(env, deltaDays) {
  const d = new Date((nowSec() + timezoneOffsetMin(env) * 60) * 1000);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

export function yesterdayLocal(env) {
  return dateAddLocal(env, -1);
}

export function dayStartSec(day, env) {
  return Math.floor(new Date(`${day}T00:00:00.000Z`).getTime() / 1000) - timezoneOffsetMin(env) * 60;
}

export function isPrivateHost(host) {
  const raw = String(host || '').trim().toLowerCase();
  if (!raw) return true;
  let hostname = raw;

  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);

  hostname = hostname.split('%')[0];
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === '0.0.0.0') return true;

  const v4mapped = hostname.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (v4mapped) return isPrivateHost(v4mapped[1]);

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    const parts = hostname.split('.').map((p) => Number(p));
    if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 0 && parts[2] === 0) return true;
    if (a === 192 && b === 0 && parts[2] === 2) return true;
    if (a === 192 && b === 88 && parts[2] === 99) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && parts[2] === 100) return true;
    if (a === 203 && b === 0 && parts[2] === 113) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (hostname.includes(':')) {
    const groups = expandIpv6(hostname);
    if (!groups) return true;
    if (groups.every((part, index) => part === 0 || (index === 7 && part === 1))) return true;
    if ((groups[0] & 0xfe00) === 0xfc00 || (groups[0] & 0xffc0) === 0xfe80) return true;
    if ((groups[0] & 0xff00) === 0xff00) return true;
    if (groups[0] === 0x0100 && groups.slice(1, 4).every(part => part === 0)) return true;
    if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;
    if (groups[0] === 0x2002) return true;
    if (groups[0] === 0x0064 && groups[1] === 0xff9b
      && (groups[2] === 1 || groups.slice(2, 6).every(part => part === 0))) return true;
    const mappedV4 = groups.slice(0, 5).every(part => part === 0) && groups[5] === 0xffff;
    const compatibleV4 = groups.slice(0, 6).every(part => part === 0);
    if (mappedV4 || compatibleV4) {
      const ipv4 = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
      return isPrivateHost(ipv4);
    }
    return false;
  }
  return false;
}

function expandIpv6(value) {
  let input = String(value || '').toLowerCase();
  const dotted = input.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const bytes = dotted[1].split('.').map(Number);
    if (bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
    input = `${input.slice(0, dotted.index)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  if ((input.match(/::/g) || []).length > 1) return null;
  const sides = input.split('::');
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  if (sides.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < (sides.length === 2 ? 1 : 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return groups.map(part => Number.parseInt(part, 16));
}

export function assertPublicHttpUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) throw new Error('URL 不能为空');
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    throw new Error('URL 格式无效');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('URL 必须使用 http:// 或 https://');
  }
  if (isPrivateHost(u.hostname)) {
    throw new Error('URL 不能指向私有或内部地址');
  }
  return u;
}

export async function fetchPublicHttpsWithValidatedRedirects(url, options = {}, fetchImpl = fetch, maxRedirects = 4) {
  let current = validatedPublicHttpsUrl(url);
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await fetchImpl(current.toString(), { ...options, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location || redirects === maxRedirects) throw new Error('too many or invalid redirects');
    current = validatedPublicHttpsUrl(new URL(location, current).toString());
  }
  throw new Error('too many redirects');
}

function validatedPublicHttpsUrl(value) {
  const url = assertPublicHttpUrl(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('URL 必须使用无凭据的 HTTPS');
  }
  return url;
}


export function sanitizeId(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const out = raw
    .replace(/^https?:\/\//, '').replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 96);
  return out || `id-${stableAsciiHash(raw || 'empty')}`;
}

function stableAsciiHash(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function sanitizeAgentId(value) {
  const out = String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return out || '';
}

export async function findEnabledAgentTarget(env, agentIdValue) {
  const raw = String(agentIdValue || '').trim();
  const canonical = sanitizeAgentId(raw);
  if (!canonical || !env?.DB) return null;
  const exact = await env.DB.prepare(`SELECT id, name, type, enabled FROM targets WHERE id = ? AND enabled = 1`).bind(raw).first().catch(() => null);
  if (exact) return exact;
  const canonicalTarget = await env.DB.prepare(`SELECT id, name, type, enabled FROM targets WHERE id = ? AND enabled = 1`).bind(canonical).first().catch(() => null);
  if (canonicalTarget) return canonicalTarget;
  const rows = await env.DB.prepare(`SELECT id, name, type, enabled FROM targets WHERE enabled = 1`).all().catch(() => ({ results: [] }));
  for (const row of rows.results || []) {
    if (sanitizeAgentId(row.id) === canonical) return row;
  }
  return null;
}

export function agentStatusFields(state, env = {}) {
  if (!state?.updated_at) return {};
  const updatedAt = Math.floor(new Date(state.updated_at).getTime() / 1000);
  const ageSec = Number.isFinite(updatedAt) && updatedAt > 0 ? Math.max(0, nowSec() - updatedAt) : null;
  const offlineAfterSec = clamp(Number(env.AGENT_OFFLINE_AFTER_SEC || 900), 120, 3600);
  return {
    status_source: 'agent',
    agent_online: ageSec != null && ageSec <= offlineAfterSec,
    agent_last_seen_sec: ageSec,
    agent_offline_after_sec: offlineAfterSec,
  };
}



export function normalizeTarget(input, allowPartial = false) {
  const type = String(input?.type || '').toLowerCase();
  if (!['tcp', 'http'].includes(type)) throw new Error('类型必须是 TCP 或 HTTP');
  const name = String(input?.name || '').trim();
  if (!name) throw new Error('名称不能为空');
  const groupName = String(input?.group_name || input?.group || 'Default').trim() || 'Default';
  const timeoutMs = clamp(Number(input?.timeout_ms || DEFAULT_TIMEOUT_MS), 500, 30000);
  const intervalSec = clamp(Number(input?.interval_sec || DEFAULT_INTERVAL_SEC), MIN_INTERVAL_SEC, 86400);
  const probeRegion = ALLOWED_REGIONS.has(String(input?.probe_region || 'auto')) ? String(input?.probe_region || 'auto') : 'auto';
  const noPublicIp = type === 'tcp' && parseBoolean(input?.no_public_ip, false);

  let targetHost = null, targetPort = null, url = null, method = null, expectedStatus = '';
  if (type === 'tcp') {
    targetHost = String(input?.target_host || input?.host || '').trim();
    targetPort = Number(input?.target_port || input?.port || 0);
    if (!noPublicIp && !targetHost) throw new Error('TCP 目标必须填写主机，或选择“无公网 IP”');
    if (!noPublicIp && (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535)) throw new Error('目标端口必须在 1 到 65535 之间');
    if (noPublicIp && (!targetHost || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535)) {
      targetHost = targetHost || null;
      targetPort = null;
    }
  }
  if (type === 'http') {
    url = String(input?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('URL 必须以 http:// 或 https:// 开头');
    assertPublicHttpUrl(url);
    method = String(input?.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) method = 'GET';
    expectedStatus = normalizeExpectedStatus(input?.expected_status || input?.expectedStatus || '200,201,202,204,301,302,307,308');
  }
  return { name, group_name: groupName, type, target_host: targetHost, target_port: targetPort, url, method, expected_status: expectedStatus, timeout_ms: timeoutMs, interval_sec: intervalSec, probe_region: probeRegion, no_public_ip: noPublicIp, enabled: input?.enabled === undefined ? true : parseBoolean(input.enabled, true) };
}

export function stableTargetId(input, normalized) {
  const explicit = String(input?.id || '').trim();
  if (explicit) return sanitizeId(explicit);
  const raw = normalized.type === 'http' ? `http-${normalized.name}-${normalized.url}` : `tcp-${normalized.name}-${normalized.target_host || 'agent'}-${normalized.target_port || 'local'}`;
  return sanitizeId(raw);
}



function normalizeExpectedStatus(value) {
  const nums = String(value || '').split(',').map(x => Number(String(x).trim())).filter(x => Number.isInteger(x) && x >= 100 && x <= 599);
  return [...new Set(nums)].join(',');
}

export function parseExpectedStatus(value) {
  if (!value) return [];
  return String(value).split(',').map(x => Number(x.trim())).filter(x => Number.isInteger(x));
}



export function publicMaskIps(env) {
  return parseBoolean(env.PUBLIC_MASK_IPS ?? env.MASK_IPS ?? env.PRIVACY_MASK_IPS ?? true, true);
}

export function publicHidePorts(env) {
  return parseBoolean(env.PUBLIC_HIDE_PORTS ?? true, true);
}

export function publicCachePrivacyVersion(env) {
  return [
    publicMaskIps(env) ? 'mask' : 'plain',
    publicHidePorts(env) ? 'noport' : 'port',
    parseBoolean(env?.PUBLIC_HIDE_URL_PATH ?? true, true) ? 'origin' : 'path',
    parseBoolean(env?.PUBLIC_STATUS_AGENT_DETAILS ?? false, false) ? 'agent' : 'noagent',
    parseBoolean(env?.PUBLIC_STATUS_UNLOCK_DETAILS ?? false, false) ? 'unlock' : 'nounlock',
    parseBoolean(env?.PUBLIC_STATUS_STORAGE_DETAILS ?? false, false) ? 'storage' : 'nostorage',
    'v3',
  ].join('-');
}

function maskIpLikeHost(host) {
  const value = String(host || '').trim();
  if (!value) return value;
  const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const nums = ipv4.slice(1).map(Number);
    if (nums.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return `${nums[0]}.${nums[1]}.*.*`;
  }
  if (/^[0-9a-f:.]+$/i.test(value) && value.includes(':')) {
    const parts = value.split(':').filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}:${parts[1]}::**`;
    if (parts.length === 1) return `${parts[0]}::**`;
  }
  return value;
}

export function publicHost(host, maskIps) {
  return maskIps ? maskIpLikeHost(host) : host;
}

export function publicUrl(value, env) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    u.username = ''; u.password = ''; u.search = ''; u.hash = '';
    if (publicHidePorts(env)) u.port = '';
    if (publicMaskIps(env)) u.hostname = maskIpLikeHost(u.hostname);
    if (parseBoolean(env?.PUBLIC_HIDE_URL_PATH ?? true, true)) return u.origin;
    return u.toString().replace(/\/$/, '');
  } catch (_) { return raw.replace(/[?#].*$/, ''); }
}

export function archiveUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    u.username = ''; u.password = ''; u.search = ''; u.hash = ''; u.port = '';
    return u.toString().replace(/\/$/, '');
  } catch (_) { return raw.replace(/[?#].*$/, ''); }
}

function publicTargetText(value, maskIps) {
  const raw = String(value || '').trim();
  if (!raw || !maskIps) return raw;
  const hostPort = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?$/);
  return hostPort ? maskIpLikeHost(hostPort[1]) : maskIpLikeHost(raw);
}

export function publicError(error, statusCode = null) {
  if (!error) return null;
  const msg = String(error);
  if (statusCode) return `Unexpected HTTP ${Number(statusCode)}`;
  if (/timeout|timed out|abort/i.test(msg)) return '连接超时';
  if (/dns|resolve|nxdomain|name not found/i.test(msg)) return 'DNS error';
  if (/refused|reset|unreachable|network|connect|socket|econn/i.test(msg)) return '连接失败';
  if (/certificate|tls|ssl/i.test(msg)) return 'TLS error';
  return '检查失败';
}

export function publicCheckPoint(point) {
  const { cf_colo, ...safePoint } = point || {};
  const missed = isMissedMonitorPoint(safePoint);
  return { ...safePoint, missed, region_label: REGION_LABELS[safePoint.probe_region || 'auto'] || safePoint.probe_region || '自动', error: missed ? null : publicError(safePoint.error, safePoint.status_code) };
}

export function sanitizePublicStatusPayload(payload, env) {
  if (!payload || typeof payload !== 'object') return payload;
  const maskIps = publicMaskIps(env);
  const hidePorts = publicHidePorts(env);
  const showAgentDetails = parseBoolean(env?.PUBLIC_STATUS_AGENT_DETAILS ?? false, false);
  const showUnlockDetails = parseBoolean(env?.PUBLIC_STATUS_UNLOCK_DETAILS ?? false, false);
  const showStorageDetails = parseBoolean(env?.PUBLIC_STATUS_STORAGE_DETAILS ?? false, false);
  const clean = { ...payload };
  clean.privacy = { ...(clean.privacy || {}), mask_ips: maskIps, hide_ports: hidePorts, hide_colo: true };
  if (Array.isArray(clean.targets)) clean.targets = clean.targets.map(row => sanitizePublicTarget(row, env, maskIps, hidePorts));
  if (Array.isArray(clean.incidents)) clean.incidents = clean.incidents.map(row => sanitizePublicTarget(row, env, maskIps, hidePorts));
  if (!showAgentDetails) delete clean.traffic;
  if (!showStorageDetails) delete clean.storage;
  if (!showUnlockDetails && Array.isArray(clean.targets)) {
    clean.targets = clean.targets.map((row) => {
      if (!row || typeof row !== 'object') return row;
      const target = { ...row };
      delete target.unlock;
      return target;
    });
  }
  return clean;
}

export function sanitizePublicAgentMetrics(metrics, env) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return metrics;
  if (parseBoolean(env?.PUBLIC_STATUS_AGENT_DETAILS ?? false, false)) return metrics;
  const clean = {
    schema: metrics.schema,
    agent_id: metrics.agent_id,
    agent_label: metrics.agent_label,
    updated_at: metrics.updated_at,
    cpu_percent: metrics.cpu_percent,
    memory: publicCapacityPercent(metrics.memory),
    load: metrics.load,
    disk: publicCapacityPercent(metrics.disk),
    net: publicNetworkRates(metrics.net),
  };
  return Object.fromEntries(Object.entries(clean).filter(([, value]) => value !== undefined && value !== null));
}

function publicCapacityPercent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const percent = Number(value.percent);
  return Number.isFinite(percent) ? { percent: clamp(percent, 0, 100) } : null;
}

function publicNetworkRates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const clean = {};
  for (const key of ['rx_bytes_sec', 'tx_bytes_sec']) {
    const number = Number(value[key]);
    if (Number.isFinite(number)) clean[key] = Math.max(0, number);
  }
  return Object.keys(clean).length ? clean : null;
}

export function sanitizePublicTarget(row, env, maskIps = publicMaskIps(env), hidePorts = publicHidePorts(env)) {
  if (!row || typeof row !== 'object') return row;
  const type = String(row.type || '').toLowerCase();
  const clean = { ...row };
  delete clean.sort_order;
  const displayHost = type === 'tcp' ? publicHost(clean.target_host, maskIps) : clean.target_host;
  const displayUrl = type === 'http' ? publicUrl(clean.url, env) : clean.url;
  const displayTarget = type === 'http' ? displayUrl : displayHost;
  if (type === 'tcp') { clean.target_host = displayHost; clean.target = displayTarget || ''; clean.target_display = displayTarget || ''; }
  else if (type === 'http') { clean.url = displayUrl; clean.target = displayTarget || ''; clean.target_display = displayTarget || ''; }
  else { if (clean.target_host) clean.target_host = publicHost(clean.target_host, maskIps); if (clean.target) clean.target = publicTargetText(clean.target, maskIps); if (clean.target_display) clean.target_display = publicTargetText(clean.target_display, maskIps); }
  if ('error' in clean) clean.error = publicError(clean.error, clean.status_code);
  if ('last_error' in clean) clean.last_error = publicError(clean.last_error, clean.status_code);
  delete clean.unlock_data;
  delete clean.nq_unlock_data;
  delete clean.nq_unlock_updated_at;
  if (!parseBoolean(env?.PUBLIC_STATUS_AGENT_DETAILS ?? false, false)) {
    delete clean.agent_version;
    delete clean.machine_uptime_sec;
    if ('agent_metrics' in clean) clean.agent_metrics = sanitizePublicAgentMetrics(clean.agent_metrics, env);
    for (const key of ['traffic_enabled', 'traffic_quota_gb', 'traffic_mode', 'traffic_reset_day', 'alert_traffic_remaining_percent', 'alert_traffic_remaining_gb']) delete clean[key];
  }
  clean.cf_colo = null; clean.start_colo = null; clean.recover_colo = null;
  clean.region_label = REGION_LABELS[clean.probe_region || 'auto'] || clean.probe_region || '自动';
  if (hidePorts) delete clean.target_port;
  return clean;
}



export function configuredAgents(env) {
  const raw = String(env.PUBLIC_AGENT_SERIES || env.AGENT_SERIES || '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.agents) ? parsed.agents : [];
      const agents = list.map(normalizeAgentConfig).filter(Boolean);
      if (agents.length) return agents;
    } catch (_) {}
  }
  return [{ id: sanitizeAgentId(env.DEFAULT_AGENT_ID || ''), label: String(env.DEFAULT_AGENT_LABEL || 'External Agent').trim() || 'External Agent', color: String(env.DEFAULT_AGENT_COLOR || '#2f7df6').trim() || '#2f7df6' }];
}

function normalizeAgentConfig(input) {
  const id = sanitizeAgentId(input?.id || input?.agent_id || '');
  if (!id) return null;
  return { id, label: String(input?.label || input?.name || id).trim().slice(0, 64) || id, color: String(input?.color || '#2f7df6').trim().slice(0, 32) || '#2f7df6' };
}

export function agentSeriesEnabled(env) {
  return parseBoolean(env.PUBLIC_ENABLE_AGENT_SERIES ?? env.ENABLE_AGENT_SERIES ?? true, true);
}



export function normalizeHistoryPoint(p) {
  const missed = isMissedMonitorPoint(p);
  const latency = p.latency_ms == null ? null : Number(p.latency_ms);
  const ok = missed ? 0 : normalizeOkInt(p.ok);
  const total = p.total == null ? 1 : Math.max(0, Number(p.total || 0));
  const okCount = p.ok_count == null ? ok : Math.max(0, Number(p.ok_count || 0));
  return {
    checked_at: Number(p.checked_at || p.t || 0), ok,
    latency_ms: Number.isFinite(latency) ? latency : null,
    status_code: p.status_code == null ? null : Number(p.status_code),
    error: p.error ? String(p.error).slice(0, 500) : null,
    probe_region: p.probe_region || 'auto', cf_colo: p.cf_colo || null,
    total: missed ? Math.max(1, total || 1) : total,
    ok_count: missed ? 0 : okCount,
    missed,
  };
}

function normalizeOkInt(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0 || value == null) return 0;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'ok', 'up'].includes(text)) return 1;
  return 0;
}

export function isMissedMonitorPoint(point) {
  if (!point || typeof point !== 'object') return false;
  if (point.missed === true || point.synthetic === true) return true;
  const error = String(point.error || '').trim().toLowerCase();
  return error === 'monitor missed this 5-minute check' || error.includes('monitor missed this 5-minute check');
}

export function buildMissedPoints(env, previous, bucketAt, okInt, probeRegion, maxBucketsOverride = null) {
  const previousAt = Number(previous?.checked_at || 0);
  if (!previousAt) return [];
  const previousBucket = Math.floor(previousAt / BUCKET_SEC) * BUCKET_SEC;
  if (dayFromSec(previousBucket, env) !== dayFromSec(bucketAt, env)) return [];
  const gapBuckets = Math.floor((bucketAt - previousBucket) / BUCKET_SEC) - 1;
  const maxMissed = clamp(
    maxBucketsOverride == null ? Number(env.MISSED_BACKFILL_MAX_BUCKETS || 144) : Number(maxBucketsOverride),
    0,
    288,
  );
  if (gapBuckets <= 0 || gapBuckets > maxMissed) return [];
  const out = [];
  for (let ts = previousBucket + BUCKET_SEC; ts < bucketAt; ts += BUCKET_SEC) {
    out.push({ checked_at: ts, ok: 0, latency_ms: null, status_code: null, error: 'monitor missed this 5-minute check', probe_region: probeRegion || 'auto', cf_colo: null, total: 1, ok_count: 0, bucket: true, missed: true });
  }
  return out;
}

export function buildOpenMissedPoints(env, previous, atSec = nowSec(), probeRegion = null) {
  const previousAt = Number(previous?.checked_at || 0);
  if (!previousAt) return [];
  const previousBucket = Math.floor(previousAt / BUCKET_SEC) * BUCKET_SEC;
  const nowValue = Number(atSec || nowSec());
  const currentBucket = Math.floor(nowValue / BUCKET_SEC) * BUCKET_SEC;
  const graceSec = clamp(Number(env.MISSED_BACKFILL_GRACE_SEC || 150), 0, BUCKET_SEC - 1);
  const virtualBucketAt = (nowValue - currentBucket) >= graceSec ? currentBucket + BUCKET_SEC : currentBucket;
  if (dayFromSec(previousBucket, env) !== dayFromSec(virtualBucketAt, env)) return [];
  const gapBuckets = Math.floor((virtualBucketAt - previousBucket) / BUCKET_SEC) - 1;
  const maxMissed = clamp(Number(env.MISSED_BACKFILL_MAX_BUCKETS || 144), 0, 288);
  if (gapBuckets <= 0 || gapBuckets > maxMissed) return [];
  const out = [];
  for (let ts = previousBucket + BUCKET_SEC; ts < virtualBucketAt; ts += BUCKET_SEC) {
    out.push({ checked_at: ts, ok: 0, latency_ms: null, status_code: null, error: 'monitor missed this 5-minute check', probe_region: probeRegion || previous?.probe_region || 'auto', cf_colo: null, total: 1, ok_count: 0, bucket: true, missed: true, synthetic: true });
  }
  return out;
}

export function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => { try { onTimeout?.(); } catch (_) {} reject(new Error(`${ms}ms 后超时`)); }, ms); })]).finally(() => clearTimeout(timer));
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
