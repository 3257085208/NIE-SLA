import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  buildLinePoints,
  clampChartRange,
  countChartGaps,
  countMissedChecks,
  filterChecksByRange,
  normalizeChartRows,
  trimEmptyPointEdges,
} from '../js/shared/chart-data.js';
import { createAdminClient } from '../js/admin/api.js';
import { latestAgentTaskMaps, shouldOpenNodeQualityReport } from '../js/admin/task-history.js';
import { agentInstallCommandFromPayload, latencyInstallCommandFromPayload, copyText } from '../js/install-command.js';
import { LINE_TYPE_OPTIONS, groupByDimension, groupByMenuHtml, groupKeyFor, lineTypeOptionsHtml, normalizeGroupByMode, priceBandKey } from '../js/shared/grouping.js';
import { readStorage, removeStorage, writeStorage } from '../js/shared/storage.js';
import { canShowTemperature, hasGpuData, hasTemperatureData, isVirtualized } from '../js/shared/hardware.js';
import {
  CURRENCIES,
  COUNTRIES,
  PROVIDERS,
  countryFlagAsset,
  filterCountries,
  filterProviders,
  normalizeCountryCode,
} from '../js/shared/target-catalogs.js';
import { formatLocationLabel, normalizeCityName } from '../js/shared/format.js';
import {
  bindNodeQualityModal,
  buildNqModalHtml,
  normalizeNqReportLink,
  renderNqAnsiHtml,
  renderNqNetworkReportHtml,
  renderNqReportHtml,
  renderNqRouteReportHtml,
  targetHasNodeQuality,
} from '../js/shared/nodequality.js';
import { DEFAULT_APPEARANCE, normalizeAppearance } from '../js/shared/appearance.js';
import { unlockState } from '../js/shared/unlock.js';
import { dailyFleetSlaSeries, targetSlaPercentage } from '../js/shared/sla.js';
import { failedPingTargetsNear, latestPingByTarget, nextPingTargetSelection, normalizeLatencySample, pingLossSeries, pingSampleWindowSec } from '../js/shared/ping.js';
import { onRequest as routeAdminPage } from '../functions/[[path]].js';
import { onRequestOptions as apiProxyOptions } from '../functions/api/[[path]].js';

const rows = normalizeChartRows([
  { checked_at: 30, ok: 1, latency_ms: 20 },
  { checked_at: 10, ok: 0, latency_ms: null },
  { checked_at: 20, ok: 1, latency_ms: 10, missed: true },
]);
assert.deepEqual(rows.map((row) => row.x), [10, 20, 30]);
assert.deepEqual(buildLinePoints(rows), [{ x: 10, y: null }, { x: 30, y: 20 }]);
assert.deepEqual(trimEmptyPointEdges([
  { x: 10, y: null },
  { x: 20, y: 11 },
  { x: 30, y: null },
  { x: 40, y: 12 },
  { x: 50, y: null },
]), [{ x: 20, y: 11 }, { x: 30, y: null }, { x: 40, y: 12 }]);
assert.deepEqual(clampChartRange(-10, 30, 0, 100), { min: 0, max: 40 });
assert.deepEqual(clampChartRange(80, 120, 0, 100), { min: 60, max: 100 });
assert.equal(countChartGaps([{ checked_at: 0 }, { checked_at: 10 }, { checked_at: 40 }], 20), 1);
assert.equal(countMissedChecks([{ missed: true }, {}, { missed: true }]), 2);
assert.deepEqual(filterChecksByRange([{ checked_at: 100 }, { checked_at: 100_000 }], 'day', 100_000), [{ checked_at: 100_000 }]);

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.sessionStorage = globalThis.localStorage;

let lastRequest = null;
globalThis.fetch = async (url, options) => {
  lastRequest = { url, options };
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

const client = createAdminClient({ apiBase: 'https://api.example' });
client.saveSession('session', Math.floor(Date.now() / 1000) + 60);
await client.api('/api/targets');
assert.equal(lastRequest.options.headers.Authorization, undefined);
assert.equal(lastRequest.options.headers['x-admin-session'], 'session');

const taskMaps = latestAgentTaskMaps([
  { id: 'ip-new', agent_id: 'vps-a', action: 'ip_unlock', status: 'failed' },
  { id: 'nq-new', agent_id: 'vps-a', action: 'nodequality', status: 'failed' },
  { id: 'nq-old', agent_id: 'vps-a', action: 'nodequality', status: 'succeeded' },
]);
assert.equal(taskMaps.byAgent.get('vps-a').id, 'ip-new');
assert.equal(taskMaps.byAction.get('vps-a:ip_unlock').id, 'ip-new');
assert.equal(taskMaps.byAction.get('vps-a:nodequality').id, 'nq-new');
assert.equal(shouldOpenNodeQualityReport({ action: 'nodequality', status: 'succeeded', result: { report_saved: false } }), true, 'completed legacy NQ tasks must try the current structured report');
assert.equal(shouldOpenNodeQualityReport({ action: 'nodequality', status: 'failed' }), false);
assert.equal(shouldOpenNodeQualityReport({ action: 'ip_unlock', status: 'succeeded' }), false);
await client.apiAuth('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'secret' }) });
assert.equal(lastRequest.options.headers.Authorization, undefined);
assert.equal(lastRequest.options.headers['x-admin-session'], undefined);
const installResponse = await client.apiAdmin('/api/agent/install-command?target_id=vps-a', {}, 1_000);
assert.equal(installResponse.ok, true);
assert.match(lastRequest.url, /\/api\/agent\/install-command\?target_id=vps-a$/);
assert.equal(lastRequest.options.headers['x-admin-session'], 'session');

let directApiAborted = false;
globalThis.fetch = (_url, options) => new Promise((resolve, reject) => {
  options.signal.addEventListener('abort', () => {
    directApiAborted = true;
    reject(new DOMException('aborted', 'AbortError'));
  }, { once: true });
});
const timeoutClient = createAdminClient({ apiBase: 'https://api.example', defaultTimeoutMs: 25 });
await assert.rejects(timeoutClient.api('/api/slow'), /API 请求超时/);
assert.equal(directApiAborted, true, 'direct Admin API requests must have a default abort deadline');
globalThis.fetch = async (url, options) => {
  lastRequest = { url, options };
  return Response.json({ ok: true });
};

const oneTimeTicket = `nsi_${'a'.repeat(48)}`;
const shortInstallCommand = `(t=$(mktemp) && trap 'rm -f "$t"' EXIT INT TERM && chmod 0600 "$t" && curl -fsSL -H 'Authorization: Bearer ${oneTimeTicket}' 'https://api.example/api/agent/install-script' -o "$t" && sh "$t")`;
const validInstallPayload = {
  ok: true,
  target_id: 'vps-a',
  api_base: 'https://api.example',
  credential_bound: true,
  credential_type: 'one_time_install_token',
  linux_command: shortInstallCommand,
};
assert.equal(agentInstallCommandFromPayload(validInstallPayload, 'vps-a'), shortInstallCommand);
assert.throws(() => agentInstallCommandFromPayload({ ...validInstallPayload, target_id: 'vps-b' }, 'vps-a'), /不匹配/);
assert.throws(() => agentInstallCommandFromPayload({ ...validInstallPayload, credential_bound: false }, 'vps-a'), /未绑定/);
assert.throws(() => agentInstallCommandFromPayload({ ...validInstallPayload, linux_command: "curl -fsSL 'https://api.example/api/agent/install-script' | sh" }, 'vps-a'), /缺少有效/);
const fakeLongLivedAgentToken = 'nst_' + 'a'.repeat(48);
assert.throws(() => agentInstallCommandFromPayload({ ...validInstallPayload, linux_command: `NSTATUS_AGENT_TOKEN='${fakeLongLivedAgentToken}' sh install.sh` }, 'vps-a'), /缺少有效|长期节点凭据/);
const latencyInstallCommand = shortInstallCommand.replace('/api/agent/install-script', '/api/latency-agent/install-script');
const validLatencyInstallPayload = {
  ok: true,
  node_id: 'latency-tokyo',
  api_base: 'https://api.example',
  credential_bound: true,
  credential_type: 'one_time_latency_install_token',
  linux_command: latencyInstallCommand,
};
assert.equal(latencyInstallCommandFromPayload(validLatencyInstallPayload, 'latency-tokyo'), latencyInstallCommand);
assert.throws(() => latencyInstallCommandFromPayload({ ...validLatencyInstallPayload, node_id: 'latency-osaka' }, 'latency-tokyo'), /不匹配/);
assert.throws(() => latencyInstallCommandFromPayload({ ...validLatencyInstallPayload, credential_type: 'one_time_install_token' }, 'latency-tokyo'), /未绑定/);
assert.throws(() => latencyInstallCommandFromPayload({ ...validLatencyInstallPayload, linux_command: `NSTATUS_LATENCY_TOKEN='${fakeLongLivedAgentToken}' sh install-latency.sh` }, 'latency-tokyo'), /缺少有效|长期节点凭据/);

const originalBrowserGlobals = new Map(['navigator', 'window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let clipboardWrites = 0;
let fallbackCopies = 0;
const installClipboardGlobals = (writeText, fallbackResult = true) => {
  const textarea = {
    value: '',
    style: {},
    setAttribute() {},
    select() {},
    remove() {},
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { isSecureContext: true } });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      body: { appendChild() {} },
      createElement() { return textarea; },
      execCommand(command) {
        assert.equal(command, 'copy');
        fallbackCopies++;
        return fallbackResult;
      },
    },
  });
};
try {
  installClipboardGlobals(async value => { clipboardWrites++; assert.equal(value, shortInstallCommand); });
  await copyText(shortInstallCommand, { timeoutMs: 100 });
  assert.equal(clipboardWrites, 1);
  assert.equal(fallbackCopies, 0);

  installClipboardGlobals(async () => { clipboardWrites++; throw new DOMException('blocked', 'NotAllowedError'); });
  await copyText(shortInstallCommand, { timeoutMs: 100 });
  assert.equal(fallbackCopies, 1, 'rejected Clipboard API must use the fallback');

  installClipboardGlobals(() => new Promise(() => {}));
  await copyText(shortInstallCommand, { timeoutMs: 100 });
  assert.equal(fallbackCopies, 2, 'pending Clipboard API must time out and use the fallback');

  installClipboardGlobals(async () => { throw new DOMException('blocked', 'NotAllowedError'); }, false);
  await assert.rejects(() => copyText(shortInstallCommand, { timeoutMs: 100 }), /剪贴板权限/);
} finally {
  for (const [key, descriptor] of originalBrowserGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}

const targets = [
  { name: 'a', group_name: 'G1', provider: 'DMIT', location: 'HK', line_type: '落地鸡', price: 8 },
  { name: 'b', group_name: 'G1', provider: 'DMIT', location: 'US', line_type: '线路鸡', price: 12 },
  { name: 'c', group_name: 'G2', provider: 'Bandwagon', location: 'HK', line_type: '落地鸡', price: 3 },
];
assert.equal(groupKeyFor(targets[0], 'provider'), 'DMIT');
assert.equal(Object.keys(groupByDimension(targets, 'location')).length, 2);
assert.equal(Object.keys(groupByDimension(targets, 'line_type')).length, 2);
assert.equal(priceBandKey({ price: 8 }), '5 – 10');
assert.match(groupByMenuHtml('location'), /role="listbox"/);
assert.match(groupByMenuHtml('location'), /data-group-value="location"[^>]*>国家\/地区<\/button>/);
assert.equal(normalizeGroupByMode('provider'), 'provider');
assert.equal(normalizeGroupByMode('legacy-invalid-value'), 'group');
assert.equal(groupKeyFor(targets[0], 'legacy-invalid-value'), 'G1');

const blockedStorage = {
  getItem() { throw new DOMException('blocked', 'SecurityError'); },
  setItem() { throw new DOMException('blocked', 'SecurityError'); },
  removeItem() { throw new DOMException('blocked', 'SecurityError'); },
};
globalThis.blockedStorage = blockedStorage;
assert.equal(readStorage('blockedStorage', 'key', 'fallback'), 'fallback');
assert.equal(writeStorage('blockedStorage', 'key', 'value'), false);
assert.equal(removeStorage('blockedStorage', 'key'), false);
delete globalThis.blockedStorage;
Object.defineProperty(globalThis, 'blockedStorage', {
  configurable: true,
  get() { throw new DOMException('blocked', 'SecurityError'); },
});
assert.equal(readStorage('blockedStorage', 'key', 'getter-fallback'), 'getter-fallback');
assert.equal(writeStorage('blockedStorage', 'key', 'value'), false);
delete globalThis.blockedStorage;
assert.match(groupByMenuHtml('line_type'), /data-group-value="line_type"[^>]*>机器类型<\/button>/);
for (const type of ['建站机', '线路机', '落地机', '中转机', '家宽机', '解锁机', '存储机', '备份机', '算力机', '游戏机', '邮件机', '综合用途']) {
  assert.equal(LINE_TYPE_OPTIONS.some((option) => option.id === type), true, `${type} must be available as a machine type`);
}
assert.match(lineTypeOptionsHtml('落地鸡'), /value="落地鸡" selected>落地鸡（旧数据）<\/option>/);
assert.equal(groupKeyFor({}, 'line_type'), '未设置机器类型');
assert.equal(countryFlagAsset('HK'), './assets/flags/4x3/hk.svg');
assert.equal(isVirtualized({ virtualization: 'kvm' }), true);
assert.equal(isVirtualized({ virtualization: 'bare-metal' }), false);
assert.equal(canShowTemperature({ virtualization: 'docker' }), false);
assert.equal(canShowTemperature({ virtualization: '' }), true);
assert.equal(hasTemperatureData({ virtualization: 'kvm', cpu_temp_c: 40 }), false);
assert.equal(hasTemperatureData({ virtualization: '', disk_temp_c: 36 }), true);
assert.equal(hasTemperatureData({ virtualization: '', temperature_sensors: [{ temp_c: 42 }] }), true);
assert.equal(hasGpuData({ gpu_util: 0 }), false);
assert.equal(hasGpuData({ gpu_count: 1 }), true);
assert.equal(hasGpuData({ gpu_name: 'NVIDIA RTX A4000' }), true);
assert.equal(hasGpuData({ virtualization: 'lxc', gpu_count: 1, gpu_name: 'Onboard IGD' }), false);
assert.equal(hasGpuData({ virtualization: 'lxc', gpu_count: 1, gpu_name: 'NVIDIA RTX A4000', gpu_accessible: true }), true);
assert.equal(hasGpuData({ virtualization: 'kvm', gpu_count: 1, gpu_name: 'NVIDIA RTX A4000', gpu_util: 0 }), true);
assert.equal(COUNTRIES.length, 249);
for (const country of COUNTRIES) {
  assert.equal(existsSync(new URL(`../assets/flags/4x3/${country.code.toLowerCase()}.svg`, import.meta.url)), true);
}
assert.equal(PROVIDERS.length >= 140, true);
assert.equal(new Set(PROVIDERS.map((provider) => provider.toLocaleLowerCase('en'))).size, PROVIDERS.length);
assert.deepEqual([...PROVIDERS].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })), PROVIDERS);
for (const provider of ['DMIT', 'LightLayer', 'MKCloud', 'HostDZire', 'Cloudnium', 'HostBrr', 'servaRICA', 'ReliableSite']) {
  assert.equal(PROVIDERS.includes(provider), true, `${provider} must be available in the provider catalog`);
}
assert.equal(CURRENCIES.length >= 15, true);
assert.equal(normalizeCountryCode('香港'), 'HK');
assert.equal(filterCountries('新加坡')[0].code, 'SG');
assert.equal(filterProviders('rack')[0], 'RackNerd');

const customizedAppearance = normalizeAppearance({
  site_name: ' Demo ',
  brand_home_url: 'https://status.example/',
  brand_logo_url: 'javascript:alert(1)',
  brand_logo_height: 999,
  header_right_image_width: 10,
  header_right_mode: 'text',
  show_chart: false,
  show_vps_details: '0',
  accent_color: '#123abc',
});
assert.equal(customizedAppearance.site_name, 'Demo');
assert.equal(customizedAppearance.brand_home_url, 'https://status.example/');
assert.equal(customizedAppearance.brand_logo_url, '');
assert.equal(customizedAppearance.brand_logo_height, 64);
assert.equal(customizedAppearance.header_right_image_width, 40);
assert.equal(customizedAppearance.header_right_mode, 'text');
assert.equal(customizedAppearance.show_chart, false);
assert.equal(customizedAppearance.show_vps_details, false);
assert.equal(customizedAppearance.accent_color, '#123abc');
assert.equal(normalizeAppearance({ brand_home_url: 'data:text/html,bad', accent_color: 'red' }).brand_home_url, DEFAULT_APPEARANCE.brand_home_url);
assert.equal(normalizeAppearance({ brand_home_url: 'data:text/html,bad', accent_color: 'red' }).accent_color, DEFAULT_APPEARANCE.accent_color);

console.log('frontend module tests passed');

assert.equal(normalizeCityName('  Los  Angeles  '), 'Los Angeles');
assert.equal(formatLocationLabel('美国', 'Los Angeles'), '美国 · Los Angeles');
assert.equal(formatLocationLabel('日本', '东京'), '日本 · 东京');
assert.equal(formatLocationLabel('香港', '香港'), '香港');
assert.equal(formatLocationLabel('', 'Singapore'), 'Singapore');
assert.equal(formatLocationLabel('德国', ''), '德国');
assert.equal(typeof bindNodeQualityModal, 'function');
console.log('location label helpers ok');

assert.equal(unlockState({ status: 'Yes', region: 'US', method: 'DNS' }), 'dns');
assert.equal(unlockState({ status: '解锁', region: 'CA', method: 'DNS' }), 'dns');
assert.equal(unlockState({ status: 'Yes', region: 'US', method: 'Native' }), 'good');
assert.equal(unlockState({ status: 'No', region: '', method: 'DNS' }), 'bad');
console.log('unlock state helpers ok');

const slaSummaries = new Map([
  ['probe-a:2026-07-26', { total: 100, ok_count: 99 }],
  ['probe-a:2026-07-27', { total: 10, ok_count: 1 }],
  ['agent-a:2026-07-27', { total: 86400, ok_count: 86300 }],
  ['clamped-a:2026-07-27', { total: 10, ok_count: 20 }],
  ['negative-a:2026-07-27', { total: 10, ok_count: -5 }],
  ['invalid-a:2026-07-27', { total: 'invalid', ok_count: 5 }],
  ['web-a:2026-07-27', { total: 288, ok_count: 287 }],
]);
assert.equal(targetSlaPercentage('probe-a', ['2026-07-26'], slaSummaries), 99);
assert.equal(targetSlaPercentage('probe-a', ['2026-07-26', '2026-07-27'], slaSummaries), 100 / 110 * 100);
assert.equal(targetSlaPercentage('agent-a', ['2026-07-27'], slaSummaries), 86300 / 86400 * 100);
assert.equal(targetSlaPercentage('clamped-a', ['2026-07-27'], slaSummaries), 100);
assert.equal(targetSlaPercentage('negative-a', ['2026-07-27'], slaSummaries), 0);
assert.equal(targetSlaPercentage('invalid-a', ['2026-07-27'], slaSummaries), null);
assert.equal(targetSlaPercentage('missing-a', ['2026-07-27'], slaSummaries), null);
assert.equal(targetSlaPercentage('web-a', ['2026-07-27'], slaSummaries), 287 / 288 * 100);
assert.deepEqual(dailyFleetSlaSeries(
  ['probe-a', 'web-a', 'missing-a'],
  ['2026-07-26', '2026-07-27'],
  slaSummaries,
), [
  { day: '2026-07-26', value: 99, target_count: 1 },
  { day: '2026-07-27', value: ((1 / 10 * 100) + (287 / 288 * 100)) / 2, target_count: 2 },
]);
const pingSamples = [
  { target_id: 'a', ts: 100, latency_ms: 30, ok: 1 },
  { target_id: 'a', ts: 130, latency_ms: null, ok: 0 },
  { target_id: 'b', ts: 100, latency_ms: 45, ok: 1 },
  { target_id: 'b', ts: 130, latency_ms: 50, ok: 1 },
];
assert.equal(latestPingByTarget(pingSamples).get('a').ok, false);
assert.equal(pingSampleWindowSec(pingSamples), 19.5);
assert.deepEqual(failedPingTargetsNear(pingSamples, 132), ['a']);
assert.deepEqual(failedPingTargetsNear(pingSamples, 170), []);
assert.deepEqual(pingLossSeries(pingSamples, ['a', 'b']), [{ x: 100, y: 0 }, { x: 130, y: 0.5 }]);
assert.deepEqual(pingLossSeries(pingSamples, ['b']), [{ x: 100, y: 0 }, { x: 130, y: 0 }]);
assert.deepEqual([...nextPingTargetSelection(null, 'a', ['a', 'b', 'c'])], ['a']);
assert.deepEqual([...nextPingTargetSelection(new Set(['a']), 'b', ['a', 'b', 'c'])], ['a', 'b']);
assert.equal(nextPingTargetSelection(new Set(['a', 'b']), 'c', ['a', 'b', 'c']), null);
assert.equal(nextPingTargetSelection(new Set(['a']), 'a', ['a', 'b', 'c']), null);
assert.deepEqual(normalizeLatencySample('external-a', { checked_at: 200, latency_ms: 999, ok: true }), {
  target_id: 'external-a', ts: 200, latency_ms: 999, ok: true,
});
assert.deepEqual(normalizeLatencySample('external-a', { checked_at: 230, latency_ms: 1001, ok: true }), {
  target_id: 'external-a', ts: 230, latency_ms: null, ok: false,
});
console.log('SLA summary helpers ok');

const previousFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  assert.match(String(url), /\/api\/auth\/config$/);
  return Response.json({ ok: true, admin_path: '/console-7f3a' });
};
const pagesEnv = {
  NSTATUS_API_BASE: 'https://api.example',
  ASSETS: {
    fetch: async request => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/admin.html') return new Response(null, { status: 307, headers: { location: '/admin' } });
      return new Response(pathname);
    },
  },
};
const routePage = pathname => routeAdminPage({
  request: new Request(`https://status.example${pathname}`),
  env: pagesEnv,
  next: async request => new Response(request ? new URL(request.url).pathname : 'next'),
});
const customAdminPage = await routePage('/console-7f3a');
assert.equal(customAdminPage.status, 200);
assert.equal(await customAdminPage.text(), '/admin');
assert.equal(customAdminPage.headers.get('location'), null);
assert.equal((await routePage('/console-7f3a/')).status, 308);
assert.equal((await routePage('/admin')).status, 404);
assert.equal(await (await routePage('/unrelated')).text(), 'next');
globalThis.fetch = previousFetch;
console.log('Pages admin path routing ok');

const sameOriginPreflight = await apiProxyOptions({ request: new Request('https://status.example/api/status', {
  method: 'OPTIONS',
  headers: { origin: 'https://status.example' },
}) });
assert.equal(sameOriginPreflight.headers.get('access-control-allow-origin'), 'https://status.example');
const crossOriginPreflight = await apiProxyOptions({ request: new Request('https://status.example/api/status', {
  method: 'OPTIONS',
  headers: { origin: 'https://evil.example' },
}) });
assert.equal(crossOriginPreflight.headers.get('access-control-allow-origin'), null);
console.log('Pages API proxy CORS ok');

assert.equal(targetHasNodeQuality({ type: 'tcp', has_nq: 1 }), true);
assert.equal(targetHasNodeQuality({ type: 'tcp', nq: { has_report: true } }), true);
assert.equal(targetHasNodeQuality({ type: 'http', has_nq: 1 }), false);
assert.match(renderNqAnsiHtml('\u001b[31mred\u001b[0m'), /color:#ef4444/);
assert.match(renderNqReportHtml('五、流媒体服务解锁检测\n服务商： TikTok Netflix\n状态： 解锁 失败\n地区： [TW] []\n方式： DNS\n六、邮局连通性及黑名单检测'), /nq-media-grid[\s\S]*nq-media-badge success[\s\S]*nq-media-badge danger/);
const sparseUnlock = renderNqReportHtml('五、流媒体服务解锁检测\n服务商：  TikTok   Disney+  Netflix Youtube  AmazonPV  Reddit   Bilibili\n状态：     失败     失败     失败    失败     屏蔽     解锁     失败\n地区：                         []\n方式：                         DNS\n六、邮局连通性及黑名单检测');
assert.match(sparseUnlock, /nq-media-label">地区<\/span>[\s\S]*nq-media-cell ">—<\/span>[\s\S]*nq-media-cell ">\[\]<\/span>/, 'sparse unlock fields must retain their source column');
const networkLayout = renderNqNetworkReportHtml('报告标题\n一、BGP信息\n注册信息：ARIN\n二、本地策略\nTCP拥塞控制算法：bbr');
assert.match(networkLayout, /nq-network-section[\s\S]*nq-network-title">一、BGP信息[\s\S]*nq-network-scroll/, 'network reports must split long terminal output into locally scrollable sections');
const inlineNetworkHeading = renderNqNetworkReportHtml('\u001b[37m四、三网TCP大包延迟（依次为电信|联通|移动 Step=80ms） \u001b[36m京\u001b[31m155\u001b[0m\n津 156 168 307\n六、国内测速   发送 延迟 接收 延迟\n杭州电信 ERROR ERROR');
assert.doesNotMatch(inlineNetworkHeading, /nq-network-title">(?:(?!<\/div>)[\s\S])*京/, 'the first province must not remain inside the network section title');
assert.match(inlineNetworkHeading, /nq-network-scroll[\s\S]*京[\s\S]*155[\s\S]*津/, 'inline province data must move to the network section body');
assert.match(inlineNetworkHeading, /nq-network-title">六、国内测速[\s\S]*nq-network-scroll[\s\S]*发送 延迟 接收 延迟/, 'inline speed-test columns must move below their section title');
const routeLayout = renderNqRouteReportHtml('五、三网回程路由\n  北京 电信 Cogent -> 163\n地理路径：美国 -> 北京 自治系统路径：AS174 -> AS4134\n 3 0.66ms 10.9.*.* * RFC1918\n 5-8 146.85ms 202.97.*.* AS4134 [CHINANET-BB] 中国 北京 电信');
assert.match(routeLayout, /nq-route-block[\s\S]*nq-route-path[\s\S]*nq-route-hop-number">3[\s\S]*nq-route-latency success">0\.66ms/, 'route reports must render responsive hop rows');
assert.match(routeLayout, /nq-route-asn">AS4134[\s\S]*nq-route-network">CHINANET-BB[\s\S]*nq-route-location">中国 北京 电信/, 'route hop metadata must retain ASN, network, and location');
const proxiedNqImage = buildNqModalHtml({
  report_time: '2026-07-23 22:41:36 CST',
  image_proxy_base: '/api/nq/vps-a/image',
  tabs: [{ id: 'network', kind: 'image', image: 'https://private-image-host.example/network.webp' }],
});
assert.match(proxiedNqImage, /\/api\/nq\/vps-a\/image\/network/);
assert.doesNotMatch(proxiedNqImage, /private-image-host\.example|data-nq-original/);
assert.match(proxiedNqImage, /referrerpolicy="no-referrer"/);
assert.match(proxiedNqImage, /role="tab"[^>]+aria-selected="true"/);
assert.match(proxiedNqImage, /role="tablist" aria-label="报告章节"/);
assert.match(proxiedNqImage, /role="tabpanel" aria-labelledby="nq-tab-0" tabindex="0"/);
const hostedNqWithSource = buildNqModalHtml({
  image_proxy_base: '/api/nq/vps-a/image',
  tabs: [
    { id: 'network', kind: 'image', image: '/api/nq/vps-a/image/network', content: '一、BGP信息\n注册信息：ARIN' },
    { id: 'route', kind: 'image', image: '/api/nq/vps-a/image/route', content: '五、三网回程路由\n北京 电信 Cogent -> 163' },
  ],
});
assert.match(hostedNqWithSource, /nq-network-panel[\s\S]*nq-network-report/, 'hosted network reports must keep the historical ANSI layout when source content is available');
assert.match(hostedNqWithSource, /nq-route-panel[\s\S]*nq-route-report/, 'hosted route reports must keep the historical ANSI layout when source content is available');
assert.doesNotMatch(hostedNqWithSource, /nq-image-panel|class="nq-image"/, 'hosted report images must not replace the historical network and route UI');
assert.equal(normalizeNqReportLink('https://www.nodequality.com/r/example-report/'), 'https://nodequality.com/r/example-report');
assert.equal(normalizeNqReportLink('javascript:alert(1)'), '');
assert.equal(normalizeNqReportLink('https://nodequality.com.evil.example/r/example-report'), '');
const unsafeNqUrls = buildNqModalHtml({
  link: 'javascript:alert(1)',
  image_proxy_base: '//image-host.example/api/nq/vps-a/image',
  tabs: [{ id: 'network', kind: 'image', image: 'https://private-image-host.example/network.webp', content: 'safe fallback' }],
});
assert.doesNotMatch(unsafeNqUrls, /javascript:|image-host\.example|private-image-host\.example|打开原报告/);
assert.match(unsafeNqUrls, /safe fallback/);
assert.match(buildNqModalHtml({ tabs: [{ id: 'network', kind: 'ansi', content: '一、BGP信息' }, { id: 'route', kind: 'ansi', content: '五、三网回程路由' }] }), /nq-network-panel[\s\S]*nq-route-panel/, 'ANSI network and route tabs must use their dedicated layouts');
const adminSource = readFileSync(new URL('../js/admin.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const adminCss = readFileSync(new URL('../admin.css', import.meta.url), 'utf8');
assert.match(adminSource, /document\.body\.classList\.add\("admin-modal-open"\)/, 'admin modals must lock background scrolling');
assert.match(adminSource, /modalReturnFocus[\s\S]*returnFocus\.focus\(\)/, 'admin modals must restore focus to their opener');
assert.match(adminSource, /onkeydown[\s\S]{0,900}event\.key !== "Tab"/, 'admin modals must trap keyboard focus');
assert.equal(adminSource.match(/input:not\(\[disabled\]\):not\(\[type="hidden"\]\)/g)?.length, 2, 'admin modal focus management must exclude hidden form fields');
assert.match(adminCss, /body\.admin-modal-open\s*\{\s*overflow:\s*hidden/, 'admin modal scroll locking must be styled');
assert.match(appSource, /部分状态数据暂不可用/, 'public status warnings must not be rendered as real empty data');
console.log('NodeQuality frontend helpers ok');
