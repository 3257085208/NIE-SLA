import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'dist-one-click');
const deploymentValidation = process.env.NIE_SLA_DEPLOYMENT_VALIDATION === '1';

for (const relative of [
  'index.html', 'admin.html', 'config.js', 'js/theme-bootstrap.js', 'js/themes.js', 'update-manifest.json', 'bin/VERSION', 'bin/SHA256SUMS',
  'bin/nstatus-metrics-linux-amd64', 'bin/nstatus-metrics-linux-arm64',
  'bin/jq-linux-amd64', 'bin/jq-linux-arm64', 'bin/jq-linux-i386', 'bin/jq-linux-armhf', 'bin/jq-linux-armel',
]) {
  const info = await stat(path.join(output, relative));
  assert.ok(info.isFile() && info.size > 0, `missing one-click asset: ${relative}`);
}

for (const relative of [
  'AGENTS.md', '.gitattributes', '.github', '.gitignore', '.wrangler', 'README.md', '_redirects',
  'package.json', 'pnpm-lock.yaml', 'functions', 'tests',
]) {
  await assert.rejects(access(path.join(output, relative)), undefined, `build input leaked into assets: ${relative}`);
}

const frontendConfig = await readFile(path.join(output, 'config.js'), 'utf8');
assert.match(frontendConfig, /window\.NSTATUS_API_BASE\s*=\s*config\.apiBase\s*\|\|\s*window\.NSTATUS_API_BASE\s*\|\|\s*''/);
assert.doesNotMatch(frontendConfig, /https?:\/\//, 'one-click frontend must use the same-origin API');

const version = (await readFile(path.join(output, 'bin/VERSION'), 'utf8')).trim();
assert.match(version, /^v\d+\.\d+\.\d+$/);
const updateManifest = JSON.parse(await readFile(path.join(root, 'update-manifest.json'), 'utf8'));
assert.deepEqual(
  JSON.parse(await readFile(path.join(output, 'update-manifest.json'), 'utf8')),
  updateManifest,
  'bundled update fallback must match the official release manifest',
);
assert.equal(version, updateManifest.agent_version, 'one-click build must bundle the declared Agent release');

const manifest = await readFile(path.join(output, 'bin/SHA256SUMS'), 'utf8');
let verified = 0;
for (const line of manifest.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const match = line.match(/^([a-f0-9]{64})\s+\*?((?:nstatus-metrics|jq)-[A-Za-z0-9._-]+)$/i);
  assert.ok(match, `invalid SHA256SUMS line: ${line}`);
  const bytes = await readFile(path.join(output, 'bin', match[2]));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), match[1].toLowerCase(), `checksum mismatch: ${match[2]}`);
  verified += 1;
}
assert.ok(verified >= 3, 'expected Agent binaries for multiple platforms');

const wrangler = JSON.parse(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(wrangler.assets?.directory, './dist-one-click');
assert.equal(wrangler.assets?.run_worker_first, true);
assert.deepEqual(wrangler.compatibility_flags, ['global_fetch_strictly_public']);
const databaseId = wrangler.d1_databases?.[0]?.database_id || '';
assert.match(databaseId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
if (!deploymentValidation) assert.equal(databaseId, '00000000-0000-0000-0000-000000000000');
assert.deepEqual(wrangler.triggers?.crons, ['* * * * *']);
assert.deepEqual(
  wrangler.durable_objects?.bindings?.map(binding => [binding.name, binding.class_name]),
  [['REGION_PROXY', 'ProbeRegion'], ['TELEMETRY_BUFFER', 'TelemetryBuffer']],
);
assert.deepEqual(wrangler.migrations?.at(-1), { tag: 'v2', new_sqlite_classes: ['TelemetryBuffer'] });

const describedBindings = packageJson.cloudflare?.bindings || {};
assert.match(packageJson.cloudflare?.label || '', /\p{Script=Han}/u);
assert.deepEqual(wrangler.vars || {}, {});
assert.deepEqual(
  Object.keys(describedBindings).sort(),
  ['ADMIN_PASSWORD', 'ADMIN_PATH', 'ADMIN_USERNAME', 'ARCHIVE', 'ASSETS', 'DB', 'REGION_PROXY', 'TELEMETRY_BUFFER'].sort(),
);
for (const name of Object.keys(describedBindings)) assert.match(describedBindings[name]?.description || '', /\p{Script=Han}/u);
assert.equal('AGENT_TOKEN' in describedBindings, false);
assert.equal('TOTP_ENCRYPTION_KEY' in describedBindings, false);

const pnpmWorkspace = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
assert.match(pnpmWorkspace, /^packages:\s*\n\s+-\s+["']?\.["']?\s*$/m);
const secretExample = await readFile(path.join(root, '.dev.vars.example'), 'utf8');
for (const name of ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_PATH']) {
  assert.match(secretExample, new RegExp(`^${name}=\\s*(?:#.*)?$`, 'm'));
}
assert.doesNotMatch(secretExample, /^AGENT_TOKEN=|^TOTP_ENCRYPTION_KEY=/m);

console.log(`one-click build passed (${verified} verified release assets, ${version})`);
