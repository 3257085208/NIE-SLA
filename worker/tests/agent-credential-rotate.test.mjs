import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getOrCreateAgentToken, getOrCreateAgentTokenForReinstall } from '../src/agent-credentials.js';

globalThis.crypto ||= webcrypto;

function d1(db) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async run() { const r = db.prepare(sql).run(...values); return { meta: { changes: r.changes } }; },
        async all() { return { results: db.prepare(sql).all(...values) }; },
        async first() { return db.prepare(sql).get(...values) || null; },
      };
    },
  };
}

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(`
  CREATE TABLE agent_credentials (
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    token_hash TEXT,
    token_ciphertext TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    PRIMARY KEY (subject_type, subject_id)
  );
`);
// A legacy credential encrypted with a key that no longer exists.
const brokenCipher = `enc:v1:${Buffer.from(new Uint8Array(28).fill(7)).toString('base64')}`;
sqlite.prepare(`INSERT INTO agent_credentials (subject_type, subject_id, token_hash, token_ciphertext, created_at, updated_at)
  VALUES ('agent', 'vps-x', 'deadbeef', ?, 1, 1)`).run(brokenCipher);

const env = { DB: d1(sqlite), TOTP_ENCRYPTION_KEY: 'rotate-test-material-0123456789abcdef' };

// Default behaviour: refuse to rotate, keep the message about protecting nodes.
await assert.rejects(
  () => getOrCreateAgentToken(env, 'agent', 'vps-x'),
  /无法读取现有节点 Token/,
  'plain reads must not silently rotate credentials',
);

// Re-install paths opt in: a fresh credential is issued and stored.
const rotated = await getOrCreateAgentTokenForReinstall(env, 'agent', 'vps-x');
assert.match(rotated.token, /^nst_[a-f0-9]{64}$/, 'rotation must return a fresh agent token');
assert.equal(rotated.rotated, true, 'rotation must be flagged for the UI');
const row = sqlite.prepare(`SELECT token_hash, token_ciphertext FROM agent_credentials WHERE subject_type = 'agent' AND subject_id = 'vps-x'`).get();
assert.notEqual(row.token_hash, 'deadbeef', 'the stored hash must be replaced');
assert.notEqual(row.token_ciphertext, brokenCipher, 'the ciphertext must be replaced');

// Subsequent reads decrypt the new credential and do not rotate again.
const again = await getOrCreateAgentTokenForReinstall(env, 'agent', 'vps-x');
assert.equal(again.token, rotated.token, 'the rotated token must stay stable afterwards');
assert.equal(Boolean(again.rotated), false, 'no further rotation is needed');

console.log('agent credential rotation tests passed');
