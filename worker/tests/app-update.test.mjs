import assert from 'node:assert/strict';
import {
  compareAppVersions,
  dispatchAppUpdate,
  getAppUpdateInfo,
  normalizeUpdateRepository,
  parseAppUpdateManifest,
} from '../src/app-update.js';

const manifest = {
  schema: 'nie-sla-app-update-v1',
  version: '1.1.0',
  source_ref: 'app-v1.1.0',
  published_at: '2026-07-25T12:00:00Z',
  title: 'NIE-SLA 1.1.0',
  changelog: ['更新中心', '安全修复'],
  release_url: 'https://github.com/3257085208/NIE-SLA/blob/main/CHANGELOG.md',
};

assert.equal(compareAppVersions('1.10.0', '1.9.9'), 1);
assert.equal(compareAppVersions('v1.0.20', '1.0.20'), 0);
assert.equal(compareAppVersions('1.0.19', '1.0.20'), -1);
assert.equal(normalizeUpdateRepository('owner/repo'), 'owner/repo');
assert.equal(normalizeUpdateRepository('https://github.com/owner/repo'), '');
assert.equal(parseAppUpdateManifest(manifest).source_ref, 'app-v1.1.0');
assert.equal(parseAppUpdateManifest({ ...manifest, release_url: 'not a URL' }).release_url, '');
assert.throws(() => parseAppUpdateManifest({ ...manifest, source_ref: 'main' }), /source ref/);

const meta = new Map([['app_update_repository', 'demo/status']]);
const env = {
  APP_UPDATE_MANIFEST_URL: 'https://updates.example.test/manifest.json',
  DB: fakeMetaDb(meta),
};
const manifestResponse = () => new Response(JSON.stringify(manifest), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

const info = await getAppUpdateInfo(env, { force: true, fetchImpl: async () => manifestResponse() });
assert.equal(info.current_version, '1.0.21');
assert.equal(info.latest_version, '1.1.0');
assert.equal(info.update_available, true);
assert.equal(info.repository, 'demo/status');
assert.equal(info.token_stored, false);

const requests = [];
const dispatched = await dispatchAppUpdate(new Request('https://status.example/api/system/update', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ repository: 'demo/deployment', github_token: 'test_token_value_12345678901234567890' }),
}), env, {
  fetchImpl: async (url, options = {}) => {
    requests.push({ url, options });
    if (url === env.APP_UPDATE_MANIFEST_URL) return manifestResponse();
    if (url === 'https://api.github.com/repos/demo/deployment') {
      return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/actions/workflows/nie-sla-update.yml/dispatches')) return new Response(null, { status: 204 });
    throw new Error(`unexpected request: ${url}`);
  },
});
assert.equal(dispatched.accepted, true);
assert.equal(dispatched.target_version, '1.1.0');
assert.equal(meta.get('app_update_repository'), 'demo/deployment');
assert.equal(requests[2].options.method, 'POST');
assert.deepEqual(JSON.parse(requests[2].options.body), {
  ref: 'main',
  inputs: { source_ref: 'app-v1.1.0', expected_version: '1.1.0' },
});
assert.match(requests[1].options.headers.authorization, /^Bearer test_token_value_/);
assert.equal(JSON.stringify(dispatched).includes('test_token_value_'), false);

await assert.rejects(
  () => dispatchAppUpdate(new Request('https://status.example/api/system/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repository: 'demo/deployment', github_token: 'short' }),
  }), env, { fetchImpl: async () => manifestResponse() }),
  /有效的 GitHub/,
);

console.log('application update tests passed');

function fakeMetaDb(values) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              return sql.startsWith('SELECT value FROM app_meta') && values.has(params[0])
                ? { value: values.get(params[0]) }
                : null;
            },
            async run() {
              if (sql.startsWith('INSERT INTO app_meta')) values.set(params[0], String(params[1]));
              return { success: true };
            },
          };
        },
      };
    },
  };
}
