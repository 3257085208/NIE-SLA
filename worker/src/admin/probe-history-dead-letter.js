import { ApiError, internalRequestHeaders, safeJson } from '../auth.js';
import { clamp, sanitizeId } from '../utils.js';
import { PROBE_HISTORY_HUB_INSTANCE } from '../probe-history-buffer.js';

const DEFAULT_TARGET_SCAN_LIMIT = 200;
const DEFAULT_DEAD_LETTER_LIMIT = 50;

export async function listProbeHistoryDeadLetters(env, url) {
  assertProbeHistoryBinding(env);
  const rawTargetId = String(url?.searchParams.get('target_id') || '').trim();
  const targetId = rawTargetId ? normalizeTargetId(rawTargetId) : '';
  const limit = clamp(Number(url?.searchParams.get('limit') || DEFAULT_DEAD_LETTER_LIMIT), 1, 100);
  const targets = await listTargetsForDeadLetters(env, targetId);
  const deadLetters = [];
  const errors = [];

  for (const target of targets) {
    try {
      const body = await fetchDeadLetterList(env, target.id, limit);
      for (const item of Array.isArray(body?.dead_letters) ? body.dead_letters : []) {
        deadLetters.push({
          ...item,
          target_id: String(target.id),
          target_name: String(target.name || target.id),
          target_enabled: Number(target.enabled || 0) === 1,
        });
      }
    } catch (error) {
      errors.push({ target_id: String(target.id), target_name: String(target.name || target.id), error: '读取失败' });
      console.error(`list probe dead-letters failed (${target.id}):`, String(error?.message || error));
    }
    if (deadLetters.length >= limit) break;
  }

  deadLetters.sort((left, right) => String(right.saved_at || '').localeCompare(String(left.saved_at || '')) || String(left.target_name).localeCompare(String(right.target_name)) || String(left.day).localeCompare(String(right.day)));
  return {
    ok: true,
    dead_letters: deadLetters.slice(0, limit),
    scanned_targets: targets.length,
    errors,
  };
}

export async function replayProbeHistoryDeadLetter(request, env) {
  assertProbeHistoryBinding(env);
  const body = await safeJson(request, 16 * 1024);
  const targetId = normalizeTargetId(body?.target_id);
  const day = String(body?.day || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ApiError(400, 'day 必须是 YYYY-MM-DD');

  const response = await env.PROBE_HISTORY.get(probeHistoryId(env)).fetch('https://nie-sla.internal/dead-letter/replay', {
    method: 'POST',
    headers: internalRequestHeaders(env),
    body: JSON.stringify({ target_id: targetId, day }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.ok === false) {
    throw new ApiError(response.status >= 400 && response.status < 500 ? response.status : 503, result?.error || 'dead-letter 重放失败');
  }
  return { ...result, target_id: targetId };
}

export async function drainProbeHistoryDeadLetters(request, env) {
  assertProbeHistoryBinding(env);
  const body = await safeJson(request, 16 * 1024);
  const targetId = body?.target_id === undefined ? '' : normalizeTargetId(body.target_id);
  const limit = clamp(Number(body?.limit || 25), 1, 25);
  const listed = await listProbeHistoryDeadLetters(env, new URL(`https://nie-sla.internal/api/probe-history/dead-letter?limit=${limit}${targetId ? `&target_id=${encodeURIComponent(targetId)}` : ''}`));
  const targetIds = [...new Set((listed.dead_letters || []).map((item) => String(item.target_id || '').trim()).filter(Boolean))];
  const drained = [];
  const failed = [...(listed.errors || [])];

  for (const id of targetIds) {
    if (drained.length + failed.length >= limit) break;
    const remaining = Math.min(25, limit - drained.length - failed.length);
    try {
      const result = await fetchDeadLetterDrain(env, id, remaining);
      for (const item of result.drained || []) drained.push({ ...item, target_id: id });
      for (const item of result.failed || []) failed.push({ ...item, target_id: id });
    } catch (error) {
      failed.push({ target_id: id, error: '读取或重放失败，原记录仍保留' });
      console.error(`drain probe dead-letters failed (${id}):`, String(error?.message || error));
    }
  }
  return { ok: true, drained: drained.slice(0, limit), failed: failed.slice(0, limit), processed: drained.length + failed.length };
}

function assertProbeHistoryBinding(env) {
  if (!env?.PROBE_HISTORY) throw new ApiError(503, '缺少 probe history Durable Object 绑定');
  if (!env?.DB) throw new ApiError(503, 'dead-letter 管理需要 D1 数据库');
}

async function listTargetsForDeadLetters(env, targetId) {
  const query = targetId
    ? env.DB.prepare('SELECT id, name, enabled FROM targets WHERE id = ? ORDER BY name COLLATE NOCASE').bind(targetId)
    : env.DB.prepare(`SELECT id, name, enabled FROM targets ORDER BY name COLLATE NOCASE, id LIMIT ${DEFAULT_TARGET_SCAN_LIMIT}`);
  const result = await query.all();
  return result.results || [];
}

async function fetchDeadLetterList(env, targetId, limit) {
  const url = new URL('https://nie-sla.internal/dead-letter');
  url.searchParams.set('target_id', String(targetId));
  url.searchParams.set('limit', String(limit));
  const response = await env.PROBE_HISTORY.get(probeHistoryId(env)).fetch(url.toString(), { headers: internalRequestHeaders(env) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) throw new Error(`HTTP ${response.status}`);
  return body;
}

async function fetchDeadLetterDrain(env, targetId, limit) {
  const response = await env.PROBE_HISTORY.get(probeHistoryId(env)).fetch('https://nie-sla.internal/dead-letter/drain', {
    method: 'POST',
    headers: internalRequestHeaders(env),
    body: JSON.stringify({ target_id: targetId, limit }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) throw new Error(`HTTP ${response.status}`);
  return body;
}

function probeHistoryId(env) {
  return env.PROBE_HISTORY.idFromName(PROBE_HISTORY_HUB_INSTANCE);
}

function normalizeTargetId(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new ApiError(400, '缺少 target_id');
  return sanitizeId(raw);
}
