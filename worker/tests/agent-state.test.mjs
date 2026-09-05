import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentStateTimestamp,
  bufferedAgentStateEnabled,
  mergeAgentMetricRows,
  newerAgentMetricRow,
} from '../src/agent-state.js';

test('buffered Agent state is opt-in through the production flag', () => {
  assert.equal(bufferedAgentStateEnabled({}), false);
  assert.equal(bufferedAgentStateEnabled({ TELEMETRY_BUFFER: {} }), false);
  assert.equal(bufferedAgentStateEnabled({ TELEMETRY_BUFFER: {}, AGENT_METRICS_STATE_TO_D1: 'false' }), true);
  assert.equal(bufferedAgentStateEnabled({ TELEMETRY_BUFFER: {}, AGENT_METRICS_STATE_TO_D1: 'true' }), false);
  assert.equal(bufferedAgentStateEnabled({ AGENT_METRICS_STATE_TO_D1: 'false' }), false);
});

test('buffered Agent state wins only when it is newer', () => {
  assert.equal(agentStateTimestamp('2026-09-03T00:00:10Z'), 1788393610);
  const old = { agent_id: 'vps-a', updated_at: '2026-09-03T00:00:00Z', cpu_percent: 10 };
  const newer = { agent_id: 'vps-a', updated_at: '2026-09-03T00:00:01Z', cpu_percent: 20 };
  assert.equal(newerAgentMetricRow(old, newer), newer);
  assert.equal(newerAgentMetricRow(newer, old), newer);
  assert.equal(newerAgentMetricRow(null, newer), newer);
});

test('merged Agent rows preserve D1 fallback and replace it per Agent', () => {
  const rows = mergeAgentMetricRows([
    { agent_id: 'vps-a', updated_at: '2026-09-03T00:00:00Z', cpu_percent: 10 },
    { agent_id: 'vps-b', updated_at: '2026-09-03T00:00:02Z', cpu_percent: 30 },
  ], {
    'vps-a': { agent_id: 'vps-a', updated_at: '2026-09-03T00:00:01Z', cpu_percent: 20 },
    'vps-b': { agent_id: 'vps-b', updated_at: '2026-09-03T00:00:01Z', cpu_percent: 40 },
    'vps-c': { agent_id: 'vps-c', updated_at: '2026-09-03T00:00:03Z', cpu_percent: 50 },
  });
  assert.deepEqual(rows.map(row => row.agent_id), ['vps-a', 'vps-b', 'vps-c']);
  assert.equal(rows.find(row => row.agent_id === 'vps-a').cpu_percent, 20);
  assert.equal(rows.find(row => row.agent_id === 'vps-b').cpu_percent, 30);
  assert.equal(rows.find(row => row.agent_id === 'vps-c').cpu_percent, 50);
});
