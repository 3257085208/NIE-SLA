const MAX_LINK_BYTES = 64 * 1024;
const MAX_ITEMS = 50;
const DEFAULT_PORTS = {
  socks5: 1080,
  http: 8080,
  ss: 8388,
  snell: 443,
  vless: 443,
  vmess: 443,
  trojan: 443,
  hysteria2: 443,
  anytls: 443,
  tuic: 443,
};
const KNOWN_SCHEMES = new Set(['socks', 'socks5', 'http', 'https', 'ss', 'ssr', 'vless', 'vmess', 'trojan', 'hysteria2', 'hy2', 'snell', 'anytls', 'tuic']);
const RUNTIME_PROTOCOLS = new Set(['socks5', 'http', 'ss', 'vless', 'vmess', 'trojan', 'hysteria2', 'snell', 'anytls']);
const TRANSPORTS = new Set(['tcp', 'tls', 'ws', 'tls-ws', 'grpc', 'tls-grpc', 'h2', 'tls-h2', 'httpupgrade', 'tls-httpupgrade', 'quic']);

export function parseProxyLinks(raw, { maxItems = MAX_ITEMS } = {}) {
  const text = String(raw ?? '').trim();
  if (!text || text.length > MAX_LINK_BYTES) throw new Error('代理链接为空或超过 64 KiB');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error('代理链接包含不允许的控制字符');
  const candidates = expandCandidates(text).slice(0, maxItems);
  if (!candidates.length) throw new Error('未找到可识别的代理分享链接');
  const parsed = [];
  for (const candidate of candidates) {
    try { parsed.push(parseOne(candidate)); }
    catch (_) { /* A pasted subscription may contain unrelated lines. */ }
  }
  if (!parsed.length) throw new Error('代理分享链接格式无法识别');
  return parsed;
}

export function proxyLinkPreview(item) {
  return {
    name: item.name,
    protocol: item.protocol,
    server: item.server,
    port: item.port,
    transport: item.transport,
    sni: item.sni,
    ws_path: item.ws_path,
    ws_host: item.ws_host,
    runtime_supported: Boolean(item.runtime_supported),
  };
}

export function isRuntimeProxyProtocol(protocol) {
  return RUNTIME_PROTOCOLS.has(String(protocol || '').toLowerCase());
}

export function isRuntimeProxyTargetSupported(protocol, transport) {
  const normalizedProtocol = String(protocol || '').toLowerCase();
  const normalizedTransport = String(transport || '').toLowerCase();
  if (!RUNTIME_PROTOCOLS.has(normalizedProtocol)) return false;
  if (['socks5', 'http', 'ss', 'snell', 'trojan', 'anytls'].includes(normalizedProtocol)) {
    return ['tcp', 'tls'].includes(normalizedTransport);
  }
  if (normalizedProtocol === 'hysteria2') return normalizedTransport === 'quic';
  return normalizedTransport !== 'quic';
}

function expandCandidates(text) {
  const direct = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const output = [];
  const addDecoded = (value) => {
    const decoded = decodeBase64(value);
    if (!decoded) return false;
    const nested = expandStructuredText(decoded);
    if (nested.length) output.push(...nested);
    else if (hasKnownScheme(decoded)) output.push(...decoded.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
    return nested.length > 0 || hasKnownScheme(decoded);
  };
  for (const line of direct) {
    if (hasKnownScheme(line)) output.push(line);
    else if (line.startsWith('{') || line.startsWith('[')) output.push(...expandStructuredText(line));
    else addDecoded(line);
  }
  if (!output.length) {
    const structured = expandStructuredText(text);
    if (structured.length) output.push(...structured);
    else if (hasKnownScheme(text)) output.push(text);
    else addDecoded(text);
  }
  return [...new Set(output)].slice(0, MAX_ITEMS);
}

function expandStructuredText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  try {
    const value = JSON.parse(trimmed);
    const nodes = Array.isArray(value) ? value : (Array.isArray(value.proxies) ? value.proxies : (Array.isArray(value.outbounds) ? value.outbounds : []));
    return nodes.flatMap(node => proxyObjectToLink(node)).filter(Boolean);
  } catch (_) {}
  return parseSimpleClashYaml(trimmed);
}

function proxyObjectToLink(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return '';
  const type = String(node.type || '').trim().toLowerCase();
  if (!type || !node.server || !node.port) return '';
  if (type === 'ss' || type === 'shadowsocks') {
    const cipher = String(node.cipher || node.method || '').trim();
    const password = String(node.password || '').trim();
    if (!cipher || !password) return '';
    return `ss://${encodeURIComponent(cipher)}:${encodeURIComponent(password)}@${node.server}:${node.port}#${encodeURIComponent(String(node.name || type))}`;
  }
  const query = new URLSearchParams();
  const network = String(node.network || node.net || '').trim().toLowerCase();
  const tls = node.tls === true || String(node.security || '').toLowerCase() === 'tls';
  if (network) query.set('type', network === 'websocket' ? 'ws' : network);
  if (tls) query.set('security', 'tls');
  if (node.sni || node.servername) query.set('sni', String(node.sni || node.servername));
  const wsOpts = node['ws-opts'] && typeof node['ws-opts'] === 'object' ? node['ws-opts'] : {};
  if (wsOpts.path || node.path) query.set('path', String(wsOpts.path || node.path));
  const headers = wsOpts.headers && typeof wsOpts.headers === 'object' ? wsOpts.headers : {};
  if (headers.Host || headers.host || node.host) query.set('host', String(headers.Host || headers.host || node.host));
  const user = node.uuid || node.username || '';
  const password = node.password || '';
  const authority = `${encodeURIComponent(String(user))}${password ? `:${encodeURIComponent(String(password))}` : ''}@${node.server}:${node.port}`;
  return `${type}://${authority}${query.size ? `?${query}` : ''}#${encodeURIComponent(String(node.name || type))}`;
}

function parseSimpleClashYaml(text) {
  if (!/^\s*proxies\s*:\s*$/m.test(text)) return [];
  const out = [];
  let current = null;
  let nested = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, '    ');
    const item = line.match(/^\s*-\s*([^:]+):\s*(.*)$/);
    if (item) {
      if (current) out.push(current);
      current = {};
      nested = '';
      setYamlValue(current, item[1], item[2]);
      continue;
    }
    if (!current) continue;
    const key = line.match(/^\s{2,}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!key) continue;
    if (key[2] === '') { nested = key[1]; continue; }
    if (nested === 'ws-opts') current['ws-opts'] ||= {};
    setYamlValue(nested === 'ws-opts' ? current['ws-opts'] : current, key[1], key[2]);
  }
  if (current) out.push(current);
  return out.map(proxyObjectToLink).filter(Boolean);
}

function setYamlValue(target, key, raw) {
  const value = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
  if (!value) return;
  if (/^(true|false)$/i.test(value)) target[key] = value.toLowerCase() === 'true';
  else if (/^\d+$/.test(value)) target[key] = Number(value);
  else target[key] = value;
}

function parseOne(raw) {
  const value = String(raw || '').trim();
  const scheme = value.slice(0, value.indexOf(':')).toLowerCase();
  if (!KNOWN_SCHEMES.has(scheme)) throw new Error('unsupported scheme');
  if (scheme === 'vmess') return parseVmess(value);
  if (scheme === 'ss') return parseShadowsocks(value);
  if (scheme === 'ssr') return parseSsr(value);
  const url = safeUrl(value);
  const protocol = scheme === 'socks' ? 'socks5' : (scheme === 'hy2' ? 'hysteria2' : (scheme === 'https' ? 'http' : scheme));
  if (protocol === 'http' || protocol === 'socks5') return parseBasicProxy(url, protocol);
  if (protocol === 'vless') return parseVless(url);
  if (protocol === 'trojan') return parseTrojan(url);
  if (protocol === 'hysteria2') return parseHysteria2(url);
  if (protocol === 'snell') return parseSnell(url);
  if (protocol === 'anytls') return parseAnytls(url);
  if (protocol === 'tuic') return parseTuic(url);
  throw new Error('unsupported scheme');
}

function parseBasicProxy(url, protocol) {
  const transport = url.protocol === 'https:' ? 'tls' : 'tcp';
  return finish({
    name: linkName(url, protocol), protocol, server: url.hostname, port: linkPort(url, protocol), transport,
    sni: url.hostname, ws_path: '/', ws_host: url.hostname,
    secret: { username: decodePart(url.username), password: decodePart(url.password) },
  });
}

function parseVless(url) {
  const query = url.searchParams;
  const transport = transportName(query.get('type') || query.get('net') || 'tcp', query.get('security') || '');
  return finish({
    name: linkName(url, 'vless'), protocol: 'vless', server: url.hostname, port: linkPort(url, 'vless'), transport,
    sni: query.get('sni') || query.get('servername') || url.hostname,
    ws_path: query.get('path') || '/', ws_host: query.get('host') || query.get('authority') || query.get('sni') || url.hostname,
    secret: { uuid: decodePart(url.username), flow: query.get('flow') || '', encryption: query.get('encryption') || 'none', security: query.get('security') || '' , grpc_service_name: query.get('serviceName') || query.get('serviceName'.toLowerCase()) || '', h2_path: query.get('path') || '' },
  });
}

function parseVmess(value) {
  const fragmentAt = value.indexOf('#');
  const encoded = value.slice(value.indexOf('://') + 3, fragmentAt >= 0 ? fragmentAt : undefined).replace(/\s/g, '');
  const json = decodeBase64(encoded);
  if (!json) throw new Error('invalid vmess payload');
  let config;
  try { config = JSON.parse(json); } catch (_) { throw new Error('invalid vmess payload'); }
  const server = String(config.add || config.address || '').trim();
  const port = Number(config.port || 443);
  if (!server || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid vmess endpoint');
  const type = String(config.net || config.network || 'tcp').toLowerCase();
  const security = String(config.tls || config.security || '').toLowerCase();
  const transport = transportName(type, security);
  const label = fragmentAt >= 0 ? decodePart(value.slice(fragmentAt + 1)) : String(config.ps || 'VMess');
  return finish({
    name: cleanName(label, 'vmess'), protocol: 'vmess', server, port, transport,
    sni: String(config.sni || config.host || server), ws_path: String(config.path || '/'), ws_host: String(config.host || config.sni || server),
    secret: { uuid: String(config.id || ''), security: String(config.scy || 'auto').toLowerCase(), alter_id: Number(config.aid || 0), grpc_service_name: String(config.path || ''), h2_path: String(config.path || ''), encryption: security },
  });
}

function parseShadowsocks(value) {
  const raw = String(value || '').trim();
  const payload = raw.slice(raw.indexOf('://') + 3);
  const fragmentIndex = payload.indexOf('#');
  const fragment = fragmentIndex >= 0 ? payload.slice(fragmentIndex) : '';
  const withoutFragment = fragmentIndex >= 0 ? payload.slice(0, fragmentIndex) : payload;
  const atIndex = withoutFragment.lastIndexOf('@');
  let normalized = raw;
  if (atIndex < 0) {
    const decoded = decodeBase64(withoutFragment);
    if (decoded && decoded.includes('@')) normalized = `ss://${decoded}${fragment}`;
  } else if (!withoutFragment.slice(0, atIndex).includes(':')) {
    const decoded = decodeBase64(withoutFragment.slice(0, atIndex));
    if (decoded && decoded.includes(':')) normalized = `ss://${decoded}@${withoutFragment.slice(atIndex + 1)}${fragment}`;
  }
  const url = safeUrl(normalized);
  const userInfo = decodePart(url.username) + (url.password ? `:${decodePart(url.password)}` : '');
  if (!url.hostname || !userInfo.includes(':')) throw new Error('invalid shadowsocks credentials');
  const split = userInfo.indexOf(':');
  const cipher = userInfo.slice(0, split).trim();
  const password = userInfo.slice(split + 1);
  if (!cipher || !password) throw new Error('invalid shadowsocks credentials');
  const plugin = url.searchParams.get('plugin') || '';
  const [pluginName, ...pluginParts] = plugin.split(';').filter(Boolean);
  return finish({
    name: linkName(url, 'ss'), protocol: 'ss', server: url.hostname, port: linkPort(url, 'ss'), transport: 'tcp',
    sni: url.hostname, ws_path: '/', ws_host: url.hostname,
    secret: { cipher, password, plugin: pluginName || '', plugin_opts: pluginParts.join(';') },
  });
}

function parseSsr(value) {
  const encoded = value.slice(value.indexOf('://') + 3).split('#', 1)[0];
  const decoded = decodeBase64(encoded);
  if (!decoded) throw new Error('invalid ssr payload');
  const [endpoint, query = ''] = decoded.split('/?');
  const [server, port, , cipher, obfs, passwordEncoded] = endpoint.split(':');
  const password = decodeBase64(passwordEncoded || '') || passwordEncoded || '';
  const params = new URLSearchParams(query);
  return finish({
    name: cleanName(decodeBase64(params.get('remarks') || '') || 'ssr', 'ssr'), protocol: 'ss', server, port: Number(port), transport: 'tcp',
    sni: server, ws_path: '/', ws_host: server,
    secret: { cipher, password, plugin: obfs || '', plugin_opts: decodeBase64(params.get('obfsparam') || '') || '' },
  });
}

function parseTrojan(url) {
  const query = url.searchParams;
  const transport = transportName(query.get('type') || 'tcp', query.get('security') || 'tls');
  return finish({
    name: linkName(url, 'trojan'), protocol: 'trojan', server: url.hostname, port: linkPort(url, 'trojan'), transport,
    sni: query.get('sni') || url.hostname, ws_path: query.get('path') || '/', ws_host: query.get('host') || query.get('sni') || url.hostname,
    secret: { password: decodePart(url.username), grpc_service_name: query.get('serviceName') || '', h2_path: query.get('path') || '' },
  });
}

function parseHysteria2(url) {
  const query = url.searchParams;
  return finish({
    name: linkName(url, 'hysteria2'), protocol: 'hysteria2', server: url.hostname, port: linkPort(url, 'hysteria2'), transport: 'quic',
    sni: query.get('sni') || url.hostname, ws_path: '/', ws_host: url.hostname,
    secret: { password: decodePart(url.username), obfs: query.get('obfs') || '', obfs_password: query.get('obfs-password') || '', fingerprint: query.get('pinSHA256') || '' },
  });
}

function parseSnell(url) {
  const q = url.searchParams;
  const server = q.get('server') || url.hostname;
  const port = Number(q.get('port') || url.port || 443);
  return finish({
    name: linkName(url, 'snell'), protocol: 'snell', server, port, transport: 'tcp', sni: q.get('sni') || server, ws_path: '/', ws_host: server,
    secret: { password: q.get('psk') || decodePart(url.username), snell_version: q.get('version') || 'v4', obfs: q.get('obfs') || '', obfs_host: q.get('obfs-host') || '' },
  });
}

function parseAnytls(url) {
  const query = url.searchParams;
  return finish({
    name: linkName(url, 'anytls'), protocol: 'anytls', server: url.hostname, port: linkPort(url, 'anytls'), transport: 'tls',
    sni: query.get('sni') || url.hostname, ws_path: '/', ws_host: url.hostname,
    secret: { password: decodePart(url.username), skip_cert_verify: query.get('insecure') === '1' || query.get('allowInsecure') === '1' },
  });
}

function parseTuic(url) {
  const query = url.searchParams;
  const [uuid, password = ''] = decodePart(url.username).split(':');
  return finish({
    name: linkName(url, 'tuic'), protocol: 'tuic', server: url.hostname, port: linkPort(url, 'tuic'), transport: 'quic',
    sni: query.get('sni') || url.hostname, ws_path: '/', ws_host: url.hostname,
    secret: { uuid, password, congestion_control: query.get('congestion_control') || '', alpn: query.get('alpn') || '' },
  });
}

function finish(item) {
  if (!item.server || !Number.isInteger(Number(item.port)) || Number(item.port) < 1 || Number(item.port) > 65535) throw new Error('invalid endpoint');
  const protocol = String(item.protocol).toLowerCase();
  if (!TRANSPORTS.has(item.transport)) throw new Error('unsupported transport');
  if (/[\s\u0000-\u001f\u007f]/.test(item.server) || item.server.length > 255) throw new Error('invalid server');
  const secret = {};
  for (const [key, raw] of Object.entries(item.secret || {})) {
    const value = typeof raw === 'boolean' || typeof raw === 'number' ? raw : String(raw ?? '').trim().slice(0, 2048);
    if (value !== '') secret[key] = value;
  }
  const transport = item.transport;
  const name = cleanName(item.name, protocol);
  return {
    name, protocol, server: item.server, port: Number(item.port), transport,
    sni: cleanHost(item.sni || item.server), ws_path: cleanPath(item.ws_path || '/'), ws_host: cleanHost(item.ws_host || item.sni || item.server),
    secret, runtime_supported: isRuntimeProxyTargetSupported(protocol, transport),
  };
}

function safeUrl(value) {
  try { return new URL(value); } catch (_) { throw new Error('invalid url'); }
}

function linkPort(url, protocol) {
  const port = Number(url.port || DEFAULT_PORTS[protocol]);
  return port;
}

function linkName(url, fallback) {
  const label = url.hash ? decodePart(url.hash.slice(1)) : '';
  return cleanName(label || `${fallback} ${url.hostname || ''}:${url.port || DEFAULT_PORTS[fallback] || ''}`, fallback);
}

function transportName(type, security) {
  const normalized = String(type || 'tcp').toLowerCase().replace(/websocket/g, 'ws').replace(/http-upgrade/g, 'httpupgrade');
  const secure = ['tls', 'reality', 'https'].includes(String(security || '').toLowerCase());
  if (normalized === 'grpc') return secure ? 'tls-grpc' : 'grpc';
  if (normalized === 'h2' || normalized === 'http') return secure ? 'tls-h2' : 'h2';
  if (normalized === 'httpupgrade') return secure ? 'tls-httpupgrade' : 'httpupgrade';
  if (normalized === 'ws') return secure ? 'tls-ws' : 'ws';
  return secure && normalized === 'tcp' ? 'tls' : 'tcp';
}

function hasKnownScheme(value) {
  const scheme = String(value || '').slice(0, String(value || '').indexOf(':')).toLowerCase();
  return KNOWN_SCHEMES.has(scheme) && String(value).includes('://');
}

function decodeBase64(value) {
  try {
    const normalized = String(value || '').replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return '';
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
  } catch (_) { return ''; }
}

function decodePart(value) {
  try { return decodeURIComponent(String(value || '')); } catch (_) { return String(value || ''); }
}

function cleanName(value, fallback) {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 96);
  return name || fallback;
}

function cleanHost(value) {
  return String(value || '').replace(/[\r\n\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
}

function cleanPath(value) {
  const path = String(value || '/').trim().slice(0, 256);
  return path.startsWith('/') ? path : `/${path}`;
}
