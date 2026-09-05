import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAdminSession } from '../src/totp.js';
import { handleRequest } from '../src/routes.js';
import { ensureV6Schema } from '../src/admin/schema.js';

function d1(db) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async run() {
          const result = db.prepare(sql).run(...values);
          return { success: true, meta: { changes: Number(result.changes || 0) } };
        },
        async all() { return { results: db.prepare(sql).all(...values) }; },
        async first() { return db.prepare(sql).get(...values) || null; },
      };
    },
  };
}

const database = new DatabaseSync(':memory:');
const env = { DB: d1(database), RATE_LIMIT_D1: true };
await ensureV6Schema(env);
const adminSession = await createAdminSession(env, { subject: 'test-owner' });
const adminHeaders = { 'x-admin-session': adminSession.session_id, 'cf-connecting-ip': '198.51.100.21' };

const issuedResponse = await handleRequest(new Request('https://status.example/api/debug/usage-access-token', {
  method: 'POST',
  headers: adminHeaders,
}), env);
assert.equal(issuedResponse.status, 201);
const issued = await issuedResponse.json();
assert.match(issued.access_token, /^nsu_[a-f0-9]{64}$/);

const statusResponse = await handleRequest(new Request('https://status.example/api/debug/usage-access-token', {
  headers: adminHeaders,
}), env);
assert.equal(statusResponse.status, 200);
assert.equal('access_token' in await statusResponse.json(), false);

const bearerHeaders = { authorization: `Bearer ${issued.access_token}`, 'cf-connecting-ip': '198.51.100.22' };
const summaryResponse = await handleRequest(new Request('https://status.example/api/debug/usage-summary?hours=24', {
  headers: bearerHeaders,
}), env);
assert.equal(summaryResponse.status, 200);
assert.equal(summaryResponse.headers.get('x-nie-sla-debug-cost'), 'one-bounded-d1-aggregate');
assert.equal((await summaryResponse.json()).complete, true);
assert.equal(database.prepare('SELECT COUNT(*) AS count FROM rate_limits').get().count, 0, 'the nsu_ summary read must not create a D1 rate-limit write');

await assert.rejects(
  handleRequest(new Request('https://status.example/api/debug/logs', { headers: bearerHeaders }), env),
  (error) => error?.status === 401,
  'the narrow credential must not read raw logs',
);
await assert.rejects(
  handleRequest(new Request('https://status.example/api/debug/usage-access-token', { method: 'POST', headers: bearerHeaders }), env),
  (error) => error?.status === 401,
  'the narrow credential must not issue another credential',
);
await assert.rejects(
  handleRequest(new Request('https://status.example/api/debug/usage-summary', {
    headers: { ...bearerHeaders, 'x-admin-session': 'not-a-valid-admin-session' },
  }), env),
  (error) => error?.status === 401,
  'an invalid administrator header must not silently fall back to a bearer token',
);

const revokedResponse = await handleRequest(new Request('https://status.example/api/debug/usage-access-token', {
  method: 'DELETE',
  headers: adminHeaders,
}), env);
assert.equal(revokedResponse.status, 200);
assert.equal((await revokedResponse.json()).revoked_count, 1);
await assert.rejects(
  handleRequest(new Request('https://status.example/api/debug/usage-summary', { headers: bearerHeaders }), env),
  (error) => error?.status === 401,
  'revocation must take effect before the next summary request',
);

console.log('usage summary access route tests passed');
