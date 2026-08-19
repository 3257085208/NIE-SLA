import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const nodes = 100;
const latencyAgents = 2;
const reportsPerDay = 24 * 60 / 5;
const minutesPerDay = 24 * 60;
const daysPerMonth = 30;

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
assert.match(wrangler, /STATUS_SNAPSHOT_EVERY_SEC = "300"/);
assert.match(wrangler, /AGENT_REPORT_INTERVAL_SEC = "300"/);
assert.match(wrangler, /AGENT_UPDATE_CHECK_SEC = "86400"/);
assert.match(wrangler, /AGENT_CREDENTIAL_TOUCH_SEC = "21600"/);
assert.match(wrangler, /TRAFFIC_PERSIST_INTERVAL_SEC = "1800"/);

console.log(`free-tier budget passed: worker_requests=${workerRequests}, durable_object_requests>=${durableObjectRequests}, d1_writes=${d1Writes}, r2_class_a=${r2ClassA}`);
