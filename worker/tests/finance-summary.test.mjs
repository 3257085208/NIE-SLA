import assert from 'node:assert/strict';
import { cycleMonths, monthlyCost, financeSummary } from '../src/admin/finance.js';

assert.equal(cycleMonths('monthly'), 1);
assert.equal(cycleMonths('ANNUALLY'), 12);
assert.equal(cycleMonths('5year'), 60);
assert.equal(cycleMonths('unknown'), null);
assert.equal(monthlyCost(120, 'annually'), 10);
assert.equal(monthlyCost(100, 'quarterly'), 33.33);
assert.equal(monthlyCost('bad', 'monthly'), null);

const now = 1_800_000_000;
const summary = financeSummary([
  { id: 'cny', name: 'CNY VPS', price: 120, billing_cycle: 'annually', currency: 'CNY', expires_at: now + 10 * 86400 },
  { id: 'usd', name: 'USD VPS', price: 12, billing_cycle: 'monthly', currency: 'USD', expires_at: now + 40 * 86400 },
  { id: 'invalid-cycle', name: 'Invalid', price: 99, billing_cycle: 'weekly', currency: 'CNY', expires_at: now + 5 * 86400 },
  { id: 'unknown-currency', name: 'Unknown currency', price: 99, billing_cycle: 'monthly', currency: 'ABC', expires_at: now + 5 * 86400 },
], { USD: 7.2 }, now);

assert.equal(summary.counted, 2);
assert.equal(summary.monthly_total_cny, 96.4);
assert.equal(summary.yearly_total_cny, 1156.8);
assert.deepEqual(summary.expiring_30d.map(item => item.id), ['cny']);
assert.equal(summary.expiring_30d[0].monthly_cny, 10);

console.log('finance summary tests passed');
