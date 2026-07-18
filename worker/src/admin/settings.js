// Admin sub-module: settings, meta, and exchange rates.
import { nowSec, clamp, parseBoolean, sha256Hex } from '../utils.js';
import { safeJson } from '../auth.js';

// ── Meta ─────────────────────────────────────────────────────────────────────

export async function getMeta(env, key) {
  const row = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(key).first();
  return row?.value ?? null;
}

export async function setMeta(env, key, value) {
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(key, String(value), nowSec()).run();
}

// ── Exchange rates ─────────────────────────────────────────────────────────

export async function fetchExchangeRates(env) {
  if (!env.DB) return;
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/CNY', { headers: { 'User-Agent': 'NStatus/1.0' } });
    if (!res.ok) return;
    const data = await res.json();
    if (data?.rates) {
      await setMeta(env, 'exchange_rates', JSON.stringify(data.rates));
      await setMeta(env, 'exchange_rates_updated', String(nowSec()));
    }
  } catch (_) {}
}

export async function getExchangeRates(env) {
  try {
    const raw = await getMeta(env, 'exchange_rates');
    const updated = Number(await getMeta(env, 'exchange_rates_updated') || 0);
    if (!raw || updated < nowSec() - 86400) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

// ── Settings ────────────────────────────────────────────────────────────────

const FRONTEND_THEMES = new Set(['classic', 'cards']);

function normalizeFrontendTheme(value) {
  const theme = String(value || 'classic').trim().toLowerCase();
  return FRONTEND_THEMES.has(theme) ? theme : 'classic';
}

export function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

export async function getPublicSettings(env) {
  let saved = null;
  let autoUpdate = null;
  try { saved = await getMeta(env, 'frontend_theme'); } catch (_) {}
  try { autoUpdate = await getMeta(env, 'agent_auto_update'); } catch (_) {}
  const frontendTheme = normalizeFrontendTheme(saved || env.PUBLIC_FRONTEND_THEME || 'classic');
  const { trafficPeriod } = await import('../traffic.js');
  return {
    ok: true,
    frontend_theme: frontendTheme,
    agent_auto_update: parseBoolean(autoUpdate ?? env.AGENT_AUTO_UPDATE_DEFAULT, false),
    traffic: trafficPeriod(env),
    themes: [
      { id: 'classic', name: '原版列表' },
      { id: 'cards', name: '卡片风格' },
    ],
  };
}

export async function updatePublicSettings(request, env) {
  const body = await safeJson(request);
  if (hasOwn(body, 'frontend_theme') || hasOwn(body, 'theme')) {
    await setMeta(env, 'frontend_theme', normalizeFrontendTheme(body?.frontend_theme ?? body?.theme));
  }
  if (hasOwn(body, 'agent_auto_update')) {
    await setMeta(env, 'agent_auto_update', parseBoolean(body.agent_auto_update, false) ? 'true' : 'false');
  }
  return getPublicSettings(env);
}

export async function getAgentUpdatePolicy(env) {
  const settings = await getPublicSettings(env);
  const release = await loadAgentRelease(env).catch(() => null);
  return {
    ok: true,
    auto_update: settings.agent_auto_update,
    check_interval_sec: clamp(Number(env.AGENT_UPDATE_CHECK_SEC || 3600), 900, 86400),
    ...(release || {}),
  };
}

async function loadAgentRelease(env) {
  const downloadBase = String(env.AGENT_DOWNLOAD_BASE || env.PUBLIC_AGENT_INSTALL_BASE || '').trim().replace(/\/+$/, '');
  if (!downloadBase.startsWith('https://')) throw new Error('AGENT_DOWNLOAD_BASE must use HTTPS');
  const [versionResponse, manifestResponse] = await Promise.all([
    fetch(`${downloadBase}/bin/VERSION`, { cache: 'no-store' }),
    fetch(`${downloadBase}/bin/SHA256SUMS`, { cache: 'no-store' }),
  ]);
  if (!versionResponse.ok || !manifestResponse.ok) throw new Error('agent release metadata is unavailable');
  const version = String(await versionResponse.text()).trim();
  if (!/^v?\d+\.\d+\.\d+$/.test(version)) throw new Error('invalid agent release version');
  const manifest = await manifestResponse.text();
  if (!manifest.trim()) throw new Error('empty agent checksum manifest');
  return {
    latest_version: version.startsWith('v') ? version : `v${version}`,
    download_base: downloadBase,
    manifest_sha256: await sha256Hex(manifest),
  };
}
