import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const legacyMarkers = [
  'schema:worker-v26-20260810-quota',
  'schema:worker-v27-next-probe',
  'schema:worker-v28-probe-buffer',
  'schema:worker-v29-agent-task-retention',
  'schema:worker-v30-backroute-task',
  'schema:worker-v31-agent-contacts',
  'schema:worker-v32-proxy-targets',
  'schema:worker-v33-proxy-links',
  'schema:worker-v34-latency-pending',
];
const pingExpectedStatusMarker = 'schema:worker-v35-ping-expected-status';

function makeLegacyDatabase({ hasExpectedStatus = false } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE ping_targets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      target TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#159754',
      ${hasExpectedStatus ? 'expected_status TEXT,' : ''}
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO ping_targets (id, name, target, enabled, created_at, updated_at)
      VALUES ('existing-ping', 'Existing ping', 'https://example.com', 1, 1, 2);
  `);
  const markerInsert = database.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, '1', 1)`);
  for (const marker of legacyMarkers) markerInsert.run(marker);
  return database;
}

function d1(database) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async run() { return database.prepare(sql).run(...values); },
        async all() { return { results: database.prepare(sql).all(...values) }; },
        async first() { return database.prepare(sql).get(...values) || null; },
      };
    },
  };
}

async function migrate(database, importKey) {
  const { ensureV6Schema } = await import(`../src/admin/schema.js?${importKey}`);
  await ensureV6Schema({ DB: d1(database) });
}

const database = makeLegacyDatabase();
await migrate(database, 'missing-expected-status-column');
assert.ok(
  database.prepare(`PRAGMA table_info(ping_targets)`).all().some(column => column.name === 'expected_status'),
  'legacy schemas with v26-v34 markers must receive ping_targets.expected_status',
);
assert.equal(
  database.prepare(`SELECT name FROM ping_targets WHERE id = 'existing-ping'`).get()?.name,
  'Existing ping',
  'the additive migration must preserve existing ping targets',
);
assert.equal(
  database.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(pingExpectedStatusMarker)?.value,
  '1',
);
// The new column must accept the write paths that previously failed in production.
database.prepare(`UPDATE ping_targets SET expected_status = '200,301' WHERE id = 'existing-ping'`).run();
assert.equal(
  database.prepare(`SELECT expected_status FROM ping_targets WHERE id = 'existing-ping'`).get()?.expected_status,
  '200,301',
);

const alreadyMigratedDatabase = makeLegacyDatabase({ hasExpectedStatus: true });
await migrate(alreadyMigratedDatabase, 'already-present-expected-status-column');
assert.equal(
  alreadyMigratedDatabase.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(pingExpectedStatusMarker)?.value,
  '1',
  'a preexisting column without its marker must be accepted and marked complete',
);

console.log('ping expected_status schema migration passed');
