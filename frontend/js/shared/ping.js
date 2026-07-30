function normalizedPing(point) {
  const targetId = String(point?.target_id || '');
  const ts = Number(point?.ts);
  const latency = point?.latency_ms == null ? null : Number(point.latency_ms);
  const ok = point?.ok === undefined ? Number.isFinite(latency) && latency >= 0 : Number(point.ok) === 1;
  return { target_id: targetId, ts, latency_ms: latency, ok };
}

export function normalizeLatencySample(sourceId, point, timeoutMs = 1000) {
  const targetId = String(sourceId || '');
  const ts = Number(point?.checked_at ?? point?.ts);
  const latency = point?.latency_ms == null ? null : Number(point.latency_ms);
  const timeout = Math.max(1, Number(timeoutMs) || 1000);
  const withinBudget = Number.isFinite(latency) && latency >= 0 && latency <= timeout;
  const ok = Number(point?.ok) === 1 && withinBudget;
  return {
    target_id: targetId,
    ts,
    latency_ms: ok ? latency : null,
    ok,
  };
}

export function latestPingByTarget(points) {
  const latest = new Map();
  for (const raw of points || []) {
    const point = normalizedPing(raw);
    if (!point.target_id || !Number.isFinite(point.ts)) continue;
    const previous = latest.get(point.target_id);
    if (!previous || point.ts >= previous.ts) latest.set(point.target_id, point);
  }
  return latest;
}

export function pingSampleWindowSec(points) {
  const byTarget = new Map();
  for (const raw of points || []) {
    const point = normalizedPing(raw);
    if (!point.target_id || !Number.isFinite(point.ts)) continue;
    const timestamps = byTarget.get(point.target_id) || [];
    timestamps.push(point.ts);
    byTarget.set(point.target_id, timestamps);
  }

  const gaps = [];
  for (const timestamps of byTarget.values()) {
    timestamps.sort((a, b) => a - b);
    for (let index = 1; index < timestamps.length; index += 1) {
      const gap = timestamps[index] - timestamps[index - 1];
      if (gap > 0 && gap <= 900) gaps.push(gap);
    }
  }
  if (!gaps.length) return 45;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return Math.min(120, Math.max(8, median * 0.65));
}

export function failedPingTargetsNear(points, timestamp, windowSec = pingSampleWindowSec(points)) {
  const targetTs = Number(timestamp);
  if (!Number.isFinite(targetTs)) return [];
  const nearest = new Map();
  for (const raw of points || []) {
    const point = normalizedPing(raw);
    if (!point.target_id || !Number.isFinite(point.ts)) continue;
    const distance = Math.abs(point.ts - targetTs);
    if (distance > windowSec) continue;
    const previous = nearest.get(point.target_id);
    if (!previous || distance < previous.distance) nearest.set(point.target_id, { point, distance });
  }
  return [...nearest.values()]
    .filter(({ point }) => !point.ok)
    .map(({ point }) => point.target_id)
    .sort((a, b) => a.localeCompare(b));
}

export function normalizePingLossSeries(seriesList) {
  const out = [];
  for (const series of seriesList || []) {
    const targetId = String(series?.target_id || '');
    const t0 = Math.floor(Number(series?.t0));
    if (!targetId || !Number.isFinite(t0) || t0 <= 0 || !Array.isArray(series?.runs)) continue;
    const runs = series.runs.map(run => {
      if (!Array.isArray(run) || run.length < 3) return null;
      const start = Math.floor(Number(run[0]));
      const step = Math.floor(Number(run[1]));
      const count = Math.floor(Number(run[2]));
      if (!Number.isFinite(start) || !Number.isFinite(step) || !Number.isFinite(count) || start < 0 || step < 0 || count < 1) return null;
      return [start, step, count];
    }).filter(Boolean);
    if (runs.length) out.push({ target_id: targetId, t0, runs });
  }
  return out;
}

export function failedPingTargetsNearRuns(seriesList, timestamp, windowSec = 1, targetIds = null) {
  const targetTs = Number(timestamp);
  const window = Math.max(0, Number(windowSec) || 0);
  if (!Number.isFinite(targetTs)) return [];
  const visible = targetIds == null ? null : new Set((targetIds || []).map(String));
  const failed = [];
  for (const series of normalizePingLossSeries(seriesList)) {
    if (visible && !visible.has(series.target_id)) continue;
    let matched = false;
    for (const [delta, step, count] of series.runs) {
      const start = series.t0 + delta;
      const index = step > 0 ? Math.max(0, Math.min(count - 1, Math.round((targetTs - start) / step))) : 0;
      if (Math.abs(start + index * step - targetTs) <= window) { matched = true; break; }
    }
    if (matched) failed.push(series.target_id);
  }
  return failed.sort((a, b) => a.localeCompare(b));
}

export function pingLossSeriesBounds(seriesList, targetIds = null) {
  const visible = targetIds == null ? null : new Set((targetIds || []).map(String));
  let min = Infinity;
  let max = -Infinity;
  for (const series of normalizePingLossSeries(seriesList)) {
    if (visible && !visible.has(series.target_id)) continue;
    for (const [delta, step, count] of series.runs) {
      const start = series.t0 + delta;
      min = Math.min(min, start);
      max = Math.max(max, start + step * (count - 1));
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

export function pingLossSeries(points, targetIds = []) {
  const ids = new Set((targetIds || []).map(String).filter(Boolean));
  const normalized = (points || []).map(normalizedPing)
    .filter(point => ids.has(point.target_id) && Number.isFinite(point.ts));
  if (!ids.size || !normalized.length) return [];

  const anchor = Math.min(...normalized.map(point => point.ts));
  const interval = Math.max(5, Math.round(pingSampleWindowSec(normalized) / 0.65));
  const buckets = new Map();
  for (const point of normalized) {
    const timestamp = anchor + Math.round((point.ts - anchor) / interval) * interval;
    const states = buckets.get(timestamp) || new Map();
    states.set(point.target_id, states.get(point.target_id) === false ? false : point.ok);
    buckets.set(timestamp, states);
  }

  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([x, states]) => {
    let failures = 0;
    for (const id of ids) if (states.get(id) === false) failures += 1;
    return { x, y: failures / ids.size };
  });
}

export function nextPingTargetSelection(current, targetId, allTargetIds = []) {
  const id = String(targetId || '');
  if (!id) return current;
  const all = new Set((allTargetIds || []).map(String).filter(Boolean));
  const next = current instanceof Set ? new Set([...current].map(String)) : new Set();
  if (current instanceof Set) {
    if (next.has(id)) next.delete(id);
    else next.add(id);
  } else {
    next.add(id);
  }
  return !next.size || (all.size && next.size >= all.size) ? null : next;
}
