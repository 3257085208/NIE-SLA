import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const privateRoot = path.resolve(import.meta.dirname, '..');
const sourceRoot = path.join(privateRoot, 'agent');
const frontendRoot = path.resolve(privateRoot, '..', 'frontend');

// The sanitized public snapshot intentionally contains no release binaries;
// the byte-for-byte sync contract only applies to the private workspace.
const sourceManifest = await readFile(path.join(sourceRoot, 'bin', 'SHA256SUMS')).catch(() => null);
if (!sourceManifest) {
  console.log('release assets are not part of this snapshot; release asset sync check skipped');
  process.exit(0);
}

const frontendInfo = await stat(frontendRoot).catch(() => null);
if (!frontendInfo?.isDirectory()) {
  console.log('production frontend sibling not present; release asset sync check skipped');
  process.exit(0);
}

const releaseFiles = [
  'cftz',
  'install.sh',
  'quick-install.sh',
  'setup.sh',
  'update.sh',
  'bin/SHA256SUMS',
  'bin/VERSION',
  'bin/jq-linux-amd64',
  'bin/jq-linux-arm64',
  'bin/jq-linux-armel',
  'bin/jq-linux-armhf',
  'bin/jq-linux-i386',
  'bin/nie-sla-agent-linux-386',
  'bin/nie-sla-agent-linux-amd64',
  'bin/nie-sla-agent-linux-arm',
  'bin/nie-sla-agent-linux-arm64',
  'bin/nie-sla-agent-linux-armv6',
  'bin/nstatus-metrics-linux-386',
  'bin/nstatus-metrics-linux-amd64',
  'bin/nstatus-metrics-linux-arm',
  'bin/nstatus-metrics-linux-arm64',
  'bin/nstatus-metrics-linux-armv6',
];

for (const relative of releaseFiles) {
  const [source, published] = await Promise.all([
    readFile(path.join(sourceRoot, relative)),
    readFile(path.join(frontendRoot, relative)),
  ]);
  assert.deepEqual(published, source, `production frontend release asset drift: ${relative}`);
}

console.log(`production frontend release assets synchronized: ${releaseFiles.length} files`);
