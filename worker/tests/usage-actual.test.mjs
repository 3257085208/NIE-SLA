import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveUsageActualConfig, fetchActualUsage, getUsageActualConfig } from '../src/admin/usage-actual.js';

// Placeholder ids only. This test ships to the public repository and the
// public-repo safety scan rejects real Cloudflare account/database UUIDs.
const OWN_DB_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_DB_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_TAG = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN = 'tok_abcdefgh12345678';

function mockEnv(extra = {}) {
  const meta = new Map();
  const row = (value) => ({ value });
  return {
    meta,
    ...extra,
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

function installFetch(d1Groups) {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: {
        viewer: {
          accounts: [{
            workers: [{ sum: { requests: 777, errors: 0 } }],
            d1: d1Groups,
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
}

const BOTH_GROUPS = [
  {
    dimensions: { databaseId: OWN_DB_ID },
    sum: { rowsWritten: 42, rowsRead: 4200, readQueries: 100, writeQueries: 10 },
  },
  {
    dimensions: { databaseId: SECOND_DB_ID },
    sum: { rowsWritten: 7, rowsRead: 700, readQueries: 20, writeQueries: 5 },
  },
];

const SINGLE_GROUP = [BOTH_GROUPS[0]];

test('save then read keeps the token (round-trip)', async () => {
  installFetch(BOTH_GROUPS);
  const env = mockEnv();
  await saveUsageActualConfig(env, { apiToken: TOKEN, accountTag: ACCOUNT_TAG });
  const config = await getUsageActualConfig(env);
  assert.equal(config.configured, true);
  assert.equal(config.account_tag, ACCOUNT_TAG);
  const result = await fetchActualUsage(env, 24);
  assert.equal(result.ok, true, `expected ok, got: ${JSON.stringify(result)}`);
  assert.equal(result.actual.d1_rows_written, 49);
  assert.equal(result.actual.d1_queries, 135);
  assert.equal(result.actual_account.d1_rows_written, 49);
  assert.equal(result.actual_account.d1_queries, 135);
  assert.equal(result.d1_scope, 'account');
  assert.deepEqual(result.d1_by_database.map((row) => row.database_id), [OWN_DB_ID, SECOND_DB_ID]);
  assert.equal(result.actual.do_wall_time_sec, 456);
  assert.equal(result.actual.workers_calls, 777);
  assert.equal(result.actual.r2_class_a, 9);
  assert.equal(result.actual.r2_class_b, 90);
  assert.equal(result.actual.r2_requests, 99);
});

test('configured USAGE_D1_DATABASE_IDS filters the own-database total', async () => {
  installFetch(BOTH_GROUPS);
  const env = mockEnv({ USAGE_D1_DATABASE_IDS: ` ${OWN_DB_ID} , ` });
  await saveUsageActualConfig(env, { apiToken: TOKEN, accountTag: ACCOUNT_TAG });
  const result = await fetchActualUsage(env, 24);
  assert.equal(result.ok, true);
  assert.equal(result.actual.d1_rows_written, 42);
  assert.equal(result.actual.d1_queries, 110);
  assert.equal(result.actual_account.d1_rows_written, 49);
  assert.equal(result.d1_scope, 'configured');
  assert.deepEqual(result.d1_database_ids, [OWN_DB_ID]);
});

test('single-database accounts fall back to that database', async () => {
  installFetch(SINGLE_GROUP);
  const env = mockEnv();
  await saveUsageActualConfig(env, { apiToken: TOKEN, accountTag: ACCOUNT_TAG });
  const result = await fetchActualUsage(env, 24);
  assert.equal(result.ok, true);
  assert.equal(result.actual.d1_rows_written, 42);
  assert.equal(result.d1_scope, 'single');
  assert.deepEqual(result.d1_database_ids, [OWN_DB_ID]);
});

test('unconfigured account reports a clear error, not a crash', async () => {
  const result = await fetchActualUsage(mockEnv(), 24);
  assert.equal(result.ok, false);
  assert.match(result.error, /尚未配置/);
});

test('invalid account id is rejected on save', async () => {
  await assert.rejects(() => saveUsageActualConfig(mockEnv(), { apiToken: TOKEN, accountTag: 'nothex' }), /Account ID/);
});
