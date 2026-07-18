import assert from 'node:assert/strict';
import { resolvePublicMetricsQuery, defaultMetricsMaxPointsForHours } from '../src/metrics.js';
import { isPrivateHost, assertPublicHttpUrl, buildOpenMissedPoints } from '../src/utils.js';

function urlWith(qs) {
  return new URL('https://example.test/api/agent/metrics?' + qs);
}

// metrics caps
{
  const q0 = resolvePublicMetricsQuery(urlWith('hours=24&max_points=0'), {});
  assert.equal(q0.maxPoints, defaultMetricsMaxPointsForHours(24, {}));
  assert.ok(q0.maxPoints > 0);
  const qHuge = resolvePublicMetricsQuery(urlWith('hours=168&max_points=999999'), {});
  assert.equal(qHuge.hours, 72);
  assert.equal(qHuge.maxPoints, 4000);
  const q1h = resolvePublicMetricsQuery(urlWith('hours=1'), {});
  assert.equal(q1h.maxPoints, 3600);
}

// private hosts
assert.equal(isPrivateHost('127.0.0.1'), true);
assert.equal(isPrivateHost('10.0.0.1'), true);
assert.equal(isPrivateHost('192.168.1.1'), true);
assert.equal(isPrivateHost('172.16.5.5'), true);
assert.equal(isPrivateHost('8.8.8.8'), false);
assert.equal(isPrivateHost('localhost'), true);
assert.equal(isPrivateHost('::1'), true);
assert.equal(isPrivateHost('[::1]'), true);
assert.equal(isPrivateHost('::ffff:127.0.0.1'), true);
assert.equal(isPrivateHost('example.com'), false);

assert.throws(() => assertPublicHttpUrl('not a url'), /无效|invalid/i);
assert.throws(() => assertPublicHttpUrl('ftp://example.com'), /http/i);
assert.throws(() => assertPublicHttpUrl('http://127.0.0.1/'), /私有|内部|private/i);
assert.ok(assertPublicHttpUrl('https://example.com/path'));

// grace default >= 120
{
  const prev = { checked_at: Math.floor(Date.now()/1000) - 400 };
  const points = buildOpenMissedPoints({}, prev, Math.floor(Date.now()/1000));
  assert.ok(Array.isArray(points));
}

console.log('hardening tests passed');
