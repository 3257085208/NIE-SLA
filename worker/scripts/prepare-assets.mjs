import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = path.resolve(workerRoot, '..', '..', 'frontend');
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
    if (relative === path.join('js', 'themes') || relative.startsWith(`${path.join('js', 'themes')}${path.sep}`)) return false;
    return !relative.split(path.sep).some(part => excluded.has(part));
  },
});

console.log(`静态资源已生成：${path.relative(workerRoot, outputRoot)}`);
