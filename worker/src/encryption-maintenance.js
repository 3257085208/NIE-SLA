import { migrateAgentCredentialEncryption } from './agent-credentials.js';
import { migrateAlertEncryption } from './alerts.js';
import { migrateNqImageHostEncryption } from './nq-image-host.js';
import { migrateTOTPEncryption } from './totp.js';

export function encryptionKeyStatus(env) {
  return {
    ok: true,
    primary_configured: Boolean(String(env.TOTP_ENCRYPTION_KEY || '').trim()),
    previous_configured: Boolean(String(env.PREVIOUS_ENCRYPTION_KEY || '').trim()),
    alert_dedicated_configured: Boolean(String(env.ALERT_ENCRYPTION_KEY || '').trim()),
    snapshot_dedicated_configured: Boolean(String(env.BACKUP_SNAPSHOT_KEY || '').trim()),
  };
}

export async function migrateEncryptionMaterials(env) {
  const status = encryptionKeyStatus(env);
  if (!status.primary_configured) {
    return { ...status, ok: false, error: '请先配置长期 TOTP_ENCRYPTION_KEY，再执行密钥迁移。' };
  }

  const results = {};
  const errors = [];
  for (const [name, migrate] of [
    ['totp', migrateTOTPEncryption],
    ['agent_credentials', migrateAgentCredentialEncryption],
    ['alerts', migrateAlertEncryption],
    ['legacy_nq_image_host', migrateNqImageHostEncryption],
  ]) {
    try {
      results[name] = await migrate(env);
    } catch (error) {
      errors.push({ component: name, error: safeMigrationError(error) });
    }
  }
  return {
    ...status,
    ok: errors.length === 0,
    results,
    errors,
  };
}

function safeMigrationError(error) {
  return String(error?.message || '迁移失败')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .slice(0, 240);
}
