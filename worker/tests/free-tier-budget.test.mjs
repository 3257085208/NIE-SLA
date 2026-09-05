import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const nodes = 100;
const latencyAgents = 2;
const reportsPerDay = 24 * 60 / 5;
const minutesPerDay = 24 * 60;
const daysPerMonth = 30;

// Phase-2 transport/storage model: metrics and probe buckets are no longer
// one HTTP/D1 write per sample.  WSS messages are handled by the existing
// TelemetryBuffer DO, while SLA buckets use one per-target ProbeHistory DO and
// one R2 object per completed local day. The public status stream adds one
// bounded publish request per scheduler minute in this conservative model;
// viewer connection churn is access-volume dependent and must be monitored
// separately.
const scaleNodes = 80;
const wssReportsPerDay = scaleNodes * reportsPerDay;
const regionProbeDoRequests = scaleNodes * reportsPerDay;
const statusStreamPublishRequests = minutesPerDay;
const controlHttpRequests = scaleNodes * (4 + (24 * 60 / 10) + 2 + 1); // reconnects + task poll + GeoIP + update policy
const publicStatusFallbackRequests = minutesPerDay * 6; // one visitor polling the cached public status every ten seconds
const publicAndCronRequests = minutesPerDay + minutesPerDay + (minutesPerDay / 5) + 144 + publicStatusFallbackRequests;
const phase2WorkerRequests = controlHttpRequests + publicAndCronRequests + latencyAgents * (minutesPerDay + minutesPerDay + 24);
const phase2DurableObjectRequests = wssReportsPerDay + regionProbeDoRequests + statusStreamPublishRequests;
const phase2ProbeHistoryD1Writes = 0;

assert.ok(phase2WorkerRequests < 100_000, `phase-2 80-node Worker request budget exceeded: ${phase2WorkerRequests}`);
assert.ok(phase2DurableObjectRequests < 100_000, `phase-2 80-node Durable Object request budget exceeded: ${phase2DurableObjectRequests}`);
assert.equal(phase2ProbeHistoryD1Writes, 0, 'phase-2 probe buckets must stay out of D1');

const workerRequests = nodes * (
  reportsPerDay
  + reportsPerDay
  + 24 * 6
  + 24 * 2
) + latencyAgents * (
  minutesPerDay
  + minutesPerDay
  + 24
) + minutesPerDay
  + nodes * 24;

const durableObjectRequests = nodes * reportsPerDay;

const d1Writes = nodes * (
  reportsPerDay
  + reportsPerDay * 2
  + 48
) + latencyAgents * minutesPerDay
  + (nodes + latencyAgents) * 4
  + 3 * reportsPerDay
  + 24;

const r2ClassA = nodes * 24 * daysPerMonth
  + latencyAgents * minutesPerDay * daysPerMonth
  + minutesPerDay * daysPerMonth
  + (minutesPerDay / 5) * daysPerMonth;

assert.ok(workerRequests < 100_000, `Worker request budget exceeded: ${workerRequests}`);
assert.ok(durableObjectRequests < 100_000, `Durable Object request budget exceeded: ${durableObjectRequests}`);
assert.ok(d1Writes < 100_000, `D1 write budget exceeded: ${d1Writes}`);
assert.ok(r2ClassA < 1_000_000, `R2 Class A budget exceeded: ${r2ClassA}`);

const bigNodes = 200;
const bigReportsPerDay = 24 * 60 / 10;
const bigWorkerRequests = bigNodes * (
  bigReportsPerDay
  + bigReportsPerDay
  + 24 * 6
  + 24 * 2
) + latencyAgents * (
  minutesPerDay
  + minutesPerDay
  + 24
) + minutesPerDay
  + bigNodes * 24;
const bigDurableObjectRequests = bigNodes * bigReportsPerDay;
const bigD1Writes = bigNodes * (
  bigReportsPerDay
  + bigReportsPerDay * 2
  + 48
) + latencyAgents * minutesPerDay
  + (bigNodes + latencyAgents) * 4
  + 3 * bigReportsPerDay
  + 24;

assert.ok(bigWorkerRequests >= 100_000, '200-node ten-minute scenario must stay outside the free tier');
assert.ok(bigDurableObjectRequests < 100_000, '200-node Durable Object request budget exceeded');
assert.ok(bigD1Writes >= 100_000, '200-node ten-minute D1 writes must stay outside the free tier');

const wrangler = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
assert.match(wrangler, /name = "TELEMETRY_BUFFER"/);
assert.match(wrangler, /name = "PROBE_HISTORY"/);
assert.match(wrangler, /PROBE_HISTORY_BUFFER = "true"/);
assert.match(wrangler, /STATUS_CACHE_TTL = "10"/);
assert.match(wrangler, /name = "STATUS_STREAM"/);
assert.match(wrangler, /STATUS_SNAPSHOT_EVERY_SEC = "300"/);
assert.match(wrangler, /AGENT_UPDATE_CHECK_SEC = "900"/);
assert.match(wrangler, /PUBLIC_WORKER_URL = "https:\/\/sla\.niekaixiang\.com"/);
assert.match(wrangler, /PUBLIC_AGENT_API_BASE = "https:\/\/sla\.niekaixiang\.com"/);
assert.match(wrangler, /AGENT_CREDENTIAL_TOUCH_SEC = "21600"/);
assert.match(wrangler, /TRAFFIC_PERSIST_INTERVAL_SEC = "1800"/);

console.log(`free-tier budget passed: legacy_worker_requests=${workerRequests}, phase2_80_worker_requests=${phase2WorkerRequests}, phase2_public_fallback_requests=${publicStatusFallbackRequests}, phase2_do_requests=${phase2DurableObjectRequests}, phase2_status_stream_publishes=${statusStreamPublishRequests}, phase2_probe_history_d1_writes=${phase2ProbeHistoryD1Writes}, d1_writes=${d1Writes}, r2_class_a=${r2ClassA}`);
