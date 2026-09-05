import { internalRequestAuthorized, internalRequestHeaders } from './auth.js';
import { nowSec, sanitizeId } from './utils.js';

const MAX_EVENTS = 100;
const MAX_MESSAGE_BYTES = 180_000;
const DEFAULT_MAX_ACTIVE_CONNECTIONS = 200;
const DEFAULT_MAX_ACTIVE_PER_IP = 10;
const DEFAULT_MAX_SOCKET_AGE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_IDLE_MS = 90 * 1000;
const SOCKET_SWEEP_MS = 60 * 1000;

/**
 * Public status updates use a separate hibernating WebSocket Durable Object.
 * The stream only carries compact target changes; the existing status API and
 * the browser's cached-poll fallback remain authoritative.
 */
export class StatusStream {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (!internalRequestAuthorized(request, this.env)) return json({ ok: false, error: '未授权' }, 401);
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/status/ws') {
      if (String(request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
        return new Response('WebSocket upgrade required', { status: 426 });
      }
      return this.openSocket(request);
    }
    if (request.method === 'POST' && url.pathname === '/publish') {
      const body = await request.json().catch(() => ({}));
      return json(await this.broadcast(body?.events));
    }
    return new Response(null, { status: 404 });
  }

  openSocket(request) {
    const WebSocketPairCtor = globalThis.WebSocketPair;
    if (typeof WebSocketPairCtor !== 'function') {
      return json({ ok: false, error: 'WebSocket runtime unavailable' }, 503);
    }
    const sockets = this.state.getWebSockets?.() || [];
    const maxConnections = envNumber(this.env, 'STATUS_STREAM_MAX_CONNECTIONS', DEFAULT_MAX_ACTIVE_CONNECTIONS, 10, 5000);
    const maxPerIp = envNumber(this.env, 'STATUS_STREAM_MAX_CONNECTIONS_PER_IP', DEFAULT_MAX_ACTIVE_PER_IP, 1, 100);
    const ip = clientIp(request);
    if (sockets.length >= maxConnections) {
      return json({ ok: false, error: '实时状态连接数已达上限，请稍后重试' }, 429, { 'retry-after': '30' });
    }
    const sameIp = sockets.reduce((count, socket) => count + (socketIp(socket) === ip ? 1 : 0), 0);
    if (sameIp >= maxPerIp) {
      return json({ ok: false, error: '同一来源的实时状态连接数已达上限，请稍后重试' }, 429, { 'retry-after': '30' });
    }
    const pair = new WebSocketPairCtor();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server, ['public-status']);
    const now = Date.now();
    server.serializeAttachment({ channel: 'public-status', protocol: 1, ip, opened_at: now, last_seen_at: now });
    server.send(JSON.stringify({ ok: true, type: 'ready', protocol: 1, heartbeat_sec: 30 }));
    void this.scheduleSocketSweep();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    try {
      this.touchSocket(socket);
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      if (text.length > 2048) return;
      const body = JSON.parse(text);
      if (body?.type === 'ping' || text === 'ping') socket.send(JSON.stringify({ ok: true, type: 'pong' }));
    } catch (_) {
      if (String(message || '') === 'ping') socket.send(JSON.stringify({ ok: true, type: 'pong' }));
    }
  }

  webSocketClose() {}

  webSocketError(_socket, error) {
    console.error('public status websocket error:', String(error?.message || error));
  }

  async alarm() {
    this.sweepExpiredSockets();
    if ((this.state.getWebSockets?.() || []).length) await this.scheduleSocketSweep();
  }

  async broadcast(events) {
    this.sweepExpiredSockets();
    const compact = compactStatusEvents(events);
    if (!compact.length) return { ok: true, skipped: true, reason: 'no_events', delivered: 0 };
    const payload = JSON.stringify({ ok: true, type: 'status_update', generated_at: nowSec(), events: compact });
    if (payload.length > MAX_MESSAGE_BYTES) return { ok: false, skipped: true, reason: 'message_too_large', delivered: 0 };
    let delivered = 0;
    for (const socket of this.state.getWebSockets?.() || []) {
      try {
        socket.send(payload);
        delivered += 1;
      } catch (_) {
        try { socket.close(1011, 'status stream unavailable'); } catch (_) {}
      }
    }
    return { ok: true, delivered, events: compact.length };
  }

  touchSocket(socket) {
    const attachment = readAttachment(socket);
    if (!attachment) return;
    try { socket.serializeAttachment({ ...attachment, last_seen_at: Date.now() }); } catch (_) {}
  }

  sweepExpiredSockets() {
    const now = Date.now();
    const maxAge = envNumber(this.env, 'STATUS_STREAM_MAX_SOCKET_AGE_SEC', DEFAULT_MAX_SOCKET_AGE_MS / 1000, 60, 86_400) * 1000;
    const maxIdle = envNumber(this.env, 'STATUS_STREAM_MAX_IDLE_SEC', DEFAULT_MAX_IDLE_MS / 1000, 30, 3_600) * 1000;
    for (const socket of this.state.getWebSockets?.() || []) {
      const attachment = readAttachment(socket);
      if (!attachment) continue;
      const openedAt = Number(attachment.opened_at || 0);
      const lastSeenAt = Number(attachment.last_seen_at || openedAt);
      if ((openedAt && now - openedAt > maxAge) || (lastSeenAt && now - lastSeenAt > maxIdle)) {
        try { socket.close(1000, 'status stream lease expired'); } catch (_) {}
      }
    }
  }

  async scheduleSocketSweep() {
    if (typeof this.state.storage?.setAlarm !== 'function') return;
    const current = typeof this.state.storage.getAlarm === 'function'
      ? await this.state.storage.getAlarm().catch(() => null)
      : null;
    if (current == null || Number(current) > Date.now() + SOCKET_SWEEP_MS) {
      await this.state.storage.setAlarm(Date.now() + SOCKET_SWEEP_MS);
    }
  }
}

function envNumber(env, key, fallback, min, max) {
  const value = Number(env?.[key]);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

function clientIp(request) {
  return String(request?.headers?.get('cf-connecting-ip') || 'unknown').trim().slice(0, 80) || 'unknown';
}

function readAttachment(socket) {
  try { return socket?.deserializeAttachment?.() || null; } catch (_) { return null; }
}

function socketIp(socket) {
  return String(readAttachment(socket)?.ip || 'unknown');
}

export function compactStatusEvents(items) {
  const byTarget = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const source = item?.state_update || item?.saved?.state_update || item || {};
    const targetId = String(source.target_id || item?.target_id || '').trim().slice(0, 128);
    const checkedAt = Math.floor(Number(source.checked_at || item?.checked_at || 0));
    if (!targetId || !checkedAt) continue;
    const event = {
      target_id: targetId,
      checked_at: checkedAt,
      ok: Number(source.ok ?? item?.ok) === 1 ? 1 : 0,
      latency_ms: source.latency_ms == null ? null : Number(source.latency_ms),
      status_code: source.status_code == null ? null : Number(source.status_code),
      error: source.error == null ? null : String(source.error).slice(0, 500),
      probe_region: String(source.probe_region || item?.probe_region || 'auto').slice(0, 32),
      uptime_24h: source.uptime_24h == null ? null : Number(source.uptime_24h),
      uptime_7d: source.uptime_7d == null ? null : Number(source.uptime_7d),
      avg_latency_24h: source.avg_latency_24h == null ? null : Number(source.avg_latency_24h),
      last_fail_at: source.last_fail_at == null ? null : Number(source.last_fail_at),
      current_outage_started_at: source.current_outage_started_at == null ? null : Number(source.current_outage_started_at),
      last_recover_at: source.last_recover_at == null ? null : Number(source.last_recover_at),
      status_changed_at: source.status_changed_at == null ? null : Number(source.status_changed_at),
    };
    const key = sanitizeId(targetId);
    const previous = byTarget.get(key);
    if (!previous || event.checked_at >= previous.checked_at) byTarget.set(key, event);
  }
  return [...byTarget.values()].slice(0, MAX_EVENTS);
}

export async function publishStatusEvents(env, events) {
  if (!env.STATUS_STREAM) return { ok: true, skipped: true, reason: 'missing_binding' };
  const compact = compactStatusEvents(events);
  if (!compact.length) return { ok: true, skipped: true, reason: 'no_events' };
  const id = env.STATUS_STREAM.idFromName('public-status-stream');
  const response = await env.STATUS_STREAM.get(id).fetch('https://nie-sla.internal/publish', {
    method: 'POST',
    headers: { ...internalRequestHeaders(env), 'content-type': 'application/json' },
    body: JSON.stringify({ events: compact }),
  });
  if (!response.ok) throw new Error(`状态 WebSocket 广播失败：HTTP ${response.status}`);
  return response.json();
}

function json(value, status = 200, headers = null) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', ...(headers || {}) } });
}
