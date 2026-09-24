import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usageInputsFromEnv } from '../src/admin/usage-model.js';

const now = Math.floor(Date.now() / 1000);

function mockDb({ agents = 3, wssAgents = 2, targets = 2, pingTargets = 5, latencyNodes = 2, trafficAgents = 1 } = {}) {
  return {
    prepare(sql) {
      const api = {
        bind: () => api,
        async first() {
          if (sql.includes('ping_targets')) return { n: pingTargets };
          if (sql.includes('latency_agents')) return { n: latencyNodes };
          if (sql.includes('traffic_enabled = 1')) return { n: trafficAgents };
          if (sql.includes('capabilities')) return { n: wssAgents };
          if (sql.includes('FROM agent_metrics_state')) return { n: agents };
          if (sql.includes('FROM targets')) return { n: targets };
          return { n: 0 };
        },
        async all() {
          if (sql.includes('FROM targets')) {
            return {
              results: [
                { id: 'agent-a', traffic_enabled: 1, no_public_ip: 0 },
                { id: 'agent-b', traffic_enabled: 0, no_public_ip: 1 },
                { id: 'agent-offline', traffic_enabled: 1, no_public_ip: 0 },
              ],
            };
          }
          return { results: [] };
        },
      };
      return api;
    },
  };
}

function bufferedEnv(states, extra = {}) {
  return {
    DB: mockDb(),
    AGENT_METRICS_STATE_TO_D1: 'false',
    AGENT_OFFLINE_AFTER_SEC: '1800',
    INTERNAL_CRON_SECRET: 'test-secret',
    TELEMETRY_BUFFER: {
      idFromName: (name) => name,
      get: () => ({
        async fetch() {
          return new Response(JSON.stringify({ states, last_seen: {} }), {
            headers: { 'content-type': 'application/json' },
          });
        },
      }),
    },
    ...extra,
  };
}

test('buffered fleet snapshot drives the model inputs when the D1 mirror is off', async () => {
  const env = bufferedEnv({
    'agent-a': { updated_at: now - 60, agent_version: 'v1.1.99' },
    'agent-b': { updated_at: now - 60, agent_version: 'v1.1.10' },
    'agent-offline': { updated_at: now - 7200, agent_version: 'v1.1.99' },
    'not-a-target': { updated_at: now - 60, agent_version: 'v1.1.99' },
  });
  const inputs = await usageInputsFromEnv(env);
  assert.equal(inputs.agents, 2, 'only fresh, enabled targets count as online agents');
  assert.equal(inputs.wssAgents, 1, 'only v1.1.16+ agents are treated as WSS capable');
  assert.equal(inputs.trafficAgents, 1, 'traffic agents follow the target setting');
  assert.equal(inputs.targets, 2, 'probe targets exclude no_public_ip entries');
  assert.equal(inputs.pingTargets, 5);
  assert.equal(inputs.latencyNodes, 2);
});

test('empty buffered snapshot falls back to the D1 state mirror', async () => {
  const env = bufferedEnv({});
  const inputs = await usageInputsFromEnv(env);
  assert.equal(inputs.agents, 3);
  assert.equal(inputs.wssAgents, 2);
  assert.equal(inputs.trafficAgents, 1);
});

test('buffer failures fall back to the D1 state mirror instead of zeros', async () => {
  const env = bufferedEnv({}, {});
  env.TELEMETRY_BUFFER = {
    idFromName: (name) => name,
    get: () => ({
      async fetch() {
        throw new Error('DO unavailable');
      },
    }),
  };
  const inputs = await usageInputsFromEnv(env);
  assert.equal(inputs.agents, 3);
});

test('D1 fallback stays in charge when the buffered mode is disabled', async () => {
  const env = {
    DB: mockDb({ agents: 4, wssAgents: 3, trafficAgents: 2 }),
    AGENT_METRICS_STATE_TO_D1: 'true',
    AGENT_OFFLINE_AFTER_SEC: '1800',
  };
  const inputs = await usageInputsFromEnv(env);
  assert.equal(inputs.agents, 4);
  assert.equal(inputs.wssAgents, 3);
  assert.equal(inputs.trafficAgents, 2);
  assert.equal(inputs.targets, 2);
});
