import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

for (const area of ['agent', 'frontend']) {
  const manifestPath = path.join(root, area, 'bin', 'SHA256SUMS');
  const hasManifest = await access(manifestPath).then(() => true, () => false);
  if (hasManifest) {
    const manifest = await readFile(manifestPath);
    const entries = manifest.toString('utf8').trim().split(/\r?\n/).map((line) => {
      const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
      assert.ok(match, `${area} invalid manifest line: ${line}`);
      return { hash: match[1].toLowerCase(), name: match[2].replace(/^bin\//, '') };
    });
    for (const entry of entries) {
      const binary = await readFile(path.join(root, area, 'bin', entry.name));
      assert.equal(sha256(binary), entry.hash, `${area}/${entry.name} hash`);
    }
  }

  for (const script of ['setup.sh', 'update.sh']) {
    const source = await readFile(path.join(root, area, script), 'utf8');
    assert.ok(source.includes('$2 == name || $2 == "bin/" name'), `${area}/${script} accepts both manifest paths`);
    assert.ok(source.includes('-n "$sums_expected"'), `${area}/${script} supports deployment-time manifest pinning`);
  }

  assert.equal(await access(path.join(root, area, 'install.ps1')).then(() => true, () => false), false, `${area} must not publish a Windows installer`);
}

const commandSource = await readFile(path.join(root, 'worker', 'src', 'admin', 'install-command.js'), 'utf8');
assert.ok(commandSource.includes("env.NIE_SLA_SHA256SUMS_SHA256 || env.NSTATUS_SHA256SUMS_SHA256 || ''"), 'public install command requires deployment-time release metadata');
assert.doesNotMatch(commandSource, /env\.(?:NIE_SLA|NSTATUS)_SHA256SUMS_SHA256[^\n]*\|\|\s*'[a-f0-9]{64}'/i, 'public source must not pin a private manifest');

console.log('installer manifest tests passed');
