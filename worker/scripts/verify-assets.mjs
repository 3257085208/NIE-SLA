import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// macOS/iCloud file providers recreate "name 2.ext" conflict copies inside
// generated directories while a Worker deployment uploads them. They were
// uploaded to production once, so every deployment sweeps them right before
// wrangler runs and fails closed if any survive.

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(process.argv[2] || path.join(workerRoot, 'dist-one-click'));
const isConflictCopy = (name) => / \d+(?:\.[^/]*)?$/.test(name);

async function walk(directory, visit) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (isConflictCopy(entry.name)) {
      await visit(full, entry);
      continue;
    }
    if (entry.isDirectory()) await walk(full, visit);
  }
}

const removed = [];
await walk(outputRoot, async (full, entry) => {
  await rm(full, { recursive: entry.isDirectory(), force: true });
  removed.push(path.relative(outputRoot, full));
});
if (removed.length) {
  const preview = removed.slice(0, 10).join(', ');
  console.log(`removed ${removed.length} file-sync conflict copies: ${preview}${removed.length > 10 ? ' …' : ''}`);
}

const leftovers = [];
await walk(outputRoot, (full) => {
  leftovers.push(path.relative(outputRoot, full));
});
if (leftovers.length) {
  throw new Error(`static assets still contain file-sync conflict copies: ${leftovers.slice(0, 10).join(', ')}`);
}
console.log('static assets contain no file-sync conflict copies');
