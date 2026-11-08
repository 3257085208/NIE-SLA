import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimMaintenanceSlot } from '../src/index.js';

function mockEnv() {
  const rows = new Map();
  let writes = 0;
  return {
    rows,
    get writes() { return writes; },
    DB: {
      prepare(sql) {
        return {
          bind(...args) { this.args = args; return this; },
          async first() {
            if (!/SELECT value FROM app_meta/.test(sql)) return null;
            return rows.has(this.args[0]) ? { value: String(rows.get(this.args[0])) } : null;
          },
          async run() {
            if (!/INSERT INTO app_meta/.test(sql)) return { meta: { changes: 0 } };
            const [key, value] = this.args;
            const previous = Number(rows.get(key) || 0);
            if (previous >= Number(value)) return { meta: { changes: 0 } };
            rows.set(key, String(value));
            writes += 1;
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };
}

test('maintenance slots read before rewriting an unchanged marker', async () => {
  const env = mockEnv();
  assert.equal(await claimMaintenanceSlot(env, 'maintenance:hourly', 101), true);
  assert.equal(env.writes, 1);
  assert.equal(await claimMaintenanceSlot(env, 'maintenance:hourly', 101), false);
  assert.equal(env.writes, 1, 'an already claimed slot must not issue another D1 write');
  assert.equal(await claimMaintenanceSlot(env, 'maintenance:hourly', 102), true);
  assert.equal(env.writes, 2);
  assert.equal(env.rows.get('maintenance:hourly'), '102');
});

test('maintenance slot claims safely skip without a D1 binding', async () => {
  assert.equal(await claimMaintenanceSlot({}, 'maintenance:hourly', 1), false);
});

console.log('maintenance slot tests passed');
