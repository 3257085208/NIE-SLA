import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAlertChecks } from '../src/alerts.js';

// Regression coverage for the "19 VPS offline" false-alarm storm: the offline
// rule used to read agent_metrics_state.updated_at (a D1 mirror throttled to
// >=900s since v1.1.93) merged with the buffered latest state (persisted in
// 300s steps and never touched by the HTTP fallback), so an online Agent that
// reported every 300s/60s could look 10-30 minutes stale. The per-Agent
// heartbeat recorded on every accepted report is the authoritative clock.

const originalFetch = globalThis.fetch;
const now = Math.floor(Date.now() / 1000);
const iso = (secondsAgo) => new Date((now - secondsAgo) * 1000).toISOString();

function alertSettings(extra = {}) {
  return JSON.stringify({
    enabled: true,
    telegram_enabled: true,
    telegram_chat_id: '-100123',
    telegram_format: 'plain',
    offline_minutes: 10,
    repeat_minutes: 360,
    notify_online: true,
    ...extra,
  });
}

function memoryDb({ targets = [], metrics = [], traffic = [], latest = [], alertState = [], meta = {} } = {}) {
  const appMeta = new Map(Object.entries(meta));
  const stateKey = (targetId, ruleKey) => `${targetId}\u0000${ruleKey}`;
  const rows = new Map(alertState.map((row) => [stateKey(row.target_id, row.rule_key), { ...row }]));
  return {
    appMeta,
    rows,
    prepare(sql) {
      const statement = {
        values: [],
        bind(...values) { statement.values = values; return statement; },
        async first() {
          if (/FROM app_meta/i.test(sql)) {
            const key = String(statement.values[0]);
            return appMeta.has(key) ? { value: appMeta.get(key), updated_at: now } : null;
          }
          if (/FROM alert_state/i.test(sql)) {
            return rows.get(stateKey(statement.values[0], statement.values[1])) || null;
          }
          return null;
        },
        async all() {
          if (/FROM targets/i.test(sql)) return { results: targets };
          if (/FROM agent_metrics_state/i.test(sql)) return { results: metrics };
          if (/FROM agent_traffic_monthly/i.test(sql)) return { results: traffic };
          if (/FROM latest_status/i.test(sql)) return { results: latest };
          if (/FROM alert_state/i.test(sql)) return { results: [...rows.values()] };
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO app_meta/i.test(sql)) {
            appMeta.set(String(statement.values[0]), String(statement.values[1]));
            return { meta: { changes: 1 } };
          }
          if (/INSERT INTO alert_state/i.test(sql)) {
            const [targetId, ruleKey] = statement.values;
            const key = stateKey(targetId, ruleKey);
            const existing = rows.get(key) || {};
            if (/last_value/i.test(sql)) {
              rows.set(key, {
                ...existing,
                target_id: targetId,
                rule_key: ruleKey,
                status: 'active',
                last_value: statement.values[2] ?? null,
                opened_at: statement.values[3] ?? null,
                resolved_at: null,
                last_sent_at: statement.values[4] ?? null,
                updated_at: statement.values[5] ?? null,
              });
            } else {
              rows.set(key, {
                ...existing,
                target_id: targetId,
                rule_key: ruleKey,
                status: 'ok',
                resolved_at: statement.values[2] ?? null,
                updated_at: statement.values[3] ?? null,
              });
            }
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
    async batch(statements) { return Promise.all((statements || []).map((statement) => statement.run())); },
  };
}

function baseEnv(db, extra = {}) {
  return {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123:test',
    TELEGRAM_CHAT_ID: '-100123',
    PUBLIC_SITE_NAME: 'Test Status',
    ...extra,
  };
}

function fleetBinding({ states = {}, lastSeen = {} } = {}) {
  return {
    idFromName(name) { return { name }; },
    get() {
      return {
        async fetch() {
          return Response.json({ ok: true, states, last_seen: lastSeen });
        },
      };
    },
  };
}

function captureTelegram() {
  const sent = [];
  globalThis.fetch = async (url, options) => {
    sent.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json({ ok: true });
  };
  return sent;
}

test('a 900s-throttled D1 mirror plus a fresh heartbeat does not report offline', async (t) => {
  const db = memoryDb({
    targets: [{ id: 'vps-a', name: 'Alpha', type: 'tcp', enabled: 1 }],
    metrics: [{ agent_id: 'vps-a', updated_at: iso(1500), cpu_percent: 1 }],
    meta: { alert_settings: alertSettings() },
  });
  const env = baseEnv(db, {
    TELEMETRY_BUFFER: fleetBinding({
      states: { 'vps-a': { agent_id: 'vps-a', updated_at: iso(1320) } },
      lastSeen: { 'vps-a': now - 40 },
    }),
  });
  const sent = captureTelegram();
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await runAlertChecks(env);
  assert.equal(result.queued, 0, 'fresh heartbeat must suppress the offline alert');
  assert.equal(sent.length, 0, 'no Telegram message may be sent');
  assert.equal(db.rows.get('vps-a\u0000agent_offline'), undefined, 'no alert state row may be opened');
});

test('a heartbeat older than the 600s threshold reports offline with the original wording', async (t) => {
  const db = memoryDb({
    targets: [{ id: 'vps-a', name: 'Alpha', type: 'tcp', enabled: 1 }],
    metrics: [{ agent_id: 'vps-a', updated_at: iso(1800), cpu_percent: 1 }],
    meta: { alert_settings: alertSettings() },
  });
  const env = baseEnv(db, {
    TELEMETRY_BUFFER: fleetBinding({
      states: { 'vps-a': { agent_id: 'vps-a', updated_at: iso(1500) } },
      lastSeen: { 'vps-a': now - 660 },
    }),
  });
  const sent = captureTelegram();
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await runAlertChecks(env);
  assert.equal(result.queued, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text, /🔴 VPS 离线：Alpha \(vps-a\)/);
  assert.match(sent[0].body.text, /最后上报：/);
  assert.match(sent[0].body.text, /已失联：11分钟/, '660s must render as 11 minutes');
  assert.match(sent[0].body.text, /阈值：10 分钟/);
  assert.equal(db.rows.get('vps-a\u0000agent_offline')?.status, 'active');
});

test('60s reporting with the throttled mirror still stays online until the heartbeat ages out', async (t) => {
  const envFor = (db, seenAgo) => baseEnv(db, {
    TELEMETRY_BUFFER: fleetBinding({
      states: { 'vps-a': { agent_id: 'vps-a', updated_at: iso(25 * 60) } },
      lastSeen: { 'vps-a': now - seenAgo },
    }),
  });
  const db = memoryDb({
    targets: [{ id: 'vps-a', name: 'Alpha', type: 'tcp', enabled: 1 }],
    metrics: [{ agent_id: 'vps-a', updated_at: iso(25 * 60), cpu_percent: 1 }],
    meta: { alert_settings: alertSettings() },
  });
  const sent = captureTelegram();
  t.after(() => { globalThis.fetch = originalFetch; });

  let result = await runAlertChecks(envFor(db, 55));
  assert.equal(result.queued, 0, 'a 60s reporter 55s after its last report is online');
  result = await runAlertChecks(envFor(db, 700));
  assert.equal(result.queued, 1, 'a 60s reporter 700s after its last report is offline');
  assert.match(sent[0].body.text, /已失联：11分钟/);
});

test('an active offline alert recovers as soon as the heartbeat is fresh again', async (t) => {
  const db = memoryDb({
    targets: [{ id: 'vps-a', name: 'Alpha', type: 'tcp', enabled: 1 }],
    metrics: [{ agent_id: 'vps-a', updated_at: iso(1400), cpu_percent: 1 }],
    alertState: [{ target_id: 'vps-a', rule_key: 'agent_offline', status: 'active', opened_at: now - 900, last_sent_at: now - 900, updated_at: now - 900 }],
    meta: { alert_settings: alertSettings() },
  });
  const env = baseEnv(db, {
    TELEMETRY_BUFFER: fleetBinding({
      states: { 'vps-a': { agent_id: 'vps-a', updated_at: iso(1400) } },
      lastSeen: { 'vps-a': now - 30 },
    }),
  });
  const sent = captureTelegram();
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await runAlertChecks(env);
  assert.equal(result.queued, 1);
  assert.match(sent[0].body.text, /🟢 VPS 上线：Alpha \(vps-a\)/);
  assert.match(sent[0].body.text, /恢复上报：/);
  assert.equal(db.rows.get('vps-a\u0000agent_offline')?.status, 'ok', 'the stale active row must resolve');
});

test('an active alert with no heartbeat and no metrics row is cleared instead of pinned forever', async (t) => {
  const db = memoryDb({
    targets: [{ id: 'vps-a', name: 'Alpha', type: 'tcp', enabled: 1 }],
    alertState: [{ target_id: 'vps-a', rule_key: 'agent_offline', status: 'active', opened_at: now - 900, last_sent_at: now - 900, updated_at: now - 900 }],
    meta: { alert_settings: alertSettings() },
  });
  const env = baseEnv(db, { TELEMETRY_BUFFER: fleetBinding({ states: {}, lastSeen: {} }) });
  const sent = captureTelegram();
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await runAlertChecks(env);
  assert.equal(result.queued, 0);
  assert.equal(sent.length, 0, 'clearing without data must not send a recovery message');
  assert.equal(db.rows.get('vps-a\u0000agent_offline')?.status, 'ok');
});

test('alert rows for targets that are no longer enabled are swept', async (t) => {
  const db = memoryDb({
    targets: [{ id: 'vps-b', name: 'Beta', type: 'tcp', enabled: 1 }],
    alertState: [
      { target_id: 'vps-gone', rule_key: 'agent_offline', status: 'active', opened_at: now - 900, last_sent_at: now - 900, updated_at: now - 900 },
      { target_id: 'vps-gone', rule_key: 'traffic:2026-09-19', status: 'active', last_value: 0, opened_at: now - 900, last_sent_at: now - 900, updated_at: now - 900 },
    ],
    meta: { alert_settings: alertSettings() },
  });
  const env = baseEnv(db, { TELEMETRY_BUFFER: fleetBinding({ states: {}, lastSeen: { 'vps-b': now - 20 } }) });
  const sent = captureTelegram();
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await runAlertChecks(env);
  assert.equal(result.cleared, 2, 'orphaned active rows must be resolved');
  assert.equal(db.rows.get('vps-gone\u0000agent_offline')?.status, 'ok');
  assert.equal(db.rows.get('vps-gone\u0000traffic:2026-09-19')?.status, 'ok');
  assert.equal(sent.length, 0);
});

test('deployments without the telemetry DO keep the D1 state fallback', async (t) => {
  const freshDb = memoryDb({
    targets: [{ id: 'vps-a', name: 'Alpha', type: 'tcp', enabled: 1 }],
    metrics: [{ agent_id: 'vps-a', updated_at: iso(120), cpu_percent: 1 }],
    meta: { alert_settings: alertSettings() },
  });
  const sent = captureTelegram();
  t.after(() => { globalThis.fetch = originalFetch; });

  let result = await runAlertChecks(baseEnv(freshDb));
  assert.equal(result.queued, 0, 'a fresh D1 row must not alert without the DO');

  const staleDb = memoryDb({
    targets: [{ id: 'vps-a', name: 'Alpha', type: 'tcp', enabled: 1 }],
    metrics: [{ agent_id: 'vps-a', updated_at: iso(1500), cpu_percent: 1 }],
    meta: { alert_settings: alertSettings() },
  });
  result = await runAlertChecks(baseEnv(staleDb));
  assert.equal(result.queued, 1, 'a stale D1 row must still alert without the DO');
  assert.match(sent[0].body.text, /已失联：25分钟/);
});

console.log('alert offline heartbeat tests passed');
