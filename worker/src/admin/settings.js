// Admin sub-module: settings, meta, and exchange rates.
import { nowSec, clamp, parseBoolean, sha256Hex, assertPublicHttpUrl } from '../utils.js';
import { ApiError, safeJson } from '../auth.js';
import { getAdminPath, setAdminPath } from '../admin-path.js';

const EXCHANGE_RATE_TTL_SEC = 86400;
const EXCHANGE_RATE_RETRY_SEC = 3600;
export const SUPPORTED_CURRENCIES = new Set([
  'CNY', 'USD', 'EUR', 'GBP', 'JPY', 'HKD', 'TWD', 'SGD', 'KRW', 'AUD',
  'CAD', 'CHF', 'NZD', 'RUB', 'INR', 'BRL', 'MXN', 'THB', 'MYR', 'IDR',
  'PHP', 'VND', 'AED', 'TRY', 'PLN', 'SEK', 'NOK', 'DKK', 'CZK', 'ZAR',
]);

// ── Meta ─────────────────────────────────────────────────────────────────────

export async function getMeta(env, key) {
  const row = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(key).first();
  return row?.value ?? null;
}

export async function setMeta(env, key, value) {
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(key, String(value), nowSec()).run();
}

async function deleteMeta(env, key) {
  await env.DB.prepare(`DELETE FROM app_meta WHERE key = ?`).bind(key).run();
}

// ── Exchange rates ─────────────────────────────────────────────────────────

export async function fetchExchangeRates(env) {
  if (!env.DB) return null;
  const attemptedAt = nowSec();
  await setMeta(env, 'exchange_rates_attempted', String(attemptedAt)).catch(() => {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/CNY', {
      headers: { 'User-Agent': 'NIE-SLA/1.0' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.rates || Number(data.rates.CNY) !== 1) return null;
    await setMeta(env, 'exchange_rates', JSON.stringify(data.rates));
    await setMeta(env, 'exchange_rates_updated', String(nowSec()));
    return data.rates;
  } catch (_) { return null; }
  finally { clearTimeout(timer); }
}

export async function getExchangeRates(env) {
  try {
    const raw = await getMeta(env, 'exchange_rates');
    const updated = Number(await getMeta(env, 'exchange_rates_updated') || 0);
    const cached = raw ? JSON.parse(raw) : null;
    if (cached && updated >= nowSec() - EXCHANGE_RATE_TTL_SEC) return cached;

    const attempted = Number(await getMeta(env, 'exchange_rates_attempted') || 0);
    if (attempted < nowSec() - EXCHANGE_RATE_RETRY_SEC) {
      const refreshed = await fetchExchangeRates(env);
      if (refreshed) return refreshed;
    }
    return cached;
  } catch (_) { return null; }
}

export function normalizeCurrency(value, fallback = 'USD') {
  const aliases = { RMB: 'CNY', CNH: 'CNY' };
  const code = aliases[String(value || '').trim().toUpperCase()] || String(value || '').trim().toUpperCase();
  return SUPPORTED_CURRENCIES.has(code) ? code : fallback;
}

export function convertPriceToCny(amount, currency, rates) {
  const value = Number(amount);
  const code = normalizeCurrency(currency, '');
  const rate = Number(rates?.[code]);
  if (!Number.isFinite(value) || value < 0 || !code || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.round((value / rate) * 100) / 100;
}

// ── Settings ────────────────────────────────────────────────────────────────

export const DEFAULT_FRONTEND_APPEARANCE = Object.freeze({
  site_name: 'NIE-SLA', site_subtitle: '', hero_subtitle: '', page_title: '', favicon_url: '', brand_home_url: './',
  brand_logo_url: '', brand_logo_alt: '站点 Logo', brand_logo_height: 36,
  header_right_text: '', header_right_image_url: './assets/cloudflare.svg?v=20260719-official',
  header_right_image_alt: 'Cloudflare', header_right_image_width: 109, header_right_link: 'https://www.cloudflare.com/', header_right_mode: 'image',
  search_placeholder: '搜索服务、IP、域名或分组...', group_by_title: '分组方式',
  banner_normal: '所有系统运行正常', banner_down: '{count} 个服务离线', banner_degraded: '{count} 个服务数据延迟',
  banner_unknown: '{count} 个服务等待检查', incident_title: '故障记录', incident_empty: '暂无故障',
  incident_empty_detail: '暂无离线事件。', checks_title: '最近检查', checks_hint: '请选择服务以查看最近检查记录。',
  checks_empty: '请选择服务以查看最近检查记录。', checks_unselected: '未选择服务', chart_title: '响应时间',
  chart_unselected: '未选择服务',
  vps_details_label: 'VPS 详情', no_search_results: '没有匹配的服务。', checks_no_records: '暂无检查记录。',
  summary_total: '{count} 个服务', summary_up: '{count} 个正常', summary_down: '{count} 个离线',
  summary_degraded: '{count} 个延迟', summary_unknown: '{count} 个待检查', summary_latency: '平均延迟 {value}',
  summary_updated: '更新于 {value}', footer_text: '版权所有 © {site_name} 2026', footer_link_text: '', footer_link_url: '',
  accent_color: '#2ea36d', page_background: '#f4f8fc', surface_color: '#ffffff',
  show_header: true, show_banner: true, show_summary: true, show_search: true, show_group_by: true,
  show_incidents: true, show_chart: true, show_vps_details: true, show_checks: true, show_footer: true,
});

function appearanceText(value, fallback, max = 160) {
  const out = String(value ?? '').trim().slice(0, max);
  return out || fallback;
}

function appearanceOptionalText(raw, key, fallback, max = 160) {
  if (!hasOwn(raw, key)) return fallback;
  return String(raw[key] ?? '').trim().slice(0, max);
}

function appearanceUrl(value, fallback = '', allowEmpty = false) {
  const out = String(value ?? '').trim().slice(0, 500);
  if (!out) return allowEmpty ? '' : fallback;
  return /^(?:https:\/\/|\/(?!\/)|\.\.?\/)/i.test(out) ? out : (allowEmpty ? '' : fallback);
}

function appearanceOptionalUrl(raw, key, fallback) {
  if (!hasOwn(raw, key)) return fallback;
  return appearanceUrl(raw[key], '', true);
}

function appearanceColor(value, fallback) {
  const out = String(value ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(out) ? out : fallback;
}

function appearanceInteger(raw, key, fallback, min, max) {
  if (!hasOwn(raw, key)) return fallback;
  const value = Number.parseInt(raw[key], 10);
  return Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function appearanceBoolean(raw, key, fallback) {
  return hasOwn(raw, key) ? parseBoolean(raw[key], fallback) : fallback;
}

function appearanceChoice(value, allowed, fallback) {
  const out = String(value ?? '').trim().toLowerCase();
  return allowed.has(out) ? out : fallback;
}

export function normalizeFrontendAppearance(input = {}, env = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const d = { ...DEFAULT_FRONTEND_APPEARANCE, site_name: String(env.PUBLIC_SITE_NAME || DEFAULT_FRONTEND_APPEARANCE.site_name) };
  return {
    site_name: appearanceText(raw.site_name, d.site_name, 80),
    site_subtitle: appearanceOptionalText(raw, 'site_subtitle', d.site_subtitle, 120),
    hero_subtitle: appearanceOptionalText(raw, 'hero_subtitle', d.hero_subtitle, 160),
    page_title: appearanceOptionalText(raw, 'page_title', d.page_title, 120),
    favicon_url: appearanceOptionalUrl(raw, 'favicon_url', d.favicon_url),
    brand_home_url: appearanceUrl(raw.brand_home_url, d.brand_home_url),
    brand_logo_url: appearanceOptionalUrl(raw, 'brand_logo_url', d.brand_logo_url),
    brand_logo_alt: appearanceText(raw.brand_logo_alt, d.brand_logo_alt, 80),
    brand_logo_height: appearanceInteger(raw, 'brand_logo_height', d.brand_logo_height, 20, 64),
    header_right_text: appearanceOptionalText(raw, 'header_right_text', d.header_right_text, 120),
    header_right_image_url: appearanceOptionalUrl(raw, 'header_right_image_url', d.header_right_image_url),
    header_right_image_alt: appearanceText(raw.header_right_image_alt, d.header_right_image_alt, 80),
    header_right_image_width: appearanceInteger(raw, 'header_right_image_width', d.header_right_image_width, 40, 240),
    header_right_link: appearanceOptionalUrl(raw, 'header_right_link', d.header_right_link),
    header_right_mode: appearanceChoice(raw.header_right_mode, new Set(['image', 'text', 'hidden']), d.header_right_mode),
    search_placeholder: appearanceText(raw.search_placeholder, d.search_placeholder, 120),
    group_by_title: appearanceText(raw.group_by_title, d.group_by_title, 40),
    banner_normal: appearanceText(raw.banner_normal, d.banner_normal, 120),
    banner_down: appearanceText(raw.banner_down, d.banner_down, 120),
    banner_degraded: appearanceText(raw.banner_degraded, d.banner_degraded, 120),
    banner_unknown: appearanceText(raw.banner_unknown, d.banner_unknown, 120),
    incident_title: appearanceText(raw.incident_title, d.incident_title, 80),
    incident_empty: appearanceText(raw.incident_empty, d.incident_empty, 80),
    incident_empty_detail: appearanceText(raw.incident_empty_detail, d.incident_empty_detail, 120),
    checks_title: appearanceText(raw.checks_title, d.checks_title, 80),
    checks_hint: appearanceText(raw.checks_hint, d.checks_hint, 120),
    checks_empty: appearanceText(raw.checks_empty, d.checks_empty, 120),
    checks_unselected: appearanceText(raw.checks_unselected, d.checks_unselected, 80),
    chart_title: appearanceText(raw.chart_title, d.chart_title, 80),
    chart_unselected: appearanceText(raw.chart_unselected, d.chart_unselected, 80),
    vps_details_label: appearanceText(raw.vps_details_label, d.vps_details_label, 40),
    no_search_results: appearanceText(raw.no_search_results, d.no_search_results, 120),
    checks_no_records: appearanceText(raw.checks_no_records, d.checks_no_records, 120),
    summary_total: appearanceText(raw.summary_total, d.summary_total, 80),
    summary_up: appearanceText(raw.summary_up, d.summary_up, 80),
    summary_down: appearanceText(raw.summary_down, d.summary_down, 80),
    summary_degraded: appearanceText(raw.summary_degraded, d.summary_degraded, 80),
    summary_unknown: appearanceText(raw.summary_unknown, d.summary_unknown, 80),
    summary_latency: appearanceText(raw.summary_latency, d.summary_latency, 80),
    summary_updated: appearanceText(raw.summary_updated, d.summary_updated, 80),
    footer_text: appearanceText(raw.footer_text, d.footer_text, 160),
    footer_link_text: appearanceOptionalText(raw, 'footer_link_text', d.footer_link_text, 80),
    footer_link_url: appearanceOptionalUrl(raw, 'footer_link_url', d.footer_link_url),
    accent_color: appearanceColor(raw.accent_color, d.accent_color),
    page_background: appearanceColor(raw.page_background, d.page_background),
    surface_color: appearanceColor(raw.surface_color, d.surface_color),
    show_header: appearanceBoolean(raw, 'show_header', d.show_header),
    show_banner: appearanceBoolean(raw, 'show_banner', d.show_banner),
    show_summary: appearanceBoolean(raw, 'show_summary', d.show_summary),
    show_search: appearanceBoolean(raw, 'show_search', d.show_search),
    show_group_by: appearanceBoolean(raw, 'show_group_by', d.show_group_by),
    show_incidents: appearanceBoolean(raw, 'show_incidents', d.show_incidents),
    show_chart: appearanceBoolean(raw, 'show_chart', d.show_chart),
    show_vps_details: appearanceBoolean(raw, 'show_vps_details', d.show_vps_details),
    show_checks: appearanceBoolean(raw, 'show_checks', d.show_checks),
    show_footer: appearanceBoolean(raw, 'show_footer', d.show_footer),
  };
}

export function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

export function normalizeAgentPublicBase(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const url = assertPublicHttpUrl(raw);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Agent 连接域名必须使用无账号密码的 HTTPS');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Agent 连接域名只能填写域名 Origin，不能包含路径、参数或片段');
  }
  return url.origin;
}

export async function getAgentPublicBase(env) {
  try {
    return normalizeAgentPublicBase(await getMeta(env, 'agent_public_base'));
  } catch (_) {
    return '';
  }
}

export async function getPublicSettings(env, { includeAdmin = false } = {}) {
  let autoUpdate = null;
  let appearanceSaved = null;
  try { autoUpdate = await getMeta(env, 'agent_auto_update'); } catch (_) {}
  try { appearanceSaved = await getMeta(env, 'frontend_appearance'); } catch (_) {}
  let parsedAppearance = {};
  try { parsedAppearance = appearanceSaved ? JSON.parse(appearanceSaved) : {}; } catch (_) {}
  const { trafficPeriod } = await import('../traffic.js');
  const settings = {
    ok: true,
    frontend_theme: 'classic',
    agent_auto_update: parseBoolean(autoUpdate ?? env.AGENT_AUTO_UPDATE_DEFAULT, true),
    appearance: normalizeFrontendAppearance(parsedAppearance, env),
    traffic: trafficPeriod(env),
  };
  if (includeAdmin) {
    settings.admin_path = await getAdminPath(env);
    settings.agent_public_base = await getAgentPublicBase(env);
  }
  return settings;
}

export async function updatePublicSettings(request, env) {
  const body = await safeJson(request);
  if (hasOwn(body, 'agent_auto_update')) {
    await setMeta(env, 'agent_auto_update', parseBoolean(body.agent_auto_update, false) ? 'true' : 'false');
  }
  if (hasOwn(body, 'agent_public_base')) {
    let agentPublicBase = '';
    try {
      agentPublicBase = normalizeAgentPublicBase(body.agent_public_base);
    } catch (error) {
      throw new ApiError(400, String(error?.message || error));
    }
    if (agentPublicBase) await setMeta(env, 'agent_public_base', agentPublicBase);
    else await deleteMeta(env, 'agent_public_base');
  }
  if (hasOwn(body, 'appearance') || hasOwn(body, 'frontend_appearance')) {
    const appearance = normalizeFrontendAppearance(body.appearance ?? body.frontend_appearance, env);
    await setMeta(env, 'frontend_appearance', JSON.stringify(appearance));
  }
  if (hasOwn(body, 'admin_path')) await setAdminPath(env, body.admin_path);
  return getPublicSettings(env, { includeAdmin: true });
}

export async function getAgentUpdatePolicy(env, request = null) {
  const settings = await getPublicSettings(env);
  const release = await loadAgentRelease(env, request).catch((err) => {
    console.error('loadAgentRelease failed:', String(err?.message || err));
    return null;
  });
  return {
    ok: true,
    auto_update: settings.agent_auto_update,
    check_interval_sec: clamp(Number(env.AGENT_UPDATE_CHECK_SEC || 3600), 900, 86400),
    release_ready: Boolean(release),
    ...(release || {}),
  };
}

export async function loadAgentRelease(env, request = null) {
  const requestOrigin = request ? new URL(request.url).origin : '';
  const configuredDownloadBase = String(env.AGENT_DOWNLOAD_BASE || '').trim();
  const storedDownloadBase = await getAgentPublicBase(env);
  const downloadBase = String(configuredDownloadBase || storedDownloadBase || requestOrigin || 'https://status.example.com').trim().replace(/\/+$/, '');
  if (!downloadBase.startsWith('https://')) throw new Error('AGENT_DOWNLOAD_BASE must use HTTPS');
  const fetchMetadata = !configuredDownloadBase && typeof env.ASSETS?.fetch === 'function'
    ? (url) => env.ASSETS.fetch(new Request(url))
    : (url) => fetch(url, { cache: 'no-store' });
  const [versionResponse, manifestResponse] = await Promise.all([
    fetchMetadata(`${downloadBase}/bin/VERSION`),
    fetchMetadata(`${downloadBase}/bin/SHA256SUMS`),
  ]);
  if (!versionResponse.ok || !manifestResponse.ok) throw new Error('agent release metadata is unavailable');
  const version = String(await versionResponse.text()).trim();
  if (!/^v?\d+\.\d+\.\d+$/.test(version)) throw new Error('invalid agent release version');
  const manifest = await manifestResponse.text();
  if (!manifest.trim()) throw new Error('empty agent checksum manifest');
  return {
    latest_version: version.startsWith('v') ? version : `v${version}`,
    download_base: downloadBase,
    manifest_sha256: await sha256Hex(manifest),
  };
}
