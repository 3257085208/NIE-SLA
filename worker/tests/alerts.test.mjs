import assert from 'node:assert/strict';
import { getAlertSettings, sendTestAlert, updateAlertSettings } from '../src/alerts.js';

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
  email_from: 'NStatus <status@example.com>',
  email_to: 'owner@example.com, second@example.com',
  email_reply_to: 'reply@example.com',
}), env);

const settings = await getAlertSettings(env);
assert.equal(settings.email_enabled, true);
assert.equal(settings.email_from, 'NStatus <status@example.com>');
assert.equal(settings.email_to, 'owner@example.com, second@example.com');
assert.equal(settings.resend_api_key_set, true);

const originalFetch = globalThis.fetch;
let sent = null;
globalThis.fetch = async (url, options) => {
  sent = { url: String(url), options, body: JSON.parse(options.body) };
  return Response.json({ id: 'email-id' });
};
try {
  const result = await sendTestAlert(jsonRequest({ channel: 'email', message: 'hello' }), env);
  assert.equal(result.ok, true);
  assert.equal(sent.url, 'https://api.resend.com/emails');
  assert.equal(sent.options.headers.authorization, 'Bearer re_test_key');
  assert.deepEqual(sent.body.to, ['owner@example.com', 'second@example.com']);
  assert.equal(sent.body.reply_to, 'reply@example.com');
  assert.match(sent.body.text, /hello/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('email alert tests passed');
