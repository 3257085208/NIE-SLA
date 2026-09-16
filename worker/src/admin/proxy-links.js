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
const PROTOCOL_ALIASES = {
  socks: 'socks5',
  socks5: 'socks5',
  'http-connect': 'http',
  https: 'http',
  shadowsocks: 'ss',
  ss: 'ss',
  hysteria: 'hysteria2',
  hy2: 'hysteria2',
  hysteria2: 'hysteria2',
};
const REMOTE_SUBSCRIPTION_SCHEMES = /^(?:clash|clashmeta|surge|shadowrocket|quantumult|quantumultx):\/\//iu;
const YAML_UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function parseProxyLinks(raw, { maxItems = MAX_ITEMS } = {}) {
  const text = String(raw ?? '').trim();
  if (!text || text.length > MAX_LINK_BYTES) throw new Error('代理链接为空或超过 64 KiB');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error('代理链接包含不允许的控制字符');
  if (REMOTE_SUBSCRIPTION_SCHEMES.test(text)) throw new Error('请粘贴订阅内容，不自动抓取远程订阅地址');
  const limit = Math.max(1, Math.min(MAX_ITEMS, Number(maxItems) || MAX_ITEMS));
  const candidates = expandCandidates(text).slice(0, limit);
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
    runtime_reason: item.runtime_reason || '',
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

function runtimeSupportReason(protocol, transport, secret = {}) {
  const normalizedProtocol = String(protocol || '').toLowerCase();
  const normalizedTransport = String(transport || '').toLowerCase();
  if (!isRuntimeProxyTargetSupported(normalizedProtocol, normalizedTransport)) {
    return '该协议或传输组合当前 Agent 尚未内置真实握手';
  }
  if (normalizedProtocol === 'vless' && String(secret.security || '').toLowerCase() === 'reality') {
    const publicKey = String(secret.reality_public_key || secret.public_key || '').trim();
    const shortId = String(secret.reality_short_id || secret.short_id || '').trim();
    if (!isRealityPublicKey(publicKey)) return 'VLESS Reality 缺少有效的公钥参数 pbk';
    if (!isRealityShortId(shortId)) return 'VLESS Reality 的短 ID 参数 sid 无效';
  }
  if (normalizedProtocol === 'vless' && String(secret.flow || '').toLowerCase() && String(secret.flow || '').toLowerCase() !== 'xtls-rprx-vision') {
    return '该 VLESS flow 当前 Agent 尚未内置真实握手';
  }
  if (normalizedProtocol === 'vmess' && Number(secret.alter_id || 0) > 0) {
    return '当前 Agent 仅支持 VMess alter_id=0';
  }
  if (normalizedProtocol === 'hysteria2' && secret.obfs && String(secret.obfs).toLowerCase() !== 'salamander') {
    return '当前 Agent 仅支持 Hysteria2 salamander 混淆';
  }
  if (normalizedProtocol === 'tuic') return 'TUIC 当前 Agent 尚未内置真实握手';
  return '';
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
    const nodes = Array.isArray(value)
      ? value
      : (Array.isArray(value?.proxies)
        ? value.proxies
        : (Array.isArray(value?.outbounds) ? value.outbounds : (value?.server && value?.type ? [value] : [])));
    return nodes.flatMap(node => proxyObjectToLink(node)).filter(Boolean);
  } catch (_) {}
  return parseSimpleClashYaml(trimmed);
}

function proxyObjectToLink(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return '';
  const type = normalizeProtocol(nodeValue(node, 'type', 'protocol'));
  const server = nodeText(nodeValue(node, 'server', 'address'));
  const port = Number(nodeValue(node, 'port', 'server_port', 'serverPort') || DEFAULT_PORTS[type]);
  if (!type || !server || !Number.isInteger(port) || port < 1 || port > 65535) return '';
  const name = cleanName(nodeValue(node, 'name', 'ps'), type);
  if (type === 'vmess') return proxyObjectToVmessLink(node, server, port, name);
  if (type === 'ss') {
    const cipher = nodeText(nodeValue(node, 'cipher', 'method'));
    const password = nodeText(nodeValue(node, 'password'));
    if (!cipher || !password) return '';
    const query = new URLSearchParams();
    const plugin = nodeText(nodeValue(node, 'plugin'));
    const pluginOpts = serializePluginOptions(nodeValue(node, 'plugin-opts', 'plugin_opts'));
    if (plugin) query.set('plugin', [plugin, pluginOpts].filter(Boolean).join(';'));
    return `ss://${encodeURIComponent(cipher)}:${encodeURIComponent(password)}@${authorityHost(server)}:${port}${query.size ? `?${query}` : ''}#${encodeURIComponent(name)}`;
  }

  const query = new URLSearchParams();
  const tlsConfig = nodeObject(nodeValue(node, 'tls'));
  const transportConfig = nodeObject(nodeValue(node, 'transport'));
  const network = normalizeNetwork(nodeValue(node, 'network', 'net') || transportConfig?.type);
  const realityOpts = nodeObject(nodeValue(node, 'reality-opts', 'reality_opts')) || nodeObject(tlsConfig?.reality);
  const security = nodeText(nodeValue(node, 'security')) || nodeText(tlsConfig?.security) || (realityOpts ? 'reality' : '');
  const tlsEnabled = type === 'trojan' || nodeBoolean(nodeValue(node, 'tls')) || nodeBoolean(tlsConfig?.enabled)
    || ['tls', 'reality', 'https'].includes(security.toLowerCase());
  const effectiveSecurity = security || (tlsEnabled ? 'tls' : '');
  if (network && network !== 'tcp') query.set('type', network);
  if (effectiveSecurity) query.set('security', effectiveSecurity);
  const sni = nodeText(nodeValue(node, 'sni', 'servername')) || nodeText(tlsConfig?.server_name, tlsConfig?.serverName) || server;
  if (sni) query.set('sni', sni);
  const wsOpts = nodeObject(nodeValue(node, 'ws-opts', 'ws_opts'));
  const grpcOpts = nodeObject(nodeValue(node, 'grpc-opts', 'grpc_opts'));
  const h2Opts = nodeObject(nodeValue(node, 'h2-opts', 'h2_opts'));
  const httpOpts = nodeObject(nodeValue(node, 'http-opts', 'http_opts'));
  const headers = nodeObject(wsOpts?.headers) || nodeObject(transportConfig?.headers);
  const path = nodeText(wsOpts?.path, nodeValue(node, 'path'))
    || nodeText(transportConfig?.path, h2Opts?.path, httpOpts?.path);
  const host = nodeText(headers?.Host, headers?.host, nodeValue(node, 'host'))
    || nodeText(transportConfig?.host, tlsConfig?.server_name, sni);
  if (path) query.set('path', path);
  if (host && ['ws', 'h2', 'httpupgrade'].includes(network)) query.set('host', host);
  const serviceName = nodeText(nodeValue(node, 'serviceName', 'service_name'), grpcOpts?.['grpc-service-name'], grpcOpts?.serviceName, transportConfig?.service_name);
  if (serviceName && network === 'grpc') query.set('serviceName', serviceName);
  const flow = nodeText(nodeValue(node, 'flow'));
  if (flow) query.set('flow', flow);
  const encryption = nodeText(nodeValue(node, 'encryption'));
  if (encryption) query.set('encryption', encryption);
  const skipCertVerify = nodeBoolean(nodeValue(node, 'skip-cert-verify', 'skip_cert_verify')) || nodeBoolean(tlsConfig?.insecure);
  if (skipCertVerify) query.set('allowInsecure', '1');
  const fingerprint = nodeText(nodeValue(node, 'client-fingerprint', 'client_fingerprint', 'fingerprint'), tlsConfig?.fingerprint);
  if (fingerprint) query.set('fingerprint', fingerprint);
  const realityPublicKey = nodeText(
    nodeValue(node, 'public-key', 'public_key', 'publicKey', 'pbk'),
    realityOpts?.['public-key'], realityOpts?.public_key, realityOpts?.publicKey, realityOpts?.pbk,
  );
  const realityShortId = nodeText(
    nodeValue(node, 'short-id', 'short_id', 'shortId', 'sid'),
    realityOpts?.['short-id'], realityOpts?.short_id, realityOpts?.shortId, realityOpts?.sid,
  );
  if (security.toLowerCase() === 'reality') {
    if (realityPublicKey) query.set('pbk', realityPublicKey);
    if (realityShortId) query.set('sid', realityShortId);
  }
  const alpn = serializeList(nodeValue(node, 'alpn') ?? tlsConfig?.alpn);
  if (alpn) query.set('alpn', alpn);
  const obfs = nodeText(nodeValue(node, 'obfs'));
  const obfsPassword = nodeText(nodeValue(node, 'obfs-password', 'obfs_password'));
  const obfsHost = nodeText(nodeValue(node, 'obfs-host', 'obfs_host'));
  if (obfs) query.set('obfs', obfs);
  if (obfsPassword) query.set('obfs-password', obfsPassword);
  if (obfsHost) query.set('obfs-host', obfsHost);
  if (type === 'tuic') {
    const uuid = nodeText(nodeValue(node, 'uuid', 'id'));
    const password = nodeText(nodeValue(node, 'password'));
    if (uuid) query.set('uuid', uuid);
    if (nodeValue(node, 'congestion_control')) query.set('congestion_control', nodeText(nodeValue(node, 'congestion_control')));
    return `tuic://${encodeURIComponent(`${uuid}:${password}`)}@${authorityHost(server)}:${port}${query.size ? `?${query}` : ''}#${encodeURIComponent(name)}`;
  }
  const nodePassword = nodeText(nodeValue(node, 'password'));
  const user = type === 'vless'
    ? nodeText(nodeValue(node, 'uuid', 'id'))
    : ['trojan', 'hysteria2', 'anytls'].includes(type)
      ? nodePassword
      : nodeText(nodeValue(node, 'username'));
  const password = ['trojan', 'hysteria2', 'anytls'].includes(type)
    ? ''
    : nodePassword || (type === 'snell' ? nodeText(nodeValue(node, 'psk')) : '');
  if (type === 'snell') {
    if (nodeValue(node, 'version')) query.set('version', nodeText(nodeValue(node, 'version')));
    return `snell://${encodeURIComponent(password)}@${authorityHost(server)}:${port}${query.size ? `?${query}` : ''}#${encodeURIComponent(name)}`;
  }
  const scheme = type === 'http' && tlsEnabled ? 'https' : type;
  const authority = `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ''}@${authorityHost(server)}:${port}`;
  if (type === 'http' || type === 'socks5') {
    if (tlsEnabled && type === 'socks5') query.set('tls', '1');
    const suffix = query.size ? `?${query}` : '';
    return `${scheme}://${authority}${suffix}#${encodeURIComponent(name)}`;
  }
  return `${scheme}://${authority}${query.size ? `?${query}` : ''}#${encodeURIComponent(name)}`;
}

function parseSimpleClashYaml(text) {
  if (!/^\s*proxies\s*:/m.test(text)) return [];
  const out = [];
  let inProxies = false;
  let proxiesIndent = 0;
  let itemIndent = null;
  let current = null;
  const contexts = [];
  const pushCurrent = () => {
    if (current) out.push(current);
    current = null;
    contexts.length = 0;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripYamlComment(rawLine.replace(/\t/g, '  '));
    if (!line.trim() || /^\s*(?:---|\.\.\.)\s*$/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    const root = body.match(/^proxies\s*:\s*(.*)$/iu);
    if (!inProxies) {
      if (root) {
        inProxies = true;
        proxiesIndent = indent;
        if (root[1]) {
          const inline = parseYamlScalar(root[1]);
          if (Array.isArray(inline)) out.push(...inline.filter(item => item && typeof item === 'object'));
        }
      }
      continue;
    }
    if (indent <= proxiesIndent && !body.startsWith('-')) {
      pushCurrent();
      inProxies = false;
      if (root) {
        inProxies = true;
        proxiesIndent = indent;
      }
      continue;
    }
    if (body === '-' || body.startsWith('- ')) {
      const value = body.slice(1).trim();
      if (itemIndent === null || indent <= itemIndent) {
        pushCurrent();
        current = Object.create(null);
        itemIndent = indent;
        if (value) {
          const keyValue = value.match(/^([^:]+):\s*(.*)$/u);
          if (keyValue && safeYamlKey(keyValue[1])) setYamlValue(current, keyValue[1], keyValue[2]);
        }
        continue;
      }
      const context = contexts[contexts.length - 1];
      if (context) {
        if (context.value && !Array.isArray(context.value) && Object.keys(context.value).length === 0) {
          context.parent[context.key] = [];
          context.value = context.parent[context.key];
        }
        if (Array.isArray(context.value)) context.value.push(parseYamlScalar(value));
      }
      continue;
    }
    if (!current) continue;
    while (contexts.length && indent <= contexts[contexts.length - 1].indent) contexts.pop();
    const key = body.match(/^([^:]+):(?:\s*(.*))?$/u);
    if (!key || !safeYamlKey(key[1])) continue;
    const name = unquoteYaml(String(key[1]).trim());
    const rawValue = key[2] == null ? '' : key[2];
    const parent = contexts.length ? contexts[contexts.length - 1].value : current;
    if (!parent || Array.isArray(parent)) continue;
    if (!rawValue.trim()) {
      const nested = Object.create(null);
      parent[name] = nested;
      contexts.push({ indent, parent, key: name, value: nested });
    } else {
      setYamlValue(parent, name, rawValue);
    }
  }
  pushCurrent();
  return out.map(proxyObjectToLink).filter(Boolean);
}

function setYamlValue(target, key, raw) {
  const name = unquoteYaml(String(key || '').trim());
  if (!safeYamlKey(name)) return;
  const value = parseYamlScalar(raw);
  if (value !== null && value !== '') target[name] = value;
}

function normalizeProtocol(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (PROTOCOL_ALIASES[normalized]) return PROTOCOL_ALIASES[normalized];
  return [...RUNTIME_PROTOCOLS, 'tuic'].includes(normalized) ? normalized : '';
}

function nodeValue(node, ...keys) {
  for (const key of keys) {
    if (node && node[key] !== undefined && node[key] !== null) return node[key];
  }
  return undefined;
}

function nodeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function nodeText(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      const list = serializeList(value);
      if (list) return list;
      continue;
    }
    if (typeof value === 'object') continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function nodeBoolean(value) {
  return value === true || value === 1 || /^(?:1|true|yes|on)$/iu.test(String(value || '').trim());
}

function normalizeNetwork(value) {
  const normalized = String(value || 'tcp').trim().toLowerCase()
    .replace(/^websocket$/u, 'ws')
    .replace(/^http[-_]?upgrade$/u, 'httpupgrade');
  return ['tcp', 'ws', 'grpc', 'h2', 'httpupgrade', 'quic'].includes(normalized) ? normalized : 'tcp';
}

function serializeList(value) {
  if (Array.isArray(value)) return value.map(item => nodeText(item)).filter(Boolean).join(',');
  return nodeText(value);
}

function serializePluginOptions(value) {
  if (!value) return '';
  if (typeof value !== 'object' || Array.isArray(value)) return nodeText(value);
  return Object.entries(value)
    .filter(([key]) => safeYamlKey(key))
    .map(([key, item]) => `${key}=${nodeText(item)}`)
    .filter(part => !part.endsWith('='))
    .join(';');
}

function safeYamlKey(value) {
  return !YAML_UNSAFE_KEYS.has(unquoteYaml(String(value || '').trim()));
}

function unquoteYaml(value) {
  const text = String(value || '').trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch (_) {}
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

function stripYamlComment(value) {
  const text = String(value || '');
  let quote = '';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '"' && char === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if (quote === '"' && char === '"' && !escaped) quote = '';
    else if (quote === "'" && char === "'") {
      if (text[index + 1] === "'") index += 1;
      else quote = '';
    } else if (!quote && (char === '"' || char === "'")) quote = char;
    if (char === '#' && !quote && (index === 0 || /\s/u.test(text[index - 1]))) return text.slice(0, index);
    escaped = false;
  }
  return text;
}

function parseYamlScalar(raw) {
  const text = stripYamlComment(String(raw ?? '').trim()).trim();
  if (!text || /^(?:null|~)$/iu.test(text)) return null;
  const unquoted = unquoteYaml(text);
  if (unquoted !== text) return unquoted;
  if (/^(?:true|false)$/iu.test(text)) return text.toLowerCase() === 'true';
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text)) return Number(text);
  if (text.startsWith('[') && text.endsWith(']')) return splitYamlCollection(text.slice(1, -1));
  if (text.startsWith('{') && text.endsWith('}')) {
    const object = Object.create(null);
    for (const part of splitYamlCollectionParts(text.slice(1, -1))) {
      const index = part.indexOf(':');
      if (index <= 0) continue;
      const key = unquoteYaml(part.slice(0, index).trim());
      if (safeYamlKey(key)) object[key] = parseYamlScalar(part.slice(index + 1));
    }
    return object;
  }
  return text;
}

function splitYamlCollection(value) {
  return splitYamlCollectionParts(value).map(part => parseYamlScalar(part));
}

function splitYamlCollectionParts(value) {
  const parts = [];
  let start = 0;
  let quote = '';
  let depth = 0;
  let escaped = false;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '"' && char === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if (quote === '"' && char === '"' && !escaped) quote = '';
    else if (quote === "'" && char === "'") {
      if (text[index + 1] === "'") index += 1;
      else quote = '';
    } else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (!quote && ['[', '{'].includes(char)) depth += 1;
    else if (!quote && [']', '}'].includes(char)) depth = Math.max(0, depth - 1);
    else if (!quote && char === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
    escaped = false;
  }
  if (text.slice(start).trim()) parts.push(text.slice(start).trim());
  return parts;
}

function authorityHost(value) {
  const host = String(value || '').trim();
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function proxyObjectToVmessLink(node, server, port, name) {
  const tlsConfig = nodeObject(nodeValue(node, 'tls'));
  const transportConfig = nodeObject(nodeValue(node, 'transport'));
  const wsOpts = nodeObject(nodeValue(node, 'ws-opts', 'ws_opts'));
  const grpcOpts = nodeObject(nodeValue(node, 'grpc-opts', 'grpc_opts'));
  const h2Opts = nodeObject(nodeValue(node, 'h2-opts', 'h2_opts'));
  const network = normalizeNetwork(nodeValue(node, 'network', 'net') || transportConfig?.type);
  const realityOpts = nodeObject(nodeValue(node, 'reality-opts', 'reality_opts'));
  const securityValue = nodeText(nodeValue(node, 'cipher', 'scy', 'security')).toLowerCase();
  const security = ['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none'].includes(securityValue) ? securityValue : 'auto';
  const tls = nodeBoolean(nodeValue(node, 'tls')) || nodeBoolean(tlsConfig?.enabled)
    || ['tls', 'reality', 'https'].includes(nodeText(nodeValue(node, 'security')).toLowerCase())
    || Boolean(realityOpts);
  const headers = nodeObject(wsOpts?.headers) || nodeObject(transportConfig?.headers);
  const path = nodeText(wsOpts?.path, nodeValue(node, 'path'), transportConfig?.path, h2Opts?.path);
  const host = nodeText(headers?.Host, headers?.host, nodeValue(node, 'host'), transportConfig?.host);
  const sni = nodeText(nodeValue(node, 'sni', 'servername'), tlsConfig?.server_name, tlsConfig?.serverName, host, server);
  const serviceName = nodeText(nodeValue(node, 'serviceName', 'service_name'), grpcOpts?.['grpc-service-name'], grpcOpts?.serviceName, transportConfig?.service_name);
  const uuid = nodeText(nodeValue(node, 'uuid', 'id'));
  const alterId = Number(nodeValue(node, 'alter_id', 'alterId', 'aid') || 0);
  const config = {
    v: '2',
    ps: name,
    add: server,
    port: String(port),
    id: uuid,
    aid: String(Number.isInteger(alterId) && alterId >= 0 ? alterId : 0),
    scy: security,
    net: network,
    type: 'none',
    host,
    path: network === 'grpc' ? (serviceName || path) : path,
    tls: tls ? 'tls' : '',
    sni,
  };
  const skipCertVerify = nodeBoolean(nodeValue(node, 'skip-cert-verify', 'skip_cert_verify')) || nodeBoolean(tlsConfig?.insecure);
  if (skipCertVerify) config.allowInsecure = true;
  const fingerprint = nodeText(nodeValue(node, 'client-fingerprint', 'client_fingerprint', 'fingerprint'), tlsConfig?.fingerprint);
  if (fingerprint) config.fp = fingerprint;
  const alpn = serializeList(nodeValue(node, 'alpn') ?? tlsConfig?.alpn);
  if (alpn) config.alpn = alpn;
  return `vmess://${encodeBase64(JSON.stringify(config))}#${encodeURIComponent(name)}`;
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
  if (protocol === 'vless') return parseVless(value);
  if (protocol === 'trojan') return parseTrojan(url);
  if (protocol === 'hysteria2') return parseHysteria2(url);
  if (protocol === 'snell') return parseSnell(url);
  if (protocol === 'anytls') return parseAnytls(url);
  if (protocol === 'tuic') return parseTuic(url);
  throw new Error('unsupported scheme');
}

function parseBasicProxy(url, protocol) {
  const secure = url.protocol === 'https:' || nodeBoolean(url.searchParams.get('tls') || url.searchParams.get('secure'));
  const transport = secure ? 'tls' : 'tcp';
  return finish({
    name: linkName(url, protocol), protocol, server: url.hostname, port: linkPort(url, protocol), transport,
    sni: url.hostname, ws_path: '/', ws_host: url.hostname,
    secret: { username: decodePart(url.username), password: decodePart(url.password) },
  });
}

function parseVless(value) {
  const url = safeUrl(value);
  const query = url.searchParams;
  const encodedAuthority = decodeVlessAuthority(value);
  const server = encodedAuthority?.server || url.hostname;
  const port = encodedAuthority?.port || linkPort(url, 'vless');
  const publicKey = query.get('pbk') || query.get('publicKey') || query.get('public_key') || '';
  const shortId = query.get('sid') || query.get('shortId') || query.get('short_id') || '';
  const securityParam = query.get('security') || '';
  const tlsEnabled = nodeBoolean(query.get('tls') || query.get('ssl') || query.get('secure'));
  const security = securityParam || (publicKey ? 'reality' : (tlsEnabled ? 'tls' : ''));
  const flow = query.get('flow') || vlessFlowFromShadowrocket(query.get('xtls'));
  const transport = transportName(query.get('type') || query.get('net') || 'tcp', security);
  const allowInsecure = nodeBoolean(query.get('allowInsecure') || query.get('allow-insecure') || query.get('insecure'));
  const label = query.get('remarks') || query.get('remark') || query.get('name') || '';
  const name = cleanName(decodePart(label) || (url.hash ? decodePart(url.hash.slice(1)) : '') || `vless ${server}:${port}`, 'vless');
  return finish({
    name, protocol: 'vless', server, port, transport,
    sni: query.get('sni') || query.get('servername') || query.get('peer') || query.get('serverName') || server,
    ws_path: query.get('path') || '/', ws_host: query.get('host') || query.get('authority') || query.get('sni') || query.get('peer') || server,
    secret: {
      uuid: encodedAuthority?.uuid || decodePart(url.username),
      flow,
      encryption: query.get('encryption') || 'none',
      security,
      grpc_service_name: query.get('serviceName') || query.get('service_name') || query.get('grpc-service-name') || '',
      h2_path: query.get('path') || '',
      http_upgrade_path: query.get('path') || '',
      skip_cert_verify: allowInsecure,
      fingerprint: query.get('fp') || query.get('fingerprint') || '',
      alpn: query.get('alpn') || '',
      reality_public_key: publicKey,
      reality_short_id: shortId,
    },
  });
}

function decodeVlessAuthority(value) {
  const schemeEnd = String(value || '').indexOf('://');
  if (schemeEnd < 0) return null;
  const rest = String(value).slice(schemeEnd + 3);
  const queryStart = rest.search(/[?#]/u);
  const encoded = (queryStart >= 0 ? rest.slice(0, queryStart) : rest).trim();
  if (!encoded || encoded.includes('@')) return null;
  const decoded = decodeBase64(decodePart(encoded));
  if (!decoded || !decoded.includes('@')) return null;
  const atIndex = decoded.lastIndexOf('@');
  let uuid = decoded.slice(0, atIndex).trim();
  const endpoint = decoded.slice(atIndex + 1).trim();
  if (/^(?:auto|vless):/iu.test(uuid)) uuid = uuid.replace(/^(?:auto|vless):/iu, '');
  if (!uuid || !endpoint) return null;
  let endpointUrl;
  try { endpointUrl = new URL(`vless://${endpoint}`); } catch (_) { return null; }
  const server = endpointUrl.hostname;
  const port = linkPort(endpointUrl, 'vless');
  if (!server || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { uuid: decodePart(uuid), server, port };
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
  const tlsSecurity = String(config.tls || '').toLowerCase();
  const transport = transportName(type, tlsSecurity);
  const label = fragmentAt >= 0 ? decodePart(value.slice(fragmentAt + 1)) : String(config.ps || 'VMess');
  return finish({
    name: cleanName(label, 'vmess'), protocol: 'vmess', server, port, transport,
    sni: String(config.sni || config.host || server), ws_path: String(config.path || '/'), ws_host: String(config.host || config.sni || server),
    secret: {
      uuid: String(config.id || ''),
      security: String(config.scy || 'auto').toLowerCase(),
      alter_id: Number(config.aid || 0),
      grpc_service_name: type === 'grpc' ? String(config.path || '') : '',
      h2_path: type === 'h2' ? String(config.path || '') : '',
      http_upgrade_path: type === 'httpupgrade' ? String(config.path || '') : '',
      encryption: tlsSecurity,
      skip_cert_verify: nodeBoolean(config.allowInsecure || config.insecure),
      fingerprint: String(config.fp || config.fingerprint || ''),
      alpn: serializeList(config.alpn),
    },
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
  const runtime_reason = runtimeSupportReason(protocol, transport, secret);
  return {
    name, protocol, server: item.server, port: Number(item.port), transport,
    sni: cleanHost(item.sni || item.server), ws_path: cleanPath(item.ws_path || '/'), ws_host: cleanHost(item.ws_host || item.sni || item.server),
    secret, runtime_supported: !runtime_reason, runtime_reason,
  };
}

function safeUrl(value) {
  try { return new URL(value); } catch (_) { throw new Error('invalid url'); }
}

function linkPort(url, protocol) {
  if (protocol === 'http' && url.protocol === 'https:' && !url.port) return 443;
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

function vlessFlowFromShadowrocket(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['2', 'vision', 'xtls-rprx-vision'].includes(normalized)) return 'xtls-rprx-vision';
  if (['1', 'origin', 'xtls-rprx-origin'].includes(normalized)) return 'xtls-rprx-origin';
  return '';
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

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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

function isRealityPublicKey(value) {
  const bytes = decodeBase64Bytes(value);
  return bytes?.length === 32;
}

function isRealityShortId(value) {
  const normalized = String(value || '').trim();
  return normalized === '' || (normalized.length <= 16 && normalized.length % 2 === 0 && /^[0-9a-f]+$/iu.test(normalized));
}

function decodeBase64Bytes(value) {
  const raw = String(value || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!raw || !/^[A-Za-z0-9+/]*={0,2}$/u.test(raw)) return null;
  const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
  } catch (_) {
    return null;
  }
}
