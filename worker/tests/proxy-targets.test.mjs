import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  createProxyTarget,
  deleteProxyTarget,
  getAgentProxyTargets,
  getCachedProxyControl,
  getProxyControlRows,
  listProxyTargets,
  normalizePublicProxyChecks,
  normalizePublicProxyTargets,
  updateProxyTarget,
} from '../src/admin/proxy-targets.js';
import { normalizeAgentProxyChecks } from '../src/metrics.js';
import { ensureV6Schema } from '../src/admin/schema.js';

globalThis.crypto ||= webcrypto;

const database = new DatabaseSync(':memory:');
const env = {
  DB: d1(database),
  TOTP_ENCRYPTION_KEY: 'test-only-encryption-key-with-at-least-32-bytes',
};
await ensureV6Schema(env);
const now = Math.floor(Date.now() / 1000);
database.prepare(`INSERT INTO targets
  (id, name, group_name, type, target_host, target_port, timeout_ms, interval_sec, probe_region, enabled, created_at, updated_at)
  VALUES (?, ?, 'VPS', 'tcp', '203.0.113.10', 443, 5000, 300, 'auto', 1, ?, ?)`)
  .run('agent-a', 'Agent A', now, now);

await createProxyTarget(jsonRequest({
  id: 'vless-main',
  agent_id: 'agent-a',
  name: 'VLESS main',
  protocol: 'vless',
  server: 'proxy.example.test',
  port: 443,
  transport: 'tls-ws',
  sni: 'proxy.example.test',
  ws_path: '/vless',
  ws_host: 'proxy.example.test',
  secret: { uuid: '8c7f969f-0000-4000-8000-000000000001' },
}), env);

const listed = await listProxyTargets(env);
assert.equal(listed.targets.length, 1);
assert.equal(listed.targets[0].secret_configured, true);
assert.equal('secret' in listed.targets[0], false, 'admin list must never expose proxy credentials');

const agentTargets = await getAgentProxyTargets(env, 'agent-a');
assert.equal(agentTargets[0].secret.uuid, '8c7f969f-0000-4000-8000-000000000001');
assert.equal('_secret_ciphertext' in agentTargets[0], false, 'Agent control response must not expose internal ciphertext');

const internalRows = await getProxyControlRows(env, 'agent-a');
assert.match(internalRows[0].secret_ciphertext, /^enc:v1:/);
const cached = await getCachedProxyControl(env, internalRows, 'agent-a');
assert.equal(cached[0].secret.uuid, agentTargets[0].secret.uuid);
assert.equal('_secret_ciphertext' in cached[0], false, 'materialized control must not expose internal ciphertext');

await updateProxyTarget('vless-main', jsonRequest({ name: 'VLESS renamed', secret: {} }), env);
assert.equal((await getAgentProxyTargets(env, 'agent-a'))[0].secret.uuid, '8c7f969f-0000-4000-8000-000000000001');
await assert.rejects(
  createProxyTarget(jsonRequest({
    id: 'bad-socks', agent_id: 'agent-a', name: 'Bad SOCKS', protocol: 'socks5',
    server: 'proxy.example.test', port: 1080, transport: 'ws', secret: {},
  }), env),
  /SOCKS5.*TCP/,
);

const checks = normalizeAgentProxyChecks([{
  target_id: 'vless-main', name: 'VLESS renamed', protocol: 'vless', ts: now,
  latency_ms: 42.7, handshake_ms: 12.2, first_byte_ms: 30.5, total_ms: 42.7,
  ok: true, stage: 'canary', error: null,
}], now);
assert.deepEqual(checks[0], {
  target_id: 'vless-main', name: 'VLESS renamed', protocol: 'vless', ts: now,
  latency_ms: 43, handshake_ms: 12, first_byte_ms: 31, total_ms: 43,
  ok: 1, stage: 'canary', error: null,
});
assert.equal(normalizePublicProxyChecks(checks, now)[0].stale, false);
assert.equal(normalizePublicProxyChecks([{ ...checks[0], ts: now - 901 }], now)[0].stale, true);
const publicTargets = normalizePublicProxyTargets([{
  id: 'vless-main', name: 'VLESS renamed', protocol: 'VLESS', transport: 'TLS-WS',
  server: 'proxy.example.test', port: 443, sni: 'secret.example.test',
  secret: { uuid: '8c7f969f-0000-4000-8000-000000000001', password: 'secret' },
}]);
assert.deepEqual(publicTargets, [{ target_id: 'vless-main', name: 'VLESS renamed', protocol: 'vless', transport: 'tls-ws' }]);
assert.equal('server' in publicTargets[0], false, 'public proxy metadata must not expose the endpoint');
assert.equal(normalizePublicProxyTargets([{ id: 'invalid', name: 'invalid', protocol: 'unknown', transport: 'tcp' }]).length, 0, 'unknown protocol metadata must be rejected');
assert.equal(normalizeAgentProxyChecks([{
  ...checks[0], stage: 'attacker-controlled', error: 'proxy.example.test:443/secret',
}], now)[0].stage, 'canary');
assert.equal(normalizeAgentProxyChecks([{
  ...checks[0], stage: 'attacker-controlled', error: 'proxy.example.test:443/secret',
}], now)[0].error, null);

await createProxyTarget(jsonRequest({
  id: 'http-main', agent_id: 'agent-a', name: 'ZZ HTTP', protocol: 'http',
  server: 'http.example.test', port: 8080, transport: 'tcp', secret: { username: 'u', password: 'p' },
}), env);
assert.equal((await listProxyTargets(env)).targets.some((target) => target.protocol === 'http'), true);
assert.equal(normalizeAgentProxyChecks([{
  target_id: 'http-main', name: 'ZZ HTTP', protocol: 'http', ts: now, latency_ms: 9, ok: true,
}], now)[0].protocol, 'http');

await deleteProxyTarget('vless-main', env);
await deleteProxyTarget('http-main', env);
assert.equal((await listProxyTargets(env)).targets.length, 0);

console.log('proxy target storage and credential boundary passed');

function jsonRequest(body) {
  return new Request('https://api.example.test/api/proxy-targets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
