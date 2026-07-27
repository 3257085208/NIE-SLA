import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ensureV6Schema } from '../src/admin/schema.js';
import { createLatencyAgent, getLatencyAgentInstallCommand, getLatencyAgentTargets, getLatencyAgentUpdatePolicy, getPublicLatency, submitLatencyAgentResults } from '../src/admin/latency-agents.js';

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
  script_sha256: '572822759ae0e370f6ca916bf2cd0b866b77e93abb159b5fbf368c199d9cfa88',
});
database.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES ('agent_auto_update', 'false', ?)`).run(now);
assert.equal((await getLatencyAgentUpdatePolicy(env)).auto_update, false);

const created = await createLatencyAgent(jsonRequest({ name: '东京 IIJ', color: '#3366CC' }), env);
assert.equal(created.ok, true);
assert.equal(database.prepare(`SELECT color FROM latency_agents WHERE id = ?`).get(created.id).color, '#3366cc');
const command = await getLatencyAgentInstallCommand(
  env,
  new URL(`https://api.example.test/api/latency-agent/install-command?node_id=${created.id}`),
  new Request('https://api.example.test', { headers: { origin: 'https://status.example.test' } }),
);
assert.match(command.linux_command, /install-latency\.sh/);
assert.match(command.linux_command, /install-latency\.sh\?v=6/);
assert.match(command.linux_command, /sha256sum -c/);
assert.match(command.linux_command, /NSTATUS_LATENCY_SCRIPT_SHA256=/);
assert.doesNotMatch(command.linux_command, /NSTATUS_AGENT_ID=/);

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
