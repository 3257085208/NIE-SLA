import { enrichCfContext, probeTarget, saveCheck, runDueTargets, runFastStatusTargets } from './probe.js';
import { writeStatusSnapshot } from './status.js';
import { archiveYesterdayOncePerLocalDay, cleanupDebugLogs, cleanupFinishedAgentTasks, cleanupOldCheckBuckets, cleanupVolatileHistory, ensureV6Schema, getExchangeRates } from './admin.js';
import { cleanupRateLimitsD1 } from './ratelimit.js';
import { cleanupAgentMetricsR2 } from './metrics.js';
import { runAlertChecks } from './alerts.js';
import { handleRequest } from './routes.js';
import { constantTimeEqual, internalRequestAuthorized, internalRequestHeaders, internalScheduleSecret, json } from './auth.js';
import { clamp, parseBoolean, shouldRunScheduledFollowups } from './utils.js';
import { routeStaticAssets } from './static-assets.js';
import { publishStatusEvents } from './status-stream.js';
export { TelemetryBuffer } from './telemetry-buffer.js';
export { ProbeHistoryBuffer } from './probe-history-buffer.js';
export { StatusStream } from './status-stream.js';

const INTERNAL_SCHEDULE_PATH = '/api/internal/scheduled';



export class ProbeRegion {
  constructor(state, env) { this.state = state; this.env = env; this.scheduledRun = null; }

  async fetch(request) {
    if (request.method !== 'POST') return json({ ok: false, error: '不支持该请求方法' }, 405);
    if (!internalRequestAuthorized(request, this.env)) return json({ ok: false, error: '未授权' }, 401, this.env);
    const url = new URL(request.url);
    if (url.pathname === '/scheduled') {
      const expected = internalScheduleSecret(this.env);
      const presented = String(request.headers.get('x-nie-sla-internal-secret') || request.headers.get('x-nstatus-internal-secret') || '');
      if (!expected || !constantTimeEqual(expected, presented)) return json({ ok: false, error: '未授权' }, 401, this.env);
      const body = await request.json().catch(() => ({}));
      if (this.scheduledRun) return json({ ok: true, skipped: true, reason: 'scheduled_run_in_progress' }, 200, this.env);
      this.scheduledRun = runScheduledTasks(this.env, String(body.cron || '* * * * *'), { serialized: true });
      try { return json(await this.scheduledRun, 200, this.env); }
      finally { this.scheduledRun = null; }
    }
    if (url.pathname === '/debug-colo') {
      const meta = await request.json().catch(() => ({}));
      const cf = await enrichCfContext(request.cf || {}, this.env);
      return json({ ok: true, region: meta.region || null, version: meta.version || null, objectName: meta.objectName || null, colo: cf.colo, echo_colo: cf.echo_colo, trace_colo: null, request_colo: cf.request_colo });
    }
    const body = await request.json();
    if (url.pathname === '/batch-probe-and-save') return json(await this.batchProbeAndSave(body, request.cf || {}), 200, this.env);
    if (url.pathname === '/batch-current-status') return json(await this.batchProbeCurrentStatus(body, request.cf || {}), 200, this.env);
    const target = body?.target || body;
    const checkedAt = Number(body?.checked_at || Math.floor(Date.now() / 1000));
    const result = await probeTarget(target, await enrichCfContext(request.cf || {}, this.env));
    if (url.pathname === '/probe-and-save') {
      const saved = await saveCheck(this.env, target, checkedAt, result, body?.previous || null);
      return json({ target_id: target.id, name: target.name, ...result, saved, state_update: saved.state_update });
    }
    return json(result);
  }

  async batchProbeAndSave(body, cf = {}) {
    const targets = Array.isArray(body?.targets) ? body.targets : [];
    const previous = body?.previous && typeof body.previous === 'object' && !Array.isArray(body.previous) ? body.previous : {};
    const checkedAt = Number(body?.checked_at || Math.floor(Date.now() / 1000));
    const concurrency = clamp(Number(this.env.CONCURRENCY || 20), 1, 40);
    const results = [];
    for (let i = 0; i < targets.length; i += concurrency) {
      const chunk = targets.slice(i, i + concurrency);
      const settled = await Promise.allSettled(chunk.map(async (target) => {
        const result = await probeTarget(target, await enrichCfContext(cf, this.env));
        const saved = await saveCheck(this.env, target, checkedAt, result, previous[target.id] || null);
        return { target_id: target.id, name: target.name, ...result, saved, state_update: saved.state_update };
      }));
      for (let index = 0; index < settled.length; index += 1) {
        const item = settled[index];
        if (item.status === 'fulfilled') results.push(item.value);
        else results.push(batchFailure(chunk[index], item.reason));
      }
    }
    return { ok: true, count: results.length, results };
  }

  async batchProbeCurrentStatus(body, cf = {}) {
    const targets = Array.isArray(body?.targets) ? body.targets : [];
    const concurrency = clamp(Number(this.env.CONCURRENCY || 20), 1, 40);
    const results = [];
    for (let i = 0; i < targets.length; i += concurrency) {
      const chunk = targets.slice(i, i + concurrency);
      const settled = await Promise.allSettled(chunk.map(async (target) => {
        const result = await probeTarget(target, await enrichCfContext(cf, this.env));
        return { target_id: target.id, name: target.name, ...result };
      }));
      for (let index = 0; index < settled.length; index += 1) {
        const item = settled[index];
        if (item.status === 'fulfilled') results.push(item.value);
        else results.push(batchFailure(chunk[index], item.reason));
      }
    }
    return { ok: true, count: results.length, results };
  }
}

function batchFailure(target, reason) {
  return {
    ok: false,
    target_id: target?.id ?? null,
    name: target?.name || null,
    error: String(reason?.message || reason),
  };
}



export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (url.pathname === INTERNAL_SCHEDULE_PATH) return handleInternalScheduledRequest(request, env);
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') {
        const assetResponse = await routeStaticAssets(request, env);
        if (assetResponse) return assetResponse;
      }
      return await handleRequest(request, env, ctx);
    }
    catch (err) {
      const status = err?.status || 500;
      const message = status === 500 ? '服务器内部错误' : String(err?.message || '请求失败');
      return json({ ok: false, error: message }, status, env, err?.headers || null);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(dispatchScheduledTasks(env, controller.cron));
  },
};

export async function runScheduledTasks(env, cron, options = {}) {
  const results = {};
  const timings = {};
  const measure = async (name, task) => {
    const started = Date.now();
    try { return await task(); }
    finally { timings[name] = Date.now() - started; }
  };
  try { await ensureV6Schema(env); } catch (err) { results.schema_error = String(err?.message || err); }


  try { results.probe = await measure('probe', () => runDueTargets(env, { skipLease: options.serialized === true })); } catch (err) { results.probe_error = String(err?.message || err); }
  if (results.probe_error || shouldRunScheduledFollowups(results.probe)) {
    try { await recordProbeResult(env, cron, results.probe, results.probe_error, timings.probe); } catch (_) {}
  }
  const historyProbeCount = Number(results.probe?.count || 0);
  if (historyProbeCount > 0) {
    results.fast_status = { ok: true, skipped: true, reason: 'history_probe_completed', count: 0 };
  } else {
    try { results.fast_status = await measure('fast_status', () => runFastStatusTargets(env, { skipLease: options.serialized === true })); } catch (err) { results.fast_status_error = String(err?.message || err); }
  }
  const statusEvents = [...(results.probe?.events || []), ...(results.fast_status?.events || [])];
  if (statusEvents.length) {
    try { results.status_stream = await measure('status_stream', () => publishStatusEvents(env, statusEvents)); } catch (err) {
      results.status_stream_error = String(err?.message || err);
    }
  }
  const hasCurrentStatus = historyProbeCount > 0 || Number(results.fast_status?.count || 0) > 0;
  if (!shouldRunScheduledFollowups(results.probe) && !hasCurrentStatus) {
    results.followups = { ok: true, skipped: true, reason: results.probe_error ? 'probe_failed' : 'no_targets_due' };
    results.timings_ms = timings;
    if (results.probe_error || results.fast_status_error) {
      try { await recordScheduledResult(env, cron, results); } catch (_) {}
    }
    return results;
  }
  try { results.alerts = await measure('alerts', () => runAlertChecks(env)); } catch (err) { results.alerts_error = String(err?.message || err); }
  try { results.status_snapshot = await measure('status_snapshot', () => writeStatusSnapshot(env)); } catch (err) { results.status_snapshot_error = String(err?.message || err); }
  let runHourlyMaintenance = false;
  try { runHourlyMaintenance = await claimHourlyMaintenanceSlot(env, cron); } catch (err) { results.hourly_claim_error = String(err?.message || err); }
  if (runHourlyMaintenance) {
    try { results.exchange_rates = await measure('exchange_rates', async () => ({ ok: Boolean(await getExchangeRates(env)) })); } catch (err) { results.exchange_rates_error = String(err?.message || err); }
    try { results.volatile_cleanup = await measure('volatile_cleanup', () => cleanupVolatileHistory(env)); } catch (err) { results.volatile_cleanup_error = String(err?.message || err); }
    try { results.rate_limit_cleanup = await measure('rate_limit_cleanup', () => cleanupRateLimitsD1(env)); } catch (err) { results.rate_limit_cleanup_error = String(err?.message || err); }
    try { results.check_bucket_cleanup = await measure('check_bucket_cleanup', () => cleanupOldCheckBuckets(env, 31)); } catch (err) { results.check_bucket_cleanup_error = String(err?.message || err); }
    try { results.debug_log_cleanup = await measure('debug_log_cleanup', () => cleanupDebugLogs(env)); } catch (err) { results.debug_log_cleanup_error = String(err?.message || err); }
    try { results.agent_metrics_r2_cleanup = await measure('agent_metrics_r2_cleanup', () => cleanupAgentMetricsR2(env)); } catch (err) { results.agent_metrics_r2_cleanup_error = String(err?.message || err); }
    try { results.agent_task_cleanup = await measure('agent_task_cleanup', () => cleanupFinishedAgentTasks(env)); } catch (err) { results.agent_task_cleanup_error = String(err?.message || err); }
  }
  if (parseBoolean(env.ENABLE_DAILY_ARCHIVE ?? false, false)) {
    try { results.archive = await archiveYesterdayOncePerLocalDay(env); } catch (err) { results.archive_error = String(err?.message || err); }
  } else { results.archive = { ok: true, skipped: true, reason: 'disabled' }; }
  results.timings_ms = timings;
  try { await recordScheduledResult(env, cron, results); } catch (_) {}
  return results;
}

async function dispatchScheduledTasks(env, cron) {
  const secret = internalScheduleSecret(env);
  const base = String(env.PUBLIC_WORKER_URL || env.PUBLIC_AGENT_API_BASE || '').trim().replace(/\/+$/, '');
  if (secret && env.REGION_PROXY) {
    const id = env.REGION_PROXY.idFromName('nie-sla-scheduled-runner');
    const response = await env.REGION_PROXY.get(id).fetch('https://nie-sla.internal/scheduled', {
      method: 'POST',
      headers: internalRequestHeaders(env),
      body: JSON.stringify({ cron }),
    });
    if (!response.ok) console.error('scheduled durable dispatch failed', response.status, await response.text());
    return;
  }
  if (!secret || !base) return runScheduledTasks(env, cron);
  let endpoint;
  try {
    endpoint = new URL(`${base}${INTERNAL_SCHEDULE_PATH}`);
    if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') throw new Error('internal schedule endpoint must use HTTPS');
  } catch (err) {
    console.error('scheduled dispatch URL invalid', String(err?.message || err));
    return;
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const cronValue = String(cron || '').slice(0, 64);
  const signature = await signInternalSchedule(secret, timestamp, cronValue);
  const response = await fetch(endpoint.toString(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${timestamp}.${signature}`,
      'x-nie-sla-cron': cronValue,
    },
  });
  if (!response.ok) console.error('scheduled dispatch failed', response.status);
}

async function handleInternalScheduledRequest(request, env) {
  if (request.method !== 'POST') return new Response(null, { status: 404 });
  const secret = internalScheduleSecret(env);
  const authorization = String(request.headers.get('authorization') || '');
  const presented = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7) : '';
  const separator = presented.indexOf('.');
  const timestamp = Number(separator > 0 ? presented.slice(0, separator) : 0);
  const signature = separator > 0 ? presented.slice(separator + 1) : '';
  const cron = String(request.headers.get('x-nie-sla-cron') || '').slice(0, 64);
  if (!secret || !Number.isInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 120) return new Response(null, { status: 404 });
  const expected = await signInternalSchedule(secret, timestamp, cron);
  if (!constantTimeEqual(signature, expected)) return new Response(null, { status: 404 });
  await runScheduledTasks(env, cron);
  return new Response(null, { status: 204 });
}

async function signInternalSchedule(secret, timestamp, cron) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}:${cron}`));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function recordProbeResult(env, cron, probe, error, durationMs) {
  if (!env.DB) return;
  const now = Math.floor(Date.now() / 1000);
  const value = JSON.stringify({
    at: now,
    cron,
    duration_ms: Number(durationMs || 0),
    ok: !error && probe?.ok !== false,
    count: Number(probe?.count || 0),
    failed: Array.isArray(probe?.results) ? probe.results.filter(item => !item?.ok).length : 0,
    error: error || null,
  });
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .bind('scheduled:probe:last', value, now)
    .run();
}

async function recordScheduledResult(env, cron, results) {
  if (!env.DB) return;
  const now = Math.floor(Date.now() / 1000);
  const value = JSON.stringify({ at: now, cron, results: compactScheduledResults(results) }).slice(0, 8000);
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    WHERE app_meta.updated_at <= ?`)
    .bind('scheduled:last', value, now, now - 300)
    .run();
}

function compactScheduledResults(results) {
  const out = { ...results };
  if (out.probe?.results) {
    const failed = out.probe.results.filter(item => !item?.ok).length;
    const warnings = [...new Set(out.probe.results.map(item => item?.warning).filter(Boolean))];
    out.probe = { ok: out.probe.ok, count: out.probe.count, failed, ...(warnings.length ? { warnings } : {}) };
  }
  if (out.fast_status?.events) delete out.fast_status.events;
  if (out.probe?.events) delete out.probe.events;
  if (out.alerts?.errors) {
    out.alerts = { ...out.alerts, errors: out.alerts.errors.slice(0, 5) };
  }
  if (out.agent_metrics_r2_cleanup?.errors) {
    out.agent_metrics_r2_cleanup = { ...out.agent_metrics_r2_cleanup, errors: out.agent_metrics_r2_cleanup.errors.slice(0, 5) };
  }
  return out;
}

async function claimHourlyMaintenanceSlot(env, cron = '') {
  if (String(cron || '').trim() === '0 * * * *') return true;
  if (!env.DB) return new Date().getUTCMinutes() < 5;
  const hour = Math.floor(Date.now() / 3600000);
  const key = 'maintenance:hourly';
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    WHERE CAST(app_meta.value AS INTEGER) < ?`)
    .bind(key, String(hour), now, hour)
    .run();
  // Only the invocation that actually inserted/advanced the hour owns the
  // maintenance slot. Reading the current value after a failed conditional
  // UPSERT would make every minute in the same hour return true.
  return Number(result?.meta?.changes || 0) > 0;
}
