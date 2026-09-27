import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyTargetSortOrder } from '../src/admin/target-order.js';

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
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function ranks(db) {
  return Object.fromEntries(
    db.prepare(`SELECT id, sort_order FROM targets ORDER BY sort_order`).all().map((row) => [row.id, row.sort_order]),
  );
}

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`
  CREATE TABLE targets (id TEXT PRIMARY KEY, sort_order INTEGER, group_name TEXT, name TEXT);
  INSERT INTO targets (id, sort_order, group_name, name) VALUES
    ('a', 0, 'VPS', 'A'), ('b', 1, 'VPS', 'B'), ('c', 2, 'VPS', 'C'), ('d', 3, 'VPS', 'D');
`);
const env = { DB: d1(sqlite) };

// Taking the top slot pushes the current 1..3 down one rank each.
await applyTargetSortOrder(env, 'd', 1);
assert.deepEqual(ranks(sqlite), { d: 0, a: 1, b: 2, c: 3 }, 'setting rank 1 must shift occupants down');

// Inserting into the middle keeps the ranking dense (no gaps).
await applyTargetSortOrder(env, 'a', 3);
assert.deepEqual(ranks(sqlite), { d: 0, b: 1, a: 2, c: 3 }, 'setting rank 3 must renumber densely');

// A rank beyond the list length appends at the end.
await applyTargetSortOrder(env, 'b', 10);
assert.deepEqual(ranks(sqlite), { d: 0, a: 1, c: 2, b: 3 }, 'an out-of-range rank must append at the end');

// Unranked (NULL) targets sort last and get numbered by the rewrite.
sqlite.prepare(`INSERT INTO targets (id, sort_order, group_name, name) VALUES ('e', NULL, 'VPS', 'E')`).run();
await applyTargetSortOrder(env, 'c', 1);
assert.deepEqual(ranks(sqlite), { c: 0, d: 1, a: 2, b: 3, e: 4 }, 'NULL ranks must be appended then numbered');

// The update path wires parsing, validation and the shift together.
const source = readFileSync(new URL('../src/admin/targets.js', import.meta.url), 'utf8');
assert.match(source, /body\?\.sort_order !== undefined[\s\S]*?排序序号必须在 1-500 之间/, 'updateTargetRecord must validate manual ranks');
assert.match(source, /if \(nextSortOrder !== null\) await applyTargetSortOrder\(env, id, nextSortOrder\);/, 'updateTargetRecord must apply the insert-and-shift helper');

console.log('target order shift tests passed');
