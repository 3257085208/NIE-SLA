import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
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

const [appSource, adminSource, adminCss, adminHtml] = await Promise.all([
  readFile(path.join(root, 'app.js'), 'utf8'),
  readFile(path.join(root, 'js', 'admin.js'), 'utf8'),
  readFile(path.join(root, 'admin.css'), 'utf8'),
  readFile(path.join(root, 'admin.html'), 'utf8'),
]);
assert.match(adminSource, /showInstallProgress\(t\);[\s\S]*apiAdmin\(/, 'deploy must show feedback before requesting the command');
assert.match(adminSource, /data-retry-install/, 'deploy failures must offer a retry action');
assert.match(adminSource, /data-target-id=/, 'deploy buttons must carry a stable target id');
assert.match(adminSource, /button\?\.dataset\.targetId \|\| button\?\.closest\("tr"\)\?\.dataset\.id/, 'deploy actions must resolve the stable button target id first');
assert.match(adminSource, /targetGroupOptions\(type, target\.group_name\)/, 'target grouping must be a VPS/Web selector');
assert.match(adminSource, /bindCatalogSearch\("mLocationSearch", "mLocation"/, 'location must provide catalog search');
assert.match(adminSource, /currencyOptionsHtml\(target\.currency \|\| "USD"\)/, 'currency must use the supported selector');
assert.match(adminSource, /id="mNoPublicIp"/, 'VPS editor must expose the no-public-IP option');
assert.match(adminSource, /const cfDetails = noPublicIp[\s\S]*\? ""/, 'no-public-IP targets must hide Cloudflare status in admin');
assert.match(adminSource, /\/api\/latency-agents/, 'admin must manage independent Latency nodes');
assert.match(adminSource, /install-command\?node_id=/, 'Latency nodes must have an independent installer command');
assert.doesNotMatch(appSource, /pingRows \|\| cardLatencyRow/, 'Latency rendering must not fall back to Ping rows');
assert.doesNotMatch(adminCss, /min-width:\s*(?:1080|1280)px/, 'probe table must not regress to the old extra-wide layout');
assert.match(adminCss, /width:\s*min\(980px,\s*calc\(100vw - 44px\)\)/, 'admin content width should match the frontend rhythm');
assert.doesNotMatch(adminCss, /\.stat(?:\.\w+)?::before/, 'dashboard stats must not render decorative edge stripes');
assert.match(adminCss, /\.group-by-menu\s*\{[\s\S]*box-shadow:/, 'group selector must use the custom admin menu');
assert.match(adminSource, /data-group-value/, 'group selector must use structured custom options');
assert.match(adminCss, /\.modal::\-webkit-scrollbar\s*\{[\s\S]*display:\s*none/, 'long edit dialogs must hide the native scrollbar');
assert.match(adminCss, /#tTable \.table-scroll\s*\{\s*overflow:\s*visible/, 'only the card-based target table may overflow on mobile');
assert.match(adminHtml, /admin\.css\?v=20260721-latency-sources/, 'admin CSS cache key must publish the Latency controls');
assert.match(adminHtml, /js\/admin\.js\?v=20260721-latency-sources/, 'admin JS cache key must publish the Latency controls');

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
