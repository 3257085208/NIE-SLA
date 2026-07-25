import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'dist-one-click');

for (const relative of [
  'index.html',
  'admin.html',
  'config.js',
  'bin/VERSION',
  'bin/SHA256SUMS',
  'bin/nstatus-metrics-linux-amd64',
  'bin/nstatus-metrics-linux-arm64',
  'bin/nstatus-metrics-windows-amd64.exe',
]) {
  const info = await stat(path.join(output, relative));
  assert.ok(info.isFile() && info.size > 0, `missing one-click asset: ${relative}`);
}

for (const relative of ['AGENTS.md', 'README.md', '_redirects', 'package.json', 'functions', 'tests']) {
  await assert.rejects(access(path.join(output, relative)), undefined, `private build input leaked into assets: ${relative}`);
}

const frontendConfig = await readFile(path.join(output, 'config.js'), 'utf8');
assert.match(frontendConfig, /window\.NSTATUS_API_BASE\s*=\s*config\.apiBase\s*\|\|\s*window\.NSTATUS_API_BASE\s*\|\|\s*''/);
assert.doesNotMatch(frontendConfig, /https?:\/\//, 'one-click frontend must use the same-origin API');

const version = (await readFile(path.join(output, 'bin/VERSION'), 'utf8')).trim();
assert.match(version, /^v\d+\.\d+\.\d+$/);

const manifest = await readFile(path.join(output, 'bin/SHA256SUMS'), 'utf8');
let verified = 0;
for (const line of manifest.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const match = line.match(/^([a-f0-9]{64})\s+\*?(nstatus-metrics-[A-Za-z0-9._-]+)$/i);
  assert.ok(match, `invalid SHA256SUMS line: ${line}`);
  const bytes = await readFile(path.join(output, 'bin', match[2]));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), match[1].toLowerCase(), `checksum mismatch: ${match[2]}`);
  verified += 1;
}
assert.ok(verified >= 3, 'expected Agent binaries for multiple platforms');

const wrangler = JSON.parse(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(wrangler.assets?.directory, './dist-one-click');
assert.equal(wrangler.assets?.run_worker_first, true, 'custom admin routes must reach the Worker before static assets');
assert.equal(wrangler.d1_databases?.[0]?.database_id, '00000000-0000-0000-0000-000000000000');
assert.ok(wrangler.r2_buckets?.[0]?.binding);
assert.ok(wrangler.durable_objects?.bindings?.[0]?.class_name);
assert.deepEqual(wrangler.triggers?.crons, ['* * * * *']);

const describedBindings = packageJson.cloudflare?.bindings || {};
const requiredInputs = ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_PATH'];
const deployBindingNames = [
  ...Object.keys(wrangler.vars || {}),
  wrangler.assets?.binding,
  ...wrangler.d1_databases.map(item => item.binding),
  ...wrangler.r2_buckets.map(item => item.binding),
  ...wrangler.durable_objects.bindings.map(item => item.name),
  ...requiredInputs,
].filter(Boolean);

assert.match(packageJson.cloudflare?.label || '', /\p{Script=Han}/u, 'deploy label should include Chinese');
assert.deepEqual(wrangler.vars || {}, {}, 'one-click deploy must not expose internal tuning defaults');
assert.deepEqual(
  Object.keys(describedBindings).sort(),
  ['ADMIN_PASSWORD', 'ADMIN_PATH', 'ADMIN_USERNAME', 'ARCHIVE', 'ASSETS', 'DB', 'REGION_PROXY'].sort(),
  'deploy form should only describe automatic resources and required inputs',
);
assert.equal('AGENT_TOKEN' in describedBindings, false, 'new deployments generate per-node Agent tokens');
assert.equal('TOTP_ENCRYPTION_KEY' in describedBindings, false, 'TOTP is optional and disabled by default');
assert.equal(packageJson.cloudflare?.docs_url, 'https://nie-sla.pages.dev/quickstart/');
for (const name of new Set(deployBindingNames)) {
  assert.match(
    describedBindings[name]?.description || '',
    /\p{Script=Han}/u,
    `missing Chinese deploy description: ${name}`,
  );
}

const pnpmWorkspace = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
assert.match(pnpmWorkspace, /^packages:\s*\n\s+-\s+["']?\.["']?\s*$/m, 'pnpm workspace must include the root package');

const secretExample = await readFile(path.join(root, '.dev.vars.example'), 'utf8');
for (const name of requiredInputs) {
  assert.match(secretExample, new RegExp(`^${name}=\\s*(?:#.*)?$`, 'm'), `${name} must require per-deployment input`);
}
assert.doesNotMatch(secretExample, /^AGENT_TOKEN=/m, 'new deployments must not ask for a global Agent token');
assert.doesNotMatch(secretExample, /^TOTP_ENCRYPTION_KEY=/m, 'TOTP is configured only when the administrator enables it');
assert.doesNotMatch(secretExample, /replace-with-|change-me|example-secret/i, 'deploy secrets must not have reusable defaults');

console.log(`one-click build passed (${verified} Agent binaries, ${version})`);
