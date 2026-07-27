// Admin sub-module: D1 schema migrations.
import { dayFromSec, nowSec, parseBoolean, timezoneOffsetMin } from '../utils.js';

let schemaEnsured = false;
let schemaPromise = null;
// Bump this marker whenever an existing installation needs new D1 objects.
const SCHEMA_MARKER = 'schema:worker-v17-20260726-agent-capabilities';

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

export function isMissingAgentCapabilitiesColumn(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return message.includes('no such column: capabilities')
    || message.includes('has no column named capabilities');
}

export async function ensureAgentCapabilitiesColumn(env) {
  await runOptionalSchemaChange(env, `ALTER TABLE agent_metrics_state ADD COLUMN capabilities TEXT`);
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
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS targets (id TEXT PRIMARY KEY, name TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT 'Default', type TEXT NOT NULL CHECK (type IN ('tcp', 'http')), target_host TEXT, target_port INTEGER, url TEXT, method TEXT DEFAULT 'GET', expected_status TEXT DEFAULT '', timeout_ms INTEGER NOT NULL DEFAULT 5000, interval_sec INTEGER NOT NULL DEFAULT 300, probe_region TEXT NOT NULL DEFAULT 'auto', enabled INTEGER NOT NULL DEFAULT 1, no_public_ip INTEGER NOT NULL DEFAULT 0, sort_order INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_checked_at INTEGER, expires_at INTEGER, price REAL, billing_cycle TEXT DEFAULT '', tags TEXT DEFAULT '', location TEXT DEFAULT '', city TEXT DEFAULT '', currency TEXT DEFAULT 'USD', traffic_enabled INTEGER NOT NULL DEFAULT 0, traffic_quota_gb REAL NOT NULL DEFAULT 0, traffic_mode TEXT DEFAULT 'total', traffic_reset_day INTEGER NOT NULL DEFAULT 1, alert_enabled INTEGER NOT NULL DEFAULT 1, alert_expiry_days INTEGER, alert_traffic_remaining_percent REAL, alert_traffic_remaining_gb REAL, provider TEXT DEFAULT '', line_type TEXT DEFAULT '', nq_report TEXT DEFAULT '', nq_updated_at INTEGER)`).run();
  for (const stmt of ['ALTER TABLE targets ADD COLUMN expires_at INTEGER', 'ALTER TABLE targets ADD COLUMN price REAL', 'ALTER TABLE targets ADD COLUMN billing_cycle TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN tags TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN location TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN currency TEXT DEFAULT \'USD\'', 'ALTER TABLE targets ADD COLUMN traffic_enabled INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE targets ADD COLUMN traffic_quota_gb REAL NOT NULL DEFAULT 0', 'ALTER TABLE targets ADD COLUMN traffic_mode TEXT DEFAULT \'total\'', 'ALTER TABLE targets ADD COLUMN traffic_reset_day INTEGER', 'ALTER TABLE targets ADD COLUMN alert_enabled INTEGER NOT NULL DEFAULT 1', 'ALTER TABLE targets ADD COLUMN alert_expiry_days INTEGER', 'ALTER TABLE targets ADD COLUMN alert_traffic_remaining_percent REAL', 'ALTER TABLE targets ADD COLUMN alert_traffic_remaining_gb REAL', 'ALTER TABLE targets ADD COLUMN sort_order INTEGER', 'ALTER TABLE targets ADD COLUMN provider TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN line_type TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN no_public_ip INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE targets ADD COLUMN city TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN nq_report TEXT DEFAULT \'\'', 'ALTER TABLE targets ADD COLUMN nq_updated_at INTEGER']) {
    await runOptionalSchemaChange(env, stmt);
  }
  for (const stmt of [
    'ALTER TABLE targets ADD COLUMN ipv4 TEXT',
    'ALTER TABLE targets ADD COLUMN ipv6 TEXT',
    'ALTER TABLE targets ADD COLUMN location_source TEXT',
    'ALTER TABLE targets ADD COLUMN location_updated_at INTEGER',
    'ALTER TABLE targets ADD COLUMN nq_url TEXT',
    'ALTER TABLE targets ADD COLUMN unlock_data TEXT',
    'ALTER TABLE targets ADD COLUMN unlock_updated_at INTEGER',
  ]) {
    await runOptionalSchemaChange(env, stmt);
  }
  await env.DB.prepare(`UPDATE targets SET traffic_reset_day = CASE WHEN expires_at IS NOT NULL AND expires_at > 0 THEN CAST(strftime('%d', expires_at + ?, 'unixepoch') AS INTEGER) ELSE 1 END WHERE traffic_reset_day IS NULL`)
    .bind(timezoneOffsetMin(env) * 60).run();
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
    pings TEXT,
    capabilities TEXT
  )`).run();
  await runOptionalSchemaChange(env, `ALTER TABLE agent_metrics_state ADD COLUMN agent_version TEXT`);
  await runOptionalSchemaChange(env, `ALTER TABLE agent_metrics_state ADD COLUMN process_count INTEGER`);
  await runOptionalSchemaChange(env, `ALTER TABLE agent_metrics_state ADD COLUMN thread_count INTEGER`);
  await runOptionalSchemaChange(env, `ALTER TABLE agent_metrics_state ADD COLUMN pings TEXT`);
  await ensureAgentCapabilitiesColumn(env);

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS agent_metrics_history (
    agent_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    data TEXT,
    PRIMARY KEY (agent_id, ts)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_history_ts ON agent_metrics_history(agent_id, ts DESC)`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS agent_daily_availability (
    agent_id TEXT NOT NULL,
    day TEXT NOT NULL,
    total_sec INTEGER NOT NULL DEFAULT 0,
    online_sec INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, day)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_availability_day ON agent_daily_availability(day, agent_id)`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS agent_traffic_monthly (
    agent_id TEXT NOT NULL,
    month TEXT NOT NULL,
    rx_bytes INTEGER NOT NULL DEFAULT 0,
    tx_bytes INTEGER NOT NULL DEFAULT 0,
    last_rx_bytes INTEGER,
    last_tx_bytes INTEGER,
    active_day TEXT,
    day_rx_bytes INTEGER NOT NULL DEFAULT 0,
    day_tx_bytes INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, month)
  )`).run();
  for (const stmt of [
    'ALTER TABLE agent_traffic_monthly ADD COLUMN active_day TEXT',
    'ALTER TABLE agent_traffic_monthly ADD COLUMN day_rx_bytes INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE agent_traffic_monthly ADD COLUMN day_tx_bytes INTEGER NOT NULL DEFAULT 0',
  ]) {
    await runOptionalSchemaChange(env, stmt);
  }
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_traffic_month ON agent_traffic_monthly(month)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS agent_traffic_daily (
    agent_id TEXT NOT NULL,
    day TEXT NOT NULL,
    rx_bytes INTEGER NOT NULL DEFAULT 0,
    tx_bytes INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, day)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_traffic_daily_day ON agent_traffic_daily(day, agent_id)`).run();

  // Legacy totals cannot be split retroactively. Preserve the newest total as
  // an upgrade-day entry; subsequent days are recorded precisely.
  const migrationNow = nowSec();
  const migrationDay = dayFromSec(migrationNow, env);
  await env.DB.prepare(`INSERT OR IGNORE INTO agent_traffic_daily (agent_id, day, rx_bytes, tx_bytes, updated_at)
    SELECT m.agent_id, ?, m.rx_bytes, m.tx_bytes, ?
    FROM agent_traffic_monthly m
    WHERE m.updated_at = (SELECT MAX(latest.updated_at) FROM agent_traffic_monthly latest WHERE latest.agent_id = m.agent_id)
      AND (m.rx_bytes > 0 OR m.tx_bytes > 0)`)
    .bind(migrationDay, migrationNow).run();
  await env.DB.prepare(`UPDATE agent_traffic_monthly SET active_day = ?, day_rx_bytes = 0, day_tx_bytes = 0
    WHERE active_day IS NULL
      AND updated_at = (SELECT MAX(latest.updated_at) FROM agent_traffic_monthly latest WHERE latest.agent_id = agent_traffic_monthly.agent_id)`)
    .bind(migrationDay).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ping_targets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    target TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#159754',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER,
    updated_at INTEGER
  )`).run();
  await env.DB.prepare(`ALTER TABLE ping_targets ADD COLUMN color TEXT NOT NULL DEFAULT '#159754'`).run().catch(() => {});

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
    color TEXT NOT NULL DEFAULT '#2e7dd7',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(`ALTER TABLE latency_agents ADD COLUMN color TEXT NOT NULL DEFAULT '#2e7dd7'`).run().catch(() => {});
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS agent_credentials (
    subject_type TEXT NOT NULL CHECK (subject_type IN ('agent', 'latency')),
    subject_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    token_ciphertext TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    PRIMARY KEY (subject_type, subject_id)
  )`).run();
  await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_credentials_hash ON agent_credentials(token_hash)`).run();
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

  // 0.24 introduces explicit node/check ownership while legacy target APIs stay
  // active. IDs are preserved so installed Agents and their credentials remain valid.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    legacy_target_id TEXT UNIQUE,
    name TEXT NOT NULL,
    group_name TEXT NOT NULL DEFAULT 'Default',
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER,
    provider TEXT DEFAULT '',
    provider_custom TEXT DEFAULT '',
    machine_type TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    ipv4 TEXT,
    ipv6 TEXT,
    country_code TEXT DEFAULT '',
    country TEXT DEFAULT '',
    city TEXT DEFAULT '',
    location_source TEXT,
    location_updated_at INTEGER,
    expires_at INTEGER,
    price REAL,
    billing_cycle TEXT DEFAULT '',
    currency TEXT DEFAULT 'USD',
    traffic_enabled INTEGER NOT NULL DEFAULT 0,
    traffic_quota_gb REAL NOT NULL DEFAULT 0,
    traffic_mode TEXT DEFAULT 'total',
    traffic_reset_day INTEGER NOT NULL DEFAULT 1,
    alert_enabled INTEGER NOT NULL DEFAULT 1,
    alert_expiry_days INTEGER,
    alert_traffic_remaining_percent REAL,
    alert_traffic_remaining_gb REAL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_nodes_group_order ON nodes(group_name, sort_order, name)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_nodes_provider ON nodes(provider, name)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS checks (
    id TEXT PRIMARY KEY,
    legacy_target_id TEXT UNIQUE,
    node_id TEXT,
    name TEXT NOT NULL,
    group_name TEXT NOT NULL DEFAULT 'Default',
    type TEXT NOT NULL CHECK (type IN ('tcp', 'http')),
    target_host TEXT,
    target_port INTEGER,
    url TEXT,
    method TEXT DEFAULT 'GET',
    expected_status TEXT DEFAULT '',
    timeout_ms INTEGER NOT NULL DEFAULT 5000,
    interval_sec INTEGER NOT NULL DEFAULT 300,
    probe_region TEXT NOT NULL DEFAULT 'auto',
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_checks_node ON checks(node_id, enabled)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_checks_due ON checks(enabled, interval_sec)`).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO nodes (
    id, legacy_target_id, name, group_name, enabled, sort_order, provider, machine_type, tags,
    ipv4, ipv6, country_code, country, city, location_source, location_updated_at,
    expires_at, price, billing_cycle, currency, traffic_enabled, traffic_quota_gb, traffic_mode,
    traffic_reset_day, alert_enabled, alert_expiry_days, alert_traffic_remaining_percent,
    alert_traffic_remaining_gb, created_at, updated_at
  ) SELECT
    id, id, name, group_name, enabled, sort_order, provider, line_type, tags,
    ipv4, ipv6, CASE WHEN length(location) = 2 THEN upper(location) ELSE '' END,
    location, city, location_source, location_updated_at,
    expires_at, price, billing_cycle, currency, traffic_enabled, traffic_quota_gb, traffic_mode,
    traffic_reset_day, alert_enabled, alert_expiry_days, alert_traffic_remaining_percent,
    alert_traffic_remaining_gb, created_at, updated_at
  FROM targets WHERE type = 'tcp'`).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO checks (
    id, legacy_target_id, node_id, name, group_name, type, target_host, target_port, url,
    method, expected_status, timeout_ms, interval_sec, probe_region, enabled, sort_order,
    created_at, updated_at
  ) SELECT
    id, id, CASE WHEN type = 'tcp' THEN id ELSE NULL END, name, group_name, type,
    target_host, target_port, url, method, expected_status, timeout_ms, interval_sec,
    probe_region, enabled, sort_order, created_at, updated_at
  FROM targets WHERE type = 'http' OR COALESCE(no_public_ip, 0) = 0`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('nodequality', 'ip_unlock')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'expired', 'cancelled')),
    requested_at INTEGER NOT NULL,
    claimed_at INTEGER,
    finished_at INTEGER,
    expires_at INTEGER NOT NULL,
    result TEXT,
    error TEXT,
    output_excerpt TEXT,
    agent_version TEXT
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_claim ON agent_tasks(agent_id, status, requested_at)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_recent ON agent_tasks(requested_at DESC)`).run();
  await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_one_active ON agent_tasks(agent_id) WHERE status IN ('queued', 'running')`).run();
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
