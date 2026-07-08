import { escapeHtml } from './html.js';
import { clampNumber, pad } from './format.js';

export function daysUntil(sec) {
  if (!sec) return null;
  const days = Math.ceil((Number(sec) - Date.now() / 1000) / 86400);
  return Number.isFinite(days) ? days : null;
}

export function formatDateOnly(sec) {
  if (!sec) return '-';
  const d = new Date(Number(sec) * 1000);
  if (Number.isNaN(d.getTime())) return '-';
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  return `${y}-${m}-${day}`;
}

export function priceInfo(target = {}) {
  const amount = Number(target.price_cny ?? target.price ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    amount,
    currency: target.price_cny != null ? 'CNY' : String(target.currency || 'CNY').toUpperCase(),
  };
}

export function moneyText(amount, currency = 'CNY') {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '-';
  const code = String(currency || 'CNY').toUpperCase();
  return code === 'CNY' ? `¥${n.toFixed(2)}` : `${code} ${n.toFixed(2)}`;
}

export function normalizeBillingCycle(cycle) {
  return String(cycle || '').trim().toLowerCase();
}

export function isLifetimeBilling(cycle) {
  const normalized = normalizeBillingCycle(cycle);
  return normalized === 'lifetime' || normalized === 'onetime';
}

export function billingCycleLabel(cycle) {
  const normalized = normalizeBillingCycle(cycle);
  return {
    hourly: '小时计费',
    monthly: '月付',
    yearly: '年付',
    lifetime: '买断 / 永久',
    onetime: '一次性 / 旧',
  }[normalized] || '未设置';
}

export function billingCycleSuffix(cycle) {
  const normalized = normalizeBillingCycle(cycle);
  return {
    hourly: '/小时',
    monthly: '/月',
    yearly: '/年',
    lifetime: '买断',
    onetime: '一次性',
  }[normalized] || '';
}

export function billingPeriodDays(cycle) {
  const normalized = normalizeBillingCycle(cycle);
  if (normalized === 'yearly') return 365;
  if (normalized === 'monthly') return 30;
  return null;
}

export function targetRemainingValue(target = {}) {
  const price = priceInfo(target);
  const days = daysUntil(target.expires_at);
  const cycle = normalizeBillingCycle(target.billing_cycle);
  if (!price || days == null || isLifetimeBilling(cycle)) return null;
  if (cycle === 'hourly') {
    return { amount: price.amount * Math.max(0, days) * 24, currency: price.currency };
  }
  const periodDays = billingPeriodDays(cycle);
  if (!periodDays) return null;

  const remainingDays = clampNumber(days, 0, periodDays);
  return {
    amount: price.amount * remainingDays / periodDays,
    currency: price.currency,
  };
}

export function targetExpiryValueHtml(target = {}) {
  const days = daysUntil(target.expires_at);
  const value = targetRemainingValue(target);
  const cycle = normalizeBillingCycle(target.billing_cycle);
  const price = priceInfo(target);
  const noExpiryText = cycle === 'hourly' ? '按量计费' : (isLifetimeBilling(cycle) ? '永久 / 买断' : '-');
  const dayText = days == null
    ? noExpiryText
    : days < 0
      ? `已过期 ${Math.abs(days)} 天`
      : `${days} 天`;
  const valueText = value
    ? moneyText(value.amount, value.currency)
    : cycle === 'hourly'
      ? '按实际用量'
      : isLifetimeBilling(cycle)
        ? '不摊销'
        : '-';
  const priceText = price ? `${moneyText(price.amount, price.currency)}${billingCycleSuffix(cycle)}` : '-';

  return `
    <div class="node-detail-value-card card-soft">
      <div class="node-detail-value-title">
        <strong>到期与价值</strong>
        <small>${escapeHtml(target.name || '-')}</small>
      </div>
      <div class="node-detail-value-grid">
        <span>计费周期</span><strong>${escapeHtml(billingCycleLabel(cycle))}</strong>
        <span>费用</span><strong>${escapeHtml(priceText)}</strong>
        <span>到期时间</span><strong>${escapeHtml(target.expires_at ? formatDateOnly(target.expires_at) : noExpiryText)}</strong>
        <span>剩余天数</span><strong>${escapeHtml(dayText)}</strong>
        <span>剩余价值</span><strong>${escapeHtml(valueText)}</strong>
      </div>
    </div>
  `;
}

export function estimateRemainingCny(targets) {
  let total = 0;
  for (const t of targets || []) {
    const value = targetRemainingValue(t);
    if (value && value.currency === 'CNY') total += value.amount;
  }
  return total;
}

export function estimateMonthlyCny(targets) {
  let total = 0;
  for (const t of targets || []) {
    const price = Number(t.price_cny ?? t.price ?? 0);
    if (!Number.isFinite(price) || price <= 0) continue;
    const cycle = normalizeBillingCycle(t.billing_cycle);
    if (cycle === 'yearly') total += price / 12;
    else if (cycle === 'hourly') total += price * 24 * 30;
    else if (isLifetimeBilling(cycle)) total += 0;
    else total += price;
  }
  return total;
}
