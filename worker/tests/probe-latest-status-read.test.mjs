import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readLatestStatusMap } from '../src/probe.js';

function dbEnv() {
  const queries = [];
  return {
    queries,
    env: {
      DB: {
        prepare(sql) {
          queries.push(sql);
          return {
            bind() { return this; },
            async all() { return { results: [{ target_id: 't1', checked_at: 1, ok: 1 }] }; },
            async first() { return null; },
          };
        },
      },
    },
  };
}

test('a disabled D1 mirror skips every latest_status read', async () => {
  const { env, queries } = dbEnv();
  const map = await readLatestStatusMap({ ...env, PROBE_LATEST_STATUS_TO_D1: 'false' }, ['t1', 't2']);
  assert.equal(map.size, 0);
  assert.equal(queries.length, 0, 'no SQL may run when latest_status can never be newer than the R2 state');
});

test('enabled and default configurations keep the latest_status read behavior', async () => {
  const enabled = dbEnv();
  const enabledMap = await readLatestStatusMap({ ...enabled.env, PROBE_LATEST_STATUS_TO_D1: 'true' }, ['t1']);
  assert.equal(enabledMap.get('t1').checked_at, 1);
  assert.match(enabled.queries[0], /FROM latest_status/);

  const fallback = dbEnv();
  const fallbackMap = await readLatestStatusMap(fallback.env, ['t1']);
  assert.equal(fallbackMap.get('t1').checked_at, 1);
  assert.match(fallback.queries[0], /FROM latest_status/);
});

test('a missing D1 binding still degrades to an empty map', async () => {
  const map = await readLatestStatusMap({}, ['t1']);
  assert.equal(map.size, 0);
});

console.log('probe latest_status read tests passed');
