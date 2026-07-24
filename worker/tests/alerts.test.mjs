import assert from 'node:assert/strict';
import { getAlertSettings, renderNotificationTemplate, sendTestAlert, updateAlertSettings } from '../src/alerts.js';

function memoryDb() {
  const meta = new Map();
  return {
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

console.log('email alert tests passed');
