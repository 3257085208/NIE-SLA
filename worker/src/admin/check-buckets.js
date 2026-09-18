
import { clamp, parseBoolean, nowSec, dayFromSec, dayStartSec, isMissedMonitorPoint, buildMissedPoints, buildOpenMissedPoints } from '../utils.js';
import { summaryRowsFromChecks, readR2State } from '../storage.js';
import { appendBufferedProbeHistory, probeHistoryEnabled, readBufferedProbeHistory } from '../probe-history-buffer.js';



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

export function latestStatusToD1Enabled(env = {}) {
  return parseBoolean(env.PROBE_LATEST_STATUS_TO_D1 ?? true, true);
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

function targetProbeScheduleStatement(env, targetId, checkedAt, nextProbeAt) {
  const next = Number(nextProbeAt);
  if (!Number.isFinite(next) || next <= 0) return null;
  return env.DB.prepare(`UPDATE targets
    SET last_checked_at = CASE WHEN last_checked_at IS NULL OR last_checked_at < ? THEN ? ELSE last_checked_at END,
        next_probe_at = CASE WHEN next_probe_at IS NULL OR next_probe_at < ? THEN ? ELSE next_probe_at END
    WHERE id = ?`).bind(checkedAt, checkedAt, next, next, targetId);
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
    const since = nowSec() - days * 86400;
    const rows = await env.DB.prepare(
      `SELECT bucket_at as checked_at, last_ok as ok, last_latency_ms as latency_ms, last_status_code as status_code, last_error as error, probe_region, total, ok_count FROM check_buckets WHERE target_id = ? AND bucket_at >= ? ORDER BY bucket_at ASC`
    ).bind(targetId, since).all();
    const legacy = (rows.results || []).map(r => ({
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
    const buffered = probeHistoryEnabled(env)
      ? await readBufferedProbeHistory(env, targetId, since, nowSec(), dayFromSec(since, env), dayFromSec(nowSec(), env)).catch((error) => {
        console.error('read buffered probe history failed:', String(error?.message || error));
        return [];
      })
      : [];
    const byBucket = new Map(legacy.map(point => [Number(point.checked_at), point]));
    for (const point of buffered) byBucket.set(Number(point.checked_at), point);
    const stored = [...byBucket.values()].sort((a, b) => Number(a.checked_at) - Number(b.checked_at));
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
  if (probeHistoryEnabled(env)) {
    const row = await env.DB.prepare(
      `SELECT bucket_at as checked_at, last_ok as ok, last_latency_ms as latency_ms, last_error as error, total, ok_count
       FROM check_buckets WHERE target_id = ? AND day = ? AND bucket_at < ? ORDER BY bucket_at ASC`
    ).bind(targetId, day, beforeAt).all();
    const buffered = await readBufferedProbeHistory(env, targetId, dayStartSec(day, env), beforeAt - 1, day, day).catch((error) => {
      console.error('read buffered probe day failed:', String(error?.message || error));
      return [];
    });
    const byBucket = new Map((row.results || []).map(point => [Number(point.checked_at), point]));
    for (const point of buffered) byBucket.set(Number(point.checked_at), point);
    return summarizeCheckPoints([...byBucket.values()]);
  }
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

function summarizeCheckPoints(points) {
  let total = 0;
  let okCount = 0;
  let sumLatency = 0;
  for (const point of points || []) {
    if (isMissedMonitorPoint(point)) continue;
    const pointTotal = Math.max(0, Number(point.total || 0));
    const pointOk = Math.max(0, Number(point.ok_count || 0));
    total += pointTotal;
    okCount += pointOk;
    const latency = Number(point.latency_ms);
    if (pointOk && Number.isFinite(latency)) sumLatency += latency * pointOk;
  }
  return { total, ok_count: okCount, sum_latency_ms: sumLatency };
}

export function checkBucketSummaryQueryPlan(startDay, options = {}) {
  const targetIds = options.targetIds === undefined
    ? null
    : [...new Set((options.targetIds || []).map(String).filter(Boolean))];
  if (targetIds && !targetIds.length) return [];
  const recentFromDay = String(options.recentFromDay || startDay);
  const historicalTargetIds = [...new Set((options.historicalTargetIds || []).map(String).filter(Boolean))];
  const historicalRanges = Array.isArray(options.historicalTargetRanges)
    ? options.historicalTargetRanges.map((range) => ({
      fromDay: String(range?.fromDay || '').slice(0, 10),
      toDay: String(range?.toDay || '').slice(0, 10),
      targetIds: [...new Set((range?.targetIds || []).map(String).filter(Boolean))],
    })).filter(range => range.fromDay && range.toDay && range.fromDay < range.toDay && range.targetIds.length)
    : [];
  const plans = [{
    where: 'day >= ?',
    params: [recentFromDay],
  }];
  if (recentFromDay > startDay && historicalRanges.length) {
    for (const range of historicalRanges) {
      const fromDay = range.fromDay < startDay ? startDay : range.fromDay;
      const toDay = range.toDay > recentFromDay ? recentFromDay : range.toDay;
      if (fromDay >= toDay) continue;
      plans.push({
        where: `day >= ? AND day < ? AND target_id IN (${range.targetIds.map(() => '?').join(',')})`,
        params: [fromDay, toDay, ...range.targetIds],
      });
    }
  } else if (recentFromDay > startDay && historicalTargetIds.length) {
    plans.push({
      where: `day >= ? AND day < ? AND target_id IN (${historicalTargetIds.map(() => '?').join(',')})`,
      params: [startDay, recentFromDay, ...historicalTargetIds],
    });
  }
  if (targetIds) {
    // D1 caps bound parameters at 100 per statement; chunk so a growing fleet
    // degrades to more queries instead of silently empty summaries.
    const chunks = [];
    for (let offset = 0; offset < targetIds.length; offset += 90) {
      chunks.push(targetIds.slice(offset, offset + 90));
    }
    const chunked = [];
    for (const plan of plans) {
      for (const chunk of chunks) {
        chunked.push({
          ...plan,
          where: `(${plan.where}) AND target_id IN (${chunk.map(() => '?').join(',')})`,
          params: [...plan.params, ...chunk],
        });
      }
    }
    return chunked;
  }
  return plans;
}

function addCalendarDays(day, offset) {
  const value = new Date(`${String(day || '').slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(value.getTime())) return String(day || '').slice(0, 10);
  value.setUTCDate(value.getUTCDate() + Number(offset || 0));
  return value.toISOString().slice(0, 10);
}

export function buildSummaryFallbackOptions({ startDay, days, env, r2State, summaryCacheRows = [], targetIds = [], forceHistoricalTargetIds = [], currentDay = dayFromSec(nowSec(), env) }) {
  const ids = [...new Set((targetIds || []).map(String).filter(Boolean))];
  if (!ids.length) return { targetIds: [] };
  const forceHistorical = new Set((forceHistoricalTargetIds || []).map(String).filter(Boolean));
  const cachedDays = new Map();
  for (const row of summaryCacheRows || []) {
    const targetId = String(row?.target_id || '').trim();
    const day = String(row?.day || '').slice(0, 10);
    if (!targetId || !day || day >= currentDay) continue;
    if (!cachedDays.has(targetId)) cachedDays.set(targetId, new Set());
    cachedDays.get(targetId).add(day);
  }

  const requiredDays = [];
  for (let offset = 0; offset < Math.max(1, Number(days) || 1); offset++) requiredDays.push(addCalendarDays(startDay, offset));
  const historicalDays = requiredDays.filter((day) => day < currentDay);
  const rangeTargets = new Map();
  const addHistoricalRange = (fromDay, toDay, targetId) => {
    const key = `${fromDay}|${toDay}`;
    if (!rangeTargets.has(key)) rangeTargets.set(key, { fromDay, toDay, targetIds: [] });
    rangeTargets.get(key).targetIds.push(targetId);
  };
  const historicalTargetIds = ids.filter((targetId) => {
    const daily = r2State?.targets?.[targetId]?.daily;
    const coveredDays = new Set(daily && typeof daily === 'object' ? Object.keys(daily) : []);
    for (const day of cachedDays.get(targetId) || []) coveredDays.add(day);
    if (forceHistorical.has(targetId)) {
      addHistoricalRange(historicalDays[0] || startDay, currentDay, targetId);
      return true;
    }
    const missingDays = historicalDays.filter((day) => !coveredDays.has(day));
    if (!missingDays.length) return false;
    let rangeStart = missingDays[0];
    let previousDay = missingDays[0];
    for (let index = 1; index < missingDays.length; index += 1) {
      const day = missingDays[index];
      if (day !== addCalendarDays(previousDay, 1)) {
        addHistoricalRange(rangeStart, addCalendarDays(previousDay, 1), targetId);
        rangeStart = day;
      }
      previousDay = day;
    }
    addHistoricalRange(rangeStart, addCalendarDays(previousDay, 1), targetId);
    return true;
  });

  return {
    targetIds: ids,
    recentFromDay: currentDay,
    historicalTargetIds,
    historicalTargetRanges: [...rangeTargets.values()].map(range => ({ ...range, targetIds: [...new Set(range.targetIds)] })),
  };
}

export async function getCheckBucketSummaries(env, startDay, options = {}) {
  if (!env.DB) return [];
  try {
    const byKey = new Map();
    // Completed days read from the pre-aggregated table (a few thousand rows
    // total); only today's live buckets still scan raw check_buckets.
    const today = dayFromSec(nowSec(), env);
    try {
      const aggRows = await env.DB.prepare(
        `SELECT target_id, day, total, ok_count, sum_latency_ms
         FROM check_bucket_days
         WHERE day >= ? AND day < ?
         ORDER BY day ASC, target_id ASC`
      ).bind(String(startDay), today).all();
      for (const row of aggRows.results || []) {
        byKey.set(`${row.target_id}|${row.day}`, {
          target_id: row.target_id,
          day: row.day,
          total: Number(row.total || 0),
          ok_count: Number(row.ok_count || 0),
          sum_latency_ms: Number(row.sum_latency_ms || 0),
        });
      }
    } catch (_) {}
    // Historical day-range plans are covered by check_bucket_days; the live
    // plan (day >= without an upper bound) still scans today's raw buckets.
    const plans = checkBucketSummaryQueryPlan(startDay, options).filter((plan) => !plan.where.includes('day <'));
    for (const plan of plans) {
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
    let latestRows = await env.DB.prepare(`SELECT target_id, checked_at, ok, latency_ms, status_code, error, probe_region FROM latest_status`).all().catch(() => ({ results: [] }));
    if (!latestStatusToD1Enabled(env)) {
      const currentState = options.r2State || await readR2State(env).catch((error) => {
        console.error('read R2 current status for summaries failed:', String(error?.message || error));
        return { targets: {} };
      });
      const latestByTarget = new Map((latestRows.results || []).map(row => [String(row.target_id), row]));
      for (const [targetId, state] of Object.entries(currentState.targets || {})) {
        const current = latestByTarget.get(targetId);
        if (!current || Number(state?.checked_at || 0) >= Number(current?.checked_at || 0)) latestByTarget.set(targetId, { ...state, target_id: targetId });
      }
      latestRows = { results: [...latestByTarget.values()] };
    }
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
    const bufferedTargetIds = [...new Set([
      ...(options.targetIds || []),
      ...(options.historicalTargetIds || []),
      ...((options.historicalTargetRanges || []).flatMap(range => range?.targetIds || [])),
    ].map(String).filter(Boolean))];
    if (probeHistoryEnabled(env) && bufferedTargetIds.length) {
      const untilDay = dayFromSec(nowSec(), env);
      const bufferedRows = await Promise.all(bufferedTargetIds.map(async targetId => {
        try {
          const points = await readBufferedProbeHistory(env, targetId, dayStartSec(startDay, env), nowSec(), startDay, untilDay);
          return summaryRowsFromChecks(targetId, points, env);
        } catch (error) {
          console.error(`read buffered probe summaries failed (${targetId}):`, String(error?.message || error));
          return [];
        }
      }));
      for (const rows of bufferedRows) {
        for (const row of rows) {
          if (String(row.day) < String(startDay)) continue;
          const key = `${row.target_id}|${row.day}`;
          const existing = byKey.get(key);
          if (!existing) {
            byKey.set(key, row);
            continue;
          }
          // The buffer is enabled during a rolling migration.  D1 contains
          // the prefix written before the switch, while the buffer contains
          // the suffix written after it; additive merge preserves both.
          existing.total += Number(row.total || 0);
          existing.ok_count += Number(row.ok_count || 0);
          existing.sum_latency_ms += Number(row.sum_latency_ms || 0);
        }
      }
    }
    return [...byKey.values()].sort((a, b) => a.day.localeCompare(b.day) || a.target_id.localeCompare(b.target_id));
  } catch (_) { return []; }
}

export async function applyProbeWriteBatch(env, targetId, checkedAt, bucketWrites, latestStatus, incidentWrite = null, nextProbeAt = null, scheduleFlush = true, options = {}) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  const stmts = [];
  let bucketStorage = 'd1';
  let bufferSucceeded = false;
  if (probeHistoryEnabled(env) && (bucketWrites || []).length) {
    try {
      // Region batches collect the writes and flush one shared-hub request for
      // the whole batch; every other caller appends through the hub directly.
      if (typeof options?.historyAppend === 'function') await options.historyAppend(targetId, bucketWrites);
      else await appendBufferedProbeHistory(env, targetId, bucketWrites);
      bucketStorage = 'probe_history';
      bufferSucceeded = true;
    } catch (error) {
      console.error('append buffered probe history failed, falling back to D1:', String(error?.message || error));
    }
  }
  // Probe buckets live in the ProbeHistory DO/R2 archive; D1 keeps a mirror
  // only when the buffer is unavailable (disabled or append failed), which
  // also removes the per-bucket index-row write cost at fleet scale.
  if (!bufferSucceeded) {
    for (const item of bucketWrites || []) {
      if (!item?.point || !item.day) continue;
      stmts.push(checkBucketStatement(env, targetId, item.day, item.point));
    }
  }
  if (latestStatus && latestStatusToD1Enabled(env)) stmts.push(latestStatusStatement(env, latestStatus));
  if (incidentWrite) {
    const incidentStmt = incidentEventStatement(env, targetId, incidentWrite.action, incidentWrite.started_at, incidentWrite.recovered_at, incidentWrite.colo, incidentWrite.error);
    if (incidentStmt) stmts.push(incidentStmt);
  }
  if (incidentWrite?.action === 'still_down') stmts.push(touchActiveIncidentStatement(env, targetId, checkedAt, incidentWrite.colo, incidentWrite.error));
  const scheduleStmt = scheduleFlush === false ? null : targetProbeScheduleStatement(env, targetId, checkedAt, nextProbeAt);
  if (scheduleStmt) stmts.push(scheduleStmt);
  if (!stmts.length) return { ok: true, writes: 0, bucket_storage: bucketStorage };
  try {
    await env.DB.batch(stmts);
  } catch (error) {
    console.error('probe D1 batch failed:', String(error?.message || error));
    return { ok: false, error: String(error?.message || error), bucket_storage: bucketStorage };
  }
  return { ok: true, writes: stmts.length, bucket_storage: bucketStorage };
}

// Durability fallback for a failed shared-hub batch flush: write the collected
// buckets back into the legacy D1 mirror so probe points are never lost.
export async function writeProbeBucketsToD1(env, entries) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  const stmts = [];
  for (const entry of entries || []) {
    const targetId = String(entry?.target_id || '');
    for (const item of entry?.writes || []) {
      if (!item?.point || !item.day) continue;
      stmts.push(checkBucketStatement(env, targetId, item.day, item.point));
    }
  }
  if (!stmts.length) return { ok: true, writes: 0 };
  try {
    await env.DB.batch(stmts);
  } catch (error) {
    console.error('probe bucket fallback D1 batch failed:', String(error?.message || error));
    return { ok: false, error: String(error?.message || error) };
  }
  return { ok: true, writes: stmts.length };
}

// Rebuild per-day summaries for the live window only (today + yesterday).
// Historical days are backfilled once at schema-ensure time and never change,
// so the expensive full-window scans disappear from the hot path.
export async function refreshCheckBucketDays(env) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  try {
    // Only completed days are ever read back from check_bucket_days
    // (getCheckBucketSummaries filters day < today), so aggregating today's
    // still-growing bucket set on every maintenance run only burned D1 reads.
    const yesterday = dayFromSec(nowSec() - 86400, env);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM check_bucket_days WHERE day = ?`).bind(yesterday),
      env.DB.prepare(`INSERT INTO check_bucket_days (day, target_id, total, ok_count, sum_latency_ms, updated_at)
        SELECT day, target_id,
               SUM(CASE WHEN last_error LIKE '%monitor missed this 5-minute check%' THEN 0 ELSE total END),
               SUM(CASE WHEN last_error LIKE '%monitor missed this 5-minute check%' THEN 0 ELSE ok_count END),
               SUM(CASE WHEN last_error LIKE '%monitor missed this 5-minute check%' THEN 0 ELSE sum_latency_ms END),
               strftime('%s','now')
        FROM check_buckets WHERE day = ? GROUP BY day, target_id`).bind(yesterday, yesterday),
    ]);
    return { ok: true };
  } catch (error) {
    console.error('refreshCheckBucketDays failed:', String(error?.message || error));
    return { ok: false, error: String(error?.message || error) };
  }
}

export async function cleanupOldCheckBuckets(env, daysToKeep = 31) {
  if (!env.DB) return;
  try {
    const cutoff = nowSec() - daysToKeep * 86400;
    const cutoffDay = dayFromSec(cutoff, env);
    // The day-index predicate has to scan every bucket of the cutoff day.
    // Scoping by the enabled target ids lets SQLite use the covering
    // (target_id, day, bucket_at) index, so only rows that actually expire
    // are read. A bucket_at-only index was rejected because it would add a
    // billed index write to every probe bucket.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM check_buckets WHERE day < ?`).bind(cutoffDay),
      env.DB.prepare(`DELETE FROM check_buckets
        WHERE target_id IN (SELECT id FROM targets) AND day = ? AND bucket_at < ?`).bind(cutoffDay, cutoff),
    ]);
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

export async function reconcileOpenIncidents(env) {
  if (!env.DB) return { ok: false, skipped: true, reason: 'no_db' };
  try {
    const result = await env.DB.prepare(
      `UPDATE incident_events SET recovered_at = (
         SELECT MAX(cb.bucket_at) FROM check_buckets cb
         WHERE cb.target_id = incident_events.target_id AND cb.ok_count > 0
       )
       WHERE recovered_at IS NULL
         AND EXISTS (
           SELECT 1 FROM check_buckets cb2
           WHERE cb2.target_id = incident_events.target_id AND cb2.ok_count > 0
             AND cb2.bucket_at > strftime('%s','now') - 1800
         )`
    ).run();
    const changes = Number(result?.meta?.changes || 0);
    if (changes) console.log(`reconciled ${changes} open incidents against fresh successful buckets`);
    return { ok: true, changes };
  } catch (error) {
    console.error('reconcile open incidents failed:', String(error?.message || error));
    return { ok: false, error: String(error?.message || error) };
  }
}
