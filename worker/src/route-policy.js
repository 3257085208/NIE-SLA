const AGENT_API_PATHS = new Set([
  '/api/agent/targets',
  '/api/agent/results',
  '/api/agent/metrics',
  '/api/agent/update-policy',
  '/api/agent/ping-targets',
  '/api/agent/pings',
  '/api/latency-agent/targets',
  '/api/latency-agent/results',
]);

export function isAgentApiPath(path) {
  return AGENT_API_PATHS.has(String(path || ''));
}
