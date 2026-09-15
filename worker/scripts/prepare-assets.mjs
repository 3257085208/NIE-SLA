import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentRoot = path.resolve(workerRoot, '..');
const frontendRoot = path.resolve(
  process.env.NIE_SLA_FRONTEND_ROOT || path.join(agentRoot, '..', 'frontend'),
);
const frontendRef = (process.env.NIE_SLA_FRONTEND_REF || 'HEAD').trim();
const updateManifest = path.resolve(agentRoot, 'public-release', 'update-manifest.json');
const outputRoot = path.join(workerRoot, 'dist-one-click');
const excluded = new Set([
  '.git',
  '.gitattributes',
  '.github',
  '.gitignore',
  '.wrangler',
  '__pycache__',
  'AGENTS.md',
  '_redirects',
  'functions',
  'node_modules',
  'pnpm-lock.yaml',
  'package.json',
  'README.md',
  'tests',
]);

async function runGit(repoRoot, args) {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function assertCleanGitRepository(repoRoot, label) {
  const resolvedRoot = await realpath(await runGit(repoRoot, ['rev-parse', '--show-toplevel']));
  const expectedRoot = await realpath(repoRoot);
  if (resolvedRoot !== expectedRoot) {
    throw new Error(`${label} Git 根目录不符合预期：${resolvedRoot}`);
  }
  const status = await runGit(repoRoot, ['status', '--porcelain', '--untracked-files=all']);
  if (status) {
    const entries = status.split('\n').filter(Boolean);
    const preview = entries.slice(0, 20).join('; ');
    const suffix = entries.length > 20 ? ' …' : '';
    throw new Error(`${label} 工作树不干净，拒绝生成生产资产：${preview}${suffix}`);
  }
}

function assertSafeGitRef(ref) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(ref)) {
    throw new Error(`Frontend Git ref 含有不允许的字符：${ref}`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

assertSafeGitRef(frontendRef);
await assertCleanGitRepository(agentRoot, 'Agent');
await assertCleanGitRepository(frontendRoot, 'Frontend');

const agentCommit = await runGit(agentRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
const frontendCommit = await runGit(
  frontendRoot,
  ['rev-parse', '--verify', `${frontendRef}^{commit}`],
);
const agentRelease = await runGit(
  agentRoot,
  ['describe', '--tags', '--exact-match', '--match', 'v*', 'HEAD'],
).catch(() => null);

const manifestBytes = await readFile(updateManifest);
let manifest;
try {
  manifest = JSON.parse(manifestBytes.toString('utf8'));
} catch (error) {
  throw new Error(`update-manifest.json 不是有效 JSON：${error.message}`);
}
if (
  !manifest
  || manifest.schema !== 'nie-sla-app-update-v1'
  || typeof manifest.version !== 'string'
  || typeof manifest.agent_version !== 'string'
  || typeof manifest.source_ref !== 'string'
) {
  throw new Error('update-manifest.json 缺少有效 schema/version/agent_version/source_ref');
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  throw new Error(`update-manifest.json version 无效：${manifest.version}`);
}
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.agent_version)) {
  throw new Error(`update-manifest.json agent_version 无效：${manifest.agent_version}`);
}
if (manifest.source_ref !== `app-v${manifest.version}`) {
  throw new Error(`update-manifest.json source_ref 与 version 不一致：${manifest.source_ref}`);
}
if (agentRelease !== manifest.agent_version) {
  throw new Error(
    `Agent HEAD 必须正好位于 ${manifest.agent_version} tag，当前为 ${agentRelease || '无精确 tag'}`,
  );
}

const manifestSha256 = sha256(manifestBytes);
const releaseBuildId = [
  `agent-${agentCommit.slice(0, 12)}`,
  `frontend-${frontendCommit.slice(0, 12)}`,
  `manifest-${manifestSha256.slice(0, 12)}`,
].join('-');
const provenance = {
  schema: 'nie-sla-build-provenance-v1',
  asset_source: 'git-archive',
  agent_commit: agentCommit,
  worker_commit: agentCommit,
  agent_release: agentRelease,
  frontend_ref: frontendRef,
  frontend_commit: frontendCommit,
  update_manifest_sha256: manifestSha256,
  manifest_version: manifest.version,
  manifest_agent_version: manifest.agent_version,
  manifest_source_ref: manifest.source_ref,
};

const stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'nie-sla-assets-'));
const archivePath = path.join(stagingRoot, 'frontend.tar');
const frontendSnapshot = path.join(stagingRoot, 'frontend');
const stagingOutput = path.join(stagingRoot, 'dist-one-click');

try {
  await mkdir(frontendSnapshot, { recursive: true });
  await mkdir(stagingOutput, { recursive: true });
  await execFileAsync('git', [
    '-C',
    frontendRoot,
    'archive',
    '--format=tar',
    '--output',
    archivePath,
    frontendCommit,
  ], { maxBuffer: 1024 * 1024 });
  await execFileAsync('tar', ['-xf', archivePath, '-C', frontendSnapshot], {
    maxBuffer: 1024 * 1024,
  });

  await cp(frontendSnapshot, stagingOutput, {
    recursive: true,
    filter(entry) {
      const relative = path.relative(frontendSnapshot, entry);
      return !relative.split(path.sep).some(part => excluded.has(part));
    },
  });
  await cp(updateManifest, path.join(stagingOutput, 'update-manifest.json'));
  await writeFile(
    path.join(stagingOutput, 'release-build-id.txt'),
    `${releaseBuildId}\n`,
    'utf8',
  );
  await writeFile(
    path.join(stagingOutput, 'build-provenance.json'),
    `${JSON.stringify(provenance, null, 2)}\n`,
    'utf8',
  );

  await rm(outputRoot, { recursive: true, force: true });
  await rename(stagingOutput, outputRoot);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

console.log(`release build id: ${releaseBuildId}`);
console.log(`Agent commit: ${agentCommit}`);
console.log(`Frontend commit: ${frontendCommit} (${frontendRef})`);
console.log(`manifest sha256: ${manifestSha256}`);
console.log(`静态资源已生成：${path.relative(workerRoot, outputRoot)}`);
