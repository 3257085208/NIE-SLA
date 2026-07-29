import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  extractReportTime,
  normalizeNodeQualityReportUrl,
  normalizeNodeQualityReport,
  parseNodeQualityMarkdown,
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
