import { VERSION } from '../version.js';

export async function getFleetVersions(env) {
  const rows = await env.DB.prepare(`SELECT agent_version, COUNT(*) AS count FROM agent_metrics_state WHERE agent_version IS NOT NULL AND agent_version != '' GROUP BY agent_version ORDER BY count DESC`).all();
  const current = `v${VERSION}`;
  const versions = (rows.results || []).map((row) => ({ version: String(row.agent_version || '').trim(), count: Number(row.count || 0) }));
  if (!versions.some((entry) => entry.version.replace(/^v/, '') === VERSION)) versions.unshift({ version: current, count: 0 });
  return { ok: true, current_version: VERSION, versions };
}
