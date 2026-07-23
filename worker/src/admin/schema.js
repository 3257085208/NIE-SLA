// Admin sub-module: D1 schema migrations.
import { parseBoolean } from '../utils.js';

let schemaEnsured = false;
let schemaPromise = null;
const SCHEMA_MARKER = 'schema:worker-v11-20260723-nq';

async function runOptionalSchemaChange(env, statement) {
  try {
    await env.DB.prepare(statement).run();
  } catch (err) {
    if (isAlreadyAppliedSchemaChange(err)) return;
    console.error('schema migration failed:', statement, String(err?.message || err));
    throw err;
  }
}

function isAlreadyAppliedSchemaChange(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return message.includes('duplicate column name') || message.includes('already exists');
}

export async function ensureV6Schema(env) {
  if (schemaEnsured || !env.DB) return;
  if (schemaPromise) { await schemaPromise; return; }
  schemaPromise = (async () => {
  try {
  // Worker isolates are short-lived. Avoid replaying dozens of idempotent DDL
  // statements on every cron invocation once this schema revision is installed.
  const installed = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(SCHEMA_MARKER).first().catch(() => null);
  if (installed?.value === '1') { schemaEnsured = true; return; }
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS targets (id TEXT PRIMARY KEY, name TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT 'Default', type TEXT NOT NULL CHECK (type IN ('tcp', 'http')), target_host TEXT, target_port INTEGER, url TEXT, method TEXT DEFAULT 'GET', expected_status TEXT DEFAULT '', timeout_ms INTEGER NOT NULL DEFAULT 5000, interval_sec INTEGER NOT NULL DEFAULT 300, probe_region TEXT NOT NULL DEFAULT 'auto', enabled INTEGER NOT NULL DEFAULT 1, no_public_ip INTEGER NOT NULL DEFAULT 0, sort_order INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_checked_at INTEGER, expires_at INTEGER, price REAL, billing_cycle TEXT DEFAULT '', tags TEXT DEFAULT '', location TEXT DEFAULT '', city TEXT DEFAULT '', currency TEXT DEFAULT 'USD', traffic_enabled INTEGER NOT NULL DEFAULT 0, traffic_quota_gb REAL NOT NULL DEFAULT 0, traffic_mode TEXT DEFAULT 'total', alert_enabled INTEGER NOT NULL DEFAULT 1, alert_expiry_days INTEGER, alert_traffic_remaining_percent REAL, alert_traffic_remaining_gb REAL, provider TEXT DEFAULT '', line_type TEXT DEFAULT '', nq_report TEXT DEFAULT '', nq_updated_at INTEGER)`).run();
  for (const stmt of ['ALTER TABLE targets ADD COLUMN expires_at INTEGER', 'ALTER TABLE targets ADD COLUMN price REAL', 'ALTER TABLE targets ADD COLUMN billing_cycle TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN tags TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN location TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN currency TEXT DEFAULT \'USD\'', 'ALTER TABLE targets ADD COLUMN traffic_enabled INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE targets ADD COLUMN traffic_quota_gb REAL NOT NULL DEFAULT 0', 'ALTER TABLE targets ADD COLUMN traffic_mode TEXT DEFAULT \'total\'', 'ALTER TABLE targets ADD COLUMN alert_enabled INTEGER NOT NULL DEFAULT 1', 'ALTER TABLE targets ADD COLUMN alert_expiry_days INTEGER', 'ALTER TABLE targets ADD COLUMN alert_traffic_remaining_percent REAL', 'ALTER TABLE targets ADD COLUMN alert_traffic_remaining_gb REAL', 'ALTER TABLE targets ADD COLUMN sort_order INTEGER', 'ALTER TABLE targets ADD COLUMN provider TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN line_type TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN no_public_ip INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE targets ADD COLUMN city TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN nq_report TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN nq_updated_at INTEGER']) {
    await runOptionalSchemaChange(env, stmt);
  }
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_targets_due ON targets(enabled, last_checked_at, interval_sec)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_targets_group ON targets(group_name, name)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_targets_sort_order ON targets(sort_order)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_targets_provider ON targets(provider, name)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_targets_line_type ON targets(line_type, name)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_targets_location ON targets(location, name)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS latest_status (target_id TEXT PRIMARY KEY, checked_at INTEGER NOT NULL, ok INTEGER NOT NULL CHECK (ok IN (0, 1)), latency_ms INTEGER, status_code INTEGER, error TEXT, probe_region TEXT DEFAULT 'auto', cf_colo TEXT, uptime_24h REAL, uptime_7d REAL, avg_latency_24h INTEGER, last_fail_at INTEGER, current_outage_started_at INTEGER, last_recover_at INTEGER, status_changed_at INTEGER)`).run();
  for (const stmt of ['ALTER TABLE latest_status ADD COLUMN probe_region TEXT DEFAULT \'auto\'', 'ALTER TABLE latest_status ADD COLUMN cf_colo TEXT', 'ALTER TABLE latest_status ADD COLUMN uptime_24h REAL', 'ALTER TABLE latest_status ADD COLUMN uptime_7d REAL', 'ALTER TABLE latest_status ADD COLUMN avg_latency_24h INTEGER', 'ALTER TABLE latest_status ADD COLUMN last_fail_at INTEGER', 'ALTER TABLE latest_status ADD COLUMN current_outage_started_at INTEGER', 'ALTER TABLE latest_status ADD COLUMN last_recover_at INTEGER', 'ALTER TABLE latest_status ADD COLUMN status_changed_at INTEGER']) {
    await runOptionalSchemaChange(env, stmt);
  }
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS check_buckets (target_id TEXT NOT NULL, bucket_at INTEGER NOT NULL, day TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, ok_count INTEGER NOT NULL DEFAULT 0, sum_latency_ms INTEGER NOT NULL DEFAULT 0, last_ok INTEGER NOT NULL CHECK (last_ok IN (0, 1)), last_latency_ms INTEGER, last_status_code INTEGER, last_error TEXT, probe_region TEXT DEFAULT 'auto', cf_colo TEXT, PRIMARY KEY (target_id, bucket_at))`).run();
  for (const stmt of ['ALTER TABLE check_buckets ADD COLUMN day TEXT DEFAULT \'\'', 'ALTER TABLE check_buckets ADD COLUMN total INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE check_buckets ADD COLUMN ok_count INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE check_buckets ADD COLUMN sum_latency_ms INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE check_buckets ADD COLUMN last_ok INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE check_buckets ADD COLUMN last_latency_ms INTEGER', 'ALTER TABLE check_buckets ADD COLUMN last_status_code INTEGER', 'ALTER TABLE check_buckets ADD COLUMN last_error TEXT', 'ALTER TABLE check_buckets ADD COLUMN probe_region TEXT DEFAULT \'auto\'', 'ALTER TABLE check_buckets ADD COLUMN cf_colo TEXT']) {
    await runOptionalSchemaChange(env, stmt);
  }
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_check_buckets_day ON check_buckets(day)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_check_buckets_target_time ON check_buckets(target_id, bucket_at DESC)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS incident_events (id TEXT PRIMARY KEY, target_id TEXT NOT NULL, started_at INTEGER NOT NULL, recovered_at INTEGER, last_checked_at INTEGER, start_colo TEXT, recover_colo TEXT, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`).run();
  for (const stmt of ['ALTER TABLE incident_events ADD COLUMN recovered_at INTEGER', 'ALTER TABLE incident_events ADD COLUMN last_checked_at INTEGER', 'ALTER TABLE incident_events ADD COLUMN start_colo TEXT', 'ALTER TABLE incident_events ADD COLUMN recover_colo TEXT', 'ALTER TABLE incident_events ADD COLUMN last_error TEXT']) {
    await runOptionalSchemaChange(env, stmt);
  }
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_incident_target_active ON incident_events(target_id, recovered_at)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_incident_started ON incident_events(started_at DESC)`).run();
  await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_one_active ON incident_events(target_id) WHERE recovered_at IS NULL`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rate_limits (key TEXT NOT NULL, ts INTEGER NOT NULL)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_rate_limits_key_ts ON rate_limits(key, ts)`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS agent_metrics_state (
    agent_id TEXT PRIMARY KEY,
    agent_label TEXT,
    agent_version TEXT,
    updated_at TEXT,
    hostname TEXT,
    cpu_percent REAL,
    memory TEXT,
    load TEXT,
    disk TEXT,
    net TEXT,
    diskio TEXT,
    stats TEXT,
    uptime_sec INTEGER,
    vps_info TEXT,
    process_count INTEGER,
    thread_count INTEGER,
    pings TEXT
  )`).run();
  await runOptionalSchemaChange(env, `ALTER TABLE agent_metrics_state ADD COLUMN agent_version TEXT`);
  await runOptionalSchemaChange(env, `ALTER TABLE agent_metrics_state ADD COLUMN process_count INTEGER`);
  await runOptionalSchemaChange(env, `ALTER TABLE agent_metrics_state ADD COLUMN thread_count INTEGER`);
  await runOptionalSchemaChange(env, `ALTER TABLE agent_metrics_state ADD COLUMN pings TEXT`);

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS agent_metrics_history (
    agent_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    data TEXT,
    PRIMARY KEY (agent_id, ts)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_history_ts ON agent_metrics_history(agent_id, ts DESC)`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS agent_traffic_monthly (
    agent_id TEXT NOT NULL,
    month TEXT NOT NULL,
    rx_bytes INTEGER NOT NULL DEFAULT 0,
    tx_bytes INTEGER NOT NULL DEFAULT 0,
    last_rx_bytes INTEGER,
    last_tx_bytes INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, month)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_traffic_month ON agent_traffic_monthly(month)`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ping_targets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    target TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER,
    updated_at INTEGER
  )`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ping_history (
    target_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    latency_ms REAL,
    ok INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (target_id, agent_id, ts)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ping_history_agent_ts ON ping_history(agent_id, ts DESC)`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS latency_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS latency_results (
    node_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    latency_ms INTEGER,
    ok INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    PRIMARY KEY (node_id, target_id, checked_at)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_latency_results_target_time ON latency_results(target_id, checked_at DESC)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_latency_results_node_time ON latency_results(node_id, checked_at DESC)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS alert_state (
    target_id TEXT NOT NULL,
    rule_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    last_value REAL,
    opened_at INTEGER,
    resolved_at INTEGER,
    last_sent_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (target_id, rule_key)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_alert_state_updated ON alert_state(updated_at DESC)`).run();
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, '1', ?) ON CONFLICT(key) DO UPDATE SET value='1', updated_at=excluded.updated_at`)
    .bind(SCHEMA_MARKER, Math.floor(Date.now() / 1000)).run();
  schemaEnsured = true;
  } catch (e) { schemaPromise = null; throw e; }
  })();
  await schemaPromise;
}

export function shouldEnsureSchemaForRequest(path, method, env) {
  if (method === 'OPTIONS') return false;
  if (path === '/api/colo-echo' || path === '/' || path === '/api/health' || path === '/api/login') return false;
  if (path === '/api/status' || path === '/api/checks') return parseBoolean(env?.ENSURE_SCHEMA_ON_READ, false);
  if (path === '/api/agent/metrics' && method === 'POST') return parseBoolean(env?.ENSURE_SCHEMA_ON_AGENT_WRITE, false);
  return parseBoolean(env?.ENSURE_SCHEMA_ON_REQUEST, false);
}

