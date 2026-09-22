import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { runAlertChecks, updateAlertSettings } from '../src/alerts.js';
import { ensureV6Schema } from '../src/admin/schema.js';

globalThis.crypto ||= webcrypto;

// Per-channel delivery state + exponential backoff. A broken channel must not
// storm retries every run, must not suppress healthy channels, and must not
// make healthy channels receive duplicates of the queued alert.
const database = new DatabaseSync(':memory:');
const env = {
  TOTP_ENCRYPTION_KEY: 'alerts-delivery-test-key-32-bytes-min',
  RESEND_API_KEY: 're_delivery_test',
  DB: d1(database),
};
await ensureV6Schema(env);

const now = nowSec();
insertDownTarget('vps-backoff', 'Backoff VPS', now);

await updateAlertSettings(jsonRequest({
  enabled: true,
  telegram_enabled: false,
  email_enabled: true,
  email_from: 'NIE-SLA <status@example.com>',
  email_to: 'owner@example.com',
  webhook_enabled: true,
  webhook_url: 'https://hooks.example.com/notify',
  webhook_method: 'POST',
}), env);

const originalFetch = globalThis.fetch;

// Scenario A: email delivers, webhook fails. The alert is committed once, the
// webhook payload is queued with backoff, healthy email gets no duplicate, and
// retries grow exponentially until the channel recovers.
{
  let emailCalls = 0;
  let webhookCalls = 0;
  const emailBodies = [];
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.startsWith('https://api.resend.com/')) {
      emailCalls += 1;
      emailBodies.push(JSON.parse(options.body));
      return Response.json({ id: 'email-id' });
    }
    if (target.startsWith('https://hooks.example.com/')) {
      webhookCalls += 1;
      return new Response('boom', { status: 500 });
    }
    throw new Error(`unexpected fetch: ${target}`);
  };
  try {
    const first = await runAlertChecks(env, { force: true });
    assert.equal(first.sent, 1, 'the healthy email channel must advance the alert state');
    assert.equal(first.retried, 0);
    assert.equal(first.channel_status.email.ok, 1);
    assert.equal(first.channel_status.webhook.failed, 1);
    assert.equal(first.errors.some((entry) => entry.channel === 'email'), false, 'the healthy channel must not be reported as failed');
    assert.ok(first.errors.some((entry) => entry.channel === 'webhook' && /Webhook HTTP 500/.test(entry.error)));
    assert.match(emailBodies[0].text, /VPS 探测异常：Backoff VPS \(vps-backoff\)/, 'alert content must stay unchanged');
    assert.equal(emailCalls, 1);
    assert.equal(webhookCalls, 1);

    const pendingAfterFirst = JSON.parse(readMeta('alert_pending_deliveries'));
    assert.equal(pendingAfterFirst.length, 1, 'the failed webhook delivery must be queued');
    assert.equal(pendingAfterFirst[0].channel, 'webhook');
    assert.ok(pendingAfterFirst[0].next_at > nowSec(), 'queued retries must wait for the backoff window');
    const backoffAfterFirst = JSON.parse(readMeta('alert_channel_backoff'));
    assert.equal(backoffAfterFirst.webhook.failures, 1);
    assert.ok(backoffAfterFirst.webhook.next_at - nowSec() > 0);

    // The next scheduled run must not re-send to either channel.
    const second = await runAlertChecks(env, { force: true });
    assert.equal(emailCalls, 1, 'a committed alert must not be re-sent to the healthy channel');
    assert.equal(webhookCalls, 1, 'a backed-off channel must not be retried on the next run');
    assert.equal(second.sent, 0);
    assert.equal(second.retried, 0);
    assert.equal(second.retried_deliveries, 0);

    // After the backoff window the queued delivery is retried exactly once and
    // the failure count/next delay grow exponentially.
    expireBackoff();
    const third = await runAlertChecks(env, { force: true });
    assert.equal(webhookCalls, 2);
    assert.equal(emailCalls, 1, 'retrying one channel must not touch the others');
    assert.ok(third.errors.some((entry) => entry.rule_key === 'delivery_retry' && entry.channel === 'webhook'));
    const backoffAfterThird = JSON.parse(readMeta('alert_channel_backoff'));
    assert.equal(backoffAfterThird.webhook.failures, 2);
    assert.ok(backoffAfterThird.webhook.next_at - nowSec() >= 600, 'the retry delay must grow exponentially');
    assert.equal(JSON.parse(readMeta('alert_pending_deliveries'))[0].attempts, 1);

    expireBackoff();
    await runAlertChecks(env, { force: true });
    assert.equal(webhookCalls, 3);
    const backoffAfterFourth = JSON.parse(readMeta('alert_channel_backoff'));
    assert.equal(backoffAfterFourth.webhook.failures, 3);
    assert.ok(backoffAfterFourth.webhook.next_at - nowSec() >= 1200, 'the delay must keep doubling per failure');

    // Recovery: the queued webhook delivery finally succeeds and the state
    // clears, without re-sending the already-delivered alert to email.
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.startsWith('https://api.resend.com/')) { emailCalls += 1; return Response.json({ id: 'email-id' }); }
      if (target.startsWith('https://hooks.example.com/')) { webhookCalls += 1; return new Response('ok', { status: 200 }); }
      throw new Error(`unexpected fetch: ${target}`);
    };
    expireBackoff();
    const recovered = await runAlertChecks(env, { force: true });
    assert.equal(recovered.retried_deliveries, 1, 'the queued delivery must be retried after the channel recovers');
    assert.equal(JSON.parse(readMeta('alert_pending_deliveries')).length, 0, 'delivered retries must leave the queue');
    assert.equal(JSON.parse(readMeta('alert_channel_backoff')).webhook, undefined, 'a successful delivery must clear the channel backoff');
    assert.equal(emailCalls, 1, 'the healthy channel must not receive the alert twice');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Scenario B: every channel is down. The run must commit the alert state and
// queue both channels once, and the next run must not retry them immediately.
{
  insertDownTarget('vps-all-down', 'All Down VPS', nowSec());
  let failedCalls = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.startsWith('https://api.resend.com/') || target.startsWith('https://hooks.example.com/')) {
      failedCalls += 1;
      return new Response('down', { status: 500 });
    }
    throw new Error(`unexpected fetch: ${target}`);
  };
  try {
    const first = await runAlertChecks(env, { force: true });
    assert.equal(first.sent, 0);
    assert.equal(first.retried, 1, 'the alert must still advance state when the queue owns delivery');
    assert.equal(first.channel_status.email.failed, 1);
    assert.equal(first.channel_status.webhook.failed, 1);
    assert.equal(failedCalls, 2);
    const status = database.prepare(`SELECT status FROM alert_state WHERE target_id = 'vps-all-down' AND rule_key = 'probe_down'`).get();
    assert.equal(status?.status, 'active');
    assert.equal(JSON.parse(readMeta('alert_pending_deliveries')).length, 2, 'each down channel must be queued separately');

    const second = await runAlertChecks(env, { force: true });
    assert.equal(failedCalls, 2, 'the next run must not retry backed-off channels');
    assert.equal(JSON.parse(readMeta('alert_pending_deliveries')).length, 2, 'queued entries must not be duplicated by regenerated alerts');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('alert delivery backoff tests passed');

function insertDownTarget(id, name, checkedAt) {
  database.prepare(`INSERT INTO targets
    (id, name, group_name, type, target_host, target_port, timeout_ms, interval_sec, probe_region, enabled, created_at, updated_at)
    VALUES (?, ?, 'VPS', 'tcp', '8.8.8.8', 443, 5000, 300, 'auto', 1, ?, ?)`)
    .run(id, name, checkedAt, checkedAt);
  database.prepare(`INSERT INTO latest_status
    (target_id, checked_at, ok, current_outage_started_at, error)
    VALUES (?, ?, 0, ?, 'timeout')`)
    .run(id, checkedAt, checkedAt - 3600);
}

function expireBackoff() {
  const queue = JSON.parse(readMeta('alert_pending_deliveries') || '[]');
  for (const entry of queue) entry.next_at = nowSec() - 1;
  writeMeta('alert_pending_deliveries', JSON.stringify(queue));
  const backoff = JSON.parse(readMeta('alert_channel_backoff') || '{}');
  for (const state of Object.values(backoff)) state.next_at = nowSec() - 1;
  writeMeta('alert_channel_backoff', JSON.stringify(backoff));
}

function jsonRequest(body) {
  return new Request('https://status.example/api/alerts/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function readMeta(key) {
  const row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function writeMeta(key, value) {
  database.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(key, value, nowSec());
}

function d1(db) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async run() { return db.prepare(sql).run(...values); },
        async all() { return { results: db.prepare(sql).all(...values) }; },
        async first() { return db.prepare(sql).get(...values) || null; },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}
