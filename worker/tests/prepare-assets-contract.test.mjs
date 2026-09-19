import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(workerRoot, 'scripts', 'prepare-assets.mjs'), 'utf8');

assert.match(source, /assertCleanGitRepository\(agentRoot, 'Agent'\)/);
assert.match(source, /assertCleanGitRepository\(frontendRoot, 'Frontend'\)/);
assert.match(source, /'archive'/);
assert.match(source, /asset_source: 'git-archive'/);
assert.match(source, /build-provenance\.json/);
assert.match(source, /update_manifest_sha256: manifestSha256/);
assert.match(source, /agentRelease !== manifest\.agent_version/);
assert.match(source, /await rename\(stagingOutput, outputRoot\)/);
assert.doesNotMatch(source, /randomBytes/);
assert.doesNotMatch(source, /cp\(frontendRoot/);

const deploy = await readFile(path.join(workerRoot, 'deploy.sh'), 'utf8');
assert.match(deploy, /bash \"\$ROOT\/\.\.\/test\.sh\"/);
assert.match(deploy, /NIE_SLA_FRONTEND_REF/);
assert.match(deploy, /FRONTEND_HEAD[\s\S]{0,260}FRONTEND_REF_COMMIT[\s\S]{0,260}测试门禁不能覆盖另一个 commit/);
assert.match(deploy, /deploy --dry-run/);
assert.match(deploy, /build-provenance\.json/);

// One-click config parity: every production Durable Object binding and
// migration must exist in the public template, otherwise fresh deployments
// silently lose probe-history buffering, the live status stream and region
// batches while local tests keep passing.
const production = await readFile(path.join(workerRoot, 'wrangler.toml'), 'utf8');
const template = JSON.parse(await readFile(path.resolve(workerRoot, '..', 'public-release', 'wrangler.jsonc'), 'utf8'));
const productionBindings = [...production.matchAll(/\[\[durable_objects\.bindings\]\]([\s\S]*?)(?=\n\[\[|$)/g)].map((match) => ({
  name: (match[1].match(/name = "([^"]+)"/) || [])[1],
  className: (match[1].match(/class_name = "([^"]+)"/) || [])[1],
}));
const templateBindings = new Map((template.durable_objects?.bindings || []).map((binding) => [binding.name, binding.class_name]));
for (const binding of productionBindings) {
  assert.equal(templateBindings.get(binding.name), binding.className, `public template missing DO binding ${binding.name}`);
}
const productionMigrations = [...production.matchAll(/\[\[migrations\]\]([\s\S]*?)(?=\n\[\[|$)/g)].map((match) => {
  const tag = (match[1].match(/tag = "([^"]+)"/) || [])[1];
  const classes = [...match[1].matchAll(/"([^"]+)"/g)].map((value) => value[1]).filter((value) => value !== tag);
  return { tag, classes };
});
const templateMigrations = new Map((template.migrations || []).map((migration) => [migration.tag, (migration.new_sqlite_classes || []).join(',')]));
for (const migration of productionMigrations) {
  assert.equal(templateMigrations.get(migration.tag), migration.classes.join(','), `public template missing migration ${migration.tag}`);
}

// Cloudflare build environments must provision the internal DO secret:
// without it every internal Durable Object call fails closed (401 -> 500) on
// fresh one-click deployments.
const oneClick = await readFile(path.resolve(workerRoot, '..', 'public-release', 'scripts', 'prepare-one-click.mjs'), 'utf8');
assert.match(oneClick, /INTERNAL_CRON_SECRET/, 'one-click build must provision INTERNAL_CRON_SECRET');
assert.match(oneClick, /WORKERS_CI/, 'secret provisioning must target Cloudflare build environments');
assert.match(oneClick, /randomBytes\(24\)/, 'generated secret must use crypto randomness');

console.log('prepare-assets provenance contract passed');
