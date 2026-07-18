import { escapeAttr, escapeHtml } from './js/shared/html.js';
import {
  billingCycleSuffix,
  daysUntil,
  estimateMonthlyCny,
  estimateRemainingCny,
  formatDateOnly,
  isLifetimeBilling,
  normalizeBillingCycle,
  targetExpiryValueHtml,
} from './js/shared/billing.js';
import {
  cssEscape,
  clampNumber,
  downsample,
  fmtBytes,
  fmtBytesPerSec,
  fmtSizeMB,
  fmtTime,
  formatDuration,
  formatGb,
  formatMachineUptime,
  minMax,
  pad,
  percent,
  timeAgoSec,
} from './js/shared/format.js';
import { trafficForTarget, trafficProgressHtml } from './js/shared/traffic.js';
import {
  buildLinePoints,
  chartColorToRgb,
  clampChartRange,
  countChartGaps,
  countMissedChecks,
  filterChecksByRange,
  hexToRgba,
  normalizeChartRows,
} from './js/shared/chart-data.js';
import {
  mountNodegetDetailChecksPanel,
  nodegetDetailPageHtml,
} from './js/themes/nodeget-detail.js';
import {
  nodegetAvatarHtml,
  nodegetCardMetaLine,
  nodegetFlagHtml,
  nodegetOsLogoHtml,
  nodegetStatusDotClass,
  nodegetTopbarToolsHtml,
} from './js/themes/nodeget-cards.js';

const $ = (sel) => document.querySelector(sel);
const FRONTEND_THEME_KEY = 'nstatus.frontendTheme';

requestAnimationFrame(() => document.body.classList.add('is-loaded'));

function initialFrontendTheme() {
  const bodyTheme = document.body?.dataset.frontendTheme;
  if (bodyTheme === 'cards' || bodyTheme === 'classic') return bodyTheme;

  try {
    const savedTheme = localStorage.getItem(FRONTEND_THEME_KEY);
    if (savedTheme === 'cards' || savedTheme === 'classic') return savedTheme;
  } catch (_) {}

  return 'cards';
}

const state = {
  apiBase: window.NSTATUS_API_BASE || '',
  data: null,
  filteredText: '',
  selectedId: null,
  selectedName: '',
  selectedTargetIntervalSec: 300,
  selectedRange: 'day',
  chart: null,
  chartZoomFullMin: null,
  chartZoomFullMax: null,
  chartHoverX: null,
  chartHoverY: null,
  chartHoverValue: null,
  chartPan: null,
  allChecks: [],
  checksLoadedHours: 0,
  dailyPoints: [],
  checksSource: '',
  checksPage: 1,
  checksPageSize: Number(localStorage.getItem('nstatus.pageSize') || 5),
  incidentsOpen: false,
  selectedMetric: 'latency',
  selectedMetricRange: '1h',
  targetMetrics: null,
  pingData: null,
  metricsCache: new Map(),
  pingsCache: new Map(),
  frontendTheme: initialFrontendTheme(),
  cardRegion: localStorage.getItem('nstatus.cardRegion') || 'all',
  cardDetailId: new URLSearchParams(window.location.search).get('target') || '',
  searchInTopbar: false,
  statusRequestSeq: 0,
  statusController: null,
  lastGroupsRenderKey: '',
};

const els = {
  brandName: $('#brandName'),
  globalBanner: $('#globalBanner'),
  subline: $('#subline'),
  summaryLine: $('#summaryLine'),
  serviceSearch: $('#serviceSearch'),
  groups: $('#groups'),
  inlineChartPanel: $('#inlineChartPanel'),
  chartCanvasWrap: $('#chartCanvasWrap'),
  chartReset: $('#chartReset'),
  chartTitle: $('#chartTitle'),
  chartMeta: $('#chartMeta'),
  chartServiceName: $('#chartServiceName'),
  chartAvg: $('#chartAvg'),
  checks: $('#checks'),
  checksHint: $('#checksHint'),
  checksPanel: $('.checks-panel'),
  pageSize: $('#pageSize'),
  prevPage: $('#prevPage'),
  nextPage: $('#nextPage'),
  pageInfo: $('#pageInfo'),
  incidentLogPanel: $('#incidentLogPanel'),
  incidentToggle: $('#incidentToggle'),
  incidentSummary: $('#incidentSummary'),
  incidentBody: $('#incidentBody'),
};

if (els.pageSize) {
  els.pageSize.value = String(state.checksPageSize);
}

if (els.incidentToggle) {
  els.incidentToggle.addEventListener('click', () => {
    state.incidentsOpen = !state.incidentsOpen;
    updateIncidentToggle();
  });
}

if (els.inlineChartPanel) {
  els.inlineChartPanel.addEventListener('click', (event) => {
    event.stopPropagation();
  });
}

if (els.chartReset) {
  els.chartReset.addEventListener('click', (event) => {
    event.stopPropagation();
    resetChartZoom();
  });
}

if (els.chartCanvasWrap) {
  els.chartCanvasWrap.addEventListener('wheel', handleChartWheel, { passive: false });
  els.chartCanvasWrap.addEventListener('pointerleave', () => {
    state.chartHoverX = null;
    state.chartHoverValue = null;
    state.chart?.update('none');
  });
  els.chartCanvasWrap.addEventListener('pointerdown', handleChartPointerDown);
  els.chartCanvasWrap.addEventListener('pointermove', handleChartPointerMove);
  els.chartCanvasWrap.addEventListener('pointerup', handleChartPointerUp);
  els.chartCanvasWrap.addEventListener('pointercancel', handleChartPointerUp);
  els.chartCanvasWrap.addEventListener('lostpointercapture', handleChartPointerUp);
  els.chartCanvasWrap.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    resetChartZoom();
  });
}

if (els.serviceSearch) {
  els.serviceSearch.addEventListener('input', () => {
    state.filteredText = els.serviceSearch.value.trim().toLowerCase();
    if (state.data) renderGroups(state.data);
  });
}

if (els.pageSize) {
  els.pageSize.addEventListener('change', () => {
    state.checksPageSize = Number(els.pageSize.value);
    state.checksPage = 1;
    localStorage.setItem('nstatus.pageSize', String(state.checksPageSize));
    renderChecksPage();
  });
}

if (els.prevPage) {
  els.prevPage.addEventListener('click', () => {
    if (state.checksPage > 1) {
      state.checksPage -= 1;
      renderChecksPage();
    }
  });
}

if (els.nextPage) {
  els.nextPage.addEventListener('click', () => {
    const totalPages = getTotalCheckPages();
    if (state.checksPage < totalPages) {
      state.checksPage += 1;
      renderChecksPage();
    }
  });
}

document.querySelectorAll('.metric-tab').forEach((btn) => {
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    document.querySelectorAll('.metric-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.selectedMetric = btn.dataset.metric;
    const isLatency = state.selectedMetric === 'latency';
    const rangeTabs = document.getElementById('rangeTabs');
    const metricRangeTabs = document.getElementById('metricRangeTabs');
    if (rangeTabs) rangeTabs.style.display = isLatency ? '' : 'none';
    if (metricRangeTabs) metricRangeTabs.style.display = isLatency ? 'none' : '';
    if (!isLatency) ensureTargetMetricsLoaded();
    updateChartForCurrentRange();
    renderVPSInfo();
  });
});

document.querySelectorAll('.metric-range-tab').forEach((btn) => {
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    document.querySelectorAll('.metric-range-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.selectedMetricRange = btn.dataset.range;
    ensureTargetMetricsLoaded();
    updateChartForCurrentRange();
  });
});

document.querySelectorAll('.range-tab').forEach((btn) => {
  btn.addEventListener('click', (event) => {
    event.stopPropagation();

    document.querySelectorAll('.range-tab').forEach(b => b.classList.remove('active'));

    btn.classList.add('active');
    state.selectedRange = btn.dataset.range;

    updateChartForCurrentRange();
    ensureChecksForSelectedRange();
  });
});

initChart();
window.addEventListener('nstatus:chartjs-ready', () => {
  if (!state.chart && window.Chart) {
    initChart();
    if (state.selectedId) updateChartForCurrentRange();
  }
});
loadStatus();
setInterval(loadStatus, 60_000);

function api(path) {
  return `${state.apiBase}${path}`;
}

async function loadStatus() {
  const requestSeq = ++state.statusRequestSeq;
  if (state.statusController) state.statusController.abort();
  const controller = new AbortController();
  state.statusController = controller;
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(api('/api/status?days=30'), {
      cache: 'no-store',
      signal: controller.signal,
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    if (requestSeq !== state.statusRequestSeq) return;
    state.data = data;
    render(data);
  } catch (err) {
    if (err.name === 'AbortError' || requestSeq !== state.statusRequestSeq) return;
    if (els.subline) {
      els.subline.textContent = `API 连接失败：${err.message}`;
    }

    if (els.globalBanner) {
      els.globalBanner.className = 'system-banner down';
      els.globalBanner.innerHTML = '<strong>API 连接失败</strong>';
    }

    if (els.summaryLine) {
      els.summaryLine.innerHTML = '<span>请检查 config.js、Worker 路由以及 D1、R2 绑定。</span>';
    }
  } finally {
    clearTimeout(timer);
    if (state.statusController === controller) state.statusController = null;
  }
}

function render(data) {
  applyFrontendTheme(data);

  if (els.brandName) {
    els.brandName.textContent = data.name || '聶.NET';
  }

  const targets = data.targets || [];
  const checked = targets.filter(targetHasStatus);
  const stale = checked.filter(t => isTargetStale(t));
  const fresh = checked.filter(t => !isTargetStale(t));
  const up = fresh.filter(targetIsUp).length;
  const down = checked.filter(t => !targetIsUp(t)).length;
  const unknown = targets.length - checked.length;
  const delayed = stale.filter(targetIsUp).length;
  const avg = avgLatency(fresh);

  let bannerText = '所有系统运行正常';
  let bannerClass = 'system-banner';

  if (down > 0) {
    bannerText = `${down} 个服务离线`;
    bannerClass += ' down';
  } else if (delayed > 0) {
    bannerText = `${delayed} 个服务数据延迟`;
    bannerClass += ' degraded';
  } else if (unknown > 0) {
    bannerText = `${unknown} 个服务等待检查`;
    bannerClass += ' degraded';
  }

  if (els.globalBanner) {
    els.globalBanner.className = bannerClass;
    els.globalBanner.innerHTML = `<strong>${bannerText}</strong>`;
  }

  if (els.subline) {
    els.subline.textContent = '';
  }

  if (els.summaryLine) {
    els.summaryLine.innerHTML = [
      `<span>${targets.length} 个服务</span>`,
      `<span>${up} 个正常</span>`,
      `<span>${down} 个离线</span>`,
      `<span>${delayed} 个延迟</span>`,
      `<span>${unknown} 个待检查</span>`,
      `<span>平均延迟 ${avg == null ? '-' : avg + ' ms'}</span>`,
      `<span>更新于 ${fmtTime(Date.now() / 1000, 'short')}</span>`,
    ].join('');
  }

  renderCardThemeExtras(data);
  renderIncidentLog(data);
  renderGroupsIfChanged(data);
}

function renderGroupsIfChanged(data) {
  const key = statusGroupsRenderKey(data);
  if (key === state.lastGroupsRenderKey) return;
  state.lastGroupsRenderKey = key;
  renderGroups(data);
}

function statusGroupsRenderKey(data) {
  return JSON.stringify({
    theme: state.frontendTheme,
    cardRegion: state.cardRegion,
    cardDetailId: state.cardDetailId,
    filter: state.filteredText,
    // Relative time labels only need periodic refresh when status data is unchanged.
    relativeBucket: Math.floor(Date.now() / 300000),
    days: data?.days || [],
    targets: data?.targets || [],
    summaries: data?.summaries || [],
  });
}

function applyFrontendTheme(data) {
  const raw = data?.frontend?.theme || data?.frontend_theme || 'classic';
  const theme = raw === 'cards' ? 'cards' : 'classic';
  state.frontendTheme = theme;
  document.body.dataset.frontendTheme = theme;
  try {
    localStorage.setItem(FRONTEND_THEME_KEY, theme);
  } catch (_) {}
  syncCardTopbar(theme === 'cards');
}

function syncCardTopbar(enabled) {
  const topbarInner = document.querySelector('.topbar-inner');
  const brand = document.querySelector('.brand');
  const main = document.querySelector('main.main');
  const searchRow = document.querySelector('.search-row');
  if (!topbarInner || !brand || !main || !searchRow) return;

  let avatar = brand.querySelector('.brand-avatar');
  let tools = topbarInner.querySelector('.card-top-tools');

  if (!enabled) {
    if (state.searchInTopbar) {
      const before = document.getElementById('incidentLogPanel') || document.getElementById('groups');
      main.insertBefore(searchRow, before);
      state.searchInTopbar = false;
    }
    avatar?.remove();
    tools?.remove();
  if (els.serviceSearch) els.serviceSearch.placeholder = '搜索服务、IP、域名或分组...';
    return;
  }

  if (!avatar) {
    avatar = document.createElement('span');
    avatar.className = 'brand-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.innerHTML = nodegetAvatarHtml();
    brand.insertBefore(avatar, brand.firstChild);
  }

  if (!tools) {
    tools = document.createElement('div');
    tools.className = 'card-top-tools';
    tools.innerHTML = nodegetTopbarToolsHtml();
  }

  if (!state.searchInTopbar) {
    topbarInner.appendChild(searchRow);
    state.searchInTopbar = true;
  }
  if (!tools.parentNode) topbarInner.appendChild(tools);
  if (els.serviceSearch) els.serviceSearch.placeholder = '搜索节点...';
}

function renderCardThemeExtras(data) {
  const main = document.querySelector('main.main');
  if (!main) return;

  let filter = document.getElementById('cardRegionBar');
  let sidebar = document.getElementById('cardSidebar');

  if (!filter) {
    filter = document.createElement('section');
    filter.id = 'cardRegionBar';
    filter.className = 'card-region-bar';
    main.insertBefore(filter, els.incidentLogPanel || els.groups || null);
  }

  if (!sidebar) {
    sidebar = document.createElement('aside');
    sidebar.id = 'cardSidebar';
    sidebar.className = 'card-sidebar';
    main.insertBefore(sidebar, filter);
  }

  const enabled = state.frontendTheme === 'cards';
  filter.hidden = !enabled;
  sidebar.hidden = !enabled;
  if (!enabled) return;

  const targets = data.targets || [];
  const regions = buildCardRegionBuckets(targets);
  if (state.cardRegion !== 'all' && !regions.some(r => r.code === state.cardRegion)) {
    state.cardRegion = 'all';
    localStorage.setItem('nstatus.cardRegion', state.cardRegion);
  }

  filter.innerHTML = [
    cardRegionButton({ code: 'all', flag: '', label: '全部', count: targets.length }),
    ...regions.map(cardRegionButton),
  ].join('');

  filter.querySelectorAll('button[data-region]').forEach((button) => {
    button.addEventListener('click', () => {
      state.cardRegion = button.dataset.region || 'all';
      localStorage.setItem('nstatus.cardRegion', state.cardRegion);
      renderCardThemeExtras(state.data || data);
      renderGroups(state.data || data);
    });
  });

  sidebar.innerHTML = renderCardSidebar(data);
}

function cardRegionButton(region) {
  const active = state.cardRegion === region.code;
  return `
    <button type="button" class="card-region-pill ${active ? 'active' : ''}" data-region="${escapeAttr(region.code)}">
      ${nodegetFlagHtml(region.code)}
      <strong>${escapeHtml(region.label)}</strong>
      <em>${Number(region.count || 0)}</em>
    </button>
  `;
}

function buildCardRegionBuckets(targets) {
  const byCode = new Map();
  for (const target of targets || []) {
    const code = targetRegionCode(target);
    if (!code || code === 'OTHER') continue;
    const existing = byCode.get(code) || { code, count: 0, ...regionMeta(code) };
    existing.count += 1;
    byCode.set(code, existing);
  }
  const order = new Map(['HK', 'US', 'DE', 'JP', 'CN', 'SG'].map((code, index) => [code, index]));
  return [...byCode.values()].sort((a, b) => (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99) || a.label.localeCompare(b.label));
}

function targetRegionCode(t) {
  const text = [
    t.location,
    t.region_label,
    t.probe_region,
    t.group_name,
    t.name,
    t.target_host,
    t.url,
  ].filter(Boolean).join(' ').toLowerCase();

  if (/(hong ?kong|\bhk\b|香港|hytron|cn\.hk)/i.test(text)) return 'HK';
  if (/(singapore|\bsg\b|新加坡)/i.test(text)) return 'SG';
  if (/(japan|tokyo|osaka|\bjp\b|日本|东京|大阪)/i.test(text)) return 'JP';
  if (/(united states|usa|america|los angeles|san jose|\bus\b|美国|洛杉矶|圣何塞)/i.test(text)) return 'US';
  if (/(germany|frankfurt|\bde\b|德国|法兰克福)/i.test(text)) return 'DE';
  if (/(china|mainland|\bcn\b|中国|大陆|aliyun|tencent|huawei|阿里云|腾讯|华为)/i.test(text)) return 'CN';
  return 'OTHER';
}

function regionMeta(code) {
  const map = {
    HK: { flag: '🇭🇰', label: 'HK' },
    US: { flag: '🇺🇸', label: 'US' },
    DE: { flag: '🇩🇪', label: 'DE' },
    JP: { flag: '🇯🇵', label: 'JP' },
    CN: { flag: '🇨🇳', label: 'CN' },
    SG: { flag: '🇸🇬', label: 'SG' },
  };
  return map[code] || { flag: '', label: code };
}

function renderCardSidebar(data) {
  const targets = data.targets || [];
  const checked = targets.filter(targetHasStatus);
  const online = checked.filter(t => targetIsUp(t) && !isTargetStale(t)).length;
  const expiring = targets.filter(t => {
    const days = daysUntil(t.expires_at);
    return days != null && days >= 0 && days <= 30;
  });
  const near = expiring.slice(0, 3);
  const monthlyCny = estimateMonthlyCny(targets);
  const remainingCny = estimateRemainingCny(targets);

  return `
    <div class="card-side-box value-box">
      <div class="side-title">
        <span class="side-icon">♧</span>
        <div><strong>剩余价值统计</strong><small>CNY</small></div>
      </div>
      <div class="value-panel">
        <span>折算月成本</span><strong>¥${monthlyCny.toFixed(2)}</strong>
        <span>剩余价值</span><strong>¥${remainingCny.toFixed(2)}</strong>
      </div>
    </div>
    <div class="card-side-box compact">
      <div class="side-title">
        <span class="side-icon">▤</span>
        <div><strong>在线 / 总节点</strong><b>${online} / ${targets.length}</b><small>当前可见节点</small></div>
      </div>
    </div>
    <div class="card-side-box compact">
      <div class="side-title">
        <span class="side-icon">⚠</span>
        <div><strong>30 天内到期</strong><b>${expiring.length}</b><small>建议优先关注</small></div>
      </div>
    </div>
    <div class="card-side-box expiry-list">
      <strong>临近到期</strong>
      <small>显示最需要关注的几台</small>
      ${near.length ? near.map(t => `<p><span>${escapeHtml(t.name)}</span><em>${daysUntil(t.expires_at)} 天</em></p>`).join('') : '<p class="empty-expiry">暂无已设置到期时间的节点</p>'}
    </div>
  `;
}

function renderIncidentLog(data) {
  if (!els.incidentLogPanel || !els.incidentBody || !els.incidentSummary) return;

  const rows = Array.isArray(data.incidents) && data.incidents.length
    ? data.incidents.map(incidentToRow)
    : (data.targets || [])
      .filter(t => Number(t.last_fail_at) > 0)
      .sort((a, b) => Number(b.last_fail_at) - Number(a.last_fail_at))
      .map(targetToIncidentRow);

  const currentDown = rows.filter(t => t.active).length;

  els.incidentSummary.textContent = rows.length
    ? `${rows.length} 条记录${currentDown ? ` · ${currentDown} 个进行中` : ''}`
    : '暂无故障';

  if (!rows.length) {
    els.incidentBody.innerHTML = '<div class="empty">暂无离线事件。</div>';
    updateIncidentToggle();
    return;
  }

  els.incidentBody.innerHTML = rows.slice(0, 40).map(t => {
    const target = displayTarget(t);
    const region = regionShort(t);

    const meta = [
      target ? escapeHtml(target) : '',
      region ? escapeHtml(region) : '',
    ].filter(Boolean).join(' · ');

    const startedAt = Number(t.started_at || t.time || 0);
    const recoveredAt = Number(t.recovered_at || 0);
    const lastCheckedAt = Number(t.last_checked_at || t.checked_at || 0);
    const durationSec = incidentDurationSec(t);
    const statusText = t.active ? '故障中' : '已恢复';

    const statusLine = t.active
      ? `仍处于离线状态 · 已持续 ${escapeHtml(formatDuration(durationSec))}${lastCheckedAt ? ` · 最后检查 ${escapeHtml(fmtTime(lastCheckedAt))}` : ''}`
      : `恢复于 ${escapeHtml(fmtTime(recoveredAt))} · 持续 ${escapeHtml(formatDuration(durationSec))}`;

    const reason = t.last_error || t.error
      ? `<span class="incident-reason">原因：${escapeHtml(t.last_error || t.error)}</span>`
      : '';

    return `
      <div class="incident-row ${t.active ? 'active' : ''}">
        <div class="incident-main">
          <strong>${escapeHtml(t.name || t.target_id || '未知服务')}</strong>
          <span>${meta || '-'}</span>
          ${reason}
        </div>
        <div class="incident-timeline">
          <time>开始于 ${escapeHtml(fmtTime(startedAt))}</time>
          <small>${statusLine}</small>
        </div>
        <em>${statusText}</em>
      </div>
    `;
  }).join('');

  updateIncidentToggle();
}

function incidentToRow(i) {
  const startedAt = Number(i.started_at || 0);
  const recoveredAt = Number(i.recovered_at || 0);

  return {
    ...i,
    active: !recoveredAt,
    started_at: startedAt,
    recovered_at: recoveredAt || null,
    time: recoveredAt || startedAt,
    ok: recoveredAt ? 1 : 0,
    checked_at: Number(i.last_checked_at || recoveredAt || startedAt || 0),
    duration_sec: i.duration_sec == null ? null : Number(i.duration_sec),
  };
}

function targetToIncidentRow(t) {
  const active = Number(t.ok) === 0;
  const startedAt = Number(t.current_outage_started_at || t.last_fail_at || 0);
  const recoveredAt = active ? 0 : Number(t.last_recover_at || 0);

  return {
    ...t,
    active,
    started_at: startedAt,
    recovered_at: recoveredAt || null,
    time: recoveredAt || startedAt,
    checked_at: Number(t.checked_at || t.last_checked_at || recoveredAt || startedAt || 0),
    duration_sec: startedAt
      ? Math.max(0, (recoveredAt || Math.floor(Date.now() / 1000)) - startedAt)
      : null,
  };
}

function incidentDurationSec(row) {
  if (row.duration_sec != null && Number.isFinite(Number(row.duration_sec))) {
    return Math.max(0, Number(row.duration_sec));
  }

  const start = Number(row.started_at || row.time || 0);
  if (!start) return 0;

  const end = Number(row.recovered_at || 0) || Math.floor(Date.now() / 1000);
  return Math.max(0, end - start);
}

function updateIncidentToggle() {
  if (!els.incidentLogPanel || !els.incidentToggle || !els.incidentBody) return;

  els.incidentBody.hidden = !state.incidentsOpen;
  els.incidentToggle.setAttribute('aria-expanded', String(state.incidentsOpen));
  els.incidentLogPanel.classList.toggle('collapsed', !state.incidentsOpen);

  const caret = els.incidentToggle.querySelector('.incident-caret');
  if (caret) {
    caret.textContent = state.incidentsOpen ? '−' : '+';
  }
}

function renderGroups(data) {
  if (!els.groups) return;

  const summaries = indexSummaries(data.summaries || []);
  const days = data.days || [];
  const allTargets = data.targets || [];
  const text = state.filteredText;
  const isCardDetail = state.frontendTheme === 'cards' && state.cardDetailId;
  document.body.classList.toggle('card-detail-mode', Boolean(isCardDetail));

  if (isCardDetail) {
    const detailTarget = allTargets.find(t => t.id === state.cardDetailId);
    if (!detailTarget) {
      els.groups.innerHTML = `
        <section class="node-detail-page card-soft">
          <button type="button" class="node-detail-back" data-card-back>← 返回节点列表</button>
          <div class="empty">未找到这个节点。</div>
        </section>
      `;
      document.querySelector('[data-card-back]')?.addEventListener('click', closeCardDetail);
      return;
    }

    els.groups.innerHTML = renderCardDetailPage(detailTarget, days, summaries);
    document.querySelector('[data-card-back]')?.addEventListener('click', closeCardDetail);
    const detailCard = document.querySelector('.node-detail-summary .service');
    selectService(detailTarget.id, detailTarget.name, detailCard, { detail: true }).catch(() => {});
    return;
  }

  let targets = text
    ? allTargets.filter(t => targetSearchText(t).includes(text))
    : allTargets;

  if (state.frontendTheme === 'cards' && state.cardRegion !== 'all') {
    targets = targets.filter(t => targetRegionCode(t) === state.cardRegion);
  }

  if (!targets.length) {
    els.groups.innerHTML = '<div class="empty">没有匹配的服务。</div>';

    if (els.inlineChartPanel) {
      els.inlineChartPanel.hidden = true;
    }

    return;
  }

  const groups = state.frontendTheme === 'cards'
    ? { 节点: targets }
    : groupBy(targets, t => t.group_name || '默认分组');

  els.groups.innerHTML = Object.entries(groups)
    .map(([name, list], index) => renderGroup(name, list, days, summaries, index))
    .join('');

  document.querySelectorAll('.group-head').forEach((head) => {
    head.addEventListener('click', () => {
      const group = head.closest('.group');
      const toggle = group.querySelector('.group-toggle');

      group.classList.toggle('collapsed');

      if (toggle) {
        toggle.textContent = group.classList.contains('collapsed') ? '+' : '−';
      }
    });
  });

  document.querySelectorAll('.service').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      if (state.frontendTheme === 'cards') {
        openCardDetail(el.dataset.id);
        return;
      }
      selectService(el.dataset.id, el.dataset.name, el);
    });
  });

  if (state.frontendTheme !== 'cards' && state.selectedId) {
    const selected = document.querySelector(`.service[data-id="${cssEscape(state.selectedId)}"]`);

    if (selected) {
      selected.classList.add('selected');
      attachInlineChart(selected);
    } else if (els.inlineChartPanel) {
      els.inlineChartPanel.hidden = true;
    }
  }
}

function renderGroup(name, list, days, summaries, index = 0) {
  const checked = list.filter(targetHasStatus);
  const down = checked.filter(t => !targetIsUp(t)).length;
  const unknown = list.length - checked.length;
  const delayed = checked.filter(t => targetIsUp(t) && isTargetStale(t)).length;
  const up = checked.filter(t => targetIsUp(t) && !isTargetStale(t)).length;

  let statusText = '运行正常';
  let className = 'group';
  let okIcon = '✓';

  if (down > 0) {
    statusText = `${down} 个离线`;
    className += ' down';
    okIcon = '!';
  } else if (delayed > 0) {
    statusText = `${delayed} 个延迟`;
    className += ' degraded';
    okIcon = '?';
  } else if (unknown > 0) {
    statusText = `${unknown} 个待检查`;
    className += ' degraded';
    okIcon = '?';
  }

  return `
    <article class="${className}" style="--delay:${Math.min(index * 70, 360)}ms">
      <div class="group-head" role="button" tabindex="0">
        <span class="group-toggle">−</span>
        <div class="group-title">
          <strong>${escapeHtml(displayGroupName(name))}</strong>
          <span>${describeGroup(name, list.length, up)}</span>
        </div>
        <span class="group-status">${escapeHtml(statusText)}</span>
        <span class="group-ok">${okIcon}</span>
      </div>
      <div class="service-list">
        ${list.map(t => renderService(t, days, summaries)).join('')}
      </div>
    </article>
  `;
}

function renderService(t, days, summaries) {
  if (state.frontendTheme === 'cards') {
    return renderServiceCard(t, days, summaries);
  }

  const checked = targetHasStatus(t);
  const isUp = targetIsUp(t);
  const stale = checked && isUp && isTargetStale(t);
  const status = checked ? (isUp ? (stale ? '数据延迟' : '运行正常') : '离线') : '待检查';
  const statusClass = checked ? (isUp ? (stale ? 'degraded' : '') : 'down') : 'unknown';
  const selectedClass = t.id === state.selectedId ? ' selected' : '';
  const metaHtml = serviceMetaHtml(t);
  const uptime = t.status_source === 'agent'
    ? (t.agent_online ? 'Agent 在线' : 'Agent 离线')
    : (t.uptime_24h == null ? '-' : `${Number(t.uptime_24h).toFixed(2)}%`);
  const latency = Number(t.ok) !== 1 || t.latency_ms == null ? '-' : `${t.latency_ms} ms`;
  const trafficProgress = trafficProgressHtml(trafficForTarget(t), 'service-traffic-progress');
  // Metadata badges
  let metaBadges = '';
  if (t.location) metaBadges += `<span class="meta-badge meta-loc">📍 ${escapeHtml(t.location)}</span>`;
  if (t.machine_uptime_sec) metaBadges += `<span class="meta-badge meta-uptime">运行时长 ${escapeHtml(formatMachineUptime(t.machine_uptime_sec))}</span>`;
  if (t.tags) {
    const tags = t.tags.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
    metaBadges += tags.map(tg => `<span class="meta-badge meta-tag">${escapeHtml(tg)}</span>`).join('');
  }
  const billingCycle = normalizeBillingCycle(t.billing_cycle);
  if (t.expires_at) {
    const remaining = Math.ceil((Number(t.expires_at) - Date.now()/1000) / 86400);
    const cls = remaining < 0 ? 'meta-expired' : remaining < 30 ? 'meta-expiry-warn' : 'meta-expiry';
    metaBadges += `<span class="meta-badge ${cls}">${remaining < 0 ? '已过期' : remaining + '天到期'}</span>`;
  } else if (billingCycle === 'hourly') {
    metaBadges += `<span class="meta-badge meta-price">按量计费</span>`;
  } else if (isLifetimeBilling(billingCycle)) {
    metaBadges += `<span class="meta-badge meta-price">永久 / 买断</span>`;
  }
  if (t.price != null) {
    const cycle = billingCycleSuffix(billingCycle);
    const cur = t.currency || 'USD';
    metaBadges += `<span class="meta-badge meta-price">${cur} ${t.price}${cycle}</span>`;
    if (t.price_cny != null && cur !== 'CNY') metaBadges += `<span class="meta-badge meta-price">≈ ¥${t.price_cny}${cycle}</span>`;
  }

  return `
    <div class="service ${statusClass}${selectedClass}" data-id="${escapeAttr(t.id)}" data-name="${escapeAttr(t.name)}">
      <div class="service-name">
        ${escapeHtml(t.name)}
        ${metaHtml ? `<span class="service-target">${metaHtml}</span>` : ''}
        ${metaBadges ? `<span class="service-meta">${metaBadges}</span>` : ''}
      </div>
      <div class="service-status">${status}</div>
      <div class="service-latency">${latency}</div>
      <div class="service-uptime">${uptime}</div>
      <div class="service-bottom-row${trafficProgress ? ' has-traffic' : ''}">
        <div class="uptime-strip" title="${t.status_source === 'agent' ? 'Cloudflare 探测记录' : '最近 30 天可用率'}">
          ${renderBars(t.id, days, summaries)}
        </div>
        ${trafficProgress}
      </div>
    </div>
  `;
}

function renderServiceCard(t, days, summaries) {
  const checked = targetHasStatus(t);
  const isUp = targetIsUp(t);
  const stale = checked && isUp && isTargetStale(t);
  const status = checked ? (isUp ? (stale ? '延迟' : '在线') : '离线') : '待定';
  const statusClass = checked ? (isUp ? (stale ? 'degraded' : '') : 'down') : 'unknown';
  const selectedClass = t.id === state.selectedId ? ' selected' : '';
  const m = t.agent_metrics || {};
  const info = m.vps_info || {};
  const region = targetRegionCode(t);
  const regionFlag = nodegetFlagHtml(region, 'node-region-flag');
  const osLine = cardOsLine(info);
  const latency = Number(t.ok) !== 1 || t.latency_ms == null ? '-' : `${t.latency_ms}ms`;
  const titleMeta = nodegetCardMetaLine([region !== 'OTHER' ? regionMeta(region).label : regionShort(t)]);
  const age = m.updated_at || t.last_metrics_at ? timeAgoSec(Math.floor(new Date(m.updated_at || t.last_metrics_at).getTime() / 1000)) : '-';
  const latencySamples = cardLatencySamples(t, days);
  const pingRows = cardPingRows(t);
  const trafficProgress = trafficProgressHtml(trafficForTarget(t), 'node-traffic-progress');
  const slaBars = trafficProgress ? 20 : 30;

  return `
    <div class="service node-card card-soft node-card-hover ${statusClass}${selectedClass}" data-id="${escapeAttr(t.id)}" data-name="${escapeAttr(t.name)}">
      <div class="node-card-head">
        <span class="node-dot ${nodegetStatusDotClass(statusClass)}"></span>
        <span class="node-logo">${nodegetOsLogoHtml(info)}</span>
        <div class="service-name">
          ${escapeHtml(t.name)}
          ${titleMeta ? `<span class="service-target">${escapeHtml(titleMeta)}</span>` : ''}
        </div>
        <span class="node-flag">${regionFlag}</span>
        <span class="service-status node-status-text">${escapeHtml(status)}</span>
      </div>
      <div class="node-os-line">${escapeHtml(osLine)}</div>
      <div class="node-resource-grid">
        ${cardResourceMetric('CPU', Number(m.cpu_percent || 0), cardCpuSub(info), 'cpu')}
        ${cardResourceMetric('内存', Number(m.memory?.percent || 0), cardMemorySub(m.memory), 'mem')}
        ${cardResourceMetric('磁盘', Number(m.disk?.percent || 0), cardDiskSub(m.disk), 'disk')}
      </div>
      <div class="node-latency-panel">
        <strong>⌁ 延迟监控</strong>
        <small>${pingRows ? 'IPV4 TCPING' : '真实探测历史'}</small>
        ${pingRows || cardLatencyRow(regionShort(t) || '当前探测', t.latency_ms, latencySamples)}
      </div>
      <div class="node-sla-row${trafficProgress ? ' has-traffic' : ''}">
        <div class="node-uptime-strip" style="--sla-bars:${slaBars}" title="${t.status_source === 'agent' ? 'Cloudflare 探测记录' : `最近 ${slaBars} 天可用率`}">
          ${renderBars(t.id, days, summaries, slaBars)}
        </div>
        ${trafficProgress}
      </div>
      <div class="node-card-foot">
        <span>↓ ${escapeHtml(fmtBytesPerSec(m.net?.rx_bytes_sec || 0))}</span>
        <span>↑ ${escapeHtml(fmtBytesPerSec(m.net?.tx_bytes_sec || 0))}</span>
        <span>◷ ${escapeHtml(formatMachineUptime(m.uptime_sec || t.machine_uptime_sec || 0))}</span>
        <em>${escapeHtml(age)}</em>
      </div>
    </div>
  `;
}

function cardResourceMetric(label, value, sub, tone) {
  const pct = Number.isFinite(Number(value)) ? clampNumber(Number(value), 0, 100) : 0;
  const radius = 44;
  const strokeWidth = 9;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (circumference * pct / 100);
  const color = metricStrokeColor(pct, tone);
  const glow = metricGlowColor(color);
  return `
    <div class="node-resource-ring ${escapeAttr(tone)}" title="${escapeAttr(sub || '')}">
      <div class="resource-ring" style="--metric-glow:${escapeAttr(glow)};--metric-color:${escapeAttr(color)};">
        <svg viewBox="0 0 100 100" aria-label="${escapeAttr(`${label} ${formatMetricPct(pct)}`)}">
          <circle class="ring-track" cx="50" cy="50" r="${radius}" fill="none" stroke-width="${strokeWidth}"></circle>
          <circle class="ring-value" cx="50" cy="50" r="${radius}" fill="none" stroke-width="${strokeWidth}" stroke-dasharray="${circumference.toFixed(3)}" stroke-dashoffset="${offset.toFixed(3)}"></circle>
        </svg>
        <span class="ring-core">
          <strong>${escapeHtml(formatMetricPct(pct))}</strong>
          <em>${escapeHtml(label)}</em>
        </span>
      </div>
      ${sub ? `<small>${escapeHtml(sub)}</small>` : ''}
    </div>
  `;
}

function renderCardDetailPage(target, days, summaries) {
  return nodegetDetailPageHtml(renderServiceCard(target, days, summaries), targetExpiryValueHtml(target));
}

function openCardDetail(id) {
  if (!id) return;
  const url = new URL(window.location.href);
  url.searchParams.set('target', id);
  window.location.href = url.toString();
}

function closeCardDetail() {
  const url = new URL(window.location.href);
  url.searchParams.delete('target');
  window.location.href = url.toString();
}

function formatMetricPct(value) {
  return `${Number(value).toFixed(1)}%`;
}

function metricStrokeColor(value, tone = '') {
  void tone;
  if (value >= 90) return '#f56565';
  if (value >= 70) return '#f6ad55';
  return '#42b983';
}

function metricGlowColor(color) {
  if (color === '#f56565') return 'rgba(245, 101, 101, 0.20)';
  if (color === '#f6ad55') return 'rgba(246, 173, 85, 0.18)';
  return 'rgba(66, 185, 131, 0.18)';
}

function cardLatencyRow(label, rawLatency, samples = []) {
  const latency = rawLatency == null || !Number.isFinite(Number(rawLatency)) ? null : Math.max(0, Number(rawLatency));
  const tone = latency == null ? '' : latency < 80 ? 'good' : latency < 180 ? 'warn' : 'bad';
  return `
    <div class="lat-row">
      <span>${escapeHtml(label)}</span>
      <div class="lat-bars ${tone}">${renderLatencyDots(samples)}</div>
      <strong>${latency == null ? '-' : Math.round(latency) + 'ms'}</strong>
    </div>
  `;
}

function cardPingRows(target) {
  const pingTargets = Array.isArray(state.data?.ping_targets) ? state.data.ping_targets : [];
  const pings = Array.isArray(target?.agent_metrics?.pings) ? target.agent_metrics.pings : [];
  if (!pingTargets.length) return '';
  return pingTargets.map((pingTarget, index) => {
    const targetId = String(pingTarget.id || '');
    const samples = pings
      .filter(p => String(p.target_id || '') === targetId)
      .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
      .slice(-30);
    const values = samples.map(p => Number(p.ok) === 1 && p.latency_ms != null ? Number(p.latency_ms) : null);
    const last = [...samples].reverse().find(p => p.latency_ms != null || Number(p.ok) === 0);
    const latency = last && Number(last.ok) === 1 && last.latency_ms != null ? Math.round(Number(last.latency_ms)) : null;
    const loss = samples.length ? Math.round(samples.filter(p => Number(p.ok) !== 1).length / samples.length * 100) : null;
    const color = pingTargetColor(pingTarget.name || targetId || String(index));
    return `
      <div class="node-ping-row" style="--ping-color:${escapeAttr(color)}">
        <span class="node-ping-name"><i></i>${escapeHtml(pingTarget.name || targetId || '-')}</span>
        <div class="lat-bars node-ping-bars">${renderLatencyDots(values)}</div>
        <strong>${latency == null ? '-' : latency + 'ms'}${loss == null ? '' : `<em>${loss}%</em>`}</strong>
      </div>
    `;
  }).join('');
}

function pingTargetColor(seed) {
  const palette = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#14b8a6'];
  const text = String(seed || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

function cardLatencySamples(target, days = []) {
  const sourceDays = days.length ? days : Object.keys(target.daily || {}).sort();
  return sourceDays.slice(-30).map((day) => {
    const item = target.daily?.[day];
    if (!item || !Number(item.total)) return undefined;
    if (Number(item.ok_count || 0) <= 0) return null;
    const avg = Number(item.sum_latency_ms || 0) / Math.max(1, Number(item.ok_count || 0));
    const fallback = Number(item.last_latency_ms);
    const value = Number.isFinite(avg) && avg > 0 ? avg : fallback;
    return Number.isFinite(value) ? value : undefined;
  });
}

function renderLatencyDots(samples = []) {
  const values = samples.slice(-30);
  while (values.length < 30) values.unshift(undefined);
  return values.map((value) => {
    const color = latencyBarColor(value);
    const height = latencyBarHeight(value);
    const title = value === undefined ? '无数据' : value === null ? '丢包' : `${Math.round(value)}ms`;
    return `<i style="height:${escapeAttr(height)};background-color:${escapeAttr(color)}" title="${escapeAttr(title)}"></i>`;
  }).join('');
}

function latencyBarColor(value) {
  if (value === undefined) return 'rgba(148, 163, 184, 0.28)';
  if (value === null) return '#d96b6b';
  if (value <= 50) return '#69be7b';
  if (value <= 100) return '#a7d879';
  if (value <= 180) return '#e8cc68';
  if (value <= 300) return '#efa85f';
  return '#e98686';
}

function latencyBarHeight(value) {
  if (value === undefined) return '16%';
  if (value === null) return '86%';
  if (value <= 50) return '22%';
  if (value <= 100) return '38%';
  if (value <= 180) return '54%';
  if (value <= 300) return '70%';
  return '86%';
}

function cardOsLine(info) {
  const os = info.os || 'Linux';
  const virt = info.virtualization || '';
  return [os, virt].filter(Boolean).join(' · ');
}

function cardCpuSub(info) {
  const cores = Number(info.cpu_cores || 0);
  return cores ? `${cores} 核` : 'Agent';
}

function cardMemorySub(memory = {}) {
  const used = Number(memory.used_mb || 0);
  const total = Number(memory.total_mb || 0);
  return total ? `${fmtSizeMB(used)} / ${fmtSizeMB(total)}` : '-';
}

function cardDiskSub(disk = {}) {
  const used = Number(disk.used_gb || 0);
  const total = Number(disk.total_gb || 0);
  return total ? `${formatGb(used)} / ${formatGb(total)}` : '-';
}

function cardLoadPercent(load = {}, info = {}) {
  const cores = Math.max(1, Number(info.cpu_cores || 1));
  const load1 = Number(load.load1 || 0);
  return clampNumber(load1 / cores * 100, 0, 100);
}

function cardLoadSub(load = {}, info = {}) {
  const cores = Math.max(1, Number(info.cpu_cores || 1));
  const load1 = Number(load.load1 || 0);
  return `${load1.toFixed(2)} / ${cores} 核`;
}

function isTargetStale(t) {
  if (t?.status_source === 'agent') return false;
  const checkedAt = Number(t.checked_at || 0);
  const metricsAt = t.last_metrics_at ? Math.floor(new Date(t.last_metrics_at).getTime() / 1000) : 0;
  const latest = Math.max(checkedAt, metricsAt);
  if (!latest) return false;

  const interval = Math.max(300, Number(t.interval_sec || 300));
  const staleAfter = Math.max(15 * 60, interval * 3);
  return latest < Math.floor(Date.now() / 1000) - staleAfter;
}

function daybarClassFromPct(pct) {
  if (pct === 100) return 'full';
  if (pct > 99) return 'good';
  if (pct >= 90) return 'fair';
  if (pct >= 80) return 'warn';
  if (pct >= 50) return 'poor';

  return 'bad';
}

function renderBars(targetId, days, summaries, count = 30) {
  const today = currentLocalDay();
  const visibleDays = days.slice(-count);

  return visibleDays.map((day, index) => {
    const s = summaries.get(`${targetId}:${day}`);

    if (!s || !s.total) {
    return `<span class="daybar none" style="--i:${index}" title="${day}：无数据"></span>`;
    }

    const pct = Number(s.ok_count || 0) / Number(s.total || 1) * 100;
    const cls = daybarClassFromPct(pct);
  const todaySuffix = day === today ? ' · 今日截至目前' : '';
    const title = `${day}: ${pct.toFixed(2)}% (${s.ok_count}/${s.total})${todaySuffix}`;

    return `<span class="daybar ${cls}" style="--i:${index}" title="${title}"></span>`;
  }).join('');
}

async function selectService(id, name, el, options = {}) {
  const detailMode = options.detail === true;
  if (state.frontendTheme === 'cards' && !detailMode) {
    openCardDetail(id);
    return;
  }

  const isSame = !detailMode && state.selectedId === id && !els.inlineChartPanel.hidden;

  document.querySelectorAll('.service').forEach(s => s.classList.remove('selected'));

  if (isSame) {
    state.selectedId = null;
    state.selectedName = '';
    state.selectedTargetIntervalSec = 300;
    state.allChecks = [];
    state.dailyPoints = [];
    state.checksSource = '';
    state.targetMetrics = null;
    state.pingData = null;

    if (els.inlineChartPanel) {
      els.inlineChartPanel.hidden = true;
    }

    renderChecksPage();
    return;
  }

  state.selectedId = id;
  state.selectedName = name;
  state.checksPage = 1;
  state.selectedMetric = 'latency';
  state.selectedMetricRange = '1h';
  state.targetMetrics = null;
  state.pingData = null;

  // Find target type
  const target = (state.data?.targets || []).find(t => t.id === id);
  state.selectedTargetIntervalSec = Math.max(300, Number(target?.interval_sec || 300));
  const isHttp = target?.type === 'http';

  document.querySelectorAll('.metric-tab').forEach(b => b.classList.remove('active'));
  document.querySelector('.metric-tab[data-metric="latency"]')?.classList.add('active');
  // Hide metric tabs for HTTP targets (websites)
  document.querySelectorAll('.metric-tab[data-metric]').forEach(b => {
    if (b.dataset.metric !== 'latency') {
      b.style.display = isHttp ? 'none' : '';
    }
  });
  const rangeTabs = document.getElementById('rangeTabs');
  const metricRangeTabs = document.getElementById('metricRangeTabs');
  if (rangeTabs) rangeTabs.style.display = '';
  if (metricRangeTabs) metricRangeTabs.style.display = 'none';
  document.querySelectorAll('.metric-range-tab').forEach(b => b.classList.remove('active'));
  document.querySelector('.metric-range-tab[data-range="1h"]')?.classList.add('active');

  el?.classList.add('selected');
  attachInlineChart(detailMode ? document.querySelector('.node-detail-chart-slot') || el : el);
  if (detailMode) {
    mountNodegetDetailChecksPanel(
      els.checksPanel,
      document.querySelector('.node-detail-checks-slot'),
    );
  }

  await loadChecks(id, name, target, { hours: rangeHours('day') });
}

function attachInlineChart(serviceEl) {
  if (!els.inlineChartPanel) return;

  els.inlineChartPanel.hidden = false;
  serviceEl.appendChild(els.inlineChartPanel);

  if (state.chart) {
    setTimeout(() => state.chart.resize(), 30);
  }
}

async function loadChecks(id, name, target = null, options = {}) {
  const requestedHours = Math.max(rangeHours('day'), Number(options.hours || rangeHours('day')));
  const quiet = Boolean(options.quiet);
  if (!quiet) {
    els.chartTitle.textContent = '响应时间';
    els.chartMeta.textContent = '正在加载检查记录...';
    els.chartServiceName.textContent = `${name} 响应时间`;
    els.chartAvg.textContent = '平均值：-';
    els.checksHint.textContent = name;
    els.checks.textContent = '正在加载...';
    els.checks.classList.add('muted');
  } else if (state.selectedMetric === 'latency') {
    els.chartMeta.textContent = `正在加载${rangeLabel(state.selectedRange)}数据...`;
  }

  try {
    const intervalSec = Math.max(300, Number(target?.interval_sec || state.selectedTargetIntervalSec || 300));
    state.selectedTargetIntervalSec = intervalSec;
    const checksHours = Math.max(requestedHours, Number(window.NSTATUS_CHECKS_MIN_HOURS || 0) || 0);
    const checksLimit = Math.min(20000, Math.max(864, Math.ceil((checksHours * 3600) / intervalSec) + 120));

    const checksRes = await fetch(api(`/api/checks?target_id=${encodeURIComponent(id)}&limit=${encodeURIComponent(checksLimit)}&hours=${encodeURIComponent(checksHours)}`), { cache: 'no-store' });

    const data = await checksRes.json();

    if (state.selectedId !== id) return;

    if (!checksRes.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${checksRes.status}`);
    }

    state.allChecks = data.checks || [];
    state.dailyPoints = data.daily_points || [];
    state.checksSource = data.source || '';
    state.checksLoadedHours = checksHours;
    state.checksPage = 1;

    updateChartForCurrentRange();
    renderChecksPage();
    renderVPSInfo();
    ensureTargetMetricsLoaded();
  } catch (err) {
    state.allChecks = [];
    state.dailyPoints = [];
    state.checksSource = '';
    state.checksLoadedHours = 0;
    state.targetMetrics = null;
    state.pingData = null;

    els.chartMeta.textContent = `检查记录加载失败：${err.message}`;
    els.checks.innerHTML = `<div class="empty fail-text">${escapeHtml(err.message)}</div>`;

    updateChart([], name);
    updatePageInfo();
  }
}

function rangeHours(range) {
  if (range === 'month') return 24 * 30;
  if (range === 'week') return 24 * 7;
  return 24;
}

function metricRangeHours(range) {
  return { '1h': 1, '6h': 6, '24h': 24 }[range] || 1;
}

function ensureChecksForSelectedRange() {
  if (!state.selectedId || state.selectedMetric !== 'latency') return;
  const needed = rangeHours(state.selectedRange);
  if (state.checksLoadedHours >= needed) return;
  loadChecks(state.selectedId, state.selectedName || '服务', null, { hours: needed, quiet: true }).catch(() => {});
}

async function ensureTargetMetricsLoaded() {
  if (!state.selectedId) return;
  const id = state.selectedId;
  const metric = state.selectedMetric;
  const hours = metricRangeHours(state.selectedMetricRange);
  const includeHistory = metric !== 'latency' && metric !== 'ping';
  const cacheKey = `${id}|${metric}|${hours}|${includeHistory ? 'history' : 'latest'}`;
  const cached = state.metricsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 30_000) {
    state.targetMetrics = cached.data;
    if (state.selectedMetric !== 'latency' && state.selectedMetric !== 'ping') updateMetricsChart();
    renderVPSInfo();
    return;
  }
  try {
    const params = new URLSearchParams({
      agent_id: id,
      hours: String(hours),
    });
    if (includeHistory) {
      params.set('metric', metric);
      params.set('format', 'columns');
      params.set('max_points', '0');
    } else {
      params.set('history', '0');
    }
    const res = await fetch(api(`/api/agent/metrics?${params}`), { cache: 'no-store' });
    if (state.selectedId !== id) return;
    const data = await res.json().catch(() => null);
    state.targetMetrics = res.ok && data?.ok ? normalizeAgentMetricsPayload(data) : null;
    if (state.targetMetrics) state.metricsCache.set(cacheKey, { at: Date.now(), data: state.targetMetrics });
    if (state.selectedMetric !== 'latency' && state.selectedMetric !== 'ping') updateMetricsChart();
    renderVPSInfo();
  } catch (_) {
    if (state.selectedId === id) state.targetMetrics = null;
  }
}

function normalizeAgentMetricsPayload(data) {
  if (!data?.series || !Array.isArray(data.series.dt)) return data;
  const { t0, dt, values } = data.series;
  const fields = Array.isArray(data.series.fields) ? data.series.fields : Object.keys(values || {});
  const history = dt.map((delta, index) => {
    const point = { ts: Number(t0 || 0) + Number(delta || 0) };
    for (const field of fields) point[field] = Number(values?.[field]?.[index] || 0);
    return point;
  });
  return { ...data, history };
}

function renderVPSInfo() {
  const bar = document.getElementById('vpsInfoBar');
  if (!bar) return;
  const m = state.targetMetrics;
  const latest = m?.latest || {};
  const info = m?.latest?.vps_info || {};
  const selectedTarget = (state.data?.targets || []).find(t => t.id === state.selectedId) || null;
  const uptimeSec = Number(m?.latest?.uptime_sec ?? selectedTarget?.machine_uptime_sec ?? 0);
  const net = latest.net || {};
  const diskio = latest.diskio || {};
  const traffic = latest.traffic || selectedTarget?.agent_metrics?.traffic || {};
  if ((!info.cpu_model && !info.os && !latest.hostname) && !uptimeSec) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  const systemItems = [];
  const load = latest.load || {};
  if (latest.hostname) systemItems.push(vpsItem('主机名', latest.hostname));
  if (info.os) systemItems.push(vpsItem('操作系统', info.os));
  if (info.kernel) systemItems.push(vpsItem('内核', info.kernel));
  if (info.arch) systemItems.push(vpsItem('CPU 架构', info.arch));
  if (info.virtualization) systemItems.push(vpsItem('虚拟化', info.virtualization));
  if (info.cpu_model) systemItems.push(vpsItem('CPU 型号', info.cpu_model));
  if (info.cpu_cores || info.physical_cores) systemItems.push(vpsItem('核心', `${Number(info.physical_cores || info.cpu_cores || 0)} 物理 / ${Number(info.cpu_cores || 0)} 逻辑`));
  if (info.total_mem_mb) systemItems.push(vpsItem('内存', fmtSizeMB(info.total_mem_mb)));
  if (info.total_swap_mb) systemItems.push(vpsItem('Swap', fmtSizeMB(info.total_swap_mb)));
  if (info.total_disk_gb) systemItems.push(vpsItem('磁盘', `${info.total_disk_gb} GB`));
  if (info.city || info.region || info.country) {
    const loc = [info.city, info.region, info.country].filter(Boolean).join(', ');
    systemItems.push(vpsItem('位置', loc));
  }

  const networkItems = [];
  if (traffic.enabled) {
    if (traffic.mode_label) networkItems.push(vpsItem('流量计费', traffic.mode_label));
    networkItems.push(vpsItem('累计接收', fmtBytes(traffic.rx_bytes || 0)));
    networkItems.push(vpsItem('累计发送', fmtBytes(traffic.tx_bytes || 0)));
    networkItems.push(vpsItem(traffic.reset === 'expiry-day' ? '计费周期流量' : '本月计费流量', `${fmtBytes(traffic.total_bytes || 0)}${traffic.quota_bytes ? ' / ' + fmtBytes(traffic.quota_bytes) : ''}${traffic.percent != null ? ' · ' + traffic.percent + '%' : ''}${traffic.reset === 'expiry-day' && traffic.reset_day ? ' · ' + traffic.reset_day + '日重置' : ''}`));
  }
  networkItems.push(vpsItem('当前接收', fmtBytesPerSec(net.rx_bytes_sec || 0)));
  networkItems.push(vpsItem('当前发送', fmtBytesPerSec(net.tx_bytes_sec || 0)));
  networkItems.push(vpsItem('磁盘读', fmtBytesPerSec(diskio.read_bytes_sec || 0)));
  networkItems.push(vpsItem('磁盘写', fmtBytesPerSec(diskio.write_bytes_sec || 0)));
  if (latest.process_count) networkItems.push(vpsItem('进程数', latest.process_count));
  networkItems.push(vpsItem('TCP / UDP', `${Number(net.tcp_conns || 0)} / ${Number(net.udp_conns || 0)}`));
  if (load.load1 != null) networkItems.push(vpsItem('负载', [load.load1, load.load5, load.load15].filter(v => v != null).map(v => Number(v).toFixed(2)).join(' / ')));
  if (uptimeSec > 0) networkItems.push(vpsItem('运行时长', formatMachineUptime(uptimeSec)));
  if (latest.agent_version) networkItems.push(vpsItem('Agent', latest.agent_version));
  if (latest.updated_at) networkItems.push(vpsItem('更新', new Date(latest.updated_at).toLocaleString('zh-CN', { hour12: false })));

  bar.innerHTML = `
    <section class="vps-info-section"><h4>系统信息</h4>${systemItems.join('')}</section>
    <section class="vps-info-section"><h4>网络与负载</h4>${networkItems.join('')}</section>
  `;
  bar.hidden = false;
}

function vpsItem(label, value) {
  return `<span class="vps-info-item"><span class="vps-info-label">${escapeHtml(label)}</span><span class="vps-info-value">${escapeHtml(value)}</span></span>`;
}

// TCP Ping

const PING_COLORS = ['#159754','#2ea3ff','#e67e22','#e74c3c','#8e44ad','#1abc9c','#f39c12','#3498db','#2ecc71','#9b59b6'];

async function updatePingChart() {
  els.chartTitle.textContent = 'TCP Ping';
  if (!state.selectedId) return;

  const range = state.selectedMetricRange;
  const hours = { '1h': 1, '6h': 6, '24h': 24 }[range] || 24;
  const cacheKey = `${state.selectedId}|${hours}`;

  try {
    const cached = state.pingsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 30_000) {
      state.pingData = cached.data;
    } else {
      const params = new URLSearchParams({
        agent_id: state.selectedId,
        hours: String(hours),
        format: 'series',
        max_points_per_target: '0',
      });
      const res = await fetch(api(`/api/agent/pings?${params}`), { cache: 'no-store' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Ping 数据加载失败');
      state.pingData = normalizePingPayload(data);
      state.pingsCache.set(cacheKey, { at: Date.now(), data: state.pingData });
    }
  } catch (err) {
    state.pingData = { pings: [] };
    els.chartMeta.textContent = '暂无 Ping 数据';
    if (state.chart) { state.chart.data.datasets = []; state.chart.update(); }
    return;
  }

  const pings = state.pingData.pings || [];
  const byTarget = new Map();
  for (const p of pings) {
    const arr = byTarget.get(p.target_id) || [];
    const ok = p.ok === undefined ? Number(p.latency_ms) >= 0 : Number(p.ok) === 1;
    arr.push({ x: Number(p.ts), y: ok && Number(p.latency_ms) >= 0 ? Number(p.latency_ms) : null });
    byTarget.set(p.target_id, arr);
  }

  if (!state.chart) return;
  const datasets = [];
  let idx = 0;
  const targets = state.pingData.targets || [];
  for (const [tid, points] of byTarget) {
    const tgt = targets.find(t => t.id === tid) || {};
    datasets.push({
      label: tgt.name || tid,
      data: points.sort((a, b) => a.x - b.x),
      borderColor: PING_COLORS[idx % PING_COLORS.length],
      borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 6,
      pointBackgroundColor: PING_COLORS[idx % PING_COLORS.length],
      tension: 0.3, fill: false, spanGaps: true,
    });
    idx++;
  }

  state.chart.data.datasets = datasets;
  state.chart.options.scales.y.title = { display: true, text: 'ms' };
  delete state.chart.options.scales.y.beginAtZero;
  delete state.chart.options.scales.y.suggestedMax;
  delete state.chart.options.scales.y.max;
  state.chart.options.scales.y.grace = '18%';

  const allX = datasets.flatMap(ds => (ds.data || []).map(p => p.x)).filter(Number.isFinite);
  const { min: xMin, max: xMax } = minMax(allX);
  if (allX.length) {
    const span = xMax - xMin || 300;
    const pad = Math.max(60, Math.round(span * 0.025));
    state.chartZoomFullMin = xMin - pad;
    state.chartZoomFullMax = xMax + pad;
  }
  const totalPings = pings.length;
  delete state.chart.options.scales.x.min;
  delete state.chart.options.scales.x.max;
  tuneChartAnimation(totalPings);
  state.chart.update();
  updateChartZoomButton();

  const okPings = pings.filter(p => p.ok === undefined ? Number(p.latency_ms) >= 0 : Number(p.ok) === 1).length;
  els.chartAvg.textContent = `Ping 总数：${totalPings} · 成功：${okPings}`;
  els.chartMeta.textContent = `最近 ${hours} 小时 · ${byTarget.size} 个目标`;
}

function normalizePingPayload(data) {
  if (!Array.isArray(data?.series)) return data;
  const pings = [];
  for (const series of data.series) {
    const targetId = series.target_id;
    const t0 = Number(series.t0 || 0);
    const dt = Array.isArray(series.dt) ? series.dt : [];
    for (let i = 0; i < dt.length; i++) {
      pings.push({
        target_id: targetId,
        ts: t0 + Number(dt[i] || 0),
        latency_ms: series.latency_ms?.[i] == null ? null : Number(series.latency_ms[i]),
        ok: Number(series.ok?.[i] || 0),
      });
    }
  }
  return { ...data, pings };
}

function renderChecksPage() {
  if (!state.selectedId) {
    els.checks.classList.add('muted');
    els.checks.innerHTML = '<div class="empty">请选择服务以查看最近检查记录。</div>';
    els.checksHint.textContent = '未选择服务';
    updatePageInfo();
    return;
  }

  const total = state.allChecks.length;
  const totalPages = getTotalCheckPages();

  state.checksPage = Math.min(Math.max(state.checksPage, 1), totalPages);

  const start = (state.checksPage - 1) * state.checksPageSize;
  const pageRows = state.allChecks.slice(start, start + state.checksPageSize);

  els.checks.classList.remove('muted');

  els.checks.innerHTML = pageRows.map((c, index) => `
    <div class="check-card" style="--delay:${Math.min(index * 35, 220)}ms">
      <div>${fmtTime(c.checked_at)}</div>
      <div class="${checkStatusClass(c)}">${checkStatusLabel(c)}</div>
      <div>${c.latency_ms == null ? '-' : c.latency_ms + ' ms'}</div>
      <div>${c.status_code || '-'}</div>
      <div class="small check-extra">${formatCheckExtraHtml(c)}</div>
    </div>
  `).join('') || '<div class="empty">暂无检查记录。</div>';

  els.checksHint.textContent = `${state.selectedName} · 最近 ${total} 条记录${state.checksSource ? ' · ' + state.checksSource : ''}`;

  updatePageInfo();
}

function checkStatusLabel(c) {
  if (c.missed) return '漏检';
  return Number(c.ok) ? '成功' : '失败';
}
function targetHasStatus(target) {
  return target?.status_source === 'agent' ? Boolean(target.last_metrics_at) : Boolean(target?.checked_at);
}

function targetIsUp(target) {
  return target?.status_source === 'agent' ? target.agent_online === true : Number(target?.ok) === 1;
}

function checkStatusClass(c) {
  if (c.missed) return 'warn-text';
  return Number(c.ok) ? 'ok-text' : 'fail-text';
}

function updatePageInfo() {
  const totalPages = getTotalCheckPages();

  if (!state.selectedId || !state.allChecks.length) {
    els.pageInfo.textContent = '-';
    els.prevPage.disabled = true;
    els.nextPage.disabled = true;
    return;
  }

  els.pageInfo.textContent = `${state.checksPage} / ${totalPages}`;
  els.prevPage.disabled = state.checksPage <= 1;
  els.nextPage.disabled = state.checksPage >= totalPages;
}

function getTotalCheckPages() {
  return Math.max(1, Math.ceil(state.allChecks.length / state.checksPageSize));
}

function initChart() {
  const ctx = document.getElementById('latencyChart');
  if (state.chart) return;

  if (!window.Chart || !ctx) {
    console.warn('Chart.js 未加载，响应时间图表已停用。');
    state.chart = null;

    if (els.chartMeta) {
      els.chartMeta.textContent = 'Chart.js 加载失败，服务状态仍可正常查看。';
    }

    return;
  }

  registerChartNearestTimeMode();

  state.chart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: buildChartDatasets([], [], []),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      resizeDelay: 120,

      animation: {
        duration: 200,
        easing: 'easeOutQuart',
      },

      interaction: {
        intersect: false,
        mode: 'nearestTime',
      },

      plugins: {
        legend: {
          display: true,
          align: 'end',
          labels: {
            boxWidth: 10,
            boxHeight: 10,
            usePointStyle: true,
            color: '#5f6b78',
            font: {
              family: 'Varela Round',
              size: 12,
            },
            filter(item) {
              return !String(item.text || '').match(/\bDown\b/);
            }
          },
        },

        tooltip: {
          mode: 'nearestTime',
          intersect: false,
          position: 'nearest',
          callbacks: {
            title(items) {
              const hoverValue = chartHoverTimestamp();
              if (Number.isFinite(hoverValue)) return formatFullChartTime(hoverValue);
              const item = items && items[0];
              return item?.parsed ? formatFullChartTime(item.parsed.x) : '';
            },

            label(context) {
              const v = context.parsed.y;
              if (!Number.isFinite(v)) return `${context.dataset.label}: failed`;
              const m = state.selectedMetric;
              if (m === 'net') {
                const bps = v * 8;
                if (bps >= 1000000) return `${context.dataset.label}: ${(bps/1000000).toFixed(1)} Mbps`;
                if (bps >= 1000) return `${context.dataset.label}: ${(bps/1000).toFixed(1)} Kbps`;
                return `${context.dataset.label}: ${bps.toFixed(0)} bps`;
              }
              if (m === 'conns') return `${context.dataset.label}: ${v}`;
              if (m === 'diskio') {
                if (v >= 1073741824) return `${context.dataset.label}: ${(v/1073741824).toFixed(1)} GB/s`;
                if (v >= 1048576) return `${context.dataset.label}: ${(v/1048576).toFixed(1)} MB/s`;
                if (v >= 1024) return `${context.dataset.label}: ${(v/1024).toFixed(1)} KB/s`;
                return `${context.dataset.label}: ${v.toFixed(0)} B/s`;
              }
              const u = m === 'cpu' || m === 'mem' || m === 'disk' ? '%' : m === 'latency' ? ' ms' : '';
              return `${context.dataset.label}: ${v}${u}`;
            }
          }
        }
      },

      scales: {
        x: {
          type: 'linear',

          grid: {
            display: false,
          },

          ticks: {
            color: '#5f6b78',
            maxTicksLimit: 12,
            autoSkip: true,

            callback(value) {
              return formatAxisChartTime(Number(value), state.selectedRange);
            },

            font: {
              family: 'Varela Round',
              size: 12,
            }
          },

          border: {
            color: '#dfe3e8',
          },
        },

        y: {
          beginAtZero: true,
          grace: '18%',

          grid: {
            color: 'rgba(151, 164, 176, .25)',
          },

          ticks: {
            color: '#5f6b78',
            maxTicksLimit: 5,

            font: {
              family: 'Varela Round',
              size: 12,
            }
          },

          border: {
            display: false,
          }
        }
      }
    },
    plugins: [chartHoverLinePlugin()],
  });
}

function updateChartForCurrentRange() {
  if (state.selectedMetric === 'ping') {
    updatePingChart();
    return;
  }
  if (state.selectedMetric !== 'latency') {
    updateMetricsChart();
    return;
  }

  els.chartTitle.textContent = '响应时间';
  const rangeChecks = getChartPointsForRange();

  updateChart(rangeChecks, state.selectedName || '服务');

  const expected = expectedChartGapSec(state.selectedRange);
  const gapCount = countChartGaps(rangeChecks, expected);
  const missedCount = countMissedChecks(rangeChecks);
  const mode = rangeChecks.length
    ? `每 5 分钟检查${gapCount ? `，${gapCount} 个数据间断` : ''}${missedCount ? `，${missedCount} 次漏检` : ''}`
    : '无原始检查数据';
  els.chartMeta.innerHTML = chartMetaHtml(state.selectedRange, rangeChecks.length, '', mode);
}

function updateMetricsChart() {
  const m = state.targetMetrics;
  const metric = state.selectedMetric;
  const range = state.selectedMetricRange;
  const labels = { cpu: 'CPU 使用率', mem: '内存使用率', disk: '磁盘使用率', load: '平均负载', net: '网络速度', conns: '连接数', diskio: '磁盘 I/O' };
  const units = { cpu: '%', mem: '%', disk: '%', load: '', net: '', conns: '', diskio: '' };
  const fields = { cpu: 'cpu', mem: 'mem', disk: 'disk', load: 'load1', net_rx: 'net_rx', net_tx: 'net_tx', tcp_conns: 'tcp_conns', udp_conns: 'udp_conns', disk_read: 'disk_read', disk_write: 'disk_write' };

  els.chartTitle.textContent = labels[metric] || metric;

  if (!m || !m.latest) {
    els.chartMeta.textContent = '暂无监控数据，请在此 VPS 上安装 nstatus-metrics Agent。';
    updateChart([], state.selectedName || '服务');
    return;
  }
  // If history is empty, create a synthetic point from latest state
  if (!m.history || !m.history.length) {
    const latestTs = Math.floor(new Date(m.latest.updated_at || 0).getTime() / 1000) || Math.floor(Date.now() / 1000);
    m.history = [{
      ts: latestTs, cpu: m.latest.cpu_percent, mem: m.latest.memory?.percent || 0,
      disk: m.latest.disk?.percent || 0, load1: m.latest.load?.load1 || 0,
      net_rx: m.latest.net?.rx_bytes_sec || 0, net_tx: m.latest.net?.tx_bytes_sec || 0,
      tcp_conns: m.latest.net?.tcp_conns || 0, udp_conns: m.latest.net?.udp_conns || 0,
      disk_read: m.latest.diskio?.read_bytes_sec || 0, disk_write: m.latest.diskio?.write_bytes_sec || 0,
    }];
  }

  // Filter by time range
  const rangeSec = { '1h': 3600, '6h': 21600, '24h': 86400 }[range] || 3600;
  const now = Math.floor(Date.now() / 1000);
  let history = m.history.filter(p => Number(p.ts) >= now - rangeSec);
  const latest = m.latest || {};
  if (!history.length) {
    const latestTs = Math.floor(new Date(latest.updated_at || 0).getTime() / 1000);
    const latestText = latestTs ? `最后上报：${timeAgoSec(latestTs)}` : 'Agent 尚未上报';
    els.chartMeta.textContent = `${range}内暂无采样点。${latestText}。`;
    els.chartAvg.textContent = latestTs ? `最近：${new Date(latest.updated_at).toLocaleString('zh-CN', { hour12: false })}` : '-';
    if (state.chart) {
      state.chart.data.datasets = [];
      delete state.chart.options.scales.x.min;
      delete state.chart.options.scales.x.max;
      state.chart.update();
      updateChartZoomButton();
    }
    return;
  }

  function fmtBytes(b) {
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB/s';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB/s';
    if (b >= 1024) return (b / 1024).toFixed(1) + ' KB/s';
    return b.toFixed(0) + ' B/s';
  }
  function fmtNet(bps) {
    const b = bps * 8;
    if (b >= 1000000000) return (b / 1000000000).toFixed(1) + ' Gbps';
    if (b >= 1000000) return (b / 1000000).toFixed(1) + ' Mbps';
    if (b >= 1000) return (b / 1000).toFixed(1) + ' Kbps';
    return b.toFixed(0) + ' bps';
  }

  if (metric === 'net') {
    const rxPoints = history.map(p => ({ x: Number(p.ts), y: Number(p.net_rx) || 0 }));
    const txPoints = history.map(p => ({ x: Number(p.ts), y: Number(p.net_tx) || 0 }));
    const rxVals = history.map(p => Number(p.net_rx) || 0);
    const txVals = history.map(p => Number(p.net_tx) || 0);
    const rxAvg = rxVals.reduce((a, b) => a + b, 0) / rxVals.length;
    const txAvg = txVals.reduce((a, b) => a + b, 0) / txVals.length;
    const netRx = latest.net?.rx_bytes_sec || 0;
    const netTx = latest.net?.tx_bytes_sec || 0;

    els.chartMeta.textContent = `接收平均 ${fmtNet(rxAvg)} · 发送平均 ${fmtNet(txAvg)} · ${history.length} 个采样点`;
    els.chartAvg.textContent = `接收 ${fmtNet(netRx)} · 发送 ${fmtNet(netTx)}`;

    if (!state.chart) return;
    state.chart.data.datasets = [
      netDataset('下载', rxPoints, '#159754'),
      netDataset('上传', txPoints, '#2ea3ff'),
    ];
  } else if (metric === 'diskio') {
    const readPoints = history.map(p => ({ x: Number(p.ts), y: Number(p.disk_read) || 0 }));
    const writePoints = history.map(p => ({ x: Number(p.ts), y: Number(p.disk_write) || 0 }));
    const readVals = history.map(p => Number(p.disk_read) || 0);
    const writeVals = history.map(p => Number(p.disk_write) || 0);
    const readAvg = readVals.reduce((a, b) => a + b, 0) / readVals.length;
    const writeAvg = writeVals.reduce((a, b) => a + b, 0) / writeVals.length;

    els.chartMeta.textContent = `读取平均 ${fmtBytes(readAvg)} · 写入平均 ${fmtBytes(writeAvg)} · ${history.length} 个采样点`;
    els.chartAvg.textContent = `读取 ${fmtBytes(latest.diskio?.read_bytes_sec || 0)} · 写入 ${fmtBytes(latest.diskio?.write_bytes_sec || 0)}`;

    if (!state.chart) return;
    state.chart.data.datasets = [
      netDataset('读取', readPoints, '#159754'),
      netDataset('写入', writePoints, '#e74c3c'),
    ];
  } else if (metric === 'conns') {
    const tcpPoints = history.map(p => ({ x: Number(p.ts), y: Number(p.tcp_conns) || 0 }));
    const udpPoints = history.map(p => ({ x: Number(p.ts), y: Number(p.udp_conns) || 0 }));
    const tcpVals = history.map(p => Number(p.tcp_conns) || 0);
    const udpVals = history.map(p => Number(p.udp_conns) || 0);
    const tcpAvg = tcpVals.reduce((a, b) => a + b, 0) / tcpVals.length;
    const udpAvg = udpVals.reduce((a, b) => a + b, 0) / udpVals.length;
    const tcpNow = latest.net?.tcp_conns || 0;
    const udpNow = latest.net?.udp_conns || 0;

    els.chartMeta.textContent = `TCP 平均 ${tcpAvg.toFixed(0)} · UDP 平均 ${udpAvg.toFixed(0)} · ${history.length} 个采样点`;
    els.chartAvg.textContent = `TCP ${tcpNow} · UDP ${udpNow}`;

    if (!state.chart) return;
    state.chart.data.datasets = [
      netDataset('TCP', tcpPoints, '#159754'),
      netDataset('UDP', udpPoints, '#e74c3c'),
    ];
  } else {
    const field = fields[metric];
    const unit = units[metric];
    const vals = history.map(p => Number(p[field]) || 0);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const { min, max } = minMax(vals);
    const currentVal = metric === 'cpu' ? latest.cpu_percent : metric === 'mem' ? latest.memory?.percent : metric === 'disk' ? latest.disk?.percent : metric === 'load' ? latest.load?.load1 : metric === 'conns' ? (latest.net?.tcp_conns || 0) + (latest.net?.udp_conns || 0) : 0;

    const stats = latest.stats;
    const statsKeyMap = { cpu: 'cpu', mem: 'mem', disk: 'disk', load: 'load', conns: 'tcp_conns', diskio: null };
    const statsKey = statsKeyMap[metric];
    const s = statsKey ? stats?.[statsKey] : null;

    els.chartMeta.textContent = s
      ? `平均 ${s.avg}${unit} · 最大 ${s.max}${unit} · 最小 ${s.min}${unit} · ${history.length} 个采样点`
      : `平均 ${avg.toFixed(1)}${unit} · 最小 ${min.toFixed(1)}${unit} · 最大 ${max.toFixed(1)}${unit} · ${history.length} 个采样点`;
    els.chartAvg.textContent = `当前：${currentVal != null ? Number(currentVal).toFixed(1) + unit : '-'}`;

    const points = history.map(p => ({ x: Number(p.ts), y: Number(p[field]) || 0 }));
    const color = metric === 'load' ? '#2ea3ff' : '#159754';

    if (!state.chart) return;
    const fill = history.length > 300 ? false : 'origin';
    state.chart.data.datasets = [metricDataset(labels[metric], points, color, fill)];
  }

  const allDatasets = state.chart.data.datasets;
  const allX = allDatasets.flatMap(ds => (ds.data || []).map(p => p.x)).filter(Number.isFinite);
  if (allX.length) {
    const { min: xMin, max: xMax } = minMax(allX);
    const pad = Math.max(60, Math.round((xMax - xMin) * 0.025));
    state.chartZoomFullMin = xMin - pad;
    state.chartZoomFullMax = xMax + pad;
  }
  delete state.chart.options.scales.x.min;
  delete state.chart.options.scales.x.max;
  state.chart.options.scales.y.beginAtZero = metric !== 'load';
  state.chart.options.scales.y.grace = metric === 'load' ? '30%' : '18%';
  if (metric === 'cpu' || metric === 'mem' || metric === 'disk') {
    state.chart.options.scales.y.max = 100;
    state.chart.options.scales.y.grace = 0;
  } else {
    delete state.chart.options.scales.y.max;
  }
  tuneChartAnimation(allDatasets.reduce((sum, ds) => sum + (ds.data?.length || 0), 0));
  state.chart.update();
  updateChartZoomButton();
}

function tuneChartAnimation(pointCount) {
  if (!state.chart) return;
  state.chart.options.animation = Number(pointCount || 0) > 5000
    ? false
    : { duration: 200, easing: 'easeOutQuart' };
}

function metricDataset(label, points, color, fill = 'origin') {
  return {
    label, data: points, parsing: false, borderColor: color,
    backgroundColor: fill ? hexToRgba(color, 0.08) : 'transparent',
    borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 6,
    pointBackgroundColor: color, pointBorderColor: '#fff', pointBorderWidth: 1.5,
    tension: 0.3, fill, spanGaps: false,
  };
}

function netDataset(label, points, color) {
  return {
    label, data: points, parsing: false, borderColor: color,
    borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 6,
    pointBackgroundColor: color, pointBorderColor: '#fff', pointBorderWidth: 2,
    tension: 0.3, fill: false, spanGaps: false,
  };
}

function getChartPointsForRange() {
  const checks = state.allChecks.slice().reverse();
  return filterChecksByRange(checks, state.selectedRange);
}

function updateChart(checks, name) {
  const rows = normalizeChartRows(checks);
  const points = buildLinePoints(rows);

  const nums = points.map(p => p.y).filter(Number.isFinite);
  const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;

  els.chartServiceName.textContent = `${name} 响应时间`;
  els.chartAvg.textContent = `平均值：${avg == null ? '-' : avg.toFixed(2) + ' ms'}`;

  if (!state.chart) {
    els.chartMeta.textContent = 'Chart.js 不可用，仍可在下方查看最近检查记录。';
    return;
  }

  delete state.chart.options.scales.y.title;
  delete state.chart.options.scales.y.max;

  state.chart.data.datasets = buildChartDatasets(points);
  applyChartFullRange(rows);
  tuneChartAnimation(points.length);
  state.chart.update();
}

function buildChartDatasets(cfPoints) {
  const datasets = [
    lineDataset({
      label: 'Cloudflare',
      data: cfPoints,
      color: '#159754',
      fill: 'origin',
      fillStrength: 1.18,
      order: 3,
    }),
  ];

  return datasets;
}

function lineDataset({ label, data, color, fill, fillStrength = 1, order }) {
  const fillEnabled = Boolean(fill);
  const alpha = fillEnabled ? Math.round(clampNumber(0.08 * fillStrength, 0.04, 0.14) * 100) / 100 : 0;
  return {
    label,
    data: data || [],
    parsing: false,
    borderColor: color,
    backgroundColor: fillEnabled ? hexToRgba(color, alpha) : 'transparent',
    borderWidth: fillEnabled ? 1.5 : 1.5,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointHitRadius: 6,
    pointBackgroundColor: color,
    pointBorderColor: '#ffffff',
    pointBorderWidth: 1.5,
    tension: 0.3,
    fill,
    spanGaps: false,
    order,
  };
}

function chartHoverLinePlugin() {
  return {
    id: 'nstatusHoverLine',
    afterEvent(chart, args) {
      const event = args.event;
      const area = chart.chartArea;
      if (!event || !area) return;
      if (event.type === 'mouseout') {
        state.chartHoverX = null;
        state.chartHoverY = null;
        state.chartHoverValue = null;
        args.changed = true;
        return;
      }
      if (event.x >= area.left && event.x <= area.right && event.y >= area.top && event.y <= area.bottom) {
        state.chartHoverX = event.x;
        state.chartHoverY = event.y;
        state.chartHoverValue = chart.scales?.x?.getValueForPixel(event.x) ?? null;
        args.changed = true;
      }
    },
    afterDatasetsDraw(chart) {
      const active = chart.tooltip?.getActiveElements?.() || [];
      const area = chart.chartArea;
      if (!area) return;

      const fallback = active[0]
        ? chart.getDatasetMeta(active[0].datasetIndex)?.data?.[active[0].index]?.x
        : null;
      const x = Number.isFinite(Number(state.chartHoverX)) ? Number(state.chartHoverX) : Number(fallback);
      const y = Number.isFinite(Number(state.chartHoverY)) ? Number(state.chartHoverY) : null;
      if (!Number.isFinite(x)) return;
      const { ctx } = chart;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(95,107,120,.38)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.stroke();
      if (y !== null) {
        ctx.beginPath();
        ctx.moveTo(area.left, y);
        ctx.lineTo(area.right, y);
        ctx.stroke();
      }
      ctx.restore();
    },
  };
}

function registerChartNearestTimeMode() {
  if (!window.Chart || window.Chart.Interaction?.modes?.nearestTime) return;

  window.Chart.Interaction.modes.nearestTime = function nearestTime(chart, event, options, useFinalPosition) {
    const xScale = chart.scales?.x;
    const area = chart.chartArea;
    if (!xScale || !area || !event) return [];

    const x = event.x;
    const y = event.y;
    if (x < area.left || x > area.right || y < area.top || y > area.bottom) return [];

    const targetValue = xScale.getValueForPixel(x);
    state.chartHoverValue = targetValue;
    const maxDistanceSec = nearestTooltipWindowSec(chart);
    const items = [];

    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      if (!meta || meta.hidden) return;

      let best = null;
      let bestDistance = Infinity;
      const data = dataset.data || [];
      if (data.length > 0) {
        // Binary search for nearest x value (data is sorted by x)
        let lo = 0, hi = data.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (Number(data[mid]?.x || 0) < targetValue) lo = mid + 1;
          else hi = mid;
        }
        // Check lo-1, lo, lo+1 for actual nearest
        for (let idx = Math.max(0, lo - 1); idx <= Math.min(data.length - 1, lo + 1); idx++) {
          const px = Number(data[idx]?.x);
          const py = Number(data[idx]?.y);
          if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
          const distance = Math.abs(px - targetValue);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = { datasetIndex, index: idx, element: meta.data[idx] };
          }
        }
      }

      if (best && best.element && bestDistance <= maxDistanceSec) {
        items.push(best);
      }
    });

    return items.sort((a, b) => a.datasetIndex - b.datasetIndex);
  };
}

function chartHoverTimestamp() {
  const value = Number(state.chartHoverValue);
  return Number.isFinite(value) ? value : null;
}

function nearestTooltipWindowSec(chart) {
  const range = currentChartRange();
  if (range) {
    return Math.max(30 * 60, (range.max - range.min) / 6);
  }

  const xScale = chart?.scales?.x;
  if (xScale) {
    return Math.max(30 * 60, (Number(xScale.max) - Number(xScale.min)) / 6);
  }

  return 30 * 60;
}

function applyChartFullRange(rows) {
  if (!state.chart) return;
  const xs = (rows || []).map(p => Number(p.x)).filter(Number.isFinite);
  const xScale = state.chart.options.scales.x;

  if (!xs.length) {
    delete xScale.min;
    delete xScale.max;
    updateChartZoomButton();
    return;
  }

  const { min, max } = minMax(xs);
  const span = max - min || 300;
  const pad = Math.max(60, Math.round(span * 0.025));
  state.chartZoomFullMin = min - pad;
  state.chartZoomFullMax = max + pad;
  delete xScale.min;
  delete xScale.max;
  updateChartZoomButton();
}

function handleChartWheel(event) {
  if (!state.chart || !state.chartZoomFullMin || !state.chartZoomFullMax) return;

  const chart = state.chart;
  const pos = getChartCanvasPoint(event);

  if (!pos) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const fullMin = state.chartZoomFullMin;
  const fullMax = state.chartZoomFullMax;
  const fullSpan = Math.max(1, fullMax - fullMin);
  const currentMin = Number.isFinite(Number(chart.options.scales.x.min)) ? Number(chart.options.scales.x.min) : fullMin;
  const currentMax = Number.isFinite(Number(chart.options.scales.x.max)) ? Number(chart.options.scales.x.max) : fullMax;
  const currentSpan = Math.max(1, currentMax - currentMin);
  const minSpan = Math.max(5 * 60, fullSpan / 120);
  const zoomFactor = event.deltaY < 0 ? 0.82 : 1.22;
  let nextSpan = clampNumber(currentSpan * zoomFactor, minSpan, fullSpan);

  const pointerRatio = clampNumber((pos.x - pos.area.left) / Math.max(1, pos.area.right - pos.area.left), 0, 1);
  const pointerValue = currentMin + currentSpan * pointerRatio;
  let nextMin = pointerValue - nextSpan * pointerRatio;
  let nextMax = nextMin + nextSpan;

  if (nextMin < fullMin) {
    nextMin = fullMin;
    nextMax = nextMin + nextSpan;
  }

  if (nextMax > fullMax) {
    nextMax = fullMax;
    nextMin = nextMax - nextSpan;
  }

  if (nextSpan >= fullSpan * 0.995) {
    delete chart.options.scales.x.min;
    delete chart.options.scales.x.max;
  } else {
    chart.options.scales.x.min = nextMin;
    chart.options.scales.x.max = nextMax;
  }

  chart.update('none');
  updateChartZoomButton();
}

function handleChartPointerDown(event) {
  if (!state.chart || event.button > 0) return;
  const pos = getChartCanvasPoint(event);
  if (!pos) return;

  const range = currentChartRange();
  if (!range) return;

  event.preventDefault();
  event.stopPropagation();
  els.chartCanvasWrap.setPointerCapture?.(event.pointerId);
  els.chartCanvasWrap.classList.add('is-panning');
  state.chartPan = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startMin: range.min,
    startMax: range.max,
    moved: false,
  };
}

function handleChartPointerMove(event) {
  const pan = state.chartPan;
  if (!pan || pan.pointerId !== event.pointerId || !state.chart) return;

  const chart = state.chart;
  const area = chart.chartArea;
  const fullMin = state.chartZoomFullMin;
  const fullMax = state.chartZoomFullMax;
  if (!area || !fullMin || !fullMax) return;

  event.preventDefault();
  event.stopPropagation();

  const pixelDelta = event.clientX - pan.startClientX;
  if (Math.abs(pixelDelta) > 2) pan.moved = true;

  const chartWidth = Math.max(1, area.right - area.left);
  const span = Math.max(1, pan.startMax - pan.startMin);
  const valueDelta = -(pixelDelta / chartWidth) * span;
  const next = clampChartRange(pan.startMin + valueDelta, pan.startMax + valueDelta, fullMin, fullMax);

  chart.options.scales.x.min = next.min;
  chart.options.scales.x.max = next.max;
  chart.update('none');
  updateChartZoomButton();
}

function handleChartPointerUp(event) {
  const pan = state.chartPan;
  if (!pan || pan.pointerId !== event.pointerId) return;

  els.chartCanvasWrap.releasePointerCapture?.(event.pointerId);
  els.chartCanvasWrap.classList.remove('is-panning');
  state.chartPan = null;
}

function getChartCanvasPoint(event) {
  if (!state.chart) return null;
  const chart = state.chart;
  const area = chart.chartArea;
  const rect = chart.canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (chart.width / Math.max(1, rect.width));
  const y = (event.clientY - rect.top) * (chart.height / Math.max(1, rect.height));

  if (!chart.scales?.x || !area || x < area.left || x > area.right || y < area.top || y > area.bottom) {
    return null;
  }

  return { x, y, area };
}

function currentChartRange() {
  if (!state.chart || !state.chartZoomFullMin || !state.chartZoomFullMax) return null;
  const xScale = state.chart.options.scales.x || {};
  const min = Number.isFinite(Number(xScale.min)) ? Number(xScale.min) : state.chartZoomFullMin;
  const max = Number.isFinite(Number(xScale.max)) ? Number(xScale.max) : state.chartZoomFullMax;
  return { min, max };
}

function resetChartZoom() {
  if (!state.chart) return;
  state.chartPan = null;
  els.chartCanvasWrap?.classList.remove('is-panning');
  delete state.chart.options.scales.x.min;
  delete state.chart.options.scales.x.max;
  state.chart.update('none');
  updateChartZoomButton();
}

function updateChartZoomButton() {
  if (!els.chartReset || !state.chart) return;
  const xScale = state.chart.options.scales.x || {};
  const min = Number(xScale.min);
  const max = Number(xScale.max);
  const hasExplicitRange = Number.isFinite(min) || Number.isFinite(max);
  const fullMin = Number(state.chartZoomFullMin);
  const fullMax = Number(state.chartZoomFullMax);
  const epsilon = Math.max(1, Math.abs(fullMax - fullMin) * 0.001);
  const zoomed = hasExplicitRange && (
    !Number.isFinite(fullMin) ||
    !Number.isFinite(fullMax) ||
    min > fullMin + epsilon ||
    max < fullMax - epsilon
  );
  els.chartReset.disabled = !zoomed;
}

function expectedChartGapSec(range) {
  const intervalSec = Math.max(300, Number(state.selectedTargetIntervalSec || 300));
  return Math.max(300, Math.round(intervalSec * 1.6));
}

function chartLineBreakGapSec(range) {
  const intervalSec = Math.max(300, Number(state.selectedTargetIntervalSec || 300));
  return Math.max(expectedChartGapSec(range), Math.round(intervalSec * 6));
}

function rangeLabel(range) {
  if (range === 'month') return '最近 30 天';
  if (range === 'week') return '最近 7 天';

  return '最近 24 小时';
}

function formatAxisChartTime(sec, range) {
  const d = new Date(Number(sec) * 1000);

  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());

  if (range === 'day') {
    return `${hh}:${mi}`;
  }

  return `${mm}-${dd} ${hh}:${mi}`;
}

function formatFullChartTime(sec) {
  const d = new Date(Number(sec) * 1000);

  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function displayTarget(t) {
  if (t.type === 'http') {
    try {
      return new URL(t.url).hostname;
    } catch (_) {
      return t.url || '';
    }
  }

  const host = maskIpLikeHost(t.target_host);
  return `${host || ''}`;
}

function serviceMetaHtml(t) {
  const region = regionShort(t);
  const parts = [];

  if (region) {
    parts.push(`<span class="meta-piece">${escapeHtml(region)}</span>`);
  }

  return parts.join('<span class="meta-sep">·</span>');
}

function regionShort(t) {
  const code = String(t.probe_region || 'auto').toLowerCase();

  if (!code || code === 'auto') {
    return '';
  }

  const map = {
    apac: 'APAC',
    weur: '西欧',
    eeur: '东欧',
    enam: '美国东部',
    wnam: '美国西部',
    sam: '南美洲',
    oc: '大洋洲',
    afr: '非洲',
    me: '中东',
  };

  const label = map[code] || t.region_label || code.toUpperCase();
  const enabled = Boolean(state.data?.region_proxy_enabled);

  return enabled ? label : `${label} · 区域代理未开启`;
}

function chartMetaHtml(range, samples, latestColo, mode = '') {
  const parts = [
    escapeHtml(rangeLabel(range)),
    `${Number(samples || 0)} 个采样点`,
  ];

  if (mode) {
    parts.push(escapeHtml(mode));
  }

  return parts.join(' · ');
}

function maskIpLikeHost(host) {
  const value = String(host || '').trim();

  if (!value) {
    return value;
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split('.');
    return `${parts[0]}.${parts[1]}.*.*`;
  }

  return value;
}

function statusTimezoneOffsetMinutes() {
  const n = Number(state.data?.timezone?.offset_minutes ?? 480);
  return Number.isFinite(n) ? n : 480;
}

function currentLocalDay() {
  const offset = statusTimezoneOffsetMinutes();
  const d = new Date((Date.now() / 1000 + offset * 60) * 1000);

  return d.toISOString().slice(0, 10);
}

function formatCheckExtraHtml(c) {
  const parts = [];

  if (c?.missed) {
    parts.push('<span class="warn-text">监控器漏掉了本次 5 分钟检查</span>');
  }

  if (c?.probe_region) {
    parts.push(`<span>区域 <strong>${escapeHtml(regionShort(c) || c.probe_region)}</strong></span>`);
  }

  if (c?.error) {
    parts.push(`<span class="fail-text">${escapeHtml(String(c.error))}</span>`);
  }

  return parts.join(' · ') || '-';
}

function describeGroup(name, total, up) {
  const lower = String(name || '').toLowerCase();

  if (lower.includes('web')) return `${total} 个网站服务`;
  if (lower.includes('vps')) return `${total} 个 VPS 节点`;
  if (lower.includes('api')) return `${total} 个 API 服务`;
  if (lower.includes('panel')) return `${total} 个控制面板服务`;

  return `${up}/${total} 个服务运行正常`;
}

function displayGroupName(name) {
  const value = String(name || '').trim();
  if (/^(default|nodes?)$/i.test(value)) return value.toLowerCase() === 'default' ? '默认分组' : '节点';
  return value || '默认分组';
}

function targetSearchText(t) {
  return [
    t.name,
    t.group_name,
    t.type,
    t.target_host,
    t.target_port,
    t.url,
    t.probe_region,
    t.region_label,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function indexSummaries(rows) {
  const map = new Map();

  rows.forEach(s => {
    map.set(`${s.target_id}:${s.day}`, s);
  });

  return map;
}

function groupBy(arr, fn) {
  return arr.reduce((acc, x) => {
    const k = fn(x);
    (acc[k] ||= []).push(x);
    return acc;
  }, {});
}

function avgLatency(rows) {
  const nums = rows.map(t => Number(t.latency_ms)).filter(Number.isFinite);

  if (!nums.length) {
    return null;
  }

  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}
