
import { nowSec, clamp, sanitizeAgentId, dayFromSec, parseExpectedStatus, BUCKET_SEC, publicCheckPoint } from '../utils.js';
import { safeJson } from '../auth.js';
import { readR2State, mergeR2StateUpdates, appendAgentR2HistoryPoints, acquireAgentHistoryLock, releaseAgentHistoryLock, setDailySummary, dailySummaryFromPoints, statsFromDailySummaries } from '../storage.js';
import { readCheckBuckets, applyProbeWriteBatch } from './check-buckets.js';

async function getTargetsById(env, ids) {
  const cleanIds = [...new Set((ids || []).map(id => String(id || '').trim()).filter(Boolean))].slice(0, 1000);
  const map = new Map();
  if (!cleanIds.length) return map;
  for (let i = 0; i < cleanIds.length; i += 80) {
    const chunk = cleanIds.slice(i, i + 80);
    const marks = chunk.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT * FROM targets WHERE enabled = 1 AND id IN (${marks})`).bind(...chunk).all();
    for (const row of rows.results || []) map.set(String(row.id), row);
  }
  return map;
}

function normalizeOkInt(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0 || value == null) return 0;
  const text = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'ok', 'up'].includes(text) ? 1 : 0;
}

function normalizeAgentResultPoint(item, target, agentId, agentLabel, submittedAt) {
  const targetId = String(item?.target_id || '').trim();
  if (!targetId || targetId !== String(target.id)) return null;
  const rawCheckedAt = Number(item?.checked_at || item?.t || submittedAt || nowSec());
  const checkedAt = Math.floor(rawCheckedAt / BUCKET_SEC) * BUCKET_SEC;
  if (!isAgentTimestampAllowed(checkedAt)) return null;
  const rawLatency = item?.latency_ms == null ? null : Math.round(Number(item.latency_ms));
  const timeoutMs = String(target?.type || '').toLowerCase() === 'tcp'
    ? clamp(Number(target?.timeout_ms || 1000), 500, 1000)
    : clamp(Number(target?.timeout_ms || 5000), 500, 30_000);
  const timedOut = Number.isFinite(rawLatency) && rawLatency > timeoutMs;
  const latency = Number.isFinite(rawLatency) && rawLatency >= 0 && !timedOut ? rawLatency : null;
  const statusCode = item?.status_code == null ? null : Number(item.status_code);
  const ok = timedOut ? 0 : (item?.ok === undefined ? inferAgentResultOk(target, latency, statusCode) : normalizeOkInt(item.ok));
  const error = ok ? null : String(timedOut ? `连接超时（>${timeoutMs}ms）` : (item?.error || '检查失败')).slice(0, 500);
  return publicCheckPoint({ checked_at: checkedAt, ok: ok ? 1 : 0, latency_ms: latency, status_code: Number.isFinite(statusCode) ? statusCode : null, error, probe_region: agentId, cf_colo: null, total: 1, ok_count: ok ? 1 : 0, bucket: true, agent_id: agentId, agent_label: agentLabel });
}

function inferAgentResultOk(target, latency, statusCode) {
  if (String(target?.type || '').toLowerCase() === 'http' && Number.isFinite(statusCode)) {
    const expected = parseExpectedStatus(target.expected_status);
    return expected.length ? (expected.includes(Number(statusCode)) ? 1 : 0) : (statusCode >= 200 && statusCode < 400 ? 1 : 0);
  }
  return Number.isFinite(latency) && latency >= 0 ? 1 : 0;
}

function latestHistoryPoint(points) {
  const rows = (points || []).filter(p => Number(p?.checked_at || 0) > 0).sort((a, b) => Number(a.checked_at) - Number(b.checked_at));
  return rows.length ? rows[rows.length - 1] : null;
}

function mergeCheckPointsByBucket(...groups) {
  const byBucket = new Map();
  for (const group of groups) {
    for (const point of group || []) {
      const checkedAt = Number(point?.checked_at || 0);
      if (!checkedAt) continue;
      byBucket.set(checkedAt, point);
    }
  }
  return [...byBucket.values()].sort((a, b) => Number(a.checked_at || 0) - Number(b.checked_at || 0));
}

function buildAgentStateUpdate(env, target, latestPoint, dayPoints, previous) {
  const pointCheckedAt = Number(latestPoint.checked_at || 0);
  const previousCheckedAt = Number(previous?.checked_at || 0);
  const checkedAt = Math.max(pointCheckedAt, previousCheckedAt);
  const day = dayFromSec(pointCheckedAt, env);
  const daily = setDailySummary(previous?.daily || {}, day, dailySummaryFromPoints((dayPoints || []).filter(p => dayFromSec(p.checked_at, env) === day)));
  const endDay = dayFromSec(checkedAt || pointCheckedAt, env);
  const stats24 = statsFromDailySummaries(daily, endDay, 1);
  const stats7 = statsFromDailySummaries(daily, endDay, 7);
  if (previousCheckedAt > pointCheckedAt) {
    return {
      target_id: target.id,
      checked_at: previousCheckedAt,
      ok: Number(previous?.ok) ? 1 : 0,
      latency_ms: previous?.latency_ms == null ? null : Number(previous.latency_ms),
      status_code: previous?.status_code == null ? null : Number(previous.status_code),
      error: previous?.error || null,
      probe_region: previous?.probe_region || target.probe_region || 'auto',
      cf_colo: previous?.cf_colo || null,
      uptime_24h: stats24.uptime, uptime_7d: stats7.uptime, avg_latency_24h: stats24.avgLatency,
      last_fail_at: previous?.last_fail_at || null,
      current_outage_started_at: previous?.current_outage_started_at || null,
      last_recover_at: previous?.last_recover_at || null,
      status_changed_at: previous?.status_changed_at || previousCheckedAt,
      daily,
    };
  }
  const okInt = Number(latestPoint.ok) ? 1 : 0;
  const wasDown = previous && Number(previous.ok) === 0;
  const isDown = okInt === 0;
  const latency = latestPoint.latency_ms == null ? null : Math.round(Number(latestPoint.latency_ms));
  const statusCode = latestPoint.status_code == null ? null : Number(latestPoint.status_code);
  return {
    target_id: target.id,
    checked_at: checkedAt,
    ok: okInt,
    latency_ms: Number.isFinite(latency) ? latency : null,
    status_code: Number.isFinite(statusCode) ? statusCode : null,
    error: okInt ? null : (latestPoint.error || '检查失败'),
    probe_region: latestPoint.probe_region || target.probe_region || 'auto',
    cf_colo: null,
    uptime_24h: stats24.uptime, uptime_7d: stats7.uptime, avg_latency_24h: stats24.avgLatency,
    last_fail_at: okInt ? (previous?.last_fail_at || null) : pointCheckedAt,
    current_outage_started_at: isDown ? (wasDown ? (previous?.current_outage_started_at || pointCheckedAt) : pointCheckedAt) : null,
    last_recover_at: !isDown && wasDown ? pointCheckedAt : (previous?.last_recover_at || null),
    status_changed_at: previous && Number(previous.ok) === okInt ? (previous.status_changed_at || pointCheckedAt) : pointCheckedAt,
    daily,
  };
}

function isAgentTimestampAllowed(checkedAt) {
  const ts = Number(checkedAt || 0);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return ts >= nowSec() - 86400 && ts <= nowSec() + 900;
}

function clampAgentTimestamp(ts) {
  const now = nowSec();
  if (!Number.isFinite(ts) || ts <= 0) return now;
  return clamp(Math.floor(ts), now - 86400, now + 900);
}

export async function submitAgentResults(request, env, parsedBody = null) {
  if (!env.ARCHIVE) return { ok: false, error: '缺少 R2 的 ARCHIVE 绑定' };
  const body = parsedBody || await safeJson(request);
  const agentId = sanitizeAgentId(body?.agent_id || env.DEFAULT_AGENT_ID || 'external-agent');
  const agentLabel = String(body?.agent_label || env.DEFAULT_AGENT_LABEL || 'External Agent').trim().slice(0, 64) || 'External Agent';
  const submittedAt = clampAgentTimestamp(Number(body?.submitted_at || nowSec()));
  const results = Array.isArray(body?.results) ? body.results : [];
  const maxResults = clamp(Number(env.AGENT_MAX_RESULTS_PER_BATCH || 200), 1, 1000);
  if (!results.length) return { ok: false, error: 'results 必须是非空数组' };
  if (results.length > maxResults) return { ok: false, error: `too many results; max ${maxResults}` };
  const targets = await getTargetsById(env, results.map(r => r?.target_id));
  const acceptedByTarget = new Map();
  const rejected = [];
  for (const item of results) {
    const targetId = String(item?.target_id || '').trim();
    const target = targets.get(targetId);
    if (!target) { rejected.push({ target_id: targetId || null, error: 'unknown target_id' }); continue; }
    const point = normalizeAgentResultPoint(item, target, agentId, agentLabel, submittedAt);
    if (!point) { rejected.push({ target_id: targetId, error: '结果无效' }); continue; }
    const day = dayFromSec(point.checked_at, env);
    const key = `${targetId}:${day}`;
    const bucket = acceptedByTarget.get(key) || { target, day, points: [] };
    bucket.points.push(point);
    acceptedByTarget.set(key, bucket);
  }
  let accepted = 0;
  const writes = [];
  const lock = await acquireAgentHistoryLock(env, agentId);
  if (env.DB && !lock) return { ok: false, error: 'Agent 历史数据正在写入，请重试本次上报', retryable: true };
  try {
  const r2State = await readR2State(env);
  const mergedBuckets = [];
  const bucketWritesByTarget = new Map();
  for (const bucket of acceptedByTarget.values()) {
    const merged = await appendAgentR2HistoryPoints(env, agentId, bucket.target, bucket.day, bucket.points);
    accepted += bucket.points.length;
    writes.push({ target_id: bucket.target.id, day: bucket.day, points: bucket.points.length, stored: merged.length });
    const latestPoint = latestHistoryPoint(merged);
    if (latestPoint) mergedBuckets.push({ target: bucket.target, day: bucket.day, points: merged, latestPoint });
    const targetWrites = bucketWritesByTarget.get(bucket.target.id) || [];
    for (const point of bucket.points) targetWrites.push({ day: dayFromSec(point.checked_at, env), point });
    bucketWritesByTarget.set(bucket.target.id, targetWrites);
  }
  mergedBuckets.sort((a, b) => String(a.target.id).localeCompare(String(b.target.id)) || Number(a.latestPoint.checked_at) - Number(b.latestPoint.checked_at));
  const latestUpdates = new Map();
  for (const bucket of mergedBuckets) {
    const previous = latestUpdates.get(bucket.target.id) || r2State.targets?.[bucket.target.id] || null;
    const d1Points = await readCheckBuckets(env, bucket.target.id, 2);
    const mergedForDaily = mergeCheckPointsByBucket(d1Points, bucket.points);
    latestUpdates.set(bucket.target.id, buildAgentStateUpdate(env, bucket.target, bucket.latestPoint, mergedForDaily, previous));
  }
  const stateUpdates = [...latestUpdates.values()];
  if (stateUpdates.length) {
    await mergeR2StateUpdates(env, stateUpdates);
    for (const update of stateUpdates) {
      await applyProbeWriteBatch(env, update.target_id, update.checked_at, bucketWritesByTarget.get(update.target_id) || [], update, null);
    }
  }
  return { ok: true, agent_id: agentId, accepted, rejected, writes, state_updates: stateUpdates.length };
  } finally {
    await releaseAgentHistoryLock(env, lock);
  }
}
