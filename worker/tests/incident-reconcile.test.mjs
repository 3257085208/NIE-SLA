import assert from 'node:assert/strict';
import { reconcileOpenIncidents } from '../src/admin/check-buckets.js';
import { nowSec } from '../src/utils.js';

// The safety net must keep working while raw bucket writes stay off: it reads
// the durable probe buffer first and falls back to the D1 mirror.

const now = nowSec();

function memoryDb({ incidents = [], buckets = [] } = {}) {
  const updates = [];
  return {
    incidents,
    buckets,
    updates,
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async all() {
          if (/FROM incident_events WHERE recovered_at IS NULL/i.test(sql)) return { results: incidents };
          if (/FROM check_buckets WHERE target_id = \?/i.test(sql)) {
            const [targetId, since] = values;
            return { results: buckets.filter(row => row.target_id === targetId && Number(row.checked_at) >= Number(since)) };
          }
          return { results: [] };
        },
        async run() {
          if (/UPDATE incident_events SET recovered_at/i.test(sql)) {
            updates.push({ recoveredAt: Number(values[0]), id: values[1] });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() { return null; },
      };
    },
  };
}

function bufferedEnv(db, points) {
  return {
    DB: db,
    TIMEZONE_OFFSET_MINUTES: '480',
    INTERNAL_CRON_SECRET: 'test-secret',
    PROBE_HISTORY: {
      idFromName: (name) => name,
      get: () => ({
        async fetch() { return Response.json({ ok: true, points }); },
      }),
    },
  };
}

{
  // A fresh buffered success recovers an orphaned incident.
  const db = memoryDb({ incidents: [{ id: 7, target_id: 'vps-a', started_at: now - 86400 }] });
  const env = bufferedEnv(db, [{ checked_at: now - 120, last_ok: 1 }]);
  const result = await reconcileOpenIncidents(env);
  assert.equal(result.changes, 1);
  assert.deepEqual(db.updates, [{ recoveredAt: now - 120, id: 7 }]);
}

{
  // Stale buffered points do not recover; a fresh D1 bucket does.
  const db = memoryDb({
    incidents: [{ id: 8, target_id: 'vps-b', started_at: now - 3600 }],
    buckets: [{ target_id: 'vps-b', checked_at: now - 180, ok: 1, ok_count: 1, total: 1, latency_ms: 10, status_code: 200, error: null, probe_region: 'auto' }],
  });
  const env = bufferedEnv(db, [{ checked_at: now - 7200, last_ok: 1 }]);
  const result = await reconcileOpenIncidents(env);
  assert.equal(result.changes, 1);
  assert.deepEqual(db.updates, [{ recoveredAt: now - 180, id: 8 }]);
}

{
  // No successful probe keeps the incident open.
  const db = memoryDb({ incidents: [{ id: 9, target_id: 'vps-c', started_at: now - 3600 }] });
  const env = bufferedEnv(db, [{ checked_at: now - 120, last_ok: 0, last_error: '连接失败' }]);
  const result = await reconcileOpenIncidents(env);
  assert.equal(result.changes, 0);
  assert.equal(db.updates.length, 0);
}

console.log('incident reconcile tests passed');
