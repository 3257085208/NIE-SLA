import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { strToU8, zipSync } from 'fflate';
import { ensureV6Schema } from '../src/admin/schema.js';
import { deleteExtension, getExtensionFile, listManagedExtensions, listPublicExtensions, updateExtension, uploadExtension } from '../src/extensions.js';

const database = new DatabaseSync(':memory:');
const env = { DB: d1(database), ARCHIVE: r2(), PUBLIC_SITE_ORIGIN: 'https://status.example.test' };
await ensureV6Schema(env);

const themeZip = extensionZip({
  schema: 'nstatus-extension-v1',
  id: 'ocean-theme',
  name: 'Ocean Theme',
  version: '1.0.0',
  type: 'theme',
  base_theme: 'classic',
  styles: ['theme.css'],
}, { 'theme.css': 'body { color: #123456; }' });
const theme = await uploadExtension(uploadRequest(themeZip), env);
assert.equal(theme.extension.enabled, false);
await updateExtension('ocean-theme', jsonRequest({ enabled: true }), env);
assert.equal((await listPublicExtensions(env)).active_theme.id, 'ocean-theme');

const pluginZip = extensionZip({
  schema: 'nstatus-extension-v1',
  id: 'hello-plugin',
  name: 'Hello Plugin',
  version: '1.2.0',
  type: 'plugin',
  entry: 'index.html',
  permissions: ['status:read'],
  height: 420,
}, {
  'index.html': '<!doctype html><script src="plugin.js"></script>',
  'plugin.js': 'parent.postMessage({type:"nstatus:ready"}, "*");',
});
await uploadExtension(uploadRequest(pluginZip), env);
await updateExtension('hello-plugin', jsonRequest({ enabled: true }), env);
const publicRegistry = await listPublicExtensions(env);
assert.equal(publicRegistry.plugins[0].id, 'hello-plugin');
assert.equal(publicRegistry.plugins[0].height, 420);

const file = await getExtensionFile(env, 'hello-plugin', 'index.html');
assert.equal(file.status, 200);
assert.match(file.headers.get('content-security-policy'), /connect-src 'none'/);
assert.match(await file.text(), /plugin\.js/);

const replacementThemeZip = extensionZip({
  schema: 'nstatus-extension-v1', id: 'mono-theme', name: 'Mono Theme', version: '1.0.0', type: 'theme', styles: ['theme.css'],
}, { 'theme.css': 'body { color: black; }' });
await uploadExtension(uploadRequest(replacementThemeZip), env);
await updateExtension('mono-theme', jsonRequest({ enabled: true }), env);
const managed = await listManagedExtensions(env);
assert.equal(managed.extensions.find(item => item.id === 'mono-theme').enabled, true);
assert.equal(managed.extensions.find(item => item.id === 'ocean-theme').enabled, false);

await deleteExtension('hello-plugin', env);
assert.equal((await listPublicExtensions(env)).plugins.length, 0);
await assert.rejects(() => getExtensionFile(env, 'hello-plugin', 'index.html'), /不存在/);

const traversalZip = extensionZip({
  schema: 'nstatus-extension-v1', id: 'bad-theme', name: 'Bad', version: '1.0.0', type: 'theme', styles: ['theme.css'],
}, { 'theme.css': 'body{}', '../escape.js': 'nope' });
await assert.rejects(() => uploadExtension(uploadRequest(traversalZip), env), /路径无效/);

for (const example of ['theme-minimal', 'plugin-status-summary']) {
  const root = path.resolve(import.meta.dirname, '..', '..', 'examples', 'extensions', example);
  const names = example === 'theme-minimal'
    ? ['manifest.json', 'theme.css']
    : ['manifest.json', 'index.html', 'plugin.css', 'plugin.js'];
  const packageFiles = Object.fromEntries(await Promise.all(names.map(async name => [name, new Uint8Array(await readFile(path.join(root, name)))])));
  const uploaded = await uploadExtension(uploadRequest(zipSync(packageFiles)), env);
  assert.equal(uploaded.ok, true, `${example} must remain a valid package example`);
}

console.log('extension package tests passed');

function extensionZip(manifest, files) {
  return zipSync(Object.fromEntries([
    ['manifest.json', strToU8(JSON.stringify(manifest))],
    ...Object.entries(files).map(([name, value]) => [name, strToU8(value)]),
  ]));
}

function uploadRequest(body) {
  return new Request('https://api.example.test/api/extensions/upload', { method: 'POST', body, headers: { 'content-type': 'application/zip' } });
}

function jsonRequest(body) {
  return new Request('https://api.example.test', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

function d1(db) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async run() { return db.prepare(sql).run(...values); },
        async all() { return { results: db.prepare(sql).all(...values) }; },
        async first() { return db.prepare(sql).get(...values) || null; },
      };
    },
    async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
  };
}

function r2() {
  const values = new Map();
  return {
    async put(key, value) { values.set(key, new Uint8Array(value)); },
    async get(key) {
      const value = values.get(key);
      return value ? { body: new Response(value).body } : null;
    },
    async list({ prefix = '', cursor } = {}) {
      if (cursor) return { objects: [], truncated: false };
      return { objects: [...values.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false };
    },
    async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
  };
}
