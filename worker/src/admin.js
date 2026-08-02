// Admin barrel module — re-exports all admin sub-module functions.
// Each sub-module handles a specific domain; this file keeps the
// original public API compatible with existing callers.

// Schema
export { ensureV6Schema, shouldEnsureSchemaForRequest } from './admin/schema.js';

// Settings, meta, exchange rates
export { getMeta, setMeta, getPublicSettings, updatePublicSettings, getAgentUpdatePolicy, fetchExchangeRates, getExchangeRates, normalizeCurrency, convertPriceToCny, SUPPORTED_CURRENCIES, hasOwn } from './admin/settings.js';

// Target CRUD, probes, agent targets
export { listTargets, createTarget, updateTarget, bulkUpdateTargets, reorderTargets, deleteTarget, probeNow, getAgentTargets } from './admin/targets.js';

// Agent results
export { submitAgentResults } from './admin/agent-results.js';

// Ping targets
export { getPingTargets, createPingTarget, updatePingTarget, deletePingTarget, submitAgentPings, getAgentPings } from './admin/ping-targets.js';
export { updatePingConfig } from './ping-config.js';

// Sync
export { syncEnvTargets, syncEnvTargetsMaybe } from './admin/sync.js';

// Archive & incidents & stats
export { archiveDay, archiveYesterdayOncePerLocalDay, getRecentIncidents, getStats } from './admin/archive.js';

// Check buckets (D1 write layer)
export { upsertLatestStatus, writeIncidentEvent, touchActiveIncident, upsertTargetLastCheckedAt, upsertCheckBucket, readCheckBuckets, readCheckBucketDaySummary, getCheckBucketSummaries, checkBucketSummaryQueryPlan, applyProbeWriteBatch, cleanupOldCheckBuckets, cleanupVolatileHistory } from './admin/check-buckets.js';

// Debug operation logs
export { cleanupDebugLogs, debugClientIp, debugSummary, listDebugLogs, recordDebugLog, sanitizeDebugLogEntry, shouldLogDebugOperation } from './admin/debug-logs.js';

// Install command
export { getAgentInstallCommand, getAgentInstallScript } from './admin/install-command.js';

// Diagnostics
export { getLatencyHealth } from './admin/latency-health.js';

// Independent external Latency nodes
export { listLatencyAgents, createLatencyAgent, updateLatencyAgent, deleteLatencyAgent, getLatencyAgentInstallCommand, getLatencyAgentInstallScript, getLatencyAgentUpdatePolicy, getLatencyAgentTargets, submitLatencyAgentResults, getPublicLatency, getLatestExternalLatencyByTarget } from './admin/latency-agents.js';

// Fixed Agent actions, automatic GeoIP, and migration backups.
export { AGENT_TASK_ACTIONS, createAgentTask, createAgentTasks, listAgentTasks, claimAgentTask, completeAgentTask, cancelAgentTask, normalizeTaskResult } from './admin/agent-tasks.js';
export { GEOIP_PROVIDERS, getGeoIpSettings, updateGeoIpSettings, getAgentRuntimeConfig, submitAgentLocation, validateCustomGeoIpUrl } from './admin/agent-location.js';
export { exportBackup, previewBackup, restoreBackup, createRestoreSnapshot } from './admin/backup.js';
