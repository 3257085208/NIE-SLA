// Admin sub-module: agent install command generation.
import { clamp, sanitizeAgentId } from '../utils.js';
import { getOrCreateAgentToken } from '../agent-credentials.js';
import { loadAgentRelease } from './settings.js';

const INSTALLER_SHA256 = '419b9a8665a1ed93c996492379a510247840555b6a60f2ca9deab1c8d8073f0f';
const SETUP_SHA256 = '1b9f78834b203d5b19e9efde39077537c73cb2b21a0f9f6c85ec4fac5c62b17c';
const CFTZ_SHA256 = 'a65e790a8d125aa1a4b68015e24f985ea52c2a456e1232e98637c64b1a8b8758';

export async function getAgentInstallCommand(env, url, request = null) {
  const targetId = sanitizeAgentId(url.searchParams.get('target_id') || '');
  if (!targetId) return { ok: false, error: '必须提供 target_id' };

  const target = await env.DB.prepare(`SELECT id, name FROM targets WHERE id = ?`).bind(targetId).first().catch(() => null);
  const label = String(target?.name || targetId).trim() || targetId;
  const agentToken = await getOrCreateAgentToken(env, 'agent', targetId);
  if (!agentToken) return { ok: false, error: '生成 Agent 专用 Token 失败' };
  const installBase = agentInstallBase(env, request);
  if (!installBase) return { ok: false, error: 'Agent 安装地址不可用。请从公开前端域名打开管理后台，或配置 PUBLIC_AGENT_INSTALL_BASE。' };
  const apiBase = agentApiBase(env, request, url, installBase);
  const pingSec = String(clamp(Number(env.NSTATUS_PING_SEC || env.AGENT_PING_SEC || 20), 5, 600));
  const release = await loadAgentRelease(env, request).catch(() => null);
  const sha256SumsSha256 = String(env.NSTATUS_SHA256SUMS_SHA256 || '').trim() || String(release?.manifest_sha256 || '').trim();
  const expectedVersion = String(env.AGENT_LATEST_VERSION || '').trim() || String(release?.latest_version || '').trim();

  const linuxEnvNames = [
    'NSTATUS_AGENT_BASE_URL',
    'DOWNLOAD_BASE',
    'CFTZ_URL_BASE',
    'NSTATUS_API_BASE',
    'NSTATUS_AGENT_TOKEN',
    'NSTATUS_AGENT_ID',
    'NSTATUS_AGENT_LABEL',
    'NSTATUS_PING_SEC',
    'NSTATUS_INSTALLER_SHA256',
    'NSTATUS_SETUP_SHA256',
    'NSTATUS_CFTZ_SHA256',
    'NSTATUS_SHA256SUMS_SHA256',
    'NSTATUS_EXPECTED_VERSION',
  ];
  const linuxEnv = [
    ['NSTATUS_AGENT_BASE_URL', installBase],
    ['DOWNLOAD_BASE', installBase],
    ['CFTZ_URL_BASE', installBase],
    ['NSTATUS_API_BASE', apiBase],
    ['NSTATUS_AGENT_TOKEN', agentToken],
    ['NSTATUS_AGENT_ID', targetId],
    ['NSTATUS_AGENT_LABEL', label],
    ['NSTATUS_PING_SEC', pingSec],
    ['NSTATUS_INSTALLER_SHA256', INSTALLER_SHA256],
    ['NSTATUS_SETUP_SHA256', SETUP_SHA256],
    ['NSTATUS_CFTZ_SHA256', CFTZ_SHA256],
    ['NSTATUS_SHA256SUMS_SHA256', sha256SumsSha256],
    ['NSTATUS_EXPECTED_VERSION', expectedVersion],
  ].map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
  const linuxPreserveEnv = linuxEnvNames.join(',');
  const linuxRunner = `(if [ "$(id -u)" -eq 0 ]; then sh "$tmp" --non-interactive; else sudo --preserve-env=${linuxPreserveEnv} sh "$tmp" --non-interactive; fi)`;
  const linuxCommand = [
    `${linuxEnv}; export ${linuxEnvNames.join(' ')}`,
    `tmp=$(mktemp)`,
    `trap 'rm -f "$tmp"' EXIT`,
    `curl -fsSL ${shellQuote(`${installBase}/install.sh?v=${encodeURIComponent(sha256SumsSha256)}`)} -o "$tmp"`,
    `actual=$(if command -v sha256sum >/dev/null 2>&1; then sha256sum "$tmp" | awk '{print $1}'; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$tmp" | awk '{print $1}'; elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$tmp" | awk '{print $NF}'; else exit 127; fi)`,
    `[ "$actual" = "$NSTATUS_INSTALLER_SHA256" ]`,
    linuxRunner,
  ].join(' && ');

  return {
    ok: true,
    target_id: targetId,
    target_label: label,
    api_base: apiBase,
    install_base: installBase,
    linux_command: linuxCommand,
  };
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
