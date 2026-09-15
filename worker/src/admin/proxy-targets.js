import { nowSec, sanitizeAgentId } from '../utils.js';
import { ApiError, safeJson } from '../auth.js';
import { decryptScopedSecret, encryptScopedSecret } from '../agent-credentials.js';
import { isRuntimeProxyTargetSupported, parseProxyLinks, proxyLinkPreview } from './proxy-links.js';

export const PROXY_PROTOCOLS = ['socks5', 'http', 'ss', 'vless', 'vmess', 'trojan', 'hysteria2', 'snell', 'anytls', 'tuic'];
export const PROXY_TRANSPORTS = ['tcp', 'tls', 'ws', 'tls-ws', 'grpc', 'tls-grpc', 'h2', 'tls-h2', 'httpupgrade', 'tls-httpupgrade', 'quic'];

const MAX_PROXY_TARGETS_PER_AGENT = 100;
const PROXY_CHECK_STAGES = new Set(['config', 'connect', 'handshake', 'canary', 'runtime', 'failed']);
const PROXY_CHECK_ERRORS = new Set(['timeout', 'auth_failed', 'unsupported', 'handshake_failed', 'canary_failed', 'invalid_config', 'runtime_failed']);

export async function previewProxyLinks(request) {
  const body = await safeJson(request, 64 * 1024);
  let items;
  try { items = parseProxyLinks(body?.link || body?.text || ''); }
  catch (_) { throw new ApiError(400, '代理分享链接无法解析'); }
  return { ok: true, items: items.map((item, index) => ({ index, ...proxyLinkPreview(item) })) };
}

export async function listProxyTargets(env) {
  const rows = await env.DB.prepare(`
    SELECT p.*, t.name AS agent_name
    FROM proxy_targets p
    LEFT JOIN targets t ON t.id = p.agent_id
    ORDER BY COALESCE(t.sort_order, 2147483647), COALESCE(t.name, p.agent_id), p.name
  `).all();
  const secretRows = await secretRowsById(env, (rows.results || []).map(row => row.id));
  return { ok: true, targets: (rows.results || []).map(row => publicProxyRow(row, secretRows.get(String(row.id)))) };
}

export async function createProxyTarget(request, env) {
  const body = await safeJson(request, 64 * 1024);
  const input = normalizeProxyInput(resolveLinkBody(body), null);
  await assertAgentTarget(env, input.agentId);
  const existing = await env.DB.prepare(`SELECT id FROM proxy_targets WHERE id = ?`).bind(input.id).first();
  if (existing) throw new ApiError(409, '代理检测目标 ID 已存在');
  const now = nowSec();
  await env.DB.prepare(`INSERT INTO proxy_targets (
    id, agent_id, name, protocol, server, port, transport, sni, ws_path, ws_host,
    enabled, timeout_ms, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.id, input.agentId, input.name, input.protocol, input.server, input.port, input.transport, input.sni, input.wsPath, input.wsHost, input.enabled, input.timeoutMs, now, now)
    .run();
  await saveProxySecret(env, input.id, input.agentId, input.secret, now);
  return { ok: true, id: input.id };
}

export async function updateProxyTarget(id, request, env) {
  const existing = await env.DB.prepare(`SELECT * FROM proxy_targets WHERE id = ?`).bind(id).first();
  if (!existing) throw new ApiError(404, '代理检测目标不存在');
  const secretRow = await env.DB.prepare(`SELECT secret_ciphertext FROM proxy_target_secrets WHERE target_id = ?`).bind(id).first().catch(() => null);
  const currentSecret = secretRow?.secret_ciphertext
    ? await decryptProxySecret(env, id, existing.agent_id, secretRow.secret_ciphertext)
    : {};
  const body = await safeJson(request, 64 * 1024);
  const resolvedBody = resolveLinkBody(body);
  const input = normalizeProxyInput({ ...existing, ...resolvedBody, id, secret: body?.link ? resolvedBody.secret : (body?.secret === undefined ? currentSecret : { ...currentSecret, ...(body.secret || {}) }) }, existing);
  await assertAgentTarget(env, input.agentId);
  const now = nowSec();
  await env.DB.prepare(`UPDATE proxy_targets SET
    agent_id = ?, name = ?, protocol = ?, server = ?, port = ?, transport = ?, sni = ?, ws_path = ?, ws_host = ?,
    enabled = ?, timeout_ms = ?, updated_at = ? WHERE id = ?`)
    .bind(input.agentId, input.name, input.protocol, input.server, input.port, input.transport, input.sni, input.wsPath, input.wsHost, input.enabled, input.timeoutMs, now, id)
    .run();
  await saveProxySecret(env, id, input.agentId, input.secret, now);
  return { ok: true, id };
}

export async function deleteProxyTarget(id, env) {
  await env.DB.prepare(`DELETE FROM proxy_targets WHERE id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM proxy_target_secrets WHERE target_id = ?`).bind(id).run();
  return { ok: true, id };
}

// Public status only receives the latest result, never proxy configuration.
// Keep this normalizer here so both D1 state and buffered DO state have the
// same bounded, credential-free shape at the public boundary.
export function normalizePublicProxyChecks(value, now = nowSec()) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_PROXY_TARGETS_PER_AGENT).flatMap((item) => {
    const id = String(item?.target_id || item?.id || '').trim().slice(0, 128);
    const protocol = PROXY_PROTOCOLS.includes(String(item?.protocol || '').toLowerCase()) ? String(item.protocol).toLowerCase() : '';
    const ts = Math.floor(Number(item?.ts || item?.checked_at || 0));
    if (!id || !protocol || !Number.isFinite(ts) || ts <= 0) return [];
    const latency = item?.latency_ms == null ? null : Number(item.latency_ms);
    const duration = (key) => {
      const value = item?.[key] == null ? null : Number(item[key]);
      return Number.isFinite(value) && value >= 0 && value <= 120_000 ? Math.round(value) : null;
    };
    const ok = item?.ok === true || item?.ok === 1 || item?.ok === '1' ? 1 : 0;
    const stage = String(item?.stage || (ok ? 'canary' : 'failed')).trim().slice(0, 32);
    const error = String(item?.error || '').trim().slice(0, 64);
    return [{
      target_id: id,
      name: String(item?.name || id).trim().slice(0, 96),
      protocol,
      ts,
      checked_at: ts,
      latency_ms: Number.isFinite(latency) && latency >= 0 && latency <= 120_000 ? Math.round(latency) : null,
      handshake_ms: duration('handshake_ms'),
      first_byte_ms: duration('first_byte_ms'),
      total_ms: duration('total_ms'),
      ok,
      stage: PROXY_CHECK_STAGES.has(stage) ? stage : (ok ? 'canary' : 'failed'),
      error: PROXY_CHECK_ERRORS.has(error) ? error : null,
      stale: ts < now - 900,
    }];
  });
}

export async function getAgentProxyTargets(env, agentId, { includeSecrets = true } = {}) {
  const rows = await getProxyTargetRows(env, agentId, true);
  const targets = [];
  for (const row of rows) {
    const target = controlProxyRow(row);
    if (includeSecrets) {
      target.secret = row.secret_ciphertext
        ? await decryptProxySecret(env, row.id, row.agent_id, row.secret_ciphertext)
        : {};
    }
    delete target._secret_ciphertext;
    targets.push(target);
  }
  return targets;
}

// Durable Object control cache stores ciphertext only.  This function turns
// cached internal rows into a one-request response without persisting plaintext
// credentials in DO storage.
export async function getCachedProxyControl(env, cachedRows, agentId) {
  const rows = Array.isArray(cachedRows) ? cachedRows : [];
  const targets = [];
  for (const row of rows) {
    const target = controlProxyRow(row);
    target.secret = row.secret_ciphertext
      ? await decryptProxySecret(env, row.id, agentId, row.secret_ciphertext)
      : {};
    delete target._secret_ciphertext;
    targets.push(target);
  }
  return targets;
}

export async function getProxyControlRows(env, agentId) {
  return getProxyTargetRows(env, agentId, true);
}

function normalizeProxyInput(body, existing) {
  const id = sanitizeAgentId(body?.id || existing?.id || body?.name || '');
  const agentId = sanitizeAgentId(body?.agent_id || body?.agentId || existing?.agent_id || '');
  const name = String(body?.name || existing?.name || '').trim().slice(0, 96);
  const protocol = String(body?.protocol || existing?.protocol || '').trim().toLowerCase();
  const server = String(body?.server || existing?.server || '').trim().slice(0, 255);
  const port = integerInRange(body?.port ?? existing?.port, 1, 65535, '端口');
  const transport = String(body?.transport || existing?.transport || 'tcp').trim().toLowerCase();
  const sni = String(body?.sni ?? existing?.sni ?? server).trim().slice(0, 255) || server;
  const wsPath = String(body?.ws_path ?? body?.path ?? existing?.ws_path ?? '/').trim().slice(0, 256) || '/';
  const wsHost = String(body?.ws_host ?? existing?.ws_host ?? sni).trim().slice(0, 255) || sni;
  const timeoutMs = integerInRange(body?.timeout_ms ?? existing?.timeout_ms ?? 5000, 1000, 15000, '超时');
  const enabled = normalizeEnabled(body?.enabled, existing?.enabled ?? 1);
  if (!id || id.length > 96) throw new ApiError(400, '代理检测目标 ID 无效');
  if (!agentId) throw new ApiError(400, '必须选择执行检测的 Agent');
  if (!name) throw new ApiError(400, '代理检测目标名称不能为空');
  if (!PROXY_PROTOCOLS.includes(protocol)) throw new ApiError(400, '协议不受支持');
  if (!PROXY_TRANSPORTS.includes(transport)) throw new ApiError(400, '传输方式不受支持');
  if ((protocol === 'socks5' || protocol === 'http') && !['tcp', 'tls'].includes(transport)) throw new ApiError(400, `${protocol.toUpperCase()} 目前只支持 TCP 或 TLS 传输`);
  if (protocol === 'hysteria2' && transport !== 'quic') throw new ApiError(400, 'Hysteria2 必须使用 QUIC');
  if (protocol === 'tuic') throw new ApiError(400, '已识别 TUIC，但当前 Agent 尚未内置 TUIC 真实握手，暂不能保存');
  if (!isRuntimeProxyTargetSupported(protocol, transport)) throw new ApiError(400, '该协议或传输组合当前 Agent 尚未内置真实握手，暂不能保存');
  if (!server || /[\s\u0000-\u001f]/.test(server)) throw new ApiError(400, '代理服务器地址无效');
  if (/[\s\u0000-\u001f]/.test(sni) || /[\s\u0000-\u001f]/.test(wsHost)) throw new ApiError(400, 'SNI 或 WebSocket Host 无效');
  if (!wsPath.startsWith('/') || /[\r\n]/.test(wsPath)) throw new ApiError(400, 'WebSocket 路径必须以 / 开头');
  const secret = normalizeSecret(protocol, body?.secret, existing?.secret || {});
  return { id, agentId, name, protocol, server, port, transport, sni, wsPath, wsHost, timeoutMs, enabled, secret };
}

function normalizeSecret(protocol, value, fallback = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const secret = { ...fallback };
  for (const key of ['uuid', 'username', 'password', 'security', 'cipher', 'plugin', 'plugin_opts', 'flow', 'encryption', 'grpc_service_name', 'h2_path', 'http_upgrade_path', 'obfs', 'obfs_password', 'obfs_host', 'snell_version', 'fingerprint', 'congestion_control', 'alpn']) {
    if (input[key] !== undefined) secret[key] = String(input[key] || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 2048);
  }
  for (const key of ['skip_cert_verify', 'insecure']) {
    if (input[key] !== undefined) secret[key] = input[key] === true || input[key] === 1 || input[key] === '1';
  }
  if (input.alter_id !== undefined) secret.alter_id = integerInRange(input.alter_id, 0, 65535, 'VMess alter_id');
  if (protocol === 'vless' || protocol === 'vmess') {
    const uuid = String(secret.uuid || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid) && !/^[0-9a-f]{32}$/i.test(uuid)) {
      throw new ApiError(400, `${protocol.toUpperCase()} UUID 无效`);
    }
    secret.uuid = uuid;
  }
  if (protocol === 'vmess') {
    secret.security = ['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none'].includes(String(secret.security || 'auto').toLowerCase()) ? String(secret.security || 'auto').toLowerCase() : 'auto';
    secret.alter_id = Number.isInteger(secret.alter_id) ? secret.alter_id : 0;
  }
  if (protocol === 'socks5') {
    secret.username = String(secret.username || '').slice(0, 256);
    secret.password = String(secret.password || '').slice(0, 512);
  }
  if (['trojan', 'hysteria2', 'snell', 'anytls'].includes(protocol) && !String(secret.password || '').trim()) {
    throw new ApiError(400, `${protocol} 凭据不能为空`);
  }
  if (protocol === 'ss' && (!String(secret.cipher || '').trim() || !String(secret.password || '').trim())) {
    throw new ApiError(400, 'Shadowsocks 必须包含加密方式和密码');
  }
  return secret;
}

function resolveLinkBody(body) {
  if (!body?.link) return body || {};
  let items;
  try { items = parseProxyLinks(body.link, { maxItems: 50 }); }
  catch (_) { throw new ApiError(400, '代理分享链接无法解析'); }
  const requestedIndex = body.link_index === undefined || body.link_index === null || body.link_index === ''
    ? 0
    : Number(body.link_index);
  if (!Number.isInteger(requestedIndex) || requestedIndex < 0 || requestedIndex >= items.length) {
    throw new ApiError(400, '代理节点选择无效，请重新解析后选择一个节点');
  }
  if (items.length > 1 && body.link_index === undefined) {
    throw new ApiError(400, '一次只能保存一个代理；请先解析后选择单个节点');
  }
  const item = items[requestedIndex];
  return {
    ...body,
    ...item,
    agent_id: body.agent_id || body.agentId,
    id: body.id || item.name,
    name: body.name || item.name,
    secret: item.secret,
  };
}

async function assertAgentTarget(env, agentId) {
  const row = await env.DB.prepare(`SELECT id, type FROM targets WHERE id = ?`).bind(agentId).first();
  if (!row || row.type !== 'tcp') throw new ApiError(400, '检测 Agent 必须是已配置的 TCP Agent');
}

async function saveProxySecret(env, targetId, agentId, secret, now) {
  const ciphertext = await encryptScopedSecret(JSON.stringify(secret || {}), env, `proxy:${sanitizeAgentId(agentId)}:${sanitizeAgentId(targetId)}`);
  await env.DB.prepare(`INSERT INTO proxy_target_secrets (target_id, agent_id, secret_ciphertext, updated_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(target_id) DO UPDATE SET agent_id = excluded.agent_id, secret_ciphertext = excluded.secret_ciphertext, updated_at = excluded.updated_at`)
    .bind(targetId, agentId, ciphertext, now).run();
}

async function decryptProxySecret(env, targetId, agentId, ciphertext) {
  const result = await decryptScopedSecret(ciphertext, env, `proxy:${sanitizeAgentId(agentId)}:${sanitizeAgentId(targetId)}`);
  if (result.needsMigration) {
    const migrated = await encryptScopedSecret(result.value, env, `proxy:${sanitizeAgentId(agentId)}:${sanitizeAgentId(targetId)}`);
    await env.DB.prepare(`UPDATE proxy_target_secrets SET secret_ciphertext = ?, updated_at = ? WHERE target_id = ?`)
      .bind(migrated, nowSec(), targetId).run().catch(() => {});
  }
  try {
    const parsed = JSON.parse(result.value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    throw new Error('代理检测凭据内容无效');
  }
}

async function getProxyTargetRows(env, agentId, enabledOnly) {
  const normalized = sanitizeAgentId(agentId);
  if (!normalized) return [];
  const result = await env.DB.prepare(`
    SELECT p.*, s.secret_ciphertext
    FROM proxy_targets p
    LEFT JOIN proxy_target_secrets s ON s.target_id = p.id
    WHERE p.agent_id = ? ${enabledOnly ? 'AND p.enabled = 1' : ''}
    ORDER BY p.name LIMIT ?
  `).bind(normalized, MAX_PROXY_TARGETS_PER_AGENT).all();
  return result.results || [];
}

async function secretRowsById(env, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const placeholders = ids.map(() => '?').join(',');
  const result = await env.DB.prepare(`SELECT target_id, secret_ciphertext FROM proxy_target_secrets WHERE target_id IN (${placeholders})`).bind(...ids).all().catch(() => ({ results: [] }));
  for (const row of result.results || []) map.set(String(row.target_id), row);
  return map;
}

function publicProxyRow(row, secretRow) {
  return {
    id: String(row.id || ''), agent_id: String(row.agent_id || ''), agent_name: String(row.agent_name || row.agent_id || ''),
    name: String(row.name || ''), protocol: String(row.protocol || ''), server: String(row.server || ''), port: Number(row.port || 0),
    transport: String(row.transport || 'tcp'), sni: String(row.sni || ''), ws_path: String(row.ws_path || '/'), ws_host: String(row.ws_host || ''),
    enabled: Number(row.enabled || 0), timeout_ms: Number(row.timeout_ms || 5000), created_at: Number(row.created_at || 0), updated_at: Number(row.updated_at || 0),
    secret_configured: Boolean(secretRow?.secret_ciphertext),
    runtime_supported: isRuntimeProxyTargetSupported(String(row.protocol || '').toLowerCase(), String(row.transport || 'tcp').toLowerCase()),
  };
}

function controlProxyRow(row) {
  return {
    id: String(row.id || ''), name: String(row.name || ''), protocol: String(row.protocol || ''), server: String(row.server || ''),
    port: Number(row.port || 0), transport: String(row.transport || 'tcp'), sni: String(row.sni || ''), ws_path: String(row.ws_path || '/'),
    ws_host: String(row.ws_host || ''), timeout_ms: Number(row.timeout_ms || 5000), enabled: Number(row.enabled || 0) === 1,
    _secret_ciphertext: row.secret_ciphertext || null,
  };
}

function integerInRange(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new ApiError(400, `${label}必须是 ${min}-${max} 之间的整数`);
  return number;
}

function normalizeEnabled(value, fallback) {
  if (value === undefined) return Number(fallback) ? 1 : 0;
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  throw new ApiError(400, 'enabled 必须是布尔值');
}
