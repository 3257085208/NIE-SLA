import { nowSec } from './utils.js';
import { ApiError, safeJson } from './auth.js';

export const MIN_PING_INTERVAL_SEC = 5;
export const MAX_PING_INTERVAL_SEC = 300;
export const DEFAULT_PING_INTERVAL_SEC = 20;

const META_KEY = 'agent_ping_interval_sec';

export function normalizePingIntervalSec(value, fallback = DEFAULT_PING_INTERVAL_SEC) {
  const number = Number(value);
  return Number.isInteger(number) && number >= MIN_PING_INTERVAL_SEC && number <= MAX_PING_INTERVAL_SEC
    ? number
    : fallback;
}

export async function getPingIntervalSec(env) {
  let stored = null;
  if (env.DB) {
    stored = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`)
      .bind(META_KEY).first().catch(() => null);
  }
  return normalizePingIntervalSec(
    stored?.value,
    normalizePingIntervalSec(env.NIE_SLA_PING_SEC ?? env.NSTATUS_PING_SEC ?? env.AGENT_PING_SEC, DEFAULT_PING_INTERVAL_SEC),
  );
}

export async function updatePingConfig(request, env) {
  const body = await safeJson(request);
  const interval = Number(body?.ping_interval_sec);
  if (!Number.isInteger(interval) || interval < MIN_PING_INTERVAL_SEC || interval > MAX_PING_INTERVAL_SEC) {
    throw new ApiError(400, `Ping 间隔必须是 ${MIN_PING_INTERVAL_SEC}-${MAX_PING_INTERVAL_SEC} 秒之间的整数`);
  }
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(META_KEY, String(interval), nowSec()).run();
  return { ok: true, ...pingConfigPayload(interval) };
}

export function pingConfigPayload(interval) {
  return {
    ping_interval_sec: normalizePingIntervalSec(interval),
    min_interval_sec: MIN_PING_INTERVAL_SEC,
    max_interval_sec: MAX_PING_INTERVAL_SEC,
  };
}
