import assert from 'node:assert/strict';
import { handleRequest } from '../src/routes.js';

function memoryDb() {
  const meta = new Map();
  const rateLimits = [];
  return {
    rateLimits,
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (/SELECT value FROM app_meta/i.test(sql)) {
            const value = meta.get(String(this.values[0]));
            return value === undefined ? null : { value };
          }
          if (/SELECT COUNT\(\*\) AS count, MIN\(ts\) AS oldest_ts/i.test(sql)) {
            const [key, cutoff] = this.values;
            const rows = rateLimits.filter(row => row.key === key && row.ts >= cutoff);
            return { count: rows.length, oldest_ts: rows.length ? Math.min(...rows.map(row => row.ts)) : null };
          }
          return null;
        },
        async run() {
          if (/INSERT INTO app_meta/i.test(sql)) meta.set(String(this.values[0]), String(this.values[1]));
          if (/DELETE FROM rate_limits WHERE key = \? AND ts < \?/i.test(sql)) {
            const [key, cutoff] = this.values;
            for (let index = rateLimits.length - 1; index >= 0; index--) {
              if (rateLimits[index].key === key && rateLimits[index].ts < cutoff) rateLimits.splice(index, 1);
            }
          } else if (/DELETE FROM rate_limits WHERE key = \?/i.test(sql)) {
            const [key] = this.values;
            for (let index = rateLimits.length - 1; index >= 0; index--) {
              if (rateLimits[index].key === key) rateLimits.splice(index, 1);
            }
          }
          if (/INSERT INTO rate_limits/i.test(sql)) {
            const [key, ts, countKey, cutoff, limit] = this.values;
            const count = rateLimits.filter(row => row.key === countKey && row.ts >= cutoff).length;
            if (count >= limit) return { meta: { changes: 0 } };
            rateLimits.push({ key, ts });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
    },
  };
}

function loginRequest(ip) {
  return new Request('https://status.example/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ username: 'owner', password: 'wrong' }),
  });
}

{
  const env = { DB: memoryDb(), ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'correct horse battery staple' };
  await assert.rejects(handleRequest(loginRequest('192.0.2.10'), env), error => error?.status === 401);
  const limited = await handleRequest(loginRequest('192.0.2.10'), env);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '10');
}

{
  const db = memoryDb();
  const env = { DB: db, ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'correct horse battery staple' };
  for (let attempt = 0; attempt < 5; attempt++) {
    await assert.rejects(handleRequest(loginRequest('192.0.2.11'), env), error => error?.status === 401);
    for (const row of db.rateLimits) if (row.key === 'login-ip-short:192.0.2.11') row.ts -= 11;
  }
  const limited = await handleRequest(loginRequest('192.0.2.11'), env);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '300');
}

console.log('login route tests passed');
