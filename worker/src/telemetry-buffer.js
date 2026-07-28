import { nowSec, sanitizeAgentId } from './utils.js';

const HOUR_SEC = 3600;
const BUFFER_PREFIX = 'hour:';
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
    const grouped = groupByHour(body?.points, body?.pings);
    if (!grouped.size) return { ok: true, skipped: true };

    await this.state.storage.transaction(async (txn) => {
      for (const [hour, incoming] of grouped) {
        const key = bufferKey(hour);
        const existing = await txn.get(key) || emptyBuffer(agentId, hour);
        await txn.put(key, mergeBuffer(existing, incoming, agentId, hour));
      }
    });

    await this.scheduleFlush();
    await this.flushCompletedHours(nowSec());
    return { ok: true, hours: grouped.size };
  }

  async read(since, until) {
    const start = Number.isFinite(since) ? Math.floor(since) : 0;
    const end = Number.isFinite(until) ? Math.floor(until) : nowSec();
    const rows = await this.state.storage.list({ prefix: BUFFER_PREFIX });
    const points = [];
    const pings = [];
    for (const value of rows.values()) {
      for (const point of value?.points || []) {
        const ts = Number(point?.ts || 0);
        if (ts >= start && ts <= end) points.push(point);
      }
      for (const ping of value?.pings || []) {
        const ts = Number(ping?.ts || 0);
        if (ts >= start && ts <= end) pings.push(ping);
      }
    }
    return { ok: true, points, pings };
  }

  async flushCompletedHours(currentAt) {
    const flushBefore = Number(currentAt) - FLUSH_GRACE_SEC;
    const rows = await this.state.storage.list({ prefix: BUFFER_PREFIX });
    let retry = false;
    for (const [key, value] of rows) {
      const hour = Number(String(key).slice(BUFFER_PREFIX.length));
      if (!Number.isFinite(hour) || hour + HOUR_SEC > flushBefore) continue;
      try {
        await flushHour(this.env, value);
        await this.state.storage.delete(key);
      } catch (error) {
        retry = true;
        console.error('telemetry buffer flush failed:', String(error?.message || error));
      }
    }
    if (retry) await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    else if ((await this.state.storage.list({ prefix: BUFFER_PREFIX, limit: 1 })).size) await this.scheduleFlush();
  }

  async scheduleFlush() {
    const alarmAt = (hourStart(nowSec()) + HOUR_SEC + FLUSH_GRACE_SEC + 30) * 1000;
    const current = await this.state.storage.getAlarm();
    if (current == null || current > alarmAt) await this.state.storage.setAlarm(alarmAt);
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

function groupByHour(points, pings) {
  const grouped = new Map();
  const bucket = (ts) => {
    const hour = hourStart(ts);
    const value = grouped.get(hour) || { points: [], pings: [] };
    grouped.set(hour, value);
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

function mergeBuffer(existing, incoming, agentId, hour) {
  const byPoint = new Map();
  for (const point of [...(existing?.points || []), ...(incoming?.points || [])]) {
    const ts = Number(point?.ts || 0);
    if (ts >= hour && ts < hour + HOUR_SEC) byPoint.set(ts, point);
  }
  const byPing = new Map();
  for (const ping of [...(existing?.pings || []), ...(incoming?.pings || [])]) {
    const ts = Number(ping?.ts || 0);
    const targetId = String(ping?.target_id || '');
    if (targetId && ts >= hour && ts < hour + HOUR_SEC) byPing.set(`${targetId}:${ts}`, ping);
  }
  return {
    schema: 'nie-sla-telemetry-buffer-v1',
    agent_id: agentId,
    hour,
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
  }, buffered, agentId, hour);
  const dayHour = utcDayHour(hour);
  await env.ARCHIVE.put(key, JSON.stringify({
    schema: 'nstatus-agent-telemetry-hour-v1',
    agent_id: agentId,
    day: dayHour.day,
    hour: dayHour.hour,
    updated_at: new Date().toISOString(),
    metrics: { schema: 'nstatus-agent-metrics-hour-v2', points: merged.points },
    pings: { schema: 'nstatus-agent-pings-hour-v2', pings: merged.pings },
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

function emptyBuffer(agentId, hour) {
  return { agent_id: agentId, hour, points: [], pings: [] };
}

function bufferKey(hour) {
  return `${BUFFER_PREFIX}${hourStart(hour)}`;
}

function hourStart(value) {
  return Math.floor(Number(value || 0) / HOUR_SEC) * HOUR_SEC;
}

function utcDayHour(ts) {
  const iso = new Date(hourStart(ts) * 1000).toISOString();
  return { day: iso.slice(0, 10), hour: iso.slice(11, 13) };
}
