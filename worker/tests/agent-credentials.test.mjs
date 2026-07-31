import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getOrCreateAgentToken, legacyScopedToken } from '../src/agent-credentials.js';
import { requireAgentForId, requireAnyAgent, requireLatencyAgentForId } from '../src/auth.js';
import { getAgentInstallCommand, getAgentInstallScript } from '../src/admin/install-command.js';
import { getLatencyAgentInstallCommand } from '../src/admin/latency-agents.js';
import { ensureV6Schema } from '../src/admin/schema.js';

globalThis.crypto ||= webcrypto;

const database = new DatabaseSync(':memory:');
const env = {
  TOTP_ENCRYPTION_KEY: 'test-only-encryption-key-with-at-least-32-bytes',
  DB: d1(database),
};
await ensureV6Schema(env);

const now = Math.floor(Date.now() / 1000);
database.prepare(`INSERT INTO targets
  (id, name, group_name, type, target_host, target_port, timeout_ms, interval_sec, probe_region, enabled, created_at, updated_at)
  VALUES (?, ?, 'VPS', 'tcp', '203.0.113.10', 443, 5000, 300, 'auto', 1, ?, ?)`)
  .run('vps-a', 'VPS A', now, now);
database.prepare(`INSERT INTO targets
  (id, name, group_name, type, target_host, target_port, timeout_ms, interval_sec, probe_region, enabled, created_at, updated_at)
  VALUES (?, ?, 'VPS', 'tcp', '203.0.113.11', 443, 5000, 300, 'auto', 1, ?, ?)`)
  .run('vps-b', 'VPS B', now, now);
database.prepare(`INSERT INTO latency_agents (id, name, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
  .run('latency-tokyo', 'Tokyo', now, now);

const token = await getOrCreateAgentToken(env, 'agent', 'vps-a');
assert.match(token, /^nst_[a-f0-9]{64}$/);
assert.equal(await getOrCreateAgentToken(env, 'agent', 'vps-a'), token, 'reopening the install command must keep the same token');

const stored = database.prepare(`SELECT token_hash, token_ciphertext FROM agent_credentials WHERE subject_type = 'agent' AND subject_id = 'vps-a'`).get();
assert.equal(stored.token_hash.length, 64);
assert.notEqual(stored.token_hash, token);
assert.doesNotMatch(stored.token_ciphertext, new RegExp(token));

assert.deepEqual(await requireAgentForId(agentRequest(token), env, 'vps-a'), { type: 'scoped', agent_id: 'vps-a' });
assert.deepEqual(await requireAnyAgent(agentRequest(token), env), { type: 'scoped', agent_id: 'vps-a' });
await assert.rejects(() => requireAgentForId(agentRequest(token), env, 'vps-b'), /未授权/);

const latencyToken = await getOrCreateAgentToken(env, 'latency', 'latency-tokyo');
assert.match(latencyToken, /^nst_[a-f0-9]{64}$/);
assert.notEqual(latencyToken, token);
assert.deepEqual(await requireLatencyAgentForId(agentRequest(latencyToken), env, 'latency-tokyo'), { type: 'scoped', node_id: 'latency-tokyo' });

const originalFetch = globalThis.fetch;
globalThis.fetch = async url => String(url).endsWith('/bin/VERSION')
  ? new Response('v1.2.3\n')
  : String(url).endsWith('/bin/SHA256SUMS')
    ? new Response('abc  nstatus-metrics-linux-amd64\n')
    : new Response('', { status: 404 });
try {
  const commandEnv = {
    ...env,
    PUBLIC_SITE_ORIGIN: 'https://status.example.test',
    PUBLIC_AGENT_API_BASE: 'https://api.example.test',
  };
  const request = new Request('https://api.example.test/admin', { headers: { origin: 'https://status.example.test' } });
  const agentCommand = await getAgentInstallCommand(
    commandEnv,
    new URL('https://api.example.test/api/agent/install-command?target_id=vps-a'),
    request,
  );
  assert.equal(agentCommand.ok, true);
  assert.equal(agentCommand.credential_bound, true);
  assert.equal(agentCommand.credential_type, 'one_time_install_token');
  assert.ok(agentCommand.linux_command.length < 360, `short install command is ${agentCommand.linux_command.length} characters`);
  assert.match(agentCommand.linux_command, /Authorization: Bearer nsi_[a-f0-9]{48}/);
  assert.match(agentCommand.linux_command, /\/api\/agent\/install-script' -o "\$t" && sh "\$t"\)$/);
  assert.doesNotMatch(agentCommand.linux_command, /NSTATUS_AGENT_TOKEN|\bnst_[a-f0-9]{32,}\b/);

  const installTicket = agentCommand.linux_command.match(/Bearer (nsi_[a-f0-9]{48})/)?.[1];
  assert.ok(installTicket);
  const storedTicket = database.prepare(`SELECT token_hash, used_at FROM agent_install_tickets WHERE target_id = 'vps-a' ORDER BY created_at DESC LIMIT 1`).get();
  assert.equal(storedTicket.token_hash.length, 64);
  assert.notEqual(storedTicket.token_hash, installTicket);
  assert.equal(storedTicket.used_at, null);

  const scriptResponse = await getAgentInstallScript(commandEnv, agentRequest(installTicket));
  assert.equal(scriptResponse.status, 200);
  assert.equal(scriptResponse.headers.get('cache-control'), 'no-store, max-age=0');
  const installScript = await scriptResponse.text();
  assert.match(installScript, new RegExp(`NSTATUS_AGENT_TOKEN='${token}'`));
  assert.match(installScript, /NSTATUS_AGENT_LABEL='VPS A'/);
  assert.match(installScript, /NSTATUS_EXPECTED_VERSION='v1\.2\.3'/);
  assert.match(installScript, /NSTATUS_INSTALLER_SHA256='[a-f0-9]{64}'/);
  assert.match(installScript, /NSTATUS_SETUP_SHA256='[a-f0-9]{64}'/);
  assert.match(installScript, /NSTATUS_CFTZ_SHA256='[a-f0-9]{64}'/);
  assert.match(installScript, /\[ "\$actual" = "\$NSTATUS_INSTALLER_SHA256" \]/);
  await assert.rejects(
    () => getAgentInstallScript(commandEnv, agentRequest(installTicket)),
    error => error?.status === 401 && /已过期或已使用/.test(error.message),
  );

  const expiringCommand = await getAgentInstallCommand(
    commandEnv,
    new URL('https://api.example.test/api/agent/install-command?target_id=vps-a'),
    request,
  );
  const expiringTicket = expiringCommand.linux_command.match(/Bearer (nsi_[a-f0-9]{48})/)?.[1];
  database.prepare(`UPDATE agent_install_tickets SET expires_at = ? WHERE used_at IS NULL`).run(now - 1);
  await assert.rejects(
    () => getAgentInstallScript(commandEnv, agentRequest(expiringTicket)),
    error => error?.status === 401 && /已过期或已使用/.test(error.message),
  );

  const latencyCommand = await getLatencyAgentInstallCommand(
    commandEnv,
    new URL('https://api.example.test/api/latency-agent/install-command?node_id=latency-tokyo'),
    request,
  );
  assert.equal(latencyCommand.ok, true);
  assert.match(latencyCommand.linux_command, new RegExp(`NSTATUS_LATENCY_TOKEN='${latencyToken}'`));

  database.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run('agent_public_base', 'https://agent.example.com', now);
  const storedOriginCommand = await getAgentInstallCommand(
    env,
    new URL('https://generated-name.workers.dev/api/agent/install-command?target_id=vps-a'),
    new Request('https://generated-name.workers.dev/api/agent/install-command?target_id=vps-a'),
  );
  assert.equal(storedOriginCommand.install_base, 'https://agent.example.com');
  assert.equal(storedOriginCommand.api_base, 'https://agent.example.com');
  assert.match(storedOriginCommand.linux_command, /https:\/\/agent\.example\.com\/api\/agent\/install-script/);
  const storedOriginLatency = await getLatencyAgentInstallCommand(
    env,
    new URL('https://generated-name.workers.dev/api/latency-agent/install-command?node_id=latency-tokyo'),
    new Request('https://generated-name.workers.dev/api/latency-agent/install-command?node_id=latency-tokyo'),
  );
  assert.equal(storedOriginLatency.install_base, 'https://agent.example.com');
  assert.equal(storedOriginLatency.api_base, 'https://agent.example.com');
  database.prepare(`DELETE FROM app_meta WHERE key = ?`).run('agent_public_base');
} finally {
  globalThis.fetch = originalFetch;
}

const wrongKeyEnv = { ...env, TOTP_ENCRYPTION_KEY: 'different-test-key-with-at-least-32-bytes' };
await assert.rejects(() => getOrCreateAgentToken(wrongKeyEnv, 'agent', 'vps-a'), /未自动轮换 Token/);
assert.deepEqual(await requireAgentForId(agentRequest(token), wrongKeyEnv, 'vps-a'), { type: 'scoped', agent_id: 'vps-a' }, 'authentication must only need the stored hash');
assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM agent_credentials WHERE subject_type = 'agent' AND subject_id = 'vps-a'`).get().count, 1);

const passwordFallbackEnv = { DB: env.DB, ADMIN_PASSWORD: 'Admin-fallback1!' };
const passwordFallbackToken = await getOrCreateAgentToken(passwordFallbackEnv, 'agent', 'password-fallback');
assert.match(passwordFallbackToken, /^nst_[a-f0-9]{64}$/);
assert.equal(await getOrCreateAgentToken(passwordFallbackEnv, 'agent', 'password-fallback'), passwordFallbackToken);
assert.equal(
  await getOrCreateAgentToken({ ...passwordFallbackEnv, TOTP_ENCRYPTION_KEY: 'new-dedicated-key' }, 'agent', 'password-fallback'),
  passwordFallbackToken,
  'adding a dedicated key must not make ADMIN_PASSWORD-encrypted credentials unreadable',
);

const legacyEnv = { ...env, AGENT_TOKEN: 'legacy-global-secret' };
const legacyToken = await legacyScopedToken(legacyEnv, 'agent', 'vps-a');
assert.match(legacyToken, /^nst_[a-f0-9]{48}$/);
assert.equal(await getOrCreateAgentToken(legacyEnv, 'agent', 'vps-a'), token, 'an existing random credential must remain stable if a legacy global token is added later');
assert.deepEqual(await requireAgentForId(agentRequest(legacyToken), legacyEnv, 'vps-a'), { type: 'scoped', agent_id: 'vps-a' });
const legacyOnlyToken = await legacyScopedToken(legacyEnv, 'agent', 'vps-b');
assert.equal(await getOrCreateAgentToken(legacyEnv, 'agent', 'vps-b'), legacyOnlyToken, 'legacy deployments without a stored credential keep their derived token');

console.log('per-node Agent credential tests passed');

function agentRequest(tokenValue) {
  return new Request('https://api.example.test', { headers: { authorization: `Bearer ${tokenValue}` } });
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
