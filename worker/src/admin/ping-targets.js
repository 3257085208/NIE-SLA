// Admin sub-module: ping target CRUD and agent TCP ping operations.
import { nowSec, clamp, parseBoolean, sanitizeAgentId, retentionSeconds } from '../utils.js';
import { safeJson, requireAgentForId, ApiError } from '../auth.js';
import { writeAgentTelemetryR2History, compactPingPointsByTarget, loadAgentPingsR2History, pingPointsToSeries } from '../metrics.js';
import { rateLimitByIp } from '../ratelimit.js';

function normalizeOkInt(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0 || value == null) return 0;
  const text = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'ok', 'up'].includes(text) ? 1 : 0;
}

// ── Ping targets CRUD ───────────────────────────────────────────────────────

export async function getPingTargets(env, options = {}) {
  const enabledOnly = options.enabledOnly !== false;
  const rows = await env.DB.prepare(`SELECT * FROM ping_targets ${enabledOnly ? 'WHERE enabled = 1 ' : ''}ORDER BY name`).all();
  return { ok: true, targets: rows.results || [] };
}

export async function createPingTarget(request, env) {
  const body = await safeJson(request);
  const name = String(body?.name || '').trim();
  const target = String(body?.target || '').trim();
  if (!name || !target) return { ok: false, error: '名称和目标（主机:端口）不能为空' };
  const id = sanitizeAgentId(body?.id || name);
  const now = nowSec();
  await env.DB.prepare(`INSERT INTO ping_targets (id, name, target, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, target=excluded.target, updated_at=excluded.updated_at`).bind(id, name, target, now, now).run();
  return { ok: true, id };
}

export async function updatePingTarget(id, request, env) {
  const existing = await env.DB.prepare(`SELECT * FROM ping_targets WHERE id = ?`).bind(id).first();
  if (!existing) return { ok: false, error: 'Ping target not found' };
  const body = await safeJson(request);
  const name = body?.name !== undefined ? String(body.name || '').trim() : existing.name;
  const target = body?.target !== undefined ? String(body.target || '').trim() : existing.target;
  const enabled = body?.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled;
  await env.DB.prepare(`UPDATE ping_targets SET name = ?, target = ?, enabled = ?, updated_at = ? WHERE id = ?`).bind(name, target, enabled, nowSec(), id).run();
  return { ok: true, id };
}

export async function deletePingTarget(id, env) {
  await env.DB.prepare(`DELETE FROM ping_targets WHERE id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM ping_history WHERE target_id = ?`).bind(id).run();
  return { ok: true, id };
}

// ── Agent TCP Ping ──────────────────────────────────────────────────────────

export async function submitAgentPings(request, env) {
  if (!env.DB) return { ok: false, error: '缺少 D1 的 DB 绑定' };
  const body = await safeJson(request);
  const agentId = sanitizeAgentId(body?.agent_id || '');
  if (!agentId) return { ok: false, error: '必须提供 agent_id' };
  await requireAgentForId(request, env, agentId);
  if (!await rateLimitByIp(request, env, 120, 60, { bestEffort: true })) {
    throw new ApiError(429, '请求过于频繁，请稍后重试。');
  }
  const pings = Array.isArray(body?.pings) ? body.pings : [];
  if (!pings.length) return { ok: false, error: 'pings 必须是非空数组' };
  if (pings.length > 100) return { ok: false, error: 'max 100 pings per batch' };

  const now = nowSec();
  const accepted = [];
  const stmts = [];
  for (const p of pings) {
    const targetId = String(p?.target_id || '').trim();
    const ts = Math.floor(Number(p?.ts || Math.floor(now)));
    const latency = p?.latency_ms == null ? null : Math.round(Number(p.latency_ms));
    const ok = p?.ok === undefined ? (Number.isFinite(latency) && latency >= 0 ? 1 : 0) : normalizeOkInt(p.ok);
    if (!targetId || !Number.isFinite(ts)) continue;
    accepted.push({ target_id: targetId, ts, latency_ms: Number.isFinite(latency) && latency >= 0 ? latency : null, ok });
  }
  if (accepted.length && env.ARCHIVE) await writeAgentTelemetryR2History(env, agentId, [], accepted);
  if (accepted.length && parseBoolean(env.AGENT_PINGS_TO_D1 ?? !env.ARCHIVE, !env.ARCHIVE)) {
    for (const p of accepted) {
      const bucketTs = Math.floor(Number(p.ts || now) / 60) * 60;
      stmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO ping_history (target_id, agent_id, ts, latency_ms, ok) VALUES (?, ?, ?, ?, ?)`
      ).bind(p.target_id, agentId, bucketTs, p.latency_ms, p.ok));
    }
  }
  if (stmts.length) {
    for (let i = 0; i < stmts.length; i += 50) {
      await env.DB.batch(stmts.slice(i, i + 50));
    }
    await env.DB.prepare(`DELETE FROM ping_history WHERE agent_id = ? AND ts < ?`)
      .bind(agentId, now - retentionSeconds(env, 'PING_HISTORY_RETENTION_HOURS', 6, 1, 72)).run();
  }
  return { ok: true, stored: accepted.length, storage: env.ARCHIVE ? 'r2' : 'd1', d1_rows: stmts.length };
}

export async function getAgentPings(env, url, ctx = null) {
  if (!env.DB) return { ok: true, targets: [], pings: [] };
  const agentId = sanitizeAgentId(url.searchParams.get('agent_id') || '');
  const publicMaxHours = clamp(Number(env.AGENT_PINGS_PUBLIC_MAX_HOURS || env.AGENT_METRICS_PUBLIC_MAX_HOURS || 72), 1, 168);
  const hours = clamp(Math.floor(Number(url.searchParams.get('hours') || 24)), 1, publicMaxHours);
  const hardMax = clamp(Number(env.AGENT_PINGS_HARD_MAX_POINTS_PER_TARGET || 2000), 30, 10000);
  const defaultMax = clamp(Number(env.AGENT_PINGS_MAX_POINTS_PER_TARGET || 360), 30, hardMax);
  let maxPerTargetRaw = url.searchParams.has('max_points_per_target')
    ? Number(url.searchParams.get('max_points_per_target'))
    : defaultMax;
  if (!Number.isFinite(maxPerTargetRaw) || maxPerTargetRaw <= 0) maxPerTargetRaw = defaultMax;
  const maxPerTarget = clamp(Math.floor(maxPerTargetRaw), 30, hardMax);
  const responseFormat = String(url.searchParams.get('format') || '').toLowerCase();
  const requestedUntil = nowSec();
  const since = requestedUntil - hours * 3600;
  let until = requestedUntil;
  try {
    const row = await env.DB.prepare(`SELECT updated_at FROM agent_metrics_state WHERE agent_id = ?`).bind(agentId).first();
    const latestTs = Math.floor(new Date(row?.updated_at || 0).getTime() / 1000);
    if (latestTs > 0) until = Math.min(requestedUntil, latestTs + 600);
  } catch (_) {}
  const byKey = new Map();
  const targets = await env.DB.prepare(`SELECT id, name FROM ping_targets WHERE enabled = 1`).all();
  const enabledTargetIds = new Set((targets.results || []).map(t => String(t.id)));
  const r2 = await loadAgentPingsR2History(env, agentId, since, until, [], ctx);
  for (const p of r2.pings || []) if (enabledTargetIds.has(String(p.target_id))) byKey.set(`${p.target_id}:${p.ts}`, p);
  try {
    const pings = await env.DB.prepare(
      `SELECT target_id, ts, latency_ms, ok FROM ping_history WHERE agent_id = ? AND ts >= ? ORDER BY ts ASC`
    ).bind(agentId, since).all();
    for (const p of pings.results || []) if (enabledTargetIds.has(String(p.target_id))) byKey.set(`${p.target_id}:${p.ts}`, {
      target_id: p.target_id,
      ts: Number(p.ts),
      latency_ms: p.latency_ms == null ? null : Number(p.latency_ms),
      ok: Number(p.ok || 0),
    });
  } catch (_) {}
  const rawPings = [...byKey.values()].sort((a, b) => a.ts - b.ts || a.target_id.localeCompare(b.target_id));
  const pings = compactPingPointsByTarget(rawPings, maxPerTarget);
  const payload = {
    ok: true,
    targets: targets.results || [],
    pings: responseFormat === 'series' ? [] : pings,
    pings_raw_count: rawPings.length,
    pings_downsampled: rawPings.length > pings.length,
    source: r2.loaded ? 'r2+d1-fallback' : 'd1',
  };
  if (responseFormat === 'series') payload.series = pingPointsToSeries(pings);
  return payload;
}
