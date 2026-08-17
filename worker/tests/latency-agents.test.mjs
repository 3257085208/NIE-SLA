import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ensureV6Schema } from '../src/admin/schema.js';
import { createLatencyAgent, deleteLatencyAgent, getLatencyAgentInstallCommand, getLatencyAgentInstallScript, getLatencyAgentTargets, getLatencyAgentUpdatePolicy, getPublicLatency, listLatencyAgents, submitLatencyAgentResults, updateLatencyAgent } from '../src/admin/latency-agents.js';

globalThis.crypto ||= webcrypto;

const database = new DatabaseSync(':memory:');
const env = {
  AGENT_TOKEN: 'test-agent-secret',
  PUBLIC_SITE_ORIGIN: 'https://status.example.test',
  PUBLIC_AGENT_API_BASE: 'https://api.example.test',
  DB: d1(database),
  ARCHIVE: memoryR2(),
};

await ensureV6Schema(env);

const now = Math.floor(Date.now() / 1000);
database.prepare(`INSERT INTO targets (id, name, group_name, type, target_host, target_port, timeout_ms, interval_sec, probe_region, enabled, no_public_ip, created_at, updated_at) VALUES (?, ?, 'VPS', 'tcp', ?, ?, 5000, 300, 'auto', 1, ?, ?, ?)`)
  .run('private-vps', 'Private VPS', null, null, 1, now, now);
database.prepare(`INSERT INTO targets (id, name, group_name, type, target_host, target_port, timeout_ms, interval_sec, probe_region, enabled, no_public_ip, created_at, updated_at) VALUES (?, ?, 'VPS', 'tcp', ?, ?, 5000, 300, 'auto', 1, ?, ?, ?)`)
  .run('public-vps', 'Public VPS', '203.0.113.10', 443, 0, now, now);

const privateRow = database.prepare(`SELECT no_public_ip, target_host, target_port FROM targets WHERE id = ?`).get('private-vps');
assert.equal(privateRow.no_public_ip, 1);
assert.equal(privateRow.target_host, null);
assert.equal(privateRow.target_port, null);

const targets = await getLatencyAgentTargets(env);
assert.deepEqual(targets.targets.map(target => target.id), ['public-vps']);
assert.deepEqual(await getLatencyAgentUpdatePolicy(env), {
  ok: true,
  auto_update: true,
  check_interval_sec: 3600,
  script_version: 6,
  script_sha256: 'a76f1e06835aa37965fe60b46bf7f94f6b65ef36083597ab11995ec00238958a',
});
database.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES ('agent_auto_update', 'false', ?)`).run(now);
assert.equal((await getLatencyAgentUpdatePolicy(env)).auto_update, false);

const listed = await listLatencyAgents(env);
assert.equal(listed.builtin.id, 'cloudflare');
assert.equal(listed.builtin.color, '#159754');
const cfUpdate = await updateLatencyAgent('cloudflare', jsonRequest({ color: '#FFAA33' }), env);
assert.equal(cfUpdate.color, '#ffaa33');
assert.equal((await listLatencyAgents(env)).builtin.color, '#ffaa33');
assert.equal(database.prepare(`SELECT value FROM app_meta WHERE key = 'latency_cloudflare_color'`).get().value, '#ffaa33');
await assert.rejects(() => deleteLatencyAgent('cloudflare', env), /不可删除/);

const created = await createLatencyAgent(jsonRequest({ name: '东京 IIJ', color: '#3366CC' }), env);
assert.equal(created.ok, true);
assert.equal(database.prepare(`SELECT color FROM latency_agents WHERE id = ?`).get(created.id).color, '#3366cc');
const command = await getLatencyAgentInstallCommand(
  env,
  new URL(`https://api.example.test/api/latency-agent/install-command?node_id=${created.id}`),
  new Request('https://api.example.test', { headers: { origin: 'https://status.example.test' } }),
);
assert.match(command.linux_command, /\/api\/latency-agent\/install-script/);
assert.match(command.linux_command, /Authorization: Bearer nsi_[a-f0-9]{48}/);
assert.equal(command.credential_bound, true);
assert.equal(command.credential_type, 'one_time_latency_install_token');
assert.doesNotMatch(command.linux_command, /(?:NIE_SLA|NSTATUS)_LATENCY_TOKEN=|\bnst_[a-f0-9]{32,}\b/);
assert.doesNotMatch(command.linux_command, /(?:NIE_SLA|NSTATUS)_AGENT_ID=/);
assert.ok(command.linux_command.length < 380);
const installTicket = command.linux_command.match(/Bearer (nsi_[a-f0-9]{48})/)?.[1];
assert.ok(installTicket);
const installScript = await getLatencyAgentInstallScript(env, new Request('https://api.example.test/api/latency-agent/install-script', { headers: { authorization: `Bearer ${installTicket}` } }));
assert.equal(installScript.status, 200);
assert.equal(installScript.headers.get('content-type'), 'text/x-shellscript; charset=utf-8');
const installScriptText = await installScript.text();
assert.match(installScriptText, /NIE_SLA_LATENCY_TOKEN='nst_[a-f0-9]{48}'/);
assert.match(installScriptText, /install-latency\.sh\?v=6/);
assert.match(installScriptText, /c95ec9798502b27e59146a4e97a66cd81e0273e06ce4fc85a7b0a84061c55b5a/);
await assert.rejects(
  () => getLatencyAgentInstallScript(env, new Request('https://api.example.test/api/latency-agent/install-script', { headers: { authorization: `Bearer ${installTicket}` } })),
  /无效|已使用/,
);

const checkedAt = Math.floor(Date.now() / 1000);
const submitted = await submitLatencyAgentResults(jsonRequest({}), env, {
  node_id: created.id,
  results: [
    { target_id: 'public-vps', checked_at: checkedAt, latency_ms: 32, ok: true },
    { target_id: 'private-vps', latency_ms: 1, ok: true },
  ],
});
assert.equal(submitted.accepted, 1);
assert.equal(submitted.storage, 'r2');
assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM latency_results WHERE target_id = 'public-vps'`).get().count, 0);
assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM latency_results WHERE target_id = 'private-vps'`).get().count, 0);
assert.equal(env.ARCHIVE.objects.size, 1);
let archived = JSON.parse([...env.ARCHIVE.objects.values()][0].value);
assert.equal(archived.schema, 'nie-sla-latency-segment-v1');
assert.equal(archived.points.length, 1);
assert.equal(archived.points[0].latency_ms, 32);

await submitLatencyAgentResults(jsonRequest({}), env, {
  node_id: created.id,
  results: [{ target_id: 'public-vps', checked_at: checkedAt, latency_ms: 45, ok: true }],
});
archived = JSON.parse([...env.ARCHIVE.objects.values()][0].value);
assert.equal(archived.points.length, 1, 'R2 archive must replace duplicate node/target/time points');
assert.equal(archived.points[0].latency_ms, 45);
const latest = JSON.parse(database.prepare(`SELECT latest_results FROM latency_agents WHERE id = ?`).get(created.id).latest_results);
assert.equal(latest[0].latency_ms, 45);
const publicHistory = await getPublicLatency(env, new URL('https://api.example.test/api/latency?target_id=public-vps&hours=24'));
assert.equal(publicHistory.sources.length, 1, JSON.stringify(publicHistory));
assert.equal(publicHistory.sources[0].points.length, 1);
assert.equal(publicHistory.sources[0].points[0].latency_ms, 45);

console.log('external Latency agent tests passed');

function jsonRequest(body) {
  return new Request('https://api.example.test', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
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

function memoryR2() {
  return {
    objects: new Map(),
    async put(key, value, options = {}) { this.objects.set(key, { value: String(value), options }); },
    async get(key) {
      const object = this.objects.get(key);
      if (!object) return null;
      return {
        async json() { return JSON.parse(object.value); },
        async text() { return object.value; },
      };
    },
    async list({ prefix = '' } = {}) {
      return { objects: [...this.objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
    },
  };
}
