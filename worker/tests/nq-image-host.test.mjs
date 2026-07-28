import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { normalizeNodeQualityReport, publicNodeQualityReport } from '../src/nodequality.js';
import {
  getNodeQualityImageHostSettings,
  renderNodeQualitySvg,
  testNodeQualityImageHost,
  updateNodeQualityImageHostSettings,
  uploadNodeQualityReportImages,
  validateUploadEndpoint,
} from '../src/nq-image-host.js';

globalThis.crypto ||= webcrypto;

const routesSource = await readFile(new URL('../src/routes.js', import.meta.url), 'utf8');
for (const path of ['/api/settings/nq-image-host', '/api/settings/nq-image-host/test']) {
  assert.match(routesSource, new RegExp(`${path.replaceAll('/', '\\/')}[\\s\\S]{0,240}withAdmin\\(request, env\\)`), `${path} must require an admin session`);
}
assert.match(routesSource, /content-security-policy[^\n]+default-src 'none'[^\n]+sandbox/, 'proxied SVG reports need a sandboxed CSP');

const env = {
  DB: memoryDb(),
  TOTP_ENCRYPTION_KEY: 'nq-image-host-test-encryption-key',
};

assert.equal(validateUploadEndpoint('https://img.example.com/upload').toString(), 'https://img.example.com/upload');
assert.throws(() => validateUploadEndpoint('http://img.example.com/upload'), /HTTPS/);
assert.throws(() => validateUploadEndpoint('https://127.0.0.1/upload'), /私有|内部/);
assert.throws(() => validateUploadEndpoint('https://img.example.com/api'), /\/upload/);

const svg = renderNodeQualitySvg('\u001b[32m成功\u001b[0m <script>alert(1)</script>', { title: '网络质量' });
assert.match(svg, /<svg/);
assert.match(svg, /#86efac/);
assert.doesNotMatch(svg, /<script>/);
assert.match(svg, /&lt;script&gt;/);

await updateNodeQualityImageHostSettings(jsonRequest({
  enabled: true,
  endpoint: 'https://img.example.com/upload',
  api_token: 'imgbed_test_token_with_upload_permission',
  upload_channel: 'cfr2',
  channel_name: 'NQ-R2',
  folder: 'NIE-SLA/NodeQuality',
}), env);

const settings = await getNodeQualityImageHostSettings(env);
assert.equal(settings.enabled, true);
assert.equal(settings.api_token_set, true);
assert.equal(settings.api_token_source, 'db');
assert.equal('api_token' in settings, false);

const originalFetch = globalThis.fetch;
const uploads = [];
globalThis.fetch = async (url, options) => {
  const file = options.body.get('file');
  uploads.push({ url: String(url), options, file, svg: await file.text() });
  return Response.json([{ src: `/file/test-${uploads.length}.svg` }]);
};
try {
  const test = await testNodeQualityImageHost(jsonRequest({}), env);
  assert.equal(test.image_url, 'https://img.example.com/file/test-1.svg');
  assert.match(uploads[0].url, /\/upload\?/);
  assert.match(uploads[0].url, /uploadChannel=cfr2/);
  assert.match(uploads[0].url, /channelName=NQ-R2/);
  assert.match(uploads[0].url, /uploadFolder=NIE-SLA%2FNodeQuality/);
  assert.equal(uploads[0].options.headers.authorization, 'Bearer imgbed_test_token_with_upload_permission');
  assert.equal(uploads[0].file.type, 'image/svg+xml');

  const normalized = normalizeNodeQualityReport({
    link: 'https://nodequality.com/r/example-report',
    tabs: [
      { id: 'basic', title: '基本信息', content: 'CPU: Test' },
      { id: 'network', title: '网络质量', content: '\u001b[36m网络测试\u001b[0m' },
      { id: 'route', title: '回程路由', content: '1 1.2ms 203.0.113.1 AS64500 [Test] CN' },
    ],
  }, { now: 123 });
  const uploaded = await uploadNodeQualityReportImages(env, normalized, { agentId: 'vps-a', finishedAt: 123 });
  assert.equal(uploaded.status.uploaded, 2);
  const publicReport = publicNodeQualityReport({ id: 'vps-a', name: 'VPS A', nq_report: uploaded.normalized.report, nq_updated_at: 123 });
  const network = publicReport.tabs.find((tab) => tab.id === 'network');
  assert.equal(network.kind, 'image');
  assert.equal(network.image, 'https://img.example.com/file/test-2.svg');
  assert.match(network.content, /网络测试/);
  assert.equal(uploads.length, 3);
} finally {
  globalThis.fetch = originalFetch;
}

await updateNodeQualityImageHostSettings(jsonRequest({ enabled: false, api_token_clear: true }), env);
assert.equal((await getNodeQualityImageHostSettings(env)).api_token_set, false);

console.log('NQ image host tests passed');

function jsonRequest(body) {
  return new Request('https://status.example/api/settings/nq-image-host', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function memoryDb() {
  const meta = new Map();
  return {
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (/SELECT value FROM app_meta/i.test(sql)) {
            const value = meta.get(String(this.values[0]));
            return value === undefined ? null : { value };
          }
          return null;
        },
        async run() {
          if (/INSERT INTO app_meta/i.test(sql)) meta.set(String(this.values[0]), String(this.values[1]));
          return { success: true };
        },
      };
    },
  };
}
