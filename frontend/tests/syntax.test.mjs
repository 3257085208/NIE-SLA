import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = [path.join(root, 'app.js'), path.join(root, 'config.js')];

for (const directory of ['functions', 'js']) {
  files.push(...await javascriptFiles(path.join(root, directory)));
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${path.relative(root, file)} syntax failed:\n${result.stderr}`);
}

console.log(`frontend syntax tests passed (${files.length} files)`);

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
  }
  return files;
}
