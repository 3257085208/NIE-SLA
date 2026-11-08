import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAgentMetrics, readAgentLatestStateR2, writeAgentLatestStateR2 } from '../src/metrics.js';
import { supplementAgentStatesFromR2 } from '../src/status.js';

function memoryR2() {
  const objects = new Map();
  return {
    objects,
    ARCHIVE: {
      async get(key) {
        const value = objects.get(key);
        return value ? { async json() { return structuredClone(value); } } : null;
      },
      async put(key, body) {
        const value = JSON.parse(String(body));
        objects.set(key, value);
        return { size: String(body).length };
      },
    },
  };
}

test('stale or unavailable DO state is filled from the R2 latest-state mirror', async () => {
  const r2 = memoryR2();
  const fresh = {
    schema: 'nie-sla-agent-metrics-v1',
    agent_id: 'vps-r2-state',
    updated_at: new Date().toISOString(),
    cpu_percent: 12,
  };
  await writeAgentLatestStateR2(r2, fresh);
  assert.deepEqual(await readAgentLatestStateR2(r2, fresh.agent_id), fresh);

  const env = {
    ...r2,
    TELEMETRY_BUFFER: {},
    AGENT_METRICS_STATE_TO_D1: 'false',
    AGENT_OFFLINE_AFTER_SEC: '900',
  };
  const states = {
    [fresh.agent_id]: { agent_id: fresh.agent_id, updated_at: '2020-01-01T00:00:00.000Z', cpu_percent: 1 },
    'missing-agent': { agent_id: 'missing-agent', updated_at: '2020-01-01T00:00:00.000Z', cpu_percent: 2 },
  };
  await supplementAgentStatesFromR2(env, states, Object.keys(states));
  assert.equal(states[fresh.agent_id].cpu_percent, 12);
  assert.equal(states['missing-agent'].cpu_percent, 2, 'an absent R2 object must leave existing data untouched');
  assert.equal(await writeAgentLatestStateR2({}, fresh), false);

  const db = {
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
  const metricsEnv = {
    ...env,
    DB: db,
    ARCHIVE: r2.ARCHIVE,
    PUBLIC_STATUS_AGENT_DETAILS: 'false',
  };
  const response = await getAgentMetrics(metricsEnv, new URL(`https://status.example/api/agent/metrics?agent_id=${fresh.agent_id}&hours=1`));
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.latest.cpu_percent, 12);
  assert.equal(body.history.length, 1, 'the latest R2 state must keep the chart non-empty while the DO is unavailable');
});

console.log('Agent R2 latest-state fallback tests passed');
