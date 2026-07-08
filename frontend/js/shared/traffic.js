import { escapeAttr, escapeHtml } from './html.js';
import { clampNumber, fmtBytes } from './format.js';

export function trafficForTarget(target = {}) {
  return target?.agent_metrics?.traffic || target?.traffic || {};
}

export function trafficProgressInfo(traffic = {}) {
  if (!traffic?.enabled) return null;

  const quota = Number(traffic.quota_bytes || 0);
  if (!Number.isFinite(quota) || quota <= 0) return null;

  const total = Math.max(0, Number(traffic.total_bytes || 0));
  const percentValue = traffic.percent == null ? NaN : Number(traffic.percent);
  const rawUsed = Number.isFinite(percentValue)
    ? percentValue
    : total / quota * 100;
  const usedPct = clampNumber(rawUsed, 0, 100);
  const remainingPct = clampNumber(100 - rawUsed, 0, 100);

  return {
    total,
    quota,
    usedPct,
    remainingPct,
  };
}

export function formatTrafficPct(value) {
  const n = Math.max(0, Number(value || 0));
  return `${n >= 99.95 || n <= 0.05 ? n.toFixed(0) : n.toFixed(1)}%`;
}

export function trafficProgressHtml(traffic, className = '') {
  const info = trafficProgressInfo(traffic);
  if (!info) return '';

  const remainingText = formatTrafficPct(info.remainingPct);
  const usedText = formatTrafficPct(info.usedPct);
  const modeLabel = traffic?.mode_label || '';
  const title = `流量剩余 ${remainingText} · 已用 ${usedText} · ${fmtBytes(info.total)} / ${fmtBytes(info.quota)}${modeLabel ? ' · ' + modeLabel : ''}`;
  const width = info.remainingPct.toFixed(1);
  const extraClass = className ? ` ${escapeAttr(className)}` : '';
  const progressLabel = modeLabel ? `流量剩余 · ${modeLabel}` : '流量剩余';

  return `
    <div class="traffic-progress${extraClass}" title="${escapeAttr(title)}">
      <div class="traffic-progress-top">
        <span>${escapeHtml(progressLabel)}</span>
        <strong>${escapeHtml(remainingText)}</strong>
      </div>
      <div class="traffic-progress-track" aria-hidden="true">
        <i style="width:${escapeAttr(width)}%"></i>
      </div>
    </div>
  `;
}
