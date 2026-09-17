import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { getRetentionHours, updateRetentionConfig, normalizeRetentionHours, RETENTION_MIN_HOURS, RETENTION_MAX_HOURS } from '../src/admin/retention.js';
import { invalidateSharedConfig } from '../src/config-cache.js';

assert.equal(RETENTION_MIN_HOURS, 72);
assert.equal(RETENTION_MAX_HOURS, 720);

assert.equal(normalizeRetentionHours(72), 72);
assert.equal(normalizeRetentionHours(720), 720);
assert.equal(normalizeRetentionHours(2000), 72, 'out-of-range values fall back to the default');
assert.equal(normalizeRetentionHours(10), 72, 'below-minimum values fall back to the default');
assert.equal(normalizeRetentionHours('not-a-number'), 72);
assert.equal(normalizeRetentionHours(500), 500);

function memoryEnv() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  return {
    sqlite,
    DB: {
      prepare(sql) {
        return {
          args: [],
          bind(...args) { this.args = args; return this; },
          async first() {
            if (/SELECT value FROM app_meta/i.test(sql)) {
              const row = sqlite.prepare('SELECT value FROM app_meta WHERE key = ?').get(this.args[0]);
              return row ? { value: row.value } : null;
            }
            return null;
          },
          async run() {
            if (/INSERT INTO app_meta/i.test(sql)) {
              sqlite.prepare('INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
                .run(this.args[0], this.args[1], this.args[2]);
            }
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };
}

assert.equal(await getRetentionHours({ AGENT_METRICS_R2_RETENTION_HOURS: '168' }), 168, 'env fallback is honoured');
await invalidateSharedConfig('agent_retention_hours');
const env = memoryEnv();
assert.equal(await getRetentionHours(env), 72, 'defaults to 72h without stored config');

const saved = await updateRetentionConfig(new Request('https://example.test', { method: 'PATCH', body: JSON.stringify({ retention_hours: 336 }) }), env);
assert.equal(saved.ok, true);
assert.equal(saved.retention_hours, 336);
assert.equal(saved.external_storage_recommended, true, 'raising above 72h recommends external storage');
assert.equal(env.sqlite.prepare(`SELECT value FROM app_meta WHERE key = 'agent_retention_hours'`).get().value, '336');
assert.equal(await getRetentionHours(env), 336, 'stored value is returned after the write invalidated the cache');

await updateRetentionConfig(new Request('https://example.test', { method: 'PATCH', body: JSON.stringify({ retention_hours: 72 }) }), env);
assert.equal((await getRetentionHours(env)), 72);
assert.equal((await updateRetentionConfig(new Request('https://example.test', { method: 'PATCH', body: JSON.stringify({ retention_hours: 72 }) }), env)).external_storage_recommended, false);

await assert.rejects(() => updateRetentionConfig(new Request('https://example.test', { method: 'PATCH', body: JSON.stringify({ retention_hours: 48 }) }), env), /72-720/);
await assert.rejects(() => updateRetentionConfig(new Request('https://example.test', { method: 'PATCH', body: JSON.stringify({ retention_hours: 721 }) }), env), /72-720/);
await assert.rejects(() => updateRetentionConfig(new Request('https://example.test', { method: 'PATCH', body: JSON.stringify({ retention_hours: 90.5 }) }), env), /72-720/);

env.sqlite.prepare(`INSERT OR REPLACE INTO app_meta (key, value, updated_at) VALUES ('agent_retention_hours', '9999', 1)`).run();
await invalidateSharedConfig('agent_retention_hours');
assert.equal(await getRetentionHours(env), 72, 'out-of-range stored values are ignored');

console.log('retention configuration tests passed');
