import { ApiError, safeJson } from '../auth.js';
import { findEnabledAgentTarget, nowSec, sanitizeAgentId } from '../utils.js';
import { getMeta, setMeta } from './settings.js';

export const GEOIP_PROVIDERS = Object.freeze([
  { id: 'ip_sb', name: 'IP.SB', city: true },
  { id: 'cloudflare', name: 'Cloudflare', city: false },
  { id: 'ipip_net', name: 'IPIP.net', city: true },
  { id: 'custom', name: '自定义 JSON', city: true },
]);

export async function getGeoIpSettings(env, { includeAdmin = false } = {}) {
  const providerValue = await getMeta(env, 'geoip_provider').catch(() => null);
  const provider = GEOIP_PROVIDERS.some(item => item.id === providerValue) ? providerValue : 'ip_sb';
  const settings = {
    provider,
    refresh_interval_sec: 86400,
    providers: GEOIP_PROVIDERS,
  };
  if (includeAdmin) settings.custom_url = await getMeta(env, 'geoip_custom_url').catch(() => '') || '';
  else if (provider === 'custom') settings.custom_url = await getMeta(env, 'geoip_custom_url').catch(() => '') || '';
  return settings;
}

export async function updateGeoIpSettings(request, env) {
  const body = await safeJson(request, 16 * 1024);
  const provider = String(body?.provider || '').trim();
  if (!GEOIP_PROVIDERS.some(item => item.id === provider)) throw new ApiError(400, '不支持的 IP 定位服务商');
  let customUrl = String(body?.custom_url || '').trim();
  if (provider === 'custom') customUrl = validateCustomGeoIpUrl(customUrl);
  else customUrl = customUrl ? validateCustomGeoIpUrl(customUrl) : '';
  await setMeta(env, 'geoip_provider', provider);
  await setMeta(env, 'geoip_custom_url', customUrl);
  return { ok: true, ...(await getGeoIpSettings(env, { includeAdmin: true })) };
}

export async function getAgentRuntimeConfig(env) {
  return { ok: true, beta: true, geoip: await getGeoIpSettings(env) };
}

export async function submitAgentLocation(request, env, agentIdValue) {
  const agentId = sanitizeAgentId(agentIdValue || '');
  if (!agentId) throw new ApiError(400, '缺少 agent_id');
  const body = await safeJson(request, 32 * 1024);
  const provider = String(body?.provider || '').trim().slice(0, 32);
  if (!GEOIP_PROVIDERS.some(item => item.id === provider)) throw new ApiError(400, '无效的定位来源');
  const ipv4 = normalizeIp(body?.ipv4, 4);
  const ipv6 = normalizeIp(body?.ipv6, 6);
  if (!ipv4 && !ipv6) throw new ApiError(400, '定位结果至少需要一个有效的 IPv4 或 IPv6');
  const countryCode = String(body?.country_code || '').trim().toUpperCase();
  if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) throw new ApiError(400, 'country_code 必须是两位国家代码');
  const country = cleanText(body?.country, 80);
  const city = cleanText(body?.city, 80);
  const now = nowSec();

  const target = await findEnabledAgentTarget(env, agentIdValue);
  if (!target || target.type !== 'tcp') throw new ApiError(404, 'Agent 对应的 VPS 不存在或已停用');
  const location = countryCode || country;
  await env.DB.prepare(`UPDATE targets SET ipv4 = ?, ipv6 = ?, location = ?, city = ?, location_source = ?, location_updated_at = ?, updated_at = ? WHERE id = ?`)
    .bind(ipv4, ipv6, location, city, provider, now, now, target.id).run();
  await env.DB.prepare(`UPDATE nodes SET ipv4 = ?, ipv6 = ?, country_code = ?, country = ?, city = ?, location_source = ?, location_updated_at = ?, updated_at = ? WHERE id = ? OR id = ? OR legacy_target_id = ?`)
    .bind(ipv4, ipv6, countryCode, country, city, provider, now, now, target.id, agentId, target.id).run();
  return { ok: true, agent_id: agentId, location: { ipv4, ipv6, country_code: countryCode, country, city, source: provider, updated_at: now } };
}

export function validateCustomGeoIpUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw new ApiError(400, '自定义定位接口必须是有效的 HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new ApiError(400, '自定义定位接口必须使用不含账号密码的 HTTPS URL');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || isPrivateHostname(hostname)) throw new ApiError(400, '自定义定位接口不能指向本机、内网或云元数据地址');
  url.hash = '';
  return url.toString().slice(0, 2000);
}

function isPrivateHostname(hostname) {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === 'metadata.google.internal') return true;
  if (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe8') || hostname.startsWith('fe9') || hostname.startsWith('fea') || hostname.startsWith('feb')) return true;
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

function normalizeIp(value, family) {
  const text = String(value || '').trim().slice(0, 64);
  if (!text) return null;
  if (family === 4 && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(text) && text.split('.').every(part => Number(part) <= 255)) return text;
  if (family === 6 && text.includes(':') && /^[0-9a-f:]+$/i.test(text)) return text.toLowerCase();
  return null;
}

function cleanText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}
