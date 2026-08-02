import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  extractReportTime,
  nodeQualityUnlockData,
  normalizeNodeQualityReportUrl,
  normalizeNodeQualityReport,
  parseNodeQualityMarkdown,
  parseNqMediaServices,
  publicNodeQualityReport,
} from '../src/nodequality.js';

const sample = await readFile(new URL('./fixtures/nodequality-report.md', import.meta.url), 'utf8');
const parsed = parseNodeQualityMarkdown(sample);
assert.deepEqual(parsed.tabs.map((tab) => [tab.id, tab.kind]), [
  ['basic', 'ansi'],
  ['ip', 'ansi'],
  ['network', 'image'],
  ['route', 'image'],
]);
assert.match(parsed.tabs[0].content, /硬件质量体检报告/);
assert.match(parsed.tabs[1].content, /IP质量体检报告/);
assert.equal(parsed.tabs[2].image, 'https://example.com/network.webp');
assert.equal(parsed.tabs[3].image, 'https://example.com/route.webp');
assert.equal(extractReportTime(sample), '2026-07-23 22:37:36 CST');
assert.equal(parsed.link, 'https://nodequality.com/r/example-report');

const normalized = normalizeNodeQualityReport(sample, { now: 123 });
assert.equal(normalized.updatedAt, 123);
assert.equal(normalized.summary.tabs.length, 4);
const publicReport = publicNodeQualityReport({ id: 'vps-a', name: 'VPS A', nq_report: normalized.report, nq_updated_at: 123 });
assert.equal(publicReport.ok, true);
const nqUnlock = nodeQualityUnlockData({ id: 'vps-a', nq_report: normalized.report, nq_updated_at: 123 });
assert.equal(nqUnlock.source, 'NQ');
assert.equal(nqUnlock.checked_at, 123);
assert.deepEqual(nqUnlock.services.map((service) => [service.id, service.status, service.region, service.method]), [
  ['tiktok', '解锁', '[TW]', 'DNS'],
  ['netflix', '失败', '[]', 'DNS'],
]);
const ansiMedia = '五、流媒体及AI服务解锁检测\n服务商： TikTok Disney+ Netflix Youtube AmazonPV Reddit ChatGPT\n状态： 解锁 解锁 仅自制 中国 屏蔽 解锁 解锁\n地区： [JP] [JP] [JP] [CN] [] [] [US]\n方式： 原生 原生 原生 — — — DNS';
const ansiServices = parseNqMediaServices(ansiMedia);
assert.deepEqual(ansiServices.map((service) => service.id), ['tiktok', 'disney_plus', 'netflix', 'youtube', 'amazon_pv', 'reddit', 'chatgpt']);
assert.equal(ansiServices[3].status, '中国');
assert.equal(ansiServices[4].status, '屏蔽');
assert.equal('raw' in publicReport, false);
assert.equal(publicReport.tabs.length, 4);
assert.equal(publicReport.image_proxy_base, '/api/nq/vps-a/image');
assert.equal(normalizeNodeQualityReportUrl('https://nodequality.com/r/VLDpQuy3AFgJ8e3f4QA8BerZwBEwEldB'), 'https://nodequality.com/r/VLDpQuy3AFgJ8e3f4QA8BerZwBEwEldB');
assert.equal(normalizeNodeQualityReportUrl('https://www.nodequality.com/r/example-report/'), 'https://nodequality.com/r/example-report');
const unsafeLegacyReport = publicNodeQualityReport({
  id: 'legacy-a',
  name: 'Legacy',
  nq_report: '[NodeQuality链接](https://evil.example/report)\n报告时间：2026-07-30 00:00:00 CST',
});
assert.equal(unsafeLegacyReport.link, null);
assert.equal(normalizeNodeQualityReportUrl('https://run.nodequality.com/'), '');
assert.equal(normalizeNodeQualityReportUrl('https://nodequality.com/'), '');
const agentReport = normalizeNodeQualityReport({
  link: 'https://nodequality.com/r/example-agent',
  tabs: [{ id: 'basic', content: '报告时间：2026-07-28 22:18:00 CST\nCPU: Test' }],
}, { now: 456 });
assert.equal(JSON.parse(agentReport.report).report_time, '2026-07-28 22:18:00 CST');

assert.throws(() => normalizeNodeQualityReport('x'.repeat(120_001)), /过长/);
assert.equal(parseNodeQualityMarkdown('![image](javascript:alert(1))').tabs[0].id, 'basic');

console.log('NodeQuality worker tests passed');
