import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildNqModalHtml, renderNqReportHtml, renderUnlockServicesReportHtml } from '../js/shared/nodequality.js';

const services = [
  { id: 'tiktok', name: 'TikTok', status: '解锁', region: 'DE', method: '原生' },
  { id: 'netflix', name: 'Netflix', status: '仅自制', region: 'DE', method: '原生' },
  { id: 'reddit', name: 'Reddit', status: '屏蔽', region: '', method: '' },
];

const unlockHtml = renderUnlockServicesReportHtml(services);
assert.match(unlockHtml, /nq-media-grid[\s\S]*nq-media-badge success[\s\S]*nq-media-badge danger/, 'IP unlock task services must render as the NodeQuality IP-quality media grid');
assert.match(unlockHtml, /nq-media-label">地区<\/span>[\s\S]*\[DE\][\s\S]*\[\]/, 'IP unlock regions must keep the NodeQuality bracketed column format');
assert.equal(renderUnlockServicesReportHtml([]), '', 'empty IP unlock results must not render an empty terminal block');
assert.equal(renderUnlockServicesReportHtml(null), '', 'missing IP unlock results must not render an empty terminal block');
assert.match(renderNqReportHtml('五、流媒体服务解锁检测\n服务商： TikTok Netflix\n状态： 解锁 失败\n地区： [TW] []\n方式： DNS'), /nq-media-grid/, 'media blocks at end-of-report must still render as the NodeQuality grid');
assert.match(renderNqReportHtml('五、流媒体及AI服务解锁检测\n服务商： TikTok Disney+\n状态： 解锁 屏蔽\n地区： [DE] []\n方式： 原生 —'), /nq-media-grid/, 'the pinned IPQuality media heading must render as the NodeQuality grid');
const fullReport = [
  '一、基础信息（Maxmind 数据库）',
  '自治系统号：            AS35916',
  '五、流媒体及AI服务解锁检测',
  '服务商： TikTok Disney+ Netflix',
  '状态： 解锁 屏蔽 仅自制',
  '地区： [DE] [] [US]',
  '方式： 原生 — 原生',
  '六、邮局连通性及黑名单检测',
  '本地25端口出站：可用',
  '报告链接：https://Report.Check.Place/ip/example.svg',
].join('\n');
const fullReportHtml = renderNqReportHtml(fullReport);
assert.match(fullReportHtml, /基础信息（Maxmind 数据库）/, 'full IPQuality reports must keep non-media terminal sections');
assert.match(fullReportHtml, /nq-media-grid/, 'full IPQuality reports must turn the media section into the NodeQuality grid');
assert.match(fullReportHtml, /邮局连通性及黑名单检测/, 'full IPQuality reports must keep the mail/blacklist section');
assert.match(buildNqModalHtml({ name: 'vps-a', tabs: [{ id: 'ip', title: 'IP质量', content: '' }] }, { title: 'IP 解锁' }), /<strong>IP 解锁<\/strong>/, 'admin IP unlock details must reuse the NQ dialog shell with an accurate title');
assert.match(buildNqModalHtml({ name: 'vps-a', tabs: [] }), /<strong>NodeQuality<\/strong>/, 'public NodeQuality dialogs must keep the original default title');

const adminSource = readFileSync(new URL('../js/admin.js', import.meta.url), 'utf8');
const adminCss = readFileSync(new URL('../admin.css', import.meta.url), 'utf8');
assert.match(adminSource, /task\.action === "ip_unlock"[\s\S]*showIpUnlockTaskReport/, 'IP unlock task details must open the structured report dialog');
assert.match(adminSource, /function showIpUnlockTaskReport[\s\S]*renderUnlockServicesReportHtml\(services\)[\s\S]*buildNqModalHtml\(report,\s*\{\s*title:\s*"IP 解锁"\s*\}\)/, 'IP unlock task details must render the structured NQ-style dialog');
assert.match(adminSource, /task\?\.result\?\.report[\s\S]*report\.tabs\[0\]\.content = reportText[\s\S]*buildNqModalHtml/, 'full IPQuality reports must be placed into the IP-quality tab content');
assert.match(adminSource, /task\.error[\s\S]*ip-unlock-raw[\s\S]*原始输出/, 'IP unlock failures must keep the raw output available but collapsed');
assert.match(adminCss, /\.ip-unlock-raw\s*\{/, 'admin must style the collapsed IP unlock raw output');

console.log('IP unlock structured report ok');
