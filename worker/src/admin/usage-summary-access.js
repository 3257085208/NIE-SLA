import { ApiError, constantTimeEqual } from '../auth.js';
import { nowSec, sha256Hex } from '../utils.js';
import { getMeta, setMeta } from './settings.js';

const ACCESS_KEY = 'usage_summary_access_v1';
const TOKEN_PREFIX = 'nsu_';
const TOKEN_PATTERN = /^nsu_[a-f0-9]{64}$/;
export const USAGE_SUMMARY_ACCESS_SCOPE = 'debug-usage-summary:read';
export const USAGE_SUMMARY_ACCESS_TTL_SEC = 24 * 60 * 60;
export const MAX_USAGE_SUMMARY_ACCESS_TOKENS = 3;

function requireDatabase(env) {
  if (!env?.DB) throw new ApiError(500, '用量只读凭据需要 D1 数据库');
}

function normalizedEntries(raw, now = nowSec()) {
  let parsed = [];
  try { parsed = raw ? JSON.parse(raw) : []; } catch (_) {}
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => ({
      token_hash: String(entry?.token_hash || ''),
      expires_at: Math.floor(Number(entry?.expires_at || 0)),
      created_at: Math.floor(Number(entry?.created_at || 0)),
      issued_order: Math.floor(Number(entry?.issued_order || entry?.created_at || 0)),
    }))
    .filter((entry) => /^[a-f0-9]{64}$/.test(entry.token_hash)
      && Number.isFinite(entry.expires_at)
      && entry.expires_at > now
      && Number.isFinite(entry.created_at)
      && entry.created_at >= 0
      && Number.isFinite(entry.issued_order)
      && entry.issued_order >= 0)
    .sort((left, right) => left.issued_order - right.issued_order
      || left.created_at - right.created_at
      || left.expires_at - right.expires_at
      || left.token_hash.localeCompare(right.token_hash))
    .slice(-MAX_USAGE_SUMMARY_ACCESS_TOKENS);
}

async function activeEntries(env, now = nowSec()) {
  requireDatabase(env);
  return normalizedEntries(await getMeta(env, ACCESS_KEY), now);
}

function newAccessToken() {
  return `${TOKEN_PREFIX}${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
}

function statusFromEntries(entries) {
  const latestExpiresAt = entries.reduce((latest, entry) => Math.max(latest, Number(entry.expires_at || 0)), 0);
  return {
    ok: true,
    scope: USAGE_SUMMARY_ACCESS_SCOPE,
    ttl_sec: USAGE_SUMMARY_ACCESS_TTL_SEC,
    max_active_tokens: MAX_USAGE_SUMMARY_ACCESS_TOKENS,
    active_count: entries.length,
    latest_expires_at: latestExpiresAt || null,
  };
}

export function usageSummaryBearerToken(request) {
  const authorization = String(request?.headers?.get?.('authorization') || '').trim();
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  const token = match?.[1] || '';
  return TOKEN_PATTERN.test(token) ? token : '';
}

export async function createUsageSummaryAccess(env) {
  const now = nowSec();
  const entries = await activeEntries(env, now);
  const issuedOrder = entries.reduce((latest, entry) => Math.max(latest, Number(entry.issued_order || 0)), 0) + 1;
  const accessToken = newAccessToken();
  const expiresAt = now + USAGE_SUMMARY_ACCESS_TTL_SEC;
  entries.push({
    token_hash: await sha256Hex(accessToken),
    created_at: now,
    issued_order: issuedOrder,
    expires_at: expiresAt,
  });
  entries.sort((left, right) => left.issued_order - right.issued_order
    || left.created_at - right.created_at
    || left.expires_at - right.expires_at
    || left.token_hash.localeCompare(right.token_hash));
  const kept = entries.slice(-MAX_USAGE_SUMMARY_ACCESS_TOKENS);
  await setMeta(env, ACCESS_KEY, JSON.stringify(kept));
  return {
    ...statusFromEntries(kept),
    access_token: accessToken,
    expires_at: expiresAt,
  };
}

export async function getUsageSummaryAccessStatus(env) {
  return statusFromEntries(await activeEntries(env));
}

export async function revokeUsageSummaryAccess(env) {
  const entries = await activeEntries(env);
  await env.DB.prepare('DELETE FROM app_meta WHERE key = ?').bind(ACCESS_KEY).run();
  return {
    ...statusFromEntries([]),
    revoked_count: entries.length,
  };
}

export async function validateUsageSummaryAccess(env, token) {
  const presented = String(token || '').trim();
  if (!TOKEN_PATTERN.test(presented) || !env?.DB) return { valid: false, expires_at: null };
  const presentedHash = await sha256Hex(presented);
  for (const entry of await activeEntries(env)) {
    if (constantTimeEqual(entry.token_hash, presentedHash)) {
      return { valid: true, expires_at: entry.expires_at, scope: USAGE_SUMMARY_ACCESS_SCOPE };
    }
  }
  return { valid: false, expires_at: null };
}
