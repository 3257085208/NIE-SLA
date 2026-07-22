export function compactStatusPayload(payload) {
  const targets = (payload.targets || []).map((target) => ({
    ...withoutKeys(target, ['daily', 'agent_metrics']),
    agent_metrics: target.agent_metrics ? withoutKeys(target.agent_metrics, ['pings']) : null,
  }));
  return {
    ok: payload.ok,
    name: payload.name,
    now: payload.now,
    days: payload.days,
    regions: payload.regions,
    region_proxy_enabled: payload.region_proxy_enabled,
    frontend_theme: payload.frontend_theme,
    frontend: payload.frontend,
    traffic: payload.traffic,
    ping_targets: payload.ping_targets || [],
    privacy: payload.privacy,
    storage: payload.storage,
    timezone: payload.timezone,
    targets,
    summaries: payload.summaries || [],
    incidents: payload.incidents || [],
    warnings: payload.warnings || [],
    lite: true,
  };
}

export function refreshLatencySources(target, externalSources = []) {
  const result = { ...(target || {}) };
  if (Number(result.no_public_ip || 0) === 1) {
    result.latency_sources = [];
    return result;
  }
  result.latency_sources = [
    {
      id: 'cloudflare',
      name: 'Cloudflare',
      kind: 'cloudflare',
      builtin: true,
      checked_at: result.checked_at || null,
      latency_ms: result.latency_ms ?? null,
      ok: Number(result.ok) === 1,
    },
    ...(result.type === 'tcp' ? externalSources : []),
  ];
  return result;
}

function withoutKeys(value, keys) {
  const result = { ...(value || {}) };
  for (const key of keys) delete result[key];
  return result;
}
