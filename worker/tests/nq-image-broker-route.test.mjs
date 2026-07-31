import assert from 'node:assert/strict';
import worker from '../src/index.js';

const originalFetch = globalThis.fetch;
const payload = {
  report_id: 'report-a',
  agent_id: 'vps-a',
  target_name: 'VPS A',
  tabs: [{ id: 'network', content: 'Network OK' }],
};

try {
  let uploadCount = 0;
  globalThis.fetch = async (_url, options) => {
    uploadCount += 1;
    assert.equal(options.body.get('file').type, 'image/svg+xml');
    return Response.json([{ src: '/public/route-test.svg' }]);
  };

  const disabled = await worker.fetch(brokerRequest(payload), brokerEnv({ NQ_PUBLIC_BROKER_ENABLED: 'false' }), {});
  assert.equal(disabled.status, 404);
  assert.equal(disabled.headers.get('cache-control'), 'no-store');
  assert.equal(uploadCount, 0);

  const unsupported = await worker.fetch(new Request('https://official.example/api/nq/image-broker', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data', 'cf-connecting-ip': '198.51.100.10' },
    body: 'file=<svg/>',
  }), brokerEnv(), {});
  assert.equal(unsupported.status, 415);
  assert.equal(unsupported.headers.get('cache-control'), 'no-store');
  assert.equal(uploadCount, 0);

  const tooLarge = await worker.fetch(brokerRequest({ ...payload, tabs: [{ id: 'network', content: 'x'.repeat(130 * 1024) }] }), brokerEnv(), {});
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.headers.get('cache-control'), 'no-store');
  assert.equal(uploadCount, 0);

  const limitedDb = rateLimitDb({ denyKey: 'nq-broker:global' });
  const limited = await worker.fetch(brokerRequest(payload), brokerEnv({ DB: limitedDb }), {});
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('cache-control'), 'no-store');
  assert.equal(uploadCount, 0);
  assert.ok(limitedDb.keys.includes('nq-broker:ip:198.51.100.10'));
  assert.ok(limitedDb.keys.includes('nq-broker:global'));

  const successEnv = brokerEnv();
  const success = await worker.fetch(brokerRequest(payload), successEnv, {});
  assert.equal(success.status, 200);
  assert.equal(success.headers.get('cache-control'), 'no-store');
  assert.equal(success.headers.get('access-control-allow-origin'), 'https://status.example');
  const successBody = await success.json();
  assert.equal(successBody.ok, true);
  assert.deepEqual(successBody.images, [{ id: 'network', url: 'https://img.example.com/public/route-test.svg' }]);
  assert.equal(JSON.stringify(successBody).includes(successEnv.NQ_IMGBED_TOKEN), false);
  assert.equal(uploadCount, 1);

  globalThis.fetch = async () => new Response('private upstream details', { status: 401 });
  const failedEnv = brokerEnv();
  const failed = await worker.fetch(brokerRequest(payload), failedEnv, {});
  assert.equal(failed.status, 502);
  assert.equal(failed.headers.get('cache-control'), 'no-store');
  const failedText = await failed.text();
  assert.doesNotMatch(failedText, /private upstream|img\.example\.com|server-only-token/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('NQ image broker route tests passed');

function brokerRequest(body) {
  return new Request('https://official.example/api/nq/image-broker', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.10' },
    body: JSON.stringify(body),
  });
}

function brokerEnv(overrides = {}) {
  return {
    DB: rateLimitDb(),
    NQ_PUBLIC_BROKER_ENABLED: 'true',
    NQ_IMGBED_URL: 'https://img.example.com/upload',
    NQ_IMGBED_TOKEN: 'server-only-token',
    ALLOWED_ORIGIN: 'https://status.example',
    ...overrides,
  };
}

function rateLimitDb(options = {}) {
  const counts = new Map();
  const keys = [];
  return {
    keys,
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async run() {
          if (/INSERT INTO rate_limits/i.test(sql)) {
            const key = String(this.values[0]);
            keys.push(key);
            if (key === options.denyKey) return { meta: { changes: 0 } };
            const count = counts.get(key) || 0;
            const limit = Number(this.values[4]);
            if (count >= limit) return { meta: { changes: 0 } };
            counts.set(key, count + 1);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
    },
  };
}
