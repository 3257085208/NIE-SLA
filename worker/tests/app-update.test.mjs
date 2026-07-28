import assert from 'node:assert/strict';
import {
  compareAppVersions,
  getAppUpdateInfo,
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
assert.equal(compareAppVersions('0.23.0-beta.2', '0.23.0-beta.1'), 1);
assert.equal(compareAppVersions('0.23.0-beta.3', '0.23.0-beta.2'), 1);
assert.equal(compareAppVersions('0.23.0', '0.23.0-beta.1'), 1);
assert.equal(compareAppVersions('0.23.0-beta.1', '0.23.0'), -1);
assert.equal(parseAppUpdateManifest({ ...manifest, version: '0.23.0-beta.1', source_ref: 'app-v0.23.0-beta.1' }).version, '0.23.0-beta.1');
assert.equal(parseAppUpdateManifest(manifest).source_ref, 'app-v1.1.0');
assert.equal(parseAppUpdateManifest({ ...manifest, release_url: 'not a URL' }).release_url, '');
assert.throws(() => parseAppUpdateManifest({ ...manifest, source_ref: 'main' }), /source ref/);

const env = { APP_UPDATE_MANIFEST_URL: 'https://updates.example.test/manifest.json' };
const info = await getAppUpdateInfo(env, {
  force: true,
  fetchImpl: async () => new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }),
});

assert.equal(info.current_version, '0.24.0-beta.26');
assert.equal(info.latest_version, '1.1.0');
assert.equal(info.update_available, true);
assert.equal(info.update_mode, 'github-actions');
assert.equal(info.automatic_check_hours, 6);
assert.equal(info.workflow_file, 'nie-sla-update.yml');
assert.equal('repository' in info, false);
assert.equal('token_stored' in info, false);
assert.equal('github_token' in info, false);

console.log('application update tests passed');
