import assert from 'node:assert/strict';
import { getAdminPath, normalizeAdminPath, setAdminPath } from '../src/admin-path.js';
import { routeStaticAssets } from '../src/static-assets.js';

function memoryDb() {
  const meta = new Map();
  return {
    meta,
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (/SELECT value FROM app_meta/i.test(sql)) {
            const value = meta.get(String(this.values[0]));
            return value === undefined ? null : { value };
          }
          return null;
        },
        async run() {
          if (/INSERT INTO app_meta/i.test(sql)) meta.set(String(this.values[0]), String(this.values[1]));
          return { success: true };
        },
      };
    },
  };
}

assert.equal(normalizeAdminPath(' console-7f3a/ '), '/console-7f3a');
assert.equal(normalizeAdminPath('/api'), '/admin');
assert.throws(() => normalizeAdminPath('/api', { strict: true }), /保留路径/);
assert.throws(() => normalizeAdminPath('/ab', { strict: true }), /3-64/);

const DB = memoryDb();
const env = {
  DB,
  ADMIN_PATH: '/from-env',
  ASSETS: {
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/admin.html') {
        return new Response(null, { status: 307, headers: { location: '/admin' } });
      }
      return new Response(pathname, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  },
};

assert.equal(await getAdminPath(env), '/from-env');
assert.equal(await setAdminPath(env, '/console-7f3a'), '/console-7f3a');
assert.equal(await getAdminPath(env), '/console-7f3a');

const custom = await routeStaticAssets(new Request('https://status.example/console-7f3a'), env);
assert.equal(custom.status, 200);
assert.equal(await custom.text(), '/admin');
assert.equal(custom.headers.get('location'), null, 'admin routing must not return the Static Assets canonical redirect');
assert.equal(custom.headers.get('cache-control'), 'no-store');
assert.equal(custom.headers.get('x-frame-options'), 'DENY');

const trailing = await routeStaticAssets(new Request('https://status.example/console-7f3a/'), env);
assert.equal(trailing.status, 308);
assert.equal(trailing.headers.get('location'), 'https://status.example/console-7f3a');

for (const legacy of ['/admin', '/admin/', '/admin.html']) {
  const response = await routeStaticAssets(new Request(`https://status.example${legacy}`), env);
  assert.equal(response.status, 404, `${legacy} must be hidden after changing the admin path`);
}

const stylesheet = await routeStaticAssets(new Request('https://status.example/style.css'), env);
assert.equal(await stylesheet.text(), '/style.css');

console.log('admin path tests passed');
