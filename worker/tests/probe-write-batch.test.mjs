import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyProbeWriteBatch } from '../src/admin/check-buckets.js';

function mockEnv() {
  let batchCalls = 0;
  const statement = {
    bind() { return this; },
    async run() { return { meta: { changes: 1 } }; },
  };
  return {
    get batchCalls() { return batchCalls; },
    DB: {
      prepare() { return statement; },
      async batch() { batchCalls += 1; return []; },
    },
    PROBE_HISTORY_BUFFER: 'false',
    PROBE_LATEST_STATUS_TO_D1: 'false',
    TARGET_SCHEDULE_FLUSH_SEC: '21600',
    TIMEZONE_OFFSET_MINUTES: '480',
  };
}

test('region batches can defer D1 statements into one collector', async () => {
  const env = mockEnv();
  const collector = [];
  const result = await applyProbeWriteBatch(
    env,
    'vps-a',
    1794159300,
    [{ day: '2026-11-09', point: { checked_at: 1794159300, ok: 1, latency_ms: 10, total: 1, ok_count: 1 } }],
    null,
    null,
    1794160200,
    true,
    { statementCollector: collector },
  );
  assert.equal(result.ok, true);
  assert.equal(result.deferred, true);
  assert.ok(collector.length > 0);
  assert.equal(env.batchCalls, 0);
});

test('region batches still execute directly without a collector', async () => {
  const env = mockEnv();
  const result = await applyProbeWriteBatch(
    env,
    'vps-a',
    1794159300,
    [{ day: '2026-11-09', point: { checked_at: 1794159300, ok: 1, latency_ms: 10, total: 1, ok_count: 1 } }],
    null,
    null,
    1794160200,
    true,
  );
  assert.equal(result.ok, true);
  assert.equal(result.deferred, undefined);
  assert.equal(env.batchCalls, 1);
});
