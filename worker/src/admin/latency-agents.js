import { ApiError, safeJson } from '../auth.js';
import { getOrCreateAgentToken } from '../agent-credentials.js';
import { clamp, nowSec, parseBoolean, sanitizeAgentId, sha256Hex } from '../utils.js';
import { agentApiBase, agentInstallBase, shellQuote } from './install-command.js';
import { getMeta, getPublicSettings, setMeta } from './settings.js';

const RESULT_BUCKET_SEC = 60;
const D1_FALLBACK_BUCKET_SEC = 300;
const ARCHIVE_SEGMENT_SEC = 6 * 3600;
const ARCHIVE_SCHEMA = 'nie-sla-latency-segment-v1';
const LATENCY_SCRIPT_VERSION = 6;
const LATENCY_SCRIPT_SHA256 = '572822759ae0e370f6ca916bf2cd0b866b77e93abb159b5fbf368c199d9cfa88';
const LATENCY_INSTALLER_SHA256 = '3f5c6845d162f5bd817ff557d500d1f9e1606c382a397e326f6f06ca6e5f1fe8';
const INSTALL_TICKET_PREFIX = 'nsi_';
const INSTALL_TICKET_BYTES = 24;
const INSTALL_TICKET_TTL_SEC = 600;
const LATENCY_TICKET_PREFIX = 'latency:';

export async function listLatencyAgents(env) {
  const rows = await env.DB.prepare(`SELECT id, name, color, enabled, last_seen_at, created_at, updated_at FROM latency_agents ORDER BY name COLLATE NOCASE`).all();
  const cfColor = normalizeChartColor(await getMeta(env, 'latency_cloudflare_color'), '#159754');
  return { ok: true, builtin: { id: 'cloudflare', name: 'Cloudflare', color: cfColor, builtin: true, enabled: true }, nodes: rows.results || [] };
}

export async function createLatencyAgent(request, env) {
  const body = await safeJson(request);
  const name = normalizeNodeName(body?.name);
  const requestedId = sanitizeAgentId(body?.id || '');
  const id = requestedId || `latency-${crypto.randomUUID().slice(0, 8)}`;
  const color = normalizeChartColor(body?.color, '#2e7dd7');
  if (body?.color !== undefined && !/^#[0-9a-f]{6}$/i.test(String(body.color).trim())) throw new ApiError(400, '颜色必须是 #RRGGBB 格式');
  if (id === 'cloudflare') throw new ApiError(400, 'Cloudflare 是系统内置来源，不能重复创建');
  const now = nowSec();
  await env.DB.prepare(`INSERT INTO latency_agents (id, name, color, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`).bind(id, name, color, now, now).run();
  return { ok: true, id, name };
}

export async function updateLatencyAgent(id, request, env) {
  const cleanId = sanitizeAgentId(id);
  if (cleanId === 'cloudflare') {
    const body = await safeJson(request);
    const color = normalizeChartColor(body?.color, '');
    if (!color) throw new ApiError(400, '颜色必须是 #RRGGBB 格式');
    await setMeta(env, 'latency_cloudflare_color', color);
    return { ok: true, id: 'cloudflare', builtin: true, color };
  }
  const existing = await env.DB.prepare(`SELECT * FROM latency_agents WHERE id = ?`).bind(cleanId).first();
  if (!existing) return { ok: false, error: 'Latency 节点不存在' };
  const body = await safeJson(request);
  const name = body?.name === undefined ? existing.name : normalizeNodeName(body.name);
  const color = body?.color === undefined ? normalizeChartColor(existing.color, '#2e7dd7') : normalizeChartColor(body.color, '');
  if (!color) throw new ApiError(400, '颜色必须是 #RRGGBB 格式');
  const enabled = body?.enabled === undefined ? Number(existing.enabled) : (parseBoolean(body.enabled, true) ? 1 : 0);
  await env.DB.prepare(`UPDATE latency_agents SET name = ?, color = ?, enabled = ?, updated_at = ? WHERE id = ?`).bind(name, color, enabled, nowSec(), cleanId).run();
  return { ok: true, id: cleanId };
}

export async function deleteLatencyAgent(id, env) {
  const cleanId = sanitizeAgentId(id);
  if (cleanId === 'cloudflare') throw new ApiError(400, 'Cloudflare 内置来源不可删除');
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM latency_results WHERE node_id = ?`).bind(cleanId),
    env.DB.prepare(`DELETE FROM agent_credentials WHERE subject_type = 'latency' AND subject_id = ?`).bind(cleanId),
    env.DB.prepare(`DELETE FROM agent_install_tickets WHERE target_id = ?`).bind(`${LATENCY_TICKET_PREFIX}${cleanId}`),
    env.DB.prepare(`DELETE FROM latency_agents WHERE id = ?`).bind(cleanId),
  ]);
  await deleteLatencyArchive(env, cleanId);
  return { ok: true, id: cleanId };
}

export async function getLatencyAgentInstallCommand(env, url, request = null) {
  const nodeId = sanitizeAgentId(url.searchParams.get('node_id') || '');
  if (!nodeId) return { ok: false, error: '必须提供 node_id' };
  const node = await env.DB.prepare(`SELECT id, name FROM latency_agents WHERE id = ?`).bind(nodeId).first().catch(() => null);
  if (!node) return { ok: false, error: 'Latency 节点不存在' };
  const installBase = await agentInstallBase(env, request);
  if (!installBase) return { ok: false, error: 'Latency 安装地址不可用，请配置 PUBLIC_AGENT_INSTALL_BASE' };
  const apiBase = await agentApiBase(env, request, url, installBase);
  const intervalSec = String(clamp(Number(env.LATENCY_AGENT_INTERVAL_SEC || 60), 30, 600));
  const installTicket = randomInstallTicket();
  const now = nowSec();
  const expiresAt = now + INSTALL_TICKET_TTL_SEC;
  await env.DB.prepare(`INSERT INTO agent_install_tickets
    (token_hash, target_id, install_base, api_base, target_label, ping_sec, manifest_sha256, expected_version, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      await sha256Hex(installTicket), `${LATENCY_TICKET_PREFIX}${nodeId}`, installBase, apiBase,
      String(node.name || nodeId).trim() || nodeId, Number(intervalSec), LATENCY_SCRIPT_SHA256,
      String(LATENCY_SCRIPT_VERSION), now, expiresAt,
    )
    .run();
  await cleanupLatencyInstallTickets(env, now);

  const linuxCommand = `(t=$(mktemp) && trap 'rm -f "$t"' EXIT INT TERM && chmod 0600 "$t" && curl -fsSL -H ${shellQuote(`Authorization: Bearer ${installTicket}`)} ${shellQuote(`${apiBase}/api/latency-agent/install-script`)} -o "$t" && sh "$t")`;
  return {
    ok: true,
    node_id: nodeId,
    node_name: node.name,
    api_base: apiBase,
    install_base: installBase,
    credential_bound: true,
    credential_type: 'one_time_latency_install_token',
    install_token_expires_at: expiresAt,
    linux_command: linuxCommand,
  };
}

export async function getLatencyAgentInstallScript(env, request) {
  const ticket = bearerToken(request);
  if (!new RegExp(`^${INSTALL_TICKET_PREFIX}[a-f0-9]{${INSTALL_TICKET_BYTES * 2}}$`).test(ticket)) {
    throw new ApiError(401, '安装凭据无效、已过期或已使用');
  }

  const now = nowSec();
  const row = await env.DB.prepare(`UPDATE agent_install_tickets SET used_at = ?
    WHERE token_hash = ? AND target_id LIKE ? AND used_at IS NULL AND expires_at >= ?
    RETURNING target_id, install_base, api_base, target_label, ping_sec, manifest_sha256, expected_version`)
    .bind(now, await sha256Hex(ticket), `${LATENCY_TICKET_PREFIX}%`, now)
    .first()
    .catch(() => null);
  if (!row?.target_id) throw new ApiError(401, '安装凭据无效、已过期或已使用');

  const nodeId = String(row.target_id).slice(LATENCY_TICKET_PREFIX.length);
  if (!nodeId || sanitizeAgentId(nodeId) !== nodeId) throw new ApiError(410, 'Latency 节点凭据无效，请重新生成安装命令');
  const node = await env.DB.prepare(`SELECT id FROM latency_agents WHERE id = ?`).bind(nodeId).first().catch(() => null);
  if (!node) throw new ApiError(410, 'Latency 节点已不存在，请重新生成安装命令');
  const token = await getOrCreateAgentToken(env, 'latency', nodeId);
  if (!token) throw new ApiError(500, '无法读取 Latency 节点专用 Token');

  const script = buildLatencyInstallScript({
    installBase: row.install_base,
    apiBase: row.api_base,
    token,
    nodeId,
    intervalSec: row.ping_sec,
    scriptSha256: row.manifest_sha256,
    scriptVersion: row.expected_version,
  });
  return new Response(script, {
    status: 200,
    headers: {
      'cache-control': 'no-store, max-age=0',
      'content-type': 'text/x-shellscript; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}

function buildLatencyInstallScript(config) {
  const envValues = [
    ['NSTATUS_LATENCY_INSTALL_BASE', config.installBase],
    ['NSTATUS_LATENCY_API_BASE', config.apiBase],
    ['NSTATUS_LATENCY_TOKEN', config.token],
    ['NSTATUS_LATENCY_NODE_ID', config.nodeId],
    ['NSTATUS_LATENCY_INTERVAL_SEC', String(clamp(Number(config.intervalSec || 60), 30, 600))],
    ['NSTATUS_LATENCY_SCRIPT_SHA256', config.scriptSha256],
  ];
  const envNames = envValues.map(([key]) => key);
  const preserveEnv = envNames.join(',');
  return [
    '#!/bin/sh',
    'set -eu',
    ...envValues.map(([key, value]) => `${key}=${shellQuote(value)}`),
    `export ${envNames.join(' ')}`,
    'tmp=$(mktemp)',
    'chmod 0600 "$tmp"',
    `trap 'rm -f "$tmp"' EXIT INT TERM`,
    `curl -fsSL ${shellQuote(`${config.installBase}/install-latency.sh?v=${encodeURIComponent(String(config.scriptVersion || LATENCY_SCRIPT_VERSION))}`)} -o "$tmp"`,
    `actual=$(if command -v sha256sum >/dev/null 2>&1; then sha256sum "$tmp" | awk '{print $1}'; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$tmp" | awk '{print $1}'; elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$tmp" | awk '{print $NF}'; else exit 127; fi)`,
    `[ "$actual" = ${shellQuote(LATENCY_INSTALLER_SHA256)} ]`,
    `if [ "$(id -u)" -eq 0 ]; then sh "$tmp"; else sudo --preserve-env=${preserveEnv} sh "$tmp"; fi`,
    '',
  ].join('\n');
}

async function cleanupLatencyInstallTickets(env, now) {
  await env.DB.prepare(`DELETE FROM agent_install_tickets
    WHERE target_id LIKE ? AND (expires_at < ? OR (used_at IS NOT NULL AND used_at < ?))`)
    .bind(`${LATENCY_TICKET_PREFIX}%`, now - 3600, now - 3600)
    .run()
    .catch(() => {});
}

function randomInstallTicket() {
  const bytes = crypto.getRandomValues(new Uint8Array(INSTALL_TICKET_BYTES));
  return INSTALL_TICKET_PREFIX + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function bearerToken(request) {
  const match = String(request?.headers?.get?.('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return String(match?.[1] || '').trim();
}

export async function getLatencyAgentUpdatePolicy(env) {
  const settings = await getPublicSettings(env);
  return {
    ok: true,
    auto_update: settings.agent_auto_update,
    check_interval_sec: clamp(Number(env.LATENCY_AGENT_UPDATE_CHECK_SEC || 3600), 300, 86400),
    script_version: LATENCY_SCRIPT_VERSION,
    script_sha256: LATENCY_SCRIPT_SHA256,
  };
}

export async function getLatencyAgentTargets(env) {
  const rows = await env.DB.prepare(`SELECT id, name, target_host, target_port, timeout_ms FROM targets WHERE enabled = 1 AND type = 'tcp' AND COALESCE(no_public_ip, 0) = 0 AND target_host IS NOT NULL AND target_port IS NOT NULL ORDER BY group_name COLLATE NOCASE, name COLLATE NOCASE`).all();
  return {
    ok: true,
    interval_sec: clamp(Number(env.LATENCY_AGENT_INTERVAL_SEC || 60), 30, 600),
    targets: (rows.results || []).map(row => ({ ...row, target_port: Number(row.target_port), timeout_ms: clamp(Number(row.timeout_ms || 1000), 500, 1000) })),
  };
}

export async function submitLatencyAgentResults(request, env, body = null) {
  const data = body || await safeJson(request);
  const nodeId = sanitizeAgentId(data?.node_id || '');
  const results = Array.isArray(data?.results) ? data.results.slice(0, 500) : [];
  if (!nodeId || !results.length) return { ok: false, error: 'node_id 和非空 results 为必填项' };
  const targetIds = [...new Set(results.map(row => String(row?.target_id || '').trim()).filter(Boolean))];
  const allowed = new Map();
  for (let offset = 0; offset < targetIds.length; offset += 80) {
    const chunk = targetIds.slice(offset, offset + 80);
    const marks = chunk.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT id, timeout_ms, created_at FROM targets WHERE enabled = 1 AND type = 'tcp' AND COALESCE(no_public_ip, 0) = 0 AND id IN (${marks})`).bind(...chunk).all();
    for (const row of rows.results || []) allowed.set(String(row.id), row);
  }
  const now = nowSec();
  const accepted = [];
  for (const result of results) {
    const targetId = String(result?.target_id || '').trim();
    const target = allowed.get(targetId);
    if (!target) continue;
    const rawTs = Number(result?.checked_at || now);
    if (!Number.isFinite(rawTs) || rawTs < now - 900 || rawTs > now + 300) continue;
    const checkedAt = Math.floor(rawTs / RESULT_BUCKET_SEC) * RESULT_BUCKET_SEC;
    const rawLatency = result?.latency_ms == null ? null : Math.round(Number(result.latency_ms));
    const timeoutMs = clamp(Number(target.timeout_ms || 1000), 500, 1000);
    const timedOut = Number.isFinite(rawLatency) && rawLatency > timeoutMs;
    const latency = Number.isFinite(rawLatency) && rawLatency >= 0 && !timedOut ? rawLatency : null;
    const ok = timedOut ? false : (result?.ok === undefined ? latency != null : parseBoolean(result.ok, false));
    const error = ok ? null : String(timedOut ? `连接超时（>${timeoutMs}ms）` : (result?.error || '连接失败')).slice(0, 200);
    accepted.push({ target_id: targetId, checked_at: checkedAt, latency_ms: latency, ok: ok ? 1 : 0, error, target_revision: Number(target.created_at || 0) });
  }
  let archived = false;
  if (accepted.length && env.ARCHIVE) {
    try {
      await appendLatencyArchive(env, nodeId, accepted);
      archived = true;
    } catch (error) {
      console.error('latency archive write failed:', String(error?.message || error));
    }
  }
  if (!archived && accepted.length) await writeLatencyD1Fallback(env, nodeId, accepted);
  const latest = latestLatencyPoints(accepted);
  await env.DB.prepare(`UPDATE latency_agents SET last_seen_at = ?, latest_results = ?, updated_at = ? WHERE id = ?`).bind(now, JSON.stringify(latest), now, nodeId).run();
  await cleanupLatencyResults(env, now);
  return { ok: true, node_id: nodeId, accepted: accepted.length, storage: archived ? 'r2' : 'd1_fallback' };
}

export async function getPublicLatency(env, url) {
  const targetId = String(url.searchParams.get('target_id') || '').trim();
  if (!targetId) return { ok: false, error: '必须提供 target_id' };
  const target = await env.DB.prepare(`SELECT id, created_at FROM targets WHERE id = ? AND enabled = 1`).bind(targetId).first().catch(() => null);
  if (!target) return { ok: false, error: '目标不存在或已停用' };
  const hours = clamp(Number(url.searchParams.get('hours') || 24), 1, 168);
  const since = nowSec() - hours * 3600;
  const cutoff = Math.floor(Math.max(since, Number(target.created_at || 0)) / RESULT_BUCKET_SEC) * RESULT_BUCKET_SEC;
  const nodes = await enabledLatencyNodes(env);
  const archivedRows = await readLatencyArchive(env, nodes, targetId, cutoff, nowSec());
  const legacyRows = await env.DB.prepare(`SELECT r.node_id, a.name AS node_name, a.color AS node_color, r.checked_at, r.latency_ms, r.ok FROM latency_results r JOIN latency_agents a ON a.id = r.node_id AND a.enabled = 1 WHERE r.target_id = ? AND r.checked_at >= ? ORDER BY r.checked_at ASC`).bind(targetId, cutoff).all().catch(() => ({ results: [] }));
  return { ok: true, target_id: targetId, sources: groupLatencySeries([...(legacyRows.results || []), ...archivedRows]) };
}

export async function getLatestExternalLatencyByTarget(env, targetIds) {
  const ids = [...new Set((targetIds || []).map(String).filter(Boolean))];
  const byTarget = new Map();
  if (!ids.length) return byTarget;
  const since = nowSec() - clamp(Number(env.LATENCY_AGENT_STALE_SEC || 600), 120, 3600);
  const nodes = await enabledLatencyNodes(env);
  const wanted = new Set(ids);
  for (const node of nodes) {
    const points = parseLatestResults(node.latest_results);
    for (const point of points) {
      if (!wanted.has(String(point.target_id)) || Number(point.checked_at || 0) < since) continue;
      const list = byTarget.get(String(point.target_id)) || [];
      list.push({ id: node.id, name: node.name, color: normalizeChartColor(node.color, '#2e7dd7'), kind: 'external', checked_at: Number(point.checked_at), latency_ms: point.latency_ms == null ? null : Number(point.latency_ms), ok: Number(point.ok) === 1 });
      byTarget.set(String(point.target_id), list);
    }
  }
  const missing = ids.filter(id => !byTarget.has(id));
  for (let offset = 0; offset < missing.length; offset += 80) {
    const chunk = missing.slice(offset, offset + 80);
    const marks = chunk.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT r.node_id, r.target_id, a.name AS node_name, a.color AS node_color, r.checked_at, r.latency_ms, r.ok FROM latency_results r JOIN latency_agents a ON a.id = r.node_id AND a.enabled = 1 WHERE r.target_id IN (${marks}) AND r.checked_at >= ? ORDER BY r.checked_at DESC`).bind(...chunk, since).all().catch(() => ({ results: [] }));
    const seen = new Set();
    for (const row of rows.results || []) {
      const key = `${row.target_id}|${row.node_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list = byTarget.get(String(row.target_id)) || [];
      list.push({ id: row.node_id, name: row.node_name, color: normalizeChartColor(row.node_color, '#2e7dd7'), kind: 'external', checked_at: Number(row.checked_at), latency_ms: row.latency_ms == null ? null : Number(row.latency_ms), ok: Number(row.ok) === 1 });
      byTarget.set(String(row.target_id), list);
    }
  }
  return byTarget;
}

async function enabledLatencyNodes(env) {
  const rows = await env.DB.prepare(`SELECT id, name, color, latest_results FROM latency_agents WHERE enabled = 1 ORDER BY name COLLATE NOCASE`).all();
  return rows.results || [];
}

function latestLatencyPoints(points) {
  const latest = new Map();
  for (const point of points || []) {
    const previous = latest.get(point.target_id);
    if (!previous || Number(point.checked_at) >= Number(previous.checked_at)) latest.set(point.target_id, point);
  }
  return [...latest.values()];
}

function parseLatestResults(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function latencySegmentStart(ts) {
  return Math.floor(Number(ts) / ARCHIVE_SEGMENT_SEC) * ARCHIVE_SEGMENT_SEC;
}

function latencySegmentKey(nodeId, segmentStart) {
  const date = new Date(segmentStart * 1000);
  const day = date.toISOString().slice(0, 10);
  const hour = String(date.getUTCHours()).padStart(2, '0');
  return `latency/v1/${encodeURIComponent(nodeId)}/${day}/${hour}.json`;
}

async function appendLatencyArchive(env, nodeId, points) {
  const groups = new Map();
  for (const point of points) {
    const start = latencySegmentStart(point.checked_at);
    const list = groups.get(start) || [];
    list.push(point);
    groups.set(start, list);
  }
  for (const [segmentStart, additions] of groups) {
    const key = latencySegmentKey(nodeId, segmentStart);
    const existing = await readArchiveObject(env.ARCHIVE, key);
    const byPoint = new Map();
    for (const point of existing?.points || []) byPoint.set(`${point.target_id}:${point.checked_at}`, point);
    for (const point of additions) byPoint.set(`${point.target_id}:${point.checked_at}`, point);
    const payload = {
      schema: ARCHIVE_SCHEMA,
      node_id: nodeId,
      segment_start: segmentStart,
      updated_at: nowSec(),
      points: [...byPoint.values()].sort((a, b) => Number(a.checked_at) - Number(b.checked_at) || String(a.target_id).localeCompare(String(b.target_id))),
    };
    await env.ARCHIVE.put(key, JSON.stringify(payload), { httpMetadata: { contentType: 'application/json; charset=utf-8' }, customMetadata: { schema: ARCHIVE_SCHEMA } });
  }
}

async function readLatencyArchive(env, nodes, targetId, since, until) {
  if (!env.ARCHIVE || !nodes.length) return [];
  const starts = [];
  for (let ts = latencySegmentStart(since); ts <= until; ts += ARCHIVE_SEGMENT_SEC) starts.push(ts);
  const reads = [];
  for (const node of nodes) for (const start of starts) reads.push(readArchiveObject(env.ARCHIVE, latencySegmentKey(node.id, start)).then(payload => ({ node, payload })));
  const rows = [];
  for (const { node, payload } of await Promise.all(reads)) {
    if (payload?.schema !== ARCHIVE_SCHEMA || payload.node_id !== node.id) continue;
    for (const point of payload.points || []) {
      if (String(point.target_id) !== targetId || Number(point.checked_at) < since || Number(point.checked_at) > until) continue;
      rows.push({ node_id: node.id, node_name: node.name, node_color: node.color, checked_at: Number(point.checked_at), latency_ms: point.latency_ms, ok: point.ok });
    }
  }
  return rows;
}

async function readArchiveObject(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    if (typeof object.json === 'function') return await object.json();
    return JSON.parse(await object.text());
  } catch (_) {
    return null;
  }
}

async function writeLatencyD1Fallback(env, nodeId, points) {
  const statements = [];
  for (const point of points) {
    const checkedAt = Math.floor(Number(point.checked_at) / D1_FALLBACK_BUCKET_SEC) * D1_FALLBACK_BUCKET_SEC;
    statements.push(env.DB.prepare(`INSERT OR REPLACE INTO latency_results (node_id, target_id, checked_at, latency_ms, ok, error) VALUES (?, ?, ?, ?, ?, ?)`).bind(nodeId, point.target_id, checkedAt, point.latency_ms, point.ok, point.error));
  }
  for (let offset = 0; offset < statements.length; offset += 80) await env.DB.batch(statements.slice(offset, offset + 80));
}

async function deleteLatencyArchive(env, nodeId) {
  if (!env.ARCHIVE || typeof env.ARCHIVE.list !== 'function') return;
  const prefix = `latency/v1/${encodeURIComponent(nodeId)}/`;
  let cursor;
  do {
    const page = await env.ARCHIVE.list({ prefix, cursor });
    const keys = (page.objects || []).map(object => object.key);
    if (keys.length) await env.ARCHIVE.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

function normalizeNodeName(value) {
  const name = String(value || '').trim().slice(0, 64);
  if (!name) throw new Error('Latency 节点名称不能为空');
  return name;
}

function normalizeChartColor(value, fallback) {
  const color = String(value ?? '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : fallback;
}

function groupLatencySeries(rows) {
  const sources = new Map();
  for (const row of rows) {
    const id = String(row.node_id);
    const source = sources.get(id) || { id, name: row.node_name, color: normalizeChartColor(row.node_color, '#2e7dd7'), kind: 'external', points: [] };
    const point = { checked_at: Number(row.checked_at), latency_ms: row.latency_ms == null ? null : Number(row.latency_ms), ok: Number(row.ok) === 1 };
    const existingIndex = source.points.findIndex(item => item.checked_at === point.checked_at);
    if (existingIndex >= 0) source.points[existingIndex] = point;
    else source.points.push(point);
    sources.set(id, source);
  }
  return [...sources.values()].map(source => ({ ...source, points: source.points.sort((a, b) => a.checked_at - b.checked_at) }));
}

async function cleanupLatencyResults(env, now) {
  const key = 'latency-results:last-cleanup';
  const previous = Number((await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(key).first().catch(() => null))?.value || 0);
  if (previous > now - 3600) return;
  const retention = clamp(Number(env.LATENCY_RESULT_RETENTION_HOURS || 72), 24, 168) * 3600;
  await env.DB.prepare(`DELETE FROM latency_results WHERE checked_at < ?`).bind(now - retention).run();
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).bind(key, String(now), now).run();
}
