import assert from 'node:assert/strict';
import { writeR2Json } from '../src/storage.js';

function memoryArchive({ readable = true, exposeHead = true } = {}) {
  const objects = new Map();
  return {
    objects,
    async put(key, body) { objects.set(key, String(body)); },
    ...(exposeHead ? { async head(key) {
      const body = objects.get(key);
      return body == null ? null : { size: new TextEncoder().encode(body).byteLength };
    } } : {}),
    async get(key) {
      if (!readable) return null;
      const body = objects.get(key);
      return body == null ? null : { async json() { return JSON.parse(body); } };
    },
  };
}

const healthy = memoryArchive();
await writeR2Json({ ARCHIVE: healthy }, 'healthy.json', { schema: 'test', value: '网络' });
assert.equal(healthy.objects.has('healthy.json'), true);

const noReadback = memoryArchive({ readable: false });
await assert.rejects(
  () => writeR2Json({ ARCHIVE: noReadback }, 'unreadable.json', { schema: 'test' }),
  /R2 readback missing/,
  'a HEAD-visible but GET-invisible object must fail closed',
);

const noHead = memoryArchive({ exposeHead: false });
await writeR2Json({ ARCHIVE: noHead }, 'no-head.json', { schema: 'test' });

const invalid = memoryArchive();
await invalid.put('invalid.json', '{not-json');
await assert.rejects(
  () => import('../src/storage.js').then(({ verifyR2Json }) => verifyR2Json({ ARCHIVE: invalid }, 'invalid.json')),
  /R2 readback failed/,
);

console.log('r2 write verification tests passed');
