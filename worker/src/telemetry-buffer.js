import { nowSec, sanitizeAgentId } from './utils.js';
import { agentStateTimestamp } from './agent-state.js';
import { internalRequestAuthorized, internalRequestHeaders } from './auth.js';
import { persistAgentMetricsStateFallback, processAgentMetricsPayload } from './metrics.js';
import { readR2JsonResult } from './storage.js';
import { exportTelemetryHour, maxExportAttempts, normalizeExportAttempt, timeseriesExportEnabled } from './timeseries-export.js';
import { getPingIntervalSec } from './ping-config.js';
import { pingTargetProtocol } from './ping-target-protocol.js';
import { decodeAgentMetricsProtobuf } from './telemetry-protobuf.js';

const HOUR_SEC = 3600;
const CHUNK_SEC = 300;
const DEFAULT_FLUSH_SEC = 3600;
const MIN_FLUSH_SEC = 600;
const MAX_FLUSH_SEC = 86400;
const CHUNK_PREFIX = 'chunk:';
const LEGACY_BUFFER_PREFIX = 'hour:';
const EXPORT_PREFIX = 'export:';
// Every Agent WebSocket is routed to the same shared Durable Object instance
// (see routes.js), so per-Agent latest states must live under per-Agent keys
// inside that one instance instead of a single shared key.
export const AGENT_METRICS_STREAM_INSTANCE = 'agent-metrics-stream';
const LATEST_STATE_PREFIX = 'latest:state:';
// Durable Object storage.list() silently truncates large key spaces (default
// page caps around 1000 keys), so every unbounded listing must page through
// the full range (startAfter acts as the continuation cursor).
const STORAGE_LIST_PAGE_LIMIT = 500;
const FLUSH_GRACE_SEC = 600;

function latestStateKey(agentId) {
  return `${LATEST_STATE_PREFIX}${sanitizeAgentId(agentId)}`;
}

export class TelemetryBuffer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (!internalRequestAuthorized(request, this.env)) return new Response(JSON.stringify({ ok: false, error: '未授权' }), { status: 401, headers: { 'content-type': 'application/json' } });
    if (request.method === 'GET' && url.pathname === '/agent-metrics/ws' && String(request.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
      return this.openAgentMetricsSocket(request);
    }
    if (request.method === 'GET' && url.pathname === '/latest') {
      const agentId = sanitizeAgentId(url.searchParams.get('agent_id') || '');
      if (!agentId) return Response.json({ ok: false, error: 'Agent ID 无效' }, { status: 400 });
      return Response.json({ ok: true, state: await this.state.storage.get(latestStateKey(agentId)) || null });
    }
    if (request.method === 'DELETE' && url.pathname === '/latest') {
      const agentId = sanitizeAgentId(url.searchParams.get('agent_id') || '');
      if (!agentId) return Response.json({ ok: false, error: 'Agent ID 无效' }, { status: 400 });
      await this.state.storage.delete(latestStateKey(agentId));
      return Response.json({ ok: true, agent_id: agentId });
    }
    if (request.method === 'GET' && url.pathname === '/fleet/latest') {
      return Response.json(await this.readFleetLatestStates());
    }
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

  openAgentMetricsSocket(request) {
    const agentId = sanitizeAgentId(request.headers.get('x-nie-sla-agent-id') || '');
    if (!agentId) return new Response(JSON.stringify({ ok: false, error: '缺少 Agent ID' }), { status: 400, headers: { 'content-type': 'application/json' } });
    const WebSocketPairCtor = globalThis.WebSocketPair;
    if (typeof WebSocketPairCtor !== 'function') return new Response(JSON.stringify({ ok: false, error: 'WebSocket runtime unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
    const pair = new WebSocketPairCtor();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ agent_id: agentId });
    this.state.acceptWebSocket(server, [`agent:${agentId}`]);
    server.send(JSON.stringify({ ok: true, type: 'ready', agent_id: agentId }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    try {
      const body = typeof message === 'string'
        ? parseJsonMessage(message)
        : parseBinaryMessage(message);
      if (body?.type === 'ping') {
        socket.send(JSON.stringify({ ok: true, type: 'pong' }));
        return;
      }
      const attachment = socket.deserializeAttachment() || {};
      const payload = body?.type === 'metrics' ? body.payload : body;
      // previousState must be THIS Agent's own latest state (per-Agent key in
      // this shared instance), never another Agent's state.
      const agentId = sanitizeAgentId(attachment.agent_id || '');
      const previousState = agentId ? await this.state.storage.get(latestStateKey(agentId)) || null : null;
      const result = await processAgentMetricsPayload(this.env, payload, null, attachment.agent_id, {
        previousState,
        skipStateD1: true,
        returnLatestState: true,
      });
      const latestState = result?.latest_state;
      if (latestState) {
        try {
          const latestKey = latestStateKey(latestState.agent_id || agentId);
          // A late message from a stale socket (reconnect race) must not
          // overwrite a newer state already stored for this Agent.
          if (agentStateTimestamp(previousState?.updated_at) <= agentStateTimestamp(latestState.updated_at)) {
            await this.state.storage.put(latestKey, latestState);
          }
        } catch (error) {
          console.error('store buffered Agent latest state failed:', String(error?.message || error));
          try {
            await persistAgentMetricsStateFallback(this.env, latestState);
          } catch (fallbackError) {
            console.error('fallback Agent latest state to D1 failed:', String(fallbackError?.message || fallbackError));
          }
        }
      }
      const { latest_state: _latestState, ...ack } = result || {};
      const control = await this.readControlSnapshot();
      socket.send(JSON.stringify({ ...ack, ...(control ? { control } : {}), type: 'metrics_ack' }));
    } catch (error) {
      const status = Number(error?.status || 400);
      socket.send(JSON.stringify({ ok: false, type: 'metrics_ack', error: String(error?.message || 'WS metrics failed'), retryable: status >= 500 }));
    }
  }

  webSocketClose() {}

  webSocketError(_socket, error) {
    console.error('agent metrics websocket error:', String(error?.message || error));
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

  async readFleetLatestStates() {
    const rows = await this.listStorageEntries(LATEST_STATE_PREFIX);
    const states = {};
    for (const [key, value] of rows) {
      const agentId = sanitizeAgentId(String(key).slice(LATEST_STATE_PREFIX.length));
      if (agentId && value && typeof value === 'object' && !Array.isArray(value)) states[agentId] = value;
    }
    return { ok: true, states };
  }

  async readControlSnapshot() {
    const now = nowSec();
    const cached = await this.state.storage.get('control:ping');
    const ttl = Math.max(60, Math.min(3600, Number(this.env.PROBE_CONTROL_CACHE_SEC || 300)));
    if (cached?.control && Number(cached.fetched_at || 0) + ttl > now) return cached.control;
    try {
      const rows = await this.env.DB?.prepare(`SELECT id, target, enabled FROM ping_targets WHERE enabled = 1 ORDER BY name LIMIT 500`).all();
      const targets = (rows?.results || []).map(row => ({
        id: String(row.id || '').slice(0, 128),
        target: String(row.target || '').slice(0, 2048),
        enabled: Number(row.enabled || 0) === 1,
        protocol: pingTargetProtocol(row.target),
      })).filter(row => row.id && row.target && ['tcp', 'http'].includes(row.protocol));
      const control = { ping_interval_sec: await getPingIntervalSec(this.env), ping_targets: targets };
      await this.state.storage.put('control:ping', { fetched_at: now, control });
      return control;
    } catch (error) {
      console.error('read WSS control snapshot failed:', String(error?.message || error));
      return cached?.control || null;
    }
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
    const flushInterval = telemetryFlushIntervalSec(this.env);
    const flushBefore = Number(currentAt) - FLUSH_GRACE_SEC;
    const rows = await this.bufferRows();
    const completed = new Map();
    for (const [key, value] of rows) {
      const start = bufferedStart(key);
      const hour = hourStart(start);
      if (!Number.isFinite(start) || hour + flushInterval > flushBefore) continue;
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
    const rows = await this.listStorageEntries(EXPORT_PREFIX);
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
    const flushInterval = telemetryFlushIntervalSec(this.env);
    const alarmAt = (hourStart(nowSec()) + flushInterval + FLUSH_GRACE_SEC + 30) * 1000;
    const current = await this.state.storage.getAlarm();
    if (current == null || current > alarmAt) await this.state.storage.setAlarm(alarmAt);
  }

  // storage.list() truncates around 1000 keys per call, so unbounded listings
  // page with an explicit per-page limit and startAfter as the continuation
  // cursor until the key range is exhausted.
  async listStorageEntries(prefix, pageLimit = STORAGE_LIST_PAGE_LIMIT) {
    const entries = new Map();
    let startAfter;
    while (true) {
      const page = await this.state.storage.list(startAfter
        ? { prefix, limit: pageLimit, startAfter }
        : { prefix, limit: pageLimit });
      const before = entries.size;
      for (const [key, value] of page) if (!entries.has(key)) entries.set(key, value);
      if (page.size < pageLimit || entries.size === before) break;
      const lastKey = [...page.keys()].pop();
      if (!lastKey || lastKey === startAfter) break;
      startAfter = lastKey;
    }
    return entries;
  }

  async bufferRows(limit = null) {
    // With a limit these are bounded existence/count probes; without one the
    // flush path must see every row, so it pages through the full key space.
    const chunks = limit == null
      ? await this.listStorageEntries(CHUNK_PREFIX)
      : await this.state.storage.list({ prefix: CHUNK_PREFIX, limit });
    if (limit != null && chunks.size >= limit) return chunks;
    const legacy = limit == null
      ? await this.listStorageEntries(LEGACY_BUFFER_PREFIX)
      : await this.state.storage.list({ prefix: LEGACY_BUFFER_PREFIX, limit: limit - chunks.size });
    return new Map([...chunks, ...legacy]);
  }
}

function parseJsonMessage(text) {
  if (text.length > 220_000) throw new Error('metrics 数据过大');
  return JSON.parse(text);
}

function parseBinaryMessage(message) {
  const bytes = message instanceof ArrayBuffer
    ? new Uint8Array(message)
    : ArrayBuffer.isView(message)
      ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
      : null;
  if (!bytes) return decodeAgentMetricsProtobuf(message);
  if (bytes.byteLength > 220_000) throw new Error('metrics 数据过大');
  // Keep accepting the legacy binary-UTF-8 JSON form used by older clients.
  if (bytes[0] === 0x7b || bytes[0] === 0x5b) return parseJsonMessage(new TextDecoder().decode(bytes));
  return decodeAgentMetricsProtobuf(bytes);
}

export async function appendBufferedAgentTelemetry(env, agentId, points, pings) {
  if (!env.TELEMETRY_BUFFER) return null;
  const id = sanitizeAgentId(agentId);
  const stub = env.TELEMETRY_BUFFER.get(env.TELEMETRY_BUFFER.idFromName(`agent:${id}`));
  const response = await stub.fetch('https://nie-sla.internal/append', {
    method: 'POST',
    headers: internalRequestHeaders(env),
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
  const response = await stub.fetch(url.toString(), { headers: internalRequestHeaders(env) });
  if (!response.ok) return { points: [], pings: [] };
  const body = await response.json().catch(() => ({}));
  return {
    points: Array.isArray(body?.points) ? body.points : [],
    pings: Array.isArray(body?.pings) ? body.pings : [],
  };
}

export async function readBufferedAgentLatestState(env, agentId) {
  if (!env.TELEMETRY_BUFFER) return null;
  const id = sanitizeAgentId(agentId);
  if (!id) return null;
  // Latest states live in the same shared instance that owns the Agent
  // WebSockets, keyed per Agent (latest:state:<agent_id>).
  const stub = env.TELEMETRY_BUFFER.get(env.TELEMETRY_BUFFER.idFromName(AGENT_METRICS_STREAM_INSTANCE));
  const url = new URL('https://nie-sla.internal/latest');
  url.searchParams.set('agent_id', id);
  const response = await stub.fetch(url.toString(), { headers: internalRequestHeaders(env) });
  if (!response.ok) return null;
  const body = await response.json().catch(() => ({}));
  return body?.state && typeof body.state === 'object' && !Array.isArray(body.state) ? body.state : null;
}

export async function readFleetLatestAgentStates(env) {
  if (!env.TELEMETRY_BUFFER) return {};
  const stub = env.TELEMETRY_BUFFER.get(env.TELEMETRY_BUFFER.idFromName(AGENT_METRICS_STREAM_INSTANCE));
  const response = await stub.fetch('https://nie-sla.internal/fleet/latest', { headers: internalRequestHeaders(env) });
  if (!response.ok) return {};
  const body = await response.json().catch(() => ({}));
  return body?.states && typeof body.states === 'object' && !Array.isArray(body.states) ? body.states : {};
}

export async function deleteBufferedAgentLatestState(env, agentId) {
  if (!env.TELEMETRY_BUFFER) return { ok: true, skipped: true };
  const id = sanitizeAgentId(agentId);
  if (!id) return { ok: true, skipped: true };
  const stub = env.TELEMETRY_BUFFER.get(env.TELEMETRY_BUFFER.idFromName(AGENT_METRICS_STREAM_INSTANCE));
  const url = new URL('https://nie-sla.internal/latest');
  url.searchParams.set('agent_id', id);
  const response = await stub.fetch(url.toString(), { method: 'DELETE', headers: internalRequestHeaders(env) });
  if (!response.ok) throw new Error(`Agent latest state 删除失败：HTTP ${response.status}`);
  return response.json();
}

export async function deleteBufferedAgentTelemetry(env, agentId) {
  if (!env.TELEMETRY_BUFFER) return { ok: true, skipped: true };
  const id = sanitizeAgentId(agentId);
  if (!id) return { ok: true, skipped: true };
  const stub = env.TELEMETRY_BUFFER.get(env.TELEMETRY_BUFFER.idFromName(`agent:${id}`));
  const response = await stub.fetch('https://nie-sla.internal/delete', { method: 'POST', headers: internalRequestHeaders(env) });
  if (!response.ok) throw new Error(`遥测缓冲删除失败：HTTP ${response.status}`);
  const result = await response.json();
  await deleteBufferedAgentLatestState(env, id);
  return result;
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
    schema: 'nie-sla-agent-telemetry-hour-v1',
    agent_id: agentId,
    day: dayHour.day,
    hour: dayHour.hour,
    updated_at: new Date().toISOString(),
    metrics: { schema: 'nie-sla-agent-metrics-hour-v2', series: metricPointsToColumns(merged.points) },
    pings: { schema: 'nie-sla-agent-pings-hour-v2', series: pingPointsToSeries(merged.pings) },
  }), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { schema: 'nie-sla-agent-telemetry-hour-v1', agent_id: agentId, day: dayHour.day, hour: dayHour.hour },
  });
}

async function readR2Object(bucket, key) {
  const result = await readR2JsonResult({ ARCHIVE: bucket }, key);
  if (!result.ok) throw new Error(`R2 telemetry read failed (${key}): ${result.error}`);
  if (!result.found) return null;
  if (!result.value || typeof result.value !== 'object' || Array.isArray(result.value)) {
    throw new Error(`R2 telemetry object is invalid (${key})`);
  }
  return result.value;
}

function metricsFromPayload(payload) {
  if (Array.isArray(payload?.points)) return payload.points;
  const series = payload?.series;
  if (!series || !Array.isArray(series.dt)) return [];
  const fields = Array.isArray(series.fields) ? series.fields : Object.keys(series.values || {});
  const temperatureSensors = Array.isArray(series.temperature_sensors) ? series.temperature_sensors : [];
  return series.dt.map((delta, index) => {
    const point = { ts: Number(series.t0 || 0) + Number(delta || 0) };
    for (const field of fields) point[field] = Number(series.values?.[field]?.[index] || 0);
    const sensors = temperatureSensors.flatMap(sensor => {
      const normalized = normalizeBufferedTemperatureSensor({ ...sensor, temp_c: sensor?.temp_c?.[index] });
      return normalized ? [normalized] : [];
    });
    if (sensors.length) point.temperature_sensors = sensors;
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

function telemetryFlushIntervalSec(env) {
  const raw = Number(env?.TELEMETRY_FLUSH_INTERVAL_SEC ?? DEFAULT_FLUSH_SEC);
  if (!Number.isFinite(raw)) return DEFAULT_FLUSH_SEC;
  return Math.max(MIN_FLUSH_SEC, Math.min(MAX_FLUSH_SEC, Math.floor(raw)));
}

function hourStart(value) {
  return Math.floor(Number(value || 0) / HOUR_SEC) * HOUR_SEC;
}

function chunkStart(value) {
  return Math.floor(Number(value || 0) / CHUNK_SEC) * CHUNK_SEC;
}

function metricPointsToColumns(points) {
  const list = [...(points || [])].sort((a, b) => Number(a.ts) - Number(b.ts));
  const fields = [...new Set(list.flatMap(point => Object.keys(point).filter(key => key !== 'ts' && key !== 'temperature_sensors')))];
  const t0 = Number(list[0]?.ts || 0);
  const values = Object.fromEntries(fields.map(field => [field, []]));
  const dt = [];
  for (const point of list) {
    dt.push(Number(point.ts) - t0);
    for (const field of fields) values[field].push(Number(point[field] || 0));
  }
  const temperatureSensors = temperatureSensorSeries(list);
  return {
    t0,
    dt,
    fields,
    values,
    ...(temperatureSensors.length ? { temperature_sensors: temperatureSensors } : {}),
  };
}

function normalizeBufferedTemperatureSensor(sensor) {
  const id = String(sensor?.id || '').trim().slice(0, 64);
  const label = String(sensor?.label || '').trim().slice(0, 128);
  const rawTemp = sensor?.temp_c;
  const temp = Number(rawTemp);
  if (!id || !label || rawTemp == null || rawTemp === '' || typeof rawTemp === 'boolean' || !Number.isFinite(temp)) return null;
  const kind = String(sensor?.kind || '');
  return {
    id,
    label,
    kind: ['cpu', 'gpu', 'motherboard', 'disk', 'chipset', 'other'].includes(kind) ? kind : 'other',
    temp_c: Math.max(-100, Math.min(1_000, temp)),
  };
}

function temperatureSensorSeries(points) {
  const sensors = new Map();
  for (const point of points || []) {
    for (const sensor of Array.isArray(point?.temperature_sensors) ? point.temperature_sensors.slice(0, 16) : []) {
      const normalized = normalizeBufferedTemperatureSensor(sensor);
      if (normalized && !sensors.has(normalized.id)) sensors.set(normalized.id, {
        id: normalized.id,
        label: normalized.label,
        kind: normalized.kind,
      });
    }
  }
  return [...sensors.values()].map(sensor => ({
    ...sensor,
    temp_c: (points || []).map(point => {
      const match = (point?.temperature_sensors || []).find(item => String(item?.id || '').trim() === sensor.id);
      return normalizeBufferedTemperatureSensor(match)?.temp_c ?? null;
    }),
  }));
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
