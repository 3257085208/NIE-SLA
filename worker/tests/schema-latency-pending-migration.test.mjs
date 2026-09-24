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
];
const pendingMarker = 'schema:worker-v34-latency-pending';

function makeLegacyDatabase({ hasPendingColumn = false } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE latency_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#2e7dd7',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_seen_at INTEGER,
      latest_results TEXT,
      ${hasPendingColumn ? 'pending_results TEXT,' : ''}
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO latency_agents (id, name, created_at, updated_at) VALUES ('existing-agent', 'Existing agent', 1, 2);
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
await migrate(database, 'missing-pending-column');
assert.ok(
  database.prepare(`PRAGMA table_info(latency_agents)`).all().some(column => column.name === 'pending_results'),
  'legacy schemas with v26-v33 markers must receive pending_results',
);
assert.equal(
  database.prepare(`SELECT name FROM latency_agents WHERE id = 'existing-agent'`).get()?.name,
  'Existing agent',
  'the additive migration must preserve existing latency agents',
);
assert.equal(database.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(pendingMarker)?.value, '1');

const alreadyMigratedDatabase = makeLegacyDatabase({ hasPendingColumn: true });
await migrate(alreadyMigratedDatabase, 'already-present-column');
assert.equal(
  alreadyMigratedDatabase.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(pendingMarker)?.value,
  '1',
  'a preexisting column without its marker must be accepted and marked complete',
);

console.log('latency pending schema migration passed');
