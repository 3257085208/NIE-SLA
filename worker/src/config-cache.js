// Shared read-through cache for small, non-secret configuration values in D1
// `app_meta`. The per-isolate memo avoids repeated reads inside one isolate,
// and the Cache API layer shares one read per colo instead of one read per
// active isolate. Only settings that already tolerate a short propagation
// delay (60s-style admin path / ping interval semantics) may use this helper;
// credentials, sessions and locks must keep reading D1 directly.

const MEM_TTL_MS = 30_000;
const MIN_TTL_SEC = 10;
const MAX_TTL_SEC = 300;
const CACHE_ORIGIN = 'https://config-cache.internal';

const mem = new Map();

function cacheStore() {
  try {
    return typeof caches !== 'undefined' && caches?.default ? caches.default : null;
  } catch (_) {
    return null;
  }
}

function cacheRequest(key) {
  return new Request(`${CACHE_ORIGIN}/meta/${encodeURIComponent(String(key))}`, { method: 'GET' });
}

function memGet(key, now) {
  const entry = mem.get(key);
  if (!entry) return undefined;
  if (entry.expires_at <= now) {
    mem.delete(key);
    return undefined;
  }
  return entry.value;
}

function memSet(key, value, ttlSec) {
  const ttlMs = Math.min(MEM_TTL_MS, Math.max(1000, ttlSec * 1000));
  mem.set(key, { value, expires_at: Date.now() + ttlMs });
}

export async function readSharedConfig(env, key, ttlSec, loader) {
  const ttl = Math.max(MIN_TTL_SEC, Math.min(MAX_TTL_SEC, Number(ttlSec) || 60));
  const memo = memGet(key, Date.now());
  if (memo !== undefined) return memo;
  const store = cacheStore();
  if (store) {
    const hit = await store.match(cacheRequest(key)).catch(() => null);
    if (hit) {
      const body = await hit.json().catch(() => null);
      if (body && typeof body === 'object' && 'value' in body) {
        memSet(key, body.value, ttl);
        return body.value;
      }
    }
  }
  const value = await loader();
  memSet(key, value, ttl);
  if (store) {
    const response = new Response(JSON.stringify({ value }), {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttl}` },
    });
    try {
      await store.put(cacheRequest(key), response);
    } catch (_) {}
  }
  return value;
}

export function invalidateSharedConfig(key) {
  mem.delete(key);
  const store = cacheStore();
  if (!store) return Promise.resolve();
  return store.delete(cacheRequest(key)).catch(() => {});
}
