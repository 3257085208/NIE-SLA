import { clamp, nowSec, sanitizeId, sanitizeAgentId, dayFromSec, dayStartSec, timezoneOffsetMin, normalizeHistoryPoint, publicCheckPoint, configuredAgents, agentSeriesEnabled, BUCKET_SEC, R2_STATE_SCHEMA, R2_HISTORY_SCHEMA } from './utils.js';

// ── R2 generic ───────────────────────────────────────────────────────────────

export async function readR2Json(env, key, fallback) {
  if (!env.ARCHIVE) return fallback;
  try { const object = await env.ARCHIVE.get(key); if (!object) return fallback; return (await object.json()) || fallback; } catch (_) { return fallback; }
}

export async function writeR2Json(env, key, value, metadata = {}) {
  if (!env.ARCHIVE) throw new Error('R2 binding ARCHIVE is required');
  await env.ARCHIVE.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json; charset=utf-8' }, customMetadata: metadata });
}

// ── State ────────────────────────────────────────────────────────────────────

function r2StateKey(env) { return String(env.R2_STATE_KEY || 'state/status.json').replace(/^\/+/, ''); }

export async function readR2State(env) {
  const state = await readR2Json(env, r2StateKey(env), { schema: R2_STATE_SCHEMA, updated_at: null, targets: {} });
  return { schema: state.schema || R2_STATE_SCHEMA, updated_at: state.updated_at || null, targets: state.targets && typeof state.targets === 'object' ? state.targets : {} };
}

export async function writeR2State(env, state) {
  await writeR2Json(env, r2StateKey(env), state, { schema: R2_STATE_SCHEMA });
}

export async function removeTargetFromR2State(env, targetId) {
  if (!env.ARCHIVE) return;
  const state = await readR2State(env);
  if (!state.targets?.[targetId]) return;
  delete state.targets[targetId];
  state.updated_at = new Date().toISOString();
  await writeR2State(env, state);
}

// Simple lock mechanism to prevent R2 write race conditions
async function acquireR2Lock(env, timeoutSec = 10) {
  if (!env.DB) return null;
  const lockKey = 'r2_state_lock';
  const now = nowSec();
  const expiresAt = now + timeoutSec;
  
  try {
    // Try to acquire lock
    await env.DB.prepare(
      `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) 
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at 
       WHERE CAST(value AS INTEGER) < ?`
    ).bind(lockKey, String(expiresAt), now, now).run();
    
    // Check if we got the lock
    const row = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(lockKey).first();
    if (row && Number(row.value) === expiresAt) {
      return lockKey;
    }
    return null;
  } catch (e) {
    console.error('acquireR2Lock error:', e);
    return null;
  }
}

async function releaseR2Lock(env, lockKey) {
  if (!env.DB || !lockKey) return;
  try {
    await env.DB.prepare(`DELETE FROM app_meta WHERE key = ?`).bind(lockKey).run();
  } catch (e) {
    console.error('releaseR2Lock error:', e);
  }
}

export async function mergeR2StateUpdates(env, updates) {
  if (!updates.length) return { ok: true, skipped: true };
  
  // Acquire lock before reading/writing R2 state to prevent race conditions
  const lock = await acquireR2Lock(env, 10);
  if (!lock) {
    console.warn('Failed to acquire R2 lock, skipping state update to prevent race condition');
    return { ok: false, error: 'lock_failed', skipped: true };
  }
  
  try {
    const state = await readR2State(env);
    state.schema = R2_STATE_SCHEMA;
    state.updated_at = new Date().toISOString();
    state.targets ||= {};
    for (const update of updates) {
      if (!update?.target_id) continue;
      const previous = state.targets[update.target_id];
      if (!previous || Number(update.checked_at || 0) >= Number(previous.checked_at || 0)) state.targets[update.target_id] = update;
    }
    await writeR2State(env, state);
    return { ok: true, count: updates.length };
  } finally {
    await releaseR2Lock(env, lock);
  }
}

// ── History ──────────────────────────────────────────────────────────────────

function r2HistoryKey(targetId, day, env) {
  return `${String(env.R2_HISTORY_PREFIX || 'history').replace(/^\/+|\/+$/g, '')}/${day}/${sanitizeId(targetId)}.json`;
}

export async function readR2History(env, targetId, day) {
  const payload = await readR2Json(env, r2HistoryKey(targetId, day, env), null);
  if (!payload) return [];
  const points = Array.isArray(payload.points) ? payload.points : Array.isArray(payload.records) ? payload.records : [];
  return points.map(normalizeHistoryPoint).filter(p => Number(p.checked_at) > 0);
}

export async function writeR2History(env, target, day, points) {
  await writeR2Json(env, r2HistoryKey(target.id, day, env), { schema: R2_HISTORY_SCHEMA, target_id: target.id, day, updated_at: new Date().toISOString(), points }, { schema: R2_HISTORY_SCHEMA, target_id: String(target.id), day });
}

export async function appendR2HistoryPoints(env, target, day, newPoints) {
  const points = await readR2History(env, target.id, day);
  const byBucket = new Map(points.map(p => [Number(p.checked_at), p]));
  for (const point of newPoints || []) { if (point) byBucket.set(Number(point.checked_at), normalizeHistoryPoint(point)); }
  const retentionPoints = clamp(Number(env.R2_HISTORY_POINTS_PER_DAY || 288), 24, 2000);
  const merged = [...byBucket.values()].sort((a, b) => Number(a.checked_at) - Number(b.checked_at)).slice(-retentionPoints);
  await writeR2History(env, target, day, merged);
  return merged;
}

export async function getR2HistoryRange(env, targetId, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) { const day = dayFromSec(nowSec() - i * 86400, env); out.push(...await readR2History(env, targetId, day)); }
  return out.sort((a, b) => Number(a.checked_at) - Number(b.checked_at));
}

// ── Agent history ────────────────────────────────────────────────────────────

function agentR2HistoryKey(agentId, targetId, day, env) {
  return `${String(env.AGENT_R2_HISTORY_PREFIX || 'agent-history').replace(/^\/+|\/+$/g, '')}/${sanitizeAgentId(agentId)}/${day}/${sanitizeId(targetId)}.json`;
}

function agentR2StateKey(agentId, env) {
  return `${String(env.AGENT_R2_STATE_PREFIX || 'agent-state').replace(/^\/+|\/+$/g, '')}/${sanitizeAgentId(agentId)}.json`;
}

export async function readAgentR2History(env, agentId, targetId, day) {
  const payload = await readR2Json(env, agentR2HistoryKey(agentId, targetId, day, env), null);
  if (!payload) return [];
  const points = Array.isArray(payload.points) ? payload.points : Array.isArray(payload.records) ? payload.records : [];
  return points.map(normalizeHistoryPoint).filter(p => Number(p.checked_at) > 0);
}

export async function writeAgentR2History(env, agentId, target, day, points) {
  await writeR2Json(env, agentR2HistoryKey(agentId, target.id, day, env), { schema: R2_HISTORY_SCHEMA, source: 'external-agent', agent_id: sanitizeAgentId(agentId), target_id: target.id, day, updated_at: new Date().toISOString(), points }, { schema: R2_HISTORY_SCHEMA, source: 'external-agent', agent_id: sanitizeAgentId(agentId), target_id: String(target.id), day });
}

export async function appendAgentR2HistoryPoints(env, agentId, target, day, newPoints) {
  const points = await readAgentR2History(env, agentId, target.id, day);
  const byBucket = new Map(points.map(p => [Number(p.checked_at), p]));
  for (const point of newPoints || []) { if (point) byBucket.set(Number(point.checked_at), normalizeHistoryPoint(point)); }
  const retentionPoints = clamp(Number(env.R2_HISTORY_POINTS_PER_DAY || 288), 24, 2000);
  const merged = [...byBucket.values()].sort((a, b) => Number(a.checked_at) - Number(b.checked_at)).slice(-retentionPoints);
  await writeAgentR2History(env, agentId, target, day, merged);
  return merged;
}

export async function getAgentR2HistoryRange(env, agentId, targetId, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) { const day = dayFromSec(nowSec() - i * 86400, env); out.push(...await readAgentR2History(env, agentId, targetId, day)); }
  return out.sort((a, b) => Number(a.checked_at) - Number(b.checked_at));
}

export async function writeAgentState(env, agentId, state) {
  if (!env.ARCHIVE) return;
  await writeR2Json(env, agentR2StateKey(agentId, env), { schema: 'nstatus-agent-state-v1', updated_at: new Date().toISOString(), ...state }, { schema: 'nstatus-agent-state-v1', agent_id: sanitizeAgentId(agentId) });
}

export async function getAgentSeriesForTarget(env, targetId, days, since, limit) {
  if (!env.ARCHIVE || !agentSeriesEnabled(env)) return [];
  const agents = configuredAgents(env);
  const out = [];
  for (const agent of agents) {
    const allPoints = await getAgentR2HistoryRange(env, agent.id, targetId, days);
    const checks = allPoints.filter(p => Number(p.checked_at) >= since).sort((a, b) => Number(b.checked_at) - Number(a.checked_at)).slice(0, limit).map(publicCheckPoint);
    const daily = dailyPointsFromChecks(allPoints, env);
    out.push({ id: agent.id, label: agent.label, color: agent.color, checks, daily_points: daily, source: 'agent-r2-5-minute-buckets' });
  }
  return out;
}

// ── Snapshot helpers ─────────────────────────────────────────────────────────

export async function getStatusSnapshotGeneratedAt(env, key) {
  try { const object = await env.ARCHIVE.get(key); if (!object) return 0; const payload = await object.json(); const generatedAt = Math.floor(new Date(payload?.generated_at || payload?.now || 0).getTime() / 1000); return Number.isFinite(generatedAt) ? generatedAt : 0; } catch (_) { return 0; }
}

// ── Summary rows ─────────────────────────────────────────────────────────────

export function getSummaryRowsFromState(state, startDay) {
  const rows = [];
  const targets = state?.targets && typeof state.targets === 'object' ? state.targets : {};
  for (const [targetId, status] of Object.entries(targets)) {
    const daily = status?.daily && typeof status.daily === 'object' ? status.daily : {};
    for (const [day, row] of Object.entries(daily)) {
      if (String(day) < String(startDay)) continue;
      rows.push({ target_id: targetId, day, total: Number(row.total || 0), ok_count: Number(row.ok_count || 0), sum_latency_ms: Number(row.sum_latency_ms || 0) });
    }
  }
  return rows.sort((a, b) => a.day.localeCompare(b.day) || a.target_id.localeCompare(b.target_id));
}

export function summaryRowsFromChecks(targetId, points, env) {
  const byDay = new Map();
  for (const point of points || []) {
    const day = dayFromSec(Number(point.checked_at || 0), env);
    if (!day) continue;
    const entry = byDay.get(day) || { target_id: targetId, day, total: 0, ok_count: 0, sum_latency_ms: 0 };
    const pointTotal = point.total == null ? 1 : Math.max(0, Number(point.total || 0));
    const pointOk = point.ok_count == null ? Number(point.ok ? 1 : 0) : Math.max(0, Number(point.ok_count || 0));
    const latency = Number(point.latency_ms);
    entry.total += pointTotal; entry.ok_count += pointOk;
    if (pointOk && Number.isFinite(latency)) entry.sum_latency_ms += latency * pointOk;
    byDay.set(day, entry);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function dailyPointsFromChecks(points, env) {
  return summaryRowsFromChecks('', points, env).map(row => {
    const total = Number(row.total || 0), ok = Number(row.ok_count || 0);
    const avg = ok ? Math.round(Number(row.sum_latency_ms || 0) / ok) : null;
    return { checked_at: dayStartSec(row.day, env) + 43200, day: row.day, ok: total && ok > 0 ? 1 : 0, latency_ms: avg, status_code: null, error: null, uptime_pct: total ? Number(((ok / total) * 100).toFixed(4)) : null, total, ok_count: ok, probe_region: null, cf_colo: null, summary: true };
  });
}


export function setDailySummary(existingDaily, day, summary) {
  const daily = existingDaily && typeof existingDaily === 'object' ? { ...existingDaily } : {};
  daily[day] = summary;
  const keys = Object.keys(daily).sort();
  for (const oldDay of keys.slice(0, Math.max(0, keys.length - 90))) delete daily[oldDay];
  return daily;
}

export function dailySummaryFromPoints(points) {
  const rows = Array.isArray(points) ? points : [];
  let total = 0, okCount = 0, sumLatency = 0, latest = null;
  for (const point of rows) {
    const pointTotal = point.total == null ? 1 : Math.max(0, Number(point.total || 0));
    total += pointTotal;
    const pointOk = point.ok_count == null ? Number(point.ok ? 1 : 0) : Math.max(0, Number(point.ok_count || 0));
    okCount += pointOk;
    const latency = Number(point.latency_ms);
    if (pointOk && Number.isFinite(latency)) sumLatency += latency * pointOk;
    if (!latest || Number(point.checked_at || 0) >= Number(latest.checked_at || 0)) latest = point;
  }
  const latestLatency = latest ? Number(latest.latency_ms) : null;
  return { total, ok_count: okCount, sum_latency_ms: sumLatency, last_ok: Number(latest?.ok ? 1 : 0), last_latency_ms: Number.isFinite(latestLatency) ? latestLatency : null, last_status_code: latest?.status_code == null ? null : Number(latest.status_code), last_error: latest?.error || null, updated_at: Number(latest?.checked_at || nowSec()) };
}

export function statsFromDailySummaries(daily, endDay, days) {
  const keys = Object.keys(daily || {}).filter(day => day <= endDay).sort().slice(-days);
  let total = 0, ok = 0, sumLatency = 0;
  for (const day of keys) { const row = daily[day] || {}; total += Number(row.total || 0); ok += Number(row.ok_count || 0); sumLatency += Number(row.sum_latency_ms || 0); }
  return { uptime: total ? Number(((ok / total) * 100).toFixed(4)) : null, avgLatency: ok ? Math.round(sumLatency / ok) : null };
}
