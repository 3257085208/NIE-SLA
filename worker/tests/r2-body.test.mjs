import assert from 'node:assert/strict';
import { encodeJsonBody, decodeJsonBody, parseJsonBytes, httpMetadataFor } from '../src/r2-body.js';
import { writeR2Json, readR2Json, readR2JsonStrict } from '../src/storage.js';

function byteLength(body) {
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return body?.byteLength || 0;
}

function gzipBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, body) { objects.set(key, body); return { size: byteLength(body) }; },
    async head(key) { const body = objects.get(key); return body == null ? null : { size: byteLength(body) }; },
    async get(key) {
      const body = objects.get(key);
      if (body == null) return null;
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
      return {
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        json: async () => parseJsonBytes(bytes),
        size: bytes.byteLength,
      };
    },
  };
}

const env = { ARCHIVE: gzipBucket() };
const big = {
  schema: 'test-v1',
  points: Array.from({ length: 200 }, (_, index) => ({ ts: 1_700_000_000 + index, cpu: index, name: `point-${index}` })),
};
await writeR2Json(env, 'big.json', big, { schema: 'test-v1' });
const stored = env.ARCHIVE.objects.get('big.json');
assert.ok(stored instanceof Uint8Array || stored instanceof ArrayBuffer, 'large archive objects must be stored as gzip bytes');
assert.deepEqual(await readR2JsonStrict(env, 'big.json'), big, 'gzip objects must round-trip through the shared reader');
assert.equal(await readR2Json(env, 'missing.json', 'fallback'), 'fallback');

const plainBytes = new TextEncoder().encode(JSON.stringify({ legacy: true }));
assert.deepEqual(await parseJsonBytes(plainBytes), { legacy: true }, 'legacy plain JSON objects must keep decoding');
assert.deepEqual(await decodeJsonBody({ json: async () => ({ compact: true }) }), { compact: true }, 'test doubles without arrayBuffer still work');

const small = await encodeJsonBody({ a: 1 });
assert.equal(small.encoding, null, 'small bodies stay plain text');
const smallDecoded = await decodeJsonBody({ arrayBuffer: async () => new TextEncoder().encode('{"a":1}').buffer });
assert.deepEqual(smallDecoded, { a: 1 });

assert.deepEqual(httpMetadataFor('gzip'), { contentType: 'application/json; charset=utf-8', contentEncoding: 'gzip' });
assert.deepEqual(httpMetadataFor(null), { contentType: 'application/json; charset=utf-8' });

console.log('R2 JSON compression tests passed');
