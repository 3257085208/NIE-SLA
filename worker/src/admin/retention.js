import { ApiError, safeJson } from '../auth.js';
import { readSharedConfig, invalidateSharedConfig } from '../config-cache.js';
import { setMeta } from './settings.js';

// Admin-adjustable archive retention. Default stays at the historical 72h so
// existing deployments are unchanged; the upper bound matches the original
// hard cap of 720h (30 days). The value governs the Agent metrics/pings
// history windows and the R2 cleanup cutoff; proxy-check history keeps its
// own (already 720h) retention.
const RETENTION_KEY = 'agent_retention_hours';
export const RETENTION_MIN_HOURS = 72;
export const RETENTION_MAX_HOURS = 720;
export const RETENTION_DEFAULT_HOURS = 72;

export function normalizeRetentionHours(value, fallback = RETENTION_DEFAULT_HOURS) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.round(number);
  if (rounded < RETENTION_MIN_HOURS || rounded > RETENTION_MAX_HOURS) return fallback;
  return rounded;
}

export async function getRetentionHours(env) {
  const fallback = normalizeRetentionHours(env?.AGENT_METRICS_R2_RETENTION_HOURS, RETENTION_DEFAULT_HOURS);
  return readSharedConfig(env, RETENTION_KEY, 60, async () => {
    if (!env?.DB) return fallback;
    try {
      const row = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?').bind(RETENTION_KEY).first();
      if (row?.value != null) return normalizeRetentionHours(row.value, fallback);
    } catch (_) {}
    return fallback;
  });
}

export async function updateRetentionConfig(request, env) {
  const body = await safeJson(request);
  const hours = Number(body?.retention_hours);
  if (!Number.isInteger(hours) || hours < RETENTION_MIN_HOURS || hours > RETENTION_MAX_HOURS) {
    throw new ApiError(400, `保留时长必须是 ${RETENTION_MIN_HOURS}-${RETENTION_MAX_HOURS} 小时之间的整数`);
  }
  await setMeta(env, RETENTION_KEY, String(hours));
  await invalidateSharedConfig(RETENTION_KEY);
  return {
    ok: true,
    retention_hours: hours,
    min_hours: RETENTION_MIN_HOURS,
    max_hours: RETENTION_MAX_HOURS,
    external_storage_recommended: hours > RETENTION_MIN_HOURS,
  };
}
