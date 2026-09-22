import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configuredAlertChannels, getAlertSettings, renderWebhookTemplate, runAlertChecks, sendTestAlert, updateAlertSettings } from '../src/alerts.js';

const originalFetch = globalThis.fetch;
const ENCRYPTION_KEY = 'channel-test-encryption-key-32-chars-min';

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
  return new Request('https://status.example/api/alerts/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function baseEnv() {
  return {
    DB: memoryDb(),
    PUBLIC_SITE_NAME: 'Test Status',
    PUBLIC_SITE_ORIGIN: 'https://status.example',
    TOTP_ENCRYPTION_KEY: ENCRYPTION_KEY,
  };
}

const CHANNEL_SETTINGS = {
  webhook_enabled: true,
  webhook_url: 'https://hooks.example.com/notify',
  webhook_method: 'GET',
  webhook_headers: '{"Authorization":"Bearer secret-token","X-Test":"1"}',
  webhook_template: 'event={{event}} target={{target}} status={{status}}\n{{message}}\n{{time}} {{url}}',
  bark_enabled: true,
  bark_server: 'https://api.day.app',
  bark_device_key: 'bark-device-key-123',
  gotify_enabled: true,
  gotify_url: 'https://gotify.example.com/',
  gotify_token: 'gotify-token-abc',
  feishu_enabled: true,
  feishu_webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/feishu-key',
  dingtalk_enabled: true,
  dingtalk_webhook: 'https://oapi.dingtalk.com/robot/send?access_token=dd-key',
  wecom_enabled: true,
  wecom_webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=wecom-key',
  serverchan_enabled: true,
  serverchan_sendkey: 'SCT-key-123',
};

test('alert settings round-trip the new channels and encrypt their secrets', async () => {
  const env = baseEnv();
  const saved = await updateAlertSettings(jsonRequest({ ...CHANNEL_SETTINGS }), env);
  assert.equal(saved.ok, true);

  const settings = await getAlertSettings(env);
  assert.equal(settings.webhook_enabled, true);
  assert.equal(settings.webhook_method, 'GET');
  assert.equal(settings.webhook_template, CHANNEL_SETTINGS.webhook_template);
  assert.equal(settings.webhook_headers, CHANNEL_SETTINGS.webhook_headers);
  assert.equal(settings.bark_server, 'https://api.day.app');
  assert.equal(settings.gotify_url, 'https://gotify.example.com/');
  for (const flag of ['bark_device_key_set', 'gotify_token_set', 'feishu_webhook_set', 'dingtalk_webhook_set', 'wecom_webhook_set', 'serverchan_sendkey_set']) {
    assert.equal(settings[flag], true, flag);
  }
  assert.equal(JSON.stringify(settings).includes('bark-device-key-123'), false, 'secret values must not leak through the settings API');

  const withSecret = await getAlertSettings(env, { includeSecret: true });
  assert.equal(withSecret.bark_device_key, 'bark-device-key-123');
  assert.equal(withSecret.gotify_token, 'gotify-token-abc');
  assert.equal(withSecret.feishu_webhook, CHANNEL_SETTINGS.feishu_webhook);
  assert.equal(withSecret.serverchan_sendkey, 'SCT-key-123');
  assert.deepEqual(configuredAlertChannels(env, withSecret), ['webhook', 'bark', 'gotify', 'feishu', 'dingtalk', 'wecom', 'serverchan']);

  const raw = String(env.DB.meta.get('alert_channel_secrets') || '');
  assert.ok(raw.startsWith('enc:v1:'), 'channel secrets must be encrypted at rest');
  assert.equal(raw.includes('bark-device-key-123'), false);
});

test('missing channel fields default safely', async () => {
  const env = baseEnv();
  await updateAlertSettings(jsonRequest({ enabled: true }), env);
  const settings = await getAlertSettings(env, { includeSecret: true });
  assert.equal(settings.webhook_enabled, false);
  assert.equal(settings.webhook_method, 'POST');
  assert.equal(settings.webhook_url, '');
  assert.equal(settings.bark_server, 'https://api.day.app');
  assert.equal(settings.bark_enabled, false);
  assert.equal(settings.gotify_enabled, false);
  assert.equal(settings.feishu_enabled, false);
  assert.equal(settings.dingtalk_enabled, false);
  assert.equal(settings.wecom_enabled, false);
  assert.equal(settings.serverchan_enabled, false);
  assert.match(settings.webhook_template, /\{\{message\}\}/);
  assert.deepEqual(configuredAlertChannels(env, settings), []);
});

test('webhook body template renders the documented placeholders', () => {
  const context = { event: 'E', target: 'T', message: 'M', status: 'test', time: 'TIME', url: 'https://status.example' };
  assert.equal(
    renderWebhookTemplate('{"event":"{{event}}","target":"{{target}}","message":"{{message}}","status":"{{status}}","time":"{{time}}","url":"{{url}}"}', context),
    '{"event":"E","target":"T","message":"M","status":"test","time":"TIME","url":"https://status.example"}',
  );
  assert.equal(renderWebhookTemplate('{{ message }} / {{unknown}}', { message: 'x' }), 'x / {{unknown}}');
  assert.equal(renderWebhookTemplate('{{missing}}', {}), '{{missing}}');
});

test('webhook sender honors method, headers and rendered body', async () => {
  const env = baseEnv();
  await updateAlertSettings(jsonRequest({
    webhook_enabled: true,
    webhook_url: 'https://hooks.example.com/notify',
    webhook_method: 'POST',
    webhook_headers: '{"X-Token":"t-1"}',
    webhook_template: 'event={{event}}\ntarget={{target}}',
  }), env);
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response('ok', { status: 200 });
  };
  try {
    const result = await sendTestAlert(jsonRequest({ channel: 'webhook' }), env);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://hooks.example.com/notify');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['X-Token'], 't-1');
    assert.equal(calls[0].options.headers['content-type'], 'application/json');
    assert.match(calls[0].options.body, /event=NIE-SLA 测试报警/);
    assert.match(calls[0].options.body, /target=测试/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  await updateAlertSettings(jsonRequest({ webhook_method: 'GET' }), env);
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response('ok', { status: 200 });
  };
  try {
    const result = await sendTestAlert(jsonRequest({ channel: 'webhook' }), env);
    assert.equal(result.ok, true);
    assert.equal(calls[1].options.method, 'GET');
    assert.equal(calls[1].options.body, undefined);
    assert.match(calls[1].url, /^https:\/\/hooks\.example\.com\/notify\?text=/);
    assert.match(decodeURIComponent(calls[1].url), /target=测试/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('per-channel failures map to channel-labelled errors', async () => {
  const env = baseEnv();
  await updateAlertSettings(jsonRequest({ ...CHANNEL_SETTINGS }), env);
  const cases = [
    ['webhook', /Webhook HTTP 500/],
    ['bark', /Bark HTTP 500/],
    ['gotify', /Gotify HTTP 500/],
    ['feishu', /飞书 HTTP 500/],
    ['dingtalk', /钉钉 HTTP 500/],
    ['wecom', /企业微信 HTTP 500/],
    ['serverchan', /ServerChan HTTP 500/],
  ];
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  try {
    for (const [channel, pattern] of cases) {
      const result = await sendTestAlert(jsonRequest({ channel }), env);
      assert.equal(result.ok, false, channel);
      assert.match(result.error, pattern, channel);
      assert.equal(result.channel, channel);
    }
    const unknown = await sendTestAlert(jsonRequest({ channel: 'nope' }), env);
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /未知通知渠道/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  try {
    const network = await sendTestAlert(jsonRequest({ channel: 'bark' }), env);
    assert.equal(network.ok, false);
    assert.match(network.error, /Bark 请求失败：connect ECONNREFUSED/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  try {
    const timeout = await sendTestAlert(jsonRequest({ channel: 'serverchan' }), env);
    assert.equal(timeout.ok, false);
    assert.match(timeout.error, /请求超时（8 秒）/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('disabled channels are skipped', async () => {
  const env = baseEnv();
  await updateAlertSettings(jsonRequest({
    enabled: true,
    telegram_enabled: false,
    email_enabled: false,
    webhook_enabled: false,
    webhook_url: 'https://hooks.example.com/notify',
    bark_enabled: true,
    bark_device_key: 'bark-device-key-123',
  }), env);
  const withSecret = await getAlertSettings(env, { includeSecret: true });
  assert.deepEqual(configuredAlertChannels(env, withSecret), ['bark'], 'a disabled webhook must not send even with a valid URL');

  await updateAlertSettings(jsonRequest({ bark_enabled: false }), env);
  const allDisabled = await getAlertSettings(env, { includeSecret: true });
  assert.deepEqual(configuredAlertChannels(env, allDisabled), []);

  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; return new Response('ok', { status: 200 }); };
  try {
    const run = await runAlertChecks(env);
    assert.equal(run.skipped, true);
    assert.equal(run.reason, 'channels_not_configured');
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('webhook template and headers are validated', async () => {
  const env = baseEnv();
  await assert.rejects(updateAlertSettings(jsonRequest({ webhook_template: '{{unknown}}' }), env), /未知 Webhook 占位符/);
  await assert.rejects(updateAlertSettings(jsonRequest({ webhook_headers: 'not json' }), env), /Webhook Headers/);
  await assert.rejects(updateAlertSettings(jsonRequest({ webhook_headers: '["array"]' }), env), /Webhook Headers/);
});

console.log('alert channel tests passed');
