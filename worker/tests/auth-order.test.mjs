import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { submitAgentMetrics } from '../src/metrics.js';
import { submitAgentPings } from '../src/admin/ping-targets.js';
import { requireAnyLatencyAgent, ApiError } from '../src/auth.js';

const routesSource = await readFile(new URL('../src/routes.js', import.meta.url), 'utf8');
const metricsSource = await readFile(new URL('../src/metrics.js', import.meta.url), 'utf8');
const pingsSource = await readFile(new URL('../src/admin/ping-targets.js', import.meta.url), 'utf8');
const authSource = await readFile(new URL('../src/auth.js', import.meta.url), 'utf8');

function throwingBody() {
  let pulls = 0;
  return new globalThis.ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) controller.enqueue('{}');
      else throw new Error('request body must not be fully read without credentials');
    },
  });
}

function guardedRequest(url) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '2' },
    body: throwingBody(),
    duplex: 'half',
  });
}

async function rejectsUnauthorized(fn) {
  let error = null;
  try {
    await fn();
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof ApiError, 'expected ApiError');
  assert.equal(error.status, 401);
}

{
  await rejectsUnauthorized(() => submitAgentMetrics(guardedRequest('https://api.example.test/api/agent/metrics'), { DB: {} }));
}

{
  await rejectsUnauthorized(() => submitAgentPings(guardedRequest('https://api.example.test/api/agent/pings'), { DB: {} }));
}

{
  await rejectsUnauthorized(() => requireAnyLatencyAgent(guardedRequest('https://api.example.test/api/latency-agent/results'), { DB: {} }));
}

{
  const ok = await requireAnyLatencyAgent(
    new Request('https://api.example.test/api/latency-agent/results', {
      headers: { authorization: 'Bearer global-token' },
    }),
    { AGENT_TOKEN: 'global-token' },
  );
  assert.deepEqual(ok, { type: 'global' });
}

assert.match(authSource, /export async function requireAnyLatencyAgent/, 'latency-wide auth helper must exist');
assert.match(metricsSource, /await requireAnyAgent\(request, env\);[\s\S]{0,120}await safeJson\(request\)/, 'metrics must authenticate before parsing the body');
assert.match(pingsSource, /await requireAnyAgent\(request, env\);[\s\S]{0,120}await safeJson\(request\)/, 'pings must authenticate before parsing the body');
assert.match(routesSource, /path === '\/api\/latency-agent\/results' && m === 'POST'[\s\S]{0,200}requireAnyLatencyAgent[\s\S]{0,200}await safeJson\(request\)/, 'latency results must authenticate before parsing the body');

console.log('auth order tests passed');
