import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { nodeQualityImageSource, normalizeNodeQualityReport, publicNodeQualityReport } from '../src/nodequality.js';
import {
  renderNodeQualitySvg,
  uploadNodeQualityReportImages,
  validateUploadEndpoint,
} from '../src/nq-image-host.js';

globalThis.crypto ||= webcrypto;

const routesSource = await readFile(new URL('../src/routes.js', import.meta.url), 'utf8');
assert.doesNotMatch(routesSource, /\/api\/settings\/nq-image-host/, 'image-host configuration must not be exposed through HTTP routes');
assert.match(routesSource, /content-security-policy[^\n]+default-src 'none'[^\n]+sandbox/, 'proxied SVG reports need a sandboxed CSP');
assert.match(routesSource, /nodeQualityImageSource\(target, tabId\)/, 'the image proxy must resolve the private upstream URL internally');

assert.equal(validateUploadEndpoint('https://img.example.com/upload').toString(), 'https://img.example.com/upload');
assert.throws(() => validateUploadEndpoint('http://img.example.com/upload'), /HTTPS/);
assert.throws(() => validateUploadEndpoint('https://127.0.0.1/upload'), /私有|内部/);
assert.throws(() => validateUploadEndpoint('https://img.example.com/api'), /\/upload/);

const svg = renderNodeQualitySvg('\u001b[32m成功\u001b[0m <script>alert(1)</script>');
assert.match(svg, /<svg/);
assert.match(svg, /#4ab118/);
assert.match(svg, /#1d1d1e/);
assert.doesNotMatch(svg, /NodeQuality · 网络质量/);
assert.doesNotMatch(svg, /<script>/);
assert.match(svg, /&lt;script&gt;/);

const styledSvg = renderNodeQualitySvg('\u001b[1;37;44m标签\u001b[0m \u001b[3;4;31m强调\u001b[0m');
assert.match(styledSvg, /fill="#0f4ac6"/);
assert.match(styledSvg, /fill="#f6f5fb" font-weight="700"/);
assert.match(styledSvg, /font-style="italic"/);
assert.match(styledSvg, /text-decoration="underline"/);
const squareBarSvg = renderNodeQualitySvg('⣿⣀');
assert.match(squareBarSvg, /data-nq-bar="square"/);
assert.doesNotMatch(squareBarSvg, /[⣿⣀]/);

const legacySettings = {
  enabled: true,
  endpoint: 'https://legacy-image-host.example/upload',
  upload_channel: 'cfr2',
  channel_name: 'legacy-r2',
  folder: 'NIE-SLA/NodeQuality',
};
const env = {
  DB: memoryDb({ nq_image_host_settings: JSON.stringify(legacySettings) }),
  NQ_IMGBED_URL: 'https://img.example.com/upload',
  NQ_IMGBED_TOKEN: 'server_only_imgbed_token_with_upload_permission',
  NQ_IMGBED_CHANNEL: 'telegram',
  NQ_IMGBED_CHANNEL_NAME: 'NQ-S3',
  NQ_IMGBED_FOLDER: 'must/not/be/used',
};

const normalized = normalizeNodeQualityReport({
  link: 'https://nodequality.com/r/example-report',
  tabs: [
    { id: 'basic', title: '基本信息', content: 'CPU: Test' },
    { id: 'network', title: '网络质量', content: '\u001b[36m网络测试\u001b[0m' },
    { id: 'route', title: '回程路由', content: '1 1.2ms 203.0.113.1 AS64500 [Test] CN' },
  ],
}, { now: 123 });

const originalFetch = globalThis.fetch;
const uploads = [];
globalThis.fetch = async (url, options) => {
  const file = options.body.get('file');
  uploads.push({ url: String(url), options, file, svg: await file.text() });
  return Response.json([{ src: `/file/test-${uploads.length}.svg` }]);
};
try {
  const uploaded = await uploadNodeQualityReportImages(env, normalized, { agentId: 'vps-a', finishedAt: 123 });
  assert.equal(uploaded.status.uploaded, 2);
  assert.equal(uploads.length, 2);
  for (const upload of uploads) {
    const uploadUrl = new URL(upload.url);
    assert.equal(uploadUrl.origin, 'https://img.example.com');
    assert.equal(uploadUrl.pathname, '/upload');
    assert.equal(uploadUrl.searchParams.get('uploadChannel'), 's3');
    assert.equal(uploadUrl.searchParams.has('uploadFolder'), false, 'the S3 upload folder must remain empty');
    assert.equal(uploadUrl.searchParams.get('channelName'), 'NQ-S3');
    assert.equal(uploadUrl.searchParams.get('serverCompress'), 'false');
    assert.equal(upload.url.includes(env.NQ_IMGBED_TOKEN), false);
    assert.equal(upload.options.headers.authorization, `Bearer ${env.NQ_IMGBED_TOKEN}`);
    assert.equal(upload.options.redirect, 'manual');
    assert.equal(upload.file.type, 'image/svg+xml');
  }

  const storedTarget = { id: 'vps-a', name: 'VPS A', nq_report: uploaded.normalized.report, nq_updated_at: 123 };
  assert.equal(nodeQualityImageSource(storedTarget, 'network'), 'https://img.example.com/file/test-1.svg');
  const publicReport = publicNodeQualityReport(storedTarget);
  const network = publicReport.tabs.find((tab) => tab.id === 'network');
  assert.equal(network.kind, 'image');
  assert.equal(network.image, '/api/nq/vps-a/image/network');
  assert.match(network.content, /网络测试/);
  assert.equal(JSON.stringify(publicReport).includes('img.example.com'), false, 'public NQ JSON must hide the upstream image host');
  assert.equal(JSON.stringify(publicReport).includes(env.NQ_IMGBED_TOKEN), false, 'public NQ JSON must never expose the API token');
} finally {
  globalThis.fetch = originalFetch;
}

const oneImageReport = normalizeNodeQualityReport({
  link: 'https://nodequality.com/r/error-report',
  tabs: [{ id: 'network', title: '网络质量', content: 'Network: Test' }],
}, { now: 124 });

for (const [status, expected] of [
  [302, /不允许的重定向/],
  [400, /上传渠道/],
  [401, /Token 无效或已过期/],
  [403, /upload 权限/],
  [404, /\/upload/],
  [429, /请求过于频繁/],
  [503, /暂时不可用/],
]) {
  globalThis.fetch = async () => new Response('upstream details must remain private', { status });
  const result = await uploadNodeQualityReportImages(env, oneImageReport);
  assert.equal(result.status.uploaded, 0);
  assert.match(result.status.errors[0], expected);
  assert.doesNotMatch(result.status.errors[0], /upstream details|img\.example\.com/);
}

for (const [body, expected] of [
  ['not-json', /无效 JSON/],
  ['{}', /没有图片地址/],
  ['{"src":"http://127.0.0.1/private.svg"}', /无效或不安全/],
]) {
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await uploadNodeQualityReportImages(env, oneImageReport);
  assert.match(result.status.errors[0], expected);
}

globalThis.fetch = async () => { throw new TypeError('fetch failed for https://secret-upstream.example/path'); };
let failed = await uploadNodeQualityReportImages(env, oneImageReport);
assert.match(failed.status.errors[0], /无法连接/);
assert.doesNotMatch(failed.status.errors[0], /secret-upstream|img\.example\.com/);
globalThis.fetch = async () => {
  const error = new Error('aborted');
  error.name = 'AbortError';
  throw error;
};
failed = await uploadNodeQualityReportImages(env, oneImageReport);
assert.match(failed.status.errors[0], /上传超时/);
globalThis.fetch = originalFetch;

const legacyToken = 'legacy_encrypted_imgbed_token_with_upload_permission';
const legacyKey = 'legacy-nq-image-host-encryption-key';
const legacyCiphertext = await encryptLegacyToken(legacyToken, legacyKey);
const fallbackEnv = {
  DB: memoryDb({
    nq_image_host_settings: JSON.stringify(legacySettings),
    nq_image_host_token: legacyCiphertext,
  }),
  TOTP_ENCRYPTION_KEY: 'new-long-term-nq-encryption-key-with-32-chars',
  PREVIOUS_ENCRYPTION_KEY: legacyKey,
};
let fallbackUpload = null;
globalThis.fetch = async (url, options) => {
  fallbackUpload = { url: String(url), options };
  return Response.json([{ src: '/file/legacy.svg' }]);
};
const fallback = await uploadNodeQualityReportImages(fallbackEnv, oneImageReport);
assert.equal(fallback.status.uploaded, 1, 'existing encrypted D1 credentials must remain a read-only migration fallback');
assert.equal(new URL(fallbackUpload.url).searchParams.get('uploadChannel'), 's3');
assert.equal(new URL(fallbackUpload.url).searchParams.has('uploadFolder'), false);
assert.equal(new URL(fallbackUpload.url).searchParams.has('channelName'), false, 'legacy browser settings must not control the fixed S3 channel');
assert.equal(fallbackUpload.options.headers.authorization, `Bearer ${legacyToken}`);
const migratedLegacyToken = fallbackEnv.DB.meta.get('nq_image_host_token');
assert.match(migratedLegacyToken, /^enc:v1:/);
assert.notEqual(migratedLegacyToken, legacyCiphertext);
delete fallbackEnv.PREVIOUS_ENCRYPTION_KEY;
const migratedFallback = await uploadNodeQualityReportImages(fallbackEnv, oneImageReport);
assert.equal(migratedFallback.status.uploaded, 1, 'lazy migration must survive removal of the previous key');
globalThis.fetch = originalFetch;

let unexpectedFetch = false;
globalThis.fetch = async () => { unexpectedFetch = true; throw new Error('must not upload'); };
const disabled = await uploadNodeQualityReportImages({ DB: memoryDb() }, oneImageReport);
assert.equal(disabled.status.enabled, false);
assert.equal(unexpectedFetch, false);
globalThis.fetch = originalFetch;

console.log('NQ image host tests passed');

function memoryDb(initial = {}) {
  const meta = new Map(Object.entries(initial));
  return {
    meta,
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

async function encryptLegacyToken(secret, material) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const additionalData = new TextEncoder().encode('NIE-SLA:nq-image-host-token:v1');
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    key,
    new TextEncoder().encode(secret),
  ));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv);
  combined.set(encrypted, iv.length);
  let binary = '';
  for (const byte of combined) binary += String.fromCharCode(byte);
  return `enc:v1:${btoa(binary)}`;
}
