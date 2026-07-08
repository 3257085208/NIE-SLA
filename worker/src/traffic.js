import { nowSec, parseBoolean, trafficPeriodFromExpiry } from './utils.js';

const TRAFFIC_MODES = new Set(['total', 'tx', 'rx', 'max']);

export function normalizeTrafficQuotaGb(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(Math.min(n, 1048576) * 100) / 100;
}

export function normalizeTrafficMode(value) {
  const mode = String(value || 'total').trim().toLowerCase();
  return TRAFFIC_MODES.has(mode) ? mode : 'total';
}

export function trafficModeLabel(mode) {
  return {
    total: '双向合计',
    tx: '仅上行',
    rx: '仅下行',
    max: '上下行较大值',
  }[normalizeTrafficMode(mode)] || '双向合计';
}

export function trafficBillableBytes(mode, rx, tx) {
  const safeRx = Number(rx || 0) || 0;
  const safeTx = Number(tx || 0) || 0;
  switch (normalizeTrafficMode(mode)) {
    case 'tx': return safeTx;
    case 'rx': return safeRx;
    case 'max': return Math.max(safeRx, safeTx);
    default: return safeRx + safeTx;
  }
}

export function currentTrafficMonth(env, ts = nowSec()) {
  return trafficPeriodFromExpiry(env, null, ts).month;
}

export function trafficPeriod(env, ts = nowSec()) {
  return trafficPeriodFromExpiry(env, null, ts);
}

export function trafficSettingsFromTarget(target, env, ts = nowSec()) {
  const quotaGb = normalizeTrafficQuotaGb(target?.traffic_quota_gb ?? 0);
  const mode = normalizeTrafficMode(target?.traffic_mode);
  return {
    enabled: parseBoolean(target?.traffic_enabled, false),
    mode,
    mode_label: trafficModeLabel(mode),
    quota_gb: quotaGb,
    quota_bytes: Math.round(quotaGb * 1024 * 1024 * 1024),
    ...trafficPeriodFromExpiry(env, target?.expires_at, ts),
  };
}

export function summarizeTraffic(row, settings) {
  const rx = Number(row?.rx_bytes || 0) || 0;
  const tx = Number(row?.tx_bytes || 0) || 0;
  const mode = normalizeTrafficMode(settings?.mode);
  const billable = trafficBillableBytes(mode, rx, tx);
  const quota = Number(settings?.quota_bytes || 0) || 0;
  return {
    enabled: Boolean(settings?.enabled),
    mode,
    mode_label: trafficModeLabel(mode),
    month: settings?.month || '',
    reset: settings?.reset || 'calendar-month',
    reset_day: Number(settings?.reset_day || 1) || 1,
    period_start: settings?.period_start || '',
    period_end: settings?.period_end || '',
    rx_bytes: rx,
    tx_bytes: tx,
    raw_total_bytes: rx + tx,
    total_bytes: billable,
    quota_gb: Number(settings?.quota_gb || 0) || 0,
    quota_bytes: quota,
    percent: quota > 0 ? Math.round((billable / quota) * 1000) / 10 : null,
    updated_at: Number(row?.updated_at || 0) || null,
  };
}
