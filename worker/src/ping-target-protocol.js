import { ApiError } from './auth.js';

export const PING_PROTOCOLS = Object.freeze(['tcp', 'http', 'icmp']);

export function normalizePingTarget(value) {
  const target = String(value || '').trim();
  if (!target || target.length > 2048) throw new ApiError(400, 'Ping 目标无效');

  if (/^https?:\/\//i.test(target)) {
    const url = parseTargetUrl(target, ['http:', 'https:']);
    if (!url.hostname) throw new ApiError(400, 'HTTP Ping 目标缺少主机名');
    return { target: target.replace(/^https?:/i, url.protocol), protocol: 'http' };
  }

  if (/^icmp:\/\//i.test(target)) {
    const url = parseTargetUrl(target, ['icmp:']);
    if (!url.hostname || url.port || !['', '/'].includes(url.pathname) || url.search || url.hash) {
      throw new ApiError(400, 'ICMP Ping 目标必须使用 icmp://主机');
    }
    return { target: target.replace(/^icmp:/i, 'icmp:'), protocol: 'icmp' };
  }

  if (/^tcp:\/\//i.test(target)) {
    const url = parseTargetUrl(target, ['tcp:']);
    if (!url.hostname || !validPort(url.port) || !['', '/'].includes(url.pathname) || url.search || url.hash) {
      throw new ApiError(400, 'TCP Ping 目标必须使用 tcp://主机:端口');
    }
    return { target: target.replace(/^tcp:/i, 'tcp:'), protocol: 'tcp' };
  }

  if (!validTcpAuthority(target)) throw new ApiError(400, 'TCP Ping 目标必须使用 主机:端口');
  return { target, protocol: 'tcp' };
}

export function pingTargetProtocol(value) {
  try { return normalizePingTarget(value).protocol; } catch (_) { return 'tcp'; }
}

export function normalizeProbeProtocols(value) {
  const requested = new Set(String(value || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean));
  return PING_PROTOCOLS.filter(protocol => requested.has(protocol));
}

function parseTargetUrl(value, protocols) {
  let url;
  try { url = new URL(value); } catch (_) { throw new ApiError(400, 'Ping 目标 URL 无效'); }
  if (!protocols.includes(url.protocol)) throw new ApiError(400, 'Ping 目标协议无效');
  if (url.username || url.password) throw new ApiError(400, 'Ping 目标不能包含用户名或密码');
  return url;
}

function validTcpAuthority(value) {
  const match = String(value).match(/^(?:\[[0-9a-f:.]+\]|[^\s:/?#]+):(\d{1,5})$/i);
  return Boolean(match && validPort(match[1]));
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
