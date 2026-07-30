// Admin sub-module: agent install command generation.
import { ApiError } from '../auth.js';
import { clamp, sanitizeAgentId, sha256Hex } from '../utils.js';
import { getOrCreateAgentToken } from '../agent-credentials.js';
import { loadAgentRelease } from './settings.js';
import { getPingIntervalSec, MAX_PING_INTERVAL_SEC, MIN_PING_INTERVAL_SEC } from '../ping-config.js';

const INSTALLER_SHA256 = '091fe6df9933ab0a9e7c3c0f1a622131df63efe4c1df96da7ff45be05ed80310';
const SETUP_SHA256 = '79b201bafa2a25c2410549253112f19ab17e38fd01c70343581a80d9ea082b5c';
const CFTZ_SHA256 = '8f027ec78ac80e74567803566aafca4748161f4fe775adedefdc722fbce2341d';
const INSTALL_TICKET_PREFIX = 'nsi_';
const INSTALL_TICKET_BYTES = 24;
const INSTALL_TICKET_TTL_SEC = 600;
const INSTALL_SCRIPT_PATH = '/api/agent/install-script';

export async function getAgentInstallCommand(env, url, request = null) {
  const targetId = sanitizeAgentId(url.searchParams.get('target_id') || '');
  if (!targetId) return { ok: false, error: '必须提供 target_id' };

  const target = await env.DB.prepare(`SELECT id, name FROM targets WHERE id = ?`).bind(targetId).first().catch(() => null);
  if (!target) return { ok: false, error: 'Agent 目标不存在' };
  const label = String(target?.name || targetId).trim() || targetId;
  const agentToken = await getOrCreateAgentToken(env, 'agent', targetId);
  if (!agentToken) return { ok: false, error: '生成 Agent 专用 Token 失败' };
  const installBase = agentInstallBase(env, request);
  if (!installBase) return { ok: false, error: 'Agent 安装地址不可用。请从公开前端域名打开管理后台，或配置 PUBLIC_AGENT_INSTALL_BASE。' };
  const apiBase = agentApiBase(env, request, url, installBase);
  const pingSec = String(await getPingIntervalSec(env));
  const release = await loadAgentRelease(env, request).catch(() => null);
  const sha256SumsSha256 = String(env.NSTATUS_SHA256SUMS_SHA256 || '').trim() || String(release?.manifest_sha256 || '').trim();
  const expectedVersion = String(env.AGENT_LATEST_VERSION || '').trim() || String(release?.latest_version || '').trim();
  const installTicket = randomInstallTicket();
  const now = nowSec();
  const expiresAt = now + INSTALL_TICKET_TTL_SEC;
  await env.DB.prepare(`INSERT INTO agent_install_tickets
    (token_hash, target_id, install_base, api_base, target_label, ping_sec, manifest_sha256, expected_version, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      await sha256Hex(installTicket), targetId, installBase, apiBase, label, Number(pingSec),
      sha256SumsSha256, expectedVersion, now, expiresAt,
    )
    .run();
  await cleanupInstallTickets(env, now);

  const linuxCommand = `(t=$(mktemp) && trap 'rm -f "$t"' EXIT INT TERM && chmod 0600 "$t" && curl -fsSL -H ${shellQuote(`Authorization: Bearer ${installTicket}`)} ${shellQuote(`${apiBase}${INSTALL_SCRIPT_PATH}`)} -o "$t" && sh "$t")`;

  return {
    ok: true,
    target_id: targetId,
    target_label: label,
    api_base: apiBase,
    install_base: installBase,
    credential_bound: true,
    credential_type: 'one_time_install_token',
    install_token_expires_at: expiresAt,
    linux_command: linuxCommand,
  };
}

export async function getAgentInstallScript(env, request) {
  const ticket = bearerToken(request);
  if (!new RegExp(`^${INSTALL_TICKET_PREFIX}[a-f0-9]{${INSTALL_TICKET_BYTES * 2}}$`).test(ticket)) {
    throw new ApiError(401, '安装凭据无效、已过期或已使用');
  }

  const now = nowSec();
  const row = await env.DB.prepare(`UPDATE agent_install_tickets SET used_at = ?
    WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?
    RETURNING target_id, install_base, api_base, target_label, ping_sec, manifest_sha256, expected_version`)
    .bind(now, await sha256Hex(ticket), now)
    .first()
    .catch(() => null);
  if (!row?.target_id) throw new ApiError(401, '安装凭据无效、已过期或已使用');

  const targetId = sanitizeAgentId(row.target_id);
  const target = targetId
    ? await env.DB.prepare(`SELECT id FROM targets WHERE id = ?`).bind(targetId).first().catch(() => null)
    : null;
  if (!target) throw new ApiError(410, 'Agent 目标已不存在，请重新生成安装命令');

  const agentToken = await getOrCreateAgentToken(env, 'agent', targetId);
  if (!agentToken) throw new ApiError(500, '无法读取 Agent 专用 Token');

  const script = buildAgentInstallScript({
    installBase: row.install_base,
    apiBase: row.api_base,
    agentToken,
    targetId,
    label: row.target_label,
    pingSec: row.ping_sec,
    sha256SumsSha256: row.manifest_sha256,
    expectedVersion: row.expected_version,
  });
  return new Response(script, {
    status: 200,
    headers: {
      'cache-control': 'no-store, max-age=0',
      'content-type': 'text/x-shellscript; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}

function buildAgentInstallScript(config) {
  const linuxEnv = [
    ['NSTATUS_AGENT_BASE_URL', config.installBase],
    ['DOWNLOAD_BASE', config.installBase],
    ['CFTZ_URL_BASE', config.installBase],
    ['NSTATUS_API_BASE', config.apiBase],
    ['NSTATUS_AGENT_TOKEN', config.agentToken],
    ['NSTATUS_AGENT_ID', config.targetId],
    ['NSTATUS_AGENT_LABEL', config.label],
    ['NSTATUS_PING_SEC', String(clamp(Number(config.pingSec || 20), MIN_PING_INTERVAL_SEC, MAX_PING_INTERVAL_SEC))],
    ['NSTATUS_INSTALLER_SHA256', INSTALLER_SHA256],
    ['NSTATUS_SETUP_SHA256', SETUP_SHA256],
    ['NSTATUS_CFTZ_SHA256', CFTZ_SHA256],
    ['NSTATUS_SHA256SUMS_SHA256', config.sha256SumsSha256],
    ['NSTATUS_EXPECTED_VERSION', config.expectedVersion],
  ];
  const linuxEnvNames = linuxEnv.map(([key]) => key);
  const preserveEnv = linuxEnvNames.join(',');
  return [
    '#!/bin/sh',
    'set -eu',
    ...linuxEnv.map(([key, value]) => `${key}=${shellQuote(value)}`),
    `export ${linuxEnvNames.join(' ')}`,
    'tmp=$(mktemp)',
    'chmod 0600 "$tmp"',
    `trap 'rm -f "$tmp"' EXIT INT TERM`,
    `curl -fsSL ${shellQuote(`${config.installBase}/install.sh?v=${encodeURIComponent(config.sha256SumsSha256)}`)} -o "$tmp"`,
    `actual=$(if command -v sha256sum >/dev/null 2>&1; then sha256sum "$tmp" | awk '{print $1}'; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$tmp" | awk '{print $1}'; elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$tmp" | awk '{print $NF}'; else exit 127; fi)`,
    '[ "$actual" = "$NSTATUS_INSTALLER_SHA256" ]',
    `if [ "$(id -u)" -eq 0 ]; then sh "$tmp" --non-interactive; else sudo --preserve-env=${preserveEnv} sh "$tmp" --non-interactive; fi`,
    '',
  ].join('\n');
}

async function cleanupInstallTickets(env, now) {
  await env.DB.prepare(`DELETE FROM agent_install_tickets
    WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)`)
    .bind(now - 3600, now - 3600)
    .run()
    .catch(() => {});
}

function randomInstallTicket() {
  const bytes = crypto.getRandomValues(new Uint8Array(INSTALL_TICKET_BYTES));
  return INSTALL_TICKET_PREFIX + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function bearerToken(request) {
  const match = String(request?.headers?.get?.('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return String(match?.[1] || '').trim();
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function agentApiBase(env, request = null, url = null, installBase = '') {
  const explicit = String(env.PUBLIC_AGENT_API_BASE || env.AGENT_API_BASE || env.PUBLIC_API_BASE || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const publicOrigin = publicRequestOrigin(request);
  if (publicOrigin) return publicOrigin.replace(/\/+$/, '');

  const workerUrl = String(env.PUBLIC_WORKER_URL || '').trim();
  if (workerUrl) return workerUrl.replace(/\/+$/, '');

  if (installBase) return installBase.replace(/\/+$/, '');
  return String(url ? `${url.protocol}//${url.host}` : '').replace(/\/+$/, '');
}

export function agentInstallBase(env, request = null) {
  const explicit = String(
    env.PUBLIC_AGENT_INSTALL_BASE
      || env.AGENT_INSTALL_BASE
      || env.PUBLIC_SITE_ORIGIN
      || '',
  ).trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const origin = publicRequestOrigin(request);
  return origin ? origin.replace(/\/+$/, '') : '';
}

function publicRequestOrigin(request = null) {
  const origin = String(request?.headers?.get?.('origin') || '').trim();
  if (isPublicHttpOrigin(origin)) return origin;

  const referer = String(request?.headers?.get?.('referer') || '').trim();
  try {
    const u = new URL(referer);
    const value = `${u.protocol}//${u.host}`;
    if (isPublicHttpOrigin(value)) return value;
  } catch (_) {}

  return '';
}

function isPublicHttpOrigin(value) {
  try {
    const u = new URL(String(value || ''));
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
  } catch (_) {
    return false;
  }
}

export function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}
