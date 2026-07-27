import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import { ensureV6Schema } from '../src/admin/schema.js';
import { createAgentTask, claimAgentTask, completeAgentTask, listAgentTasks, normalizeTaskResult } from '../src/admin/agent-tasks.js';
import { getGeoIpSettings, submitAgentLocation, updateGeoIpSettings, validateCustomGeoIpUrl } from '../src/admin/agent-location.js';
import { exportBackup, previewBackup, restoreBackup } from '../src/admin/backup.js';
import { normalizeAgentCapabilities } from '../src/metrics.js';

globalThis.crypto ||= webcrypto;

assert.deepEqual(
  normalizeAgentCapabilities({
    protocol: 1,
    mode: 'compatibility',
    privileged: true,
    actions: ['nodequality', 'ip_unlock', 'shell'],
  }, 123),
  {
    protocol: 1,
    mode: 'compatibility',
    manager_version: null,
    privileged: false,
    actions: ['ip_unlock'],
    service_schema: 0,
    update_state: null,
    observed_at: 123,
  },
);

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
sqlite.exec(`CREATE TABLE agent_metrics_state (
  agent_id TEXT PRIMARY KEY,
  agent_label TEXT,
  updated_at TEXT,
  hostname TEXT,
  cpu_percent REAL,
  memory TEXT,
  load TEXT,
  disk TEXT,
  net TEXT,
  diskio TEXT,
  stats TEXT,
  uptime_sec INTEGER,
  vps_info TEXT,
  agent_version TEXT,
  process_count INTEGER,
  pings TEXT,
  thread_count INTEGER
)`);
sqlite.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, '1', ?)`)
  .run('schema:worker-v16-20260726-nodes-tasks-backup', Math.floor(Date.now() / 1000));
const env = {
  DB: d1(sqlite),
  ARCHIVE: {
    objects: new Map(),
    async put(key, value) { this.objects.set(key, value); },
  },
  TOTP_ENCRYPTION_KEY: 'test-key-that-is-long-enough-for-encryption',
  TIMEZONE_OFFSET_MINUTES: '480',
};
await ensureV6Schema(env);
assert.equal(
  sqlite.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('agent_metrics_state') WHERE name = 'capabilities'`).get().count,
  1,
);

const now = Math.floor(Date.now() / 1000);
sqlite.prepare(`INSERT INTO targets (id, name, group_name, type, enabled, no_public_ip, created_at, updated_at, traffic_reset_day)
  VALUES (?, ?, 'Default', 'tcp', 1, 1, ?, ?, 1)`).run('vps-a', 'VPS A', now, now);
sqlite.prepare(`INSERT INTO nodes (id, legacy_target_id, name, group_name, enabled, created_at, updated_at)
  VALUES (?, ?, ?, 'Default', 1, ?, ?)`).run('vps-a', 'vps-a', 'VPS A', now, now);
sqlite.prepare(`INSERT INTO targets (id, name, group_name, type, enabled, no_public_ip, created_at, updated_at, traffic_reset_day)
  VALUES (?, ?, 'Default', 'tcp', 1, 1, ?, ?, 1)`).run('vps-b', 'VPS B', now, now);
const managerCapabilities = JSON.stringify({
  protocol: 1,
  mode: 'manager',
  privileged: true,
  actions: ['nodequality', 'ip_unlock'],
});
sqlite.prepare(`INSERT INTO agent_metrics_state (agent_id, updated_at, capabilities) VALUES (?, ?, ?)`)
  .run('vps-a', new Date().toISOString(), managerCapabilities);
sqlite.prepare(`INSERT INTO agent_metrics_state (agent_id, updated_at, capabilities) VALUES (?, ?, ?)`)
  .run('vps-b', new Date().toISOString(), managerCapabilities);

const created = await createAgentTask(jsonRequest({ agent_id: 'vps-a', action: 'ip_unlock' }), env);
assert.equal(created.task.status, 'queued');
await assert.rejects(
  () => createAgentTask(jsonRequest({ agent_id: 'vps-a', action: 'nodequality' }), env),
  error => error?.status === 409,
);
await assert.rejects(
  () => createAgentTask(jsonRequest({ agent_id: 'vps-a', action: 'bash -lc whoami' }), env),
  error => error?.status === 400,
);

const claimed = await claimAgentTask(env, 'vps-a');
assert.equal(claimed.task.action, 'ip_unlock');
assert.equal(claimed.task.timeout_sec, 600);
assert.equal(claimed.poll_after_sec, 300);
const completed = await completeAgentTask(jsonRequest({
  status: 'succeeded',
  result: { services: [{ id: 'netflix', name: 'Netflix', status: '解锁', region: '[US]', method: '原生' }] },
  output_excerpt: 'IPv4 解锁测试完成',
  agent_version: 'v1.0.21',
}), env, claimed.task.id, 'vps-a');
assert.equal(completed.task.status, 'succeeded');
assert.equal(JSON.parse(sqlite.prepare(`SELECT unlock_data FROM targets WHERE id = ?`).get('vps-a').unlock_data).services[0].name, 'Netflix');

const nq = await createAgentTask(jsonRequest({ agent_id: 'vps-a', action: 'nodequality' }), env);
const nqClaim = await claimAgentTask(env, 'vps-a');
assert.equal(nqClaim.task.id, nq.task.id);
await completeAgentTask(jsonRequest({ status: 'succeeded', result: { report_url: 'https://nodequality.com/r/example' } }), env, nq.task.id, 'vps-a');
assert.equal(sqlite.prepare(`SELECT nq_url FROM targets WHERE id = ?`).get('vps-a').nq_url, 'https://nodequality.com/r/example');
assert.equal((await listAgentTasks(env, new URL('https://example.test/api/agent-tasks?agent_id=vps-a'))).tasks.length, 2);
const failedTask = await createAgentTask(jsonRequest({ agent_id: 'vps-a', action: 'ip_unlock' }), env);
await claimAgentTask(env, 'vps-a');
const failed = await completeAgentTask(jsonRequest({ status: 'failed', error: 'script failed' }), env, failedTask.task.id, 'vps-a');
assert.equal(failed.task.status, 'failed');
assert.throws(() => normalizeTaskResult('nodequality', { report_url: 'https://example.com/report' }), /nodequality\.com/i);

const filteredTask = await createAgentTask(jsonRequest({ agent_id: 'vps-b', action: 'nodequality' }), env);
assert.equal((await claimAgentTask(env, 'vps-b', 'ip_unlock')).task, null);
assert.equal((await claimAgentTask(env, 'vps-b')).task.id, filteredTask.task.id);
await assert.rejects(
  () => claimAgentTask(env, 'vps-b', 'shell'),
  error => error?.status === 400,
);

assert.equal((await getGeoIpSettings(env)).provider, 'ip_sb');
await updateGeoIpSettings(jsonRequest({ provider: 'ipip_net' }), env);
assert.equal((await getGeoIpSettings(env)).provider, 'ipip_net');
assert.throws(() => validateCustomGeoIpUrl('http://127.0.0.1/geo'), /HTTPS/);
assert.throws(() => validateCustomGeoIpUrl('https://169.254.169.254/latest/meta-data'), /内网/);
assert.equal(validateCustomGeoIpUrl('https://geo.example.test/lookup'), 'https://geo.example.test/lookup');

await submitAgentLocation(jsonRequest({
  provider: 'ipip_net',
  ipv4: '203.0.113.8',
  ipv6: '2001:db8::8',
  country_code: 'US',
  country: 'United States',
  city: 'Los Angeles',
}), env, 'vps-a');
const location = sqlite.prepare(`SELECT location, city, location_source FROM targets WHERE id = ?`).get('vps-a');
assert.equal(location.location, 'US');
assert.equal(location.city, 'Los Angeles');
assert.equal(location.location_source, 'ipip_net');
assert.equal(sqlite.prepare(`SELECT country_code FROM nodes WHERE id = ?`).get('vps-a').country_code, 'US');

sqlite.prepare(`INSERT INTO agent_credentials (subject_type, subject_id, token_hash, token_ciphertext, created_at, updated_at)
  VALUES ('agent', 'vps-a', 'hash', 'ciphertext', ?, ?)`).run(now, now);
const portable = await exportBackup(new Request('https://example.test/api/backup/export'), env);
assert.equal(portable.backup.portable.targets.length, 2);
assert.equal('sensitive' in portable.backup, false);
const protectedBackup = await exportBackup(jsonRequest({ include_secrets: true, password: 'Backup-password-123!' }), env);
assert.equal(protectedBackup.backup.sensitive.algorithm, 'PBKDF2-SHA256+A256GCM');
const preview = await previewBackup(jsonRequest({ backup: protectedBackup.backup, password: 'Backup-password-123!' }));
assert.equal(preview.preview.counts.targets, 2);
assert.equal(preview.preview.sensitive_counts.agent_credentials, 1);
await assert.rejects(
  () => previewBackup(jsonRequest({ backup: protectedBackup.backup, password: 'wrong-password' })),
  error => error?.status === 400,
);
sqlite.prepare(`UPDATE targets SET name = 'Changed' WHERE id = 'vps-a'`).run();
const restored = await restoreBackup(jsonRequest({
  backup: protectedBackup.backup,
  password: 'Backup-password-123!',
  mode: 'merge',
  confirm: 'RESTORE',
}), env);
assert.equal(restored.ok, true);
assert.equal(sqlite.prepare(`SELECT name FROM targets WHERE id = 'vps-a'`).get().name, 'VPS A');
assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM nodes WHERE id = 'vps-a'`).get().count, 1);
assert.equal(restored.restore_snapshot.stored, true);
assert.equal(env.ARCHIVE.objects.size, 1);
const internalSnapshot = JSON.parse([...env.ARCHIVE.objects.values()][0]);
assert.equal(internalSnapshot.schema, 'nie-sla-internal-snapshot-v2');
assert.equal(typeof internalSnapshot.encrypted?.ciphertext, 'string');
assert.equal(JSON.stringify(internalSnapshot).includes('test-key-that-is-long-enough-for-encryption'), false);
assert.equal(JSON.stringify(internalSnapshot).includes('token_ciphertext'), false);
assert.equal(JSON.stringify(internalSnapshot).includes('ciphertext\"'), true);

console.log('Agent task, GeoIP, and backup tests passed');

function jsonRequest(value) {
  return new Request('https://example.test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

function d1(database) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async run() {
          const result = database.prepare(sql).run(...values);
          return { meta: { changes: Number(result.changes || 0) } };
        },
        async all() { return { results: database.prepare(sql).all(...values) }; },
        async first() { return database.prepare(sql).get(...values) || null; },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}
