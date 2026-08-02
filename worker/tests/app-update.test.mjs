import assert from 'node:assert/strict';
import {
  compareAppVersions,
  getAppUpdateInfo,
  parseAppUpdateManifest,
  resetAppUpdateCacheForTests,
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
await assert.rejects(
  getAppUpdateInfo({ APP_UPDATE_MANIFEST_URL: 'https://user:secret@updates.example.test/manifest.json' }),
  /禁止内嵌凭据/,
);

const env = { APP_UPDATE_MANIFEST_URL: 'https://updates.example.test/manifest.json' };
resetAppUpdateCacheForTests();
const info = await getAppUpdateInfo(env, {
  force: true,
  fetchImpl: async () => new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }),
});

assert.equal(info.current_version, '1.0.65');
assert.equal(info.latest_version, '1.1.0');
assert.equal(info.update_available, true);
assert.equal(info.stale, false);
assert.equal(info.update_source, 'official');
assert.equal(info.update_mode, 'github-actions');
assert.equal(info.automatic_check_hours, 6);
assert.equal(info.workflow_file, 'nie-sla-update.yml');
assert.equal('repository' in info, false);
assert.equal('token_stored' in info, false);
assert.equal('github_token' in info, false);

const bundledManifest = {
  ...manifest,
  version: '1.0.65',
  source_ref: 'app-v1.0.65',
  title: 'NIE-SLA 1.0.65',
};
let upstreamRequests = 0;
let assetRequests = 0;
resetAppUpdateCacheForTests();
const fallbackEnv = {
  APP_UPDATE_MANIFEST_URL: 'https://rate-limited.example.test/manifest.json',
  ASSETS: {
    async fetch(request) {
      assetRequests += 1;
      assert.equal(new URL(request.url).pathname, '/update-manifest.json');
      return new Response(JSON.stringify(bundledManifest), { status: 200 });
    },
  },
};
const rateLimitedFetch = async () => {
  upstreamRequests += 1;
  return new Response('rate limited', { status: 429 });
};
const fallbackInfo = await getAppUpdateInfo(fallbackEnv, { force: true, fetchImpl: rateLimitedFetch });
assert.equal(fallbackInfo.current_version, '1.0.65');
assert.equal(fallbackInfo.latest_version, '1.0.65');
assert.equal(fallbackInfo.update_available, false);
assert.equal(fallbackInfo.stale, true);
assert.equal(fallbackInfo.update_source, 'bundled');
assert.equal(upstreamRequests, 1);
assert.equal(assetRequests, 1);

const backedOffInfo = await getAppUpdateInfo(fallbackEnv, { force: true, fetchImpl: rateLimitedFetch });
assert.equal(backedOffInfo.update_source, 'bundled');
assert.equal(upstreamRequests, 1, '429 backoff must prevent repeated upstream requests');
assert.equal(assetRequests, 1, 'bundled manifest must remain cached during backoff');

resetAppUpdateCacheForTests();
let staleRequests = 0;
const staleEnv = { APP_UPDATE_MANIFEST_URL: 'https://stale.example.test/manifest.json' };
await getAppUpdateInfo(staleEnv, {
  force: true,
  fetchImpl: async () => {
    staleRequests += 1;
    return new Response(JSON.stringify(manifest), { status: 200 });
  },
});
const staleInfo = await getAppUpdateInfo(staleEnv, {
  force: true,
  fetchImpl: async () => {
    staleRequests += 1;
    return new Response('unavailable', { status: 503 });
  },
});
assert.equal(staleInfo.latest_version, '1.1.0');
assert.equal(staleInfo.stale, true);
assert.equal(staleInfo.update_source, 'cache');
assert.equal(staleRequests, 2);

resetAppUpdateCacheForTests();
let concurrentRequests = 0;
const concurrentEnv = { APP_UPDATE_MANIFEST_URL: 'https://concurrent.example.test/manifest.json' };
const concurrentFetch = async () => {
  concurrentRequests += 1;
  await new Promise((resolve) => setTimeout(resolve, 10));
  return new Response(JSON.stringify(manifest), { status: 200 });
};
const concurrentResults = await Promise.all([
  getAppUpdateInfo(concurrentEnv, { force: true, fetchImpl: concurrentFetch }),
  getAppUpdateInfo(concurrentEnv, { force: true, fetchImpl: concurrentFetch }),
]);
assert.equal(concurrentRequests, 1, 'concurrent refreshes must share one upstream request');
assert.equal(concurrentResults[0].latest_version, concurrentResults[1].latest_version);

console.log('application update tests passed');
