import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { strToU8, zipSync } from 'fflate';
import { deleteTheme, getPublicTheme, getThemeFile, listManagedThemes, updateTheme, uploadTheme } from '../src/themes.js';

const env = { DB: d1(), ARCHIVE: r2(), PUBLIC_SITE_ORIGIN: 'https://status.example.test' };
const cssZip = themeZip({
  schema: 'nie-sla-theme-v1',
  id: 'clean-green',
  name: 'Clean Green',
  version: '1.0.0',
  type: 'theme',
  mode: 'css',
  styles: ['theme.css'],
}, { 'theme.css': 'body[data-extension-theme="clean-green"] { --green: #16825d; }' });

const uploadedCss = await uploadTheme(uploadRequest(cssZip), env);
assert.equal(uploadedCss.theme.enabled, false);
assert.equal(uploadedCss.theme.storage_root, 'themes/v1');
assert.match(uploadedCss.theme.package_sha256, /^[a-f0-9]{64}$/);
assert.ok(env.ARCHIVE.keys().some(key => key.startsWith('themes/v1/clean-green/')));
assert.equal((await getPublicTheme(env)).active_theme, null);

await updateTheme('clean-green', jsonRequest({ enabled: true }), env);
assert.equal((await getPublicTheme(env)).active_theme.id, 'clean-green');
assert.match(await (await getThemeFile(env, 'clean-green', 'theme.css')).text(), /--green/);
const activeCss = (await getPublicTheme(env)).active_theme;
const revisionedCss = await getThemeFile(env, 'clean-green', 'theme.css', activeCss.revision);
assert.match(revisionedCss.headers.get('cache-control'), /immutable/);
await assert.rejects(() => getThemeFile(env, 'clean-green', 'theme.css', 'stale-revision'), /版本不存在/);

const replacedCss = await uploadTheme(uploadRequest(cssZip), env);
assert.equal(replacedCss.theme.enabled, false, 'replacing an active theme must require fresh administrator approval');
assert.equal((await getPublicTheme(env)).active_theme, null);
await updateTheme('clean-green', jsonRequest({ enabled: true }), env);

const canvasZip = themeZip({
  schema: 'nie-sla-theme-v1',
  id: 'dashboard-canvas',
  name: 'Dashboard Canvas',
  version: '1.2.0',
  type: 'theme',
  mode: 'canvas',
  entry: 'index.html',
  permissions: ['status:read'],
  height: 99999,
}, {
  'index.html': '<!doctype html><script src="theme.js"></script>',
  'theme.js': 'parent.postMessage({type:"nie-sla:ready"}, "*");',
});
const uploadedCanvas = await uploadTheme(uploadRequest(canvasZip), env);
assert.equal(uploadedCanvas.theme.height, 12000);
await updateTheme('dashboard-canvas', jsonRequest({ enabled: true }), env);
const activeCanvas = (await getPublicTheme(env)).active_theme;
assert.equal(activeCanvas.id, 'dashboard-canvas');
assert.equal(activeCanvas.entry, 'index.html');
assert.equal((await listManagedThemes(env)).themes.find(theme => theme.id === 'clean-green').enabled, false);
const canvasEntry = await getThemeFile(env, 'dashboard-canvas', 'index.html');
assert.match(canvasEntry.headers.get('content-security-policy'), /^sandbox allow-scripts;/);
assert.match(canvasEntry.headers.get('content-security-policy'), /connect-src 'none'/);
assert.match(canvasEntry.headers.get('permissions-policy'), /camera=\(\)/);

const pluginZip = themeZip({
  schema: 'nie-sla-theme-v1',
  id: 'not-a-theme',
  name: 'Not A Theme',
  version: '1.0.0',
  type: 'plugin',
  styles: ['theme.css'],
}, { 'theme.css': 'body{}' });
await assert.rejects(() => uploadTheme(uploadRequest(pluginZip), env), /类型必须是 theme/);

const unsafeCanvas = themeZip({
  schema: 'nie-sla-theme-v1',
  id: 'unsafe-canvas',
  name: 'Unsafe Canvas',
  version: '1.0.0',
  type: 'theme',
  mode: 'canvas',
  entry: 'index.html',
  permissions: ['admin:write'],
}, { 'index.html': '<!doctype html><p>unsafe</p>' });
await assert.rejects(() => uploadTheme(uploadRequest(unsafeCanvas), env), /status:read/);

const mismatchedFiles = themeZip({
  schema: 'nie-sla-theme-v1',
  id: 'files-mismatch',
  name: 'Files Mismatch',
  version: '1.0.0',
  type: 'theme',
  styles: ['theme.css'],
  files: ['theme.css', 'missing.css'],
}, { 'theme.css': 'body{}' });
await assert.rejects(() => uploadTheme(uploadRequest(mismatchedFiles), env), /files 清单/);

const traversalZip = themeZip({
  schema: 'nie-sla-theme-v1',
  id: 'bad-path',
  name: 'Bad Path',
  version: '1.0.0',
  type: 'theme',
  styles: ['theme.css'],
}, { 'theme.css': 'body{}', '../escape.js': 'nope' });
await assert.rejects(() => uploadTheme(uploadRequest(traversalZip), env), /路径无效/);
await assert.rejects(() => uploadTheme(uploadRequest(strToU8('not a zip')), env), /不是有效的非空 ZIP/);
await assert.rejects(() => uploadTheme(uploadRequest(cssZip, { sha256: '0'.repeat(64) }), env), /SHA-256 校验失败/);
await assert.rejects(() => uploadTheme(new Request('https://api.example.test/api/themes/upload', {
  method: 'POST',
  body: cssZip,
  headers: { 'content-type': 'application/zip' },
}), env), /SHA-256/);

const legacyEnv = { DB: d1(), ARCHIVE: r2() };
legacyEnv.DB.meta.set('extensions:registry:v1', JSON.stringify([{
  id: 'legacy-theme',
  name: 'Legacy Theme',
  version: '1.0.0',
  description: '',
  author: '',
  type: 'theme',
  mode: 'css',
  styles: ['theme.css'],
  files: ['manifest.json', 'theme.css'],
  revision: 'legacyrevision',
  storage_root: 'extensions/v1',
  enabled: true,
}]));
legacyEnv.ARCHIVE.setValue('extensions/v1/legacy-theme/legacyrevision/theme.css', strToU8('body{color:gray}'));
assert.equal((await getPublicTheme(legacyEnv)).active_theme.id, 'legacy-theme');
assert.ok(legacyEnv.DB.meta.has('themes:registry:v1'));
assert.match(await (await getThemeFile(legacyEnv, 'legacy-theme', 'theme.css')).text(), /gray/);

for (const unsafeRecord of [
  { ...JSON.parse(legacyEnv.DB.meta.get('extensions:registry:v1'))[0], storage_root: 'backups', revision: '../../private' },
  { ...JSON.parse(legacyEnv.DB.meta.get('extensions:registry:v1'))[0], files: ['manifest.json', '../private.json'] },
  { ...JSON.parse(legacyEnv.DB.meta.get('extensions:registry:v1'))[0], mode: 'plugin' },
]) {
  const unsafeEnv = { DB: d1(), ARCHIVE: r2() };
  unsafeEnv.DB.meta.set('themes:registry:v1', JSON.stringify([unsafeRecord]));
  await assert.rejects(() => getPublicTheme(unsafeEnv), /注册表损坏/);
}

await deleteTheme('dashboard-canvas', env);
assert.equal((await getPublicTheme(env)).active_theme, null);
await assert.rejects(() => getThemeFile(env, 'dashboard-canvas', 'index.html'), /不存在/);

for (const [directory, expectedMode] of [['minimal-css', 'css'], ['minimal-canvas', 'canvas']]) {
  const packageBytes = await exampleThemeZip(directory);
  const uploaded = await uploadTheme(uploadRequest(packageBytes), env);
  assert.equal(uploaded.theme.mode, expectedMode, `${directory} example must remain a valid ${expectedMode} package`);
  assert.equal(uploaded.theme.enabled, false);
}

console.log('theme package tests passed');

function themeZip(manifest, files) {
  return zipSync(Object.fromEntries([
    ['manifest.json', strToU8(JSON.stringify(manifest))],
    ...Object.entries(files).map(([name, value]) => [name, strToU8(value)]),
  ]));
}

async function exampleThemeZip(directory) {
  const root = new URL(`../../examples/themes/${directory}/`, import.meta.url);
  const entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isFile() && !/\s\d+(?:\.\d+)*\.\w+$/i.test(entry.name));
  const files = await Promise.all(entries.map(async entry => [
    entry.name,
    new Uint8Array(await readFile(new URL(entry.name, root))),
  ]));
  return zipSync(Object.fromEntries(files));
}

function uploadRequest(body, options = {}) {
  const sha256 = options.sha256 || createHash('sha256').update(body).digest('hex');
  return new Request('https://api.example.test/api/themes/upload', {
    method: 'POST',
    body,
    headers: {
      'content-type': options.contentType || 'application/zip',
      [options.legacyHeader ? 'x-extension-sha256' : 'x-theme-sha256']: sha256,
    },
  });
}

function jsonRequest(body) {
  return new Request('https://api.example.test', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function d1() {
  const meta = new Map();
  return {
    meta,
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async first() {
          if (/SELECT value FROM app_meta/i.test(sql)) return meta.has(values[0]) ? { value: meta.get(values[0]) } : null;
          return null;
        },
        async run() {
          if (/INSERT INTO app_meta/i.test(sql)) meta.set(values[0], String(values[1]));
          return { success: true };
        },
      };
    },
  };
}

function r2() {
  const values = new Map();
  return {
    keys() { return [...values.keys()]; },
    setValue(key, value) { values.set(key, new Uint8Array(value)); },
    async put(key, value) { values.set(key, new Uint8Array(value)); },
    async get(key) {
      const value = values.get(key);
      return value ? { body: new Response(value).body } : null;
    },
    async list({ prefix = '' } = {}) {
      return { objects: [...values.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
  };
}
