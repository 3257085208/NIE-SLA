export function targetHasNodeQuality(target = {}) {
  return target?.type === 'tcp' && Boolean(target?.has_nq || target?.nq?.has_report);
}

export function nqTabTitle(tab = {}) {
  const id = String(tab.id || '').toLowerCase();
  if (tab.title) return String(tab.title);
  return ({ basic: '基本信息', ip: 'IP质量', network: '网络质量', route: '回程路由' })[id] || id || '报告';
}

export function renderNqAnsiHtml(content = '') {
  const source = String(content || '');
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
  const style = () => [
    state.color && `color:${state.color}`,
    state.background && `background-color:${state.background}`,
    state.bold && 'font-weight:700',
    state.italic && 'font-style:italic',
    state.underline && 'text-decoration:underline',
  ].filter(Boolean).join(';');
  const append = (value) => {
    if (!value) return;
    const safe = escapeHtml(value);
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
  if (/解锁|可用/.test(value)) return 'success';
  if (/失败|屏蔽|禁会员|阻断/.test(value)) return 'danger';
  if (/DNS|部分|未知/.test(value)) return 'warning';
  return 'neutral';
}

function renderNqMediaBlock(lines) {
  const { names: providers, starts } = nqMediaHeader(lines);
  const statuses = nqMediaRow(lines, '状态：', starts);
  const regions = nqMediaRow(lines, '地区：', starts);
  const methods = nqMediaRow(lines, '方式：', starts);
  const columnCount = Math.max(providers.length, statuses.length, regions.length, methods.length);
  if (!columnCount) return renderNqAnsiHtml(lines.join('\n'));
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
    <span class="nq-media-title">五、流媒体及AI服务解锁检测</span>
    <span class="nq-media-scroll"><span class="nq-media-grid" style="grid-template-columns:58px repeat(${columnCount}, 68px);">
      ${row('服务商', providers, 'nq-media-head')}
      ${statusCells}
      ${row('地区', regions)}
      ${row('方式', methods)}
    </span></span>
  </span>`;
}

export function renderNqReportHtml(content = '') {
  const lines = String(content || '').split('\n');
  const heading = '五、流媒体及AI服务解锁检测';
  let cursor = 0;
  let html = '';
  while (cursor < lines.length) {
    const start = lines.findIndex((line, index) => index >= cursor && stripNqAnsi(line).includes(heading));
    if (start < 0) break;
    const end = lines.findIndex((line, index) => index > start && stripNqAnsi(line).startsWith('六、邮局连通性及黑名单检测'));
    if (end < 0) break;
    html += renderNqAnsiHtml(lines.slice(cursor, start).join('\n'));
    html += renderNqMediaBlock(lines.slice(start, end));
    cursor = end;
  }
  return html + renderNqAnsiHtml(lines.slice(cursor).join('\n'));
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildNqModalHtml(report) {
  const tabs = Array.isArray(report?.tabs) ? report.tabs : [];
  const time = report?.report_time || '';
  const link = report?.link || '';
  const name = report?.name || '';
  const tabButtons = tabs.map((tab, index) => {
    const id = escapeHtml(tab.id || `tab-${index}`);
    const title = escapeHtml(nqTabTitle(tab));
    return `<button type="button" class="nq-tab${index === 0 ? ' active' : ''}" data-nq-tab="${id}">${title}</button>`;
  }).join('');
  const panels = tabs.map((tab, index) => {
    const id = escapeHtml(tab.id || `tab-${index}`);
    if (tab.kind === 'image' && tab.image) {
      const imageSrc = report?.image_proxy_base
        ? `${String(report.image_proxy_base).replace(/\/+$/, '')}/${encodeURIComponent(tab.id || `tab-${index}`)}`
        : tab.image;
      return `<div class="nq-panel nq-image-panel${index === 0 ? ' active' : ''}" data-nq-panel="${id}"><img class="nq-image" src="${escapeHtml(imageSrc)}" data-nq-original="${escapeHtml(tab.image)}" alt="${escapeHtml(nqTabTitle(tab))}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></div>`;
    }
    return `<div class="nq-panel nq-ansi-panel${index === 0 ? ' active' : ''}" data-nq-panel="${id}"><pre class="nq-ansi">${renderNqReportHtml(tab.content || '')}</pre></div>`;
  }).join('');
  return `
    <div class="nq-modal-backdrop" data-nq-close>
      <div class="nq-modal" role="dialog" aria-modal="true" aria-label="NodeQuality 报告">
        <div class="nq-modal-head">
          <div>
            <strong>NodeQuality</strong>
            <span>${escapeHtml(name)}</span>
          </div>
          <button type="button" class="nq-close" data-nq-close aria-label="关闭">×</button>
        </div>
        <div class="nq-modal-meta">
          <span>报告时间：${escapeHtml(time || '未知')}</span>
          ${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">打开原报告</a>` : ''}
        </div>
        <div class="nq-tabs">${tabButtons}</div>
        <div class="nq-panels">${panels || '<div class="nq-empty">暂无报告内容</div>'}</div>
      </div>
    </div>
  `;
}
