import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const assetVersion = '20260916-proxy7';
const isDuplicateCopy = (name) => /\s\d+(?:\.\d+)*\.js$/i.test(name);

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(file));
    else if (entry.isFile() && entry.name.endsWith('.js') && !isDuplicateCopy(entry.name)) files.push(file);
  }
  return files;
}

const files = [path.join(root, 'app.js'), path.join(root, 'js', 'admin.js')];
files.push(...await javascriptFiles(path.join(root, 'js')));

for (const file of [...new Set(files)]) {
  const source = await readFile(file, 'utf8');
  const imports = [...source.matchAll(/(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/g)].map((match) => match[1]);
  for (const specifier of imports) {
    const [pathname, query = ''] = specifier.split('?');
    if (!pathname.startsWith('.') || !pathname.endsWith('.js')) continue;
    assert.equal(
      new URLSearchParams(query).get('v'),
      assetVersion,
      `${path.relative(root, file)} imports ${specifier} without the current asset version key`,
    );
  }
}

const htmlAssets = {
  'index.html': ['./style.css', './js/theme-bootstrap.js', './config.js', './app.js'],
  'admin.html': ['/admin.css', '/config.js', '/js/admin-bootstrap.js', '/js/admin.js'],
};
for (const [htmlFile, assets] of Object.entries(htmlAssets)) {
  const source = await readFile(path.join(root, htmlFile), 'utf8');
  for (const asset of assets) {
    const escaped = asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(source, new RegExp(`${escaped}\\?v=${assetVersion}(?:["'])`), `${htmlFile} must version ${asset}`);
  }
}

console.log(`frontend asset versioning contract passed (${assetVersion})`);
