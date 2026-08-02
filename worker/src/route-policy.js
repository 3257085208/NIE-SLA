const AGENT_API_PATHS = new Set([
  '/api/agent/targets',
  '/api/agent/results',
  '/api/agent/metrics',
  '/api/agent/update-policy',
  '/api/agent/ping-targets',
  '/api/agent/pings',
  '/api/agent/config',
  '/api/agent/location',
  '/api/agent/tasks',
  '/api/agent/tasks/{id}/cancel-status',
  '/api/latency-agent/targets',
  '/api/latency-agent/results',
  '/api/latency-agent/update-policy',
]);

export function isAgentApiPath(path) {
  const normalized = String(path || '');
  return AGENT_API_PATHS.has(normalized) || normalized.startsWith('/api/agent/tasks/');
}
