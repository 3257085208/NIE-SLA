import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseJsonc } from '../scripts/jsonc.mjs';

// Release gate: replay the online-update chain against a repository shaped like
// a real one-click deployment (no .github CI files, an older preserved
// wrangler.jsonc, the minimal reusable-workflow wrapper). Every failure this
// simulation reproduces has escaped to production at least once, so keep it in
// the release path.

if (process.env.NIE_SLA_DEPLOYMENT_VALIDATION === '1') {
  console.log('deployment update simulation skipped (deployment validation)');
  process.exit(0);
}

const root = path.resolve(import.meta.dirname, '..');
const workflowPath = path.join(root, '.github/workflows/nie-sla-update.yml');
if (!existsSync(workflowPath)) {
  console.log('deployment update simulation skipped (official workflow not present in this snapshot)');
  process.exit(0);
}

const workflow = readFileSync(workflowPath, 'utf8');
const compareFragment = 'rsync -rlpcni --delete';
const applyFragment = 'rsync -rlpc --delete';
const excludeFragments = ["--exclude='.git/'", "--exclude='.github/'", "--exclude='.dev.vars'", "--exclude='wrangler.jsonc'"];
const mtimeFilter = "grep -vE '^\\.(f|d|L)\\.\\.T\\.\\.\\.\\.'";
for (const fragment of [compareFragment, applyFragment, ...excludeFragments, mtimeFilter]) {
  assert.ok(workflow.includes(fragment), `update workflow must keep the fragment this gate exercises: ${fragment}`);
}
assert.match(workflow, /Merged official Durable Object bindings and migrations into wrangler\.jsonc/, 'update workflow must ship the DO binding merge');

// Exercise the merge logic exactly as shipped: extract the heredoc from the
// workflow instead of duplicating it here.
const heredocs = [...workflow.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s*NODE\n/g)]
  .map((match) => match[1].split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n'));
const mergeScript = heredocs.find((block) => block.includes('durable_objects') && block.includes('writeFileSync'));
assert.ok(mergeScript, 'update workflow must ship the DO binding merge script');

const WRAPPER = `name: NIE-SLA Online Update
on:
  workflow_dispatch:
  schedule:
    - cron: "17 */6 * * *"
permissions:
  contents: write
jobs:
  update:
    uses: 3257085208/NIE-SLA/.github/workflows/nie-sla-update.yml@main
`;
const OLD_CONFIG = {
  $schema: './node_modules/wrangler/config-schema.json',
  name: 'nie-sla-sim-deployment',
  main: './worker/src/index.js',
  compatibility_date: '2026-07-24',
  compatibility_flags: ['global_fetch_strictly_public'],
  workers_dev: true,
  assets: { directory: './dist-one-click', binding: 'ASSETS', run_worker_first: true, not_found_handling: '404-page' },
  triggers: { crons: ['* * * * *'] },
  d1_databases: [{ binding: 'DB', database_name: 'nie-sla-db', database_id: '279ad7f9-0b69-49aa-90eb-c42321eda6c3' }],
  r2_buckets: [{ binding: 'ARCHIVE', bucket_name: 'nie-sla-archive' }],
  durable_objects: {
    bindings: [
      { name: 'REGION_PROXY', class_name: 'ProbeRegion' },
      { name: 'TELEMETRY_BUFFER', class_name: 'TelemetryBuffer' },
    ],
  },
  migrations: [
    { tag: 'v1', new_sqlite_classes: ['ProbeRegion'] },
    { tag: 'v2', new_sqlite_classes: ['TelemetryBuffer'] },
  ],
};

const temp = mkdtempSync(path.join(tmpdir(), 'nie-sla-deploy-sim-'));
const deployment = path.join(temp, 'deployment');
const baseline = path.join(temp, 'baseline');
const target = path.join(temp, 'target');
const runner = path.join(temp, 'runner');
try {
  extract(root, target);
  extract(root, deployment);
  rmSync(path.join(deployment, '.github'), { recursive: true, force: true });
  rmSync(path.join(deployment, 'wrangler.jsonc'), { force: true });
  mkdirSync(path.join(deployment, '.github/workflows'), { recursive: true });
  writeFileSync(path.join(deployment, '.github/workflows/nie-sla-update.yml'), WRAPPER);
  // Deployment configs are allowed to be JSON-with-comments.
  const oldConfigJsonc = JSON.stringify(OLD_CONFIG, null, 2)
    .replace('{\n', '{\n  // deployment-local config kept across updates\n')
    .replace('\n}', ',\n}');
  writeFileSync(path.join(deployment, 'wrangler.jsonc'), `${oldConfigJsonc}\n`);
  // Simulate a deployment that trails the target release: the committed tree
  // carries an older application version.
  writeFileSync(path.join(deployment, 'worker/src/version.js'), 'export const VERSION = "0.0.0";\n');
  // The baseline tag snapshot must match the deployed tree byte-for-byte except
  // for the excluded files; keep a copy for the comparison assertions.
  cpSync(deployment, baseline, { recursive: true });
  run('git', ['init', '-q'], { cwd: deployment });
  run('git', ['add', '-A'], { cwd: deployment });
  run('git', ['-c', 'user.email=sim@example.test', '-c', 'user.name=sim', 'commit', '-qm', 'initial deployment'], { cwd: deployment });
  // A local secret file that is not part of the repository must survive updates.
  writeFileSync(path.join(deployment, '.dev.vars'), 'SIM_SECRET=keep-me\n');

  // Baseline comparison: a matching repository must not be reported as changed,
  // while a real content change must still be caught.
  const excludes = excludeFragments.join(' ');
  const compare = (source, destination) => run('bash', ['-c', `rsync -rlpcni --delete ${excludes} '${source}/' '${destination}/' | ${mtimeFilter} || true`]);
  assert.equal(compare(baseline, deployment).trim(), '', 'a matching deployment must not be reported as changed');
  assert.match(compare(target, deployment), /worker\/src\/version\.js/, 'real content changes must still be detected');

  // Apply the snapshot exactly like the workflow: never touch .github/ or the
  // deployment's own wrangler.jsonc.
  run('bash', ['-c', `rsync -rlpc --delete ${excludes} '${target}/' '${deployment}/'`]);
  assert.equal(
    readFileSync(path.join(deployment, 'worker/src/version.js'), 'utf8'),
    readFileSync(path.join(target, 'worker/src/version.js'), 'utf8'),
    'the applied snapshot must replace application files',
  );
  assert.match(
    readFileSync(path.join(deployment, '.github/workflows/nie-sla-update.yml'), 'utf8'),
    /uses: 3257085208\/NIE-SLA\/\.github\/workflows\/nie-sla-update\.yml@main/,
    'the apply step must never rewrite workflow files',
  );
  assert.equal(parseJsonc(readFileSync(path.join(deployment, 'wrangler.jsonc'), 'utf8')).name, OLD_CONFIG.name, 'the apply step must preserve the deployment config');
  assert.equal(readFileSync(path.join(deployment, '.dev.vars'), 'utf8'), 'SIM_SECRET=keep-me\n', 'the apply step must preserve local secret files');

  // Merge missing official bindings with the shipped script.
  mkdirSync(path.join(runner, 'target-source'), { recursive: true });
  cpSync(path.join(target, 'wrangler.jsonc'), path.join(runner, 'target-source/wrangler.jsonc'));
  execFileSync(process.execPath, ['--input-type=module', '-e', mergeScript], {
    cwd: deployment,
    env: { ...process.env, RUNNER_TEMP: runner },
    stdio: 'pipe',
  });
  const merged = parseJsonc(readFileSync(path.join(deployment, 'wrangler.jsonc'), 'utf8'));
  assert.deepEqual(
    merged.durable_objects.bindings.map((binding) => binding.name),
    ['REGION_PROXY', 'TELEMETRY_BUFFER', 'PROBE_HISTORY', 'STATUS_STREAM'],
    'the merge step must add the missing official DO bindings',
  );
  assert.deepEqual(merged.migrations.at(-1), { tag: 'v4', new_sqlite_classes: ['StatusStream'] }, 'the merge step must add the missing migrations');
  assert.equal(merged.name, OLD_CONFIG.name, 'the merge step must preserve deployment fields');

  // The eventual push must never contain workflow files.
  run('git', ['add', '-A'], { cwd: deployment });
  const staged = run('git', ['status', '--porcelain'], { cwd: deployment });
  assert.doesNotMatch(staged, /\.github\//, 'the update commit must not modify workflow files');
  assert.match(staged, /worker\/src\/version\.js/, 'the update commit must stage application changes');

  // The deployment-validation contract must pass inside the simulated repo.
  execFileSync(process.execPath, ['tests/app-update.test.mjs'], {
    cwd: deployment,
    env: { ...process.env, NIE_SLA_DEPLOYMENT_VALIDATION: '1' },
    stdio: 'pipe',
  });

  console.log('deployment update simulation passed');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function extract(source, destination) {
  mkdirSync(destination, { recursive: true });
  run('bash', ['-c', `git -C '${source}' archive HEAD | tar -x -C '${destination}'`]);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}
