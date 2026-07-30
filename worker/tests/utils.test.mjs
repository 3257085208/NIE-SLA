import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { agentStatusFields, buildMissedPoints, buildOpenMissedPoints, lastPersistedCheckAt, normalizeTarget, parseBoolean, publicCheckPoint, sanitizeId, shouldRunScheduledFollowups, trafficPeriodFromResetDay } from '../src/utils.js';
import { agentScopedToken, latencyAgentScopedToken, requireAgentForId, requireAgentIdentity, requireAnyAgent, requireLatencyAgentForId, safeJson } from '../src/auth.js';
import { rateLimitD1 } from '../src/ratelimit.js';
import { compactMetricPoints, compactPingPointsByTarget, loadAgentPingsR2History, metricFieldsForRequest, metricPointsFromPayload, metricPointsToColumns, normalizeAgentMetricState, normalizeAgentVpsInfo, pingLossPointsToRuns, pingLossRunsToPoints, pingPointsFromPayload, pingPointsToSeries, summarizePingPointsByTarget, writeAgentTelemetryR2History } from '../src/metrics.js';
import { runAlertChecks } from '../src/alerts.js';
import { convertPriceToCny, getAgentUpdatePolicy, getExchangeRates, getPublicSettings, normalizeCurrency, normalizeFrontendAppearance, updatePublicSettings } from '../src/admin/settings.js';
import { normalizeTargetOrder } from '../src/admin/target-order.js';
import { cachedDailySummaryBefore, dailySummaryFromPoints, mergeR2StateUpdates } from '../src/storage.js';
import { checkBucketSummaryQueryPlan } from '../src/admin/check-buckets.js';
import { isAgentApiPath } from '../src/route-policy.js';
import { compactStatusPayload, refreshLatencySources } from '../src/status-payload.js';
import { agentAvailabilitySegments, mergeAgentAvailabilityRows, uptimeBaselineRows } from '../src/agent-availability.js';
import { getAgentInstallCommand } from '../src/admin/install-command.js';
import { getLatencyAgentInstallCommand } from '../src/admin/latency-agents.js';

globalThis.crypto ||= webcrypto;
const originalFetch = globalThis.fetch;

assert.equal(parseBoolean(true, false), true);
assert.equal(parseBoolean('true', false), true);
assert.equal(parseBoolean('1', false), true);
assert.equal(parseBoolean('false', true), false);
assert.equal(parseBoolean('0', true), false);
assert.equal(parseBoolean('yes', false), false);
assert.equal(parseBoolean('enabled', false), false);
assert.equal(shouldRunScheduledFollowups({ count: 38 }), true);
assert.equal(shouldRunScheduledFollowups({ count: 0 }), false);
assert.equal(shouldRunScheduledFollowups(null), false);
assert.equal(lastPersistedCheckAt({ last_checked_at: 100 }, { checked_at: 120 }), 120);
assert.equal(lastPersistedCheckAt({ last_checked_at: 140 }, { checked_at: 120 }), 140);
assert.equal(lastPersistedCheckAt({ last_checked_at: null }, null), 0);

const emptyId = sanitizeId('');
assert.equal(emptyId, sanitizeId(''));
assert.match(emptyId, /^id-[a-z0-9]+$/);
assert.equal(sanitizeId('%%%'), sanitizeId('%%%'));
assert.equal(sanitizeId('HTTP://Example.COM/a b'), 'example.com-a-b');

const env = { TIMEZONE_OFFSET_MINUTES: '480' };
const beforeReset = Date.parse('2026-07-05T12:00:00.000Z') / 1000;
const afterReset = Date.parse('2026-07-15T12:00:00.000Z') / 1000;

assert.deepEqual(trafficPeriodFromResetDay(env, 12, beforeReset), {
  month: '2026-06-12',
  reset: 'reset-day',
  reset_day: 12,
  period_start: '2026-06-12',
  period_end: '2026-07-12',
});
assert.deepEqual(trafficPeriodFromResetDay(env, 12, afterReset), {
  month: '2026-07-12',
  reset: 'reset-day',
  reset_day: 12,
  period_start: '2026-07-12',
  period_end: '2026-08-12',
});
assert.deepEqual(trafficPeriodFromResetDay(env, 1, beforeReset), {
  month: '2026-07-01',
  reset: 'calendar-month',
  reset_day: 1,
  period_start: '2026-07-01',
  period_end: '2026-08-01',
});
assert.deepEqual(trafficPeriodFromResetDay(env, 31, Date.parse('2026-03-15T12:00:00.000Z') / 1000), {
  month: '2026-02-28',
  reset: 'reset-day',
  reset_day: 31,
  period_start: '2026-02-28',
  period_end: '2026-03-31',
});

assert.equal(
  buildMissedPoints(env, { checked_at: 1783330800, ok: 1 }, 1783330800 + 12 * 300, 1, 'auto', 6).length,
  0,
);
assert.equal(
  buildMissedPoints(env, { checked_at: 1783330800, ok: 1 }, 1783330800 + 4 * 300, 1, 'auto', 6).length,
  3,
);
const missedWhileDown = buildMissedPoints(env, { checked_at: 1783330800, ok: 0 }, 1783330800 + 4 * 300, 0, 'auto', 6);
assert.equal(missedWhileDown.length, 3);
assert.ok(missedWhileDown.every(point => point.missed && point.latency_ms === null));
assert.deepEqual(publicCheckPoint(missedWhileDown[0]), {
  ...Object.fromEntries(Object.entries(missedWhileDown[0]).filter(([key]) => key !== 'cf_colo')),
  missed: true,
  region_label: '自动',
  error: null,
});
assert.equal(buildOpenMissedPoints(env, { checked_at: 1783330800, ok: 0 }, 1783330800 + 4 * 300, 'auto').length, 3);
assert.deepEqual(dailySummaryFromPoints([
  { checked_at: 1783330800, ok: 0, total: 1, ok_count: 0, latency_ms: null },
  ...missedWhileDown,
]), {
  total: 1,
  ok_count: 0,
  sum_latency_ms: 0,
  last_ok: 0,
  last_latency_ms: null,
  last_status_code: null,
  last_error: null,
  updated_at: 1783330800,
});

const cachedDaily = { total: 10, ok_count: 9, sum_latency_ms: 180, updated_at: 1200 };
assert.deepEqual(cachedDailySummaryBefore({ checked_at: 1200, daily: { '2026-07-18': cachedDaily } }, '2026-07-18', 1500), {
  total: 10,
  ok_count: 9,
  sum_latency_ms: 180,
});
assert.equal(cachedDailySummaryBefore({ checked_at: 1500, daily: { '2026-07-18': cachedDaily } }, '2026-07-18', 1500), null);
assert.equal(cachedDailySummaryBefore({ checked_at: 1500, daily: { '2026-07-18': cachedDaily } }, '2026-07-18', 1800), null);
assert.deepEqual(checkBucketSummaryQueryPlan('2026-06-19', {
  recentFromDay: '2026-07-17',
  historicalTargetIds: ['vps-a', 'vps-a', 'vps-b'],
}), [
  { where: 'day >= ?', params: ['2026-07-17'] },
  { where: 'day >= ? AND day < ? AND target_id IN (?,?)', params: ['2026-06-19', '2026-07-17', 'vps-a', 'vps-b'] },
]);
assert.deepEqual(checkBucketSummaryQueryPlan('2026-06-19', { targetIds: [] }), []);
assert.deepEqual(checkBucketSummaryQueryPlan('2026-06-19', { targetIds: ['vps-a'] }), [
  { where: '(day >= ?) AND target_id IN (?)', params: ['2026-06-19', 'vps-a'] },
]);

assert.equal(await rateLimitD1({}, 'missing-db', 1, 60), false);
const rateEnv = fakeRateLimitEnv();
assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => rateLimitD1(rateEnv, 'login:1', 3, 60))), [true, true, true, false, false, false, false, false]);
assert.equal(isAgentApiPath('/api/agent/metrics'), true);
assert.equal(isAgentApiPath('/api/agent/ping-targets'), true);
assert.equal(isAgentApiPath('/api/latency-agent/targets'), true);
assert.equal(isAgentApiPath('/api/latency-agent/results'), true);
assert.equal(isAgentApiPath('/api/latency-agent/update-policy'), true);

assert.throws(() => normalizeTarget({ type: 'tcp', name: 'Private VPS', target_host: '', target_port: 0 }), /主机/);
const privateTarget = normalizeTarget({ type: 'tcp', name: 'Private VPS', no_public_ip: true });
assert.equal(privateTarget.no_public_ip, true);
assert.equal(privateTarget.target_host, null);
assert.equal(privateTarget.target_port, null);

const compactStatus = compactStatusPayload({
  ok: true,
  frontend: { theme: 'cards', appearance: { site_name: 'Demo' } },
  days: ['2026-07-19'],
  region_proxy_enabled: true,
  summaries: [{ target_id: 'vps-a', day: '2026-07-19', total: 1, ok_count: 1 }],
  incidents: [{ target_id: 'vps-a', started_at: 1 }],
  ping_targets: [{ id: 'cn', name: 'China' }],
  targets: [{
    id: 'vps-a',
    provider: 'Example',
    daily: { '2026-07-19': { total: 1 } },
    agent_metrics: { cpu_percent: 12, memory: { percent: 34 }, pings: [{ target_id: 'cn', ts: 1 }] },
  }],
});
assert.equal(compactStatus.lite, true);
assert.equal(compactStatus.region_proxy_enabled, true);
assert.equal(compactStatus.frontend.appearance.site_name, 'Demo');
assert.deepEqual(compactStatus.summaries, [{ target_id: 'vps-a', day: '2026-07-19', total: 1, ok_count: 1 }]);
assert.equal(compactStatus.targets[0].provider, 'Example');
assert.equal(compactStatus.targets[0].agent_metrics.cpu_percent, 12);
assert.equal('daily' in compactStatus.targets[0], false);
assert.equal('pings' in compactStatus.targets[0].agent_metrics, false);
const liveLatency = refreshLatencySources({ id: 'vps-a', type: 'tcp', checked_at: 100, latency_ms: 20, ok: 1 }, [
  { id: 'tokyo', name: 'Tokyo', kind: 'external', checked_at: 101, latency_ms: 35, ok: true },
]);
assert.deepEqual(liveLatency.latency_sources.map(source => source.id), ['cloudflare', 'tokyo']);
assert.equal(liveLatency.latency_sources[0].latency_ms, 20);
assert.deepEqual(refreshLatencySources({ id: 'private', type: 'tcp', no_public_ip: 1 }, liveLatency.latency_sources).latency_sources, []);
assert.equal(isAgentApiPath('/api/agent/install-command'), false);

globalThis.fetch = async (url) => String(url).endsWith('/bin/VERSION')
  ? new Response('v9.8.7\n')
  : String(url).endsWith('/bin/SHA256SUMS')
    ? new Response('abc  nstatus-metrics-linux-amd64\n')
    : new Response('', { status: 404 });
const installCommand = await getAgentInstallCommand(
  {
    AGENT_TOKEN: 'global-agent-secret',
    PUBLIC_AGENT_API_BASE: 'https://api.example.test',
    DB: {
      prepare() {
        return {
          bind() {
            return {
              first: async () => ({ id: 'vps-a', name: 'VPS A' }),
              run: async () => ({ meta: { changes: 1 } }),
            };
          },
        };
      },
    },
  },
  new URL('https://api.example.test/api/agent/install-command?target_id=vps-a'),
  new Request('https://api.example.test/api/agent/install-command?target_id=vps-a', {
    headers: { origin: 'https://status.example.test' },
  }),
);
assert.equal(installCommand.ok, true);
assert.equal(installCommand.install_base, 'https://status.example.test');
assert.equal(installCommand.credential_bound, true);
assert.equal(installCommand.credential_type, 'one_time_install_token');
assert.match(installCommand.linux_command, /Authorization: Bearer nsi_[a-f0-9]{48}/);
assert.match(installCommand.linux_command, /https:\/\/api\.example\.test\/api\/agent\/install-script/);
assert.doesNotMatch(installCommand.linux_command, /NSTATUS_AGENT_TOKEN|\bnst_[a-f0-9]{32,}\b/);
assert.ok(installCommand.linux_command.length < 360);
assert.equal('windows_command' in installCommand, false);

const installCommandWithoutSourceHeaders = await getAgentInstallCommand(
  {
    AGENT_TOKEN: 'global-agent-secret',
    PUBLIC_AGENT_API_BASE: 'https://api.example.test',
    PUBLIC_SITE_ORIGIN: 'https://status.example.test',
    DB: {
      prepare() {
        return {
          bind() {
            return {
              first: async () => ({ id: 'vps-a', name: 'VPS A' }),
              run: async () => ({ meta: { changes: 1 } }),
            };
          },
        };
      },
    },
  },
  new URL('https://api.example.test/api/agent/install-command?target_id=vps-a'),
  new Request('https://api.example.test/api/agent/install-command?target_id=vps-a'),
);
assert.equal(installCommandWithoutSourceHeaders.ok, true);
assert.equal(installCommandWithoutSourceHeaders.install_base, 'https://status.example.test');
assert.match(installCommandWithoutSourceHeaders.linux_command, /https:\/\/api\.example\.test\/api\/agent\/install-script/);
const latencyInstallCommand = await getLatencyAgentInstallCommand(
  {
    AGENT_TOKEN: 'global-agent-secret',
    PUBLIC_AGENT_API_BASE: 'https://api.example.test',
    PUBLIC_SITE_ORIGIN: 'https://status.example.test',
    DB: {
      prepare() {
        return { bind() { return { first: async () => ({ id: 'latency-tokyo', name: '东京 IIJ' }) }; } };
      },
    },
  },
  new URL('https://api.example.test/api/latency-agent/install-command?node_id=latency-tokyo'),
  new Request('https://api.example.test/api/latency-agent/install-command?node_id=latency-tokyo'),
);
assert.equal(latencyInstallCommand.ok, true);
assert.match(latencyInstallCommand.linux_command, /install-latency\.sh/);
assert.match(latencyInstallCommand.linux_command, /install-latency\.sh\?v=6/);
assert.doesNotMatch(latencyInstallCommand.linux_command, /NSTATUS_AGENT_ID=/);
globalThis.fetch = originalFetch;
assert.equal(isAgentApiPath('/api/login'), false);

assert.deepEqual(await safeJson(new Request('https://example.com', { method: 'POST', body: '{"ok":true}' }), 64), { ok: true });
await assert.rejects(
  () => safeJson(new Request('https://example.com', { method: 'POST', body: JSON.stringify({ value: 'x'.repeat(100) }) }), 32),
  err => err?.status === 413,
);

const authEnv = authEnvWithTargets(['vps-a', 'vps-b']);
const scopedToken = await agentScopedToken(authEnv, 'vps-a');
assert.match(scopedToken, /^nst_[a-f0-9]{48}$/);
assert.deepEqual(await requireAgentForId(agentRequest('global-secret'), authEnv, 'vps-a'), { type: 'global' });
assert.deepEqual(await requireAgentForId(agentRequest(scopedToken), authEnv, 'vps-a'), { type: 'scoped', agent_id: 'vps-a' });
assert.deepEqual(await requireAgentIdentity(agentRequest(scopedToken), authEnv, 'vps-a'), { type: 'scoped', agent_id: 'vps-a' });
const externalScopedToken = await agentScopedToken(authEnv, 'external-probe');
assert.deepEqual(await requireAgentIdentity(agentRequest(externalScopedToken), authEnv, 'external-probe'), { type: 'scoped', agent_id: 'external-probe' });
await assert.rejects(() => requireAgentForId(agentRequest(scopedToken), authEnv, 'vps-b'), /未授权/);
await assert.rejects(() => requireAgentForId(agentRequest(scopedToken), authEnv, 'deleted-vps'), /不存在或已禁用/);
assert.deepEqual(await requireAnyAgent(agentRequest(scopedToken), authEnvWithTargets(['vps-a'])), { type: 'scoped', agent_id: 'vps-a' });
await assert.rejects(() => requireAnyAgent(agentRequest(scopedToken), authEnvWithTargets(['vps-b'])), /未授权/);
const latencyAuthEnv = authEnvWithTargets(['latency-tokyo']);
const latencyToken = await latencyAgentScopedToken(latencyAuthEnv, 'latency-tokyo');
assert.deepEqual(await requireLatencyAgentForId(agentRequest(latencyToken), latencyAuthEnv, 'latency-tokyo'), { type: 'scoped', node_id: 'latency-tokyo' });

const settingsEnv = fakeD1Env();
assert.equal((await getPublicSettings(settingsEnv)).agent_auto_update, true);
assert.equal('themes' in (await getPublicSettings(settingsEnv)), false);
await updatePublicSettings(new Request('https://example.com', { method: 'PATCH', body: JSON.stringify({ frontend_theme: 'cards' }) }), settingsEnv);
assert.equal((await getPublicSettings(settingsEnv)).frontend_theme, 'classic');
assert.equal(normalizeFrontendAppearance({ site_name: ' Demo ', brand_logo_url: 'javascript:bad', accent_color: 'red' }).site_name, 'Demo');
assert.equal(normalizeFrontendAppearance({ site_name: ' Demo ', brand_logo_url: 'javascript:bad', accent_color: 'red' }).brand_logo_url, '');
assert.equal(normalizeFrontendAppearance({ site_name: ' Demo ', brand_logo_url: 'javascript:bad', accent_color: 'red' }).accent_color, '#2ea36d');
const appearance = normalizeFrontendAppearance({
  brand_home_url: 'data:text/html,bad',
  brand_logo_height: 500,
  header_right_image_width: 20,
  header_right_mode: 'invalid',
  hero_subtitle: ' 自定义说明 ',
  show_header: 'false',
  show_chart: 0,
  show_vps_details: '1',
});
assert.equal(appearance.brand_home_url, './');
assert.equal(appearance.brand_logo_height, 64);
assert.equal(appearance.header_right_image_width, 40);
assert.equal(appearance.header_right_mode, 'image');
assert.equal(appearance.hero_subtitle, '自定义说明');
assert.equal(appearance.show_header, false);
assert.equal(appearance.show_chart, false);
assert.equal(appearance.show_vps_details, true);
assert.equal(normalizeCurrency('rmb'), 'CNY');
assert.equal(normalizeCurrency('not-a-currency'), 'USD');
assert.equal(convertPriceToCny(10, 'USD', { CNY: 1, USD: 0.14 }), 71.43);
assert.equal(convertPriceToCny(10, 'UNKNOWN', { CNY: 1 }), null);
globalThis.fetch = async (url) => String(url).includes('api.exchangerate-api.com')
  ? new Response(JSON.stringify({ rates: { CNY: 1, USD: 0.14, EUR: 0.12 } }), { headers: { 'content-type': 'application/json' } })
  : new Response('', { status: 404 });
const fetchedRates = await getExchangeRates(settingsEnv);
assert.equal(fetchedRates.USD, 0.14);
assert.ok(settingsEnv._tables.app_meta.some(row => row.key === 'exchange_rates_updated'));
await updatePublicSettings(new Request('https://example.com', {
  method: 'PATCH',
  body: JSON.stringify({ agent_auto_update: true }),
}), settingsEnv);
assert.equal((await getPublicSettings(settingsEnv)).agent_auto_update, true);
await updatePublicSettings(new Request('https://example.com', { method: 'PATCH', body: JSON.stringify({ appearance: { site_name: 'Status Demo', banner_normal: '全部在线' } }) }), settingsEnv);
assert.equal((await getPublicSettings(settingsEnv)).appearance.site_name, 'Status Demo');
assert.equal((await getPublicSettings(settingsEnv)).appearance.banner_normal, '全部在线');
globalThis.fetch = async (url) => String(url).endsWith('/bin/VERSION')
  ? new Response('v1.0.9\n')
  : new Response('abc  nstatus-metrics-linux-amd64\n');
const updatePolicy = await getAgentUpdatePolicy({ ...settingsEnv, AGENT_DOWNLOAD_BASE: 'https://downloads.example' });
assert.equal(updatePolicy.auto_update, true);
assert.equal(updatePolicy.release_ready, true);
assert.equal(updatePolicy.latest_version, 'v1.0.9');
assert.match(updatePolicy.manifest_sha256, /^[a-f0-9]{64}$/);
const assetRequests = [];
globalThis.fetch = async () => { throw new Error('same-origin Worker fetch must not be used for bound assets'); };
const sameOriginPolicy = await getAgentUpdatePolicy({
  ...settingsEnv,
  ASSETS: {
    async fetch(request) {
      assetRequests.push(new URL(request.url).pathname);
      return request.url.endsWith('/bin/VERSION')
        ? new Response('v1.0.21\n')
        : new Response('abc  nstatus-metrics-linux-amd64\n');
    },
  },
}, new Request('https://one-click.example/api/agent/update-policy?agent_id=vps-a'));
assert.equal(sameOriginPolicy.download_base, 'https://one-click.example');
assert.equal(sameOriginPolicy.release_ready, true);
assert.equal(sameOriginPolicy.latest_version, 'v1.0.21');
assert.deepEqual(assetRequests.sort(), ['/bin/SHA256SUMS', '/bin/VERSION']);
globalThis.fetch = originalFetch;

const reordered = normalizeTargetOrder(['web-c', 'vps-a'], ['vps-a', 'vps-b', 'web-c']);
assert.equal(reordered.ok, true);
assert.deepEqual(reordered.ids, ['web-c', 'vps-a', 'vps-b']);
const duplicateOrder = normalizeTargetOrder(['vps-a', 'vps-a'], ['vps-a', 'vps-b']);
assert.equal(duplicateOrder.ok, false);
assert.equal(normalizeTargetOrder(['missing'], ['vps-a']).ok, false);

const liveAgent = agentStatusFields({ updated_at: new Date().toISOString() }, {});
assert.equal(liveAgent.status_source, 'agent');
assert.equal(liveAgent.agent_online, true);
assert.equal(agentStatusFields({ updated_at: '2020-01-01T00:00:00.000Z' }, {}).agent_online, false);

const availabilityEnv = { TIMEZONE_OFFSET_MINUTES: '0', AGENT_OFFLINE_AFTER_SEC: '900' };
assert.deepEqual(agentAvailabilitySegments('2026-07-20T23:50:00Z', '2026-07-22T00:10:00Z', availabilityEnv), [
  { day: '2026-07-20', total: 600, ok_count: 600 },
  { day: '2026-07-21', total: 86400, ok_count: 300 },
  { day: '2026-07-22', total: 600, ok_count: 0 },
]);
assert.deepEqual(agentAvailabilitySegments('2026-07-24T10:00:00Z', '2026-07-24T10:05:00Z', availabilityEnv), [
  { day: '2026-07-24', total: 300, ok_count: 300 },
]);
assert.deepEqual(mergeAgentAvailabilityRows(
  [{ agent_id: 'private-vps', day: '2026-07-24', total_sec: 600, online_sec: 600 }],
  [{ agent_id: 'private-vps', updated_at: '2026-07-24T00:10:00Z' }],
  availabilityEnv,
  Math.floor(new Date('2026-07-24T01:10:00Z').getTime() / 1000),
), [{ agent_id: 'private-vps', day: '2026-07-24', total: 4200, ok_count: 1500 }]);
const baselineMetrics = [{
  agent_id: 'private-vps',
  updated_at: '2026-07-24T12:00:00Z',
  uptime_sec: 4 * 86400,
}];
const baselineTargets = [{
  id: 'private-vps',
  no_public_ip: 1,
  created_at: Math.floor(new Date('2026-07-21T04:00:00Z').getTime() / 1000),
}];
assert.deepEqual(uptimeBaselineRows([], baselineMetrics, baselineTargets, availabilityEnv, Math.floor(new Date('2026-07-24T12:00:00Z').getTime() / 1000)), [
  { agent_id: 'private-vps', day: '2026-07-21', total: 72000, ok_count: 72000 },
  { agent_id: 'private-vps', day: '2026-07-22', total: 86400, ok_count: 86400 },
  { agent_id: 'private-vps', day: '2026-07-23', total: 86400, ok_count: 86400 },
  { agent_id: 'private-vps', day: '2026-07-24', total: 43200, ok_count: 43200 },
]);
assert.deepEqual(uptimeBaselineRows(
  [{ agent_id: 'private-vps', day: '2026-07-24', total_sec: 60, online_sec: 60 }],
  baselineMetrics,
  baselineTargets,
  availabilityEnv,
  Math.floor(new Date('2026-07-24T12:00:00Z').getTime() / 1000),
).map(row => row.day), ['2026-07-21', '2026-07-22', '2026-07-23']);

const lockedR2Env = fakeLockedR2Env();
const mergedStates = await Promise.all([
  mergeR2StateUpdates(lockedR2Env, [{ target_id: 'a', checked_at: 1, ok: 1 }]),
  mergeR2StateUpdates(lockedR2Env, [{ target_id: 'b', checked_at: 2, ok: 1 }]),
]);
assert.ok(mergedStates.every(result => result.ok));
assert.deepEqual(Object.keys((await lockedR2Env.ARCHIVE.get('state/status.json')).value.targets).sort(), ['a', 'b']);

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
const boundedState = normalizeAgentMetricState({
  cpu_percent: 150,
  process_count: -5,
  memory: { total_mb: 1024, used_mb: -1, percent: 125 },
  disk: { total_gb: 14, used_gb: 6, avail_gb: 8, percent: -20 },
  load: { load1: -1 },
  net: { rx_bytes_sec: -1, tx_bytes_sec: 1e308 },
  diskio: { read_bytes_sec: -1, write_bytes_sec: 1e308 },
});
assert.equal(boundedState.cpu_percent, 100);
assert.equal(boundedState.process_count, 0);
assert.equal(boundedState.memory.used_mb, 0);
assert.equal(boundedState.memory.percent, 0);
assert.equal(boundedState.disk.percent, 42.86);
assert.equal(boundedState.net.rx_bytes_sec, 0);
assert.equal(boundedState.net.tx_bytes_sec, 1024 ** 5);
const boundedPoints = compactMetricPoints([{ ts: 1, cpu: 150, mem: -1, disk: 101, net_rx: -1, gpu_util: 150, cpu_temp: -500 }], 2);
assert.deepEqual({ cpu: boundedPoints[0].cpu, mem: boundedPoints[0].mem, disk: boundedPoints[0].disk, net_rx: boundedPoints[0].net_rx }, { cpu: 100, mem: 0, disk: 100, net_rx: 0 });
assert.equal(boundedPoints[0].gpu_util, 100);
assert.equal(boundedPoints[0].cpu_temp, -100);
const boundedVpsInfo = normalizeAgentVpsInfo({
  cpu_model: 'x'.repeat(400),
  cpu_cores: -1,
  total_disk_gb: 1e308,
  gpu_util: 150,
  temperature_sensors: [
    { label: 'CPU', kind: 'cpu', temp_c: 5000 },
    { label: 'Null', kind: 'cpu', temp_c: null },
    { label: 'Empty', kind: 'cpu', temp_c: '' },
    { label: 'NaN', kind: 'cpu', temp_c: 'not-a-number' },
  ],
});
assert.equal(boundedVpsInfo.cpu_model.length, 256);
assert.equal(boundedVpsInfo.cpu_cores, 0);
assert.equal(boundedVpsInfo.total_disk_gb, 1_000_000_000_000);
assert.equal(boundedVpsInfo.gpu_util, 100);
assert.deepEqual(boundedVpsInfo.temperature_sensors, [{ label: 'CPU', kind: 'cpu', temp_c: 1000 }]);

const r2Env = fakeR2Env();
const hourStart = Math.floor(Date.now() / 3_600_000) * 3600;
const firstBatch = Array.from({ length: 300 }, (_, i) => ({ ...metricPoints[i], ts: hourStart + i }));
const secondBatch = Array.from({ length: 300 }, (_, i) => ({ ...metricPoints[i], ts: hourStart + 300 + i }));
await writeAgentTelemetryR2History(r2Env, 'vps-a', firstBatch);
await writeAgentTelemetryR2History(r2Env, 'vps-a', secondBatch);
const telemetryObject = [...r2Env._objects.values()].find(item => item.key.endsWith('/telemetry.json'));
assert.ok(telemetryObject, 'combined telemetry history should be written to R2');
assert.equal(metricPointsFromPayload(telemetryObject.value.metrics).length, 600, 'successive reports must retain every raw sample');
assert.equal(r2Env._puts, 2, 'each report should use one R2 write');

const pingPoints = Array.from({ length: 500 }, (_, i) => ({ target_id: 'a', ts: 2000 + i, latency_ms: 10 + i, ok: 1 }))
  .concat(Array.from({ length: 20 }, (_, i) => ({ target_id: 'b', ts: 3000 + i, latency_ms: 20, ok: 1 })));
const compactPings = compactPingPointsByTarget(pingPoints, 50);
assert.ok(compactPings.filter(p => p.target_id === 'a').length <= 50);
assert.equal(compactPings.filter(p => p.target_id === 'b').length, 20);
assert.equal(compactPings.find(p => p.target_id === 'a').ts, 2000);
assert.deepEqual(summarizePingPointsByTarget([
  { target_id: 'a', ts: 1, latency_ms: 10, ok: 1 },
  { target_id: 'a', ts: 2, latency_ms: null, ok: 0 },
  { target_id: 'b', ts: 3, latency_ms: 20, ok: 1 },
]), [
  { target_id: 'a', total: 2, ok: 1, lost: 1, loss_rate: 50 },
  { target_id: 'b', total: 1, ok: 1, lost: 0, loss_rate: 0 },
]);
const pingSeries = pingPointsToSeries(pingPoints.slice(0, 3));
assert.deepEqual(pingSeries[0].dt, [0, 1, 2]);
assert.deepEqual(pingSeries[0].latency_ms, [10, 11, 12]);
assert.deepEqual(pingPointsFromPayload({ series: pingSeries }).map(p => p.latency_ms), [10, 11, 12]);
const sparseLosses = [100, 103, 109, 110, 111, 150].map(ts => ({ target_id: 'a', ts, latency_ms: null, ok: 0 }));
const sparseLossRuns = pingLossPointsToRuns(sparseLosses);
assert.deepEqual(pingLossRunsToPoints(sparseLossRuns).map(point => point.ts), sparseLosses.map(point => point.ts), 'sparse loss runs must round-trip exactly');
const fullDayLosses = Array.from({ length: 86_400 }, (_, index) => ({ target_id: 'dense', ts: 10_000 + index, latency_ms: null, ok: 0 }));
const fullDayLossRuns = pingLossPointsToRuns(fullDayLosses);
assert.deepEqual(fullDayLossRuns[0].runs, [[0, 1, 86_400]], 'a continuous one-second outage must use one run');
assert.ok(JSON.stringify(fullDayLossRuns).length < 128, 'a full-day outage must remain compact');
const full72HourTarget = Array.from({ length: 72 * 3600 }, (_, index) => ({ target_id: 'capacity', ts: 20_000 + index, latency_ms: null, ok: 0 }));
const full72HourRuns = pingLossPointsToRuns(full72HourTarget);
const estimatedFleetPayload = JSON.stringify(full72HourRuns).length * 5 * 100;
assert.ok(estimatedFleetPayload < 128 * 1024, '100 Agents x five full-outage targets x 72 hours must remain compact as runs');
const currentHourPings = pingPoints.slice(0, 3).map((point, index) => ({ ...point, ts: hourStart + index }));
await writeAgentTelemetryR2History(r2Env, 'vps-a', [], currentHourPings);
const telemetryWithPings = [...r2Env._objects.values()].find(item => item.key.endsWith('/telemetry.json'));
assert.equal(pingPointsFromPayload(telemetryWithPings.value.pings).length, 3, 'ping history should share the telemetry object');
assert.equal(metricPointsFromPayload(telemetryWithPings.value.metrics).length, 600, 'ping-only reports must preserve metric history');
const loadedCombinedPings = await loadAgentPingsR2History(r2Env, 'vps-a', hourStart, hourStart + 10);
assert.equal(loadedCombinedPings.pings.length, 3, 'combined telemetry pings should remain readable through the public loader');

const legacyR2Env = fakeR2Env();
const legacyIso = new Date(hourStart * 1000).toISOString();
const legacyBase = `agent-metrics-v1/vps-a/${legacyIso.slice(0, 10)}/${legacyIso.slice(11, 13)}`;
await legacyR2Env.ARCHIVE.put(`${legacyBase}/metrics.json`, JSON.stringify({ series: metricPointsToColumns(firstBatch.slice(0, 2)) }));
await legacyR2Env.ARCHIVE.put(`${legacyBase}/pings.json`, JSON.stringify({ series: pingPointsToSeries(pingPoints.slice(0, 2).map((point, index) => ({ ...point, ts: hourStart + index }))) }));
await writeAgentTelemetryR2History(legacyR2Env, 'vps-a', [{ ...metricPoints[2], ts: hourStart + 2 }]);
const migratedTelemetry = [...legacyR2Env._objects.values()].find(item => item.key.endsWith('/telemetry.json'));
assert.equal(metricPointsFromPayload(migratedTelemetry.value.metrics).length, 3, 'legacy metric objects should migrate without data loss');
assert.equal(pingPointsFromPayload(migratedTelemetry.value.pings).length, 2, 'legacy ping objects should migrate without data loss');

globalThis.fetch = async () => ({ ok: true, text: async () => '' });
const fakeAlertEnv = fakeD1Env();
const alertResult = await runAlertChecks(fakeAlertEnv, { max_messages: 5 });
assert.equal(alertResult.ok, true);
assert.equal(alertResult.sent, 1);
assert.equal(fakeAlertEnv._tables.alert_state.length, 1);
assert.equal(fakeAlertEnv._alertStatePointReads, 0, 'alert checks should preload state instead of querying each rule');
globalThis.fetch = originalFetch;

console.log('worker utility tests passed');

function fakeRateLimitEnv() {
  const rows = [];
  return {
    DB: {
      prepare(sql) {
        let params = [];
        return {
          bind(...values) { params = values; return this; },
          async run() {
            if (sql.startsWith('DELETE FROM rate_limits WHERE key')) {
              const [key, cutoff] = params;
              for (let i = rows.length - 1; i >= 0; i--) if (rows[i].key === key && rows[i].ts < cutoff) rows.splice(i, 1);
              return { meta: { changes: 0 } };
            }
            if (sql.startsWith('INSERT INTO rate_limits')) {
              const [key, ts, countKey, cutoff, limit] = params;
              const count = rows.filter(row => row.key === countKey && row.ts >= cutoff).length;
              if (count >= limit) return { meta: { changes: 0 } };
              rows.push({ key, ts });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        };
      },
    },
  };
}

function fakeLockedR2Env() {
  const objects = new Map();
  let lock = null;
  return {
    DB: {
      prepare(sql) {
        let params = [];
        return {
          bind(...values) { params = values; return this; },
          async run() {
            if (sql.startsWith('INSERT INTO app_meta')) {
              const [key, token, updatedAt, now] = params;
              if (!lock || Number.parseInt(lock.value, 10) < now) lock = { key, value: token, updated_at: updatedAt };
              return { meta: { changes: lock?.value === token ? 1 : 0 } };
            }
            if (sql.startsWith('DELETE FROM app_meta') && lock?.key === params[0] && lock?.value === params[1]) lock = null;
            return { meta: { changes: 1 } };
          },
          async first() {
            return sql.includes('FROM app_meta') && lock?.key === params[0] ? { value: lock.value } : null;
          },
        };
      },
    },
    ARCHIVE: {
      async get(key) {
        const value = objects.get(key);
        if (!value) return null;
        const copy = () => JSON.parse(JSON.stringify(value));
        return { value: copy(), json: async () => copy() };
      },
      async put(key, body) {
        await new Promise(resolve => setTimeout(resolve, 10));
        objects.set(key, JSON.parse(body));
      },
    },
  };
}

function fakeD1Env() {
  const nowIso = new Date().toISOString();
  let alertStatePointReads = 0;
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
        if (sql.includes('FROM alert_state') && sql.includes('WHERE target_id')) alertStatePointReads++;
        return fakeStatement(sql, tables);
      },
    },
    _tables: tables,
    get _alertStatePointReads() { return alertStatePointReads; },
  };
  return env;
}

function fakeR2Env() {
  const objects = new Map();
  let puts = 0;
  return {
    ARCHIVE: {
      async get(key) {
        const item = objects.get(key);
        return item ? { json: async () => JSON.parse(JSON.stringify(item.value)) } : null;
      },
      async put(key, body) {
        puts++;
        objects.set(key, { key, value: JSON.parse(body) });
      },
    },
    _objects: objects,
    get _puts() { return puts; },
  };
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
        let values = [];
        return {
          bind(...params) { values = params; return this; },
          all: async () => ({ results: ids.map(id => ({ id })) }),
          first: async () => ids.includes(String(values[0] || '')) ? { id: values[0] } : null,
        };
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


// cpu_temp thermal fields
{
  const pts = compactMetricPoints([
    { ts: 1, cpu: 1, cpu_temp: 40, gpu_temp: 50, gpu_util: 10, motherboard_temp: 35, disk_temp: 32, chipset_temp: 44 },
    { ts: 2, cpu: 2, cpu_temp: 42, gpu_temp: 52, gpu_util: 20, motherboard_temp: 37, disk_temp: 34, chipset_temp: 46 },
  ], 2);
  assert.equal(pts.length, 2);
  assert.equal(pts[0].cpu_temp, 40);
  assert.equal(pts[1].gpu_util, 20);
  assert.equal(pts[0].motherboard_temp, 35);
  assert.equal(pts[1].disk_temp, 34);
  assert.deepEqual(metricFieldsForRequest('temp'), ['cpu_temp', 'gpu_temp', 'motherboard_temp', 'disk_temp', 'chipset_temp']);
}
