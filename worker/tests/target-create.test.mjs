import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/admin/targets.js', import.meta.url), 'utf8');

assert.match(
  source,
  /const expiresAt = normalizeExpiresAt\(body\?\.expires_at, env\) \?\? null;/,
  'target creation must convert an omitted expiration date to SQL NULL before binding it to D1',
);
assert.match(
  source,
  /INSERT INTO targets[\s\S]*?\.bind\([\s\S]*?expiresAt,[\s\S]*?\)\.run\(\);/,
  'the normalized expiration date must be used by the target insert statement',
);

console.log('VPS target creation defaults passed');
