import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  extractReportTime,
  normalizeNodeQualityReport,
  parseNodeQualityMarkdown,
  publicNodeQualityReport,
} from '../src/nodequality.js';

const sample = await readFile('/Users/marknkx/.codex/attachments/7ce887bb-105a-4007-bad8-1f5bb41daa7e/pasted-text.txt', 'utf8');
const parsed = parseNodeQualityMarkdown(sample);
assert.deepEqual(parsed.tabs.map((tab) => [tab.id, tab.kind]), [
  ['basic', 'ansi'],
  ['ip', 'ansi'],
  ['network', 'image'],
  ['route', 'image'],
]);
assert.match(parsed.tabs[0].content, /硬件质量体检报告/);
assert.match(parsed.tabs[1].content, /IP质量体检报告/);
assert.equal(parsed.tabs[2].image, 'https://i.111666.best/image/cohH2O2u6Wo51sidbNj1U5.webp');
assert.equal(parsed.tabs[3].image, 'https://i.111666.best/image/LcUXW9z5bLcpL26JsJwUpI.webp');
assert.equal(extractReportTime(sample), '2026-07-23 22:37:36 CST');
assert.equal(parsed.link, 'https://nodequality.com/r/VLDpQuy3AFgJ8e3f4QA8BerZwBEwEldB');

const normalized = normalizeNodeQualityReport(sample, { now: 123 });
assert.equal(normalized.updatedAt, 123);
assert.equal(normalized.summary.tabs.length, 4);
const publicReport = publicNodeQualityReport({ id: 'vps-a', name: 'VPS A', nq_report: normalized.report, nq_updated_at: 123 });
assert.equal(publicReport.ok, true);
assert.equal('raw' in publicReport, false);
assert.equal(publicReport.tabs.length, 4);
assert.equal(publicReport.image_proxy_base, '/api/nq/vps-a/image');

assert.throws(() => normalizeNodeQualityReport('x'.repeat(120_001)), /过长/);
assert.equal(parseNodeQualityMarkdown('![image](javascript:alert(1))').tabs[0].id, 'basic');

console.log('NodeQuality worker tests passed');
