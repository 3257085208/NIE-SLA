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

const nodequalitySource = fs.readFileSync(path.join(vendorDir, 'nodequality.sh'), 'utf8');
assert.match(nodequalitySource, /github_mirrors=\(/, 'NodeQuality must keep a GitHub mirror fallback list');
assert.match(nodequalitySource, /bench_os_sha256_x86_64=/, 'NodeQuality must pin the x86_64 BenchOs checksum');
assert.match(nodequalitySource, /download_with_mirrors "\$bench_os_url"/, 'BenchOs downloads must use mirror fallback');
assert.doesNotMatch(nodequalitySource, /curl "-L#o" BenchOs\.tar\.gz \$bench_os_url/, 'BenchOs must not rely only on the GitHub direct URL');
console.log(`reviewed task source snapshots verified (${manifest.assets.length} assets)`);
