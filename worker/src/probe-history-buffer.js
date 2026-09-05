import { clamp, dayFromSec, dayStartSec, isMissedMonitorPoint, nowSec, parseBoolean, sanitizeId } from './utils.js';
import { internalRequestAuthorized, internalRequestHeaders } from './auth.js';
import { readR2JsonResult } from './storage.js';

const DAY_PREFIX = 'day:';
const SCHEMA = 'nie-sla-probe-history-day-v1';
const DEFAULT_MAX_POINTS = 2_000;
const DAY_RANGE_LIMIT = 90;

/**
 * Probe history is intentionally a per-target Durable Object.  The object
 * serializes same-target bucket updates, keeps the current local day hot, and
 * writes one R2 object when a day is complete.  D1 remains the compatibility
 * fallback for old rows and for deployments without this binding.
 */
export class ProbeHistoryBuffer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (!internalRequestAuthorized(request, this.env)) return json({ ok: false, error: '未授权' }, 401);
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/append') {
      return json(await this.append(await request.json()));
    }
    if (request.method === 'GET' && url.pathname === '/read') {
      return json(await this.read({
        fromDay: url.searchParams.get('from_day'),
        toDay: url.searchParams.get('to_day'),
        since: Number(url.searchParams.get('since') || 0),
        until: Number(url.searchParams.get('until') || nowSec()),
      }));
    }
    if (request.method === 'GET' && url.pathname === '/summary') {
      return json(await this.summary(
        String(url.searchParams.get('day') || ''),
        Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER),
      ));
    }
    if (request.method === 'POST' && url.pathname === '/delete') {
      await this.state.storage.deleteAll();
      return json({ ok: true });
    }
    return new Response(null, { status: 404 });
  }

  async append(body) {
    const targetId = sanitizeId(body?.target_id);
    await this.state.storage.put('meta', { target_id: targetId, schema: SCHEMA });
    const incoming = new Map();
    for (const item of Array.isArray(body?.writes) ? body.writes : []) {
      const point = normalizeProbePoint(item?.point || item);
      const day = String(item?.day || dayFromSec(point?.checked_at || 0, this.env)).slice(0, 10);
      if (!point || !isDay(day)) continue;
      const list = incoming.get(day) || [];
      list.push(point);
      incoming.set(day, list);
    }
    if (!incoming.size) return { ok: true, skipped: true };

    const currentDay = dayFromSec(nowSec(), this.env);
    for (const [day, points] of incoming) {
      if (day < currentDay && this.env.ARCHIVE) {
        await this.mergeArchiveDay(targetId, day, points);
        continue;
      }
      const key = `${DAY_PREFIX}${day}`;
      const existing = await this.state.storage.get(key);
      const merged = mergeDay(existing, targetId, day, points, this.env);
      await this.state.storage.put(key, merged);
    }

    await this.flushCompletedDays(currentDay);
    await this.scheduleFlush(currentDay);
    return { ok: true, target_id: targetId, days: incoming.size, points: [...incoming.values()].reduce((sum, rows) => sum + rows.length, 0) };
  }

  async read({ fromDay, toDay, since = 0, until = nowSec() } = {}) {
    const start = Math.floor(Number(since) || 0);
    const end = Math.floor(Number(until) || nowSec());
    const days = boundedDayRange(fromDay, toDay, this.env, start, end);
    const stateRows = await this.state.storage.list({ prefix: DAY_PREFIX });
    const stateByDay = new Map();
    for (const [key, value] of stateRows) stateByDay.set(String(key).slice(DAY_PREFIX.length), value);

    const points = [];
    for (const day of days) {
      const archived = await this.readArchiveDay(day, stateByDay.get(day)?.target_id || null);
      const live = stateByDay.get(day);
      const merged = mergeDay(archived, live?.target_id || '', day, [
        ...(Array.isArray(live?.points) ? live.points : []),
      ], this.env);
      for (const point of merged.points || []) {
        if (Number(point.checked_at) >= start && Number(point.checked_at) <= end) points.push(toPublicPoint(point));
      }
    }
    points.sort((a, b) => Number(a.checked_at) - Number(b.checked_at));
    return { ok: true, points };
  }

  async summary(day, beforeAt = Number.MAX_SAFE_INTEGER) {
    if (!isDay(day)) return { ok: true, day: null, total: 0, ok_count: 0, sum_latency_ms: 0 };
    const result = await this.read({
      fromDay: day,
      toDay: day,
      since: dayStartSec(day, this.env),
      until: Math.min(Number(beforeAt) || Number.MAX_SAFE_INTEGER, dayStartSec(day, this.env) + 86400 - 1),
    });
    return { ok: true, day, ...summarizePoints(result.points) };
  }

  async flushCompletedDays(currentDay = dayFromSec(nowSec(), this.env)) {
    if (!this.env.ARCHIVE) return { ok: true, skipped: true, reason: 'missing_archive' };
    const rows = await this.state.storage.list({ prefix: DAY_PREFIX });
    let flushed = 0;
    for (const [key, value] of rows) {
      const day = String(key).slice(DAY_PREFIX.length);
      if (!isDay(day) || day >= currentDay) continue;
      await this.mergeArchiveDay(value?.target_id || '', day, Array.isArray(value?.points) ? value.points : []);
      await this.state.storage.delete(key);
      flushed += 1;
    }
    return { ok: true, flushed };
  }

  async alarm() {
    await this.flushCompletedDays(dayFromSec(nowSec(), this.env));
    await this.scheduleFlush(dayFromSec(nowSec(), this.env));
  }

  async scheduleFlush(currentDay) {
    if (typeof this.state.storage.setAlarm !== 'function') return;
    const nextDay = addDays(currentDay, 1);
    const nextBoundary = dayStartSec(nextDay, this.env) + 300;
    const currentAlarm = await this.state.storage.getAlarm?.();
    const nextAlarm = nextBoundary * 1000;
    if (currentAlarm == null || currentAlarm < Date.now() || currentAlarm > nextAlarm) await this.state.storage.setAlarm(nextAlarm);
  }

  async mergeArchiveDay(targetId, day, points) {
    if (!this.env.ARCHIVE) throw new Error('缺少 R2 的 ARCHIVE 绑定');
    const meta = await this.state.storage.get('meta');
    const resolvedTargetId = sanitizeId(targetId || meta?.target_id);
    const key = probeHistoryKey(this.env, resolvedTargetId, day);
    const existing = await this.readArchiveDay(day, resolvedTargetId);
    const merged = mergeDay(existing, resolvedTargetId, day, points, this.env);
    await this.env.ARCHIVE.put(key, JSON.stringify({
      schema: SCHEMA,
      target_id: merged.target_id,
      day,
      updated_at: new Date().toISOString(),
      points: merged.points,
    }), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: { schema: SCHEMA, target_id: merged.target_id, day },
    });
  }

  async readArchiveDay(day, targetId = null) {
    if (!this.env.ARCHIVE) return null;
    const meta = await this.state.storage.get('meta');
    const resolvedTargetId = sanitizeId(targetId || meta?.target_id);
    const result = await readR2JsonResult({ ARCHIVE: this.env.ARCHIVE }, probeHistoryKey(this.env, resolvedTargetId, day));
    if (!result.ok) throw new Error(`R2 probe history read failed (${day}): ${result.error}`);
    if (!result.found) return null;
    if (!result.value || typeof result.value !== 'object' || Array.isArray(result.value)) throw new Error(`R2 probe history object is invalid (${day})`);
    return result.value;
  }
}

export function probeHistoryEnabled(env = {}) {
  return Boolean(env.PROBE_HISTORY) && parseBoolean(env.PROBE_HISTORY_BUFFER ?? true, true);
}

export async function appendBufferedProbeHistory(env, targetId, bucketWrites) {
  if (!probeHistoryEnabled(env) || !bucketWrites?.length) return { ok: true, skipped: true, reason: 'disabled' };
  const id = env.PROBE_HISTORY.idFromName(`probe:${sanitizeId(targetId)}`);
  const stub = env.PROBE_HISTORY.get(id);
  const response = await stub.fetch('https://nie-sla.internal/append', {
    method: 'POST',
    headers: internalRequestHeaders(env),
    body: JSON.stringify({ target_id: targetId, writes: bucketWrites }),
  });
  if (!response.ok) throw new Error(`SLA 历史缓冲写入失败：HTTP ${response.status}`);
  return response.json();
}

export async function readBufferedProbeHistory(env, targetId, since, until, fromDay = null, toDay = null) {
  if (!probeHistoryEnabled(env)) return [];
  const id = env.PROBE_HISTORY.idFromName(`probe:${sanitizeId(targetId)}`);
  const url = new URL('https://nie-sla.internal/read');
  url.searchParams.set('since', String(Math.floor(Number(since) || 0)));
  url.searchParams.set('until', String(Math.floor(Number(until) || nowSec())));
  if (fromDay) url.searchParams.set('from_day', String(fromDay));
  if (toDay) url.searchParams.set('to_day', String(toDay));
  const response = await env.PROBE_HISTORY.get(id).fetch(url.toString(), { headers: internalRequestHeaders(env) });
  if (!response.ok) throw new Error(`SLA 历史缓冲读取失败：HTTP ${response.status}`);
  const body = await response.json().catch(() => ({}));
  return Array.isArray(body?.points) ? body.points : [];
}

export async function readBufferedProbeDaySummary(env, targetId, day, beforeAt) {
  if (!probeHistoryEnabled(env)) return null;
  const id = env.PROBE_HISTORY.idFromName(`probe:${sanitizeId(targetId)}`);
  const url = new URL('https://nie-sla.internal/summary');
  url.searchParams.set('day', String(day));
  url.searchParams.set('before', String(Math.floor(Number(beforeAt) || Number.MAX_SAFE_INTEGER)));
  const response = await env.PROBE_HISTORY.get(id).fetch(url.toString(), { headers: internalRequestHeaders(env) });
  if (!response.ok) throw new Error(`SLA 历史缓冲汇总读取失败：HTTP ${response.status}`);
  const body = await response.json().catch(() => null);
  return body?.ok ? { total: Number(body.total || 0), ok_count: Number(body.ok_count || 0), sum_latency_ms: Number(body.sum_latency_ms || 0) } : null;
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function probeHistoryKey(env, targetId, day) {
  const prefix = String(env.PROBE_HISTORY_R2_PREFIX || 'probe-history-v1').replace(/^\/+|\/+$/g, '');
  return `${prefix}/${sanitizeId(targetId || 'target')}/${day}.json`;
}

function normalizeProbePoint(point) {
  const checkedAt = Math.floor(Number(point?.checked_at || 0));
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return null;
  const inputError = point?.error ?? point?.last_error;
  const missed = isMissedMonitorPoint({ ...point, error: inputError });
  const total = missed ? Math.max(1, Number(point?.total || 0) || 1) : Math.max(0, Number(point?.total == null ? 1 : point.total) || 0);
  const inputOk = point?.ok ?? point?.last_ok;
  const okCount = missed ? 0 : Math.max(0, Number(point?.ok_count == null ? (inputOk ? 1 : 0) : point.ok_count) || 0);
  const inputLatency = point?.latency_ms ?? point?.last_latency_ms;
  const latency = missed || inputLatency == null ? null : Number(inputLatency);
  const finiteLatency = Number.isFinite(latency) ? latency : null;
  const sumLatency = missed ? 0 : (Number.isFinite(Number(point?.sum_latency_ms)) ? Math.max(0, Number(point.sum_latency_ms)) : (finiteLatency == null ? 0 : finiteLatency * okCount));
  return {
    checked_at: checkedAt,
    total,
    ok_count: okCount,
    sum_latency_ms: sumLatency,
    last_ok: missed ? 0 : (inputOk == null ? 0 : Number(inputOk) ? 1 : 0),
    last_latency_ms: finiteLatency,
    last_status_code: missed || (point?.status_code ?? point?.last_status_code) == null ? null : Number(point.status_code ?? point.last_status_code),
    last_error: inputError == null ? null : String(inputError).slice(0, 500),
    probe_region: String(point?.probe_region || 'auto').slice(0, 32),
    cf_colo: point?.cf_colo ? String(point.cf_colo).slice(0, 32) : null,
  };
}

function mergeDay(existing, targetId, day, incoming, env) {
  const byBucket = new Map();
  const oldPoints = Array.isArray(existing?.points) ? existing.points : [];
  for (const point of oldPoints) {
    const normalized = normalizeProbePoint(point);
    if (normalized && dayFromSec(normalized.checked_at, env) === day) byBucket.set(normalized.checked_at, normalized);
  }
  for (const point of incoming || []) {
    const normalized = normalizeProbePoint(point);
    if (normalized && dayFromSec(normalized.checked_at, env) === day) byBucket.set(normalized.checked_at, normalized);
  }
  const maxPoints = clamp(Number(env.PROBE_HISTORY_MAX_POINTS_PER_DAY || DEFAULT_MAX_POINTS), 288, 10_000);
  const points = [...byBucket.values()].sort((a, b) => a.checked_at - b.checked_at).slice(-maxPoints);
  return { schema: SCHEMA, target_id: String(targetId || existing?.target_id || ''), day, points };
}

function toPublicPoint(point) {
  const missed = isMissedMonitorPoint({ ...point, error: point?.error ?? point?.last_error }) || (Number(point?.total || 0) === 0 && Number(point?.ok_count || 0) === 0);
  return {
    missed,
    checked_at: Number(point.checked_at),
    ok: missed ? 0 : Number(point.last_ok || 0),
    latency_ms: missed ? null : (point.last_latency_ms == null ? null : Number(point.last_latency_ms)),
    status_code: missed ? null : (point.last_status_code == null ? null : Number(point.last_status_code)),
    error: point.last_error == null ? null : String(point.last_error),
    probe_region: point.probe_region || 'auto',
    total: missed ? Math.max(1, Number(point.total || 0) || 1) : Number(point.total || 0),
    ok_count: missed ? 0 : Number(point.ok_count || 0),
    bucket: true,
  };
}

function summarizePoints(points) {
  let total = 0;
  let okCount = 0;
  let sumLatency = 0;
  for (const point of points || []) {
    if (isMissedMonitorPoint(point)) continue;
    total += Math.max(0, Number(point.total || 0));
    okCount += Math.max(0, Number(point.ok_count || 0));
    const latency = Number(point.latency_ms);
    if (okCount && Number.isFinite(latency)) sumLatency += latency * Math.max(0, Number(point.ok_count || 0));
  }
  return { total, ok_count: okCount, sum_latency_ms: sumLatency };
}

function boundedDayRange(fromDay, toDay, env, since, until) {
  const start = isDay(fromDay) ? fromDay : dayFromSec(since || nowSec(), env);
  const end = isDay(toDay) ? toDay : dayFromSec(until || nowSec(), env);
  const out = [];
  let day = start;
  for (let i = 0; i < DAY_RANGE_LIMIT && day <= end; i += 1) {
    out.push(day);
    day = addDays(day, 1);
  }
  return out;
}

function addDays(day, offset) {
  const value = new Date(`${String(day).slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(value.getTime())) return String(day).slice(0, 10);
  value.setUTCDate(value.getUTCDate() + Number(offset || 0));
  return value.toISOString().slice(0, 10);
}

function isDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}
