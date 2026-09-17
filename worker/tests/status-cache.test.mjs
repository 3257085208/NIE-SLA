import assert from 'node:assert/strict';
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

console.log('status cache key tests passed');
