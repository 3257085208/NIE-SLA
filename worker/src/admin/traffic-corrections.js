import { ApiError } from '../auth.js';
import { getMeta, setMeta } from './settings.js';
import { sanitizeAgentId } from '../utils.js';

const KEY_PREFIX = 'traffic_corr:';

function normalizeGb(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return 0;
  return Math.round(n * 1024 * 1024 * 1024);
}

function keyOf(agentId) {
  return `${KEY_PREFIX}${sanitizeAgentId(agentId)}`;
}

export async function getTrafficCorrection(env, agentId) {
  const id = sanitizeAgentId(agentId);
  if (!id) return null;
  try {
    const raw = await getMeta(env, keyOf(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const rx = Number(parsed?.rx_bytes);
    const tx = Number(parsed?.tx_bytes);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) return null;
    return { rx_bytes: Math.trunc(rx), tx_bytes: Math.trunc(tx) };
  } catch (_) {
    return null;
  }
}

export async function listTrafficCorrections(env) {
  const rows = await env.DB.prepare(`SELECT key, value FROM app_meta WHERE key LIKE ?`).bind(`${KEY_PREFIX}%`).all();
  const out = {};
  for (const row of rows.results || []) {
    try {
      const parsed = JSON.parse(row.value);
      out[String(row.key).slice(KEY_PREFIX.length)] = parsed;
    } catch (_) {}
  }
  return out;
}

export async function saveTrafficCorrection(env, agentId, rxGb, txGb) {
  const id = sanitizeAgentId(agentId);
  if (!id) throw new ApiError(400, 'Agent ID 无效');
  const rx = normalizeGb(rxGb);
  const tx = normalizeGb(txGb);
  if (!rx && !tx) {
    await env.DB.prepare(`DELETE FROM app_meta WHERE key = ?`).bind(keyOf(id)).run();
    return { ok: true, cleared: true, agent_id: id };
  }
  await setMeta(env, keyOf(id), JSON.stringify({ rx_bytes: rx, tx_bytes: tx, updated_at: Math.floor(Date.now() / 1000) }));
  return { ok: true, agent_id: id, rx_bytes: rx, tx_bytes: tx };
}

export async function getTrafficCorrectionsMap(env) {
  const all = await listTrafficCorrections(env);
  return all;
}
