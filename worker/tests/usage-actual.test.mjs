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
  json: async () => ({ data: { viewer: { accounts: [{ d1: [{ sum: { rowsWritten: 42, rowsRead: 4200 } }], durableObjects: [{ sum: { requests: 123, wallTime: 456_000_000 } }] }] } } }),
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
  assert.equal(result.actual.do_wall_time_sec, 456);
});

test('unconfigured account reports a clear error, not a crash', async () => {
  const result = await fetchActualUsage(mockEnv(), 24);
  assert.equal(result.ok, false);
  assert.match(result.error, /尚未配置/);
});

test('invalid account id is rejected on save', async () => {
  await assert.rejects(() => saveUsageActualConfig(mockEnv(), { apiToken: 'tok_abcdefgh12345678', accountTag: 'nothex' }), /Account ID/);
});
