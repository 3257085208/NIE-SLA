import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = path.resolve(workerRoot, '..', '..', 'frontend');
const updateManifest = path.resolve(workerRoot, '..', 'public-release', 'update-manifest.json');
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

const frontendInfo = await stat(frontendRoot).catch(() => null);
if (!frontendInfo?.isDirectory()) {
  throw new Error(`生产前端目录不存在：${frontendRoot}`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await cp(frontendRoot, outputRoot, {
  recursive: true,
  filter(entry) {
    const relative = path.relative(frontendRoot, entry);
    return !relative.split(path.sep).some(part => excluded.has(part));
  },
});
await cp(updateManifest, path.join(outputRoot, 'update-manifest.json'));

// A unique asset forces Wrangler to process a fresh assets manifest instead of
// reusing a stale one that can leave static files absent from ASSETS.
const releaseBuildId = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
await writeFile(path.join(outputRoot, 'release-build-id.txt'), `${releaseBuildId}\n`, 'utf8');

console.log(`release build id: ${releaseBuildId}`);
console.log(`静态资源已生成：${path.relative(workerRoot, outputRoot)}`);
