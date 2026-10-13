import { nowSec } from '../utils.js';

const MAX_PROXY_TARGETS_PER_AGENT = 100;
const PROXY_CHECK_STAGES = new Set(['config', 'connect', 'handshake', 'canary', 'runtime', 'failed']);
const PROXY_CHECK_ERRORS = new Set(['timeout', 'auth_failed', 'unsupported', 'handshake_failed', 'canary_failed', 'invalid_config', 'runtime_failed']);

function normalizeProtocolToken(value) {
  const token = String(value || '').trim().toLowerCase();
  return /^[a-z][a-z0-9-]{0,31}$/.test(token) ? token : '';
}

// Public status only receives the latest result, never proxy configuration.
// Keep this normalizer here so both D1 state and buffered DO state have the
// same bounded, credential-free shape at the public boundary.
export function normalizePublicProxyChecks(value, now = nowSec()) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_PROXY_TARGETS_PER_AGENT).flatMap((item) => {
    const id = String(item?.target_id || item?.id || '').trim().slice(0, 128);
    const protocol = normalizeProtocolToken(item?.protocol);
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

// The public status page needs to distinguish "configured, waiting for the
// first Agent result" from "no proxy target configured".  Keep this metadata
// deliberately smaller than the admin/control rows: endpoint and credential
// fields must never cross the public boundary.
export function normalizePublicProxyTargets(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PROXY_TARGETS_PER_AGENT).flatMap((item) => {
    const id = String(item?.target_id || item?.id || '').trim().slice(0, 128);
    const protocol = normalizeProtocolToken(item?.protocol);
    const transport = normalizeProtocolToken(item?.transport || 'tcp');
    if (!id || !protocol || !transport) return [];
    return [{
      target_id: id,
      name: String(item?.name || id).trim().slice(0, 96),
      protocol,
      transport,
    }];
  });
}

// Proxy target management was retired: the Agent control channel keeps
// answering with an empty target set so existing Agents converge to
// "no proxy targets" without erroring, and the admin/v1 APIs no longer
// expose proxy configuration at all.
export async function getAgentProxyTargets() {
  return [];
}

export async function getCachedProxyControl() {
  return [];
}

export async function getProxyControlRows() {
  return [];
}
