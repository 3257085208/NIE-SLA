import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureV6Schema } from '../src/admin/schema.js';

const database = new DatabaseSync(':memory:');
database.exec(`
  CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  INSERT INTO app_meta VALUES ('schema:worker-v17-20260726-agent-capabilities', '1', 1);
  CREATE TABLE ping_targets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    target TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE latency_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

await ensureV6Schema({ DB: d1(database) });

assert.ok(database.prepare(`PRAGMA table_info(ping_targets)`).all().some(column => column.name === 'color'));
assert.ok(database.prepare(`PRAGMA table_info(latency_agents)`).all().some(column => column.name === 'color'));
assert.ok(database.prepare(`PRAGMA table_info(agent_install_tickets)`).all().some(column => column.name === 'expires_at'));
assert.ok(database.prepare(`PRAGMA table_info(agent_tasks)`).all().some(column => column.name === 'cancel_requested_at'));
assert.ok(database.prepare(`PRAGMA table_info(agent_tasks)`).all().some(column => column.name === 'runner_instance_id'));
assert.ok(database.prepare(`PRAGMA table_info(agent_tasks)`).all().some(column => column.name === 'runner_heartbeat_at'));
assert.ok(database.prepare(`PRAGMA table_info(targets)`).all().some(column => column.name === 'nq_unlock_data'));
assert.ok(database.prepare(`PRAGMA table_info(targets)`).all().some(column => column.name === 'nq_unlock_updated_at'));
assert.equal(
  database.prepare(`SELECT value FROM app_meta WHERE key = 'schema:worker-v26-20260810-quota'`).get()?.value,
  '1',
);
const debugColumns = database.prepare(`PRAGMA table_info(debug_logs)`).all().map(column => column.name);
for (const column of ['id', 'ts', 'level', 'ip', 'method', 'path', 'actor', 'summary', 'status', 'ref']) {
  assert.ok(debugColumns.includes(column), `debug_logs missing column: ${column}`);
}
const debugIndexes = database.prepare(`PRAGMA index_list(debug_logs)`).all().map(index => index.name);
assert.ok(debugIndexes.includes('idx_debug_logs_ts'), 'debug_logs must keep a time index');
assert.ok(debugIndexes.includes('idx_debug_logs_actor_ts'), 'debug_logs must keep an actor/time index');

console.log('legacy chart color schema migration passed');

function d1(db) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async run() { return db.prepare(sql).run(...values); },
        async all() { return { results: db.prepare(sql).all(...values) }; },
        async first() { return db.prepare(sql).get(...values) || null; },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}
