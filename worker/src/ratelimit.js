// Worker isolates do not share memory, so this Map is only a best-effort
// throttle for public/cacheable reads. Use the D1-backed path for anything
// security-sensitive, such as admin login, TOTP and write endpoints.
const buckets = new Map();
let d1TableReady = false;

function check(key, limit, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, count: 0 };
    buckets.set(key, bucket);
  }
  bucket.count++;
  if (buckets.size > 10000) {
    for (const [k, v] of buckets) { if (now - v.start > windowMs) buckets.delete(k); }
  }
  return bucket.count <= limit;
}

export async function rateLimitByIp(request, env, limit, windowSec = 60, options = {}) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (useD1RateLimit(env, options)) {
    return await rateLimitD1(env, `ip:${ip}`, limit, windowSec);
  }
  return check(ip, limit, windowSec * 1000);
}

export async function rateLimitGlobal(request, env, limit, windowSec = 60, options = {}) {
  if (useD1RateLimit(env, options)) {
    return await rateLimitD1(env, '__global__', limit, windowSec);
  }
  return check('__global__', limit, windowSec * 1000);
}

function useD1RateLimit(env, options = {}) {
  if (options.bestEffort) return false;
  if (options.durable) return true;
  const value = env?.RATE_LIMIT_D1;
  if (value === true) return true;
  if (value === false) return false;
  if (value == null || value === '') return true;
  const text = String(value).trim().toLowerCase();
  if (text === '1' || text === 'true') return true;
  if (text === '0' || text === 'false') return false;
  return true;
}

export async function rateLimitD1(env, key, limit, windowSec = 60) {
  if (!env.DB) return false;
  const now = nowSec();
  const windowStart = now - windowSec;
  try {
    await ensureD1RateLimitTable(env);
    await env.DB.prepare(`DELETE FROM rate_limits WHERE key = ? AND ts < ?`).bind(key, windowStart).run();
    const result = await env.DB.prepare(`INSERT INTO rate_limits (key, ts)
      SELECT ?, ?
      WHERE (SELECT COUNT(*) FROM rate_limits WHERE key = ? AND ts >= ?) < ?`)
      .bind(key, now, key, windowStart, limit).run();
    return Number(result?.meta?.changes || 0) === 1;
  } catch (err) {
    console.error('rateLimitD1 failed:', String(err?.message || err));
    return false;
  }
}

async function ensureD1RateLimitTable(env) {
  if (d1TableReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rate_limits (key TEXT NOT NULL, ts INTEGER NOT NULL)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_rate_limits_key_ts ON rate_limits(key, ts)`).run();
  d1TableReady = true;
}

export async function cleanupRateLimitsD1(env) {
  if (!env.DB) return { ok: true, skipped: true, reason: 'missing_db' };
  try {
    const result = await env.DB.prepare(`DELETE FROM rate_limits WHERE ts < ?`).bind(nowSec() - 3600).run();
    return { ok: true, changes: result?.meta?.changes ?? null };
  } catch (err) {
    const message = String(err?.message || err);
    console.error('cleanupRateLimitsD1 failed:', message);
    return { ok: false, error: message };
  }
}

function nowSec() { return Math.floor(Date.now() / 1000); }
