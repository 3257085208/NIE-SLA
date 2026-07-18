import { enrichCfContext, probeTarget, saveCheck, runDueTargets } from './probe.js';
import { writeStatusSnapshot } from './status.js';
import { archiveYesterdayOncePerLocalDay, cleanupOldCheckBuckets, cleanupVolatileHistory, ensureV6Schema } from './admin.js';
import { cleanupRateLimitsD1 } from './ratelimit.js';
import { cleanupAgentMetricsR2 } from './metrics.js';
import { runAlertChecks } from './alerts.js';
import { VERSION } from './version.js';
import { handleRequest } from './routes.js';
import { json } from './auth.js';
import { parseBoolean } from './utils.js';

// Durable Object for region probing.

export class ProbeRegion {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    if (request.method !== 'POST') return json({ ok: false, error: '不支持该请求方法' }, 405);
    const url = new URL(request.url);
    if (url.pathname === '/debug-colo') {
      const meta = await request.json().catch(() => ({}));
      const cf = await enrichCfContext(request.cf || {}, this.env);
      return json({ ok: true, region: meta.region || null, version: meta.version || null, objectName: meta.objectName || null, colo: cf.colo, echo_colo: cf.echo_colo, trace_colo: null, request_colo: cf.request_colo });
    }
    const body = await request.json();
    const target = body?.target || body;
    const checkedAt = Number(body?.checked_at || Math.floor(Date.now() / 1000));
    const result = await probeTarget(target, await enrichCfContext(request.cf || {}, this.env));
    if (url.pathname === '/probe-and-save') {
      const saved = await saveCheck(this.env, target, checkedAt, result, body?.previous || null);
      return json({ target_id: target.id, name: target.name, ...result, saved, state_update: saved.state_update });
    }
    return json(result);
  }
}

// Worker entry.

export default {
  async fetch(request, env, ctx) {
    try { return await handleRequest(request, env, ctx); }
    catch (err) {
      const status = err?.status || 500;
      const message = status === 500 ? '服务器内部错误' : String(err?.message || '请求失败');
      return json({ ok: false, error: message }, status, env);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledTasks(env, controller.cron));
  },
};

async function runScheduledTasks(env, cron) {
  const results = {};
  const timings = {};
  const measure = async (name, task) => {
    const started = Date.now();
    try { return await task(); }
    finally { timings[name] = Date.now() - started; }
  };
  try { await ensureV6Schema(env); } catch (err) { results.schema_error = String(err?.message || err); }
  // Availability checks are the time-sensitive task; maintenance must never
  // consume the cron execution window before probes have run.
  try { results.probe = await measure('probe', () => runDueTargets(env)); } catch (err) { results.probe_error = String(err?.message || err); }
  try { await recordProbeResult(env, cron, results.probe, results.probe_error, timings.probe); } catch (_) {}
  try { results.alerts = await measure('alerts', () => runAlertChecks(env)); } catch (err) { results.alerts_error = String(err?.message || err); }
  try { results.status_snapshot = await measure('status_snapshot', () => writeStatusSnapshot(env)); } catch (err) { results.status_snapshot_error = String(err?.message || err); }
  let runHourlyMaintenance = false;
  try { runHourlyMaintenance = await claimHourlyMaintenanceSlot(env, cron); } catch (err) { results.hourly_claim_error = String(err?.message || err); }
  if (runHourlyMaintenance) {
    try { results.volatile_cleanup = await measure('volatile_cleanup', () => cleanupVolatileHistory(env)); } catch (err) { results.volatile_cleanup_error = String(err?.message || err); }
    try { results.rate_limit_cleanup = await measure('rate_limit_cleanup', () => cleanupRateLimitsD1(env)); } catch (err) { results.rate_limit_cleanup_error = String(err?.message || err); }
    try { results.check_bucket_cleanup = await measure('check_bucket_cleanup', () => cleanupOldCheckBuckets(env, 31)); } catch (err) { results.check_bucket_cleanup_error = String(err?.message || err); }
    try { results.agent_metrics_r2_cleanup = await measure('agent_metrics_r2_cleanup', () => cleanupAgentMetricsR2(env)); } catch (err) { results.agent_metrics_r2_cleanup_error = String(err?.message || err); }
  }
  if (parseBoolean(env.ENABLE_DAILY_ARCHIVE ?? false, false)) {
    try { results.archive = await archiveYesterdayOncePerLocalDay(env); } catch (err) { results.archive_error = String(err?.message || err); }
  } else { results.archive = { ok: true, skipped: true, reason: 'disabled' }; }
  results.timings_ms = timings;
  try { await recordScheduledResult(env, cron, results); } catch (_) {}
  return results;
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
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .bind('scheduled:last', value, now)
    .run();
}

function compactScheduledResults(results) {
  const out = { ...results };
  if (out.probe?.results) {
    const failed = out.probe.results.filter(item => !item?.ok).length;
    out.probe = { ok: out.probe.ok, count: out.probe.count, failed };
  }
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
  const row = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(key).first().catch(() => null);
  if (Number(row?.value || -1) >= hour) return false;
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .bind(key, String(hour), Math.floor(Date.now() / 1000))
    .run();
  return true;
}
