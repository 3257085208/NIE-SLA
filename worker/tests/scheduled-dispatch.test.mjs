import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { resolveScheduledRunnerMode } from '../src/index.js';

test('scheduled runs stay on the Worker path unless the DO runner is explicitly enabled', () => {
  assert.equal(resolveScheduledRunnerMode({}), 'worker');
  assert.equal(resolveScheduledRunnerMode({ INTERNAL_CRON_SECRET: 'test-secret', REGION_PROXY: {} }), 'worker');
  assert.equal(resolveScheduledRunnerMode({ INTERNAL_CRON_SECRET: 'test-secret', REGION_PROXY: {}, SCHEDULED_RUNNER_DO: 'false' }), 'worker');
  assert.equal(resolveScheduledRunnerMode({ INTERNAL_CRON_SECRET: 'test-secret', REGION_PROXY: {}, SCHEDULED_RUNNER_DO: 'true' }), 'durable');
  assert.equal(resolveScheduledRunnerMode({ SCHEDULED_RUNNER_DO: 'true' }), 'worker');
  assert.equal(resolveScheduledRunnerMode({ INTERNAL_CRON_SECRET: 'test-secret', SCHEDULED_RUNNER_DO: 'true' }), 'worker');
});

test('cron delegates to the internal Worker endpoint when the DO runner is disabled', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  };
  try {
    let pending;
    await worker.scheduled(
      { cron: '* * * * *' },
      {
        INTERNAL_CRON_SECRET: 'test-secret',
        PUBLIC_WORKER_URL: 'https://example.test',
        SCHEDULED_RUNNER_DO: 'false',
        REGION_PROXY: {},
      },
      { waitUntil: (promise) => { pending = promise; } },
    );
    await pending;
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/internal\/scheduled$/);
    assert.match(calls[0].init.headers.authorization, /^Bearer \d+\.[0-9a-f]{64}$/);
    assert.equal(calls[0].init.headers['x-nie-sla-cron'], '* * * * *');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the internal scheduled endpoint rejects unsigned requests', async () => {
  const response = await worker.fetch(
    new Request('https://example.test/api/internal/scheduled', {
      method: 'POST',
      headers: { 'x-nie-sla-cron': '* * * * *' },
    }),
    { INTERNAL_CRON_SECRET: 'test-secret' },
  );
  assert.equal(response.status, 404);
});

test('the internal scheduled endpoint accepts a signed request', async () => {
  const secret = 'test-secret';
  const timestamp = Math.floor(Date.now() / 1000);
  const cron = '* * * * *';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}:${cron}`));
  const signature = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const response = await worker.fetch(
    new Request('https://example.test/api/internal/scheduled', {
      method: 'POST',
      headers: { authorization: `Bearer ${timestamp}.${signature}`, 'x-nie-sla-cron': cron },
    }),
    { INTERNAL_CRON_SECRET: secret },
  );
  assert.equal(response.status, 204);
});

