import assert from 'node:assert/strict';
import { getAgentMetrics, getAgentMetricsCached } from '../src/metrics.js';
import { readPublicAgentMetrics, TelemetryBuffer, AGENT_METRICS_STREAM_INSTANCE } from '../src/telemetry-buffer.js';

const now = Math.floor(Date.now() / 1000);
const latest = { agent_id: 'reader-fixture', updated_at: new Date(now * 1000).toISOString(), cpu_percent: 12 };
const points = Array.from({ length: 600 }, (_, i) => ({ ts: now - 600 + i, cpu: i % 100, mem: 40 }));
const names = [];
let archiveReads = 0;
let edgeArchiveReads = 0;
let readerCalls = 0;
const DB = {
  prepare(sql) {
    const query = {
      bind() { return query; },
      async first() { return sql.includes('SELECT 1 AS ok FROM targets') ? { ok: 1 } : null; },
      async all() { return { results: [] }; },
      async run() { return { meta: { changes: 0 } }; },
    };
    return query;
  },
};
const env = { DB, INTERNAL_CRON_SECRET: 'reader-test-secret', AGENT_METRICS_STATE_TO_D1: '0' };
const readerEnv = { ...env, ARCHIVE: { async get() { archiveReads++; return null; } } };
const reader = new TelemetryBuffer({ storage: {}, waitUntil() {} }, readerEnv);
env.TELEMETRY_BUFFER = readerEnv.TELEMETRY_BUFFER = {
  idFromName(name) { names.push(name); return name; },
  get(name) {
    return {
      async fetch(input, init) {
        const request = new Request(input, init);
        assert.equal(request.headers.get('x-nie-sla-internal-secret'), env.INTERNAL_CRON_SECRET);
        const url = new URL(request.url);
        if (name === AGENT_METRICS_STREAM_INSTANCE) {
          if (url.pathname === '/latest') return Response.json({ ok: true, state: latest });
          if (url.pathname === '/read') return Response.json({ ok: true, points, pings: [], proxy_checks: [] });
          assert.fail('unexpected ingestion request: ' + url.pathname);
        }
        assert.match(name, /^public-metrics-reader-v1-\d+$/);
        assert.equal(url.pathname, '/public-metrics');
        readerCalls++;
        const response = await reader.fetch(request);
        response.json = () => { throw new Error('edge must stream the encoded history without decoding it'); };
        return response;
      },
    };
  },
};
env.ARCHIVE = { async get() { edgeArchiveReads++; throw new Error('history must not decode in the edge Worker'); } };
const url = new URL('https://status.example/api/agent/metrics?agent_id=reader-fixture&hours=1&metric=cpu&format=columns&max_points=3600');
const previousCaches = globalThis.caches;
try {
  globalThis.caches = undefined;
  const denied = await reader.fetch(new Request('https://nie-sla.internal/public-metrics' + url.search));
  assert.equal(denied.status, 401);
  assert.equal(archiveReads, 0, 'the internal reader stays authenticated');

  const response = await getAgentMetricsCached(new Request(url), env, url);
  const body = JSON.parse(await response.text());
  const expected = await (await getAgentMetrics(readerEnv, url)).json();
  assert.deepEqual(body, expected, 'delegation preserves the full existing payload, field selection and precision');
  assert.equal(body.series.dt.length, 600);
  assert.deepEqual(body.series.fields, ['cpu']);
  assert.equal(edgeArchiveReads, 0);
  assert.ok(archiveReads > 0);
  assert.ok(names.includes(AGENT_METRICS_STREAM_INSTANCE), 'readers read live data from the separate ingestion instance');
  assert.equal(readerCalls, 1);

  const cache = new Map();
  globalThis.caches = { default: {
    async match(key) { return cache.get(key.url)?.clone(); },
    async put(key, value) { cache.set(key.url, value); },
  } };
  await getAgentMetricsCached(new Request(url), env, url);
  const callsAfterMiss = readerCalls;
  await getAgentMetricsCached(new Request(url), env, url);
  assert.equal(readerCalls, callsAfterMiss, 'existing edge caching still avoids repeated DO reads');

  const latestUrl = new URL(url);
  latestUrl.searchParams.set('history', '0');
  const latestResponse = await getAgentMetricsCached(new Request(latestUrl), env, latestUrl);
  assert.equal((await latestResponse.json()).latest.updated_at, latest.updated_at);
  assert.equal(readerCalls, callsAfterMiss, 'lightweight latest-only requests keep their existing path');

  globalThis.caches = undefined;
  for (const fallbackEnv of [
    { ...readerEnv, TELEMETRY_BUFFER: undefined },
    { ...readerEnv, INTERNAL_CRON_SECRET: '' },
  ]) {
    const fallback = await getAgentMetricsCached(new Request(url), fallbackEnv, url);
    assert.equal(fallback.status, 200, 'deployments without an authenticated reader keep their existing read path');
    assert.equal(readerCalls, callsAfterMiss);
  }

  const allocated = new Set();
  const boundedEnv = { INTERNAL_CRON_SECRET: env.INTERNAL_CRON_SECRET, TELEMETRY_BUFFER: {
    idFromName(name) { allocated.add(name); return name; },
    get() { return { async fetch() { return Response.json({ ok: true }); } }; },
  } };
  for (let i = 0; i < 256; i++) {
    const guessedUrl = new URL(url);
    guessedUrl.searchParams.set('agent_id', 'unknown-' + i);
    await readPublicAgentMetrics(boundedEnv, guessedUrl);
  }
  assert.ok(allocated.size <= 16, 'arbitrary public IDs cannot allocate an unbounded number of reader instances');
  assert.ok(!allocated.has(AGENT_METRICS_STREAM_INSTANCE));
} finally {
  if (previousCaches === undefined) delete globalThis.caches;
  else globalThis.caches = previousCaches;
}
console.log('public metrics reader tests passed: authorization, payload parity, streaming, cache, latest-only, fallback, bounded instances');
