
import { clamp, nowSec, parseBoolean, timezoneOffsetMin, publicError, publicHost, publicUrl, REGION_LABELS } from '../utils.js';
import { summaryRowsFromChecks } from '../storage.js';
import { getMeta, setMeta } from './settings.js';
import { readCheckBuckets } from './check-buckets.js';



function dayStartSecValue(day, env) { return Math.floor(new Date(`${day}T00:00:00.000Z`).getTime() / 1000) - timezoneOffsetMin(env) * 60; }

function yesterdayLocal(env) {
  const d = new Date((Math.floor(Date.now() / 1000) + clamp(Number(env?.TIMEZONE_OFFSET_MINUTES ?? 480), -720, 840) * 60 - 86400) * 1000);
  return d.toISOString().slice(0, 10);
}

export async function archiveYesterdayOncePerLocalDay(env) {
  const afterSec = clamp(Number(env.DAILY_ARCHIVE_AFTER_SEC || 300), 0, 6 * 3600);
  const localNow = nowSec() + timezoneOffsetMin(env) * 60;
  const secInLocalDay = ((localNow % 86400) + 86400) % 86400;
  if (secInLocalDay < afterSec) return { ok: true, skipped: true, reason: 'too_early', after_sec: afterSec };
  const day = yesterdayLocal(env);
  const key = `daily_archive_done:${day}`;
  const done = await getMeta(env, key);
  if (done) return { ok: true, skipped: true, reason: 'already_done', day, done_at: done };
  const result = await archiveDay(env, day);
  if (result?.ok) await setMeta(env, key, String(nowSec()));
  return result;
}

export async function archiveDay(env, day) {
  if (!env.ARCHIVE) return { ok: false, error: 'R2 binding ARCHIVE is missing' };
  const targetRows = await env.DB.prepare(`SELECT * FROM targets WHERE enabled = 1 ORDER BY group_name, name`).all();
  const summaries = [];
  for (const target of targetRows.results || []) {
    const points = await readCheckBuckets(env, target.id, 2);
    summaries.push(...summaryRowsFromChecks(target.id, points, env).filter(row => row.day === day));
  }
  const dayStart = dayStartSecValue(day, env);
  const dayEnd = dayStart + 86400;
  const incidents = await env.DB.prepare(`SELECT * FROM incident_events WHERE (started_at >= ? AND started_at < ?) OR (recovered_at >= ? AND recovered_at < ?) OR (started_at < ? AND recovered_at IS NULL) ORDER BY COALESCE(recovered_at, started_at) ASC`).bind(dayStart, dayEnd, dayStart, dayEnd, dayEnd).all();
  const key = `daily-summary/${day}.json`;
  await env.ARCHIVE.put(key, JSON.stringify({ schema: 'nie-sla-daily-summary-v6', day, exported_at: new Date().toISOString(), summaries, incidents: incidents.results || [] }), { httpMetadata: { contentType: 'application/json; charset=utf-8' }, customMetadata: { day, rows: String(summaries.length) } });
  return { ok: true, key, summary_rows: summaries.length, incident_rows: (incidents.results || []).length };
}



export async function getRecentIncidents(env, limit, maskIps, hidePorts = true) {
  const rows = await env.DB.prepare(`SELECT i.id, i.target_id, i.started_at, i.recovered_at, i.last_checked_at, i.start_colo, i.recover_colo, i.last_error, t.name, t.group_name, t.type, t.target_host, t.target_port, t.url, t.probe_region FROM incident_events i LEFT JOIN targets t ON t.id = i.target_id ORDER BY COALESCE(i.recovered_at, i.started_at) DESC LIMIT ?`).bind(limit).all();
  return (rows.results || []).map(row => {
    const displayHost = row.type === 'tcp' ? publicHost(row.target_host, maskIps) : row.target_host;
    const displayUrl = row.type === 'http' ? publicUrl(row.url, env) : row.url;
    const publicRow = { ...row, target_host: row.type === 'tcp' ? displayHost : row.target_host, url: row.type === 'http' ? displayUrl : row.url, target: row.type === 'http' ? displayUrl : displayHost, last_error: publicError(row.last_error, null), start_colo: null, recover_colo: null, region_label: REGION_LABELS[row.probe_region || 'auto'] || row.probe_region || '自动' };
    if (hidePorts) delete publicRow.target_port;
    return publicRow;
  });
}



export async function getStats(env) {
  if (!env.DB) return { ok: true, note: '未绑定 D1' };
  const results = {};
  try {
    const tables = ['targets', 'check_buckets', 'latest_status', 'incident_events', 'agent_metrics_state', 'agent_metrics_history', 'agent_traffic_monthly', 'agent_traffic_daily', 'ping_targets', 'ping_history', 'rate_limits', 'app_meta'];
    for (const table of tables) {
      try {
        const row = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).first();
        results[table] = { rows: row?.cnt || 0 };
      } catch (_) { results[table] = { error: 'not found' }; }
    }
    const targetsCount = (await env.DB.prepare(`SELECT COUNT(*) as cnt FROM targets WHERE enabled = 1`).first())?.cnt || 0;
    const recentProbes = await env.DB.prepare(`SELECT target_id, COUNT(*) as cnt FROM check_buckets WHERE bucket_at >= ? GROUP BY target_id ORDER BY cnt ASC LIMIT 20`).bind(nowSec() - 3600).all();
    results.probe_status = { enabled_targets: targetsCount, recent_buckets_per_target: recentProbes.results || [] };
    const agentState = await env.DB.prepare(`SELECT agent_id, updated_at FROM agent_metrics_state`).all();
    const now = nowSec();
    results.agent_status = (agentState.results || []).map(r => ({
      agent_id: r.agent_id,
      seconds_since_update: now - Math.floor(new Date(r.updated_at || 0).getTime() / 1000),
      online: (now - Math.floor(new Date(r.updated_at || 0).getTime() / 1000)) < 600
    }));
    const agentCount = agentState.results?.length || 0;
    const metricsPointsPerReport = clamp(Number(env.AGENT_METRICS_POINTS_PER_REPORT || 6), 1, 60);
    const metricsToD1 = parseBoolean(env.AGENT_METRICS_TO_D1 ?? !env.ARCHIVE, !env.ARCHIVE);
    const pingsToD1 = parseBoolean(env.AGENT_PINGS_TO_D1 ?? !env.ARCHIVE, !env.ARCHIVE);
    const pingTargetsCount = (await env.DB.prepare(`SELECT COUNT(*) as cnt FROM ping_targets WHERE enabled = 1`).first())?.cnt || 0;
    const trafficAgentCount = (await env.DB.prepare(`SELECT COUNT(*) as cnt FROM targets WHERE enabled = 1 AND traffic_enabled = 1`).first())?.cnt || 0;
    const reportIntervalSec = clamp(Number(env.AGENT_REPORT_INTERVAL_SEC || 900), 60, 86400);
    const agentReportsPerDay = agentCount * Math.ceil(86400 / reportIntervalSec);
    const pingIntervalSec = clamp(Number(env.NIE_SLA_PING_SEC || env.NSTATUS_PING_SEC || env.AGENT_PING_SEC || 20), 5, 600);
    results.estimated_daily = {
      check_bucket_writes: targetsCount * Math.ceil(86400 / clamp(Number(env.HISTORY_PROBE_HEALTHY_INTERVAL_SEC || 900), 300, 86400)),
      agent_state_writes: agentReportsPerDay,
      agent_traffic_period_writes: trafficAgentCount * Math.ceil(86400 / reportIntervalSec),
      agent_traffic_daily_writes: trafficAgentCount,
      agent_history_d1_writes: metricsToD1 ? agentReportsPerDay : 0,
      ping_history_d1_writes: pingsToD1 ? Math.ceil(agentCount * pingTargetsCount * 86400 / pingIntervalSec) : 0,
      agent_history_points_in_d1: metricsToD1 ? agentCount * metricsPointsPerReport * Math.ceil(86400 / reportIntervalSec) : 0,
      agent_metric_points_in_r2: agentCount * reportIntervalSec * Math.ceil(86400 / reportIntervalSec),
      ping_points_in_r2: Math.ceil(agentCount * pingTargetsCount * 86400 / pingIntervalSec),
      r2_class_a_writes_month: agentReportsPerDay * 30,
      d1_rows_written_limit_per_day: 100000,
      storage_mode: env.ARCHIVE ? 'r2-primary' : 'd1-fallback',
      notes: 'R2-primary keeps high-frequency metric and ping history out of D1 unless AGENT_METRICS_TO_D1/AGENT_PINGS_TO_D1 are enabled. Traffic daily rows are finalized once per agent per day.'
    };
  } catch (e) { results.error = String(e?.message || e); }
  return { ok: true, stats: results };
}
