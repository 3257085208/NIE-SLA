import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordProbeResult } from '../src/index.js';

function mockEnv() {
  const rows = new Map();
  let writes = 0;
  return {
    rows,
    get writes() { return writes; },
    env: {
      DB: {
        prepare(sql) {
          return {
            bind(...args) { this.args = args; return this; },
            async first() {
              if (/SELECT value, updated_at FROM app_meta/.test(sql)) {
                const row = rows.get(this.args[0]);
                return row ? { value: row.value, updated_at: row.updated_at } : null;
              }
              return null;
            },
            async run() {
              if (/INSERT INTO app_meta/.test(sql)) {
                writes += 1;
                rows.set(this.args[0], { value: this.args[1], updated_at: this.args[2] });
              }
              return {};
            },
          };
        },
      },
    },
  };
}

const probe = { ok: true, count: 5, results: [{ ok: true }, { ok: true }] };

test('recordProbeResult only moves on failure, change, or the 300s heartbeat', async () => {
  const mock = mockEnv();
  await recordProbeResult(mock.env, '* * * * *', probe, null, 1200);
  assert.equal(mock.writes, 1, 'the first observation must be recorded');
  const first = mock.rows.get('scheduled:probe:last');

  await recordProbeResult(mock.env, '* * * * *', probe, null, 900);
  assert.equal(mock.writes, 1, 'an unchanged healthy round must not rewrite the mirror');

  await recordProbeResult(mock.env, '* * * * *', probe, 'probe exploded', 900);
  assert.equal(mock.writes, 2, 'a failed run must always move the mirror');

  await recordProbeResult(mock.env, '* * * * *', probe, null, 900);
  assert.equal(mock.writes, 3, 'recovery must be recorded even when the summary matches again');

  await recordProbeResult(mock.env, '* * * * *', { ...probe, count: 6 }, null, 900);
  assert.equal(mock.writes, 4, 'a changed run count must be recorded');

  const last = mock.rows.get('scheduled:probe:last');
  mock.rows.set('scheduled:probe:last', { value: last.value, updated_at: first.updated_at - 400 });
  await recordProbeResult(mock.env, '* * * * *', { ...probe, count: 6 }, null, 900);
  assert.equal(mock.writes, 5, 'the 300s heartbeat must refresh the mirror');
});

test('recordProbeResult skips entirely without a D1 binding', async () => {
  await recordProbeResult({}, '* * * * *', probe, null, 1200);
});

console.log('probe run record tests passed');
