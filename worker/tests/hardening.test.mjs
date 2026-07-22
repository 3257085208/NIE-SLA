import assert from 'node:assert/strict';
import { resolvePublicMetricsQuery, defaultMetricsMaxPointsForHours } from '../src/metrics.js';
import { isPrivateHost, assertPublicHttpUrl, buildOpenMissedPoints } from '../src/utils.js';
import { resolveCorsOrigin } from '../src/auth.js';
import { getDeveloperApiManifest, resolveDeveloperApiOrigin, withDeveloperApiHeaders } from '../src/developer-api.js';

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

// CORS origin resolution
{
  assert.equal(resolveCorsOrigin({ ALLOWED_ORIGIN: 'https://sla.example' }), 'https://sla.example');
  assert.equal(resolveCorsOrigin({ PUBLIC_SITE_ORIGIN: 'https://pages.example/' }), 'https://pages.example');
  assert.equal(resolveCorsOrigin({}), '');
}
console.log('cors tests passed');

// Versioned developer API stays read-only and uses explicit origins.
{
  const request = new Request('https://api.example.test/api/v1', { headers: { origin: 'https://theme.example.test' } });
  const env = {
    ALLOWED_ORIGIN: 'https://status.example.test',
    DEVELOPER_API_ORIGINS: 'https://theme.example.test,http://localhost:5173,*,http://unsafe.example.test',
  };
  assert.equal(resolveDeveloperApiOrigin(request, env), 'https://theme.example.test');
  assert.equal(resolveDeveloperApiOrigin(new Request(request.url, { headers: { origin: 'https://blocked.example.test' } }), env), 'https://status.example.test');
  const manifest = getDeveloperApiManifest(request, env, 'v1.2.3');
  assert.equal(manifest.api_version, 'v1');
  assert.equal(manifest.authentication.write, 'not_available');
  assert.equal(manifest.extensions.privileged_plugins, false);
  assert.ok(manifest.endpoints.every(endpoint => endpoint.method === 'GET' && endpoint.url.startsWith('https://api.example.test/api/v1/')));
  const response = withDeveloperApiHeaders(new Response('{}'), request, env);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://theme.example.test');
  assert.equal(response.headers.get('x-nstatus-api-version'), 'v1');
}
console.log('developer API tests passed');
