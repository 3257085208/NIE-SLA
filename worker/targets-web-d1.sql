CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT 'Default',
  type TEXT NOT NULL CHECK (type IN ('tcp','http')),
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
  updated_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  expires_at INTEGER,
  price REAL,
  billing_cycle TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  location TEXT DEFAULT '',
  currency TEXT DEFAULT 'USD',
  traffic_enabled INTEGER NOT NULL DEFAULT 0,
  traffic_quota_gb REAL NOT NULL DEFAULT 0,
  traffic_mode TEXT DEFAULT 'total',
  alert_enabled INTEGER NOT NULL DEFAULT 1,
  alert_expiry_days INTEGER,
  alert_traffic_remaining_percent REAL,
  alert_traffic_remaining_gb REAL
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS incident_events (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  recovered_at INTEGER,
  last_checked_at INTEGER,
  start_colo TEXT,
  recover_colo TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_state (
  target_id TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  last_value REAL,
  opened_at INTEGER,
  resolved_at INTEGER,
  last_sent_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (target_id, rule_key)
);

CREATE INDEX IF NOT EXISTS idx_targets_group ON targets(group_name, name);
CREATE INDEX IF NOT EXISTS idx_incident_target_active ON incident_events(target_id, recovered_at);
CREATE INDEX IF NOT EXISTS idx_incident_started ON incident_events(started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_one_active ON incident_events(target_id) WHERE recovered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alert_state_updated ON alert_state(updated_at DESC);

-- This file intentionally contains schema only.
-- Do not commit real VPS IP addresses, private hostnames, or personal domains here.
-- Seed targets should be added through the admin panel, D1 console, or private .sql files ignored by git.

SELECT COUNT(*) AS target_count FROM targets;
