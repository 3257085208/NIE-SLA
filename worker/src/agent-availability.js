import { clamp, nowSec, sanitizeAgentId, timezoneOffsetMin } from './utils.js';

const DEFAULT_RETENTION_DAYS = 90;

export function agentAvailabilitySegments(previousUpdatedAt, currentAt = nowSec(), env = {}) {
  const previousAt = timestampSec(previousUpdatedAt);
  const endAt = timestampSec(currentAt);
  if (!previousAt || !endAt || endAt <= previousAt) return [];

  const retentionDays = clamp(Number(env.AGENT_AVAILABILITY_RETENTION_DAYS || DEFAULT_RETENTION_DAYS), 30, 180);
  const offlineAfterSec = clamp(Number(env.AGENT_OFFLINE_AFTER_SEC || 900), 120, 3600);
  const startAt = Math.max(previousAt, endAt - retentionDays * 86400);
  const onlineUntil = Math.min(endAt, previousAt + offlineAfterSec);
  const rows = new Map();

  addInterval(rows, startAt, Math.max(startAt, onlineUntil), true, env);
  addInterval(rows, Math.max(startAt, onlineUntil), endAt, false, env);
  return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export async function recordAgentAvailability(env, agentId, previousUpdatedAt, currentAt = nowSec()) {
  if (!env.DB) return;
  const id = sanitizeAgentId(agentId);
  const rows = agentAvailabilitySegments(previousUpdatedAt, currentAt, env);
  if (!id || !rows.length) return;

  const statements = rows.map(row => env.DB.prepare(`
    INSERT INTO agent_daily_availability (agent_id, day, total_sec, online_sec, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, day) DO UPDATE SET
      total_sec = total_sec + excluded.total_sec,
      online_sec = online_sec + excluded.online_sec,
      updated_at = excluded.updated_at
  `).bind(id, row.day, row.total, row.ok_count, timestampSec(currentAt)));
  if (typeof env.DB.batch === 'function') await env.DB.batch(statements);
  else for (const statement of statements) await statement.run();

  const previousDay = localDay(timestampSec(previousUpdatedAt), env);
  const currentDay = localDay(timestampSec(currentAt), env);
  if (previousDay && currentDay && previousDay !== currentDay) {
    const retentionDays = clamp(Number(env.AGENT_AVAILABILITY_RETENTION_DAYS || DEFAULT_RETENTION_DAYS), 30, 180);
    const cutoff = localDay(timestampSec(currentAt) - retentionDays * 86400, env);
    await env.DB.prepare('DELETE FROM agent_daily_availability WHERE agent_id = ? AND day < ?').bind(id, cutoff).run();
  }
}

export function mergeAgentAvailabilityRows(storedRows = [], metricRows = [], env = {}, currentAt = nowSec(), targetRows = []) {
  const byKey = new Map();
  for (const row of uptimeBaselineRows(storedRows, metricRows, targetRows, env, currentAt)) {
    mergeRow(byKey, row.agent_id, row.day, row.total, row.ok_count);
  }
  for (const row of storedRows || []) mergeRow(byKey, row.agent_id, row.day, row.total_sec, row.online_sec);
  for (const metric of metricRows || []) {
    const id = sanitizeAgentId(metric?.agent_id);
    for (const row of agentAvailabilitySegments(metric?.updated_at, currentAt, env)) {
      mergeRow(byKey, id, row.day, row.total, row.ok_count);
    }
  }
  return [...byKey.values()].sort((a, b) => a.day.localeCompare(b.day) || a.agent_id.localeCompare(b.agent_id));
}

export function uptimeBaselineRows(storedRows = [], metricRows = [], targetRows = [], env = {}, currentAt = nowSec()) {
  const earliestStoredDay = new Map();
  for (const row of storedRows || []) {
    const id = sanitizeAgentId(row?.agent_id);
    const day = String(row?.day || '');
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!earliestStoredDay.has(id) || day < earliestStoredDay.get(id)) earliestStoredDay.set(id, day);
  }

  const metricsByAgent = new Map((metricRows || []).map(row => [sanitizeAgentId(row?.agent_id), row]));
  const retentionDays = clamp(Number(env.AGENT_AVAILABILITY_RETENTION_DAYS || DEFAULT_RETENTION_DAYS), 30, 180);
  const retentionStart = timestampSec(currentAt) - retentionDays * 86400;
  const output = [];

  for (const target of targetRows || []) {
    if (Number(target?.no_public_ip || 0) !== 1) continue;
    const id = sanitizeAgentId(target?.id);
    const metric = metricsByAgent.get(id);
    const endAt = timestampSec(metric?.updated_at);
    const uptimeSec = Math.max(0, Math.floor(Number(metric?.uptime_sec || 0)));
    const createdAt = timestampSec(target?.created_at);
    const startAt = Math.max(endAt - uptimeSec, createdAt, retentionStart);
    if (!id || !endAt || !uptimeSec || endAt <= startAt) continue;

    const rows = new Map();
    addInterval(rows, startAt, endAt, true, env);
    const firstRecordedDay = earliestStoredDay.get(id);
    for (const row of rows.values()) {

      if (firstRecordedDay && row.day >= firstRecordedDay) continue;
      output.push({ agent_id: id, ...row });
    }
  }
  return output;
}

function addInterval(rows, startAt, endAt, online, env) {
  let cursor = Math.floor(startAt);
  const end = Math.floor(endAt);
  const offsetSec = timezoneOffsetMin(env) * 60;
  while (cursor < end) {
    const dayIndex = Math.floor((cursor + offsetSec) / 86400);
    const nextDayAt = (dayIndex + 1) * 86400 - offsetSec;
    const segmentEnd = Math.min(end, nextDayAt);
    const seconds = Math.max(0, segmentEnd - cursor);
    const day = new Date(dayIndex * 86400000).toISOString().slice(0, 10);
    const row = rows.get(day) || { day, total: 0, ok_count: 0 };
    row.total += seconds;
    if (online) row.ok_count += seconds;
    rows.set(day, row);
    cursor = segmentEnd;
  }
}

function mergeRow(rows, agentId, day, total, online) {
  const id = sanitizeAgentId(agentId);
  const cleanDay = String(day || '');
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(cleanDay)) return;
  const key = `${id}|${cleanDay}`;
  const row = rows.get(key) || { agent_id: id, day: cleanDay, total: 0, ok_count: 0 };
  row.total += Math.max(0, Number(total || 0));
  row.ok_count += Math.max(0, Number(online || 0));
  rows.set(key, row);
}

function timestampSec(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.floor(value) : 0;
  const parsed = Math.floor(new Date(value || 0).getTime() / 1000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function localDay(timestamp, env) {
  if (!timestamp) return '';
  return new Date((timestamp + timezoneOffsetMin(env) * 60) * 1000).toISOString().slice(0, 10);
}
