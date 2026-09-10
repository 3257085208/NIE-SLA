import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const siblingFrontend = path.resolve(root, '..', 'frontend');
const frontendRoot = existsSync(path.join(siblingFrontend, 'AGENTS.md')) ? siblingFrontend : path.join(root, 'frontend');

const visibleFiles = [
  'index.html',
  'admin.html',
  '404.html',
  'app.js',
  'js/admin.js',
  'js/shared/appearance.js',
];
const visibleSource = (await Promise.all(
  visibleFiles.map(file => readFile(path.join(frontendRoot, file), 'utf8')),
)).join('\n');

assert.doesNotMatch(visibleSource, /聶\.NET|SLA-NIE|nstatus-metrics Agent/i);
assert.match(visibleSource, /NIE-SLA/);

const contracts = await Promise.all([
  readFile(path.join(root, 'agent/Cargo.toml'), 'utf8'),
  readFile(path.join(root, 'agent/setup.sh'), 'utf8'),
  readFile(path.join(root, 'worker/src/admin/install-command.js'), 'utf8'),
  readFile(path.join(root, 'worker/src/developer-api.js'), 'utf8'),
  readFile(path.join(frontendRoot, 'config.js'), 'utf8'),
  readFile(path.join(frontendRoot, 'js/shared/storage.js'), 'utf8'),
  readFile(path.join(root, 'docs/zh-CN/09-operations.md'), 'utf8'),
  readFile(path.join(root, 'docs/zh-CN/13-external-latency-agents.md'), 'utf8'),
  readFile(path.join(root, 'agent/index.html'), 'utf8'),
  readFile(path.join(frontendRoot, 'vendor/tasks/README.md'), 'utf8'),
  readFile(path.join(root, 'scripts/smoke-prod.mjs'), 'utf8'),
]);

assert.match(contracts[0], /name = "nie-sla-agent"/);
assert.match(contracts[1], /SERVICE_NAME="nie-sla-agent"/);
assert.match(contracts[1], /LEGACY_SERVICE_NAME="nstatus-metrics"/);
assert.match(contracts[2], /NIE_SLA_AGENT_TOKEN/);
assert.match(contracts[3], /x-nie-sla-api-version/);
assert.match(contracts[3], /x-nstatus-api-version/);
assert.match(contracts[4], /window\.NIE_SLA_CONFIG/);
assert.match(contracts[5], /readMigratedStorage/);
assert.match(contracts[6], /systemctl status nie-sla-agent/);
assert.doesNotMatch(contracts[6], /systemctl status nstatus-metrics/);
assert.match(contracts[7], /nie-sla-latency-agent\.service/);
assert.doesNotMatch(contracts[7], /systemctl (?:status|is-active) nstatus-latency-agent/);
assert.doesNotMatch(contracts[7], /\/etc\/nstatus-latency-agent|\/opt\/nstatus-latency|d1 execute nstatus-db/);
assert.match(contracts[8], /nie-sla-agent-manager/);
assert.doesNotMatch(contracts[8], /<code>nstatus-metrics/);
assert.match(contracts[9], /低权限 `nie-sla` 用户/);
assert.match(contracts[10], /<title>页面不存在 - NIE-SLA<\\\/title>/);
assert.doesNotMatch(contracts[10], /页面不存在 - 聶\.NET/);

console.log('NIE-SLA branding migration guard passed');
