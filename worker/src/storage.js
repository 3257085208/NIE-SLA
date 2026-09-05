import { clamp, nowSec, sanitizeId, sanitizeAgentId, dayFromSec, dayStartSec, normalizeHistoryPoint, publicCheckPoint, configuredAgents, agentSeriesEnabled, R2_STATE_SCHEMA, R2_HISTORY_SCHEMA, isMissedMonitorPoint } from './utils.js';



export async function readR2Json(env, key, fallback) {
  const result = await readR2JsonResult(env, key);
  return result.ok ? (result.found ? result.value : fallback) : fallback;
}

export async function readR2JsonResult(env, key) {
  if (!env.ARCHIVE) return { ok: false, error: 'missing_archive', key };
  let object;
  try { object = await env.ARCHIVE.get(key); } catch (error) {
    return { ok: false, error: String(error?.message || error), key };
  }
  if (!object) return { ok: true, found: false, value: null, key };
  try {
    const value = await object.json();
    return { ok: true, found: true, value: value || null, key };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), key };
  }
}

export async function readR2JsonStrict(env, key) {
  const result = await readR2JsonResult(env, key);
  if (!result.ok) throw new Error(`R2 read failed (${result.key || key}): ${result.error}`);
  return result.found ? result.value : null;
}

export async function writeR2Json(env, key, value, metadata = {}) {
  if (!env.ARCHIVE) throw new Error('缺少 R2 的 ARCHIVE 绑定');
  await env.ARCHIVE.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json; charset=utf-8' }, customMetadata: metadata });
}



function r2StateKey(env) { return String(env.R2_STATE_KEY || 'state/status.json').replace(/^\/+/, ''); }

export async function readR2State(env) {
  const result = await readR2JsonResult(env, r2StateKey(env));
  if (!result.ok) throw new Error(`R2 state read failed (${result.key}): ${result.error}`);
  const state = result.found ? result.value : { schema: R2_STATE_SCHEMA, updated_at: null, targets: {} };
  return { schema: state.schema || R2_STATE_SCHEMA, updated_at: state.updated_at || null, targets: state.targets && typeof state.targets === 'object' ? state.targets : {} };
}

export async function writeR2State(env, state) {
  await writeR2Json(env, r2StateKey(env), state, { schema: R2_STATE_SCHEMA });
}

export async function removeTargetFromR2State(env, targetId) {
  if (!env.ARCHIVE) return;
  const lock = await acquireR2Lock(env, r2LockTtlSec(env));
  if (env.DB && !lock) throw new Error('R2 状态正在写入，请重试删除操作');
  try {
    const state = await readR2State(env);
    if (!state.targets?.[targetId]) return;
    delete state.targets[targetId];
    state.updated_at = new Date().toISOString();
    await writeR2State(env, state);
  } finally {
    await releaseR2Lock(env, lock);
  }
}

function r2LockTtlSec(env) {
  return clamp(Number(env?.R2_LOCK_TTL_SEC || 30), 15, 120);
}

async function acquireR2Lock(env, timeoutSec = null, attempts = 12) {
  if (!timeoutSec) timeoutSec = r2LockTtlSec(env);
  if (!env.DB) return null;
  const lockKey = 'r2_state_lock';

  for (let attempt = 0; attempt < attempts; attempt++) {
    const now = nowSec();
    const token = `${now + timeoutSec}:${crypto.randomUUID()}`;
    try {
      await env.DB.prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
         WHERE CAST(app_meta.value AS INTEGER) < ?`
      ).bind(lockKey, token, now, now).run();

      const row = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(lockKey).first();
      if (row?.value === token) return { key: lockKey, token };
    } catch (e) {
      console.error('acquireR2Lock error:', e);
      return null;
    }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 20 + Math.floor(Math.random() * 40)));
  }
  return null;
}

async function releaseR2Lock(env, lock) {
  if (!env.DB || !lock) return;
  try {
    await env.DB.prepare(`DELETE FROM app_meta WHERE key = ? AND value = ?`).bind(lock.key, lock.token).run();
  } catch (e) {
    console.error('releaseR2Lock error:', e);
  }
}

export async function acquireAgentHistoryLock(env, agentId, ttlSec = 90) {
  if (!env.DB) return null;
  const key = `agent_history_lock:${sanitizeAgentId(agentId)}`;
  const now = nowSec();
  const token = `${now + ttlSec}:${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    WHERE CAST(substr(app_meta.value, 1, instr(app_meta.value, ':') - 1) AS INTEGER) < ?`)
    .bind(key, token, now, now).run();
  const row = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(key).first();
  return row?.value === token ? { key, token } : null;
}

export async function releaseAgentHistoryLock(env, lock) {
  if (!env.DB || !lock) return;
  await env.DB.prepare(`DELETE FROM app_meta WHERE key = ? AND value = ?`).bind(lock.key, lock.token).run().catch(() => {});
}

export async function mergeR2StateUpdates(env, updates) {
  if (!updates.length) return { ok: true, skipped: true };

  const lock = await acquireR2Lock(env, r2LockTtlSec(env));
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
  const payload = await readR2JsonStrict(env, r2HistoryKey(target.id, day, env));
  const points = payload ? (Array.isArray(payload.points) ? payload.points : Array.isArray(payload.records) ? payload.records : []).map(normalizeHistoryPoint).filter(p => Number(p.checked_at) > 0) : [];
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
  const payload = await readR2JsonStrict(env, agentR2HistoryKey(agentId, target.id, day, env));
  const points = payload ? (Array.isArray(payload.points) ? payload.points : Array.isArray(payload.records) ? payload.records : []).map(normalizeHistoryPoint).filter(p => Number(p.checked_at) > 0) : [];
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
  await writeR2Json(env, agentR2StateKey(agentId, env), { schema: 'nie-sla-agent-state-v1', updated_at: new Date().toISOString(), ...state }, { schema: 'nie-sla-agent-state-v1', agent_id: sanitizeAgentId(agentId) });
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

export async function deleteTargetR2Data(env, targetId) {
  if (!env.ARCHIVE) return { deleted: 0, updated_agent_states: 0, warnings: [] };
  const id = sanitizeId(targetId);
  const warnings = [];
  let deleted = 0;
  const historyPrefix = `${String(env.R2_HISTORY_PREFIX || 'history').replace(/^\/+|\/+$/g, '')}/`;
  const agentHistoryPrefix = `${String(env.AGENT_R2_HISTORY_PREFIX || 'agent-history').replace(/^\/+|\/+$/g, '')}/`;
  for (const prefix of [historyPrefix, agentHistoryPrefix]) {
    let cursor;
    try {
      do {
        const page = await env.ARCHIVE.list({ prefix, cursor, limit: 1000 });
        const keys = (page.objects || []).filter(item => String(item.key).endsWith(`/${id}.json`)).map(item => item.key);
        for (let offset = 0; offset < keys.length; offset += 100) await env.ARCHIVE.delete(keys.slice(offset, offset + 100));
        deleted += keys.length;
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    } catch (error) {
      warnings.push(`history cleanup failed for ${prefix}: ${String(error?.message || error)}`);
    }
  }
  let updatedAgentStates = 0;
  const statePrefix = `${String(env.AGENT_R2_STATE_PREFIX || 'agent-state').replace(/^\/+|\/+$/g, '')}/`;
  try {
    let cursor;
    do {
      const page = await env.ARCHIVE.list({ prefix: statePrefix, cursor, limit: 1000 });
      for (const object of page.objects || []) {
        try {
          const data = await readR2JsonStrict(env, object.key);
          if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
          const copy = JSON.parse(JSON.stringify(data));
          let changed = false;
          if (copy[id] && typeof copy[id] === 'object') { delete copy[id]; changed = true; }
          for (const sectionName of ['targets', 'daily', 'series', 'latest']) {
            const section = copy[sectionName];
            if (section && typeof section === 'object' && !Array.isArray(section) && Object.prototype.hasOwnProperty.call(section, id)) {
              delete section[id];
              changed = true;
            }
          }
          if (changed) { await writeR2Json(env, object.key, copy); updatedAgentStates++; }
        } catch (error) {
          warnings.push(`agent-state cleanup failed for ${object.key}: ${String(error?.message || error)}`);
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (error) {
    warnings.push(`agent-state list failed: ${String(error?.message || error)}`);
  }
  return { deleted, updated_agent_states: updatedAgentStates, warnings };
}

export async function getStatusSnapshotGeneratedAt(env, key) {
  try { const object = await env.ARCHIVE.get(key); if (!object) return 0; const payload = await object.json(); const generatedAt = Math.floor(new Date(payload?.generated_at || payload?.now || 0).getTime() / 1000); return Number.isFinite(generatedAt) ? generatedAt : 0; } catch (_) { return 0; }
}



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
    if (isMissedMonitorPoint(point)) continue;
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

export function cachedDailySummaryBefore(previous, day, beforeAt) {
  const summary = previous?.daily?.[day];
  const previousAt = Number(previous?.checked_at || 0);
  const summaryAt = Number(summary?.updated_at || 0);
  const cutoff = Number(beforeAt || 0);
  if (!summary || !previousAt || !cutoff) return null;
  if (previousAt >= cutoff || summaryAt < previousAt) return null;
  return {
    total: Number(summary.total || 0),
    ok_count: Number(summary.ok_count || 0),
    sum_latency_ms: Number(summary.sum_latency_ms || 0),
  };
}

export function dailySummaryFromPoints(points) {
  const rows = Array.isArray(points) ? points : [];
  let total = 0, okCount = 0, sumLatency = 0, latest = null;
  for (const point of rows) {
    if (isMissedMonitorPoint(point)) continue;
    const pointTotal = point.total == null ? 1 : Math.max(0, Number(point.total || 0));
    total += pointTotal;
    const pointOk = point.ok_count == null ? Number(point.ok ? 1 : 0) : Math.max(0, Number(point.ok_count || 0));
    okCount += pointOk;
    const latency = Number(point.latency_ms);
    if (pointOk && Number.isFinite(latency)) sumLatency += latency * pointOk;
    if (!latest || Number(point.checked_at || 0) >= Number(latest.checked_at || 0)) latest = point;
  }
  const latestLatency = latest?.latency_ms == null ? null : Number(latest.latency_ms);
  return { total, ok_count: okCount, sum_latency_ms: sumLatency, last_ok: Number(latest?.ok ? 1 : 0), last_latency_ms: Number.isFinite(latestLatency) ? latestLatency : null, last_status_code: latest?.status_code == null ? null : Number(latest.status_code), last_error: latest?.error || null, updated_at: Number(latest?.checked_at || nowSec()) };
}

export function statsFromDailySummaries(daily, endDay, days) {
  const keys = Object.keys(daily || {}).filter(day => day <= endDay).sort().slice(-days);
  let total = 0, ok = 0, sumLatency = 0;
  for (const day of keys) { const row = daily[day] || {}; total += Number(row.total || 0); ok += Number(row.ok_count || 0); sumLatency += Number(row.sum_latency_ms || 0); }
  return { uptime: total ? Number(((ok / total) * 100).toFixed(4)) : null, avgLatency: ok ? Math.round(sumLatency / ok) : null };
}
