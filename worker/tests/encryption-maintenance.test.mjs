import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { encryptionKeyStatus, migrateEncryptionMaterials } from '../src/encryption-maintenance.js';

assert.deepEqual(encryptionKeyStatus({}), {
  ok: true,
  primary_configured: false,
  previous_configured: false,
  alert_dedicated_configured: false,
  snapshot_dedicated_configured: false,
});
assert.deepEqual(encryptionKeyStatus({
  TOTP_ENCRYPTION_KEY: 'primary-secret-value',
  PREVIOUS_ENCRYPTION_KEY: 'previous-secret-value',
  ALERT_ENCRYPTION_KEY: 'alert-secret-value',
  BACKUP_SNAPSHOT_KEY: 'snapshot-secret-value',
}), {
  ok: true,
  primary_configured: true,
  previous_configured: true,
  alert_dedicated_configured: true,
  snapshot_dedicated_configured: true,
});

const missing = await migrateEncryptionMaterials({ ADMIN_PASSWORD: 'must-not-become-primary' });
assert.equal(missing.ok, false);
assert.match(missing.error, /TOTP_ENCRYPTION_KEY/);
assert.equal(JSON.stringify(missing).includes('must-not-become-primary'), false);

const routes = await readFile(new URL('../src/routes.js', import.meta.url), 'utf8');
assert.match(routes, /path === '\/api\/security\/encryption'[^\n]+withAdmin/);
assert.match(routes, /path === '\/api\/security\/encryption\/migrate'[^\n]+withAdmin/);
console.log('encryption key rotation tests passed');
