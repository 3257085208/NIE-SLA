import { escapeHtml } from './html.js';
export { escapeHtml };

export function targetHasNodeQuality(target = {}) {
  return target?.type === 'tcp' && Boolean(target?.has_nq || target?.nq?.has_report);
}

function plainReportLine(raw) {
  return String(raw || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').trim();
}

export function trimReportAdFooter(value = '') {
  const text = String(value || '');
  const lines = text.split(/\r?\n/);
  const tailMarkers = [/今日IP检测量/, /总检测量/, /感谢使用xy系列脚本/, /报告链接/, /Report Link/];
  let cut = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = plainReportLine(lines[i]);
    if (tailMarkers.some((item) => item.test(line))) cut = i;
  }
  if (cut < 0) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = plainReportLine(lines[i]);
      if (line.startsWith('TERM environment variable not set.') || /^[A-Z][A-Z0-9.]{5,}$/.test(line)) {
        cut = i - 1;
        break;
      }
    }
  }
  const body = cut >= 0 ? lines.slice(0, cut + 1).join('\n') : text;
  const trimmed = body.replace(/\s+$/u, '');
  return cut >= 0 && cut + 1 < lines.length ? `${trimmed}\n` : trimmed;
}

export function nqTabTitle(tab = {}) {
  const id = String(tab.id || '').toLowerCase();
  if (tab.title) return String(tab.title);
  return ({ basic: '基本信息', ip: 'IP质量', network: '网络质量', route: '回程路由' })[id] || id || '报告';
}

export function renderNqAnsiHtml(content = '', wrapCharsArg = 0) {
  const source = String(content || '');
  const wrapChars = Number(wrapCharsArg) > 0 ? Number(wrapCharsArg) : 0;
  const sgr = /\u001b\[([0-9;]*)m/g;
  const colors = {
    30: '#111827', 31: '#ef4444', 32: '#65a30d', 33: '#eab308',
    34: '#2563eb', 35: '#c026d3', 36: '#0891b2', 37: '#f8fafc',
    90: '#6b7280', 91: '#f87171', 92: '#a3e635', 93: '#fde047',
    94: '#60a5fa', 95: '#e879f9', 96: '#22d3ee', 97: '#ffffff',
  };
  const backgrounds = {
    40: '#111827', 41: '#dc2626', 42: '#16a34a', 43: '#ca8a04',
    44: '#1d4ed8', 45: '#a21caf', 46: '#0891b2', 47: '#f8fafc',
  };
  let cursor = 0;
  let state = { color: '', background: '', bold: false, italic: false, underline: false };
  let html = '';
  let lineCols = 0;
  let lineLeading = 0;
  let lineStarted = false;
  const style = () => [
    state.color && `color:${state.color}`,
    state.background && `background-color:${state.background}`,
    state.bold && 'font-weight:700',
    state.italic && 'font-style:italic',
    state.underline && 'text-decoration:underline',
  ].filter(Boolean).join(';');
  const append = (value) => {
    if (!value) return;
    let text = value;
    if (wrapChars > 0) {
      let out = '';
      for (const ch of text) {
        if (ch === '\n') { lineCols = 0; lineLeading = 0; lineStarted = false; out += ch; continue; }
        const cols = nqCharCols(ch);
        if (!lineStarted && ch === ' ') lineLeading += 1;
        else lineStarted = true;
        const nextCols = ch === '\t' ? (Math.floor(lineCols / 8) + 1) * 8 : lineCols + cols;
        if (nextCols > wrapChars) {
          out += '\n' + ' '.repeat(lineLeading);
          lineCols = lineLeading + cols;
          lineStarted = true;
        } else {
          lineCols = nextCols;
        }
        out += ch;
      }
      text = out;
    }
    const safe = escapeHtml(text);
    html += style() ? `<span style="${style()}">${safe}</span>` : safe;
  };
  let match;
  while ((match = sgr.exec(source))) {
    append(source.slice(cursor, match.index));
    const codes = (match[1] || '0').split(';').map(Number).filter(Number.isFinite);
    for (const code of codes) {
      if (code === 0) state = { color: '', background: '', bold: false, italic: false, underline: false };
      else if (code === 1) state.bold = true;
      else if (code === 3) state.italic = true;
      else if (code === 4) state.underline = true;
      else if (code === 22) state.bold = false;
      else if (code === 23) state.italic = false;
      else if (code === 24) state.underline = false;
      else if (code === 39) state.color = '';
      else if (code === 49) state.background = '';
      else if (colors[code]) state.color = colors[code];
      else if (backgrounds[code]) state.background = backgrounds[code];
    }
    cursor = sgr.lastIndex;
  }
  append(source.slice(cursor));
  return html;
}

function stripNqAnsi(value = '') {
  return String(value || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function nqMediaHeader(lines) {
  const label = '服务商：';
  const line = lines.find((item) => stripNqAnsi(item).includes(label));
  if (!line) return { names: [], starts: [] };
  const plain = stripNqAnsi(line);
  const bodyStart = plain.indexOf(label) + label.length;
  const body = plain.slice(bodyStart);
  const names = [];
  const starts = [];
  const matcher = /\S+/g;
  let match;
  while ((match = matcher.exec(body))) {
    names.push(match[0]);
    starts.push(bodyStart + match.index);
  }
  return { names, starts };
}

function nqMediaRow(lines, label, starts) {
  const line = lines.find((item) => stripNqAnsi(item).includes(label));
  if (!line) return [];
  const plain = stripNqAnsi(line);
  const bodyStart = plain.indexOf(label) + label.length;
  const values = Array.from({ length: starts.length }, () => '');
  const tokens = [...plain.slice(bodyStart).matchAll(/\S+/g)];
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


function nqMediaStatusClass(value) {
  if (/失败|屏蔽|禁会员|阻断|中国/.test(value)) return 'danger';
  if (/DNS|部分|未知|仅自制|仅网页|仅APP/.test(value)) return 'warning';
  if (/解锁|可用/.test(value)) return 'success';
  return 'neutral';
}

function isNqMediaHeading(line) {
  return /^五、流媒体(?:服务|及AI服务)?解锁检测$/.test(stripNqAnsi(line).trim());
}

function nqCharCols(ch) {
  if (ch === '\t') return 8;
  const code = ch.codePointAt(0);
  if (
    code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (0x2e80 <= code && code <= 0xa4cf && code !== 0x303f) ||
    (0xac00 <= code && code <= 0xd7a3) ||
    (0xf900 <= code && code <= 0xfaff) ||
    (0xfe30 <= code && code <= 0xfe4f) ||
    (0xff00 <= code && code <= 0xff60) ||
    (0xffe0 <= code && code <= 0xffe6) ||
    (0x1f300 <= code && code <= 0x1faff))
  ) return 2;
  return 1;
}

function mobileNqWrapChars() {
  if (typeof window === 'undefined' || !window.innerWidth) return 0;
  if (window.innerWidth > 760) return 0;
  return Math.max(40, Math.floor((window.innerWidth - 24) / 6) - 2);
}

function renderNqMediaBlock(lines, wrapChars = 0) {
  const { names: providers, starts } = nqMediaHeader(lines);
  const statuses = nqMediaRow(lines, '状态：', starts);
  const regions = nqMediaRow(lines, '地区：', starts);
  const methods = nqMediaRow(lines, '方式：', starts);
  const columnCount = Math.max(providers.length, statuses.length, regions.length, methods.length);
  if (!columnCount) return renderNqAnsiHtml(lines.join('\n'), wrapChars);
  const cell = (value, className = '') => `<span class="nq-media-cell ${className}">${escapeHtml(value || '—')}</span>`;
  const row = (label, values, className = '') => [
    cell(label, 'nq-media-label'),
    ...Array.from({ length: columnCount }, (_, index) => cell(values[index], className)),
  ].join('');
  const statusCells = [
    cell('状态', 'nq-media-label'),
    ...Array.from({ length: columnCount }, (_, index) => {
      const value = statuses[index] || '—';
      return `<span class="nq-media-cell"><b class="nq-media-badge ${nqMediaStatusClass(value)}">${escapeHtml(value)}</b></span>`;
    }),
  ].join('');
  return `<span class="nq-media-block">
    <span class="nq-media-title">五、流媒体解锁检测</span>
    <span class="nq-media-scroll"><span class="nq-media-grid" style="--nq-media-cols:${columnCount};">
      ${row('服务商', providers, 'nq-media-head')}
      ${statusCells}
      ${row('地区', regions)}
      ${row('方式', methods)}
    </span></span>
  </span>`;
}

export function renderNqReportHtml(content = '') {
  const lines = String(content || '').split('\n');
  const wrapChars = mobileNqWrapChars();
  let cursor = 0;
  let html = '';
  while (cursor < lines.length) {
    const start = lines.findIndex((line, index) => index >= cursor && isNqMediaHeading(line));
    if (start < 0) break;
    const end = lines.findIndex((line, index) => index > start && stripNqAnsi(line).startsWith('六、邮局连通性及黑名单检测'));
    const mediaEnd = end < 0 ? lines.length : end;
    html += renderNqAnsiHtml(lines.slice(cursor, start).join('\n'), wrapChars);
    html += renderNqMediaBlock(lines.slice(start, mediaEnd), wrapChars);
    cursor = mediaEnd;
  }
  return html + renderNqAnsiHtml(lines.slice(cursor).join('\n'), wrapChars);
}

export function renderUnlockServicesReportHtml(services = []) {
  const rows = (Array.isArray(services) ? services : [])
    .map((service) => ({ ...(service || {}) }))
    .filter((service) => String(service.name || service.id || '').trim() && (service.status || service.region || service.method));
  if (!rows.length) return '';
  const providers = rows.map((service) => String(service.name || service.id || '—').trim());
  const statuses = rows.map((service) => String(service.status || '—').trim() || '—');
  const regions = rows.map((service) => {
    const region = String(service.region || '').replace(/^\[|\]$/g, '').trim();
    return region && !/^(?:null|none|-)$/i.test(region) ? `[${region}]` : '[]';
  });
  const methods = rows.map((service) => String(service.method || '—').trim() || '—');
  const content = [
    '五、流媒体服务解锁检测',
    `服务商： ${providers.join(' ')}`,
    `状态： ${statuses.join(' ')}`,
    `地区： ${regions.join(' ')}`,
    `方式： ${methods.join(' ')}`,
  ].join('\n');
  return `<pre class="nq-ansi">${renderNqReportHtml(content)}</pre>`;
}

function nqReportPre(lines, className = '') {
  if (!lines.length) return '';
  return `<pre class="nq-report-pre ${className}">${renderNqAnsiHtml(lines.join('\n'))}</pre>`;
}

function isNqSectionHeading(line) {
  return /^[一二三四五六七八九十]+、/.test(stripNqAnsi(line).trim());
}

function splitNqAnsiLineAt(line, visibleIndex) {
  const source = String(line || '');
  let rawIndex = 0;
  let visible = 0;
  let activeCodes = '';
  while (rawIndex < source.length && visible < visibleIndex) {
    const code = source.slice(rawIndex).match(/^\u001b\[[0-9;]*m/);
    if (code) {
      activeCodes += code[0];
      rawIndex += code[0].length;
      continue;
    }
    rawIndex += 1;
    visible += 1;
  }
  const body = `${activeCodes}${source.slice(rawIndex)}`
    .replace(/^((?:\u001b\[[0-9;]*m)*)\s+/, '$1');
  return { title: source.slice(0, rawIndex), body };
}

function nqSectionHeadingParts(line) {
  const plain = stripNqAnsi(line);
  const patterns = [
    /^(四、三网TCP大包延迟（.*?）)\s+(.+)$/,
    /^(六、国内测速)\s+(.+)$/,
    /^(七、国际互连)\s+(.+)$/,
  ];
  for (const pattern of patterns) {
    const match = plain.match(pattern);
    if (!match) continue;
    return splitNqAnsiLineAt(line, plain.length - match[2].length);
  }
  return { title: line, body: '' };
}

function splitNqSections(content = '') {
  const sections = [];
  let current = { title: '', lines: [] };
  for (const line of String(content || '').split('\n')) {
    if (isNqSectionHeading(line)) {
      if (current.title || current.lines.length) sections.push(current);
      const heading = nqSectionHeadingParts(line);
      current = { title: heading.title, lines: heading.body ? [heading.body] : [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.title || current.lines.length) sections.push(current);
  return sections;
}

export function renderNqNetworkReportHtml(content = '') {
  const sections = splitNqSections(content);
  return `<div class="nq-network-report">${sections.map((section) => {
    if (!section.title) {
      return `<div class="nq-report-intro nq-scroll-region">${nqReportPre(section.lines)}</div>`;
    }
    return `<section class="nq-network-section">
      <div class="nq-network-title">${renderNqAnsiHtml(section.title)}</div>
      <div class="nq-network-scroll nq-scroll-region">${nqReportPre(section.lines, 'nq-network-pre')}</div>
    </section>`;
  }).join('')}</div>`;
}

function parseNqRouteHop(line) {
  const plain = stripNqAnsi(line).trim();
  const match = plain.match(/^(\d+(?:-\d+)?)\s+(\d+(?:\.\d+)?ms)\s+(\S+)\s*(.*)$/);
  if (!match) return null;
  let rest = match[4].trim();
  let asn = '';
  let network = '';
  const asnMatch = rest.match(/^(AS\d+)\b\s*/);
  if (asnMatch) {
    asn = asnMatch[1];
    rest = rest.slice(asnMatch[0].length);
  }
  const networkMatch = rest.match(/^\[([^\]]+)]\s*/);
  if (networkMatch) {
    network = networkMatch[1];
    rest = rest.slice(networkMatch[0].length);
  }
  const latency = Number.parseFloat(match[2]);
  const latencyClass = latency >= 250 ? 'danger' : latency >= 150 ? 'warning' : 'success';
  return {
    hop: match[1],
    latency: match[2],
    latencyClass,
    ip: match[3],
    asn,
    network,
    location: rest,
  };
}

function renderNqRouteHops(lines) {
  const parsed = lines.map(parseNqRouteHop);
  if (!parsed.some(Boolean)) {
    return `<div class="nq-route-raw nq-scroll-region">${nqReportPre(lines)}</div>`;
  }
  return `<div class="nq-route-hops">${lines.map((line, index) => {
    const hop = parsed[index];
    if (!hop) return `<div class="nq-route-note">${renderNqAnsiHtml(line)}</div>`;
    return `<div class="nq-route-hop">
      <span class="nq-route-hop-number">${escapeHtml(hop.hop)}</span>
      <span class="nq-route-latency ${hop.latencyClass}">${escapeHtml(hop.latency)}</span>
      <span class="nq-route-ip">${escapeHtml(hop.ip)}</span>
      <span class="nq-route-asn">${escapeHtml(hop.asn || '—')}</span>
      <span class="nq-route-network">${escapeHtml(hop.network || '—')}</span>
      <span class="nq-route-location">${escapeHtml(hop.location || '—')}</span>
    </div>`;
  }).join('')}</div>`;
}

function isNqRouteHeading(line) {
  return /^\s*(?:北京|上海|广东|广州)\s+(?:电信|联通|移动)\s+.+?\s+->\s+.+?\s*$/.test(stripNqAnsi(line));
}

function isNqRoutePath(line) {
  return /^地理路径：/.test(stripNqAnsi(line).trim());
}

export function renderNqRouteReportHtml(content = '') {
  const lines = String(content || '').split('\n');
  const chunks = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const routeStart = lines.findIndex((line, index) => index >= cursor && isNqRouteHeading(line));
    if (routeStart < 0) {
      if (cursor < lines.length) chunks.push({ kind: 'plain', lines: lines.slice(cursor) });
      break;
    }
    if (routeStart > cursor) chunks.push({ kind: 'plain', lines: lines.slice(cursor, routeStart) });
    const nextRoute = lines.findIndex((line, index) => index > routeStart && isNqRouteHeading(line));
    const reportBreak = lines.findIndex((line, index) => index > routeStart && /^={20,}$/.test(stripNqAnsi(line).trim()));
    const candidates = [nextRoute, reportBreak].filter((index) => index >= 0);
    const end = candidates.length ? Math.min(...candidates) : lines.length;
    const blockLines = lines.slice(routeStart + 1, end);
    const pathIndex = blockLines.findIndex(isNqRoutePath);
    chunks.push({
      kind: 'route',
      title: lines[routeStart],
      path: pathIndex >= 0 ? blockLines[pathIndex] : '',
      hops: blockLines.filter((_, index) => index !== pathIndex),
    });
    cursor = end;
  }
  return `<div class="nq-route-report">${chunks.map((chunk) => {
    if (chunk.kind === 'plain') {
      return `<div class="nq-report-intro nq-scroll-region">${nqReportPre(chunk.lines)}</div>`;
    }
    return `<section class="nq-route-block">
      <div class="nq-route-title">${renderNqAnsiHtml(chunk.title)}</div>
      ${chunk.path ? `<div class="nq-route-path">${renderNqAnsiHtml(chunk.path)}</div>` : ''}
      ${renderNqRouteHops(chunk.hops)}
    </section>`;
  }).join('')}</div>`;
}

export function normalizeNqReportLink(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return '';
    if (!['nodequality.com', 'www.nodequality.com'].includes(url.hostname.toLowerCase())) return '';
    const match = url.pathname.match(/^\/r\/([A-Za-z0-9_-]{8,128})\/?$/);
    return match ? `https://nodequality.com/r/${match[1]}` : '';
  } catch (_) {
    return '';
  }
}

function normalizeNqImageProxyBase(value) {
  const path = String(value || '').trim().replace(/\/+$/, '');
  return /^\/api\/nq\/[^/?#]{1,256}\/image$/.test(path) ? path : '';
}

function normalizeNqImagePath(value) {
  const path = String(value || '').trim();
  return /^\/api\/nq\/[^/?#]{1,256}\/image\/[^/?#]{1,128}$/.test(path) ? path : '';
}

export function buildNqModalHtml(report, options = {}) {
  const tabs = Array.isArray(report?.tabs) ? report.tabs : [];
  const time = report?.report_time || '';
  const link = normalizeNqReportLink(report?.link);
  const name = report?.name || '';
  const imageProxyBase = normalizeNqImageProxyBase(report?.image_proxy_base);
  const modalTitle = String(options?.title || 'NodeQuality');
  const tabButtons = tabs.map((tab, index) => {
    const id = escapeHtml(tab.id || `tab-${index}`);
    const title = escapeHtml(nqTabTitle(tab));
    return `<button type="button" role="tab" id="nq-tab-${index}" aria-controls="nq-panel-${index}" aria-selected="${index === 0}" tabindex="${index === 0 ? '0' : '-1'}" class="nq-tab${index === 0 ? ' active' : ''}" data-nq-tab="${id}">${title}</button>`;
  }).join('');
  const panels = tabs.map((tab, index) => {
    const rawId = String(tab.id || `tab-${index}`).toLowerCase();
    const id = escapeHtml(rawId);
    const imageSrc = imageProxyBase
      ? `${imageProxyBase}/${encodeURIComponent(tab.id || `tab-${index}`)}`
      : normalizeNqImagePath(tab.image);
    if (tab.kind === 'image' && imageSrc) {
      const fallback = tab.content
        ? (rawId === 'network' ? renderNqNetworkReportHtml(tab.content) : rawId === 'route' ? renderNqRouteReportHtml(tab.content) : `<pre class="nq-ansi">${renderNqReportHtml(tab.content)}</pre>`)
        : '';
      return `<div class="nq-panel nq-image-panel${index === 0 ? ' active' : ''}" id="nq-panel-${index}" role="tabpanel" aria-labelledby="nq-tab-${index}" tabindex="0" data-nq-panel="${id}"${index === 0 ? '' : ' hidden'}><img class="nq-image" src="${escapeHtml(imageSrc)}" alt="${escapeHtml(nqTabTitle(tab))}" loading="lazy" referrerpolicy="no-referrer">${fallback ? `<div class="nq-image-fallback" hidden>${fallback}</div>` : ''}</div>`;
    }
    const content = rawId === 'network'
      ? renderNqNetworkReportHtml(tab.content || '')
      : rawId === 'route'
        ? renderNqRouteReportHtml(tab.content || '')
        : `<pre class="nq-ansi">${renderNqReportHtml(tab.content || '')}</pre>`;
    const layoutClass = rawId === 'network' || rawId === 'route' ? ` nq-${rawId}-panel` : '';
    return `<div class="nq-panel nq-ansi-panel${layoutClass}${index === 0 ? ' active' : ''}" id="nq-panel-${index}" role="tabpanel" aria-labelledby="nq-tab-${index}" tabindex="0" data-nq-panel="${id}"${index === 0 ? '' : ' hidden'}>${content}</div>`;
  }).join('');
  return `
    <div class="nq-modal-backdrop" data-nq-close>
      <div class="nq-modal" role="dialog" aria-modal="true" aria-label="NodeQuality 报告">
        <div class="nq-modal-head">
          <div>
            <strong>${escapeHtml(modalTitle)}</strong>
            <span>${escapeHtml(name)}</span>
          </div>
          <button type="button" class="nq-close" data-nq-close aria-label="关闭">×</button>
        </div>
        <div class="nq-modal-meta">
          <span>报告时间：${escapeHtml(time || '未知')}</span>
          ${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">打开原报告</a>` : ''}
        </div>
        <div class="nq-tabs" role="tablist" aria-label="报告章节">${tabButtons}</div>
        <div class="nq-panels">${panels || '<div class="nq-empty">暂无报告内容</div>'}</div>
      </div>
    </div>
  `;
}

export function bindNodeQualityModal(root) {
  root?.querySelectorAll('.nq-image').forEach((image) => {
    image.addEventListener('error', () => {
      const fallback = image.parentElement?.querySelector('.nq-image-fallback');
      if (!fallback) return;
      image.hidden = true;
      fallback.hidden = false;
      image.parentElement.classList.add('fallback-active');
    }, { once: true });
  });
  const tabs = [...(root?.querySelectorAll('.nq-tab') || [])];
  const activateTab = (tab, focus = false) => {
    if (!tab) return;
      const id = tab.dataset.nqTab;
      root.querySelectorAll('.nq-tab').forEach((item) => {
        const active = item === tab;
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', String(active));
        item.tabIndex = active ? 0 : -1;
      });
      root.querySelectorAll('.nq-panel').forEach((panel) => {
        const active = panel.dataset.nqPanel === id;
        panel.classList.toggle('active', active);
        panel.hidden = !active;
      });
      const panels = root.querySelector('.nq-panels');
      if (panels) {
        panels.scrollTop = 0;
        panels.scrollLeft = 0;
        panels.querySelectorAll('.nq-ansi').forEach((ansi) => {
          ansi.scrollTop = 0;
          ansi.scrollLeft = 0;
        });
        panels.querySelectorAll('.nq-ansi-panel, .nq-scroll-region').forEach((region) => {
          region.scrollLeft = 0;
        });
      }
      if (focus) tab.focus();
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab));
    tab.addEventListener('keydown', (event) => {
      let next = null;
      if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
      else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === 'Home') next = tabs[0];
      else if (event.key === 'End') next = tabs.at(-1);
      if (!next) return;
      event.preventDefault();
      activateTab(next, true);
    });
  });
  if (root && !root.nqFocusTrapBound) {
    root.nqFocusTrapBound = true;
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const focusable = [...root.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }
  root?.querySelector('.nq-close')?.focus();
}
