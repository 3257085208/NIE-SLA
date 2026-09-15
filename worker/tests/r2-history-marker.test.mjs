import assert from 'node:assert/strict';
import { mergeR2StateUpdates, readR2State } from '../src/storage.js';
import { lastPersistedCheckAt } from '../src/utils.js';

const meta = new Map();
const db = {
  prepare(sql) {
    return {
      bind(...args) { this.args = args; return this; },
      async run() {
        if (/INSERT INTO app_meta/.test(sql)) meta.set(this.args[0], this.args[1]);
        if (/DELETE FROM app_meta/.test(sql)) meta.delete(this.args[0]);
        return {};
      },
      async first() {
        if (/SELECT value FROM app_meta/.test(sql)) return { value: meta.get(this.args[0]) };
        return null;
      },
      async all() { return { results: [] }; },
    };
  },
};

const objects = new Map();
const archive = {
  async get(key) {
    const body = objects.get(key);
    if (body == null) return null;
    return { json: async () => JSON.parse(body) };
  },
  async put(key, body) { objects.set(key, body); return { size: body.length }; },
  async head(key) { return objects.has(key) ? { size: (objects.get(key) || '').length } : null; },
};

const env = { DB: db, ARCHIVE: archive };

await mergeR2StateUpdates(env, [{ target_id: 't1', checked_at: 600, history_checked_at: 600, ok: 1 }]);
await mergeR2StateUpdates(env, [{ target_id: 't1', checked_at: 1200, ok: 1 }]);

const state = await readR2State(env);
const target = state.targets.t1;
assert.equal(target.checked_at, 1200, 'the newer fast-status update must win checked_at');
assert.equal(target.history_checked_at, 600, 'the fast-status update must preserve the dedicated history marker');

await mergeR2StateUpdates(env, [{ target_id: 't1', checked_at: 1800, history_checked_at: 1800, ok: 1 }]);
const advanced = (await readR2State(env)).targets.t1;
assert.equal(advanced.checked_at, 1800, 'the newer history update must win checked_at');
assert.equal(advanced.history_checked_at, 1800, 'the history marker must advance with history probes');

const gate = lastPersistedCheckAt({ last_checked_at: 0 }, null, advanced.history_checked_at);
assert.equal(gate, 1800, 'the history gate must read the dedicated marker, not the fast-status timestamp');

console.log('r2 history marker tests passed');
