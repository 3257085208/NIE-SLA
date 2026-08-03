import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const socketsLoader = path.join(root, 'worker', 'tests', 'cloudflare-sockets-loader.mjs');

function isDuplicateCopy(name) {
  return /\s\d+(?:\.\d+)*\.(?:js|mjs)$/i.test(name);
}

function filesIn(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesIn(file, extension);
    if (!entry.name.endsWith(extension) || isDuplicateCopy(entry.name)) return [];
    return [file];
  });
}

function run(args) {
  execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
}

for (const file of filesIn(path.join(root, 'worker', 'src'), '.js')) run(['--check', file]);
for (const file of filesIn(path.join(root, 'frontend'), '.js')) run(['--check', file]);
for (const file of filesIn(path.join(root, 'worker', 'tests'), '.mjs')) {
  if (file === socketsLoader) continue;
  const args = file.endsWith(`${path.sep}nq-image-broker-route.test.mjs`)
    ? ['--experimental-loader', socketsLoader, file]
    : [file];
  run(args);
}
for (const file of filesIn(path.join(root, 'frontend', 'tests'), '.mjs')) run([file]);
run([path.join(root, 'tests', 'frontend-app-import-smoke.mjs')]);
run([path.join(root, 'tests', 'frontend-modules.test.mjs')]);

console.log('lightweight application validation passed');
