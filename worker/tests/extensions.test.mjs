import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { strToU8, Zip, ZipPassThrough, zipSync } from 'fflate';
import { ensureV6Schema } from '../src/admin/schema.js';
import { recordAgentAvailability } from '../src/agent-availability.js';
import { deleteExtension, getExtensionFile, listManagedExtensions, listManagedExtensionsByType, listPublicExtensions, updateExtension, uploadExtension } from '../src/extensions.js';

const database = new DatabaseSync(':memory:');
const env = { DB: d1(database), ARCHIVE: r2(), PUBLIC_SITE_ORIGIN: 'https://status.example.test', TIMEZONE_OFFSET_MINUTES: '0' };
await ensureV6Schema(env);
await recordAgentAvailability(env, 'availability-test', '2026-07-20T23:50:00Z', Math.floor(new Date('2026-07-21T00:10:00Z').getTime() / 1000));
assert.deepEqual(database.prepare('SELECT day, total_sec, online_sec FROM agent_daily_availability WHERE agent_id = ? ORDER BY day').all('availability-test').map(row => ({ ...row })), [
  { day: '2026-07-20', total_sec: 600, online_sec: 600 },
  { day: '2026-07-21', total_sec: 600, online_sec: 300 },
]);

const themeZip = extensionZip({
  schema: 'nstatus-extension-v1',
  id: 'ocean-theme',
  name: 'Ocean Theme',
  version: '1.0.0',
  type: 'theme',
  base_theme: 'classic',
  styles: ['theme.css'],
}, { 'theme.css': 'body { color: #123456; }' });
const theme = await uploadExtension(uploadRequest(themeZip, 'themes'), env, 'theme');
assert.equal(theme.extension.enabled, false);
assert.equal(theme.extension.storage_root, 'themes/v1');
assert.equal(theme.extension.mode, 'css');
assert.match(theme.extension.package_sha256, /^[a-f0-9]{64}$/);
assert.ok(env.ARCHIVE.keys().some(key => key.startsWith('themes/v1/ocean-theme/')));
await assert.rejects(() => uploadExtension(uploadRequest(themeZip, 'plugins'), env, 'plugin'), /只接受 plugin 包/);
const collidingPluginZip = extensionZip({
  schema: 'nstatus-extension-v1', id: 'ocean-theme', name: 'Colliding Plugin', version: '1.0.0', type: 'plugin', entry: 'index.html', permissions: ['status:read'],
}, { 'index.html': '<!doctype html><p>collision</p>' });
await assert.rejects(() => uploadExtension(uploadRequest(collidingPluginZip, 'plugins'), env, 'plugin'), /已被主题使用/);
await updateExtension('ocean-theme', jsonRequest({ enabled: true }), env);
assert.equal((await listPublicExtensions(env)).active_theme.id, 'ocean-theme');

const canvasThemeZip = extensionZip({
  schema: 'nstatus-extension-v1', id: 'canvas-theme', name: 'Canvas Theme', version: '1.0.0', type: 'theme',
  mode: 'canvas', entry: 'index.html', permissions: ['status:read'], height: 99999,
}, {
  'index.html': '<!doctype html><script src="theme.js"></script>',
  'theme.js': 'parent.postMessage({type:"nstatus:ready"}, "*");',
});
const canvasTheme = await uploadExtension(uploadRequest(canvasThemeZip, 'themes'), env, 'theme');
assert.equal(canvasTheme.extension.mode, 'canvas');
assert.equal(canvasTheme.extension.height, 12000);
await updateExtension('canvas-theme', jsonRequest({ enabled: true }), env, 'theme');
const publicCanvasTheme = (await listPublicExtensions(env)).active_theme;
assert.equal(publicCanvasTheme.id, 'canvas-theme');
assert.equal(publicCanvasTheme.entry, 'index.html');
assert.deepEqual(publicCanvasTheme.permissions, ['status:read']);
const canvasEntryResponse = await getExtensionFile(env, 'canvas-theme', 'index.html');
assert.match(canvasEntryResponse.headers.get('content-security-policy'), /^sandbox allow-scripts;/);
assert.match(canvasEntryResponse.headers.get('content-security-policy'), /connect-src 'none'/);
assert.match(canvasEntryResponse.headers.get('permissions-policy'), /camera=\(\)/);

const privilegedCanvasZip = extensionZip({
  schema: 'nstatus-extension-v1', id: 'unsafe-canvas', name: 'Unsafe Canvas', version: '1.0.0', type: 'theme',
  mode: 'canvas', entry: 'index.html', permissions: ['admin:write'],
}, { 'index.html': '<!doctype html><p>unsafe</p>' });
await assert.rejects(() => uploadExtension(uploadRequest(privilegedCanvasZip, 'themes'), env, 'theme'), /只支持 status:read/);

const mismatchedFilesZip = extensionZip({
  schema: 'nstatus-extension-v1', id: 'files-mismatch', name: 'Files Mismatch', version: '1.0.0', type: 'theme',
  styles: ['theme.css'], files: ['theme.css', 'missing.css'],
}, { 'theme.css': 'body{}' });
await assert.rejects(() => uploadExtension(uploadRequest(mismatchedFilesZip, 'themes'), env, 'theme'), /files 清单/);

const explicitManifestZip = extensionZip({
  schema: 'nstatus-extension-v1', id: 'explicit-files', name: 'Explicit Files', version: '1.0.0', type: 'theme',
  mode: 'css', styles: ['theme.css'], files: ['manifest.json', 'theme.css'],
}, { 'theme.css': 'body{}' });
assert.equal((await uploadExtension(uploadRequest(explicitManifestZip, 'themes'), env, 'theme')).ok, true);

const unknownModeZip = extensionZip({
  schema: 'nstatus-extension-v1', id: 'unknown-mode', name: 'Unknown Mode', version: '1.0.0', type: 'theme',
  mode: 'native', styles: ['theme.css'],
}, { 'theme.css': 'body{}' });
await assert.rejects(() => uploadExtension(uploadRequest(unknownModeZip, 'themes'), env, 'theme'), /mode 只能是 css 或 canvas/);

const permissionlessCanvasZip = extensionZip({
  schema: 'nstatus-extension-v1', id: 'no-permission', name: 'No Permission', version: '1.0.0', type: 'theme',
  mode: 'canvas', entry: 'index.html', permissions: [],
}, { 'index.html': '<!doctype html><p>missing permission</p>' });
await assert.rejects(() => uploadExtension(uploadRequest(permissionlessCanvasZip, 'themes'), env, 'theme'), /必须声明 status:read/);

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
  'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
});
const plugin = await uploadExtension(uploadRequest(pluginZip, 'plugins'), env, 'plugin');
assert.equal(plugin.extension.storage_root, 'plugins/v1');
assert.ok(env.ARCHIVE.keys().some(key => key.startsWith('plugins/v1/hello-plugin/')));
await assert.rejects(() => uploadExtension(uploadRequest(pluginZip, 'themes'), env, 'theme'), /只接受 theme 包/);
await updateExtension('hello-plugin', jsonRequest({ enabled: true }), env);
const publicRegistry = await listPublicExtensions(env);
assert.equal(publicRegistry.plugins[0].id, 'hello-plugin');
assert.equal(publicRegistry.plugins[0].height, 420);

const file = await getExtensionFile(env, 'hello-plugin', 'index.html');
assert.equal(file.status, 200);
assert.match(file.headers.get('content-security-policy'), /connect-src 'none'/);
assert.match(await file.text(), /plugin\.js/);
const svgFile = await getExtensionFile(env, 'hello-plugin', 'icon.svg');
assert.match(svgFile.headers.get('content-security-policy'), /^sandbox;/);
assert.match(svgFile.headers.get('content-security-policy'), /default-src 'none'/);

const replacementThemeZip = extensionZip({
  schema: 'nstatus-extension-v1', id: 'mono-theme', name: 'Mono Theme', version: '1.0.0', type: 'theme', styles: ['theme.css'],
}, { 'theme.css': 'body { color: black; }' });
await uploadExtension(uploadRequest(replacementThemeZip), env);
await updateExtension('mono-theme', jsonRequest({ enabled: true }), env);
const managed = await listManagedExtensions(env);
assert.equal(managed.extensions.find(item => item.id === 'mono-theme').enabled, true);
assert.equal(managed.extensions.find(item => item.id === 'ocean-theme').enabled, false);
assert.deepEqual((await listManagedExtensionsByType(env, 'theme')).extensions.map(item => item.type), ['theme', 'theme', 'theme', 'theme']);
assert.deepEqual((await listManagedExtensionsByType(env, 'plugin')).extensions.map(item => item.type), ['plugin']);
await assert.rejects(() => updateExtension('hello-plugin', jsonRequest({ enabled: false }), env, 'theme'), /主题不存在/);
await assert.rejects(() => deleteExtension('mono-theme', env, 'plugin'), /插件不存在/);

const legacyZip = extensionZip({
  schema: 'nstatus-extension-v1', id: 'legacy-theme', name: 'Legacy Theme', version: '1.0.0', type: 'theme', styles: ['theme.css'],
}, { 'theme.css': 'body { color: gray; }' });
const legacyUpload = await uploadExtension(uploadRequest(legacyZip), env);
await updateExtension('legacy-theme', jsonRequest({ enabled: true }), env);
const legacyRecord = legacyUpload.extension;
const legacyBytes = env.ARCHIVE.value(`themes/v1/${legacyRecord.id}/${legacyRecord.revision}/theme.css`);
env.ARCHIVE.setValue(`extensions/v1/${legacyRecord.id}/${legacyRecord.revision}/theme.css`, legacyBytes);
env.ARCHIVE.deleteValue(`themes/v1/${legacyRecord.id}/${legacyRecord.revision}/theme.css`);
await env.DB.prepare('UPDATE app_meta SET value = ?, updated_at = ? WHERE key = ?').bind(
  JSON.stringify((await listManagedExtensions(env)).extensions.map(item => item.id === legacyRecord.id ? { ...item, storage_root: 'themes/v1' } : item)),
  Math.floor(Date.now() / 1000),
  'extensions:registry:v1',
).run();
assert.equal(await (await getExtensionFile(env, 'legacy-theme', 'theme.css')).text(), 'body { color: gray; }');

await deleteExtension('hello-plugin', env);
assert.equal((await listPublicExtensions(env)).plugins.length, 0);
await assert.rejects(() => getExtensionFile(env, 'hello-plugin', 'index.html'), /不存在/);

const traversalZip = extensionZip({
  schema: 'nstatus-extension-v1', id: 'bad-theme', name: 'Bad', version: '1.0.0', type: 'theme', styles: ['theme.css'],
}, { 'theme.css': 'body{}', '../escape.js': 'nope' });
await assert.rejects(() => uploadExtension(uploadRequest(traversalZip), env), /路径无效/);

await assert.rejects(() => uploadExtension(uploadRequest(themeZip, 'themes', { contentType: 'text/plain' }), env, 'theme'), /ZIP Content-Type/);
await assert.rejects(() => uploadExtension(uploadRequest(strToU8('not a zip')), env), /不是有效的非空 ZIP/);
await assert.rejects(() => uploadExtension(uploadRequest(themeZip, 'themes', { sha256: '0'.repeat(64) }), env, 'theme'), /SHA-256 校验失败/);
await assert.rejects(() => uploadExtension(new Request('https://api.example.test/api/themes/upload', {
  method: 'POST', body: themeZip, headers: { 'content-type': 'application/zip' },
}), env, 'theme'), /缺少有效的 x-extension-sha256/);

const duplicateZip = await duplicateEntryZip();
await assert.rejects(() => uploadExtension(uploadRequest(duplicateZip), env), /重复路径/);

const oversizedManifest = strToU8(JSON.stringify({
  schema: 'nstatus-extension-v1', id: 'large-manifest', name: 'Large', version: '1.0.0', type: 'theme', styles: ['theme.css'], padding: 'x'.repeat(70 * 1024),
}));
await assert.rejects(() => uploadExtension(uploadRequest(zipSync({ 'manifest.json': oversizedManifest, 'theme.css': strToU8('body{}') })), env), /manifest\.json 不能超过 64 KiB/);

const invalidUtf8Manifest = new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]);
await assert.rejects(() => uploadExtension(uploadRequest(zipSync({ 'manifest.json': invalidUtf8Manifest, 'theme.css': strToU8('body{}') })), env), /有效 UTF-8 JSON/);

for (const invalidPath of ['assets/e\u0301.css', 'assets/bad\u0001.css', 'assets/trailing. ', 'a/b/c/d/e/f/g/h/i.css']) {
  const invalidPathZip = extensionZip({
    schema: 'nstatus-extension-v1', id: 'path-test', name: 'Path Test', version: '1.0.0', type: 'theme', styles: [invalidPath],
  }, { [invalidPath]: 'body{}' });
  await assert.rejects(() => uploadExtension(uploadRequest(invalidPathZip), env), /路径无效/);
}

const reservedIdZip = extensionZip({
  schema: 'nstatus-extension-v1', id: 'classic', name: 'Reserved', version: '1.0.0', type: 'theme', styles: ['theme.css'],
}, { 'theme.css': 'body{}' });
await assert.rejects(() => uploadExtension(uploadRequest(reservedIdZip), env), /系统保留名称/);

const writeFailureDatabase = new DatabaseSync(':memory:');
writeFailureDatabase.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
const writeFailureEnv = { DB: d1(writeFailureDatabase), ARCHIVE: r2({ failPutAt: 2 }) };
await assert.rejects(() => uploadExtension(uploadRequest(themeZip), writeFailureEnv), /simulated R2 put failure/);
assert.deepEqual(writeFailureEnv.ARCHIVE.keys(), [], 'failed R2 writes must remove the staged revision');

const registryFailureDatabase = new DatabaseSync(':memory:');
registryFailureDatabase.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
const registryFailureControl = { failMetaWrites: false };
const registryFailureEnv = { DB: d1(registryFailureDatabase, registryFailureControl), ARCHIVE: r2() };
registryFailureControl.failMetaWrites = true;
await assert.rejects(() => uploadExtension(uploadRequest(themeZip), registryFailureEnv), /simulated registry failure/);
assert.deepEqual(registryFailureEnv.ARCHIVE.keys(), [], 'failed registry writes must remove the staged revision');

const corruptRegistryDatabase = new DatabaseSync(':memory:');
corruptRegistryDatabase.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
const corruptRegistryEnv = { DB: d1(corruptRegistryDatabase), ARCHIVE: r2() };
await corruptRegistryEnv.DB.prepare('INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)').bind('extensions:registry:v1', '{broken', 1).run();
await assert.rejects(() => uploadExtension(uploadRequest(themeZip), corruptRegistryEnv), /扩展注册表损坏/);
assert.deepEqual(corruptRegistryEnv.ARCHIVE.keys(), [], 'a corrupt registry must not be silently replaced');

for (const example of ['theme-minimal', 'theme-cards', 'theme-canvas', 'plugin-status-summary']) {
  const root = path.resolve(import.meta.dirname, '..', '..', 'examples', 'extensions', example);
  const names = example === 'theme-cards'
    ? ['manifest.json', 'theme.css', 'LICENSE']
    : example === 'theme-minimal'
      ? ['manifest.json', 'theme.css']
    : example === 'theme-canvas'
      ? ['manifest.json', 'index.html', 'theme.css', 'theme.js']
      : ['manifest.json', 'index.html', 'plugin.css', 'plugin.js'];
  const packageFiles = Object.fromEntries(await Promise.all(names.map(async name => [name, new Uint8Array(await readFile(path.join(root, name)))])));
  const uploaded = await uploadExtension(uploadRequest(zipSync(packageFiles)), env);
  assert.equal(uploaded.ok, true, `${example} must remain a valid package example`);
}

if (process.env.NSTATUS_THEME_ZIP) {
  const packagedTheme = new Uint8Array(await readFile(process.env.NSTATUS_THEME_ZIP));
  const uploaded = await uploadExtension(uploadRequest(packagedTheme, 'themes'), env, 'theme');
  assert.equal(uploaded.extension.id, 'nstatus-cards');
  assert.equal(uploaded.extension.version, '1.1.0');
}

console.log('extension package tests passed');

function extensionZip(manifest, files) {
  return zipSync(Object.fromEntries([
    ['manifest.json', strToU8(JSON.stringify(manifest))],
    ...Object.entries(files).map(([name, value]) => [name, strToU8(value)]),
  ]));
}

function uploadRequest(body, resource = 'extensions', options = {}) {
  const sha256 = options.sha256 || createHash('sha256').update(body).digest('hex');
  return new Request(`https://api.example.test/api/${resource}/upload`, {
    method: 'POST',
    body,
    headers: { 'content-type': options.contentType || 'application/zip', 'x-extension-sha256': sha256 },
  });
}

function jsonRequest(body) {
  return new Request('https://api.example.test', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

function d1(db, controls = {}) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async run() {
          if (controls.failMetaWrites && /^INSERT INTO app_meta\b/i.test(sql.trim())) throw new Error('simulated registry failure');
          return db.prepare(sql).run(...values);
        },
        async all() { return { results: db.prepare(sql).all(...values) }; },
        async first() { return db.prepare(sql).get(...values) || null; },
      };
    },
    async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
  };
}

function r2(options = {}) {
  const values = new Map();
  let putCount = 0;
  return {
    keys() { return [...values.keys()]; },
    value(key) { return values.get(key); },
    setValue(key, value) { values.set(key, value); },
    deleteValue(key) { values.delete(key); },
    async put(key, value) {
      putCount += 1;
      if (putCount === options.failPutAt) throw new Error('simulated R2 put failure');
      values.set(key, new Uint8Array(value));
    },
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

function duplicateEntryZip() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = new Zip((error, chunk, final) => {
      if (error) return reject(error);
      chunks.push(chunk);
      if (final) resolve(Buffer.concat(chunks.map(value => Buffer.from(value))));
    });
    for (const value of ['first', 'second']) {
      const entry = new ZipPassThrough('duplicate.txt');
      archive.add(entry);
      entry.push(strToU8(value), true);
    }
    archive.end();
  });
}
