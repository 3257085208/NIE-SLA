import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildNqModalHtml, renderNqReportHtml, renderUnlockServicesReportHtml, trimReportAdFooter } from '../js/shared/nodequality.js';

const services = [
  { id: 'tiktok', name: 'TikTok', status: '解锁', region: 'DE', method: '原生' },
  { id: 'netflix', name: 'Netflix', status: '仅自制', region: 'DE', method: '原生' },
  { id: 'reddit', name: 'Reddit', status: '屏蔽', region: '', method: '' },
  { id: 'chatgpt', name: 'ChatGPT', status: '解锁', region: 'US', method: 'DNS' },
];

const unlockHtml = renderUnlockServicesReportHtml(services);
assert.match(unlockHtml, /nq-media-grid[\s\S]*nq-media-badge success[\s\S]*nq-media-badge danger/, 'IP unlock task services must render as the NodeQuality IP-quality media grid');
const unlockBadges = [...unlockHtml.matchAll(/nq-media-badge ([a-z]+)">([^<]+)</g)].map(match => `${match[1]}:${match[2]}`);
assert.ok(unlockBadges.includes('warning:仅自制'), '仅自制 must render with the yellow warning state');
assert.equal(unlockBadges.at(-1), 'success:解锁', 'ChatGPT DNS unlock must stay green when the source status is 解锁');
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
assert.match(adminSource, /trimReportAdFooter\(task\.result\.report\)/, 'full IPQuality reports must strip sponsor ads before rendering in the admin dialog');
assert.match(adminSource, /task\.error[\s\S]*ip-unlock-raw[\s\S]*原始输出/, 'IP unlock failures must keep the raw output available but collapsed');
const adReport = 'IP 质量体检报告：117.55.*.*\n五、流媒体解锁检测\n========================================================================\n今日IP检测量：1；总检测量：2。感谢使用xy系列脚本！\nTERM environment variable not set.\nSPONSORSPONSORSPONSOR\nIPWOIPWOIPWO https://www.ipwo.net/\n';
const trimmedAdReport = trimReportAdFooter(adReport);
assert.equal(trimmedAdReport, 'IP 质量体检报告：117.55.*.*\n五、流媒体解锁检测\n========================================================================\n今日IP检测量：1；总检测量：2。感谢使用xy系列脚本！\n');
assert.doesNotMatch(trimmedAdReport, /SPONSOR|IPWO|TERM environment/, 'IP unlock reports must strip sponsor advertisements before rendering');
assert.equal(trimReportAdFooter('IP 质量体检报告\n五、流媒体解锁检测\nNEWSPONSORBANNER\nhttps://example.com/ad\n'), 'IP 质量体检报告\n五、流媒体解锁检测\n');
assert.equal(trimReportAdFooter('IP 质量体检报告'), 'IP 质量体检报告');
const ansiAdReport = '\u001b[36mIP 质量体检报告：117.55.*.*\u001b[0m\n\u001b[36m今日IP检测量：1；总检测量：2。感谢使用xy系列脚本！\u001b[0m\nTERM environment variable not set.\nSPONSORSPONSORSPONSOR\n';
const trimmedAnsiAdReport = trimReportAdFooter(ansiAdReport);
assert.match(trimmedAnsiAdReport, /今日IP检测量/, 'ANSI-colored report tails must still be detected');
assert.doesNotMatch(trimmedAnsiAdReport, /SPONSOR|TERM environment/, 'ANSI-colored ad footers must still be stripped');

assert.match(adminCss, /\.ip-unlock-raw\s*\{/, 'admin must style the collapsed IP unlock raw output');

console.log('IP unlock structured report ok');
