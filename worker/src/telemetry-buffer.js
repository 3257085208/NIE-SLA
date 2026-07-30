import { nowSec, sanitizeAgentId } from './utils.js';
import { exportTelemetryHour, maxExportAttempts, normalizeExportAttempt, timeseriesExportEnabled } from './timeseries-export.js';

const HOUR_SEC = 3600;
const CHUNK_SEC = 300;
const CHUNK_PREFIX = 'chunk:';
const LEGACY_BUFFER_PREFIX = 'hour:';
const EXPORT_PREFIX = 'export:';
const FLUSH_GRACE_SEC = 600;

export class TelemetryBuffer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/append') {
      const body = await request.json();
      return Response.json(await this.append(body));
    }
    if (request.method === 'GET' && url.pathname === '/read') {
      return Response.json(await this.read(
        Number(url.searchParams.get('since') || 0),
        Number(url.searchParams.get('until') || nowSec()),
      ));
    }
    if (request.method === 'POST' && url.pathname === '/delete') {
      await this.state.storage.deleteAll();
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  }

  async alarm() {
    await this.flushCompletedHours(nowSec());
  }

  async append(body) {
    const agentId = sanitizeAgentId(body?.agent_id);
    if (!agentId) throw new Error('Agent ID 无效');
    const grouped = groupByChunk(body?.points, body?.pings);
    if (!grouped.size) return { ok: true, skipped: true };

    await this.state.storage.transaction(async (txn) => {
      for (const [chunk, incoming] of grouped) {
        const key = chunkKey(chunk);
        const existing = await txn.get(key) || emptyBuffer(agentId, chunk);
        await txn.put(key, compactBuffer(mergeBuffer(existing, incoming, agentId, chunk, CHUNK_SEC)));
      }
    });

    await this.scheduleFlush();
    await this.flushCompletedHours(nowSec());
    return { ok: true, chunks: grouped.size };
  }

  async read(since, until) {
    const start = Number.isFinite(since) ? Math.floor(since) : 0;
    const end = Number.isFinite(until) ? Math.floor(until) : nowSec();
    const rows = await this.bufferRows();
    const points = [];
    const pings = [];
    for (const value of rows.values()) {
      for (const point of bufferPoints(value)) {
        const ts = Number(point?.ts || 0);
        if (ts >= start && ts <= end) points.push(point);
      }
      for (const ping of bufferPings(value)) {
        const ts = Number(ping?.ts || 0);
        if (ts >= start && ts <= end) pings.push(ping);
      }
    }
    points.sort((a, b) => Number(a.ts) - Number(b.ts));
    pings.sort((a, b) => Number(a.ts) - Number(b.ts) || String(a.target_id).localeCompare(String(b.target_id)));
    return { ok: true, points, pings };
  }

  async flushCompletedHours(currentAt) {
    const flushBefore = Number(currentAt) - FLUSH_GRACE_SEC;
    const rows = await this.bufferRows();
    const completed = new Map();
    for (const [key, value] of rows) {
      const start = bufferedStart(key);
      const hour = hourStart(start);
      if (!Number.isFinite(start) || hour + HOUR_SEC > flushBefore) continue;
      const item = completed.get(hour) || { keys: [], buffers: [] };
      item.keys.push(key);
      item.buffers.push(value);
      completed.set(hour, item);
    }
    let retry = false;
    for (const [hour, item] of completed) {
      try {
        let merged = emptyBuffer(item.buffers[0]?.agent_id, hour);
        for (const value of item.buffers) merged = mergeBuffer(merged, value, value?.agent_id, hour, HOUR_SEC);
        await flushHour(this.env, merged);
        await this.queueExport(merged.agent_id, hour);
        for (const key of item.keys) await this.state.storage.delete(key);
      } catch (error) {
        retry = true;
        console.error('telemetry buffer flush failed:', String(error?.message || error));
      }
    }
    await this.flushPendingExports(currentAt);
    if (retry) await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    else if ((await this.bufferRows(1)).size) await this.scheduleFlush();
  }

  async queueExport(agentId, hour) {
    if (!timeseriesExportEnabled(this.env)) return;
    const key = `${EXPORT_PREFIX}${hourStart(hour)}`;
    const current = normalizeExportAttempt(await this.state.storage.get(key));
    await this.state.storage.put(key, { agent_id: sanitizeAgentId(agentId), hour: hourStart(hour), ...current });
  }

  async flushPendingExports(currentAt) {
    if (!timeseriesExportEnabled(this.env)) return;
    const rows = await this.state.storage.list({ prefix: EXPORT_PREFIX });
    let retry = false;
    for (const [key, value] of rows) {
      const hour = hourStart(value?.hour || String(key).slice(EXPORT_PREFIX.length));
      const nextAt = Number(value?.next_at || 0);
      if (nextAt > currentAt) { retry = true; continue; }
      try {
        const object = await readR2Object(this.env.ARCHIVE, telemetryKey(this.env, sanitizeAgentId(value?.agent_id), hour));
        if (!object) { await this.state.storage.delete(key); continue; }
        await exportTelemetryHour(this.env, value.agent_id, hour, pingsFromPayload(object?.pings));
        await this.state.storage.delete(key);
      } catch (error) {
        const attempt = normalizeExportAttempt(value);
        const attempts = attempt.attempts + 1;
        if (attempts >= maxExportAttempts) {
          console.error('time-series export dropped after retry limit:', String(error?.message || error));
          await this.state.storage.delete(key);
          continue;
        }
        const delay = Math.min(3600, 300 * (2 ** Math.min(attempts - 1, 3)));
        await this.state.storage.put(key, {
          agent_id: value.agent_id,
          hour,
          attempts,
          last_error: normalizeExportAttempt({ last_error: error?.message || error }).last_error,
          next_at: currentAt + delay,
        });
        retry = true;
      }
    }
    if (retry) await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
  }

  async scheduleFlush() {
    const alarmAt = (hourStart(nowSec()) + HOUR_SEC + FLUSH_GRACE_SEC + 30) * 1000;
    const current = await this.state.storage.getAlarm();
    if (current == null || current > alarmAt) await this.state.storage.setAlarm(alarmAt);
  }

  async bufferRows(limit = null) {
    const chunks = await this.state.storage.list(limit == null ? { prefix: CHUNK_PREFIX } : { prefix: CHUNK_PREFIX, limit });
    if (limit != null && chunks.size >= limit) return chunks;
    const legacy = await this.state.storage.list(limit == null
      ? { prefix: LEGACY_BUFFER_PREFIX }
      : { prefix: LEGACY_BUFFER_PREFIX, limit: limit - chunks.size });
    return new Map([...chunks, ...legacy]);
  }
}

export async function appendBufferedAgentTelemetry(env, agentId, points, pings) {
  if (!env.TELEMETRY_BUFFER) return null;
  const id = sanitizeAgentId(agentId);
  const stub = env.TELEMETRY_BUFFER.get(env.TELEMETRY_BUFFER.idFromName(`agent:${id}`));
  const response = await stub.fetch('https://nie-sla.internal/append', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent_id: id, points, pings }),
  });
  if (!response.ok) throw new Error(`遥测缓冲写入失败：HTTP ${response.status}`);
  return response.json();
}

export async function readBufferedAgentTelemetry(env, agentId, since, until) {
  if (!env.TELEMETRY_BUFFER) return { points: [], pings: [] };
  const id = sanitizeAgentId(agentId);
  const stub = env.TELEMETRY_BUFFER.get(env.TELEMETRY_BUFFER.idFromName(`agent:${id}`));
  const url = new URL('https://nie-sla.internal/read');
  url.searchParams.set('since', String(Math.floor(Number(since) || 0)));
  url.searchParams.set('until', String(Math.floor(Number(until) || nowSec())));
  const response = await stub.fetch(url.toString());
  if (!response.ok) return { points: [], pings: [] };
  const body = await response.json().catch(() => ({}));
  return {
    points: Array.isArray(body?.points) ? body.points : [],
    pings: Array.isArray(body?.pings) ? body.pings : [],
  };
}

export async function deleteBufferedAgentTelemetry(env, agentId) {
  if (!env.TELEMETRY_BUFFER) return { ok: true, skipped: true };
  const id = sanitizeAgentId(agentId);
  if (!id) return { ok: true, skipped: true };
  const stub = env.TELEMETRY_BUFFER.get(env.TELEMETRY_BUFFER.idFromName(`agent:${id}`));
  const response = await stub.fetch('https://nie-sla.internal/delete', { method: 'POST' });
  if (!response.ok) throw new Error(`遥测缓冲删除失败：HTTP ${response.status}`);
  return response.json();
}

function groupByChunk(points, pings) {
  const grouped = new Map();
  const bucket = (ts) => {
    const chunk = chunkStart(ts);
    const value = grouped.get(chunk) || { points: [], pings: [] };
    grouped.set(chunk, value);
    return value;
  };
  for (const point of Array.isArray(points) ? points : []) {
    const ts = Number(point?.ts || 0);
    if (ts > 0) bucket(ts).points.push(point);
  }
  for (const ping of Array.isArray(pings) ? pings : []) {
    const ts = Number(ping?.ts || 0);
    if (ts > 0 && ping?.target_id) bucket(ts).pings.push(ping);
  }
  return grouped;
}

function mergeBuffer(existing, incoming, agentId, start, duration) {
  const byPoint = new Map();
  for (const point of [...bufferPoints(existing), ...bufferPoints(incoming)]) {
    const ts = Number(point?.ts || 0);
    if (ts >= start && ts < start + duration) byPoint.set(ts, point);
  }
  const byPing = new Map();
  for (const ping of [...bufferPings(existing), ...bufferPings(incoming)]) {
    const ts = Number(ping?.ts || 0);
    const targetId = String(ping?.target_id || '');
    if (targetId && ts >= start && ts < start + duration) byPing.set(`${targetId}:${ts}`, ping);
  }
  return {
    schema: duration === CHUNK_SEC ? 'nie-sla-telemetry-buffer-v2' : 'nie-sla-telemetry-buffer-v1',
    agent_id: agentId,
    chunk: start,
    hour: hourStart(start),
    points: [...byPoint.values()].sort((a, b) => Number(a.ts) - Number(b.ts)),
    pings: [...byPing.values()].sort((a, b) => Number(a.ts) - Number(b.ts) || String(a.target_id).localeCompare(String(b.target_id))),
  };
}

async function flushHour(env, buffered) {
  if (!env.ARCHIVE) throw new Error('缺少 R2 的 ARCHIVE 绑定');
  const agentId = sanitizeAgentId(buffered?.agent_id);
  const hour = hourStart(buffered?.hour);
  const key = telemetryKey(env, agentId, hour);
  const existing = await readR2Object(env.ARCHIVE, key);
  const merged = mergeBuffer({
    points: metricsFromPayload(existing?.metrics),
    pings: pingsFromPayload(existing?.pings),
  }, buffered, agentId, hour, HOUR_SEC);
  const dayHour = utcDayHour(hour);
  await env.ARCHIVE.put(key, JSON.stringify({
    schema: 'nstatus-agent-telemetry-hour-v1',
    agent_id: agentId,
    day: dayHour.day,
    hour: dayHour.hour,
    updated_at: new Date().toISOString(),
    metrics: { schema: 'nstatus-agent-metrics-hour-v2', series: metricPointsToColumns(merged.points) },
    pings: { schema: 'nstatus-agent-pings-hour-v2', series: pingPointsToSeries(merged.pings) },
  }), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { schema: 'nstatus-agent-telemetry-hour-v1', agent_id: agentId, day: dayHour.day, hour: dayHour.hour },
  });
}

async function readR2Object(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  try { return await object.json(); } catch (_) { return null; }
}

function metricsFromPayload(payload) {
  if (Array.isArray(payload?.points)) return payload.points;
  const series = payload?.series;
  if (!series || !Array.isArray(series.dt)) return [];
  const fields = Array.isArray(series.fields) ? series.fields : Object.keys(series.values || {});
  return series.dt.map((delta, index) => {
    const point = { ts: Number(series.t0 || 0) + Number(delta || 0) };
    for (const field of fields) point[field] = Number(series.values?.[field]?.[index] || 0);
    return point;
  });
}

function pingsFromPayload(payload) {
  if (Array.isArray(payload?.pings)) return payload.pings;
  if (!Array.isArray(payload?.series)) return [];
  const out = [];
  for (const series of payload.series) {
    for (let index = 0; index < (series?.dt || []).length; index++) {
      out.push({
        target_id: String(series.target_id || ''),
        ts: Number(series.t0 || 0) + Number(series.dt[index] || 0),
        latency_ms: series.latency_ms?.[index] == null ? null : Number(series.latency_ms[index]),
        ok: Number(series.ok?.[index] || 0),
      });
    }
  }
  return out;
}

function telemetryKey(env, agentId, hour) {
  const prefix = String(env.AGENT_METRICS_R2_PREFIX || 'agent-metrics-v1').replace(/^\/+|\/+$/g, '');
  const dayHour = utcDayHour(hour);
  return `${prefix}/${agentId}/${dayHour.day}/${dayHour.hour}/telemetry.json`;
}

function emptyBuffer(agentId, start) {
  return { agent_id: agentId, chunk: start, hour: hourStart(start), points: [], pings: [] };
}

function compactBuffer(buffer) {
  return {
    schema: 'nie-sla-telemetry-buffer-v2',
    agent_id: buffer.agent_id,
    chunk: buffer.chunk,
    hour: buffer.hour,
    metric_series: metricPointsToColumns(buffer.points),
    ping_series: pingPointsToSeries(buffer.pings),
  };
}

function bufferPoints(value) {
  if (Array.isArray(value?.points)) return value.points;
  return metricsFromPayload({ series: value?.metric_series });
}

function bufferPings(value) {
  if (Array.isArray(value?.pings)) return value.pings;
  return pingsFromPayload({ series: value?.ping_series });
}

function chunkKey(chunk) {
  return `${CHUNK_PREFIX}${chunkStart(chunk)}`;
}

function bufferedStart(key) {
  const text = String(key);
  if (text.startsWith(CHUNK_PREFIX)) return Number(text.slice(CHUNK_PREFIX.length));
  if (text.startsWith(LEGACY_BUFFER_PREFIX)) return Number(text.slice(LEGACY_BUFFER_PREFIX.length));
  return NaN;
}

function hourStart(value) {
  return Math.floor(Number(value || 0) / HOUR_SEC) * HOUR_SEC;
}

function chunkStart(value) {
  return Math.floor(Number(value || 0) / CHUNK_SEC) * CHUNK_SEC;
}

function metricPointsToColumns(points) {
  const list = [...(points || [])].sort((a, b) => Number(a.ts) - Number(b.ts));
  const fields = [...new Set(list.flatMap(point => Object.keys(point).filter(key => key !== 'ts')))];
  const t0 = Number(list[0]?.ts || 0);
  const values = Object.fromEntries(fields.map(field => [field, []]));
  const dt = [];
  for (const point of list) {
    dt.push(Number(point.ts) - t0);
    for (const field of fields) values[field].push(Number(point[field] || 0));
  }
  return { t0, dt, fields, values };
}

function pingPointsToSeries(pings) {
  const grouped = new Map();
  for (const ping of pings || []) {
    const targetId = String(ping?.target_id || '');
    if (!targetId) continue;
    const list = grouped.get(targetId) || [];
    list.push(ping);
    grouped.set(targetId, list);
  }
  return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([targetId, list]) => {
    list.sort((a, b) => Number(a.ts) - Number(b.ts));
    const t0 = Number(list[0]?.ts || 0);
    return {
      target_id: targetId,
      t0,
      dt: list.map(point => Number(point.ts) - t0),
      latency_ms: list.map(point => point.latency_ms == null ? null : Number(point.latency_ms)),
      ok: list.map(point => Number(point.ok || 0)),
    };
  });
}

function utcDayHour(ts) {
  const iso = new Date(hourStart(ts) * 1000).toISOString();
  return { day: iso.slice(0, 10), hour: iso.slice(11, 13) };
}
