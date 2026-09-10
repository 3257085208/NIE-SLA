import { financeSummary } from './finance.js';
import { getExchangeRates } from './settings.js';
import { nowSec } from '../utils.js';

export async function getFinanceSummary(env) {
  const rates = await getExchangeRates(env).catch(() => ({}));
  const rows = await env.DB.prepare(
    `SELECT id, name, price, billing_cycle, currency, expires_at FROM targets
     WHERE enabled = 1 AND price IS NOT NULL AND billing_cycle IS NOT NULL`
  ).all();
  return { ok: true, ...financeSummary(rows.results || [], rates || {}, nowSec()) };
}
