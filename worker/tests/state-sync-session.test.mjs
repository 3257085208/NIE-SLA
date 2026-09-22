import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createR2StateSyncSession, mergeR2StateUpdates, readR2State } from '../src/storage.js';
import { commitR2StateSync } from '../src/probe.js';

function mockEnv() {
  const meta = new Map();
  const queries = [];
  const objects = new Map();
  return {
    meta,
    queries,
    objects,
    DB: {
      prepare(sql) {
        queries.push(sql);
        return {
          bind(...args) { this.args = args; return this; },
          async run() {
            if (/INSERT INTO app_meta/.test(sql)) {
              const existing = meta.get(this.args[0]);
              if (existing && /ON CONFLICT/.test(sql)) {
                const expiry = Number(String(existing).split(':')[0]);
                const now = Number(this.args[2]);
                if (!(expiry < now)) return {};
              }
              meta.set(this.args[0], this.args[1]);
            } else if (/DELETE FROM app_meta/.test(sql)) {
              if (meta.get(this.args[0]) === this.args[1]) meta.delete(this.args[0]);
            }
            return {};
          },
          async first() {
            if (/SELECT value FROM app_meta/.test(sql)) return meta.has(this.args[0]) ? { value: meta.get(this.args[0]) } : null;
            return null;
          },
          async all() { return { results: [] }; },
        };
      },
    },
    ARCHIVE: {
      async get(key) {
        const body = objects.get(key);
        return body == null ? null : { async json() { return JSON.parse(body); } };
      },
      async put(key, body) { objects.set(key, String(body)); return { size: String(body).length }; },
    },
  };
}

const lockInserts = (env) => env.queries.filter(sql => /INSERT INTO app_meta/.test(sql)).length;
const lockDeletes = (env) => env.queries.filter(sql => /DELETE FROM app_meta/.test(sql)).length;

test('one round merges history and fast-status updates with a single R2 lock', async () => {
  const env = mockEnv();
  const session = createR2StateSyncSession();
  session.add([{ target_id: 't1', checked_at: 600, history_checked_at: 600, ok: 1 }]);
  session.add([{ target_id: 't1', checked_at: 660, ok: 0 }]);
  session.add([{ target_id: 't2', checked_at: 660, ok: 1 }]);
  assert.equal(session.size, 3);

  const schedulingView = { targets: {} };
  session.applyOverlay(schedulingView);
  assert.equal(schedulingView.targets.t1.checked_at, 660, 'the fast-status update must win the scheduling view');
  assert.equal(schedulingView.targets.t1.history_checked_at, 600, 'the overlay must keep the history marker');
  assert.equal(schedulingView.targets.t1.ok, 0);
  assert.equal(schedulingView.targets.t2.ok, 1);

  const outcome = await commitR2StateSync(env, session);
  assert.equal(outcome.ok, true);
  assert.equal(lockInserts(env), 1, 'the lock must be acquired once per round');
  assert.equal(lockDeletes(env), 1, 'the lock must be released once per round');
  const state = await readR2State(env);
  assert.equal(state.targets.t1.checked_at, 660);
  assert.equal(state.targets.t1.history_checked_at, 600);
  assert.equal(state.targets.t1.ok, 0);
  assert.equal(state.targets.t2.checked_at, 660);
});

test('a session commit matches two sequential merges without extra lock churn', async () => {
  const sequential = mockEnv();
  const historyUpdates = [{ target_id: 't1', checked_at: 600, history_checked_at: 600, ok: 1 }];
  const fastUpdates = [{ target_id: 't1', checked_at: 660, ok: 0 }, { target_id: 't1', checked_at: 600, ok: 0 }];
  await mergeR2StateUpdates(sequential, historyUpdates);
  await mergeR2StateUpdates(sequential, fastUpdates);
  assert.equal(lockInserts(sequential), 2);

  const batched = mockEnv();
  const session = createR2StateSyncSession();
  session.add(historyUpdates);
  session.add(fastUpdates);
  await commitR2StateSync(batched, session);

  const expected = await readR2State(sequential);
  const actual = await readR2State(batched);
  assert.equal(actual.targets.t1.checked_at, expected.targets.t1.checked_at);
  assert.equal(actual.targets.t1.history_checked_at, expected.targets.t1.history_checked_at);
  assert.equal(actual.targets.t1.ok, expected.targets.t1.ok);
  assert.equal(lockInserts(batched), 1, 'the batched round must pay one lock');
});

test('an empty round skips the lock and the R2 rewrite entirely', async () => {
  const env = mockEnv();
  const outcome = await commitR2StateSync(env, createR2StateSyncSession());
  assert.equal(outcome.skipped, true);
  assert.equal(lockInserts(env), 0);
  assert.equal(lockDeletes(env), 0);
  assert.equal(env.objects.size, 0);
});

test('a failed lock acquisition reports the existing state sync warning', async () => {
  const env = mockEnv();
  env.meta.set('r2_state_lock', '9999999999:foreign-token');
  const session = createR2StateSyncSession();
  session.add([{ target_id: 't1', checked_at: 600, ok: 1 }]);
  const outcome = await commitR2StateSync(env, session);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.warning, 'r2_state_sync_failed');
  assert.equal(env.objects.size, 0, 'a failed merge must not rewrite the state object');
});

console.log('state sync session tests passed');
