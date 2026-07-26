import { pad } from './format.js';

export function formatDateOnly(sec) {
  if (!sec) return '-';
  const d = new Date(Number(sec) * 1000);
  if (Number.isNaN(d.getTime())) return '-';
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  return `${y}-${m}-${day}`;
}

export function normalizeBillingCycle(cycle) {
  return String(cycle || '').trim().toLowerCase();
}

export function isLifetimeBilling(cycle) {
  const normalized = normalizeBillingCycle(cycle);
  return normalized === 'lifetime' || normalized === 'onetime';
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
