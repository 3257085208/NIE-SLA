import assert from 'node:assert/strict';
import { exportTelemetryHour, normalizeExportAttempt, timeseriesExportEnabled } from '../src/timeseries-export.js';

assert.equal(timeseriesExportEnabled({}), false);
assert.deepEqual(normalizeExportAttempt({ attempts: 2, last_error: 'x', next_at: 4 }), { attempts: 2, last_error: 'x', next_at: 4 });

const requests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (request, init) => {
  requests.push({ request: String(request), init });
  return new Response(null, { status: 204 });
};
try {
  const result = await exportTelemetryHour({ TIMESERIES_EXPORT_URL: 'https://metrics.example.test/import', TIMESERIES_EXPORT_FORMAT: 'victoriametrics', TIMESERIES_EXPORT_TOKEN: 'redacted' }, 'agent-1', 1_700_000_000, [
    { target_id: 'a,b', ts: 1_700_000_001, latency_ms: 12, ok: 1 },
    { target_id: 'a,b', ts: 1_700_000_002, latency_ms: null, ok: 0 },
  ]);
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].init.body, /nie_sla_ping_ok/);
  assert.match(requests[0].init.body, /nie_sla_ping_latency_ms/);
  assert.match(requests[0].init.headers.authorization, /^Bearer /);
  await assert.rejects(() => exportTelemetryHour({ TIMESERIES_EXPORT_URL: 'http://metrics.example.test/import' }, 'a', 1, []), /HTTPS/);
  await assert.rejects(() => exportTelemetryHour({ TIMESERIES_EXPORT_URL: 'https://metrics.example.test/import', TIMESERIES_EXPORT_FORMAT: 'unknown' }, 'a', 1, []), /format is invalid/);
  globalThis.fetch = async () => { throw new Error('failed at https://metrics.example.test/import?token=secret'); };
  await assert.rejects(
    () => exportTelemetryHour({ TIMESERIES_EXPORT_URL: 'https://metrics.example.test/import', TIMESERIES_EXPORT_TOKEN: 'secret' }, 'a', 1, [{ target_id: 'x', ts: 1, ok: 0 }]),
    error => error.message === 'time-series export request failed',
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('time-series export tests passed');
