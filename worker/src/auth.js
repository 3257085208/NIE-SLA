import { sha256Hex } from './utils.js';

export function requireAdmin(request, env) {
  const configured = env.ADMIN_TOKEN;
  if (!configured) throw new ApiError(500, 'Authentication not configured');
  const token = bearerToken(request);
  if (!token || !constantTimeEqual(token, configured)) throw new ApiError(401, 'Unauthorized');
}

export function requireAgent(request, env) {
  const configured = env.AGENT_TOKEN;
  if (!configured) throw new ApiError(500, 'Authentication not configured');
  const token = bearerToken(request);
  if (!token || !constantTimeEqual(token, configured)) throw new ApiError(401, 'Unauthorized');
}

export async function requireAgentForId(request, env, agentId) {
  const configured = String(env.AGENT_TOKEN || '').trim();
  if (!configured) throw new ApiError(500, 'Authentication not configured');
  const token = bearerToken(request);
  if (!token) throw new ApiError(401, 'Unauthorized');
  if (constantTimeEqual(token, configured)) return { type: 'global' };
  const scoped = await agentScopedToken(env, agentId);
  if (scoped && constantTimeEqual(token, scoped)) return { type: 'scoped', agent_id: String(agentId || '') };
  throw new ApiError(401, 'Unauthorized');
}

export async function requireAnyAgent(request, env) {
  const configured = String(env.AGENT_TOKEN || '').trim();
  if (!configured) throw new ApiError(500, 'Authentication not configured');
  const token = bearerToken(request);
  if (!token) throw new ApiError(401, 'Unauthorized');
  if (constantTimeEqual(token, configured)) return { type: 'global' };
  if (!env.DB) throw new ApiError(401, 'Unauthorized');
  const rows = await env.DB.prepare(`SELECT id FROM targets WHERE enabled = 1`).all().catch(() => ({ results: [] }));
  for (const row of rows.results || []) {
    const scoped = await agentScopedToken(env, row.id);
    if (scoped && constantTimeEqual(token, scoped)) return { type: 'scoped', agent_id: String(row.id || '') };
  }
  throw new ApiError(401, 'Unauthorized');
}

export async function agentScopedToken(env, agentId) {
  const configured = String(env.AGENT_TOKEN || '').trim();
  const id = String(agentId || '').trim();
  if (!configured || !id) return '';
  return `nst_${(await sha256Hex(`${configured}:${id}`)).slice(0, 48)}`;
}

export function bearerToken(request) {
  const auth = request.headers.get('authorization') || '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
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
  if (contentLength > maxBytes) throw new ApiError(413, 'Request body too large');
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Body must be a JSON object');
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, `Invalid JSON body: ${err.message}`);
  }
}

export function json(data, status = 200, env = null, extraHeaders = null) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'access-control-allow-origin': env?.ALLOWED_ORIGIN || '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization,x-admin-session,x-totp-code', 'access-control-max-age': '86400', ...(extraHeaders || {}) } });
}

export function corsPreflight(env) {
  const origin = env?.ALLOWED_ORIGIN || '*';
  return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization,x-admin-session,x-totp-code', 'access-control-max-age': '86400' } });
}
