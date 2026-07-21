import { safeJson, latencyAgentScopedToken } from '../auth.js';
import { clamp, nowSec, parseBoolean, sanitizeAgentId } from '../utils.js';
import { agentApiBase, agentInstallBase, shellQuote } from './install-command.js';

const RESULT_BUCKET_SEC = 60;

export async function listLatencyAgents(env) {
  const rows = await env.DB.prepare(`SELECT id, name, enabled, last_seen_at, created_at, updated_at FROM latency_agents ORDER BY name COLLATE NOCASE`).all();
  return { ok: true, builtin: { id: 'cloudflare', name: 'Cloudflare', builtin: true, enabled: true }, nodes: rows.results || [] };
}

export async function createLatencyAgent(request, env) {
  const body = await safeJson(request);
  const name = normalizeNodeName(body?.name);
  const requestedId = sanitizeAgentId(body?.id || '');
  const id = requestedId || `latency-${crypto.randomUUID().slice(0, 8)}`;
  const now = nowSec();
  await env.DB.prepare(`INSERT INTO latency_agents (id, name, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`).bind(id, name, now, now).run();
  return { ok: true, id, name };
}

export async function updateLatencyAgent(id, request, env) {
  const cleanId = sanitizeAgentId(id);
  const existing = await env.DB.prepare(`SELECT * FROM latency_agents WHERE id = ?`).bind(cleanId).first();
  if (!existing) return { ok: false, error: 'Latency 节点不存在' };
  const body = await safeJson(request);
  const name = body?.name === undefined ? existing.name : normalizeNodeName(body.name);
  const enabled = body?.enabled === undefined ? Number(existing.enabled) : (parseBoolean(body.enabled, true) ? 1 : 0);
  await env.DB.prepare(`UPDATE latency_agents SET name = ?, enabled = ?, updated_at = ? WHERE id = ?`).bind(name, enabled, nowSec(), cleanId).run();
  return { ok: true, id: cleanId };
}

export async function deleteLatencyAgent(id, env) {
  const cleanId = sanitizeAgentId(id);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM latency_results WHERE node_id = ?`).bind(cleanId),
    env.DB.prepare(`DELETE FROM latency_agents WHERE id = ?`).bind(cleanId),
  ]);
  return { ok: true, id: cleanId };
}

export async function getLatencyAgentInstallCommand(env, url, request = null) {
  const nodeId = sanitizeAgentId(url.searchParams.get('node_id') || '');
  if (!nodeId) return { ok: false, error: '必须提供 node_id' };
  const node = await env.DB.prepare(`SELECT id, name FROM latency_agents WHERE id = ?`).bind(nodeId).first().catch(() => null);
  if (!node) return { ok: false, error: 'Latency 节点不存在' };
  const token = await latencyAgentScopedToken(env, nodeId);
  if (!token) return { ok: false, error: '生成 Latency 节点专用 Token 失败' };
  const installBase = agentInstallBase(env, request);
  if (!installBase) return { ok: false, error: 'Latency 安装地址不可用，请配置 PUBLIC_AGENT_INSTALL_BASE' };
  const apiBase = agentApiBase(env, request, url, installBase);
  const intervalSec = String(clamp(Number(env.LATENCY_AGENT_INTERVAL_SEC || 60), 30, 600));
  const envNames = ['NSTATUS_LATENCY_INSTALL_BASE', 'NSTATUS_LATENCY_API_BASE', 'NSTATUS_LATENCY_TOKEN', 'NSTATUS_LATENCY_NODE_ID', 'NSTATUS_LATENCY_INTERVAL_SEC'];
  const envValues = [
    ['NSTATUS_LATENCY_INSTALL_BASE', installBase],
    ['NSTATUS_LATENCY_API_BASE', apiBase],
    ['NSTATUS_LATENCY_TOKEN', token],
    ['NSTATUS_LATENCY_NODE_ID', nodeId],
    ['NSTATUS_LATENCY_INTERVAL_SEC', intervalSec],
  ];
  const prefix = envValues.map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
  const command = [
    `${prefix}; export ${envNames.join(' ')}`,
    'tmp=$(mktemp)',
    `trap 'rm -f "$tmp"' EXIT`,
    `curl -fsSL ${shellQuote(`${installBase}/install-latency.sh?v=1`)} -o "$tmp"`,
    `(if [ "$(id -u)" -eq 0 ]; then sh "$tmp"; else sudo --preserve-env=${envNames.join(',')} sh "$tmp"; fi)`,
  ].join(' && ');
  return { ok: true, node_id: nodeId, node_name: node.name, api_base: apiBase, install_base: installBase, linux_command: command };
}

export async function getLatencyAgentTargets(env) {
  const rows = await env.DB.prepare(`SELECT id, name, target_host, target_port, timeout_ms FROM targets WHERE enabled = 1 AND type = 'tcp' AND COALESCE(no_public_ip, 0) = 0 AND target_host IS NOT NULL AND target_port IS NOT NULL ORDER BY group_name COLLATE NOCASE, name COLLATE NOCASE`).all();
  return {
    ok: true,
    interval_sec: clamp(Number(env.LATENCY_AGENT_INTERVAL_SEC || 60), 30, 600),
    targets: (rows.results || []).map(row => ({ ...row, target_port: Number(row.target_port), timeout_ms: clamp(Number(row.timeout_ms || 5000), 500, 30000) })),
  };
}

export async function submitLatencyAgentResults(request, env, body = null) {
  const data = body || await safeJson(request);
  const nodeId = sanitizeAgentId(data?.node_id || '');
  const results = Array.isArray(data?.results) ? data.results.slice(0, 500) : [];
  if (!nodeId || !results.length) return { ok: false, error: 'node_id 和非空 results 为必填项' };
  const targetIds = [...new Set(results.map(row => String(row?.target_id || '').trim()).filter(Boolean))];
  const allowed = new Set();
  for (let offset = 0; offset < targetIds.length; offset += 80) {
    const chunk = targetIds.slice(offset, offset + 80);
    const marks = chunk.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT id FROM targets WHERE enabled = 1 AND type = 'tcp' AND COALESCE(no_public_ip, 0) = 0 AND id IN (${marks})`).bind(...chunk).all();
    for (const row of rows.results || []) allowed.add(String(row.id));
  }
  const now = nowSec();
  const statements = [];
  for (const result of results) {
    const targetId = String(result?.target_id || '').trim();
    if (!allowed.has(targetId)) continue;
    const rawTs = Number(result?.checked_at || now);
    if (!Number.isFinite(rawTs) || rawTs < now - 900 || rawTs > now + 300) continue;
    const checkedAt = Math.floor(rawTs / RESULT_BUCKET_SEC) * RESULT_BUCKET_SEC;
    const latency = result?.latency_ms == null ? null : Math.round(Number(result.latency_ms));
    const ok = result?.ok === undefined ? Number.isFinite(latency) && latency >= 0 : parseBoolean(result.ok, false);
    const error = ok ? null : String(result?.error || '连接失败').slice(0, 200);
    statements.push(env.DB.prepare(`INSERT OR REPLACE INTO latency_results (node_id, target_id, checked_at, latency_ms, ok, error) VALUES (?, ?, ?, ?, ?, ?)`).bind(nodeId, targetId, checkedAt, Number.isFinite(latency) && latency >= 0 ? latency : null, ok ? 1 : 0, error));
  }
  for (let offset = 0; offset < statements.length; offset += 80) await env.DB.batch(statements.slice(offset, offset + 80));
  await env.DB.prepare(`UPDATE latency_agents SET last_seen_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, nodeId).run();
  await cleanupLatencyResults(env, now);
  return { ok: true, node_id: nodeId, accepted: statements.length };
}

export async function getPublicLatency(env, url) {
  const targetId = String(url.searchParams.get('target_id') || '').trim();
  if (!targetId) return { ok: false, error: '必须提供 target_id' };
  const hours = clamp(Number(url.searchParams.get('hours') || 24), 1, 168);
  const since = nowSec() - hours * 3600;
  const rows = await env.DB.prepare(`SELECT r.node_id, a.name AS node_name, r.checked_at, r.latency_ms, r.ok FROM latency_results r JOIN latency_agents a ON a.id = r.node_id AND a.enabled = 1 WHERE r.target_id = ? AND r.checked_at >= ? ORDER BY r.checked_at ASC`).bind(targetId, since).all();
  return { ok: true, target_id: targetId, sources: groupLatencySeries(rows.results || []) };
}

export async function getLatestExternalLatencyByTarget(env, targetIds) {
  const ids = [...new Set((targetIds || []).map(String).filter(Boolean))];
  const byTarget = new Map();
  if (!ids.length) return byTarget;
  const since = nowSec() - clamp(Number(env.LATENCY_AGENT_STALE_SEC || 600), 120, 3600);
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const marks = chunk.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT r.node_id, r.target_id, a.name AS node_name, r.checked_at, r.latency_ms, r.ok FROM latency_results r JOIN latency_agents a ON a.id = r.node_id AND a.enabled = 1 WHERE r.target_id IN (${marks}) AND r.checked_at >= ? ORDER BY r.checked_at DESC`).bind(...chunk, since).all();
    const seen = new Set();
    for (const row of rows.results || []) {
      const key = `${row.target_id}|${row.node_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list = byTarget.get(String(row.target_id)) || [];
      list.push({ id: row.node_id, name: row.node_name, kind: 'external', checked_at: Number(row.checked_at), latency_ms: row.latency_ms == null ? null : Number(row.latency_ms), ok: Number(row.ok) === 1 });
      byTarget.set(String(row.target_id), list);
    }
  }
  return byTarget;
}

function normalizeNodeName(value) {
  const name = String(value || '').trim().slice(0, 64);
  if (!name) throw new Error('Latency 节点名称不能为空');
  return name;
}

function groupLatencySeries(rows) {
  const sources = new Map();
  for (const row of rows) {
    const id = String(row.node_id);
    const source = sources.get(id) || { id, name: row.node_name, kind: 'external', points: [] };
    source.points.push({ checked_at: Number(row.checked_at), latency_ms: row.latency_ms == null ? null : Number(row.latency_ms), ok: Number(row.ok) === 1 });
    sources.set(id, source);
  }
  return [...sources.values()];
}

async function cleanupLatencyResults(env, now) {
  const key = 'latency-results:last-cleanup';
  const previous = Number((await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(key).first().catch(() => null))?.value || 0);
  if (previous > now - 3600) return;
  const retention = clamp(Number(env.LATENCY_RESULT_RETENTION_HOURS || 72), 24, 168) * 3600;
  await env.DB.prepare(`DELETE FROM latency_results WHERE checked_at < ?`).bind(now - retention).run();
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).bind(key, String(now), now).run();
}
