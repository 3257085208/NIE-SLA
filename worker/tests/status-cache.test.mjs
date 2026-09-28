import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { statusCacheKey } from '../src/utils.js';

const env = {};
const base = new URL('https://status.example.com/api/status');

const plain = statusCacheKey(base, env);
assert.equal(plain.method, 'GET');
assert.match(plain.url, /days=30/, 'missing days falls back to the default window');
assert.match(plain.url, /privacy=/);
assert.doesNotMatch(plain.url, /fresh=1/, 'plain requests use the shared cache entry');

const fresh = statusCacheKey(new URL('https://status.example.com/api/status?fresh=1'), env);
const cacheOff = statusCacheKey(new URL('https://status.example.com/api/status?cache=0'), env);
assert.notEqual(fresh.url, plain.url, 'fresh=1 must not overwrite the shared cache entry');
assert.equal(fresh.url, cacheOff.url, 'fresh=1 and cache=0 share one isolated cache entry');
assert.match(fresh.url, /fresh=1/);

const lite = statusCacheKey(new URL('https://status.example.com/api/status?lite=1&days=7'), env);
assert.match(lite.url, /lite=1/);
assert.match(lite.url, /days=7/);
assert.notEqual(lite.url, plain.url);

const clamped = statusCacheKey(new URL('https://status.example.com/api/status?days=999'), env);
assert.match(clamped.url, /days=90/, 'day windows are clamped to 90');

const noise = statusCacheKey(new URL('https://status.example.com/api/status?fresh=0&lite=0&foo=bar'), env);
assert.equal(noise.url, plain.url, 'unrelated query noise does not fragment the cache');

// Admin mutations must invalidate both the edge cache and the R2 snapshot,
// otherwise public requests keep the previous order/state until the snapshot
// freshness window expires (~150s).
const routesSource = readFileSync(new URL('../src/routes.js', import.meta.url), 'utf8');
assert.match(routesSource, /env\?\.ARCHIVE\?\.delete\?\.\(snapshotKey\)/, 'cache clearing must drop the R2 status snapshot');
assert.match(routesSource, /createTarget\(request, env\)[\s\S]{0,160}clearStatusCaches\(url, env, ctx\)/, 'target creation must invalidate status caches');
assert.match(routesSource, /updateTarget\(pathParam\(targetMatch\[1\]\), request, env\)[\s\S]{0,160}clearStatusCaches\(url, env, ctx\)/, 'target updates must invalidate status caches');
assert.match(routesSource, /deleteTarget\(pathParam\(targetMatch\[1\]\), env\)[\s\S]{0,160}clearStatusCaches\(url, env, ctx\)/, 'target deletion must invalidate status caches');
assert.match(routesSource, /ctx\?\.waitUntil[\s\S]{0,120}writeStatusSnapshot\(env, \{ force: true \}\)/, 'cache clearing must prewarm the snapshot in the background');
const statusSource = readFileSync(new URL('../src/status.js', import.meta.url), 'utf8');
assert.match(statusSource, /writeStatusSnapshot\(env, \{ force = false \} = \{\}\)/, 'the snapshot writer must support a forced rebuild');

console.log('status cache key tests passed');
