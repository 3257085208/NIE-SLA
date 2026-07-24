import { sanitizeAgentId, sha256Hex } from './utils.js';

export function requireAgent(request, env) {
  const configured = env.AGENT_TOKEN;
  if (!configured) throw new ApiError(500, '未配置身份验证');
  const token = bearerToken(request);
  if (!token || !constantTimeEqual(token, configured)) throw new ApiError(401, '未授权');
}

export async function requireAgentForId(request, env, agentId) {
  const configured = String(env.AGENT_TOKEN || '').trim();
  if (!configured) throw new ApiError(500, '未配置身份验证');
  const id = String(agentId || '').trim();
  if (!id || !env.DB) throw new ApiError(401, '未授权');
  let target = await env.DB.prepare(`SELECT id FROM targets WHERE id = ? AND enabled = 1`).bind(id).first().catch(() => null);
  if (!target) {
    const rows = await env.DB.prepare(`SELECT id FROM targets WHERE enabled = 1`).all().catch(() => ({ results: [] }));
    target = (rows.results || []).find(row => sanitizeAgentId(row.id) === id) || null;
  }
  if (!target) throw new ApiError(401, 'Agent 目标不存在或已禁用');
  const token = bearerToken(request);
  if (!token) throw new ApiError(401, '未授权');
  if (constantTimeEqual(token, configured)) return { type: 'global' };
  const scoped = await agentScopedToken(env, id);
  if (scoped && constantTimeEqual(token, scoped)) return { type: 'scoped', agent_id: id };
  throw new ApiError(401, '未授权');
}

export async function requireAnyAgent(request, env) {
  const configured = String(env.AGENT_TOKEN || '').trim();
  if (!configured) throw new ApiError(500, '未配置身份验证');
  const token = bearerToken(request);
  if (!token) throw new ApiError(401, '未授权');
  if (constantTimeEqual(token, configured)) return { type: 'global' };
  if (!env.DB) throw new ApiError(401, '未授权');
  const rows = await env.DB.prepare(`SELECT id FROM targets WHERE enabled = 1`).all().catch(() => ({ results: [] }));
  for (const row of rows.results || []) {
    const scoped = await agentScopedToken(env, row.id);
    if (scoped && constantTimeEqual(token, scoped)) return { type: 'scoped', agent_id: String(row.id || '') };
  }
  throw new ApiError(401, '未授权');
}

export async function requireAgentIdentity(request, env, agentId) {
  const configured = String(env.AGENT_TOKEN || '').trim();
  if (!configured) throw new ApiError(500, '未配置身份验证');
  const id = sanitizeAgentId(String(agentId || '').trim());
  if (!String(agentId || '').trim() || !id) throw new ApiError(401, '缺少有效的 Agent ID');
  const token = bearerToken(request);
  if (!token) throw new ApiError(401, '未授权');
  if (constantTimeEqual(token, configured)) return { type: 'global', agent_id: id };
  const scoped = await agentScopedToken(env, id);
  if (scoped && constantTimeEqual(token, scoped)) return { type: 'scoped', agent_id: id };
  throw new ApiError(401, '未授权');
}

export async function agentScopedToken(env, agentId) {
  const configured = String(env.AGENT_TOKEN || '').trim();
  const id = String(agentId || '').trim();
  if (!configured || !id) return '';
  return `nst_${(await sha256Hex(`${configured}:${id}`)).slice(0, 48)}`;
}

export async function requireLatencyAgentForId(request, env, nodeId) {
  const id = sanitizeAgentId(nodeId);
  if (!id || !env.DB) throw new ApiError(401, 'Latency 节点不存在或已禁用');
  const node = await env.DB.prepare(`SELECT id FROM latency_agents WHERE id = ? AND enabled = 1`).bind(id).first().catch(() => null);
  if (!node) throw new ApiError(401, 'Latency 节点不存在或已禁用');
  const token = bearerToken(request);
  const globalToken = String(env.AGENT_TOKEN || '').trim();
  if (!globalToken) throw new ApiError(500, '未配置身份验证');
  if (token && constantTimeEqual(token, globalToken)) return { type: 'global', node_id: id };
  const scoped = await latencyAgentScopedToken(env, id);
  if (token && scoped && constantTimeEqual(token, scoped)) return { type: 'scoped', node_id: id };
  throw new ApiError(401, '未授权');
}

export async function latencyAgentScopedToken(env, nodeId) {
  return agentScopedToken(env, `latency:${sanitizeAgentId(nodeId)}`);
}

export function bearerToken(request) {
  const auth = request.headers.get('authorization') || '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
}

/** Prefer explicit ALLOWED_ORIGIN; never default open CORS in production configs. */
export function resolveCorsOrigin(env) {
  const allowed = String(env?.ALLOWED_ORIGIN || '').trim();
  if (allowed) return allowed;
  const site = String(env?.PUBLIC_SITE_ORIGIN || env?.PUBLIC_PAGES_ORIGIN || '').trim();
  if (site) return site.replace(/\/+$/, '');
  const worker = String(env?.PUBLIC_WORKER_URL || '').trim();
  if (worker) {
    try { return new URL(worker).origin; } catch (_) {}
  }
  return '';
}

export function constantTimeEqual(a, b) {
  const left = String(a || ''), right = String(b || '');
  let diff = left.length ^ right.length;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return diff === 0;
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function safeJson(request, maxBytes = 256_000) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new ApiError(413, '请求内容过大');
  try {
    let text = '';
    if (request.body) {
      const reader = request.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new ApiError(413, '请求内容过大');
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }
    if (!text.trim()) return {};
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('请求内容必须是 JSON 对象');
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, `JSON 请求内容无效：${err.message}`);
  }
}

export function json(data, status = 200, env = null, extraHeaders = null) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'access-control-allow-origin': resolveCorsOrigin(env) || 'null', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization,x-admin-session,x-totp-code,x-extension-filename,x-extension-sha256', 'access-control-max-age': '86400', ...(extraHeaders || {}) } });
}

export function corsPreflight(env) {
  const origin = resolveCorsOrigin(env) || 'null';
  return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization,x-admin-session,x-totp-code,x-extension-filename,x-extension-sha256', 'access-control-max-age': '86400' } });
}
