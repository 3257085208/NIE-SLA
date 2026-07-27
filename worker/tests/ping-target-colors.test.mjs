import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPingTarget, getPingTargets, updatePingTarget } from '../src/admin/ping-targets.js';
import { ensureV6Schema } from '../src/admin/schema.js';

globalThis.crypto ||= webcrypto;

const database = new DatabaseSync(':memory:');
const env = { DB: d1(database) };
await ensureV6Schema(env);

const created = await createPingTarget(jsonRequest({
  id: 'cloudflare-dns',
  name: 'Cloudflare DNS',
  target: '1.1.1.1:53',
  color: '#33AA66',
}), env);
assert.equal(created.ok, true);
assert.equal((await getPingTargets(env)).targets[0].color, '#33aa66');

await updatePingTarget('cloudflare-dns', jsonRequest({ color: '#2457d6' }), env);
assert.equal(database.prepare(`SELECT color FROM ping_targets WHERE id = ?`).get('cloudflare-dns').color, '#2457d6');

await assert.rejects(
  createPingTarget(jsonRequest({ id: 'bad', name: 'Bad', target: '127.0.0.1:1', color: 'red' }), env),
  /颜色必须是 #RRGGBB 格式/,
);

console.log('Ping target color tests passed');

function jsonRequest(body) {
  return new Request('https://api.example.test/api/ping-targets', {
    method: 'POST',
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
