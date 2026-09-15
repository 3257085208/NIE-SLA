import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createS3ArchiveFacade, withS3Archive } from '../src/r2s3.js';

globalThis.crypto ||= webcrypto;

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();
const requests = [];
const storedBody = JSON.stringify({ ok: true, message: '网络' });

try {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method || 'GET';
    const body = typeof init.body === 'string' ? init.body : '';
    requests.push({ url: url.toString(), method, headers: init.headers, body });
    if (method === 'PUT') return new Response('', { status: 200 });
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(encoder.encode(storedBody).byteLength) } });
    if (method === 'GET' && url.searchParams.has('list-type')) {
      return new Response('<ListBucketResult><Contents><Key>state/a&amp;b.json</Key><LastModified>2026-09-15T00:00:00.000Z</LastModified><Size>12</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
    }
    if (method === 'GET') return new Response(storedBody, { status: 200 });
    return new Response('', { status: 204 });
  };

  const facade = createS3ArchiveFacade({
    R2_S3_ACCOUNT_ID: 'a'.repeat(32),
    R2_S3_BUCKET: 'test-bucket',
    R2_S3_ACCESS_KEY_ID: 'access-key',
    R2_S3_SECRET_ACCESS_KEY: 'secret-key',
    R2_S3_TIMEOUT_MS: 1_000,
  });
  const unicodeBody = JSON.stringify({ message: '网络' });
  const put = await facade.put('state/网络.json', unicodeBody, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { schema: 'test-schema', agent_id: 'vps-a' },
  });
  assert.equal(put.size, encoder.encode(unicodeBody).byteLength, 'S3 put size must be UTF-8 bytes');
  assert.match(requests[0].url, /state\/%E7%BD%91%E7%BB%9C\.json$/);
  assert.equal(requests[0].headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(requests[0].headers['x-amz-meta-schema'], 'test-schema');
  assert.match(requests[0].headers.authorization, /SignedHeaders=.*content-type/);

  const head = await facade.head('state/网络.json');
  assert.equal(head.size, encoder.encode(storedBody).byteLength);
  const object = await facade.get('state/网络.json');
  assert.deepEqual(await object.json(), { ok: true, message: '网络' });
  assert.equal(object.size, encoder.encode(storedBody).byteLength, 'S3 get size must be UTF-8 bytes');

  const listed = await facade.list({ prefix: 'state/!/', limit: 25 });
  assert.deepEqual(listed.objects, [{ key: 'state/a&b.json', size: 12, last_modified: '2026-09-15T00:00:00.000Z' }]);
  assert.equal(listed.truncated, false);
  const listRequest = requests.find((request) => request.method === 'GET' && request.url.includes('list-type'));
  assert.ok(listRequest);
  assert.match(listRequest.url, /prefix=state%2F%21%2F/);

  const nativeArchive = { ARCHIVE: {} };
  const active = withS3Archive({ ...nativeArchive, R2_S3_ACCOUNT_ID: 'a'.repeat(32), R2_S3_ACCESS_KEY_ID: 'access-key', R2_S3_SECRET_ACCESS_KEY: 'secret-key' });
  assert.notEqual(active.ARCHIVE, nativeArchive.ARCHIVE, 'complete credentials must activate S3 facade');
  const inactiveArchive = { ARCHIVE: {} };
  assert.equal(withS3Archive({ ...inactiveArchive, R2_S3_ACCOUNT_ID: 'a'.repeat(32), R2_S3_ACCESS_KEY_ID: '  ', R2_S3_SECRET_ACCESS_KEY: 'secret-key' }).ARCHIVE, inactiveArchive.ARCHIVE, 'blank credentials must not activate facade');

  globalThis.fetch = (_input, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const shortTimeout = createS3ArchiveFacade({
    R2_S3_ACCOUNT_ID: 'a'.repeat(32),
    R2_S3_BUCKET: 'test-bucket',
    R2_S3_ACCESS_KEY_ID: 'access-key',
    R2_S3_SECRET_ACCESS_KEY: 'secret-key',
    R2_S3_TIMEOUT_MS: 100,
  });
  await assert.rejects(() => shortTimeout.get('timeout.json'), /timed out after 100ms/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('r2 s3 facade tests passed');
