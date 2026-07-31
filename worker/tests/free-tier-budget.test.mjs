import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const nodes = 100;
const latencyAgents = 2;
const reportsPerDay = 24 * 60 / 5;
const minutesPerDay = 24 * 60;
const daysPerMonth = 30;

const workerRequests = nodes * (
  reportsPerDay       // metrics upload
  + reportsPerDay     // fixed task poll
  + 24 * 6            // ping-target refresh every ten minutes
  + 24 * 2            // telemetry and privileged-manager update checks
) + latencyAgents * (
  minutesPerDay       // target refresh
  + minutesPerDay     // result upload
  + 24                // update policy
) + minutesPerDay     // scheduled dispatch
  + nodes * 24;       // completed-hour telemetry alarms

const durableObjectRequests = nodes * reportsPerDay; // one telemetry buffer append per Agent report

const d1Writes = nodes * (
  reportsPerDay       // latest metric state
  + reportsPerDay * 2 // one SLA bucket and latest check status
  + 48                // traffic ledger, at most every thirty minutes
) + latencyAgents * minutesPerDay
  + (nodes + latencyAgents) * 4 // credential touch, at most every six hours
  + 3 * reportsPerDay // scheduled, alert, and probe diagnostics
  + 24;

const r2ClassA = nodes * 24 * daysPerMonth
  + latencyAgents * minutesPerDay * daysPerMonth
  + minutesPerDay * daysPerMonth
  + (minutesPerDay / 5) * daysPerMonth;

assert.ok(workerRequests < 100_000, `Worker request budget exceeded: ${workerRequests}`);
assert.ok(durableObjectRequests < 100_000, `Durable Object request budget exceeded: ${durableObjectRequests}`);
assert.ok(d1Writes < 100_000, `D1 write budget exceeded: ${d1Writes}`);
assert.ok(r2ClassA < 1_000_000, `R2 Class A budget exceeded: ${r2ClassA}`);

const wrangler = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
assert.match(wrangler, /name = "TELEMETRY_BUFFER"/);
assert.match(wrangler, /STATUS_SNAPSHOT_EVERY_SEC = "300"/);
assert.match(wrangler, /AGENT_CREDENTIAL_TOUCH_SEC = "21600"/);
assert.match(wrangler, /TRAFFIC_PERSIST_INTERVAL_SEC = "1800"/);

console.log(`free-tier budget passed: worker_requests=${workerRequests}, durable_object_requests>=${durableObjectRequests}, d1_writes=${d1Writes}, r2_class_a=${r2ClassA}`);
