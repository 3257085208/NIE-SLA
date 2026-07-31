import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'vendor', 'tasks');
const manifest = JSON.parse(fs.readFileSync(path.join(vendorDir, 'manifest.json'), 'utf8'));

assert.equal(manifest.schema, 'nie-sla-reviewed-task-sources-v1');
assert.match(manifest.reviewed_at, /^\d{4}-\d{2}-\d{2}$/);
assert.deepEqual(
  manifest.assets.map((asset) => asset.id).sort(),
  ['ip-check', 'nodequality'],
);

for (const asset of manifest.assets) {
  assert.match(asset.source_commit, /^[0-9a-f]{40}$/);
  assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  assert.equal(asset.license, 'AGPL-3.0-only');
  const bytes = fs.readFileSync(path.join(vendorDir, asset.file));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), asset.sha256);
}

assert.match(
  fs.readFileSync(path.join(vendorDir, 'AGPL-3.0.txt'), 'utf8'),
  /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/,
);
console.log(`reviewed task source snapshots verified (${manifest.assets.length} assets)`);
