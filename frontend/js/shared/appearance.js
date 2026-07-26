export const DEFAULT_APPEARANCE = Object.freeze({
  site_name: '聶.NET',
  site_subtitle: '',
  hero_subtitle: '',
  page_title: '',
  favicon_url: '',
  brand_home_url: './',
  brand_logo_url: '',
  brand_logo_alt: '站点 Logo',
  brand_logo_height: 36,
  header_right_text: '',
  header_right_image_url: './assets/cloudflare.svg?v=20260719-official',
  header_right_image_alt: 'Cloudflare',
  header_right_image_width: 109,
  header_right_link: 'https://www.cloudflare.com/',
  header_right_mode: 'image',
  search_placeholder: '搜索服务、IP、域名或分组...',
  group_by_title: '分组方式',
  banner_normal: '所有系统运行正常',
  banner_down: '{count} 个服务离线',
  banner_degraded: '{count} 个服务数据延迟',
  banner_unknown: '{count} 个服务等待检查',
  incident_title: '故障记录',
  incident_empty: '暂无故障',
  incident_empty_detail: '暂无离线事件。',
  checks_title: '最近检查',
  checks_hint: '请选择服务以查看最近检查记录。',
  checks_empty: '请选择服务以查看最近检查记录。',
  checks_unselected: '未选择服务',
  chart_title: '响应时间',
  chart_unselected: '未选择服务',
  vps_details_label: 'VPS 详情',
  no_search_results: '没有匹配的服务。',
  checks_no_records: '暂无检查记录。',
  summary_total: '{count} 个服务',
  summary_up: '{count} 个正常',
  summary_down: '{count} 个离线',
  summary_degraded: '{count} 个延迟',
  summary_unknown: '{count} 个待检查',
  summary_latency: '平均延迟 {value}',
  summary_updated: '更新于 {value}',
  footer_text: '版权所有 © {site_name} 2026',
  footer_link_text: '',
  footer_link_url: '',
  accent_color: '#2ea36d',
  page_background: '#f4f8fc',
  surface_color: '#ffffff',
  show_header: true,
  show_banner: true,
  show_summary: true,
  show_search: true,
  show_group_by: true,
  show_incidents: true,
  show_chart: true,
  show_vps_details: true,
  show_checks: true,
  show_footer: true,
});

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function text(value, fallback, max = 160) {
  const out = String(value ?? '').trim().slice(0, max);
  return out || fallback;
}

function optionalText(raw, key, fallback, max = 160) {
  if (!hasOwn(raw, key)) return fallback;
  return String(raw[key] ?? '').trim().slice(0, max);
}

function safeUrl(value, fallback = '', { allowEmpty = false } = {}) {
  const out = String(value ?? '').trim().slice(0, 500);
  if (!out) return allowEmpty ? '' : fallback;
  if (/^(?:https:\/\/|\/(?!\/)|\.\.?\/)/i.test(out)) return out;
  return allowEmpty ? '' : fallback;
}

function optionalUrl(raw, key, fallback) {
  if (!hasOwn(raw, key)) return fallback;
  return safeUrl(raw[key], '', { allowEmpty: true });
}

function color(value, fallback) {
  const out = String(value ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(out) ? out : fallback;
}

function integer(raw, key, fallback, min, max) {
  if (!hasOwn(raw, key)) return fallback;
  const value = Number.parseInt(raw[key], 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function bool(raw, key, fallback) {
  if (!hasOwn(raw, key)) return fallback;
  const value = raw[key];
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function choice(value, allowed, fallback) {
  const out = String(value ?? '').trim().toLowerCase();
  return allowed.includes(out) ? out : fallback;
}

export function normalizeAppearance(input = {}, env = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const siteNameDefault = String(env.PUBLIC_SITE_NAME || DEFAULT_APPEARANCE.site_name);
  const d = { ...DEFAULT_APPEARANCE, site_name: siteNameDefault };
  return {
    site_name: text(raw.site_name, d.site_name, 80),
    site_subtitle: optionalText(raw, 'site_subtitle', d.site_subtitle, 120),
    hero_subtitle: optionalText(raw, 'hero_subtitle', d.hero_subtitle, 160),
    page_title: optionalText(raw, 'page_title', d.page_title, 120),
    favicon_url: optionalUrl(raw, 'favicon_url', d.favicon_url),
    brand_home_url: safeUrl(raw.brand_home_url, d.brand_home_url),
    brand_logo_url: optionalUrl(raw, 'brand_logo_url', d.brand_logo_url),
    brand_logo_alt: text(raw.brand_logo_alt, d.brand_logo_alt, 80),
    brand_logo_height: integer(raw, 'brand_logo_height', d.brand_logo_height, 20, 64),
    header_right_text: optionalText(raw, 'header_right_text', d.header_right_text, 120),
    header_right_image_url: optionalUrl(raw, 'header_right_image_url', d.header_right_image_url),
    header_right_image_alt: text(raw.header_right_image_alt, d.header_right_image_alt, 80),
    header_right_image_width: integer(raw, 'header_right_image_width', d.header_right_image_width, 40, 240),
    header_right_link: optionalUrl(raw, 'header_right_link', d.header_right_link),
    header_right_mode: choice(raw.header_right_mode, ['image', 'text', 'hidden'], d.header_right_mode),
    search_placeholder: text(raw.search_placeholder, d.search_placeholder, 120),
    group_by_title: text(raw.group_by_title, d.group_by_title, 40),
    banner_normal: text(raw.banner_normal, d.banner_normal, 120),
    banner_down: text(raw.banner_down, d.banner_down, 120),
    banner_degraded: text(raw.banner_degraded, d.banner_degraded, 120),
    banner_unknown: text(raw.banner_unknown, d.banner_unknown, 120),
    incident_title: text(raw.incident_title, d.incident_title, 80),
    incident_empty: text(raw.incident_empty, d.incident_empty, 80),
    incident_empty_detail: text(raw.incident_empty_detail, d.incident_empty_detail, 120),
    checks_title: text(raw.checks_title, d.checks_title, 80),
    checks_hint: text(raw.checks_hint, d.checks_hint, 120),
    checks_empty: text(raw.checks_empty, d.checks_empty, 120),
    checks_unselected: text(raw.checks_unselected, d.checks_unselected, 80),
    chart_title: text(raw.chart_title, d.chart_title, 80),
    chart_unselected: text(raw.chart_unselected, d.chart_unselected, 80),
    vps_details_label: text(raw.vps_details_label, d.vps_details_label, 40),
    no_search_results: text(raw.no_search_results, d.no_search_results, 120),
    checks_no_records: text(raw.checks_no_records, d.checks_no_records, 120),
    summary_total: text(raw.summary_total, d.summary_total, 80),
    summary_up: text(raw.summary_up, d.summary_up, 80),
    summary_down: text(raw.summary_down, d.summary_down, 80),
    summary_degraded: text(raw.summary_degraded, d.summary_degraded, 80),
    summary_unknown: text(raw.summary_unknown, d.summary_unknown, 80),
    summary_latency: text(raw.summary_latency, d.summary_latency, 80),
    summary_updated: text(raw.summary_updated, d.summary_updated, 80),
    footer_text: text(raw.footer_text, d.footer_text, 160),
    footer_link_text: optionalText(raw, 'footer_link_text', d.footer_link_text, 80),
    footer_link_url: optionalUrl(raw, 'footer_link_url', d.footer_link_url),
    accent_color: color(raw.accent_color, d.accent_color),
    page_background: color(raw.page_background, d.page_background),
    surface_color: color(raw.surface_color, d.surface_color),
    show_header: bool(raw, 'show_header', d.show_header),
    show_banner: bool(raw, 'show_banner', d.show_banner),
    show_summary: bool(raw, 'show_summary', d.show_summary),
    show_search: bool(raw, 'show_search', d.show_search),
    show_group_by: bool(raw, 'show_group_by', d.show_group_by),
    show_incidents: bool(raw, 'show_incidents', d.show_incidents),
    show_chart: bool(raw, 'show_chart', d.show_chart),
    show_vps_details: bool(raw, 'show_vps_details', d.show_vps_details),
    show_checks: bool(raw, 'show_checks', d.show_checks),
    show_footer: bool(raw, 'show_footer', d.show_footer),
  };
}
