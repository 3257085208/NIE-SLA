import { assertPublicHttpUrl } from './utils.js';

// NodeQuality report parsing and normalization for VPS targets.
const MAX_REPORT_CHARS = 120_000;
const TAB_ALIASES = {
  '基本信息': 'basic',
  '硬件': 'basic',
  '硬件质量': 'basic',
  'hq': 'basic',
  'hardware': 'basic',
  'ip质量': 'ip',
  'ip': 'ip',
  '网络质量': 'network',
  '网络': 'network',
  'network': 'network',
  '回程路由': 'route',
  '回程': 'route',
  'route': 'route',
  '路由': 'route',
};

export function normalizeNodeQualityReport(raw, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (raw == null || raw === '') {
    return { report: null, updatedAt: null, summary: null };
  }
  if (typeof raw === 'object') {
    return normalizeStructuredReport(raw, now);
  }
  const text = String(raw || '').trim();
  if (!text) return { report: null, updatedAt: null, summary: null };
  if (text.length > MAX_REPORT_CHARS) {
    throw new Error(`NodeQuality 报告过长（>${MAX_REPORT_CHARS} 字符）`);
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return normalizeStructuredReport(JSON.parse(text), now);
    } catch (_) {
      // fall through to markdown/tab parse
    }
  }
  const parsed = parseNodeQualityMarkdown(text);
  const reportTime = parsed.report_time || extractReportTime(text) || null;
  const link = safeReportLink(parsed.link || extractNodeQualityLink(text)) || null;
  const report = {
    version: 1,
    source: 'paste',
    report_time: reportTime,
    link,
    tabs: parsed.tabs,
    raw: text,
  };
  return {
    report: JSON.stringify(report),
    updatedAt: now,
    summary: publicNodeQualitySummary({ nq_report: JSON.stringify(report), nq_updated_at: now }),
  };
}

function normalizeStructuredReport(input, now) {
  let reportTime = String(input?.report_time || input?.time || extractReportTime(input?.raw || '') || '').trim() || null;
  const link = safeReportLink(input?.link || input?.url || extractNodeQualityLink(input?.raw || '')) || null;
  let tabs = Array.isArray(input?.tabs) ? input.tabs.map(normalizeTab).filter(Boolean) : [];
  if (!tabs.length && input?.raw) tabs = parseNodeQualityMarkdown(String(input.raw)).tabs;
  if (!tabs.length) {
    // Accept section maps: { basic, ip, network, route }
    for (const [key, value] of Object.entries(input || {})) {
      const id = TAB_ALIASES[String(key).toLowerCase()] || TAB_ALIASES[String(key)] || null;
      if (!id) continue;
      const tab = normalizeTab({ id, title: defaultTabTitle(id), content: value });
      if (tab) tabs.push(tab);
    }
  }
  if (!tabs.length && typeof input?.content === 'string') {
    tabs = [{ id: 'basic', title: '基本信息', kind: 'ansi', content: sanitizeAnsiContent(input.content) }];
  }
  if (!tabs.length) throw new Error('无法解析 NodeQuality 报告内容');
  if (!reportTime) {
    reportTime = tabs
      .map((tab) => tab.kind === 'ansi' ? extractReportTime(tab.content || '') : '')
      .find(Boolean) || null;
  }
  const report = {
    version: 1,
    source: String(input?.source || 'json'),
    report_time: reportTime,
    link,
    tabs,
    raw: String(input?.raw || '').slice(0, MAX_REPORT_CHARS) || undefined,
  };
  return {
    report: JSON.stringify(report),
    updatedAt: now,
    summary: publicNodeQualitySummary({ nq_report: JSON.stringify(report), nq_updated_at: now }),
  };
}

function normalizeTab(tab) {
  if (!tab || typeof tab !== 'object') return null;
  const id = normalizeTabId(tab.id || tab.key || tab.title || tab.name);
  if (!id) return null;
  const title = String(tab.title || tab.name || defaultTabTitle(id)).trim().slice(0, 32) || defaultTabTitle(id);
  const image = String(tab.image || tab.img || tab.src || '').trim();
  const content = String(tab.content || tab.text || tab.body || '').trim();
  if (image && isSafeImageUrl(image)) {
    return { id, title, kind: 'image', image: image.slice(0, 2048), content: content ? sanitizeAnsiContent(content).slice(0, 20_000) : undefined };
  }
  if (!content && !image) return null;
  return { id, title, kind: 'ansi', content: sanitizeAnsiContent(content).slice(0, 60_000) };
}

function normalizeTabId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (TAB_ALIASES[raw] || TAB_ALIASES[lower]) return TAB_ALIASES[raw] || TAB_ALIASES[lower];
  if (['basic', 'ip', 'network', 'route'].includes(lower)) return lower;
  if (/基本|硬件|hq/i.test(raw)) return 'basic';
  if (/ip/i.test(raw)) return 'ip';
  if (/网络|network/i.test(raw)) return 'network';
  if (/回程|路由|route/i.test(raw)) return 'route';
  return lower.replace(/[^a-z0-9_-]+/g, '-').slice(0, 24) || null;
}

function defaultTabTitle(id) {
  return ({ basic: '基本信息', ip: 'IP质量', network: '网络质量', route: '回程路由' })[id] || id;
}

export function parseNodeQualityMarkdown(text) {
  const source = String(text || '').replace(/\r\n/g, '\n');
  const tabs = [];
  // Format A: ::: tab-item TITLE ... :::. NodeQuality puts a standalone :::
  // between items, so slice from each header instead of relying on a fragile
  // lookahead that can consume the following item.
  const headers = [];
  const tabItemRe = /^[\t ]*:::[\t ]*tab-item[\t ]+([^\n]+?)[\t ]*$/gim;
  let match;
  while ((match = tabItemRe.exec(source))) headers.push({ title: match[1], start: match.index, end: tabItemRe.lastIndex });
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const next = headers[index + 1];
    let body = source.slice(header.end, next ? next.start : source.length);
    body = body.replace(/\n[\t ]*::::[\t ]*\s*$/i, '').replace(/\n[\t ]*:::[\t ]*\s*$/i, '').trim();
    const title = stripEmoji(header.title).trim();
    const ansi = extractAnsiBlock(body);
    // Prefer fenced ANSI/text content over any SVG/report links that appear inside the report body.
    // Image tabs are only used when the tab body is primarily a markdown/bare image (network/route).
    const image = ansi ? '' : extractMarkdownImage(body);
    const id = normalizeTabId(title) || `tab-${tabs.length + 1}`;
    const tabTitle = defaultTabTitle(id) === id ? (title || defaultTabTitle(id)) : defaultTabTitle(id);
    if (ansi) tabs.push({ id, title: tabTitle, kind: 'ansi', content: sanitizeAnsiContent(ansi) });
    else if (image) tabs.push({ id, title: tabTitle, kind: 'image', image });
    else if (body) tabs.push({ id, title: tabTitle, kind: 'ansi', content: sanitizeAnsiContent(body) });
  }
  if (tabs.length) {
    return {
      tabs,
      report_time: extractReportTime(source),
      link: extractNodeQualityLink(source),
    };
  }

  // Format B: plain multi-section NodeQuality paste with report links / images.
  const sections = splitPlainSections(source);
  for (const section of sections) {
    const id = normalizeTabId(section.title) || `tab-${tabs.length + 1}`;
    if (section.image) tabs.push({ id, title: defaultTabTitle(id), kind: 'image', image: section.image });
    else tabs.push({ id, title: defaultTabTitle(id), kind: 'ansi', content: sanitizeAnsiContent(section.content) });
  }
  if (!tabs.length && source.trim()) {
    tabs.push({ id: 'basic', title: '基本信息', kind: 'ansi', content: sanitizeAnsiContent(source) });
  }
  return {
    tabs,
    report_time: extractReportTime(source),
    link: extractNodeQualityLink(source),
  };
}

function splitPlainSections(source) {
  const lines = String(source || '').split('\n');
  const sections = [];
  let current = null;
  const push = () => {
    if (!current) return;
    const content = current.lines.join('\n').trim();
    const image = extractMarkdownImage(content) || extractBareImageUrl(content);
    if (content || image) sections.push({ title: current.title, content, image });
  };
  for (const line of lines) {
    const heading = line.match(/^(?:#{1,3}\s*)?(基本信息|IP质量|网络质量|回程路由|硬件质量|硬件信息)\s*$/i)
      || line.match(/^[\+\|#=\-]{3,}\s*(基本信息|IP质量|网络质量|回程路由)\s*[\+\|#=\-]{0,}$/i);
    if (heading) {
      push();
      current = { title: heading[1], lines: [] };
      continue;
    }
    if (!current) current = { title: '基本信息', lines: [] };
    current.lines.push(line);
  }
  push();
  return sections;
}

function extractAnsiBlock(body) {
  const fenced = String(body || '').match(/```(?:ansi|text|bash)?\n([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : '';
}

function extractMarkdownImage(body) {
  const md = String(body || '').match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i);
  if (md && isSafeImageUrl(md[1])) return md[1];
  return extractBareImageUrl(body);
}

function extractBareImageUrl(body) {
  const url = String(body || '').match(/https?:\/\/[^\s)"']+\.(?:png|jpe?g|webp|gif|svg)(?:\?[^\s)"']*)?/i);
  return url && isSafeImageUrl(url[0]) ? url[0] : '';
}

export function extractReportTime(text) {
  const value = String(text || '');
  const m = value.match(/报告时间[:：]\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\s*[A-Z]{2,5})?)/);
  return m ? m[1].trim() : '';
}

export function extractNodeQualityLink(text) {
  const value = String(text || '');
  const m = value.match(/https?:\/\/(?:www\.)?nodequality\.com\/r\/[A-Za-z0-9_-]+/i)
    || value.match(/\[NodeQuality[^\]]*\]\((https?:\/\/[^)\s]+)\)/i);
  if (!m) return '';
  const url = m[1] || m[0];
  return isSafeHttpUrl(url) ? url : '';
}

function isSafeHttpUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function safeReportLink(value) {
  return normalizeNodeQualityReportUrl(value);
}

export function normalizeNodeQualityReportUrl(value) {
  try {
    const url = assertPublicHttpUrl(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    if (!['nodequality.com', 'www.nodequality.com'].includes(url.hostname.toLowerCase())) return '';
    const match = url.pathname.match(/^\/r\/([A-Za-z0-9_-]{8,128})\/?$/);
    if (!match || url.search || url.hash) return '';
    return `https://nodequality.com/r/${match[1]}`;
  } catch (_) {
    return '';
  }
}

function isSafeImageUrl(value) {
  if (!isSafeHttpUrl(value)) return false;
  let u;
  try { u = assertPublicHttpUrl(value); } catch (_) { return false; }
  // Block obvious script-like payloads; allow common image hosts / report CDNs.
  return !/[<>"']/.test(value) && u.pathname.length < 1024;
}

// Keep SGR color codes for frontend rendering; drop OSC/other control sequences.
export function sanitizeAnsiContent(text) {
  return String(text || '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b(?!\[[0-9;?]*[ -/]*[@-~])/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f]/g, '')
    .replace(/\r/g, '');
}

export function stripAnsiSafe(text) {
  return String(text || '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b./g, '')
    .replace(/\r/g, '');
}

const NQ_MEDIA_PROVIDERS = new Map([
  ['tiktok', { id: 'tiktok', name: 'TikTok' }],
  ['disney+', { id: 'disney_plus', name: 'Disney+' }],
  ['disneyplus', { id: 'disney_plus', name: 'Disney+' }],
  ['netflix', { id: 'netflix', name: 'Netflix' }],
  ['youtube', { id: 'youtube', name: 'Youtube' }],
  ['amazonpv', { id: 'amazon_pv', name: 'AmazonPV' }],
  ['reddit', { id: 'reddit', name: 'Reddit' }],
  ['chatgpt', { id: 'chatgpt', name: 'ChatGPT' }],
]);

function nqMediaHeading(line) {
  return /^[五5]\s*[、.]\s*流媒体(?:服务|及AI服务)?解锁检测/.test(stripAnsiSafe(line).trim());
}

function nqMediaHeader(lines) {
  const line = lines.find((item) => /^服务商\s*[:：]/.test(stripAnsiSafe(item).trim()));
  if (!line) return { names: [], starts: [] };
  const plain = stripAnsiSafe(line);
  const match = plain.match(/^服务商\s*[:：]\s*/);
  const bodyStart = match ? match[0].length : 0;
  const body = plain.slice(bodyStart);
  const names = [];
  const starts = [];
  const matcher = /\S+/g;
  let m;
  while ((m = matcher.exec(body))) {
    names.push(m[0]);
    starts.push(bodyStart + m.index);
  }
  return { names, starts };
}

function nqMediaRow(lines, labelPattern, starts) {
  const line = lines.find((item) => labelPattern.test(stripAnsiSafe(item).trim()));
  if (!line) return [];
  const plain = stripAnsiSafe(line);
  const match = plain.match(labelPattern);
  const bodyStart = match ? match[0].length : 0;
  const body = plain.slice(bodyStart);
  const values = Array.from({ length: starts.length }, () => '');
  const tokens = [...body.matchAll(/\S+/g)];
  let previousColumn = -1;
  for (const token of tokens) {
    const absoluteStart = bodyStart + token.index;
    let bestColumn = -1;
    let bestDistance = Infinity;
    starts.forEach((start, index) => {
      if (index <= previousColumn) return;
      const distance = Math.abs(start - absoluteStart);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestColumn = index;
      }
    });
    if (bestColumn < 0) break;
    values[bestColumn] = token[0];
    previousColumn = bestColumn;
  }
  return values;
}

export function parseNqMediaServices(content = '') {
  const lines = String(content || '').replace(/\r/g, '').split('\n');
  const start = lines.findIndex((line) => nqMediaHeading(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^[六6]\s*[、.]/.test(stripAnsiSafe(line).trim()));
  const block = lines.slice(start, end < 0 ? lines.length : end);
  const { names, starts } = nqMediaHeader(block);
  if (!names.length || !starts.length) return [];
  const statuses = nqMediaRow(block, /^状态\s*[:：]/, starts);
  const regions = nqMediaRow(block, /^地区\s*[:：]/, starts);
  const methods = nqMediaRow(block, /^方式\s*[:：]/, starts);
  const count = Math.max(names.length, statuses.length, regions.length, methods.length);
  const services = [];
  for (let index = 0; index < count; index += 1) {
    const service = normalizeNqMediaService(names[index] || '', statuses[index] || '', regions[index] || '', methods[index] || '');
    if (service) services.push(service);
  }
  return services;
}

function normalizeNqMediaService(rawName, rawStatus, rawRegion, rawMethod) {
  const name = String(rawName || '').trim().slice(0, 40);
  const status = /^[-—]$/.test(String(rawStatus || '').trim()) ? '' : String(rawStatus || '').trim().slice(0, 80);
  const region = /^[-—]$/.test(String(rawRegion || '').trim()) ? '' : String(rawRegion || '').trim().slice(0, 40);
  const method = /^[-—]$/.test(String(rawMethod || '').trim()) ? '' : String(rawMethod || '').trim().slice(0, 40);
  if (!name || (!status && !region && !method)) return null;
  const key = name.toLowerCase().replace(/[^a-z0-9+]/g, '');
  const canonical = NQ_MEDIA_PROVIDERS.get(key);
  const id = String(canonical?.id || name.toLowerCase().replace(/[^a-z0-9_+-]/g, '_')).slice(0, 40);
  return { id, name: canonical?.name || name, status, region, method };
}

function nodeQualityReportTabs(value) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tabs)) return parsed.tabs;
    } catch (_) { }
    return parseNodeQualityMarkdown(value).tabs;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(value.tabs)) return value.tabs;
    return [];
  }
  return [];
}

export function nodeQualityUnlockData(target = {}) {
  const tabs = nodeQualityReportTabs(target?.nq_report);
  const ipTab = tabs.find((tab) => String(tab?.id || '').toLowerCase() === 'ip' || /IP质量/.test(String(tab?.title || '')));
  if (!ipTab) return null;
  const services = parseNqMediaServices(ipTab?.content || ipTab?.text || ipTab?.body || '');
  if (!services.length) return null;
  return {
    checked_at: Number(target?.nq_updated_at || 0) || null,
    source: 'NQ',
    services,
  };
}

function stripEmoji(text) {
  return String(text || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
}

export function publicNodeQualitySummary(target = {}) {
  const raw = target?.nq_report;
  if (!raw) return null;
  let report = null;
  try {
    report = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    // legacy plain text
    const reportTime = extractReportTime(raw);
    return {
      has_report: true,
      report_time: reportTime || null,
      updated_at: target?.nq_updated_at ? Number(target.nq_updated_at) : null,
      tabs: ['basic'],
      link: safeReportLink(extractNodeQualityLink(raw)) || null,
    };
  }
  if (!report || typeof report !== 'object') return null;
  const tabs = Array.isArray(report.tabs) ? report.tabs.map((tab) => tab?.id || tab?.title).filter(Boolean) : [];
  return {
    has_report: true,
    report_time: report.report_time || extractReportTime(report.raw || '') || null,
    updated_at: target?.nq_updated_at ? Number(target.nq_updated_at) : null,
    tabs,
    link: safeReportLink(report.link || extractNodeQualityLink(report.raw || '')) || null,
  };
}

export function publicNodeQualityReport(target = {}) {
  const raw = target?.nq_report;
  if (!raw) return null;
  try {
    const report = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!report || typeof report !== 'object') return null;
    const imageProxyBase = target.id ? `/api/nq/${encodeURIComponent(String(target.id))}/image` : null;
    return {
      ok: true,
      target_id: String(target.id || ''),
      name: String(target.name || ''),
      report_time: report.report_time || extractReportTime(report.raw || '') || null,
      updated_at: target?.nq_updated_at ? Number(target.nq_updated_at) : null,
      link: safeReportLink(report.link || extractNodeQualityLink(report.raw || '')) || null,
      image_proxy_base: imageProxyBase,
      tabs: Array.isArray(report.tabs) ? report.tabs.map((tab) => ({
        id: String(tab.id || ''),
        title: String(tab.title || defaultTabTitle(tab.id) || ''),
        kind: tab.kind === 'image' ? 'image' : 'ansi',
        content: tab.content ? sanitizeAnsiContent(tab.content || '') : undefined,
        image: tab.kind === 'image' && isSafeImageUrl(tab.image) && imageProxyBase
          ? `${imageProxyBase}/${encodeURIComponent(String(tab.id || ''))}`
          : undefined,
      })).filter((tab) => tab.id && (tab.content || tab.image)) : [],
    };
  } catch (_) {
    const text = String(raw || '');
    return {
      ok: true,
      target_id: String(target.id || ''),
      name: String(target.name || ''),
      report_time: extractReportTime(text) || null,
      updated_at: target?.nq_updated_at ? Number(target.nq_updated_at) : null,
      link: safeReportLink(extractNodeQualityLink(text)) || null,
      image_proxy_base: target.id ? `/api/nq/${encodeURIComponent(String(target.id))}/image` : null,
      tabs: [{ id: 'basic', title: '基本信息', kind: 'ansi', content: sanitizeAnsiContent(text) }],
    };
  }
}

export function nodeQualityImageSource(target = {}, tabIdValue = '') {
  const tabId = String(tabIdValue || '');
  if (!target?.nq_report || !tabId) return null;
  try {
    const report = typeof target.nq_report === 'string' ? JSON.parse(target.nq_report) : target.nq_report;
    const tab = Array.isArray(report?.tabs) ? report.tabs.find((item) => String(item?.id || '') === tabId) : null;
    return tab?.kind === 'image' && isSafeImageUrl(tab.image) ? String(tab.image) : null;
  } catch (_) {
    return null;
  }
}
