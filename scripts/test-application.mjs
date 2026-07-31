import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const socketsLoader = path.join(root, 'worker', 'tests', 'cloudflare-sockets-loader.mjs');

function filesIn(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file, extension) : entry.name.endsWith(extension) ? [file] : [];
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
