
import { clamp, parseBoolean, nowSec, dayFromSec, isMissedMonitorPoint, buildMissedPoints, buildOpenMissedPoints, retentionSeconds } from '../utils.js';
import { summaryRowsFromChecks } from '../storage.js';



function latestStatusStatement(env, s) {
  return env.DB.prepare(`
    INSERT INTO latest_status (target_id, checked_at, ok, latency_ms, status_code, error, probe_region, cf_colo, uptime_24h, uptime_7d, avg_latency_24h, last_fail_at, current_outage_started_at, last_recover_at, status_changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(target_id) DO UPDATE SET
      checked_at=excluded.checked_at, ok=excluded.ok, latency_ms=excluded.latency_ms,
      status_code=excluded.status_code, error=excluded.error, probe_region=excluded.probe_region, cf_colo=excluded.cf_colo,
      uptime_24h=excluded.uptime_24h, uptime_7d=excluded.uptime_7d, avg_latency_24h=excluded.avg_latency_24h,
      last_fail_at=excluded.last_fail_at, current_outage_started_at=excluded.current_outage_started_at,
      last_recover_at=excluded.last_recover_at, status_changed_at=excluded.status_changed_at
    WHERE excluded.checked_at >= latest_status.checked_at
  `).bind(
    s.target_id, s.checked_at, s.ok, s.latency_ms, s.status_code,
    s.error ? String(s.error).slice(0, 500) : null,
    s.probe_region || 'auto', s.cf_colo || null, s.uptime_24h, s.uptime_7d, s.avg_latency_24h,
    s.last_fail_at, s.current_outage_started_at, s.last_recover_at, s.status_changed_at
  );
}

export async function upsertLatestStatus(env, s) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  try {
    await latestStatusStatement(env, s).run();
    return { ok: true };
  } catch (err) {
    console.error('upsertLatestStatus failed', err);
    return { ok: false, error: String(err?.message || err) };
  }
}



function incidentEventStatement(env, targetId, action, startedAt, recoveredAt, colo, error) {
  const now = nowSec();
  if (action === 'started') {
    return env.DB.prepare(`INSERT OR IGNORE INTO incident_events (id, target_id, started_at, last_checked_at, start_colo, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(`${targetId}-${startedAt}`, targetId, startedAt, startedAt, colo || null, error ? String(error).slice(0, 500) : null, now, now);
  }
  if (action === 'recovered') {
    return env.DB.prepare(`UPDATE incident_events SET recovered_at = ?, last_checked_at = ?, recover_colo = ?, last_error = NULL, updated_at = ? WHERE target_id = ? AND recovered_at IS NULL`)
      .bind(recoveredAt, recoveredAt || startedAt || null, colo || null, now, targetId);
  }
  return null;
}

function touchActiveIncidentStatement(env, targetId, checkedAt, colo, error) {
  return env.DB.prepare(`UPDATE incident_events SET last_checked_at = ?, last_error = ?, updated_at = ? WHERE target_id = ? AND recovered_at IS NULL`)
    .bind(checkedAt, error ? String(error).slice(0, 500) : null, nowSec(), targetId);
}

function targetLastCheckedStatement(env, targetId, checkedAt) {
  return env.DB.prepare(`UPDATE targets SET last_checked_at = CASE WHEN last_checked_at IS NULL OR last_checked_at < ? THEN ? ELSE last_checked_at END WHERE id = ?`).bind(checkedAt, checkedAt, targetId);
}

export async function writeIncidentEvent(env, targetId, action, startedAt, recoveredAt, colo, error) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  try {
    const stmt = incidentEventStatement(env, targetId, action, startedAt, recoveredAt, colo, error);
    if (stmt) await stmt.run();
    return { ok: true };
  } catch (err) {
    console.error('writeIncidentEvent failed', err);
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function touchActiveIncident(env, targetId, checkedAt, colo, error) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  try {
    await touchActiveIncidentStatement(env, targetId, checkedAt, colo, error).run();
    return { ok: true };
  } catch (err) {
    console.error('touchActiveIncident failed', err);
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function upsertTargetLastCheckedAt(env, targetId, checkedAt) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  const ts = Number.isFinite(Number(checkedAt)) ? Math.floor(Number(checkedAt)) : null;
  if (!ts) return { ok: false, skipped: true, reason: 'invalid_timestamp' };
  try {
    await targetLastCheckedStatement(env, targetId, ts).run();
    return { ok: true };
  } catch (err) {
    console.error('upsertTargetLastCheckedAt failed', err);
    return { ok: false, error: String(err?.message || err) };
  }
}



function normalizeCheckBucketPoint(point) {
  const missed = isMissedMonitorPoint(point);
  const total = point.total == null ? 1 : Math.max(0, Number(point.total || 0));
  const okCount = point.ok_count == null ? (point.ok ? 1 : 0) : Math.max(0, Number(point.ok_count || 0));
  return {
    missed,
    total: missed ? Math.max(1, total || 1) : total,
    okCount: missed ? 0 : okCount,
    ok: missed ? 0 : (point.ok == null ? 0 : Number(point.ok)),
    latencyMs: missed ? null : (point.latency_ms == null ? null : Number(point.latency_ms)),
    statusCode: missed ? null : (point.status_code == null ? null : Number(point.status_code)),
    error: point.error == null ? null : String(point.error).slice(0, 500),
    probeRegion: point.probe_region || 'auto',
    cfColo: point.cf_colo || null,
  };
}

function checkBucketStatement(env, targetId, day, point) {
  const normalized = normalizeCheckBucketPoint(point);
  return env.DB.prepare(`
      INSERT INTO check_buckets (target_id, bucket_at, day, total, ok_count, sum_latency_ms, last_ok, last_latency_ms, last_status_code, last_error, probe_region, cf_colo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_id, bucket_at) DO UPDATE SET
        day=excluded.day,
        total=excluded.total,
        ok_count=excluded.ok_count,
        sum_latency_ms=excluded.sum_latency_ms,
        last_ok=excluded.last_ok, last_latency_ms=excluded.last_latency_ms,
        last_status_code=excluded.last_status_code, last_error=excluded.last_error,
        probe_region=excluded.probe_region, cf_colo=excluded.cf_colo
    `).bind(
      targetId, point.checked_at, day,
      normalized.total,
      normalized.okCount,
      normalized.latencyMs == null ? 0 : Number(normalized.latencyMs),
      normalized.ok,
      normalized.latencyMs,
      normalized.statusCode,
      normalized.error,
      normalized.probeRegion,
      normalized.cfColo
    );
}

export async function upsertCheckBucket(env, targetId, day, point) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  try {
    await checkBucketStatement(env, targetId, day, point).run();
    return { ok: true };
  } catch (err) {
    console.error('upsertCheckBucket failed', err);
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function readCheckBuckets(env, targetId, days) {
  if (!env.DB) return [];
  try {
    const rows = await env.DB.prepare(
      `SELECT bucket_at as checked_at, last_ok as ok, last_latency_ms as latency_ms, last_status_code as status_code, last_error as error, probe_region, total, ok_count FROM check_buckets WHERE target_id = ? AND bucket_at >= ? ORDER BY bucket_at ASC`
    ).bind(targetId, nowSec() - days * 86400).all();
    const stored = (rows.results || []).map(r => ({
      missed: isMissedMonitorPoint(r) || (Number(r.total || 0) === 0 && Number(r.ok_count || 0) === 0),
      checked_at: Number(r.checked_at || 0),
      ok: isMissedMonitorPoint(r) ? 0 : Number(r.ok || 0),
      latency_ms: isMissedMonitorPoint(r) ? null : (r.latency_ms == null ? null : Number(r.latency_ms)),
      status_code: isMissedMonitorPoint(r) ? null : (r.status_code == null ? null : Number(r.status_code)),
      error: r.error == null ? null : String(r.error),
      probe_region: r.probe_region || 'auto',
      total: isMissedMonitorPoint(r) ? Math.max(1, Number(r.total || 0) || 1) : Number(r.total || 0),
      ok_count: isMissedMonitorPoint(r) ? 0 : Number(r.ok_count || 0),
      bucket: true,
    })).filter(r => Number(r.checked_at) > 0);
    if (!stored.length) return stored;
    const out = [stored[0]];
    for (let i = 1; i < stored.length; i++) {
      const previous = out[out.length - 1];
      const current = stored[i];
      const missed = buildMissedPoints(env, previous, current.checked_at, current.ok, current.probe_region);
      if (missed.length) out.push(...missed);
      out.push(current);
    }
    const tail = buildOpenMissedPoints(env, out[out.length - 1], nowSec(), out[out.length - 1]?.probe_region);
    if (tail.length) out.push(...tail);
    return out;
  } catch (_) { return []; }
}

export async function readCheckBucketDaySummary(env, targetId, day, beforeAt) {
  if (!env.DB) return { total: 0, ok_count: 0, sum_latency_ms: 0 };
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN last_error LIKE '%monitor missed this 5-minute check%' THEN 0 ELSE total END) AS total,
       SUM(CASE WHEN last_error LIKE '%monitor missed this 5-minute check%' THEN 0 ELSE ok_count END) AS ok_count,
       SUM(CASE WHEN last_error LIKE '%monitor missed this 5-minute check%' THEN 0 ELSE sum_latency_ms END) AS sum_latency_ms
     FROM check_buckets
     WHERE target_id = ? AND day = ? AND bucket_at < ?`
  ).bind(targetId, day, beforeAt).first();
  return {
    total: Number(row?.total || 0),
    ok_count: Number(row?.ok_count || 0),
    sum_latency_ms: Number(row?.sum_latency_ms || 0),
  };
}

export function checkBucketSummaryQueryPlan(startDay, options = {}) {
  const targetIds = options.targetIds === undefined
    ? null
    : [...new Set((options.targetIds || []).map(String).filter(Boolean))];
  if (targetIds && !targetIds.length) return [];
  const recentFromDay = String(options.recentFromDay || startDay);
  const historicalTargetIds = [...new Set((options.historicalTargetIds || []).map(String).filter(Boolean))];
  const plans = [{
    where: 'day >= ?',
    params: [recentFromDay],
  }];
  if (recentFromDay > startDay && historicalTargetIds.length) {
    plans.push({
      where: `day >= ? AND day < ? AND target_id IN (${historicalTargetIds.map(() => '?').join(',')})`,
      params: [startDay, recentFromDay, ...historicalTargetIds],
    });
  }
  if (targetIds) {
    const marks = targetIds.map(() => '?').join(',');
    for (const plan of plans) {
      plan.where = `(${plan.where}) AND target_id IN (${marks})`;
      plan.params.push(...targetIds);
    }
  }
  return plans;
}

export async function getCheckBucketSummaries(env, startDay, options = {}) {
  if (!env.DB) return [];
  try {
    const byKey = new Map();
    for (const plan of checkBucketSummaryQueryPlan(startDay, options)) {
      const rows = await env.DB.prepare(
        `SELECT target_id, day,
              SUM(CASE WHEN last_error LIKE '%monitor missed this 5-minute check%' THEN 0 ELSE total END) as total,
              SUM(CASE WHEN last_error LIKE '%monitor missed this 5-minute check%' THEN 0 ELSE ok_count END) as ok_count,
              SUM(CASE WHEN last_error LIKE '%monitor missed this 5-minute check%' THEN 0 ELSE sum_latency_ms END) as sum_latency_ms
       FROM check_buckets
       WHERE ${plan.where}
       GROUP BY target_id, day
       ORDER BY day ASC, target_id ASC`
      ).bind(...plan.params).all();
      for (const row of rows.results || []) {
        byKey.set(`${row.target_id}|${row.day}`, {
          target_id: row.target_id,
          day: row.day,
          total: Number(row.total || 0),
          ok_count: Number(row.ok_count || 0),
          sum_latency_ms: Number(row.sum_latency_ms || 0),
        });
      }
    }
    const latestRows = await env.DB.prepare(`SELECT target_id, checked_at, ok, latency_ms, status_code, error, probe_region FROM latest_status`).all().catch(() => ({ results: [] }));
    for (const row of latestRows.results || []) {
      if (Number(row.ok || 0) !== 1 || !Number(row.checked_at || 0)) continue;
      const synthetic = buildOpenMissedPoints(env, row, nowSec(), row.probe_region || 'auto');
      if (!synthetic.length) continue;
      const summaries = summaryRowsFromChecks(row.target_id, synthetic, env);
      for (const summary of summaries) {
        if (summary.day < startDay) continue;
        const key = `${summary.target_id}|${summary.day}`;
        const existing = byKey.get(key) || { target_id: summary.target_id, day: summary.day, total: 0, ok_count: 0, sum_latency_ms: 0 };
        existing.total += Number(summary.total || 0);
        existing.ok_count += Number(summary.ok_count || 0);
        existing.sum_latency_ms += Number(summary.sum_latency_ms || 0);
        byKey.set(key, existing);
      }
    }
    return [...byKey.values()].sort((a, b) => a.day.localeCompare(b.day) || a.target_id.localeCompare(b.target_id));
  } catch (_) { return []; }
}

export async function applyProbeWriteBatch(env, targetId, checkedAt, bucketWrites, latestStatus, incidentWrite = null) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  const stmts = [];
  for (const item of bucketWrites || []) {
    if (!item?.point || !item.day) continue;
    stmts.push(checkBucketStatement(env, targetId, item.day, item.point));
  }
  if (latestStatus) stmts.push(latestStatusStatement(env, latestStatus));
  if (incidentWrite) {
    const incidentStmt = incidentEventStatement(env, targetId, incidentWrite.action, incidentWrite.started_at, incidentWrite.recovered_at, incidentWrite.colo, incidentWrite.error);
    if (incidentStmt) stmts.push(incidentStmt);
  }
  if (incidentWrite?.action === 'still_down') stmts.push(touchActiveIncidentStatement(env, targetId, checkedAt, incidentWrite.colo, incidentWrite.error));
  if (!stmts.length) return { ok: true, writes: 0 };
  await env.DB.batch(stmts);
  return { ok: true, writes: stmts.length };
}

export async function cleanupOldCheckBuckets(env, daysToKeep = 31) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(`DELETE FROM check_buckets WHERE bucket_at < ?`).bind(nowSec() - daysToKeep * 86400).run();
  } catch (_) { console.error('cleanupOldCheckBuckets failed'); }
}

export async function cleanupVolatileHistory(env, options = {}) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  const now = nowSec();
  const agentRetention = clamp(Number(options.agent_hours || env.AGENT_METRICS_RETENTION_HOURS || 6), 1, 72) * 3600;
  const pingRetention = clamp(Number(options.ping_hours || env.PING_HISTORY_RETENTION_HOURS || 6), 1, 72) * 3600;
  const agentCutoff = now - agentRetention;
  const pingCutoff = now - pingRetention;
  const results = { ok: true, agent_cutoff: agentCutoff, ping_cutoff: pingCutoff, agent_changes: 0, ping_changes: 0, errors: [] };

  const agentIds = new Set();
  const pingAgentIds = new Set();
  try {
    const rows = await env.DB.prepare(`SELECT agent_id FROM agent_metrics_state`).all();
    for (const row of rows.results || []) {
      if (!row.agent_id) continue;
      agentIds.add(String(row.agent_id));
      pingAgentIds.add(String(row.agent_id));
    }
  } catch (err) { results.errors.push(`agent id list: ${String(err?.message || err)}`); }
  if (parseBoolean(env.AGENT_PINGS_TO_D1 ?? !env.ARCHIVE, !env.ARCHIVE)) {
    try {
      const rows = await env.DB.prepare(`SELECT DISTINCT agent_id FROM ping_history WHERE ts < ? LIMIT 200`).bind(pingCutoff).all();
      for (const row of rows.results || []) if (row.agent_id) pingAgentIds.add(String(row.agent_id));
    } catch (err) { results.errors.push(`ping id list: ${String(err?.message || err)}`); }
  }

  if (parseBoolean(env.AGENT_METRICS_TO_D1 ?? !env.ARCHIVE, !env.ARCHIVE)) {
    for (const agentId of agentIds) {
      try {
        const res = await env.DB.prepare(`DELETE FROM agent_metrics_history WHERE agent_id = ? AND ts < ?`).bind(agentId, agentCutoff).run();
        results.agent_changes += Number(res?.meta?.changes || 0);
      } catch (err) { results.errors.push(`agent ${agentId}: ${String(err?.message || err)}`); }
    }
  }
  if (parseBoolean(env.AGENT_PINGS_TO_D1 ?? !env.ARCHIVE, !env.ARCHIVE)) {
    for (const agentId of pingAgentIds) {
      try {
        const res = await env.DB.prepare(`DELETE FROM ping_history WHERE agent_id = ? AND ts < ?`).bind(agentId, pingCutoff).run();
        results.ping_changes += Number(res?.meta?.changes || 0);
      } catch (err) { results.errors.push(`ping ${agentId}: ${String(err?.message || err)}`); }
    }
  }
  results.ok = results.errors.length === 0;
  return results;
}
