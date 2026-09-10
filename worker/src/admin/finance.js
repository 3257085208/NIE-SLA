import { nowSec } from '../utils.js';

const CYCLE_MONTHS = { monthly: 1, quarterly: 3, semiannually: 6, annually: 12, biennially: 24, triennially: 36, '5year': 60 };

export function cycleMonths(cycle) {
  return CYCLE_MONTHS[String(cycle || '').toLowerCase()] || null;
}

export function monthlyCost(price, cycle) {
  const months = cycleMonths(cycle);
  if (!months || !Number.isFinite(Number(price))) return null;
  return Math.round((Number(price) / months) * 100) / 100;
}

export function financeSummary(rows, rates = {}, now = nowSec()) {
  let totalMonthlyCny = 0;
  let counted = 0;
  const expiring30 = [];
  for (const row of rows) {
    const price = Number(row.price);
    const cycle = row.billing_cycle;
    const monthlySource = monthlyCost(price, cycle);
    if (!Number.isFinite(price) || price <= 0 || monthlySource == null) continue;
    const currency = String(row.currency || 'CNY').toUpperCase();
    const rate = currency === 'CNY' ? 1 : Number(rates[currency]);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    const monthlyCny = monthlySource * rate;
    totalMonthlyCny += monthlyCny;
    counted += 1;
    const expiresAt = Number(row.expires_at || 0);
    if (expiresAt > now && expiresAt < now + 30 * 86400) {
      expiring30.push({ id: row.id, name: row.name, expires_at: expiresAt, price, cycle, monthly_cny: monthlyCny });
    }
  }
  return {
    counted,
    monthly_total_cny: Math.round(totalMonthlyCny * 100) / 100,
    yearly_total_cny: Math.round(totalMonthlyCny * 12 * 100) / 100,
    expiring_30d: expiring30.sort((a, b) => a.expires_at - b.expires_at),
  };
}
