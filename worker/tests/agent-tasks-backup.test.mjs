import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import { ensureV6Schema } from '../src/admin/schema.js';
import { createAgentTask, createAgentTasks, claimAgentTask, completeAgentTask, listAgentTasks, normalizeTaskResult } from '../src/admin/agent-tasks.js';
import { getGeoIpSettings, submitAgentLocation, updateGeoIpSettings, validateCustomGeoIpUrl } from '../src/admin/agent-location.js';
import { exportBackup, previewBackup, restoreBackup } from '../src/admin/backup.js';
import { getOrCreateAgentToken, verifyAgentCredential } from '../src/agent-credentials.js';
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
const d1Stats = { batchSizes: [] };
const env = {
  DB: d1(sqlite, d1Stats),
  ARCHIVE: {
    objects: new Map(),
    async put(key, value) { this.objects.set(key, value); },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
    },
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

const batch = await createAgentTasks(env, ['vps-a', 'vps-b', 'missing-agent', 'vps-a'], 'ip_unlock');
assert.equal(batch.requested, 3);
assert.equal(batch.created.length, 2);
assert.deepEqual(batch.created.map((task) => task.agent_id).sort(), ['vps-a', 'vps-b']);
assert.equal(batch.rejected.length, 1);
assert.equal(batch.rejected[0].agent_id, 'missing-agent');
await assert.rejects(
  () => createAgentTasks(env, [], 'ip_unlock'),
  error => error?.status === 400,
);
const batchClaim = await claimAgentTask(env, 'vps-a');
await completeAgentTask(jsonRequest({ status: 'failed', error: 'batch cleanup' }), env, batchClaim.task.id, 'vps-a');
const batchClaimB = await claimAgentTask(env, 'vps-b');
await completeAgentTask(jsonRequest({ status: 'failed', error: 'batch cleanup' }), env, batchClaimB.task.id, 'vps-b');

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
  result: {
    services: [{ id: 'netflix', name: 'Netflix', status: '解锁', region: '[US]', method: '原生' }],
    report: 'IP 质量体检报告：117.55.*.*\r\n五、流媒体解锁检测\u001b[31m彩色\u001b[0m\n',
  },
  output_excerpt: 'IPv4 解锁测试完成',
  agent_version: 'v1.0.21',
}), env, claimed.task.id, 'vps-a');
assert.equal(completed.task.status, 'succeeded');
assert.equal(JSON.parse(sqlite.prepare(`SELECT unlock_data FROM targets WHERE id = ?`).get('vps-a').unlock_data).services[0].name, 'Netflix');
const storedTaskResult = typeof completed.task.result === 'string'
  ? JSON.parse(completed.task.result)
  : completed.task.result;
const storedReport = storedTaskResult.report;
assert.equal(storedReport, 'IP 质量体检报告：117.55.*.*\n五、流媒体解锁检测\u001b[31m彩色\u001b[0m\n');
const longReport = 'x'.repeat(70 * 1024);
assert.equal(normalizeTaskResult('ip_unlock', { services: [{ id: 'netflix', name: 'Netflix', status: '解锁', region: '[US]', method: '原生' }], report: longReport }).report.length, 64 * 1024, 'IP unlock reports must be capped at 64 KiB on the Worker');
assert.equal(normalizeTaskResult('ip_unlock', { services: [{ id: 'netflix', name: 'Netflix', status: '解锁', region: '[US]', method: '原生' }], report: '\r\u0000ok\u001b[31mred\u001b[0m' }).report, 'ok\u001b[31mred\u001b[0m', 'IP unlock reports must drop control characters while keeping ANSI SGR colors');

const nq = await createAgentTask(jsonRequest({ agent_id: 'vps-a', action: 'nodequality' }), env);
const nqClaim = await claimAgentTask(env, 'vps-a');
assert.equal(nqClaim.task.id, nq.task.id);
assert.equal(nqClaim.task.timeout_sec, 3600);
await completeAgentTask(jsonRequest({
  status: 'succeeded',
  result: {
    report_url: 'https://nodequality.com/r/example123',
    report: {
      tabs: [
        { id: 'basic', title: '基本信息', content: 'CPU: Test' },
        { id: 'ip', title: 'IP质量', content: 'IP: Test' },
        { id: 'network', title: '网络质量', content: 'Network: Test' },
        { id: 'route', title: '回程路由', content: 'Route: Test' },
      ],
    },
  },
}), env, nq.task.id, 'vps-a');
const storedNq = sqlite.prepare(`SELECT nq_url, nq_report FROM targets WHERE id = ?`).get('vps-a');
assert.equal(storedNq.nq_url, 'https://nodequality.com/r/example123');
assert.deepEqual(JSON.parse(storedNq.nq_report).tabs.map((tab) => tab.id), ['basic', 'ip', 'network', 'route']);
assert.equal((await listAgentTasks(env, new URL('https://example.test/api/agent-tasks?agent_id=vps-a'))).tasks.length, 3);

const nqWithoutReport = await createAgentTask(jsonRequest({ agent_id: 'vps-a', action: 'nodequality' }), env);
await claimAgentTask(env, 'vps-a');
const nqWithoutReportResult = await completeAgentTask(jsonRequest({
  status: 'succeeded',
  result: { report_url: 'https://nodequality.com/r/missingReport123' },
}), env, nqWithoutReport.task.id, 'vps-a');
const missingReportPayload = nqWithoutReportResult.task.result;
assert.equal(missingReportPayload.report_saved, false);
assert.equal(missingReportPayload.image_upload.uploaded, 0);
assert.match(missingReportPayload.image_upload.errors[0], /未返回可保存/);

const failedTask = await createAgentTask(jsonRequest({ agent_id: 'vps-a', action: 'ip_unlock' }), env);
await claimAgentTask(env, 'vps-a');
const failed = await completeAgentTask(jsonRequest({ status: 'failed', error: 'script failed' }), env, failedTask.task.id, 'vps-a');
assert.equal(failed.task.status, 'failed');
assert.throws(() => normalizeTaskResult('nodequality', { report_url: 'https://example.com/report' }), /nodequality\.com/i);
assert.throws(() => normalizeTaskResult('nodequality', { report_url: 'https://run.nodequality.com/' }), /报告ID/i);
assert.throws(() => normalizeTaskResult('nodequality', { report_url: 'https://api.nodequality.com/api/v1/record' }), /报告ID/i);
assert.throws(() => normalizeTaskResult('nodequality', { report_url: 'https://nodequality.com/' }), /报告ID/i);

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

const originalAgentToken = await getOrCreateAgentToken(env, 'agent', 'vps-a');
sqlite.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?), (?, ?, ?)`)
  .run(
    'nq_image_host_settings', JSON.stringify({ endpoint: 'https://private-image-host.example/upload', upload_channel: 'cfr2', folder: 'legacy/path' }), now,
    'nq_image_host_token', 'enc:v1:private-token-ciphertext', now,
  );
const portable = await exportBackup(new Request('https://example.test/api/backup/export'), env);
assert.equal(portable.backup.portable.targets.length, 2);
assert.equal('sensitive' in portable.backup, false);
assert.equal(JSON.stringify(portable.backup).includes('private-image-host.example'), false);
assert.equal(portable.backup.portable.app_meta.some((row) => row.key.startsWith('nq_image_host_')), false);
portable.backup.portable.targets[0].unknown_future_column = 'ignored';
await restoreBackup(jsonRequest({ backup: portable.backup, mode: 'merge', confirm: 'RESTORE' }), env);
const bulkBackup = structuredClone(portable.backup);
const targetTemplate = bulkBackup.portable.targets[0];
bulkBackup.portable.targets = Array.from({ length: 120 }, (_, index) => ({
  ...targetTemplate,
  id: `restore-bulk-${index}`,
  name: `Restore Bulk ${index}`,
  sort_order: index,
}));
bulkBackup.portable.app_meta = Array.from({ length: 80 }, (_, index) => ({
  key: `restore_bulk_setting_${index}`,
  value: String(index),
  updated_at: now,
}));
const batchesBeforeBulkRestore = d1Stats.batchSizes.length;
await restoreBackup(jsonRequest({ backup: bulkBackup, mode: 'replace', confirm: 'RESTORE' }), env);
const bulkBatchSizes = d1Stats.batchSizes.slice(batchesBeforeBulkRestore);
assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM targets WHERE id LIKE 'restore-bulk-%'`).get().count, 120);
assert.ok(bulkBatchSizes.filter(size => size === 50).length >= 3, 'large restores must use bounded D1 batches');
assert.ok(bulkBatchSizes.every(size => size <= 50), 'D1 restore batches must stay within the configured bound');
await restoreBackup(jsonRequest({ backup: portable.backup, mode: 'replace', confirm: 'RESTORE' }), env);
env.ARCHIVE.objects.clear();
await assert.rejects(
  () => exportBackup(new Request('https://example.test/api/backup/export'), {
    DB: { prepare() { return { all: async () => { throw new Error('simulated backup read failure'); } }; } },
  }),
  /simulated backup read failure/,
);
const protectedBackup = await exportBackup(jsonRequest({ include_secrets: true, password: 'Backup-password-123!' }), env);
assert.equal(protectedBackup.backup.sensitive.algorithm, 'PBKDF2-SHA256+A256GCM');
assert.equal(protectedBackup.backup.sensitive.iterations, 100_000);
assert.equal(JSON.stringify(protectedBackup.backup).includes('private-image-host.example'), false);
const preview = await previewBackup(jsonRequest({ backup: protectedBackup.backup, password: 'Backup-password-123!' }));
assert.equal(preview.preview.counts.targets, 2);
assert.equal(preview.preview.sensitive_counts.agent_tokens, 1);
assert.equal(preview.preview.sensitive_counts.agent_credentials, 0);
assert.equal(preview.preview.agent_connections_preserved, true);
assert.equal(preview.preview.sensitive_counts.app_meta, 2);
await assert.rejects(
  () => previewBackup(jsonRequest({ backup: protectedBackup.backup, password: 'wrong-password' })),
  error => error?.status === 400,
);
const unsupportedKdfBackup = structuredClone(protectedBackup.backup);
unsupportedKdfBackup.sensitive.iterations = 310_000;
await assert.rejects(
  () => previewBackup(jsonRequest({ backup: unsupportedKdfBackup, password: 'Backup-password-123!' })),
  error => error?.status === 400 && /PBKDF2|Cloudflare/.test(error.message),
);
sqlite.prepare(`UPDATE targets SET name = 'Changed' WHERE id = 'vps-a'`).run();
sqlite.prepare(`DELETE FROM agent_credentials`).run();
sqlite.prepare(`DELETE FROM app_meta WHERE key LIKE 'nq_image_host_%'`).run();
const restoredEnv = { ...env, TOTP_ENCRYPTION_KEY: 'new-deployment-key-that-is-long-enough' };
const restored = await restoreBackup(jsonRequest({
  backup: protectedBackup.backup,
  password: 'Backup-password-123!',
  mode: 'merge',
  confirm: 'RESTORE',
}), restoredEnv);
assert.equal(restored.ok, true);
assert.equal(sqlite.prepare(`SELECT name FROM targets WHERE id = 'vps-a'`).get().name, 'VPS A');
assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM nodes WHERE id = 'vps-a'`).get().count, 1);
assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM app_meta WHERE key LIKE 'nq_image_host_%'`).get().count, 2);
assert.equal(restored.restored.agent_tokens, 1);
assert.equal(await getOrCreateAgentToken(restoredEnv, 'agent', 'vps-a'), originalAgentToken);
assert.equal(await verifyAgentCredential(restoredEnv, 'agent', 'vps-a', originalAgentToken), true);
assert.equal(restored.restore_snapshot.stored, true);
assert.equal(env.ARCHIVE.objects.size, 1);
const internalSnapshot = JSON.parse([...env.ARCHIVE.objects.values()][0]);
assert.equal(internalSnapshot.schema, 'nie-sla-internal-snapshot-v2');
assert.equal(typeof internalSnapshot.encrypted?.ciphertext, 'string');
assert.equal(JSON.stringify(internalSnapshot).includes('test-key-that-is-long-enough-for-encryption'), false);
assert.equal(JSON.stringify(internalSnapshot).includes('token_ciphertext'), false);
assert.equal(JSON.stringify(internalSnapshot).includes('ciphertext\"'), true);

const replaced = await restoreBackup(jsonRequest({
  backup: protectedBackup.backup,
  password: 'Backup-password-123!',
  mode: 'replace',
  confirm: 'RESTORE',
}), restoredEnv);
assert.deepEqual(replaced.runtime_cleanup, { d1_cleared: true, r2_cleared: true, warnings: [] });

console.log('Agent task, GeoIP, and backup tests passed');

function jsonRequest(value) {
  return new Request('https://example.test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

function d1(database, stats = null) {
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
      if (stats) stats.batchSizes.push(statements.length);
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}
