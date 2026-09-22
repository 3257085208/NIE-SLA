import assert from 'node:assert/strict';
import { writeR2Json } from '../src/storage.js';

function memoryArchive({ readable = true, exposeHead = true } = {}) {
  const objects = new Map();
  const calls = { put: 0, head: 0, get: 0 };
  return {
    objects,
    calls,
    async put(key, body) {
      calls.put += 1;
      objects.set(key, String(body));
      return { size: new TextEncoder().encode(body).byteLength };
    },
    ...(exposeHead ? { async head(key) {
      calls.head += 1;
      const body = objects.get(key);
      return body == null ? null : { size: new TextEncoder().encode(body).byteLength };
    } } : {}),
    async get(key) {
      calls.get += 1;
      if (!readable) return null;
      const body = objects.get(key);
      return body == null ? null : { async json() { return JSON.parse(body); } };
    },
  };
}

const healthy = memoryArchive();
await writeR2Json({ ARCHIVE: healthy }, 'healthy.json', { schema: 'test', value: '网络' });
assert.equal(healthy.objects.has('healthy.json'), true);
assert.equal(healthy.calls.head, 0, 'the PUT result size must replace the per-write HEAD');
assert.equal(healthy.calls.get, 0, 'writes must not read back on every PUT');

const sampled = memoryArchive({ readable: false });
await assert.rejects(
  () => writeR2Json({ ARCHIVE: sampled, R2_WRITE_READBACK_EVERY: 1 }, 'unreadable.json', { schema: 'test' }),
  /R2 readback missing/,
  'a sampled readback of a HEAD-visible but GET-invisible object must fail closed',
);

const noHead = memoryArchive({ exposeHead: false });
await writeR2Json({ ARCHIVE: noHead }, 'no-head.json', { schema: 'test' });

const mismatched = memoryArchive();
mismatched.put = async (key, body) => { mismatched.objects.set(key, String(body)); return { size: 999_999 }; };
await assert.rejects(
  () => writeR2Json({ ARCHIVE: mismatched }, 'mismatch.json', { schema: 'test' }),
  /R2 write size mismatch/,
  'a PUT result size mismatch must fail the write',
);

const invalid = memoryArchive();
await invalid.put('invalid.json', '{not-json');
await assert.rejects(
  () => import('../src/storage.js').then(({ verifyR2Json }) => verifyR2Json({ ARCHIVE: invalid }, 'invalid.json')),
  /R2 readback failed/,
);

console.log('r2 write verification tests passed');
