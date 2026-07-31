import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendCandidates = [
  path.resolve(root, '..', 'frontend'),
  path.join(root, 'frontend'),
];
const frontend = frontendCandidates.find((candidate) =>
  fs.existsSync(path.join(candidate, 'vendor', 'tasks', 'manifest.json')),
);
assert.ok(frontend, 'production frontend task source manifest is required');

const manifest = JSON.parse(
  fs.readFileSync(path.join(frontend, 'vendor', 'tasks', 'manifest.json'), 'utf8'),
);
const rust = fs.readFileSync(path.join(root, 'agent', 'src', 'tasks.rs'), 'utf8');
for (const asset of manifest.assets) {
  assert.ok(rust.includes(`"${asset.sha256}"`), `${asset.id} digest must match Rust`);
  assert.ok(rust.includes(`"${asset.file}"`), `${asset.id} asset path must match Rust`);
}
assert.ok(rust.includes('/vendor/tasks/'));
console.log(`Agent task vendor contract verified (${manifest.assets.length} assets)`);
