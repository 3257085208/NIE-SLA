// Admin barrel module — re-exports all admin sub-module functions.
// Each sub-module handles a specific domain; this file keeps the
// original public API compatible with existing callers.

// Schema
export { ensureV6Schema, shouldEnsureSchemaForRequest } from './admin/schema.js';

// Settings, meta, exchange rates
export { getMeta, setMeta, getPublicSettings, updatePublicSettings, getAgentUpdatePolicy, fetchExchangeRates, getExchangeRates, hasOwn } from './admin/settings.js';

// Target CRUD, probes, agent targets
export { listTargets, createTarget, updateTarget, reorderTargets, deleteTarget, probeNow, getAgentTargets } from './admin/targets.js';

// Agent results
export { submitAgentResults } from './admin/agent-results.js';

// Ping targets
export { getPingTargets, createPingTarget, updatePingTarget, deletePingTarget, submitAgentPings, getAgentPings } from './admin/ping-targets.js';

// Sync
export { syncEnvTargets, syncEnvTargetsMaybe } from './admin/sync.js';

// Archive & incidents & stats
export { archiveDay, archiveYesterdayOncePerLocalDay, getRecentIncidents, getStats } from './admin/archive.js';

// Check buckets (D1 write layer)
export { upsertLatestStatus, writeIncidentEvent, touchActiveIncident, upsertTargetLastCheckedAt, upsertCheckBucket, readCheckBuckets, readCheckBucketDaySummary, getCheckBucketSummaries, checkBucketSummaryQueryPlan, applyProbeWriteBatch, cleanupOldCheckBuckets, cleanupVolatileHistory } from './admin/check-buckets.js';

// Install command
export { getAgentInstallCommand } from './admin/install-command.js';

// Diagnostics
export { getLatencyHealth } from './admin/latency-health.js';
