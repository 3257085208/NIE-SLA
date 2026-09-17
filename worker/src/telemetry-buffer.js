import { nowSec, sanitizeAgentId, clamp } from './utils.js';
import { recordAgentAvailability } from './agent-availability.js';
import { agentStateTimestamp, bufferedAgentStateEnabled } from './agent-state.js';
import { internalRequestAuthorized, internalRequestHeaders } from './auth.js';
import { withS3Archive } from './r2s3.js';
import { persistAgentMetricsStateFallback, persistAgentTraffic, processAgentMetricsPayload } from './metrics.js';
import { readR2JsonResult } from './storage.js';
import { encodeJsonBody, httpMetadataFor } from './r2-body.js';
import { exportTelemetryHour, maxExportAttempts, normalizeExportAttempt, timeseriesExportEnabled } from './timeseries-export.js';
import { getPingIntervalSec } from './ping-config.js';
import { getAgentReportInterval } from './admin/settings.js';
import { pingTargetProtocol } from './ping-target-protocol.js';
import { getCachedProxyControl, getProxyControlRows } from './admin/proxy-targets.js';
import { decodeAgentMetricsProtobuf } from './telemetry-protobuf.js';

const HOUR_SEC = 3600;
const CHUNK_SEC = 300;
const DEFAULT_FLUSH_SEC = 3600;
const MIN_FLUSH_SEC = 600;
const MAX_FLUSH_SEC = 86400;
const CHUNK_PREFIX = 'chunk:';
const LEGACY_BUFFER_PREFIX = 'hour:';
const EXPORT_PREFIX = 'export:';
export const AGENT_METRICS_STREAM_INSTANCE = 'agent-metrics-stream';
const LATEST_STATE_PREFIX = 'latest:state:';
const STORAGE_LIST_PAGE_LIMIT = 500;
const FLUSH_GRACE_SEC = 600;
const MAX_MEM_REPORTS = 5_000;
const LATEST_PERSIST_THROTTLE_SEC = 300;
const AGENT_LIFECYCLE_PREFIX = 'agent:lifecycle:';

function latestStateKey(agentId) {
  return `${LATEST_STATE_PREFIX}${sanitizeAgentId(agentId)}`;
}

function agentLifecycleKey(agentId) {
  return `${AGENT_LIFECYCLE_PREFIX}${sanitizeAgentId(agentId)}`;
}

export class TelemetryBuffer {
  constructor(state, env) {
    env = withS3Archive(env);
    this.state = state;
    this.env = env;
    this.memLatest = new Map();
    this.memReports = [];
    this.latestPersistAt = new Map();
    this.msgWindows = new Map();
    this.migratedAgents = new Set();
  }

  // One shared DO serves every Agent's WSS reports; bound each agent's message
  // rate so one misbehaving node cannot exhaust the instance.
  allowAgentMessage(agentId) {
    const now = nowSec();
    const windowSec = clamp(Number(this.env.AGENT_WS_BURST_WINDOW_SEC || 300), 30, 3600);
    const limit = clamp(Number(this.env.AGENT_WS_BURST_LIMIT || 20), 2, 1000);
    let entry = this.msgWindows.get(agentId);
    if (!entry || now - entry.start >= windowSec) {
      entry = { start: now, count: 0 };
      this.msgWindows.set(agentId, entry);
      if (this.msgWindows.size > 5000) {
        for (const [key, value] of this.msgWindows) {
          if (now - value.start >= windowSec) this.msgWindows.delete(key);
        }
      }
    }
    entry.count += 1;
    return entry.count <= limit;
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
      if ((await this.state.storage.get(agentLifecycleKey(agentId)))?.deleted_at) {
        return Response.json({ ok: true, state: null });
      }
      const memo = this.memLatest.get(agentId);
      if (memo) return Response.json({ ok: true, state: memo });
      return Response.json({ ok: true, state: await this.state.storage.get(latestStateKey(agentId)) || null });
    }
    if (request.method === 'DELETE' && url.pathname === '/latest') {
      const agentId = sanitizeAgentId(url.searchParams.get('agent_id') || '');
      if (!agentId) return Response.json({ ok: false, error: 'Agent ID 无效' }, { status: 400 });
      await this.markAgentDeleted(agentId);
      this.memLatest.delete(agentId);
      this.latestPersistAt.delete(agentId);
      this.memReports = this.memReports.filter((report) => sanitizeAgentId(String(report?.agent_id || '')) !== agentId);
      await this.state.storage.delete(latestStateKey(agentId));
      for (const socket of this.state.getWebSockets?.(`agent:${agentId}`) || []) {
        try { socket.close?.(1000, 'agent deleted'); } catch (_) {}
      }
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
        sanitizeAgentId(url.searchParams.get('agent_id') || '') || null,
      ));
    }
    if (request.method === 'POST' && url.pathname === '/delete-agent') {
      const agentId = sanitizeAgentId(url.searchParams.get('agent_id') || '');
      if (!agentId) return Response.json({ ok: false, error: 'Agent ID 无效' }, { status: 400 });
      return Response.json(await this.deleteAgentBuffer(agentId));
    }
    if (request.method === 'POST' && url.pathname === '/delete') {
      await this.state.storage.deleteAll();
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  }

  async openAgentMetricsSocket(request) {
    const agentId = sanitizeAgentId(request.headers.get('x-nie-sla-agent-id') || '');
    if (!agentId) return new Response(JSON.stringify({ ok: false, error: '缺少 Agent ID' }), { status: 400, headers: { 'content-type': 'application/json' } });
    const WebSocketPairCtor = globalThis.WebSocketPair;
    if (typeof WebSocketPairCtor !== 'function') return new Response(JSON.stringify({ ok: false, error: 'WebSocket runtime unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
    const lifecycle = await this.openAgentLifecycle(agentId);
    const pair = new WebSocketPairCtor();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ agent_id: agentId, lifecycle_epoch: lifecycle.epoch });
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
      const agentId = sanitizeAgentId(attachment.agent_id || '');
      // The singleton stream instance is shared by the whole fleet: a single
      // misbehaving agent must not be able to flood it. Legitimate agents send
      // one report per report interval plus retries, so allow a bounded burst
      // per window and acknowledge (and drop) anything beyond it instead of
      // wedging the agent with an error.
      if (agentId && !this.allowAgentMessage(agentId)) {
        socket.send(JSON.stringify({ ok: true, type: 'metrics_ack', dropped: true }));
        return;
      }
      const lifecycleEpoch = await this.currentAgentLifecycleEpoch(agentId, attachment.lifecycle_epoch);
      if (lifecycleEpoch == null) {
        socket.close?.(1000, 'agent deleted or superseded');
        return;
      }
      let previousState = null;
      if (agentId) {
        const memo = this.memLatest.get(agentId) || null;
        const stored = await this.state.storage.get(latestStateKey(agentId)) || null;
        previousState = agentStateTimestamp(stored?.updated_at || 0) > agentStateTimestamp(memo?.updated_at || 0) ? stored : memo;
      }
      const result = await processAgentMetricsPayload(this.env, payload, null, attachment.agent_id, {
        previousState,
        skipStateD1: true,
        returnLatestState: true,
        wss: true,
      });
      if (await this.currentAgentLifecycleEpoch(agentId, lifecycleEpoch) !== lifecycleEpoch) {
        socket.close?.(1000, 'agent deleted or superseded');
        return;
      }
      const latestState = result?.latest_state;
      let acceptedState = null;
      if (latestState) {
        const prevTs = agentStateTimestamp(previousState?.updated_at);
        if (agentStateTimestamp(latestState.updated_at) >= prevTs || nowSec() - prevTs > 900) {
          this.memLatest.set(latestState.agent_id || agentId, latestState);
          acceptedState = latestState;
        } else if (previousState) {
          this.memLatest.set(latestState.agent_id || agentId, previousState);
        }
      }
      const reportTs = nowSec();
      this.memReports.push({
        agent_id: agentId,
        lifecycle_epoch: lifecycleEpoch,
        ts: reportTs,
        prev_report_at: previousState?.updated_at || null,
        updated_at: acceptedState?.updated_at || null,
        state: acceptedState,
        points: result?.mapped_points || [],
        pings: result?.mapped_pings || [],
        proxy_checks: result?.mapped_proxy_checks || [],
        net: result?.net || null,
      });
      if (this.memReports.length > MAX_MEM_REPORTS) {
        const dropped = this.memReports.length - MAX_MEM_REPORTS;
        this.memReports.splice(0, dropped);
        console.error(JSON.stringify({ diag: 'mem_reports_cap', dropped, agent_id: agentId }));
      }
      await this.scheduleReportDrain();
      const { latest_state: _latestState, mapped_points: _p, mapped_pings: _q, mapped_proxy_checks: _r, net: _n, ...ack } = result || {};
      const control = await this.readControlSnapshot(agentId);
      const scopedControl = control
        ? { ...control, traffic_correction: control.traffic_corrections?.[agentId] || null, traffic_corrections: undefined }
        : null;
      socket.send(JSON.stringify({ ...ack, ...(scopedControl ? { control: scopedControl } : {}), type: 'metrics_ack' }));
    } catch (error) {
      const status = Number(error?.status || 400);
      socket.send(JSON.stringify({ ok: false, type: 'metrics_ack', error: String(error?.message || 'WS metrics failed'), retryable: status >= 500 }));
    }
  }

  async scheduleReportDrain() {
    const existing = await this.state.storage.getAlarm();
    if (existing != null && existing <= Date.now() + 30_000) return;
    await this.state.storage.setAlarm(Date.now() + 30_000);
  }

  webSocketClose() {}

  webSocketError(_socket, error) {
    console.error('agent metrics websocket error:', String(error?.message || error));
  }

  async alarm() {
    try {
      await this.drainPendingReports();
    } catch (error) {
      console.error('drain pending reports failed:', String(error?.message || error));
      const existing = await this.state.storage.getAlarm();
      const retryAt = Date.now() + 60_000;
      if (existing == null || existing > retryAt) await this.state.storage.setAlarm(retryAt).catch(() => {});
    }
    try {
      await this.flushCompletedHours(nowSec());
    } catch (error) {
      console.error('flush completed hours failed:', String(error?.message || error));
      const existing = await this.state.storage.getAlarm();
      const retryAt = Date.now() + 5 * 60 * 1000;
      if (existing == null || existing > retryAt) await this.state.storage.setAlarm(retryAt).catch(() => {});
    }
  }

  async drainPendingReports() {
    if (!this.memReports.length) return 0;
    const reports = this.memReports.splice(0, this.memReports.length);
    reports.sort((a, b) => a.ts - b.ts);
    const groups = new Map();
    for (const report of reports) {
      const id = sanitizeAgentId(String(report.agent_id || ''));
      if (!id) continue;
      const group = groups.get(id) || [];
      group.push(report);
      groups.set(id, group);
    }
    const noPublicIpAgents = await this.loadNoPublicIpAgents([...groups.keys()]);
    const failures = [];
    let drained = 0;
    for (const [agentId, group] of groups) {
      const lifecycleEpoch = Number(group[0]?.lifecycle_epoch || 0) || null;
      if (await this.currentAgentLifecycleEpoch(agentId, lifecycleEpoch) == null) {
        drained += group.length;
        continue;
      }
      const drainState = (item) => {
        if (!item.__drainState) item.__drainState = {};
        return item.__drainState;
      };
      let groupFailed = false;
      const newestReport = group.reduce((latest, item) => (
        item.state && (!latest || agentStateTimestamp(item.state.updated_at) > agentStateTimestamp(latest.state?.updated_at)) ? item : latest
      ), null);
      if (newestReport?.state && !drainState(newestReport).latestStatePersisted) {
        try {
          await this.persistLatestState(agentId, newestReport.state);
          drainState(newestReport).latestStatePersisted = true;
        } catch (error) {
          groupFailed = true;
          console.error('persist latest agent state failed:', String(error?.message || error));
        }
      }
      try {
        const points = group.flatMap(item => item.points || []);
        const pings = group.flatMap(item => item.pings || []);
        const proxyChecks = group.flatMap(item => item.proxy_checks || []);
        if ((points.length || pings.length || proxyChecks.length) && !group.every(item => drainState(item).telemetryAppended)) {
          await this.ensureLegacyBufferMigrated(agentId);
          await this.appendLocal({ agent_id: agentId, points, pings, proxy_checks: proxyChecks });
          for (const item of group) drainState(item).telemetryAppended = true;
        }
      } catch (error) {
        console.error('drain buffered agent reports failed:', String(error?.message || error));
        failures.push(...group);
        continue;
      }
      if ((noPublicIpAgents.get(agentId) || 0) === 1 && group[0].prev_report_at && !drainState(group[0]).availabilityPersisted) {
        const lastAt = group[group.length - 1].ts;
        try {
          await recordAgentAvailability(this.env, agentId, group[0].prev_report_at, lastAt);
          drainState(group[0]).availabilityPersisted = true;
        } catch (error) {
          groupFailed = true;
          console.error('record agent availability failed:', String(error?.message || error));
        }
      }
      for (const item of group) {
        if (item.net && !drainState(item).trafficPersisted) {
          try {
            await persistAgentTraffic(this.env, agentId, { net: item.net }, item.ts);
            drainState(item).trafficPersisted = true;
          } catch (error) {
            groupFailed = true;
            console.error('replay agent traffic failed:', String(error?.message || error));
          }
        }
      }
      const latestItem = group.reduce((latest, item) => (
        item.state && (!latest || agentStateTimestamp(item.state.updated_at) > agentStateTimestamp(latest.state?.updated_at)) ? item : latest
      ), null);
      if (latestItem?.state && !drainState(latestItem).latestStatePersisted) {
        try {
          await this.persistLatestState(agentId, latestItem.state);
          drainState(latestItem).latestStatePersisted = true;
        } catch (error) {
          groupFailed = true;
          console.error('persist latest agent state failed:', String(error?.message || error));
        }
      }
      if (groupFailed) {
        failures.push(...group);
        continue;
      }
      drained += group.length;
    }
    if (failures.length) {
      this.memReports = [...failures, ...this.memReports];
      if (this.memReports.length > MAX_MEM_REPORTS) {
        this.memReports = this.memReports.slice(this.memReports.length - MAX_MEM_REPORTS);
      }
      const existing = await this.state.storage.getAlarm();
      const retryAt = Date.now() + 60_000;
      if (existing == null || existing > retryAt) await this.state.storage.setAlarm(retryAt);
    }
    if (drained > 0) console.log(JSON.stringify({ diag: 'drain', drained, failCount: failures.length, agents: groups.size }));
    return drained;
  }

  async persistLatestState(agentId, state) {
    const now = nowSec();
    if (now - Number(this.latestPersistAt.get(agentId) || 0) < LATEST_PERSIST_THROTTLE_SEC) return;
    this.latestPersistAt.set(agentId, now);
    await this.state.storage.put(latestStateKey(agentId), state);
    // When the buffered-state architecture is active the DO storage is the
    // authoritative copy and read paths merge it in; the D1 mirror only exists
    // for deployments that keep AGENT_METRICS_STATE_TO_D1 enabled (or when no
    // TelemetryBuffer is bound). Writing it unconditionally was the second
    // largest D1 write source at scale.
    if (!bufferedAgentStateEnabled(this.env)) {
      await persistAgentMetricsStateFallback(this.env, { ...state, updated_at: new Date(now * 1000).toISOString() });
    }
  }

  async openAgentLifecycle(agentId) {
    const key = agentLifecycleKey(agentId);
    const current = await this.state.storage.get(key);
    if (current?.deleted_at) {
      const lifecycle = { epoch: (Number(current.epoch) || 0) + 1, deleted_at: null, opened_at: nowSec() };
      await this.state.storage.put(key, lifecycle);
      return lifecycle;
    }
    if (current && Number(current.epoch) > 0) return current;
    const lifecycle = { epoch: 1, deleted_at: null, opened_at: nowSec() };
    await this.state.storage.put(key, lifecycle);
    return lifecycle;
  }

  async markAgentDeleted(agentId) {
    const key = agentLifecycleKey(agentId);
    const current = await this.state.storage.get(key);
    await this.state.storage.put(key, {
      epoch: (Number(current?.epoch) || 0) + 1,
      deleted_at: nowSec(),
    });
  }

  async currentAgentLifecycleEpoch(agentId, expectedEpoch = null) {
    if (!agentId) return null;
    const current = await this.state.storage.get(agentLifecycleKey(agentId));
    if (current?.deleted_at) return null;
    if (!current) return Number(expectedEpoch || 0) || 0;
    const epoch = Number(current?.epoch || expectedEpoch || 0) || 0;
    if (!epoch) return null;
    if (expectedEpoch != null && Number(expectedEpoch) > 0 && epoch !== Number(expectedEpoch)) return null;
    return epoch;
  }

  async loadNoPublicIpAgents(agentIds) {
    const map = new Map();
    if (!this.env.DB || !agentIds.length) return map;
    for (let offset = 0; offset < agentIds.length; offset += 90) {
      const chunk = agentIds.slice(offset, offset + 90);
      try {
        const rows = await this.env.DB.prepare(`SELECT id FROM targets WHERE no_public_ip = 1 AND id IN (${chunk.map(() => '?').join(',')})`)
          .bind(...chunk).all();
        for (const row of rows.results || []) map.set(String(row.id), 1);
      } catch (error) {
        console.error('load no-public-ip targets failed:', String(error?.message || error));
      }
    }
    return map;
  }

  async append(body) {
    const agentId = sanitizeAgentId(body?.agent_id);
    if (!agentId) throw new Error('Agent ID 无效');
    await this.ensureLegacyBufferMigrated(agentId);
    const result = await this.appendLocal(body);
    if (result?.skipped) return result;
    await this.scheduleFlush();
    await this.flushCompletedHours(nowSec());
    return result;
  }

  // One shared stream instance owns every Agent's live buffer so WSS drains do
  // not cost an extra Durable Object request per Agent report. Chunks are keyed
  // by Agent, so this local write replaces the former per-Agent DO fetch while
  // keeping the same five-minute merge semantics.
  async appendLocal(body) {
    const agentId = sanitizeAgentId(body?.agent_id);
    if (!agentId) throw new Error('Agent ID 无效');
    const grouped = groupByChunk(body?.points, body?.pings, body?.proxy_checks);
    if (!grouped.size) return { ok: true, skipped: true, chunks: 0 };

    await this.state.storage.transaction(async (txn) => {
      for (const [chunk, incoming] of grouped) {
        const key = chunkKey(agentId, chunk);
        const existing = await txn.get(key) || emptyBuffer(agentId, chunk);
        await txn.put(key, compactBuffer(mergeBuffer(existing, incoming, agentId, chunk, CHUNK_SEC)));
      }
    });
    return { ok: true, agent_id: agentId, chunks: grouped.size };
  }

  // Existing installs still hold the current hour of points in their former
  // per-Agent buffer DO. Migrate that data once per Agent on first use so live
  // reads never lose the transition window.
  async ensureLegacyBufferMigrated(rawAgentId) {
    const agentId = sanitizeAgentId(rawAgentId);
    if (!agentId || !this.env.TELEMETRY_BUFFER) return;
    if (String(this.state?.id?.name || '') !== AGENT_METRICS_STREAM_INSTANCE) return;
    if (this.migratedAgents.has(agentId)) return;
    const flagKey = `migrated:${agentId}`;
    try {
      if (await this.state.storage.get(flagKey)) {
        this.migratedAgents.add(agentId);
        return;
      }
    } catch (_) {}
    try {
      const legacy = this.env.TELEMETRY_BUFFER.get(this.env.TELEMETRY_BUFFER.idFromName(`agent:${agentId}`));
      const response = await legacy.fetch('https://nie-sla.internal/read?since=0', { headers: internalRequestHeaders(this.env) });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        const points = Array.isArray(body?.points) ? body.points : [];
        const pings = Array.isArray(body?.pings) ? body.pings : [];
        const proxyChecks = Array.isArray(body?.proxy_checks) ? body.proxy_checks : [];
        if (points.length || pings.length || proxyChecks.length) {
          await this.appendLocal({ agent_id: agentId, points, pings, proxy_checks: proxyChecks });
        }
        await legacy.fetch('https://nie-sla.internal/delete', { method: 'POST', headers: internalRequestHeaders(this.env) }).catch(() => {});
      }
    } catch (error) {
      console.error('telemetry buffer migration deferred:', String(error?.message || error));
      return;
    }
    await this.state.storage.put(flagKey, nowSec()).catch(() => {});
    this.migratedAgents.add(agentId);
  }

  async deleteAgentBuffer(rawAgentId) {
    const agentId = sanitizeAgentId(rawAgentId);
    if (!agentId) return { ok: false, error: 'Agent ID 无效' };
    let deleted = 0;
    const prefix = `${CHUNK_PREFIX}${agentId}:`;
    for (const [key] of await this.listStorageEntries(prefix)) {
      await this.state.storage.delete(key);
      deleted += 1;
    }
    for (const [key, value] of await this.listStorageEntries(EXPORT_PREFIX)) {
      if (sanitizeAgentId(value?.agent_id) !== agentId) continue;
      await this.state.storage.delete(key);
      deleted += 1;
    }
    await this.state.storage.delete(`migrated:${agentId}`).catch(() => {});
    this.migratedAgents.delete(agentId);
    return { ok: true, agent_id: agentId, deleted };
  }

  async readFleetLatestStates() {
    const rows = await this.listStorageEntries(LATEST_STATE_PREFIX);
    const states = {};
    for (const [key, value] of rows) {
      const agentId = sanitizeAgentId(String(key).slice(LATEST_STATE_PREFIX.length));
      if (agentId && value && typeof value === 'object' && !Array.isArray(value)) states[agentId] = value;
    }
    // Storage persists latest states at most once per LATEST_PERSIST_THROTTLE_SEC,
    // so fleet readers (status snapshot, alerts, admin) could briefly see an
    // older row while this instance already holds a fresher report in memory.
    // In-memory states are never older than their persisted copy: overlay them.
    for (const [key, value] of this.memLatest || []) {
      const agentId = sanitizeAgentId(value?.agent_id || key);
      if (!agentId || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const current = states[agentId];
      if (!current || agentStateTimestamp(value.updated_at) >= agentStateTimestamp(current.updated_at)) {
        states[agentId] = value;
      }
    }
    return { ok: true, states };
  }

  async readControlSnapshot(agentId = '') {
    const scopedAgentId = sanitizeAgentId(agentId);
    const now = nowSec();
    const cacheKey = scopedAgentId ? `control:ping:${scopedAgentId}` : 'control:ping';
    const cached = await this.state.storage.get(cacheKey);
    const ttl = Math.max(60, Math.min(3600, Number(this.env.PROBE_CONTROL_CACHE_SEC || 300)));
    const materialize = async (internal) => {
      if (!internal) return null;
      const { proxy_targets_internal: _proxyRows, ...control } = internal;
      let proxyTargets = [];
      try {
        proxyTargets = await getCachedProxyControl(this.env, _proxyRows || [], scopedAgentId);
      } catch (error) {
        console.error('read WSS proxy control failed:', String(error?.message || error));
      }
      return {
        ...control,
        proxy_targets: proxyTargets,
        proxy_canary_host: String(this.env.PROXY_CANARY_HOST || 'example.com').trim() || 'example.com',
        proxy_canary_port: Math.max(1, Math.min(65535, Number(this.env.PROXY_CANARY_PORT || 443) || 443)),
      };
    };
    if (cached?.control && Number(cached.fetched_at || 0) + ttl > now) return materialize(cached.control);
    try {
      const rows = await this.env.DB?.prepare(`SELECT id, target, enabled FROM ping_targets WHERE enabled = 1 ORDER BY name LIMIT 500`).all();
      const targets = (rows?.results || []).map(row => ({
        id: String(row.id || '').slice(0, 128),
        target: String(row.target || '').slice(0, 2048),
        enabled: Number(row.enabled || 0) === 1,
        protocol: pingTargetProtocol(row.target),
      })).filter(row => row.id && row.target && ['tcp', 'http'].includes(row.protocol));
      let trafficCorrections = {};
      try {
        const rows = await this.env.DB.prepare(`SELECT key, value FROM app_meta WHERE key LIKE 'traffic_corr:%'`).all();
        for (const row of rows.results || []) {
          try {
            trafficCorrections[String(row.key).slice('traffic_corr:'.length)] = JSON.parse(row.value);
          } catch (_) {}
        }
      } catch (_) {}
      let proxyTargetsInternal = [];
      try {
        proxyTargetsInternal = await getProxyControlRows(this.env, scopedAgentId);
      } catch (_) {
        // The proxy tables are additive; keep existing Agent control working
        // while an older database is being upgraded or has no proxy targets.
      }
      const reportInterval = await getAgentReportInterval(this.env);
      const control = { ping_interval_sec: await getPingIntervalSec(this.env), ping_targets: targets, proxy_targets_internal: proxyTargetsInternal, traffic_corrections: trafficCorrections, report_interval_sec: reportInterval };
      await this.state.storage.put(cacheKey, { fetched_at: now, control });
      return materialize(control);
    } catch (error) {
      console.error('read WSS control snapshot failed:', String(error?.message || error));
      return materialize(cached?.control || null);
    }
  }

  async read(since, until, rawAgentId = null) {
    const start = Number.isFinite(since) ? Math.floor(since) : 0;
    const end = Number.isFinite(until) ? Math.floor(until) : nowSec();
    const scopedAgentId = rawAgentId ? sanitizeAgentId(rawAgentId) : null;
    if (scopedAgentId) await this.ensureLegacyBufferMigrated(scopedAgentId).catch(() => {});
    const rows = await this.bufferRows();
    const points = [];
    const pings = [];
    const proxyChecks = [];
    for (const value of rows.values()) {
      if (scopedAgentId && sanitizeAgentId(value?.agent_id) !== scopedAgentId) continue;
      for (const point of bufferPoints(value)) {
        const ts = Number(point?.ts || 0);
        if (ts >= start && ts <= end) points.push(point);
      }
      for (const ping of bufferPings(value)) {
        const ts = Number(ping?.ts || 0);
        if (ts >= start && ts <= end) pings.push(ping);
      }
      for (const check of bufferProxyChecks(value)) {
        const ts = Number(check?.ts || 0);
        if (ts >= start && ts <= end) proxyChecks.push(check);
      }
    }
    points.sort((a, b) => Number(a.ts) - Number(b.ts));
    pings.sort((a, b) => Number(a.ts) - Number(b.ts) || String(a.target_id).localeCompare(String(b.target_id)));
    proxyChecks.sort((a, b) => Number(a.ts) - Number(b.ts) || String(a.target_id).localeCompare(String(b.target_id)));
    return { ok: true, points, pings, proxy_checks: proxyChecks };
  }

  async flushCompletedHours(currentAt) {
    const flushInterval = telemetryFlushIntervalSec(this.env);
    const flushBefore = Number(currentAt) - FLUSH_GRACE_SEC;
    const rows = await this.bufferRows();
    const completed = new Map();
    for (const [key, value] of rows) {
      const start = bufferedStart(key);
      const hour = hourStart(start);
      const agentId = sanitizeAgentId(value?.agent_id);
      if (!agentId || !Number.isFinite(start) || hour + flushInterval > flushBefore) continue;
      const groupKey = `${agentId}|${hour}`;
      const item = completed.get(groupKey) || { agentId, hour, keys: [], buffers: [] };
      item.keys.push(key);
      item.buffers.push(value);
      completed.set(groupKey, item);
    }
    let retry = false;
    for (const item of completed.values()) {
      try {
        let merged = emptyBuffer(item.agentId, item.hour);
        for (const value of item.buffers) merged = mergeBuffer(merged, value, item.agentId, item.hour, HOUR_SEC);
        await flushHour(this.env, merged);
        await this.queueExport(item.agentId, item.hour);
        for (const key of item.keys) await this.state.storage.delete(key);
      } catch (error) {
        retry = true;
        console.error('telemetry buffer flush failed:', String(error?.message || error));
      }
    }
    await this.flushPendingExports(currentAt);
    if (retry) await this.scheduleAlarmIfSooner(5 * 60 * 1000);
    else if ((await this.bufferRows(1)).size) await this.scheduleFlush();
  }

  async queueExport(rawAgentId, hour) {
    if (!timeseriesExportEnabled(this.env)) return;
    const agentId = sanitizeAgentId(rawAgentId);
    const key = `${EXPORT_PREFIX}${agentId}:${hourStart(hour)}`;
    const current = normalizeExportAttempt(await this.state.storage.get(key));
    await this.state.storage.put(key, { agent_id: agentId, hour: hourStart(hour), ...current });
  }

  async flushPendingExports(currentAt) {
    if (!timeseriesExportEnabled(this.env)) return;
    const rows = await this.listStorageEntries(EXPORT_PREFIX);
    let retry = false;
    for (const [key, value] of rows) {
      const hour = hourStart(value?.hour || String(key).slice(String(key).lastIndexOf(':') + 1));
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
    if (retry) await this.scheduleAlarmIfSooner(5 * 60 * 1000);
  }

  async scheduleAlarmIfSooner(delayMs) {
    const at = Date.now() + delayMs;
    const existing = await this.state.storage.getAlarm();
    if (existing == null || existing > at) await this.state.storage.setAlarm(at);
  }

  async scheduleFlush() {
    const flushInterval = telemetryFlushIntervalSec(this.env);
    const alarmAt = (hourStart(nowSec()) + flushInterval + FLUSH_GRACE_SEC + 30) * 1000;
    const current = await this.state.storage.getAlarm();
    if (current == null || current > alarmAt) await this.state.storage.setAlarm(alarmAt);
  }

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
  if (bytes[0] === 0x7b || bytes[0] === 0x5b) return parseJsonMessage(new TextDecoder().decode(bytes));
  return decodeAgentMetricsProtobuf(bytes);
}

export async function appendBufferedAgentTelemetry(env, agentId, points, pings, proxyChecks = []) {
  if (!env.TELEMETRY_BUFFER) return null;
  const id = sanitizeAgentId(agentId);
  const stub = env.TELEMETRY_BUFFER.get(env.TELEMETRY_BUFFER.idFromName(AGENT_METRICS_STREAM_INSTANCE));
  const response = await stub.fetch('https://nie-sla.internal/append', {
    method: 'POST',
    headers: internalRequestHeaders(env),
    body: JSON.stringify({ agent_id: id, points, pings, proxy_checks: proxyChecks }),
  });
  if (!response.ok) throw new Error(`遥测缓冲写入失败：HTTP ${response.status}`);
  return response.json();
}

export async function readBufferedAgentTelemetry(env, agentId, since, until) {
  if (!env.TELEMETRY_BUFFER) return { points: [], pings: [], proxy_checks: [] };
  const id = sanitizeAgentId(agentId);
  const stub = env.TELEMETRY_BUFFER.get(env.TELEMETRY_BUFFER.idFromName(AGENT_METRICS_STREAM_INSTANCE));
  const url = new URL('https://nie-sla.internal/read');
  url.searchParams.set('agent_id', id);
  url.searchParams.set('since', String(Math.floor(Number(since) || 0)));
  url.searchParams.set('until', String(Math.floor(Number(until) || nowSec())));
  const response = await stub.fetch(url.toString(), { headers: internalRequestHeaders(env) });
  if (!response.ok) return { points: [], pings: [], proxy_checks: [] };
  const body = await response.json().catch(() => ({}));
  return {
    points: Array.isArray(body?.points) ? body.points : [],
    pings: Array.isArray(body?.pings) ? body.pings : [],
    proxy_checks: Array.isArray(body?.proxy_checks) ? body.proxy_checks : [],
  };
}

export async function readBufferedAgentLatestState(env, agentId) {
  if (!env.TELEMETRY_BUFFER) return null;
  const id = sanitizeAgentId(agentId);
  if (!id) return null;
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
  await deleteBufferedAgentLatestState(env, id);
  const url = new URL('https://nie-sla.internal/delete-agent');
  url.searchParams.set('agent_id', id);
  const stub = env.TELEMETRY_BUFFER.get(env.TELEMETRY_BUFFER.idFromName(AGENT_METRICS_STREAM_INSTANCE));
  const response = await stub.fetch(url.toString(), { method: 'POST', headers: internalRequestHeaders(env) });
  if (!response.ok) throw new Error(`遥测缓冲删除失败：HTTP ${response.status}`);
  return response.json();
}

function groupByChunk(points, pings, proxyChecks) {
  const grouped = new Map();
  const bucket = (ts) => {
    const chunk = chunkStart(ts);
    const value = grouped.get(chunk) || { points: [], pings: [], proxy_checks: [] };
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
  for (const check of Array.isArray(proxyChecks) ? proxyChecks : []) {
    const ts = Number(check?.ts || 0);
    if (ts > 0 && check?.target_id) bucket(ts).proxy_checks.push(check);
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
  const byProxyCheck = new Map();
  for (const check of [...bufferProxyChecks(existing), ...bufferProxyChecks(incoming)]) {
    const ts = Number(check?.ts || 0);
    const targetId = String(check?.target_id || '');
    if (targetId && ts >= start && ts < start + duration) byProxyCheck.set(`${targetId}:${ts}`, check);
  }
  return {
    schema: duration === CHUNK_SEC ? 'nie-sla-telemetry-buffer-v2' : 'nie-sla-telemetry-buffer-v1',
    agent_id: agentId,
    chunk: start,
    hour: hourStart(start),
    points: [...byPoint.values()].sort((a, b) => Number(a.ts) - Number(b.ts)),
    pings: [...byPing.values()].sort((a, b) => Number(a.ts) - Number(b.ts) || String(a.target_id).localeCompare(String(b.target_id))),
    proxy_checks: [...byProxyCheck.values()].sort((a, b) => Number(a.ts) - Number(b.ts) || String(a.target_id).localeCompare(String(b.target_id))),
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
    proxy_checks: proxyChecksFromPayload(existing?.proxy_checks),
  }, buffered, agentId, hour, HOUR_SEC);
  const dayHour = utcDayHour(hour);
  const { body, bytes, encoding } = await encodeJsonBody({
    schema: 'nie-sla-agent-telemetry-hour-v1',
    agent_id: agentId,
    day: dayHour.day,
    hour: dayHour.hour,
    updated_at: new Date().toISOString(),
    metrics: { schema: 'nie-sla-agent-metrics-hour-v2', series: metricPointsToColumns(merged.points) },
    pings: { schema: 'nie-sla-agent-pings-hour-v2', series: pingPointsToSeries(merged.pings) },
    proxy_checks: { schema: 'nie-sla-proxy-checks-hour-v1', series: proxyChecksToSeries(merged.proxy_checks) },
  });
  await env.ARCHIVE.put(key, body, {
    httpMetadata: httpMetadataFor(encoding),
    customMetadata: { schema: 'nie-sla-agent-telemetry-hour-v1', agent_id: agentId, day: dayHour.day, hour: dayHour.hour, encoding: encoding || 'none' },
  });
  if (typeof env.ARCHIVE.head === 'function') {
    const verify = await env.ARCHIVE.head(key);
    if (!verify) throw new Error(`R2 telemetry hour write did not persist (${agentId} ${dayHour.day}/${dayHour.hour})`);
    if (Number.isFinite(Number(verify.size)) && Number(verify.size) !== bytes) throw new Error(`R2 telemetry hour size mismatch (${agentId} ${dayHour.day}/${dayHour.hour} expected ${bytes}, got ${verify.size})`);
  }
  const persisted = await readR2Object(env.ARCHIVE, key);
  if (persisted?.schema !== 'nie-sla-agent-telemetry-hour-v1'
    || String(persisted.agent_id || '') !== agentId
    || String(persisted.day || '') !== dayHour.day
    || String(persisted.hour || '') !== dayHour.hour
    || !persisted.metrics || !persisted.pings || !persisted.proxy_checks) {
    throw new Error(`R2 telemetry hour readback validation failed (${agentId} ${dayHour.day}/${dayHour.hour})`);
  }
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
  return { agent_id: agentId, chunk: start, hour: hourStart(start), points: [], pings: [], proxy_checks: [] };
}

function compactBuffer(buffer) {
  return {
    schema: 'nie-sla-telemetry-buffer-v2',
    agent_id: buffer.agent_id,
    chunk: buffer.chunk,
    hour: buffer.hour,
    metric_series: metricPointsToColumns(buffer.points),
    ping_series: pingPointsToSeries(buffer.pings),
    proxy_check_series: proxyChecksToSeries(buffer.proxy_checks),
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

function bufferProxyChecks(value) {
  if (Array.isArray(value?.proxy_checks)) return value.proxy_checks;
  return proxyChecksFromPayload({ series: value?.proxy_check_series });
}

function chunkKey(agentId, chunk) {
  return `${CHUNK_PREFIX}${sanitizeAgentId(agentId)}:${chunkStart(chunk)}`;
}

function bufferedStart(key) {
  const text = String(key);
  if (!text.startsWith(CHUNK_PREFIX) && !text.startsWith(LEGACY_BUFFER_PREFIX)) return NaN;
  return Number(text.slice(text.lastIndexOf(':') + 1));
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

function proxyChecksToSeries(checks) {
  const grouped = new Map();
  for (const check of checks || []) {
    const targetId = String(check?.target_id || '');
    if (!targetId) continue;
    const list = grouped.get(targetId) || [];
    list.push(check);
    grouped.set(targetId, list);
  }
  return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([targetId, list]) => {
    list.sort((a, b) => Number(a.ts) - Number(b.ts));
    const t0 = Number(list[0]?.ts || 0);
    return {
      target_id: targetId,
      name: String(list[0]?.name || targetId).slice(0, 96),
      protocol: String(list[0]?.protocol || '').slice(0, 24),
      t0,
      dt: list.map(check => Number(check.ts) - t0),
      latency_ms: list.map(check => check.latency_ms == null ? null : Number(check.latency_ms)),
      handshake_ms: list.map(check => check.handshake_ms == null ? null : Number(check.handshake_ms)),
      first_byte_ms: list.map(check => check.first_byte_ms == null ? null : Number(check.first_byte_ms)),
      total_ms: list.map(check => check.total_ms == null ? null : Number(check.total_ms)),
      ok: list.map(check => Number(check.ok || 0)),
      stage: list.map(check => String(check.stage || '').slice(0, 32)),
      error: list.map(check => check.error == null ? null : String(check.error).slice(0, 64)),
    };
  });
}

function proxyChecksFromPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.checks)) return payload.checks;
  if (!Array.isArray(payload.series)) return [];
  const out = [];
  for (const series of payload.series) {
    const targetId = String(series?.target_id || '');
    const t0 = Number(series?.t0 || 0);
    if (!targetId || !t0) continue;
    const dt = Array.isArray(series.dt) ? series.dt : [];
    for (let index = 0; index < dt.length; index += 1) {
      out.push({
        target_id: targetId,
        name: String(series.name || targetId),
        protocol: String(series.protocol || ''),
        ts: t0 + Number(dt[index] || 0),
        latency_ms: series.latency_ms?.[index] == null ? null : Number(series.latency_ms[index]),
        handshake_ms: series.handshake_ms?.[index] == null ? null : Number(series.handshake_ms[index]),
        first_byte_ms: series.first_byte_ms?.[index] == null ? null : Number(series.first_byte_ms[index]),
        total_ms: series.total_ms?.[index] == null ? null : Number(series.total_ms[index]),
        ok: Number(series.ok?.[index] || 0),
        stage: String(series.stage?.[index] || ''),
        error: series.error?.[index] == null ? null : String(series.error[index]),
      });
    }
  }
  return out;
}

function utcDayHour(ts) {
  const iso = new Date(hourStart(ts) * 1000).toISOString();
  return { day: iso.slice(0, 10), hour: iso.slice(11, 13) };
}
