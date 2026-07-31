import assert from 'node:assert/strict';
import { getAlertSettings, migrateAlertEncryption, renderNotificationTemplate, runAlertChecks, sendTestAlert, updateAlertSettings } from '../src/alerts.js';

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
          return { success: true };
        },
      };
    },
  };
}

function jsonRequest(body) {
  return new Request('https://status.example/api/alerts/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const env = {
  DB: memoryDb(),
  RESEND_API_KEY: 're_test_key',
  PUBLIC_SITE_NAME: 'Test Status',
};

await updateAlertSettings(jsonRequest({
  enabled: true,
  telegram_enabled: false,
  email_enabled: true,
  email_from: 'NIE-SLA <status@example.com>',
  email_to: 'owner@example.com, second@example.com',
  email_reply_to: 'reply@example.com',
  email_format: 'html',
  email_subject_template: '{{site_name}} / {{title}}',
  email_template: '<main><h1>{{title}}</h1><p>{{message}}</p></main>',
  telegram_format: 'html',
  telegram_template: '<b>{{title}}</b>\n{{message}}',
  telegram_message_thread_id: '42',
  telegram_disable_web_preview: true,
  telegram_silent: true,
}), env);

const settings = await getAlertSettings(env);
assert.equal(settings.email_enabled, true);
assert.equal(settings.email_from, 'NIE-SLA <status@example.com>');
assert.equal(settings.email_to, 'owner@example.com, second@example.com');
assert.equal(settings.resend_api_key_set, true);

const originalFetch = globalThis.fetch;
let sent = null;
globalThis.fetch = async (url, options) => {
  sent = { url: String(url), options, body: JSON.parse(options.body) };
  return Response.json({ id: 'email-id' });
};
try {
  const result = await sendTestAlert(jsonRequest({ channel: 'email', message: '<hello>' }), env);
  assert.equal(result.ok, true);
  assert.equal(sent.url, 'https://api.resend.com/emails');
  assert.equal(sent.options.headers.authorization, 'Bearer re_test_key');
  assert.deepEqual(sent.body.to, ['owner@example.com', 'second@example.com']);
  assert.equal(sent.body.reply_to, 'reply@example.com');
  assert.equal(sent.body.subject, 'Test Status / NIE-SLA 测试报警');
  assert.match(sent.body.html, /&lt;hello&gt;/);
  assert.equal(sent.body.text, undefined);
} finally {
  globalThis.fetch = originalFetch;
}

env.TELEGRAM_BOT_TOKEN = '123:test';
await updateAlertSettings(jsonRequest({ telegram_chat_id: '-100123' }), env);
sent = null;
globalThis.fetch = async (url, options) => {
  sent = { url: String(url), options, body: JSON.parse(options.body) };
  return Response.json({ ok: true });
};
try {
  const result = await sendTestAlert(jsonRequest({ channel: 'telegram', message: '<hello>' }), env);
  assert.equal(result.ok, true);
  assert.match(sent.url, /api\.telegram\.org/);
  assert.equal(sent.body.parse_mode, 'HTML');
  assert.equal(sent.body.message_thread_id, 42);
  assert.equal(sent.body.disable_notification, true);
  assert.match(sent.body.text, /&lt;hello&gt;/);
} finally {
  globalThis.fetch = originalFetch;
}

assert.equal(
  renderNotificationTemplate('{{message}}', { message: 'a_b[c]' }, 'markdownv2', 'telegram'),
  'a\\_b\\[c\\]',
);

await assert.rejects(
  updateAlertSettings(jsonRequest({ telegram_template: '{{message}} / {{message}}' }), env),
  /只能出现一次/,
);
await assert.rejects(
  updateAlertSettings(jsonRequest({ email_template: '<p>{{unknown}}</p>' }), env),
  /未知模板占位符/,
);
await assert.rejects(
  updateAlertSettings(jsonRequest({ email_template: '<p>{{title}}</p>' }), env),
  /必须包含 \{\{message\}\}/,
);

const noDedicatedKeyEnv = { DB: memoryDb(), ADMIN_PASSWORD: 'legacy-admin-password' };
await assert.rejects(
  updateAlertSettings(jsonRequest({ telegram_bot_token: '123:legacy' }), noDedicatedKeyEnv),
  /ALERT_ENCRYPTION_KEY|TOTP_ENCRYPTION_KEY/,
);

const alertRotationDb = memoryDb();
const alertOldEnv = {
  DB: alertRotationDb,
  TOTP_ENCRYPTION_KEY: 'old-alert-encryption-key-with-at-least-32-chars',
};
await updateAlertSettings(jsonRequest({
  telegram_bot_token: '123:rotation-test',
  resend_api_key: 're_rotation_test',
}), alertOldEnv);
const alertRotation = await migrateAlertEncryption({
  DB: alertRotationDb,
  TOTP_ENCRYPTION_KEY: 'new-alert-encryption-key-with-at-least-32-chars',
  PREVIOUS_ENCRYPTION_KEY: alertOldEnv.TOTP_ENCRYPTION_KEY,
});
assert.deepEqual(alertRotation, { total: 2, migrated: 2 });
const rotatedAlertSettings = await getAlertSettings({
  DB: alertRotationDb,
  TOTP_ENCRYPTION_KEY: 'new-alert-encryption-key-with-at-least-32-chars',
});
assert.equal(rotatedAlertSettings.telegram_bot_token_set, true);
assert.equal(rotatedAlertSettings.resend_api_key_set, true);

const failedReadEnv = {
  TELEGRAM_BOT_TOKEN: '123:test',
  TELEGRAM_CHAT_ID: '-100123',
  DB: {
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (/SELECT value FROM app_meta/i.test(sql) && this.values[0] === 'alert_settings') {
            return { value: JSON.stringify({ enabled: true }) };
          }
          return null;
        },
        async run() { return { success: true }; },
        async all() { throw new Error('simulated D1 read failure'); },
      };
    },
  },
};
await assert.rejects(() => runAlertChecks(failedReadEnv), /simulated D1 read failure/);

console.log('email alert tests passed');
