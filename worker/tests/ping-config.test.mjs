import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPingTarget, getPingTargets, updatePingTarget } from '../src/admin/ping-targets.js';
import { getPingIntervalSec, updatePingConfig } from '../src/ping-config.js';
import { ensureV6Schema } from '../src/admin/schema.js';

globalThis.crypto ||= webcrypto;

const database = new DatabaseSync(':memory:');
const env = { DB: d1(database) };
await ensureV6Schema(env);

assert.equal(await getPingIntervalSec(env), 20);
const saved = await updatePingConfig(jsonRequest({ ping_interval_sec: 1 }), env);
assert.equal(saved.ping_interval_sec, 1);
assert.equal(saved.min_interval_sec, 1);
assert.equal(saved.max_interval_sec, 300);
assert.equal(saved.one_second_max_targets, 5);

for (let index = 1; index <= 5; index++) {
  await createPingTarget(jsonRequest({ id: `target-${index}`, name: `Target ${index}`, target: `127.0.0.1:${index}` }), env);
}
await assert.rejects(
  createPingTarget(jsonRequest({ id: 'target-6', name: 'Target 6', target: '127.0.0.1:6' }), env),
  /最多允许启用 5 个目标/,
);
await updatePingTarget('target-5', jsonRequest({ enabled: false }), env);
await createPingTarget(jsonRequest({ id: 'target-6', name: 'Target 6', target: '127.0.0.1:6' }), env);
await assert.rejects(updatePingTarget('target-5', jsonRequest({ enabled: true }), env), /最多允许启用 5 个目标/);

const payload = await getPingTargets(env, { enabledOnly: false });
assert.equal(payload.ping_interval_sec, 1);
assert.equal(payload.targets.length, 6);
await assert.rejects(updatePingConfig(jsonRequest({ ping_interval_sec: 0 }), env), /1-300 秒/);
await assert.rejects(updatePingConfig(jsonRequest({ ping_interval_sec: 301 }), env), /1-300 秒/);
await assert.rejects(updatePingConfig(jsonRequest({ ping_interval_sec: 1.5 }), env), /1-300 秒/);

await updatePingConfig(jsonRequest({ ping_interval_sec: 20 }), env);
await updatePingTarget('target-5', jsonRequest({ enabled: true }), env);
await assert.rejects(updatePingConfig(jsonRequest({ ping_interval_sec: 1 }), env), /请先禁用多余目标/);

console.log('Ping configuration tests passed');

function jsonRequest(body) {
  return new Request('https://api.example.test/api/ping-config', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function d1(db) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async run() { return db.prepare(sql).run(...values); },
        async all() { return { results: db.prepare(sql).all(...values) }; },
        async first() { return db.prepare(sql).get(...values) || null; },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}
