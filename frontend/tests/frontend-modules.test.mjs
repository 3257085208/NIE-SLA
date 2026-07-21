import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  buildLinePoints,
  clampChartRange,
  countChartGaps,
  countMissedChecks,
  filterChecksByRange,
  normalizeChartRows,
  trimEmptyPointEdges,
} from '../js/shared/chart-data.js';
import { createAdminClient } from '../js/admin/api.js';
import { groupByDimension, groupByMenuHtml, groupKeyFor, priceBandKey } from '../js/shared/grouping.js';
import { nodegetFlagHtml } from '../js/themes/nodeget-cards.js';
import { canShowTemperature, hasTemperatureData, isVirtualized } from '../js/shared/hardware.js';
import {
  CURRENCIES,
  COUNTRIES,
  PROVIDERS,
  countryFlagAsset,
  filterCountries,
  filterProviders,
  normalizeCountryCode,
} from '../js/shared/target-catalogs.js';

const rows = normalizeChartRows([
  { checked_at: 30, ok: 1, latency_ms: 20 },
  { checked_at: 10, ok: 0, latency_ms: null },
  { checked_at: 20, ok: 1, latency_ms: 10, missed: true },
]);
assert.deepEqual(rows.map((row) => row.x), [10, 20, 30]);
assert.deepEqual(buildLinePoints(rows), [{ x: 10, y: null }, { x: 30, y: 20 }]);
assert.deepEqual(trimEmptyPointEdges([
  { x: 10, y: null },
  { x: 20, y: 11 },
  { x: 30, y: null },
  { x: 40, y: 12 },
  { x: 50, y: null },
]), [{ x: 20, y: 11 }, { x: 30, y: null }, { x: 40, y: 12 }]);
assert.deepEqual(clampChartRange(-10, 30, 0, 100), { min: 0, max: 40 });
assert.deepEqual(clampChartRange(80, 120, 0, 100), { min: 60, max: 100 });
assert.equal(countChartGaps([{ checked_at: 0 }, { checked_at: 10 }, { checked_at: 40 }], 20), 1);
assert.equal(countMissedChecks([{ missed: true }, {}, { missed: true }]), 2);
assert.deepEqual(filterChecksByRange([{ checked_at: 100 }, { checked_at: 100_000 }], 'day', 100_000), [{ checked_at: 100_000 }]);

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.sessionStorage = globalThis.localStorage;

let lastRequest = null;
globalThis.fetch = async (url, options) => {
  lastRequest = { url, options };
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

const client = createAdminClient({ apiBase: 'https://api.example' });
client.setToken('secret');
client.saveSession('session', Math.floor(Date.now() / 1000) + 60);
await client.api('/api/targets');
assert.equal(lastRequest.options.headers.Authorization, undefined);
assert.equal(lastRequest.options.headers['x-admin-session'], 'session');
await client.api('/api/login', { forceToken: true });
assert.equal(lastRequest.options.headers.Authorization, 'Bearer secret');
const installResponse = await client.apiAdmin('/api/agent/install-command?target_id=vps-a', {}, 1_000);
assert.equal(installResponse.ok, true);
assert.match(lastRequest.url, /\/api\/agent\/install-command\?target_id=vps-a$/);
assert.equal(lastRequest.options.headers['x-admin-session'], 'session');

const targets = [
  { name: 'a', group_name: 'G1', provider: 'DMIT', location: 'HK', line_type: '落地鸡', price: 8 },
  { name: 'b', group_name: 'G1', provider: 'DMIT', location: 'US', line_type: '线路鸡', price: 12 },
  { name: 'c', group_name: 'G2', provider: 'Bandwagon', location: 'HK', line_type: '落地鸡', price: 3 },
];
assert.equal(groupKeyFor(targets[0], 'provider'), 'DMIT');
assert.equal(Object.keys(groupByDimension(targets, 'location')).length, 2);
assert.equal(Object.keys(groupByDimension(targets, 'line_type')).length, 2);
assert.equal(priceBandKey({ price: 8 }), '5 – 10');
assert.match(groupByMenuHtml('location'), /role="listbox"/);
assert.match(groupByMenuHtml('location'), /data-group-value="location"[^>]*>国家\/地区<\/button>/);
assert.match(nodegetFlagHtml('HK'), /assets\/flags\/4x3\/hk\.svg/);
assert.match(nodegetFlagHtml('HK'), /width="18" height="13"/);
assert.equal(countryFlagAsset('HK'), './assets/flags/4x3/hk.svg');
assert.doesNotMatch(nodegetFlagHtml('HK'), /flagcdn\.com/);
assert.equal(isVirtualized({ virtualization: 'kvm' }), true);
assert.equal(isVirtualized({ virtualization: 'bare-metal' }), false);
assert.equal(canShowTemperature({ virtualization: 'docker' }), false);
assert.equal(canShowTemperature({ virtualization: '' }), true);
assert.equal(hasTemperatureData({ virtualization: 'kvm', cpu_temp_c: 40 }), false);
assert.equal(hasTemperatureData({ virtualization: '', disk_temp_c: 36 }), true);
assert.equal(hasTemperatureData({ virtualization: '', temperature_sensors: [{ temp_c: 42 }] }), true);
assert.equal(COUNTRIES.length, 249);
for (const country of COUNTRIES) {
  assert.equal(existsSync(new URL(`../assets/flags/4x3/${country.code.toLowerCase()}.svg`, import.meta.url)), true);
}
assert.equal(PROVIDERS.length >= 40, true);
assert.equal(CURRENCIES.length >= 15, true);
assert.equal(normalizeCountryCode('香港'), 'HK');
assert.equal(filterCountries('新加坡')[0].code, 'SG');
assert.equal(filterProviders('rack')[0], 'RackNerd');

console.log('frontend module tests passed');
