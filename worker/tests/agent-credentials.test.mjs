import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getOrCreateAgentToken, legacyScopedToken, migrateAgentCredentialEncryption, verifyAgentCredential } from '../src/agent-credentials.js';
import { requireAgentForId, requireAnyAgent, requireLatencyAgentForId } from '../src/auth.js';
import { getAgentInstallCommand, getAgentInstallScript } from '../src/admin/install-command.js';
import { getLatencyAgentInstallCommand, getLatencyAgentInstallScript } from '../src/admin/latency-agents.js';
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
for (const [id, name] of [
  ['Hytron-hk-status', 'HK Status'],
  ['bitsflowcloud-lax-9929&cmin2', 'LAX 9929&CMIN2'],
]) {
  database.prepare(`INSERT INTO targets
    (id, name, group_name, type, target_host, target_port, timeout_ms, interval_sec, probe_region, enabled, created_at, updated_at)
    VALUES (?, ?, 'VPS', 'tcp', '203.0.113.12', 443, 5000, 300, 'auto', 1, ?, ?)`)
    .run(id, name, now, now);
}
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
  assert.doesNotMatch(agentCommand.linux_command, /(?:NIE_SLA|NSTATUS)_AGENT_TOKEN|\bnst_[a-f0-9]{32,}\b/);

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
  assert.match(installScript, new RegExp(`NIE_SLA_AGENT_TOKEN='${token}'`));
  assert.match(installScript, /NIE_SLA_AGENT_LABEL='VPS A'/);
  assert.match(installScript, /NIE_SLA_EXPECTED_VERSION='v1\.2\.3'/);
  assert.match(installScript, /NIE_SLA_INSTALLER_SHA256='[a-f0-9]{64}'/);
  assert.match(installScript, /NIE_SLA_SETUP_SHA256='[a-f0-9]{64}'/);
  assert.match(installScript, /NIE_SLA_CFTZ_SHA256='[a-f0-9]{64}'/);
  assert.match(installScript, /\[ "\$actual" = "\$NIE_SLA_INSTALLER_SHA256" \]/);
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

  for (const [rawTargetId, canonicalAgentId] of [
    ['Hytron-hk-status', 'hytron-hk-status'],
    ['bitsflowcloud-lax-9929&cmin2', 'bitsflowcloud-lax-9929-cmin2'],
  ]) {
    const legacyIdCommand = await getAgentInstallCommand(
      commandEnv,
      new URL(`https://api.example.test/api/agent/install-command?target_id=${encodeURIComponent(rawTargetId)}`),
      request,
    );
    assert.equal(legacyIdCommand.ok, true);
    assert.equal(legacyIdCommand.target_id, rawTargetId, 'the admin response must stay bound to the selected target');
    const legacyIdTicket = legacyIdCommand.linux_command.match(/Bearer (nsi_[a-f0-9]{48})/)?.[1];
    assert.ok(legacyIdTicket);
    assert.ok(database.prepare(`SELECT token_hash FROM agent_install_tickets WHERE target_id = ? AND used_at IS NULL`).get(rawTargetId));
    const legacyIdScript = await (await getAgentInstallScript(commandEnv, agentRequest(legacyIdTicket))).text();
    assert.match(legacyIdScript, new RegExp(`NIE_SLA_AGENT_ID='${canonicalAgentId}'`));
    assert.ok(database.prepare(`SELECT token_hash FROM agent_credentials WHERE subject_type = 'agent' AND subject_id = ?`).get(canonicalAgentId));
  }

  const rawIdToken = await getOrCreateAgentToken(env, 'agent', 'bitsflowcloud-lax-9929-cmin2');
  assert.deepEqual(await requireAnyAgent(agentRequest(rawIdToken), env), { type: 'scoped', agent_id: 'bitsflowcloud-lax-9929-cmin2' });
  assert.deepEqual(await requireAgentForId(agentRequest(rawIdToken), env, 'bitsflowcloud-lax-9929-cmin2'), { type: 'scoped', agent_id: 'bitsflowcloud-lax-9929-cmin2' });

  for (const id of ['collision&target', 'collision-target']) {
    database.prepare(`INSERT INTO targets
      (id, name, group_name, type, target_host, target_port, timeout_ms, interval_sec, probe_region, enabled, created_at, updated_at)
      VALUES (?, ?, 'VPS', 'tcp', '203.0.113.13', 443, 5000, 300, 'auto', 1, ?, ?)`)
      .run(id, id, now, now);
  }
  const collisionCommand = await getAgentInstallCommand(
    commandEnv,
    new URL('https://api.example.test/api/agent/install-command?target_id=collision%26target'),
    request,
  );
  assert.equal(collisionCommand.ok, false);
  assert.match(collisionCommand.error, /相同的 Agent ID/);

  const latencyCommand = await getLatencyAgentInstallCommand(
    commandEnv,
    new URL('https://api.example.test/api/latency-agent/install-command?node_id=latency-tokyo'),
    request,
  );
  assert.equal(latencyCommand.ok, true);
  assert.equal(latencyCommand.credential_bound, true);
  assert.equal(latencyCommand.credential_type, 'one_time_latency_install_token');
  assert.doesNotMatch(latencyCommand.linux_command, /(?:NIE_SLA|NSTATUS)_LATENCY_TOKEN|\bnst_[a-f0-9]{32,}\b/);
  const latencyInstallTicket = latencyCommand.linux_command.match(/Bearer (nsi_[a-f0-9]{48})/)?.[1];
  assert.ok(latencyInstallTicket);
  const latencyScript = await getLatencyAgentInstallScript(commandEnv, new Request('https://api.example.test/api/latency-agent/install-script', { headers: { authorization: `Bearer ${latencyInstallTicket}` } }));
  assert.equal(latencyScript.status, 200);
  assert.match(await latencyScript.text(), new RegExp(`NIE_SLA_LATENCY_TOKEN='${latencyToken}'`));

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

const legacyPassword = 'Admin-fallback1!';
const passwordFallbackToken = `nst_${'ab'.repeat(32)}`;
const passwordFallbackHash = await sha256Hex(passwordFallbackToken);
const passwordFallbackCiphertext = await encryptLegacyAgentToken(
  passwordFallbackToken,
  legacyPassword,
  { type: 'agent', id: 'password-fallback' },
);
database.prepare(`INSERT INTO agent_credentials
  (subject_type, subject_id, token_hash, token_ciphertext, created_at, updated_at)
  VALUES ('agent', 'password-fallback', ?, ?, ?, ?)`).run(
  passwordFallbackHash,
  passwordFallbackCiphertext,
  now,
  now,
);
const passwordFallbackEnv = {
  DB: env.DB,
  ADMIN_PASSWORD: legacyPassword,
  TOTP_ENCRYPTION_KEY: 'new-dedicated-key-with-at-least-32-characters',
};
assert.equal(
  await getOrCreateAgentToken(passwordFallbackEnv, 'agent', 'password-fallback'),
  passwordFallbackToken,
  'adding a dedicated key must decrypt and migrate ADMIN_PASSWORD-encrypted credentials',
);
const migratedFallback = database.prepare(`SELECT token_hash, token_ciphertext FROM agent_credentials
  WHERE subject_type = 'agent' AND subject_id = 'password-fallback'`).get();
assert.equal(migratedFallback.token_hash, passwordFallbackHash, 'lazy re-encryption must preserve online authentication hashes');
assert.notEqual(migratedFallback.token_ciphertext, passwordFallbackCiphertext);
assert.equal(
  await getOrCreateAgentToken({ DB: env.DB, TOTP_ENCRYPTION_KEY: passwordFallbackEnv.TOTP_ENCRYPTION_KEY }, 'agent', 'password-fallback'),
  passwordFallbackToken,
  'the migrated credential must remain readable after the old Admin password is removed',
);
assert.equal(
  await verifyAgentCredential({ DB: env.DB }, 'agent', 'password-fallback', passwordFallbackToken),
  true,
  'online Agent authentication remains hash-only after encryption migration',
);

const rotationDatabase = new DatabaseSync(':memory:');
rotationDatabase.exec(`CREATE TABLE agent_credentials (
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (subject_type, subject_id)
)`);
const rotationOldEnv = {
  DB: d1(rotationDatabase),
  TOTP_ENCRYPTION_KEY: env.TOTP_ENCRYPTION_KEY,
};
const rotationToken = await getOrCreateAgentToken(rotationOldEnv, 'agent', 'rotation-test');
const rotation = await migrateAgentCredentialEncryption({
  DB: rotationOldEnv.DB,
  TOTP_ENCRYPTION_KEY: 'rotated-primary-key-with-at-least-32-characters',
  PREVIOUS_ENCRYPTION_KEY: env.TOTP_ENCRYPTION_KEY,
});
assert.ok(rotation.migrated >= 1);
assert.equal(
  await getOrCreateAgentToken({ DB: rotationOldEnv.DB, TOTP_ENCRYPTION_KEY: 'rotated-primary-key-with-at-least-32-characters' }, 'agent', 'rotation-test'),
  rotationToken,
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

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function encryptLegacyAgentToken(tokenValue, material, subject) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const additionalData = new TextEncoder().encode(`nie-sla:${subject.type}:${subject.id}`);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    key,
    new TextEncoder().encode(tokenValue),
  ));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv);
  combined.set(encrypted, iv.length);
  let binary = '';
  for (const byte of combined) binary += String.fromCharCode(byte);
  return `enc:v1:${btoa(binary)}`;
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
