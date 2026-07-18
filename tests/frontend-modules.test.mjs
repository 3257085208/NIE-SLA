import assert from 'node:assert/strict';
import {
  buildLinePoints,
  clampChartRange,
  countChartGaps,
  countMissedChecks,
  filterChecksByRange,
  normalizeChartRows,
} from '../frontend/js/shared/chart-data.js';
import { createAdminClient } from '../frontend/js/admin/api.js';

const rows = normalizeChartRows([
  { checked_at: 30, ok: 1, latency_ms: 20 },
  { checked_at: 10, ok: 0, latency_ms: null },
  { checked_at: 20, ok: 1, latency_ms: 10, missed: true },
]);
assert.deepEqual(rows.map((row) => row.x), [10, 20, 30]);
assert.deepEqual(buildLinePoints(rows), [{ x: 10, y: null }, { x: 30, y: 20 }]);
assert.deepEqual(clampChartRange(-10, 30, 0, 100), { min: 0, max: 40 });
assert.deepEqual(clampChartRange(80, 120, 0, 100), { min: 60, max: 100 });
assert.equal(countChartGaps([{ checked_at: 0 }, { checked_at: 10 }, { checked_at: 40 }], 20), 1);
assert.equal(countMissedChecks([{ missed: true }, {}, { missed: true }]), 2);
assert.deepEqual(
  filterChecksByRange([{ checked_at: 100 }, { checked_at: 100_000 }], 'day', 100_000),
  [{ checked_at: 100_000 }],
);

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
await client.api('/api/login');
assert.equal(lastRequest.url, 'https://api.example/api/login');
assert.equal(lastRequest.options.headers.Authorization, 'Bearer secret');
assert.equal(lastRequest.options.headers['x-admin-session'], 'session');

let unauthorized = '';
globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: '未授权' }), { status: 401 });
const denied = createAdminClient({
  apiBase: 'https://api.example',
  onUnauthorized: (message) => { unauthorized = message; },
});
denied.setToken('bad');
await assert.rejects(() => denied.api('/api/login'), /未授权/);
assert.equal(denied.getToken(), '');
assert.equal(unauthorized, '未授权');

console.log('frontend module tests passed');
