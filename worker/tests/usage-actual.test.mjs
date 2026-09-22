import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveUsageActualConfig, fetchActualUsage, getUsageActualConfig } from '../src/admin/usage-actual.js';

function mockEnv() {
  const meta = new Map();
  const row = (value) => ({ value });
  return {
    meta,
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            this.args = args;
            return this;
          },
          async first() {
            if (sql.includes('SELECT value FROM app_meta')) {
              return meta.has(this.args[0]) ? row(meta.get(this.args[0])) : null;
            }
            return null;
          },
          async run() {
            if (sql.includes('INSERT INTO app_meta')) {
              meta.set(this.args[0], this.args[1]);
            }
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };
}

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    data: {
      viewer: {
        accounts: [{
          workers: [{ sum: { requests: 777, errors: 0 } }],
          d1: [
            {
              dimensions: { databaseId: '279ad7f9-0b69-49aa-90eb-c42321eda6c3' },
              sum: { rowsWritten: 42, rowsRead: 4200, readQueries: 100, writeQueries: 10 },
            },
            {
              dimensions: { databaseId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
              sum: { rowsWritten: 7, rowsRead: 700, readQueries: 20, writeQueries: 5 },
            },
          ],
          durableObjects: [{ sum: { requests: 123, wallTime: 456_000_000 } }],
          r2: [
            { dimensions: { actionType: 'PutObject' }, sum: { requests: 9 } },
            { dimensions: { actionType: 'GetObject' }, sum: { requests: 90 } },
          ],
        }],
      },
    },
  }),
});

test('save then read keeps the token (round-trip)', async () => {
  const env = mockEnv();
  await saveUsageActualConfig(env, { apiToken: 'tok_abcdefgh12345678', accountTag: '7be7fa0d9553fcb51caf34b27338f49a' });
  const config = await getUsageActualConfig(env);
  assert.equal(config.configured, true);
  assert.equal(config.account_tag, '7be7fa0d9553fcb51caf34b27338f49a');
  const result = await fetchActualUsage(env, 24);
  assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
  assert.equal(result.actual.d1_rows_written, 42);
  assert.equal(result.actual.d1_queries, 110);
  assert.equal(result.actual_account.d1_rows_written, 49);
  assert.equal(result.actual_account.d1_queries, 135);
  assert.equal(result.d1_scope, 'own');
  assert.deepEqual(result.d1_by_database.map((row) => row.database_id), [
    '279ad7f9-0b69-49aa-90eb-c42321eda6c3',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]);
  assert.equal(result.actual.do_wall_time_sec, 456);
  assert.equal(result.actual.workers_calls, 777);
  assert.equal(result.actual.r2_class_a, 9);
  assert.equal(result.actual.r2_class_b, 90);
  assert.equal(result.actual.r2_requests, 99);
});

test('unconfigured account reports a clear error, not a crash', async () => {
  const result = await fetchActualUsage(mockEnv(), 24);
  assert.equal(result.ok, false);
  assert.match(result.error, /尚未配置/);
});

test('invalid account id is rejected on save', async () => {
  await assert.rejects(() => saveUsageActualConfig(mockEnv(), { apiToken: 'tok_abcdefgh12345678', accountTag: 'nothex' }), /Account ID/);
});
