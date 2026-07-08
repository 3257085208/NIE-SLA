import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { buildMissedPoints, parseBoolean, sanitizeId, trafficPeriodFromExpiry } from '../src/utils.js';
import { agentScopedToken, requireAgentForId, requireAnyAgent } from '../src/auth.js';
import { rateLimitD1 } from '../src/ratelimit.js';
import { compactMetricPoints, compactPingPointsByTarget, metricFieldsForRequest, metricPointsFromPayload, metricPointsToColumns, pingPointsFromPayload, pingPointsToSeries } from '../src/metrics.js';
import { runAlertChecks } from '../src/alerts.js';

globalThis.crypto ||= webcrypto;

assert.equal(parseBoolean(true, false), true);
assert.equal(parseBoolean('true', false), true);
assert.equal(parseBoolean('1', false), true);
assert.equal(parseBoolean('false', true), false);
assert.equal(parseBoolean('0', true), false);
assert.equal(parseBoolean('yes', false), false);
assert.equal(parseBoolean('enabled', false), false);

const emptyId = sanitizeId('');
assert.equal(emptyId, sanitizeId(''));
assert.match(emptyId, /^id-[a-z0-9]+$/);
assert.equal(sanitizeId('%%%'), sanitizeId('%%%'));
assert.equal(sanitizeId('HTTP://Example.COM/a b'), 'example.com-a-b');

const env = { TIMEZONE_OFFSET_MINUTES: '480' };
const expiryAt = Date.parse('2027-01-11T16:00:00.000Z') / 1000; // 2027-01-12 in UTC+8.
const beforeReset = Date.parse('2026-07-05T12:00:00.000Z') / 1000;
const afterReset = Date.parse('2026-07-15T12:00:00.000Z') / 1000;

assert.deepEqual(trafficPeriodFromExpiry(env, expiryAt, beforeReset), {
  month: '2026-06-12',
  reset: 'expiry-day',
  reset_day: 12,
  period_start: '2026-06-12',
  period_end: '2026-07-12',
});
assert.deepEqual(trafficPeriodFromExpiry(env, expiryAt, afterReset), {
  month: '2026-07-12',
  reset: 'expiry-day',
  reset_day: 12,
  period_start: '2026-07-12',
  period_end: '2026-08-12',
});

assert.equal(
  buildMissedPoints(env, { checked_at: 1783330800, ok: 1 }, 1783330800 + 12 * 300, 1, 'auto', 6).length,
  0,
);
assert.equal(
  buildMissedPoints(env, { checked_at: 1783330800, ok: 1 }, 1783330800 + 4 * 300, 1, 'auto', 6).length,
  3,
);

assert.equal(await rateLimitD1({}, 'missing-db', 1, 60), false);

const authEnv = { AGENT_TOKEN: 'global-secret' };
const scopedToken = await agentScopedToken(authEnv, 'vps-a');
assert.match(scopedToken, /^nst_[a-f0-9]{48}$/);
assert.deepEqual(await requireAgentForId(agentRequest('global-secret'), authEnv, 'vps-a'), { type: 'global' });
assert.deepEqual(await requireAgentForId(agentRequest(scopedToken), authEnv, 'vps-a'), { type: 'scoped', agent_id: 'vps-a' });
await assert.rejects(() => requireAgentForId(agentRequest(scopedToken), authEnv, 'vps-b'), /Unauthorized/);
assert.deepEqual(await requireAnyAgent(agentRequest(scopedToken), authEnvWithTargets(['vps-a'])), { type: 'scoped', agent_id: 'vps-a' });
await assert.rejects(() => requireAnyAgent(agentRequest(scopedToken), authEnvWithTargets(['vps-b'])), /Unauthorized/);

const metricPoints = Array.from({ length: 1000 }, (_, i) => ({
  ts: 1000 + i,
  cpu: i % 100,
  mem: 50,
  disk: 10,
  load1: 0.1,
  net_rx: i,
  net_tx: i * 2,
  tcp_conns: 1,
  udp_conns: 2,
  disk_read: 0,
  disk_write: 0,
}));
const compactMetrics = compactMetricPoints(metricPoints, 100);
assert.ok(compactMetrics.length <= 100);
assert.equal(compactMetrics[0].ts, metricPoints[0].ts);
assert.equal(compactMetrics.at(-1).ts, metricPoints.at(-1).ts);
assert.deepEqual(metricFieldsForRequest('net'), ['net_rx', 'net_tx']);
const metricColumns = metricPointsToColumns(metricPoints.slice(0, 3), ['cpu']);
assert.deepEqual(metricColumns.fields, ['cpu']);
assert.deepEqual(metricColumns.dt, [0, 1, 2]);
assert.deepEqual(metricColumns.values.cpu, [0, 1, 2]);
assert.deepEqual(metricPointsFromPayload({ series: metricColumns }, ['cpu']).map(p => p.cpu), [0, 1, 2]);

const pingPoints = Array.from({ length: 500 }, (_, i) => ({ target_id: 'a', ts: 2000 + i, latency_ms: 10 + i, ok: 1 }))
  .concat(Array.from({ length: 20 }, (_, i) => ({ target_id: 'b', ts: 3000 + i, latency_ms: 20, ok: 1 })));
const compactPings = compactPingPointsByTarget(pingPoints, 50);
assert.ok(compactPings.filter(p => p.target_id === 'a').length <= 50);
assert.equal(compactPings.filter(p => p.target_id === 'b').length, 20);
assert.equal(compactPings.find(p => p.target_id === 'a').ts, 2000);
const pingSeries = pingPointsToSeries(pingPoints.slice(0, 3));
assert.deepEqual(pingSeries[0].dt, [0, 1, 2]);
assert.deepEqual(pingSeries[0].latency_ms, [10, 11, 12]);
assert.deepEqual(pingPointsFromPayload({ series: pingSeries }).map(p => p.latency_ms), [10, 11, 12]);

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, text: async () => '' });
const fakeAlertEnv = fakeD1Env();
const alertResult = await runAlertChecks(fakeAlertEnv, { max_messages: 5 });
assert.equal(alertResult.ok, true);
assert.equal(alertResult.sent, 1);
assert.equal(fakeAlertEnv._tables.alert_state.length, 1);
globalThis.fetch = originalFetch;

console.log('worker utility tests passed');

function fakeD1Env() {
  const nowIso = new Date().toISOString();
  const tables = {
    app_meta: [
      { key: 'alert_settings', value: JSON.stringify({ enabled: true, telegram_chat_id: '1', cpu_percent: 1, repeat_minutes: 0 }), updated_at: 1 },
    ],
    targets: [{ id: 'test-vps', name: 'Test VPS', enabled: 1, alert_enabled: 1, interval_sec: 300 }],
    agent_metrics_state: [{
      agent_id: 'test-vps',
      updated_at: nowIso,
      cpu_percent: 2,
      memory: '{}',
      load: '{}',
      disk: '{}',
      net: '{}',
      diskio: '{}',
      process_count: 1,
      thread_count: 1,
    }],
    agent_traffic_monthly: [],
    latest_status: [{ target_id: 'test-vps', checked_at: Math.floor(Date.now() / 1000), ok: 1, latency_ms: 1 }],
    alert_state: [],
  };
  const env = {
    TELEGRAM_BOT_TOKEN: '123:test',
    DB: {
      prepare(sql) {
        return fakeStatement(sql, tables);
      },
    },
    _tables: tables,
  };
  return env;
}

function agentRequest(token) {
  return new Request('https://example.com', {
    headers: { authorization: `Bearer ${token}` },
  });
}

function authEnvWithTargets(ids) {
  return {
    AGENT_TOKEN: 'global-secret',
    DB: {
      prepare() {
        return { all: async () => ({ results: ids.map(id => ({ id })) }) };
      },
    },
  };
}

function fakeStatement(sql, tables) {
  let params = [];
  return {
    bind(...values) {
      params = values;
      return this;
    },
    async all() {
      if (sql.includes('FROM targets')) return { results: tables.targets };
      if (sql.includes('FROM agent_metrics_state')) return { results: tables.agent_metrics_state };
      if (sql.includes('FROM agent_traffic_monthly')) return { results: tables.agent_traffic_monthly };
      if (sql.includes('FROM latest_status')) return { results: tables.latest_status };
      if (sql.includes("rule_key LIKE 'traffic:%'")) return { results: tables.alert_state.filter(row => row.target_id === params[0] && row.rule_key.startsWith('traffic:')) };
      if (sql.includes('FROM alert_state')) return { results: tables.alert_state.filter(row => row.target_id === params[0]) };
      return { results: [] };
    },
    async first() {
      if (sql.includes('FROM app_meta')) return tables.app_meta.find(row => row.key === params[0]) || null;
      if (sql.includes('FROM alert_state')) return tables.alert_state.find(row => row.target_id === params[0] && row.rule_key === params[1]) || null;
      return null;
    },
    async run() {
      if (sql.includes('INSERT INTO alert_state')) {
        if (sql.includes("VALUES (?, ?, 'ok'")) {
          const [targetId, ruleKey, resolvedAt, updatedAt] = params;
          tables.alert_state.push({ target_id: targetId, rule_key: ruleKey, status: 'ok', resolved_at: resolvedAt, updated_at: updatedAt });
        } else {
          const [targetId, ruleKey, value, openedAt, sentAt, updatedAt] = params;
          tables.alert_state.push({ target_id: targetId, rule_key: ruleKey, status: 'active', last_value: value, opened_at: openedAt, last_sent_at: sentAt, updated_at: updatedAt });
        }
      } else if (sql.includes('INSERT INTO app_meta')) {
        const [key, value, updatedAt] = params;
        const row = tables.app_meta.find(item => item.key === key);
        if (row) Object.assign(row, { value, updated_at: updatedAt });
        else tables.app_meta.push({ key, value, updated_at: updatedAt });
      }
      return { success: true, meta: { changes: 1 } };
    },
  };
}
