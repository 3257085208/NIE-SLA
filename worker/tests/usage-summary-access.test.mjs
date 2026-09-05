import assert from 'node:assert/strict';
import {
  MAX_USAGE_SUMMARY_ACCESS_TOKENS,
  createUsageSummaryAccess,
  getUsageSummaryAccessStatus,
  revokeUsageSummaryAccess,
  usageSummaryBearerToken,
  validateUsageSummaryAccess,
} from '../src/admin/usage-summary-access.js';
import { updateAdminAccount } from '../src/admin-auth.js';

function memoryDb() {
  const meta = new Map();
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
          if (/DELETE FROM app_meta/i.test(sql)) meta.delete(String(this.values[0]));
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  };
}

const db = memoryDb();
const env = { DB: db };
const issued = [];
for (let index = 0; index < MAX_USAGE_SUMMARY_ACCESS_TOKENS + 1; index += 1) {
  issued.push(await createUsageSummaryAccess(env));
}

for (const item of issued) {
  assert.match(item.access_token, /^nsu_[a-f0-9]{64}$/);
}
const validResults = await Promise.all(issued.map((item) => validateUsageSummaryAccess(env, item.access_token)));
assert.equal(validResults.filter((result) => result.valid).length, MAX_USAGE_SUMMARY_ACCESS_TOKENS);
assert.equal(validResults[0].valid, false, 'the oldest credential must be evicted first');
assert.equal(validResults.at(-1).valid, true, 'the newest credential must remain usable');
const status = await getUsageSummaryAccessStatus(env);
assert.equal(status.active_count, MAX_USAGE_SUMMARY_ACCESS_TOKENS);
assert.equal('access_token' in status, false);
assert.ok(Number(status.latest_expires_at) > Math.floor(Date.now() / 1000));

const stored = String(db.meta.get('usage_summary_access_v1') || '');
assert.equal(stored.includes(issued.at(-1).access_token), false, 'D1 must contain hashes, never a raw terminal token');
assert.doesNotMatch(stored, /nsu_/);

const sample = issued.at(-1).access_token;
assert.equal(usageSummaryBearerToken(new Request('https://status.example', { headers: { authorization: `Bearer ${sample}` } })), sample);
assert.equal(usageSummaryBearerToken(new Request('https://status.example', { headers: { authorization: `Bearer ${sample} extra` } })), '');
assert.equal(usageSummaryBearerToken(new Request('https://status.example', { headers: { authorization: 'Basic ignored' } })), '');
assert.equal((await validateUsageSummaryAccess(env, 'nsu_invalid')).valid, false);

const revoked = await revokeUsageSummaryAccess(env);
assert.equal(revoked.revoked_count, MAX_USAGE_SUMMARY_ACCESS_TOKENS);
assert.equal((await validateUsageSummaryAccess(env, sample)).valid, false);
assert.equal((await getUsageSummaryAccessStatus(env)).active_count, 0);

const accountEnv = { DB: memoryDb(), ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'Current!Pass1' };
await createUsageSummaryAccess(accountEnv);
await updateAdminAccount(new Request('https://status.example/api/auth/account', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    current_password: 'Current!Pass1',
    username: 'owner',
    new_password: 'Next!Pass2',
    confirm_password: 'Next!Pass2',
  }),
}), accountEnv);
assert.equal((await getUsageSummaryAccessStatus(accountEnv)).active_count, 0, 'changing the administrator password must revoke usage-only credentials');

console.log('usage summary read-only access tests passed');
