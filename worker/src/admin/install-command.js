// Admin sub-module: agent install command generation.
import { clamp, sanitizeAgentId } from '../utils.js';
import { agentScopedToken } from '../auth.js';

export async function getAgentInstallCommand(env, url, request = null) {
  const globalAgentToken = String(env.AGENT_TOKEN || '').trim();
  if (!globalAgentToken) return { ok: false, error: 'Worker 尚未配置 AGENT_TOKEN' };

  const targetId = sanitizeAgentId(url.searchParams.get('target_id') || '');
  if (!targetId) return { ok: false, error: '必须提供 target_id' };

  const target = await env.DB.prepare(`SELECT id, name FROM targets WHERE id = ?`).bind(targetId).first().catch(() => null);
  const label = String(target?.name || targetId).trim() || targetId;
  const agentToken = await agentScopedToken(env, targetId);
  if (!agentToken) return { ok: false, error: '生成 Agent 专用 Token 失败' };
  const installBase = agentInstallBase(env, request);
  if (!installBase) return { ok: false, error: 'Agent 安装地址不可用。请从公开前端域名打开管理后台，或配置 PUBLIC_AGENT_INSTALL_BASE。' };
  const apiBase = agentApiBase(env, request, url, installBase);
  const pingSec = String(clamp(Number(env.NSTATUS_PING_SEC || env.AGENT_PING_SEC || 20), 5, 600));
  const sha256SumsSha256 = String(env.NSTATUS_SHA256SUMS_SHA256 || '').trim();
  const expectedVersion = String(env.AGENT_LATEST_VERSION || 'v1.0.16').trim();

  const linuxEnvNames = [
    'NSTATUS_AGENT_BASE_URL',
    'DOWNLOAD_BASE',
    'CFTZ_URL_BASE',
    'NSTATUS_API_BASE',
    'NSTATUS_AGENT_TOKEN',
    'NSTATUS_AGENT_ID',
    'NSTATUS_AGENT_LABEL',
    'NSTATUS_PING_SEC',
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
    linuxRunner,
  ].join(' && ');

  const windowsCommand = [
    `$env:NSTATUS_API_BASE=${psQuote(apiBase)}`,
    `$env:NSTATUS_AGENT_TOKEN=${psQuote(agentToken)}`,
    `$env:NSTATUS_AGENT_ID=${psQuote(targetId)}`,
    `$env:NSTATUS_AGENT_LABEL=${psQuote(label)}`,
    `$env:NSTATUS_PING_SEC=${psQuote(pingSec)}`,
    `$env:DOWNLOAD_BASE=${psQuote(installBase)}`,
    `$env:NSTATUS_SHA256SUMS_SHA256=${psQuote(sha256SumsSha256)}`,
    `$env:NSTATUS_EXPECTED_VERSION=${psQuote(expectedVersion)}`,
    `$installer=Join-Path $env:TEMP 'nstatus-install.ps1'`,
    `Invoke-WebRequest -UseBasicParsing ${psQuote(`${installBase}/install.ps1?v=${encodeURIComponent(sha256SumsSha256)}`)} -OutFile $installer`,
    `powershell -ExecutionPolicy RemoteSigned -File $installer`,
    `Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue`,
  ].join('; ');

  return {
    ok: true,
    target_id: targetId,
    target_label: label,
    api_base: apiBase,
    install_base: installBase,
    linux_command: linuxCommand,
    windows_command: windowsCommand,
  };
}

function agentApiBase(env, request = null, url = null, installBase = '') {
  const explicit = String(env.PUBLIC_AGENT_API_BASE || env.AGENT_API_BASE || env.PUBLIC_API_BASE || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const publicOrigin = publicRequestOrigin(request);
  if (publicOrigin) return publicOrigin.replace(/\/+$/, '');

  const workerUrl = String(env.PUBLIC_WORKER_URL || '').trim();
  if (workerUrl) return workerUrl.replace(/\/+$/, '');

  if (installBase) return installBase.replace(/\/+$/, '');
  return String(url ? `${url.protocol}//${url.host}` : '').replace(/\/+$/, '');
}

function agentInstallBase(env, request = null) {
  const explicit = String(env.PUBLIC_AGENT_INSTALL_BASE || env.AGENT_INSTALL_BASE || '').trim();
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

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function psQuote(value) {
  return `"${String(value ?? '').replace(/`/g, '``').replace(/"/g, '`"')}"`;
}
