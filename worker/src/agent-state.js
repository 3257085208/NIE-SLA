import { parseBoolean, sanitizeAgentId } from './utils.js';

export function bufferedAgentStateEnabled(env = {}) {
  return Boolean(env?.TELEMETRY_BUFFER)
    && parseBoolean(env?.AGENT_METRICS_STATE_TO_D1 ?? true, true) === false;
}

export function agentStateTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.floor(value) : 0;
  const parsed = Math.floor(new Date(value || 0).getTime() / 1000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function newerAgentMetricRow(current, candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return current || null;
  if (!current) return candidate;
  return agentStateTimestamp(candidate.updated_at) >= agentStateTimestamp(current.updated_at)
    ? candidate
    : current;
}

export function mergeAgentMetricRows(d1Rows = [], bufferedStates = {}) {
  const byAgent = new Map();
  for (const row of d1Rows || []) {
    const id = sanitizeAgentId(row?.agent_id);
    if (!id) continue;
    byAgent.set(id, newerAgentMetricRow(byAgent.get(id), row));
  }
  for (const [key, state] of Object.entries(bufferedStates || {})) {
    const id = sanitizeAgentId(state?.agent_id || key);
    if (!id) continue;
    byAgent.set(id, newerAgentMetricRow(byAgent.get(id), { ...state, agent_id: id }));
  }
  return [...byAgent.values()];
}
