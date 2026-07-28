import { escapeAttr, escapeHtml } from './js/shared/html.js';
import {
  billingCycleSuffix,
  formatDateOnly,
  isLifetimeBilling,
  normalizeBillingCycle,
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
  formatLocationLabel,
  formatMachineUptime,
  minMax,
  normalizeCityName,
  pad,
  percent,
  timeAgoSec,
} from './js/shared/format.js';
import { trafficForTarget, trafficProgressHtml } from './js/shared/traffic.js';
import { GROUP_BY_OPTIONS, groupByDimension, displayGroupName as sharedDisplayGroupName } from './js/shared/grouping.js?v=20260725-machine-types1';
import { canShowTemperature, hasGpuData, hasTemperatureData } from './js/shared/hardware.js';
import { countryByCode, normalizeCountryCode } from './js/shared/target-catalogs.js';
import {
  chartColorToRgb,
  clampChartRange,
  countChartGaps,
  countMissedChecks,
  filterChecksByRange,
  hexToRgba,
  trimEmptyPointEdges,
} from './js/shared/chart-data.js';
import { bindNodeQualityModal, buildNqModalHtml, targetHasNodeQuality } from './js/shared/nodequality.js?v=20260729-beta24-imgbed1';
import { DEFAULT_APPEARANCE, normalizeAppearance } from './js/shared/appearance.js';
import { unlockState } from './js/shared/unlock.js?v=20260727-dns-unlock1';
import { targetSlaPercentage } from './js/shared/sla.js';
import { failedPingTargetsNear, latestPingByTarget, nextPingTargetSelection, normalizeLatencySample, pingLossSeries, pingSampleWindowSec } from './js/shared/ping.js';
import { initializeFrontendTheme, publishThemeStatus } from './js/themes.js?v=20260729-beta23';

const $ = (sel) => document.querySelector(sel);

requestAnimationFrame(() => document.body.classList.add('is-loaded'));

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
  pingVisibleTargets: null,
  externalLatencySources: [],
  latencyVisibleSources: null,
  latencyChartSources: [],
  latencyChartSamples: [],
  metricsCache: new Map(),
  pingsCache: new Map(),
  groupByMode: localStorage.getItem('nstatus.groupByMode') || 'group',
  statusRequestSeq: 0,
  statusController: null,
  lastGroupsRenderKey: '',
  appearance: normalizeAppearance(DEFAULT_APPEARANCE),
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
  pingLossStats: $('#pingLossStats'),
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

if (els.pingLossStats) {
  els.pingLossStats.addEventListener('click', (event) => {
    const item = event.target.closest('.ping-loss-item[data-target-id]');
    if (!item) return;
    event.stopPropagation();
    const allIds = [...els.pingLossStats.querySelectorAll('.ping-loss-item[data-target-id]')]
      .map(element => element.dataset.targetId);
    if (state.selectedMetric === 'latency') {
      state.latencyVisibleSources = nextPingTargetSelection(state.latencyVisibleSources, item.dataset.targetId, allIds);
      applyLatencySourceSelection();
    } else if (state.selectedMetric === 'ping') {
      state.pingVisibleTargets = nextPingTargetSelection(state.pingVisibleTargets, item.dataset.targetId, allIds);
      applyPingTargetSelection();
    }
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
initializeFrontendTheme();
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
    const res = await fetch(api('/api/status?days=30&lite=1'), {
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
  applyAppearance(data?.frontend?.appearance || { site_name: data.name });

  const targets = data.targets || [];
  const checked = targets.filter(targetHasStatus);
  const stale = checked.filter(t => isTargetStale(t));
  const fresh = checked.filter(t => !isTargetStale(t));
  const up = fresh.filter(targetIsUp).length;
  const down = checked.filter(t => !targetIsUp(t)).length;
  const unknown = targets.length - checked.length;
  const delayed = stale.filter(targetIsUp).length;
  const avg = avgLatency(fresh);

  let bannerText = appearanceText(state.appearance.banner_normal);
  let bannerClass = 'system-banner';

  if (down > 0) {
    bannerText = appearanceText(state.appearance.banner_down, down);
    bannerClass += ' down';
  } else if (delayed > 0) {
    bannerText = appearanceText(state.appearance.banner_degraded, delayed);
    bannerClass += ' degraded';
  } else if (unknown > 0) {
    bannerText = appearanceText(state.appearance.banner_unknown, unknown);
    bannerClass += ' degraded';
  }

  if (els.globalBanner) {
    els.globalBanner.className = bannerClass;
    els.globalBanner.replaceChildren();
    const strong = document.createElement('strong');
    strong.textContent = bannerText;
    els.globalBanner.append(strong);
  }

  if (els.subline) {
    els.subline.textContent = appearanceText(state.appearance.hero_subtitle);
    els.subline.hidden = !state.appearance.hero_subtitle;
  }

  if (els.summaryLine) {
    els.summaryLine.innerHTML = [
      `<span>${escapeHtml(appearanceText(state.appearance.summary_total, targets.length))}</span>`,
      `<span>${escapeHtml(appearanceText(state.appearance.summary_up, up))}</span>`,
      `<span>${escapeHtml(appearanceText(state.appearance.summary_down, down))}</span>`,
      `<span>${escapeHtml(appearanceText(state.appearance.summary_degraded, delayed))}</span>`,
      `<span>${escapeHtml(appearanceText(state.appearance.summary_unknown, unknown))}</span>`,
      `<span>${escapeHtml(appearanceText(state.appearance.summary_latency, 0, avg == null ? '-' : `${avg} ms`))}</span>`,
      `<span>${escapeHtml(appearanceText(state.appearance.summary_updated, 0, fmtTime(Date.now() / 1000, 'short')))}</span>`,
    ].join('');
  }

  renderIncidentLog(data);
  renderGroupsIfChanged(data);
  publishThemeStatus(data);
}

function renderGroupsIfChanged(data) {
  const key = statusGroupsRenderKey(data);
  if (key === state.lastGroupsRenderKey) return;
  state.lastGroupsRenderKey = key;
  renderGroups(data);
}

function statusGroupsRenderKey(data) {
  return JSON.stringify({
    groupByMode: state.groupByMode,
    filter: state.filteredText,
    // Relative time labels only need periodic refresh when status data is unchanged.
    relativeBucket: Math.floor(Date.now() / 300000),
    appearance: state.appearance,
    days: data?.days || [],
    targets: data?.targets || [],
    summaries: data?.summaries || [],
  });
}

function appearanceText(template, count = 0, value = '') {
  return String(template || '')
    .replaceAll('{count}', String(count))
    .replaceAll('{value}', String(value))
    .replaceAll('{site_name}', state.appearance.site_name);
}

function applyAppearance(raw) {
  state.appearance = normalizeAppearance(raw || {});
  document.title = state.appearance.page_title || state.appearance.site_name;
  const rootStyle = document.documentElement?.style;
  rootStyle?.setProperty('--appearance-accent', state.appearance.accent_color);
  rootStyle?.setProperty('--appearance-bg', state.appearance.page_background);
  rootStyle?.setProperty('--appearance-surface', state.appearance.surface_color);
  rootStyle?.setProperty('--appearance-brand-logo-height', `${state.appearance.brand_logo_height}px`);
  rootStyle?.setProperty('--appearance-header-image-width', `${state.appearance.header_right_image_width}px`);
  let favicon = document.querySelector('link[rel~="icon"]');
  if (state.appearance.favicon_url) {
    if (!favicon) { favicon = document.createElement('link'); favicon.rel = 'icon'; document.head.appendChild(favicon); }
    favicon.href = state.appearance.favicon_url;
  } else if (favicon) favicon.remove();
  if (els.brandName) els.brandName.textContent = state.appearance.site_name;
  const brand = document.querySelector('.brand');
  if (brand) {
    brand.href = state.appearance.brand_home_url;
    brand.setAttribute('aria-label', `${state.appearance.site_name} 首页`);
    let logo = brand.querySelector('.brand-custom-logo');
    if (state.appearance.brand_logo_url) {
      if (!logo) { logo = document.createElement('img'); logo.className = 'brand-custom-logo'; brand.insertBefore(logo, brand.firstChild); }
      logo.src = state.appearance.brand_logo_url;
      logo.alt = state.appearance.brand_logo_alt;
      logo.hidden = false;
    } else if (logo) logo.hidden = true;
    let subtitle = brand.querySelector('.brand-subtitle');
    if (state.appearance.site_subtitle) {
      if (!subtitle) { subtitle = document.createElement('small'); subtitle.className = 'brand-subtitle'; brand.appendChild(subtitle); }
      subtitle.textContent = state.appearance.site_subtitle;
      subtitle.hidden = false;
    } else if (subtitle) subtitle.hidden = true;
  }
  const right = document.querySelector('.topbar-cf');
  if (right) {
    right.hidden = state.appearance.header_right_mode === 'hidden';
    if (state.appearance.header_right_mode === 'text') {
      right.innerHTML = state.appearance.header_right_link
        ? `<a class="appearance-header-text" href="${escapeAttr(state.appearance.header_right_link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(state.appearance.header_right_text)}</a>`
        : `<span class="appearance-header-text">${escapeHtml(state.appearance.header_right_text)}</span>`;
    } else if (state.appearance.header_right_mode === 'image') {
      right.innerHTML = state.appearance.header_right_image_url
        ? `<a class="cf-logo" href="${escapeAttr(state.appearance.header_right_link || '#')}" target="_blank" rel="noopener noreferrer"><img class="cf-logo-img" src="${escapeAttr(state.appearance.header_right_image_url)}" alt="${escapeAttr(state.appearance.header_right_image_alt)}"></a>`
        : '';
    }
  }
  const topbar = document.querySelector('.topbar');
  if (topbar) topbar.hidden = !state.appearance.show_header;
  const searchRow = document.querySelector('.search-row');
  if (searchRow) searchRow.hidden = !state.appearance.show_search;
  if (els.globalBanner) els.globalBanner.hidden = !state.appearance.show_banner;
  if (els.summaryLine) els.summaryLine.hidden = !state.appearance.show_summary;
  if (els.incidentLogPanel) els.incidentLogPanel.hidden = !state.appearance.show_incidents;
  if (els.inlineChartPanel && !state.appearance.show_chart) els.inlineChartPanel.hidden = true;
  if (els.checksPanel) els.checksPanel.hidden = !state.appearance.show_checks;
  const footerRoot = document.querySelector('.footer');
  if (footerRoot) footerRoot.hidden = !state.appearance.show_footer;
  if (els.serviceSearch) els.serviceSearch.placeholder = state.appearance.search_placeholder;
  const incidentTitle = document.querySelector('#incidentToggle > span');
  if (incidentTitle) incidentTitle.textContent = state.appearance.incident_title;
  const checksTitle = document.querySelector('.checks-head h2');
  if (checksTitle) checksTitle.textContent = state.appearance.checks_title;
  const checksHint = document.querySelector('#checksHint');
  if (checksHint && !state.selectedId) checksHint.textContent = state.appearance.checks_hint;
  if (els.chartTitle && !state.selectedId) els.chartTitle.textContent = state.appearance.chart_title;
  if (els.chartServiceName && !state.selectedId) els.chartServiceName.textContent = state.appearance.chart_unselected;
  const footer = document.querySelector('.footer-left');
  if (footer) {
    footer.textContent = appearanceText(state.appearance.footer_text);
    if (state.appearance.footer_link_text && state.appearance.footer_link_url) footer.insertAdjacentHTML('beforeend', ` <a href="${escapeAttr(state.appearance.footer_link_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(state.appearance.footer_link_text)}</a>`);
  }
}

function targetCityName(t = {}) {
  return normalizeCityName(t?.city || t?.location_city || '');
}

function targetLocationLabel(t = {}) {
  const country = countryByCode(t?.location);
  const countryName = country?.name || String(t?.location || '').trim();
  return formatLocationLabel(countryName, targetCityName(t), t?.location || '');
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
    : state.appearance.incident_empty;

  if (!rows.length) {
    els.incidentBody.innerHTML = `<div class="empty">${escapeHtml(state.appearance.incident_empty_detail)}</div>`;
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

function ensurePublicGroupByBar() {
  let bar = document.getElementById('publicGroupByBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'publicGroupByBar';
    bar.className = 'group-by-bar';
    const host = document.querySelector('.search-row') || document.querySelector('main.main');
    if (host) host.appendChild(bar);
  }
  const selected = state.groupByMode || 'group';
  const options = GROUP_BY_OPTIONS.map(({ id, label }) => `
    <button type="button" class="group-by-option${id === selected ? ' active' : ''}"
      data-group-by="${escapeAttr(id)}" aria-pressed="${id === selected}">${escapeHtml(label)}</button>
  `).join('');

  bar.innerHTML = `
    <span class="group-by-title">${escapeHtml(state.appearance.group_by_title)}</span>
    <div class="group-by-options" role="group" aria-label="${escapeAttr(state.appearance.group_by_title)}">${options}</div>
  `;
  bar.hidden = !state.appearance.show_group_by;

  bar.querySelectorAll('[data-group-by]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextMode = button.dataset.groupBy || 'group';
      if (nextMode === state.groupByMode) return;
      state.groupByMode = nextMode;
      try {
        localStorage.setItem('nstatus.groupByMode', nextMode);
      } catch (_) {}
      state.lastGroupsRenderKey = '';
      if (state.data) renderGroups(state.data);
    });
  });
}

function renderGroups(data) {
  if (!els.groups) return;
  ensurePublicGroupByBar();

  const summaries = indexSummaries(data.summaries || []);
  const days = data.days || [];
  const allTargets = data.targets || [];
  const text = state.filteredText;
  const targets = text
    ? allTargets.filter(target => targetSearchText(target).includes(text))
    : allTargets;

  if (!targets.length) {
    els.groups.innerHTML = `<div class="empty">${escapeHtml(state.appearance.no_search_results)}</div>`;
    if (els.inlineChartPanel) els.inlineChartPanel.hidden = true;
    return;
  }

  const groups = groupByDimension(targets, state.groupByMode || 'group');
  els.groups.innerHTML = Object.entries(groups)
    .map(([name, list], index) => renderGroup(name, list, days, summaries, index))
    .join('');

  document.querySelectorAll('.group-head').forEach((head) => {
    head.addEventListener('click', () => {
      const group = head.closest('.group');
      const toggle = group.querySelector('.group-toggle');
      group.classList.toggle('collapsed');
      if (toggle) toggle.textContent = group.classList.contains('collapsed') ? '+' : '−';
    });
  });

  document.querySelectorAll('.service').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      const nqButton = event.target.closest('.nq-report-btn');
      if (nqButton) {
        openNodeQualityReport(nqButton.dataset.nqTarget, nqButton.dataset.nqName || element.dataset.name);
        return;
      }
      selectService(element.dataset.id, element.dataset.name, element);
    });
  });

  if (state.selectedId) {
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
  const checked = targetHasStatus(t);
  const isUp = targetIsUp(t);
  const stale = checked && isUp && isTargetStale(t);
  const status = checked ? (isUp ? (stale ? '数据延迟' : '运行正常') : '离线') : '待检查';
  const statusClass = checked ? (isUp ? (stale ? 'degraded' : '') : 'down') : 'unknown';
  const selectedClass = t.id === state.selectedId ? ' selected' : '';
  const displayName = serviceDisplayName(t);
  const sla = targetSlaPercentage(t.id, days, summaries);
  const slaValue = sla == null ? '-' : `${sla.toFixed(2)}%`;
  const slaLabel = sla == null ? '最近 30 天 SLA：暂无数据' : `最近 30 天 SLA：${slaValue}`;
  const slaClass = sla == null ? ' sla-unknown' : sla >= 99 ? ' sla-good' : sla >= 95 ? ' sla-warn' : ' sla-bad';
  const hasLatency = targetHasPublicLatency(t);
  const latencyHtml = hasLatency ? serviceCloudflareLatencyHtml(t) : '';
  const trafficProgress = trafficProgressHtml(trafficForTarget(t), 'service-traffic-progress');
  const nqButton = targetHasNodeQuality(t)
    ? `<button type="button" class="nq-report-btn" data-nq-target="${escapeAttr(t.id)}" data-nq-name="${escapeAttr(displayName)}" title="查看 NodeQuality 报告">NQ</button>`
    : '';
  // Metadata badges
  let metaBadges = '';
  if (t.line_type) metaBadges += `<span class="meta-badge meta-line">${escapeHtml(t.line_type)}</span>`;
  if (t.location || targetCityName(t)) {
    const locationText = targetLocationLabel(t);
    if (locationText) metaBadges += `<span class="meta-badge meta-loc">${escapeHtml(locationText)}</span>`;
  }
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
    const priceText = t.price_cny != null
      ? `¥${Number(t.price_cny).toFixed(2)}${cycle}`
      : `${cur} ${t.price}${cycle}`;
    metaBadges += `<span class="meta-badge meta-price">${escapeHtml(priceText)}</span>`;
  }
  const unlockStrip = unlockCompactHtml(t.unlock);

  return `
    <div class="service ${statusClass}${selectedClass}" data-id="${escapeAttr(t.id)}" data-name="${escapeAttr(displayName)}">
      <div class="service-name">
        <span class="service-title-line">
          <span class="service-title-text">${escapeHtml(displayName)}</span>
          ${nqButton}
        </span>
        ${metaBadges ? `<span class="service-meta">${metaBadges}</span>` : ''}
        ${unlockStrip}
      </div>
      <div class="service-status">${status}</div>
      <div class="service-latency${hasLatency ? '' : ' is-placeholder'}"${hasLatency ? '' : ' aria-hidden="true"'}>${latencyHtml}</div>
      <div class="service-sla${slaClass}" title="${escapeAttr(slaLabel)}" aria-label="${escapeAttr(slaLabel)}">
        <strong class="service-sla-value">${slaValue}</strong>
      </div>
      <div class="service-bottom-row${trafficProgress ? ' has-traffic' : ''}">
        <div class="uptime-strip" title="${Number(t.no_public_ip || 0) === 1 ? 'Agent 在线记录' : '最近 30 天可用率'}">
          ${renderBars(t.id, days, summaries)}
        </div>
        ${trafficProgress}
      </div>
    </div>
  `;
}

async function openNodeQualityReport(targetId, targetName = '') {
  if (!targetId) return;
  closeNodeQualityReport();
  const root = document.createElement('div');
  root.className = 'nq-modal-root';
  root.innerHTML = '<div class="nq-modal-backdrop"><div class="nq-modal nq-modal-loading" role="dialog" aria-modal="true"><div class="nq-modal-head"><strong>NodeQuality</strong><button type="button" class="nq-close" data-nq-close aria-label="关闭">×</button></div><div class="nq-loading">正在加载报告...</div></div></div>';
  document.body.appendChild(root);
  const load = async () => {
    try {
      const response = await fetch(api(`/api/nq/${encodeURIComponent(targetId)}`), { cache: 'no-store' });
      const report = await response.json();
      if (!response.ok || !report.ok) throw new Error(report.error || `HTTP ${response.status}`);
      report.name ||= targetName;
      root.innerHTML = buildNqModalHtml(report);
      bindNodeQualityModal(root);
    } catch (error) {
      root.innerHTML = `<div class="nq-modal-backdrop"><div class="nq-modal" role="dialog" aria-modal="true"><div class="nq-modal-head"><strong>NodeQuality</strong><button type="button" class="nq-close" data-nq-close aria-label="关闭">×</button></div><div class="nq-empty">报告加载失败：${escapeHtml(error.message)}</div></div></div>`;
      bindNodeQualityModal(root);
    }
  };
  root.addEventListener('click', (event) => {
    // Only the close button or empty backdrop closes the dialog. A tab is
    // inside the backdrop, so closest('[data-nq-close]') would close it too.
    if (event.target.closest('.nq-close') || event.target.classList.contains('nq-modal-backdrop')) closeNodeQualityReport();
  });
  await load();
}

function closeNodeQualityReport() {
  document.querySelector('.nq-modal-root')?.remove();
}

if (document.addEventListener) {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeNodeQualityReport();
  });
}

function targetHasPublicLatency(target) {
  return Number(target?.no_public_ip || 0) !== 1;
}

function serviceCloudflareLatencyHtml(target) {
  const latency = Number(target?.latency_ms);
  const value = Number(target?.ok) === 1 && Number.isFinite(latency) ? `${Math.round(latency)} ms` : '-';
  return `<strong title="Cloudflare 延迟">${escapeHtml(value)}</strong>`;
}

function pingTargetColor(seed) {
  const palette = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#14b8a6'];
  const text = String(seed || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

function configuredChartColor(value, fallback) {
  const color = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : fallback;
}

function isTargetStale() {
  // Web checks have one source of truth: the latest check result. A successful
  // result remains healthy until a later check fails. Agent freshness is
  // already represented by agent_online from the Worker.
  return false;
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
    const title = s.source === 'agent'
      ? `${day}：Agent 在线率 ${pct.toFixed(2)}% · 在线 ${formatDuration(Number(s.ok_count || 0))} / 已记录 ${formatDuration(Number(s.total || 0))}${todaySuffix}`
      : `${day}: ${pct.toFixed(2)}% (${s.ok_count}/${s.total})${todaySuffix}`;

    return `<span class="daybar ${cls}" style="--i:${index}" title="${title}"></span>`;
  }).join('');
}

async function selectService(id, name, el) {
  const isSame = state.selectedId === id && !els.inlineChartPanel.hidden;

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
    state.externalLatencySources = [];
    state.latencyVisibleSources = null;
    state.latencyChartSources = [];
    state.latencyChartSamples = [];

    if (els.inlineChartPanel) {
      els.inlineChartPanel.hidden = true;
    }

    renderChecksPage();
    return;
  }

  state.selectedId = id;
  state.selectedName = name;
  state.checksPage = 1;
  // Find target type
  const target = (state.data?.targets || []).find(t => t.id === id);
  const hasLatency = targetHasPublicLatency(target);
  state.selectedMetric = hasLatency ? 'latency' : 'cpu';
  state.selectedMetricRange = '1h';
  state.targetMetrics = null;
  state.pingData = null;
  state.pingVisibleTargets = null;
  state.externalLatencySources = [];
  state.latencyVisibleSources = null;
  state.latencyChartSources = [];
  state.latencyChartSamples = [];
  state.selectedTargetIntervalSec = Math.max(300, Number(target?.interval_sec || 300));
  const isHttp = target?.type === 'http';

  document.querySelectorAll('.metric-tab').forEach(b => b.classList.remove('active'));
  document.querySelector(`.metric-tab[data-metric="${hasLatency ? 'latency' : 'cpu'}"]`)?.classList.add('active');
  // Hide metric tabs for HTTP targets (websites)
  document.querySelectorAll('.metric-tab[data-metric]').forEach(b => {
    if (b.dataset.metric === 'latency') {
      b.style.display = hasLatency ? '' : 'none';
    } else {
      const isTemperature = b.dataset.metric === 'temp';
      const isGpu = b.dataset.metric === 'gpu';
      const info = target?.agent_metrics?.vps_info || {};
      b.style.display = isHttp
        || (isTemperature && !hasTemperatureData(info))
        || (isGpu && !hasGpuData(info))
        ? 'none'
        : '';
    }
  });
  const rangeTabs = document.getElementById('rangeTabs');
  const metricRangeTabs = document.getElementById('metricRangeTabs');
  if (rangeTabs) rangeTabs.style.display = hasLatency ? '' : 'none';
  if (metricRangeTabs) metricRangeTabs.style.display = hasLatency ? 'none' : '';
  document.querySelectorAll('.metric-range-tab').forEach(b => b.classList.remove('active'));
  document.querySelector('.metric-range-tab[data-range="1h"]')?.classList.add('active');

  el?.classList.add('selected');
  attachInlineChart(el);

  if (hasLatency) {
    await loadChecks(id, name, target, { hours: rangeHours('day') });
  } else {
    els.chartTitle.textContent = 'CPU 使用率';
    els.chartServiceName.textContent = `${name} CPU`;
    els.chartMeta.textContent = 'Agent 在线数据';
    await ensureTargetMetricsLoaded();
    updateMetricsChart();
  }
}

function attachInlineChart(serviceEl) {
  if (!els.inlineChartPanel) return;

  if (!state.appearance.show_chart) {
    els.inlineChartPanel.hidden = true;
    return;
  }

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
    els.chartTitle.textContent = state.appearance.chart_title;
    els.chartMeta.textContent = '正在加载检查记录...';
    els.chartServiceName.textContent = `${name} ${state.appearance.chart_title}`;
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

    const [checksRes, latencyRes] = await Promise.all([
      fetch(api(`/api/checks?target_id=${encodeURIComponent(id)}&limit=${encodeURIComponent(checksLimit)}&hours=${encodeURIComponent(checksHours)}`), { cache: 'no-store' }),
      fetch(api(`/api/latency?target_id=${encodeURIComponent(id)}&hours=${encodeURIComponent(Math.min(168, checksHours))}`), { cache: 'no-store' }).catch(() => null),
    ]);

    const [data, latencyData] = await Promise.all([
      checksRes.json(),
      latencyRes?.ok ? latencyRes.json().catch(() => null) : null,
    ]);

    if (state.selectedId !== id) return;

    if (!checksRes.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${checksRes.status}`);
    }

    state.allChecks = data.checks || [];
    state.dailyPoints = data.daily_points || [];
    state.checksSource = data.source || '';
    state.externalLatencySources = latencyData?.ok && Array.isArray(latencyData.sources) ? latencyData.sources : [];
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
    state.externalLatencySources = [];
    state.latencyChartSources = [];
    state.latencyChartSamples = [];

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
      params.set('max_points', String(({ '1h': 3600, '6h': 1800, '24h': 1200 }[state.selectedMetricRange] || 1200)));
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
  if (!state.appearance.show_vps_details) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  const m = state.targetMetrics;
  const latest = m?.latest || {};
  const info = m?.latest?.vps_info || {};
  const tempTab = document.querySelector('.metric-tab[data-metric="temp"]');
  if (tempTab) tempTab.style.display = hasTemperatureData(info) ? '' : 'none';
  const gpuTab = document.querySelector('.metric-tab[data-metric="gpu"]');
  if (gpuTab) gpuTab.style.display = hasGpuData(info) ? '' : 'none';
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
  const configuredLocation = targetLocationLabel(selectedTarget || {});
  if (configuredLocation) {
    systemItems.push(vpsItem('位置', configuredLocation));
  } else if (info.city || info.region || info.country) {
    const loc = formatLocationLabel(info.country || info.region || '', info.city || '', [info.city, info.region, info.country].filter(Boolean).join(' · '));
    systemItems.push(vpsItem('位置', loc));
  }

  const networkItems = [];
  if (traffic.enabled) {
    if (traffic.mode_label) networkItems.push(vpsItem('流量计费', traffic.mode_label));
    networkItems.push(vpsItem('累计接收', fmtBytes(traffic.rx_bytes || 0)));
    networkItems.push(vpsItem('累计发送', fmtBytes(traffic.tx_bytes || 0)));
    networkItems.push(vpsItem('计费周期流量', `${fmtBytes(traffic.total_bytes || 0)}${traffic.quota_bytes ? ' / ' + fmtBytes(traffic.quota_bytes) : ''}${traffic.percent != null ? ' · ' + traffic.percent + '%' : ''}${traffic.reset_day ? ' · ' + traffic.reset_day + '日重置' : ''}`));
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
  const temperatureItems = temperatureSensorItems(info);

  const summaryBits = [];
  if (latest.hostname) summaryBits.push(latest.hostname);
  if (configuredLocation) summaryBits.push(configuredLocation);
  else if (info.os) summaryBits.push(info.os);
  if (info.cpu_model) summaryBits.push(info.cpu_model);
  if (uptimeSec > 0) summaryBits.push(formatMachineUptime(uptimeSec));
  const summary = summaryBits.slice(0, 3).join(' · ') || '系统与网络信息';
  bar.innerHTML = `
    <button type="button" class="vps-info-toggle" id="vpsInfoToggle" aria-expanded="false">
      <span class="vps-info-toggle-label">${escapeHtml(state.appearance.vps_details_label)}</span>
      <span class="vps-info-toggle-summary">${escapeHtml(summary)}</span>
      <span class="vps-info-toggle-icon" aria-hidden="true"></span>
    </button>
    <div class="vps-info-body" id="vpsInfoBody">
      <section class="vps-info-section"><h4>系统信息</h4>${systemItems.join('')}</section>
      <section class="vps-info-section"><h4>网络与负载</h4>${networkItems.join('')}</section>
      ${temperatureItems.length ? `<section class="vps-info-section vps-temperature-section"><h4>温度传感器</h4>${temperatureItems.join('')}</section>` : ''}
    </div>
  `;
  bar.hidden = false;
  bar.classList.add('is-collapsible');
  bar.classList.remove('is-expanded');
  const toggle = bar.querySelector('#vpsInfoToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const expanded = bar.classList.toggle('is-expanded');
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
  }
}

function unlockServices(unlock) {
  const primary = ['tiktok', 'disney', 'netflix', 'youtube', 'amazonpv', 'chatgpt'];
  const services = (Array.isArray(unlock?.services) ? unlock.services : [])
    .filter(service => service?.name && (service.status || service.region || service.method));
  const normalized = (service) => String(service.id || service.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return primary
    .map(id => services.find(service => normalized(service).includes(id)))
    .filter(Boolean);
}

function unlockCompactHtml(unlock) {
  const services = unlockServices(unlock);
  if (!services.length) return '';
  const states = services.map(service => ({ service, stateName: unlockState(service) }));
  const details = states.map(({ service }) => [service.name, service.status, service.region, service.method].filter(Boolean).join(' · ')).join('\n');
  const labels = states.map(({ service }) => `<span class="unlock-service-label" title="${escapeAttr(service.name)}">${escapeHtml(service.name)}</span>`).join('');
  const countries = states.map(({ service, stateName }) => {
    const title = [service.name, service.status, service.region, service.method].filter(Boolean).join(' · ');
    return `<strong class="unlock-country ${stateName}" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}">${escapeHtml(unlockCountryCode(service, stateName))}</strong>`;
  }).join('');
  return `<div class="unlock-grid" title="${escapeAttr(details)}" aria-label="IPv4 解锁状态">${labels}${countries}</div>`;
}

function unlockCountryCode(service, stateName) {
  if (stateName === 'bad') return '--';
  const raw = String(service?.region || '').replace(/^\[|\]$/g, '').trim();
  if (!raw || /^(?:null|none|-)$/i.test(raw)) return '--';
  const normalized = raw.toUpperCase().replace(/[^A-Z\u4E00-\u9FFF]/g, '');
  const aliases = {
    中国: 'CN', 香港: 'HK', 台湾: 'TW', 日本: 'JP', 韩国: 'KR', 新加坡: 'SG',
    UNITEDSTATES: 'US', UNITEDKINGDOM: 'GB', HONGKONG: 'HK', SINGAPORE: 'SG',
    JAPAN: 'JP', KOREA: 'KR', TAIWAN: 'TW', CHINA: 'CN',
  };
  if (aliases[normalized]) return aliases[normalized];
  const knownCodes = ['HK', 'SG', 'US', 'GB', 'JP', 'KR', 'TW', 'CN', 'CA', 'AU', 'IN', 'DE', 'FR', 'NL', 'BR', 'RU'];
  if (knownCodes.includes(normalized)) return normalized;
  return knownCodes.find(code => normalized.endsWith(code)) || '--';
}

function temperatureSensorItems(info = {}) {
  if (!hasTemperatureData(info)) return [];
  const items = [];
  const add = (label, value) => {
    if (Number.isFinite(Number(value))) items.push(vpsItem(label, `${Number(value).toFixed(1)}°C`));
  };
  add('CPU', info.cpu_temp_c);
  add('GPU', info.gpu_temp_c);
  const sensors = Array.isArray(info.temperature_sensors) ? info.temperature_sensors : [];
  for (const sensor of sensors.slice(0, 16)) {
    const kind = { motherboard: '主板', disk: '硬盘', chipset: '芯片组', other: '传感器' }[sensor?.kind] || '传感器';
    add(`${kind} · ${sensor?.label || sensor?.id || '-'}`, sensor?.temp_c);
  }
  if (!sensors.some(sensor => sensor?.kind === 'motherboard')) add('主板', info.motherboard_temp_c);
  if (!sensors.some(sensor => sensor?.kind === 'disk')) add('硬盘', info.disk_temp_c);
  if (!sensors.some(sensor => sensor?.kind === 'chipset')) add('芯片组', info.chipset_temp_c);
  return items;
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
        max_points_per_target: String(({ '1h': 360, '6h': 360, '24h': 480 }[range] || 360)),
      });
      const res = await fetch(api(`/api/agent/pings?${params}`), { cache: 'no-store' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Ping 数据加载失败');
      state.pingData = normalizePingPayload(data);
      state.pingsCache.set(cacheKey, { at: Date.now(), data: state.pingData });
    }
  } catch (err) {
    state.pingData = { pings: [] };
    els.chartMeta.textContent = `Ping 数据加载失败：${err.message}`;
    renderPingLossStats([]);
    if (state.chart) { state.chart.data.datasets = []; state.chart.update(); }
    return;
  }

  const pings = state.pingData.pings || [];
  const byTarget = new Map();
  for (const p of pings) {
    const targetId = String(p.target_id || '');
    if (!targetId) continue;
    const arr = byTarget.get(targetId) || [];
    const ok = p.ok === undefined ? Number(p.latency_ms) >= 0 : Number(p.ok) === 1;
    arr.push({ x: Number(p.ts), y: ok && Number(p.latency_ms) >= 0 ? Number(p.latency_ms) : null });
    byTarget.set(targetId, arr);
  }

  if (!state.chart) return;
  const datasets = [];
  let idx = 0;
  const targets = state.pingData.targets || [];
  const targetById = new Map(targets.map(target => [String(target.id), target]));
  const targetIds = [
    ...targets.map(target => String(target.id)),
    ...[...byTarget.keys()].filter(id => !targetById.has(String(id))),
  ];
  for (const tid of targetIds) {
    const points = byTarget.get(tid) || [];
    const tgt = targetById.get(String(tid)) || {};
    const color = configuredChartColor(tgt.color, PING_COLORS[idx % PING_COLORS.length]);
    const label = tgt.name || tid;
    datasets.push({
      label,
      pingTargetId: String(tid),
      data: points.sort((a, b) => a.x - b.x),
      borderColor: color,
      borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 6,
      pointBackgroundColor: color,
      tension: 0.3, fill: false, spanGaps: true,
      hidden: state.pingVisibleTargets instanceof Set && !state.pingVisibleTargets.has(String(tid)),
    });
    idx++;
  }
  const visibleTargetIds = state.pingVisibleTargets instanceof Set
    ? targetIds.filter(id => state.pingVisibleTargets.has(String(id)))
    : targetIds;
  datasets.push({
    label: '丢包率',
    packetLoss: true,
    data: pingLossSeries(pings, visibleTargetIds),
    yAxisID: 'packetLoss',
    borderColor: 'rgba(202, 138, 4, 0.38)',
    backgroundColor: 'rgba(250, 204, 21, 0.10)',
    borderWidth: 1,
    pointRadius: 0,
    pointHoverRadius: 3,
    pointHitRadius: 6,
    tension: 0.12,
    fill: 'origin',
    spanGaps: true,
    order: 10,
  });

  state.chart.data.datasets = datasets;
  state.chart.options.scales.y.title = { display: true, text: 'ms' };
  delete state.chart.options.scales.y.beginAtZero;
  delete state.chart.options.scales.y.suggestedMax;
  delete state.chart.options.scales.y.max;
  state.chart.options.scales.y.min = 0;
  state.chart.options.scales.y.grace = '18%';
  state.chart.options.scales.packetLoss = { axis: 'y', type: 'linear', display: false, min: 0, max: 4 };

  const allX = datasets.flatMap(ds => (ds.data || []).map(p => p.x)).filter(Number.isFinite);
  const { min: xMin, max: xMax } = minMax(allX);
  if (allX.length) {
    const min = xMin === xMax ? xMin - 150 : xMin;
    const max = xMin === xMax ? xMax + 150 : xMax;
    state.chartZoomFullMin = min;
    state.chartZoomFullMax = max;
    state.chart.options.scales.x.min = min;
    state.chart.options.scales.x.max = max;
  } else {
    delete state.chart.options.scales.x.min;
    delete state.chart.options.scales.x.max;
  }
  const rawStats = Array.isArray(state.pingData.ping_stats) ? state.pingData.ping_stats : fallbackPingStats(pings);
  const totalPings = rawStats.reduce((sum, item) => sum + Number(item.total || 0), 0);
  tuneChartAnimation(totalPings);
  state.chart.update();
  updateChartZoomButton();

  const okPings = rawStats.reduce((sum, item) => sum + Number(item.ok || 0), 0);
  els.chartAvg.textContent = `Ping 总数：${totalPings} · 成功：${okPings}`;
  els.chartMeta.textContent = `最近 ${hours} 小时 · ${targetIds.length} 个目标`;
  renderPingLossStats(rawStats, targetById, targetIds, pings);
}

function fallbackPingStats(pings) {
  const stats = new Map();
  for (const ping of pings) {
    const id = String(ping.target_id || '');
    if (!id) continue;
    const item = stats.get(id) || { target_id: id, total: 0, ok: 0 };
    item.total += 1;
    if (ping.ok === undefined ? Number(ping.latency_ms) >= 0 : Number(ping.ok) === 1) item.ok += 1;
    stats.set(id, item);
  }
  return [...stats.values()].map(item => ({ ...item, lost: item.total - item.ok, loss_rate: item.total ? ((item.total - item.ok) / item.total) * 100 : null }));
}

function renderPingLossStats(stats, targetById = new Map(), targetIds = [], pings = [], visibleTargets = state.pingVisibleTargets) {
  if (!els.pingLossStats) return;
  const byId = new Map((stats || []).map(item => [String(item.target_id), item]));
  const latestById = latestPingByTarget(pings);
  const ids = targetIds.length ? targetIds : [...byId.keys()];
  els.pingLossStats.hidden = !ids.length;
  els.pingLossStats.innerHTML = ids.map((id, index) => {
    const item = byId.get(String(id)) || {};
    const total = Number(item.total || 0);
    const ok = Number(item.ok || 0);
    const loss = Number.isFinite(Number(item.loss_rate)) ? Number(item.loss_rate) : (total ? ((total - ok) / total) * 100 : null);
    const name = targetById.get(String(id))?.name || id;
    const level = loss == null ? 'unknown' : loss === 0 ? 'good' : loss < 5 ? 'warn' : 'bad';
    const color = configuredChartColor(targetById.get(String(id))?.color, PING_COLORS[index % PING_COLORS.length]);
    const latest = latestById.get(String(id));
    const current = !latest ? '-' : latest.ok && Number.isFinite(latest.latency_ms) ? `${Math.round(latest.latency_ms)} ms` : '超时';
    const currentClass = latest && !latest.ok ? ' timeout' : '';
    const details = `${name} · 当前 ${current} · ${total} 次 Ping · 丢失 ${Math.max(0, total - ok)} 次`;
    const hidden = visibleTargets instanceof Set && !visibleTargets.has(String(id));
    return `<button type="button" class="ping-loss-item ${level}${hidden ? ' is-hidden' : ''}" data-target-id="${escapeAttr(String(id))}" title="${escapeAttr(details)}" aria-label="${escapeAttr(details)}" aria-pressed="${hidden ? 'false' : 'true'}"><i style="--ping-color:${color}"></i><b>${escapeHtml(name)}</b><span class="ping-loss-metric ping-current"><small>当前</small><span class="ping-current-value${currentClass}">${escapeHtml(current)}</span></span><span class="ping-loss-metric"><small>丢包</small><strong>${loss == null ? '-' : `${loss.toFixed(loss > 0 && loss < 1 ? 2 : 1)}%`}</strong></span></button>`;
  }).join('');
}

function applyPingTargetSelection() {
  const visible = state.pingVisibleTargets;
  const allIds = [...(els.pingLossStats?.querySelectorAll('.ping-loss-item[data-target-id]') || [])]
    .map(item => String(item.dataset.targetId));
  for (const dataset of state.chart?.data?.datasets || []) {
    if (dataset.pingTargetId) {
      dataset.hidden = visible instanceof Set && !visible.has(String(dataset.pingTargetId));
    } else if (dataset.packetLoss) {
      const selectedIds = visible instanceof Set ? allIds.filter(id => visible.has(id)) : allIds;
      dataset.data = pingLossSeries(state.pingData?.pings || [], selectedIds);
    }
  }
  els.pingLossStats?.querySelectorAll('.ping-loss-item[data-target-id]').forEach(item => {
    const hidden = visible instanceof Set && !visible.has(String(item.dataset.targetId));
    item.classList.toggle('is-hidden', hidden);
    item.setAttribute('aria-pressed', String(!hidden));
  });
  state.chart?.update();
}

function applyLatencySourceSelection() {
  const visible = state.latencyVisibleSources;
  const allIds = state.latencyChartSources.map(source => String(source.id));
  for (const dataset of state.chart?.data?.datasets || []) {
    if (dataset.latencySourceId) {
      dataset.hidden = visible instanceof Set && !visible.has(String(dataset.latencySourceId));
    } else if (dataset.packetLoss) {
      const selectedIds = visible instanceof Set ? allIds.filter(id => visible.has(id)) : allIds;
      dataset.data = pingLossSeries(state.latencyChartSamples, selectedIds);
    }
  }
  els.pingLossStats?.querySelectorAll('.ping-loss-item[data-target-id]').forEach(item => {
    const hidden = visible instanceof Set && !visible.has(String(item.dataset.targetId));
    item.classList.toggle('is-hidden', hidden);
    item.setAttribute('aria-pressed', String(!hidden));
  });
  state.chart?.update();
}

function chartTooltipFailures() {
  if (state.selectedMetric !== 'ping' && state.selectedMetric !== 'latency') return [];
  const timestamp = chartHoverTimestamp();
  if (!Number.isFinite(timestamp)) return [];
  const points = state.selectedMetric === 'ping' ? (state.pingData?.pings || []) : state.latencyChartSamples;
  const names = state.selectedMetric === 'ping'
    ? new Map((state.pingData?.targets || []).map(target => [String(target.id), target.name || target.id]))
    : new Map(state.latencyChartSources.map(source => [String(source.id), source.name || source.id]));
  return failedPingTargetsNear(points, timestamp, pingSampleWindowSec(points))
    .map(id => `${names.get(id) || id}: 超时`);
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
    els.checks.innerHTML = `<div class="empty">${escapeHtml(state.appearance.checks_empty)}</div>`;
    els.checksHint.textContent = state.appearance.checks_unselected;
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
  `).join('') || `<div class="empty">${escapeHtml(state.appearance.checks_no_records)}</div>`;

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

  const mobileChart = isMobileChartViewport();
  state.chart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: buildLatencyChartDatasets(),
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
          align: mobileChart ? 'start' : 'end',
          labels: {
            boxWidth: mobileChart ? 8 : 10,
            boxHeight: mobileChart ? 8 : 10,
            padding: mobileChart ? 8 : 10,
            usePointStyle: true,
            color: '#5f6b78',
            font: {
              family: 'Varela Round',
              size: mobileChart ? 10 : 12,
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
              if (context.dataset.packetLoss) {
                const loss = Math.max(0, Number(context.parsed.y || 0) * 100);
                return `丢包率：${loss.toFixed(loss > 0 && loss < 1 ? 2 : 1)}%`;
              }
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
            },

            afterBody(items) {
              const shown = new Set((items || [])
                .filter(item => item.dataset.packetLoss)
                .map(item => String(item.dataset.sourceLabel || ''))
                .filter(Boolean));
              const failures = chartTooltipFailures()
                .filter(line => !shown.has(line.replace(/:\s*超时$/, '')));
              return failures.length ? ['', ...failures] : [];
            },
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
            maxTicksLimit: mobileChart ? 5 : 12,
            autoSkip: true,

            callback(value) {
              return formatAxisChartTime(Number(value), state.selectedRange);
            },

            font: {
              family: 'Varela Round',
              size: mobileChart ? 10 : 12,
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
            maxTicksLimit: mobileChart ? 4 : 5,

            font: {
              family: 'Varela Round',
              size: mobileChart ? 10 : 12,
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

function isMobileChartViewport() {
  return Number(window.innerWidth || 0) <= 760;
}

function updateChartForCurrentRange() {
  if (state.chart?.options?.plugins?.legend) {
    state.chart.options.plugins.legend.display = !['latency', 'ping'].includes(state.selectedMetric);
  }
  if (state.selectedMetric === 'ping') {
    updatePingChart().catch(err => {
      console.error('TCP Ping chart render failed', err);
      els.chartMeta.textContent = `Ping 图表渲染失败：${err.message}`;
      renderPingLossStats([]);
    });
    return;
  }
  if (state.selectedMetric !== 'latency') {
    renderPingLossStats([]);
    updateMetricsChart();
    return;
  }

  els.chartTitle.textContent = state.appearance.chart_title;
  const rangeChecks = getChartPointsForRange();

  updateChart(rangeChecks, state.selectedName || '服务');

  const expected = expectedChartGapSec(state.selectedRange);
  const gapCount = countChartGaps(rangeChecks, expected);
  const missedCount = countMissedChecks(rangeChecks);
  const externalCount = (state.externalLatencySources || []).length;
  const mode = rangeChecks.length
    ? `Cloudflare 每 5 分钟${externalCount ? ` + ${externalCount} 个外部 Latency 节点` : ''}${gapCount ? `，${gapCount} 个数据间断` : ''}${missedCount ? `，${missedCount} 次漏检` : ''}`
    : (externalCount ? `${externalCount} 个外部 Latency 节点` : '无原始检查数据');
  els.chartMeta.innerHTML = chartMetaHtml(state.selectedRange, rangeChecks.length, '', mode);
}

function updateMetricsChart() {
  const m = state.targetMetrics;
  const metric = state.selectedMetric;
  const range = state.selectedMetricRange;
  const labels = { cpu: 'CPU 使用率', mem: '内存使用率', disk: '磁盘使用率', load: '平均负载', net: '网络速度', conns: '连接数', diskio: '磁盘 I/O', temp: '温度', gpu: 'GPU' };
  const units = { cpu: '%', mem: '%', disk: '%', load: '', net: '', conns: '', diskio: '', temp: '°C', gpu: '%' };
  const fields = { cpu: 'cpu', mem: 'mem', disk: 'disk', load: 'load1', net_rx: 'net_rx', net_tx: 'net_tx', tcp_conns: 'tcp_conns', udp_conns: 'udp_conns', disk_read: 'disk_read', disk_write: 'disk_write', temp: 'cpu_temp', gpu: 'gpu_util', cpu_temp: 'cpu_temp', gpu_temp: 'gpu_temp', gpu_util: 'gpu_util' };

  const metricLabel = labels[metric] || metric;
  els.chartTitle.textContent = metricLabel;
  els.chartServiceName.textContent = `${state.selectedName || '服务'} ${metricLabel}`;

  if (!m || !m.latest) {
    els.chartMeta.textContent = '暂无监控数据，请在此 VPS 上安装 nstatus-metrics Agent。';
    updateChart([], state.selectedName || '服务');
    els.chartServiceName.textContent = `${state.selectedName || '服务'} ${metricLabel}`;
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

  if (metric === 'temp') {
    if (!canShowTemperature(latest.vps_info || {})) {
      els.chartMeta.textContent = '虚拟化环境不显示硬件温度。';
      els.chartAvg.textContent = '-';
      if (state.chart) {
        state.chart.data.datasets = [];
        state.chart.update();
      }
      return;
    }
    const definitions = [
      { field: 'cpu_temp', latest: 'cpu_temp_c', label: 'CPU', color: '#e4572e' },
      { field: 'gpu_temp', latest: 'gpu_temp_c', label: 'GPU', color: '#2f80ed' },
      { field: 'motherboard_temp', latest: 'motherboard_temp_c', label: '主板', color: '#009688' },
      { field: 'disk_temp', latest: 'disk_temp_c', label: '硬盘', color: '#d39e00' },
      { field: 'chipset_temp', latest: 'chipset_temp_c', label: '芯片组', color: '#64748b' },
    ];
    const series = definitions.map(definition => {
      const values = history.map(point => Number(point[definition.field])).filter(Number.isFinite);
      return {
        ...definition,
        values,
        points: history.map(point => ({ x: Number(point.ts), y: Number.isFinite(Number(point[definition.field])) ? Number(point[definition.field]) : null })),
      };
    }).filter(item => item.values.length);
    els.chartTitle.textContent = '温度';
    els.chartMeta.textContent = series.length
      ? `${series.map(item => `${item.label} 平均 ${(item.values.reduce((a, b) => a + b, 0) / item.values.length).toFixed(1)}°C`).join(' · ')} · ${history.length} 个采样点`
      : '当前设备未提供可用的温度历史数据。';
    const currentTemperatures = definitions.map(item => {
      const raw = latest.vps_info?.[item.latest];
      const value = Number(raw);
      return raw != null && Number.isFinite(value) ? `${item.label} ${value.toFixed(1)}°C` : '';
    }).filter(Boolean);
    els.chartAvg.textContent = currentTemperatures.join(' · ') || '-';
    if (!state.chart) return;
    state.chart.data.datasets = series.map(item => netDataset(`${item.label} °C`, item.points, item.color));
  } else if (metric === 'gpu') {
    const showTemperature = canShowTemperature(latest.vps_info || {});
    const utilPoints = history.map(p => ({ x: Number(p.ts), y: Number(p.gpu_util) || 0 }));
    const tempPoints = history.map(p => ({ x: Number(p.ts), y: Number.isFinite(Number(p.gpu_temp)) ? Number(p.gpu_temp) : null }));
    const utilVals = history.map(p => Number(p.gpu_util)).filter(Number.isFinite);
    const avg = utilVals.length ? utilVals.reduce((a, b) => a + b, 0) / utilVals.length : 0;
    els.chartTitle.textContent = 'GPU';
    els.chartMeta.textContent = `占用平均 ${avg.toFixed(1)}% · ${history.length} 个采样点`;
    els.chartAvg.textContent = `占用 ${Number(latest.vps_info?.gpu_util ?? latest.gpu_util ?? 0).toFixed(1)}%${showTemperature ? ` · 温度 ${Number(latest.vps_info?.gpu_temp_c ?? latest.gpu_temp_c ?? 0).toFixed(1)}°C` : ''}`;
    if (!state.chart) return;
    state.chart.data.datasets = [
      netDataset('占用 %', utilPoints, '#3949ab'),
      ...(showTemperature ? [netDataset('温度 °C', tempPoints, '#8e24aa')] : []),
    ];
  } else if (metric === 'net') {
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
    const min = xMin === xMax ? xMin - 150 : xMin;
    const max = xMin === xMax ? xMax + 150 : xMax;
    state.chartZoomFullMin = min;
    state.chartZoomFullMax = max;
    state.chart.options.scales.x.min = min;
    state.chart.options.scales.x.max = max;
  } else {
    delete state.chart.options.scales.x.min;
    delete state.chart.options.scales.x.max;
  }
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
  els.chartServiceName.textContent = `${name} ${state.appearance.chart_title}`;

  if (!state.chart) {
    els.chartMeta.textContent = 'Chart.js 不可用，仍可在下方查看最近检查记录。';
    return;
  }

  delete state.chart.options.scales.y.title;
  delete state.chart.options.scales.y.max;
  state.chart.options.scales.y.min = 0;
  state.chart.options.scales.y.grace = '18%';
  state.chart.options.scales.packetLoss = { axis: 'y', type: 'linear', display: false, min: 0, max: 4 };

  const cloudflareSeries = cloudflareLatencyChartSeries(checks);
  const externalSeries = externalLatencyChartSeries();
  const sources = [cloudflareSeries, ...externalSeries].filter(source => source.samples.length);
  const samples = sources.flatMap(source => source.samples);
  if (state.latencyVisibleSources instanceof Set) {
    const available = new Set(sources.map(source => String(source.id)));
    const retained = new Set([...state.latencyVisibleSources].filter(id => available.has(String(id))));
    state.latencyVisibleSources = !retained.size || retained.size >= available.size ? null : retained;
  }
  const visibleIds = state.latencyVisibleSources instanceof Set
    ? sources.map(source => source.id).filter(id => state.latencyVisibleSources.has(String(id)))
    : sources.map(source => source.id);
  state.latencyChartSources = sources;
  state.latencyChartSamples = samples;

  const stats = fallbackPingStats(samples);
  const total = stats.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const ok = stats.reduce((sum, item) => sum + Number(item.ok || 0), 0);
  els.chartAvg.textContent = `Latency 总数：${total} · 成功：${ok}`;
  renderPingLossStats(
    stats,
    new Map(sources.map(source => [String(source.id), source])),
    sources.map(source => String(source.id)),
    samples,
    state.latencyVisibleSources,
  );

  const lossPoints = pingLossSeries(samples, visibleIds);
  const allPoints = [...sources.flatMap(source => source.points), ...lossPoints];
  state.chart.data.datasets = buildLatencyChartDatasets(sources, samples, visibleIds);
  applyChartFullRange(allPoints);
  tuneChartAnimation(allPoints.length);
  state.chart.update();
}

function buildLatencyChartDatasets(sources = [], samples = [], visibleIds = []) {
  const selected = new Set(visibleIds.map(String));
  const datasets = [];
  for (const source of sources) {
    datasets.push(lineDataset({
      label: source.name,
      data: source.points,
      color: configuredChartColor(source.color, pingTargetColor(source.id || source.name)),
      fill: false,
      order: 2,
      sourceId: source.id,
      hidden: !selected.has(String(source.id)),
    }));
  }
  datasets.push({
    label: '丢包率',
    packetLoss: true,
    data: pingLossSeries(samples, visibleIds),
    yAxisID: 'packetLoss',
    borderColor: 'rgba(202, 138, 4, 0.38)',
    backgroundColor: 'rgba(250, 204, 21, 0.10)',
    borderWidth: 1,
    pointRadius: 0,
    pointHoverRadius: 3,
    pointHitRadius: 6,
    tension: 0.12,
    fill: 'origin',
    spanGaps: true,
    order: 10,
  });
  return datasets;
}

function cloudflareLatencyChartSeries(checks) {
  const samples = latencySamples('cloudflare', checks, { excludeMissed: true });
  return {
    id: 'cloudflare',
    name: 'Cloudflare',
    color: '#159754',
    samples,
    points: latencyLinePoints(samples),
  };
}

function externalLatencyChartSeries() {
  return (state.externalLatencySources || []).map(source => {
    const checks = filterChecksByRange((source.points || []).map(point => ({
      checked_at: Number(point.checked_at),
      latency_ms: point.latency_ms == null ? null : Number(point.latency_ms),
      ok: point.ok ? 1 : 0,
    })), state.selectedRange);
    const id = String(source.id || '');
    const samples = latencySamples(id, checks);
    return {
      id,
      name: String(source.name || source.id || 'Latency'),
      color: source.color,
      samples,
      points: latencyLinePoints(samples),
    };
  }).filter(source => source.id && source.samples.length);
}

function latencySamples(sourceId, checks, { excludeMissed = false } = {}) {
  return (checks || [])
    .filter(check => !excludeMissed || !check.missed)
    .map(check => normalizeLatencySample(sourceId, check))
    .filter(point => point.target_id && Number.isFinite(point.ts));
}

function latencyLinePoints(samples) {
  return trimEmptyPointEdges((samples || []).map(point => ({
    x: point.ts,
    y: point.ok && Number.isFinite(point.latency_ms) ? point.latency_ms : null,
  })));
}

function lineDataset({ label, data, color, fill, fillStrength = 1, order, sourceId = '', hidden = false }) {
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
    spanGaps: true,
    order,
    latencySourceId: String(sourceId || ''),
    hidden,
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
    state.chartZoomFullMin = null;
    state.chartZoomFullMax = null;
    updateChartZoomButton();
    return;
  }

  const range = minMax(xs);
  // Keep the visible domain tight to data edges so zoom-out never reintroduces blank gutters.
  const min = range.min === range.max ? range.min - 150 : range.min;
  const max = range.min === range.max ? range.max + 150 : range.max;
  state.chartZoomFullMin = min;
  state.chartZoomFullMax = max;
  xScale.min = min;
  xScale.max = max;
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

  // Always keep explicit bounds so Chart.js cannot auto-pad blank ends after zoom-out.
  if (nextSpan >= fullSpan * 0.995) {
    chart.options.scales.x.min = fullMin;
    chart.options.scales.x.max = fullMax;
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
  state.chart.options.scales.x.min = state.chartZoomFullMin;
  state.chart.options.scales.x.max = state.chartZoomFullMax;
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

function serviceDisplayName(t = {}) {
  const provider = String(t.provider || '').trim();
  const name = String(t.name || '').trim();
  if (!provider) return name;
  if (!name) return provider;
  const normalize = value => value.toLocaleLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  return normalize(name).startsWith(normalize(provider)) ? name : `${provider} ${name}`;
}

function regionShort(t) {
  const code = String(t.probe_region || 'auto').toLowerCase();

  if (!code || code === 'auto') {
    return '';
  }

  const map = {
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

  if (!c?.missed && c?.error) {
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
  return sharedDisplayGroupName(name);
}

function targetSearchText(t) {
  const country = countryByCode(t.location);
  return [
    t.name,
    t.group_name,
    t.provider,
    t.location,
    t.city,
    targetLocationLabel(t),
    country?.name,
    country?.englishName,
    t.line_type,
    t.tags,
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
  const nums = rows.filter(targetHasPublicLatency).map(t => Number(t.latency_ms)).filter(Number.isFinite);

  if (!nums.length) {
    return null;
  }

  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}
