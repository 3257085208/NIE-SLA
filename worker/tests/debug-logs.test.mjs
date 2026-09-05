import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  cleanupDebugLogs,
  debugClientIp,
  debugSummary,
  getDebugLogSummary,
  listDebugLogs,
  recordDebugLog,
  sanitizeDebugLogEntry,
  shouldLogDebugOperation,
} from '../src/admin/debug-logs.js';
import { ensureV6Schema } from '../src/admin/schema.js';

const database = new DatabaseSync(':memory:');
await ensureV6Schema({ DB: d1(database) });
const columns = database.prepare(`PRAGMA table_info(debug_logs)`).all().map(row => row.name);
for (const column of ['id', 'ts', 'level', 'ip', 'method', 'path', 'actor', 'summary', 'status', 'ref']) {
  assert.ok(columns.includes(column), `debug_logs missing column: ${column}`);
}

const now = Math.floor(Date.now() / 1000);
const env = { DB: d1(database) };
await recordDebugLog(env, {
  ts: now,
  ip: '198.51.100.7',
  method: 'post',
  path: '/api/targets?token=secret',
  actor: 'owner@example',
  summary: '探针配置',
  status: 201,
  ref: 'target-a',
});
const listed = await listDebugLogs(env, new URL('https://status.example/api/debug/logs?limit=10'));
assert.equal(listed.logs.length, 1);
assert.equal(listed.logs[0].method, 'POST');
assert.equal(listed.logs[0].path, '/api/targets');
assert.equal(listed.logs[0].ip, '198.51.100.7');
assert.equal(JSON.stringify(listed).includes('token'), false);

await recordDebugLog(env, {
  ts: now - 31 * 86400,
  ip: '198.51.100.8',
  method: 'GET',
  path: '/api/stats',
  actor: 'admin',
  summary: 'old log',
  status: 200,
});
const cleanup = await cleanupDebugLogs(env, 30);
assert.equal(cleanup.deleted, 1);
const afterCleanup = await listDebugLogs(env);
assert.equal(afterCleanup.logs.length, 1);
assert.equal(afterCleanup.logs[0].ip, '198.51.100.7');

assert.equal(shouldLogDebugOperation('/api/auth/login', 'POST'), true);
assert.equal(shouldLogDebugOperation('/api/auth/login', 'POST', true), true, 'login failures must be logged');
assert.equal(shouldLogDebugOperation('/api/totp/verify', 'POST'), true);
assert.equal(shouldLogDebugOperation('/api/status', 'GET'), false);
assert.equal(shouldLogDebugOperation('/api/debug/logs', 'GET'), false);
assert.equal(shouldLogDebugOperation('/api/debug/usage-summary', 'GET'), false);
assert.equal(shouldLogDebugOperation('/api/agent/tasks', 'GET'), false, 'agent polls must not be logged');
assert.equal(shouldLogDebugOperation('/api/agent/tasks', 'POST', true), true, 'task failures must be logged');
assert.equal(shouldLogDebugOperation('/api/agent/tasks', 'POST'), false, 'successful task completions must not be logged');
assert.equal(shouldLogDebugOperation('/api/agent/tasks/task-1', 'POST', true), true);
assert.equal(shouldLogDebugOperation('/api/agent/tasks/task-1', 'POST'), false);
assert.equal(shouldLogDebugOperation('/api/targets', 'PATCH', true), false, 'admin CRUD failures stay out of debug logs');
assert.equal(shouldLogDebugOperation('/api/agent/metrics', 'POST'), false);
assert.equal(debugSummary('/api/targets', 'PATCH'), '探针配置');
assert.equal(
  debugClientIp(new Request('https://status.example/api/targets', { headers: { 'cf-connecting-ip': '203.0.113.9' } })),
  '203.0.113.9',
);

await recordDebugLog(env, { ts: now - 10, method: 'GET', path: '/api/agent/tasks', status: 200 });
await recordDebugLog(env, { ts: now - 20, method: 'POST', path: '/api/agent/tasks/task-1', status: 200 });
await recordDebugLog(env, { ts: now - 30, method: 'GET', path: '/api/agent-tasks', status: 200 });
await recordDebugLog(env, { ts: now - 40, method: 'PATCH', path: '/api/targets/target-1', status: 500 });
const summary = await getDebugLogSummary(env, new URL(`https://status.example/api/debug/usage-summary?from=${now - 3600}&to=${now}`));
assert.equal(summary.total, 4);
assert.equal(summary.route_counts.agent_tasks, 1);
assert.equal(summary.route_counts.agent_task_action, 1);
assert.equal(summary.route_counts.admin_agent_tasks, 1);
assert.equal(summary.route_counts.other_debug, 1);
assert.deepEqual(summary.status_counts, { '200': 3, '500': 1 });
assert.equal(summary.query.statements, 1);
assert.equal(summary.query.raw_rows_returned, 0);
assert.equal(summary.query.aggregate_rows_returned, 4);
assert.equal(summary.complete, true);
assert.equal(summary.groups.some((group) => 'path' in group || 'ip' in group || 'actor' in group), false);
const queryPlan = database.prepare(`EXPLAIN QUERY PLAN SELECT id FROM debug_logs WHERE ts >= ? AND ts < ?`).all(now - 3600, now);
assert.match(queryPlan.map((row) => row.detail).join(' '), /idx_debug_logs_ts/);
const unavailableSummary = await getDebugLogSummary({}, new URL('https://status.example/api/debug/usage-summary'));
assert.equal(unavailableSummary.available, false);
assert.equal(unavailableSummary.complete, false);
assert.equal(unavailableSummary.query.statements, 0);

const clean = sanitizeDebugLogEntry({
  method: ' delete ',
  path: '/api/backup/restore?admin_session=abc',
  actor: 'a\nb',
  summary: 'x'.repeat(500),
  status: 500,
});
assert.equal(clean.method, 'DELETE');
assert.equal(clean.path, '/api/backup/restore');
assert.equal(JSON.stringify(clean).includes('admin_session'), false);
assert.equal(clean.summary.length, 300);

const routes = await readFile(new URL('../src/routes.js', import.meta.url), 'utf8');
assert.match(
  routes,
  /\/api\/debug\/logs[\s\S]{0,300}withAdmin\(request, env\)[\s\S]{0,300}listDebugLogs\(env, url\)[\s\S]{0,300}'cache-control': 'no-store'/,
  'debug log listing must require an admin session and must not be cached',
);
assert.match(
  routes,
  /\/api\/debug\/usage-summary[\s\S]{0,300}rateLimitByIp\(request, env, 6, 300, \{ bestEffort: true, keyPrefix: 'debug-usage-summary' \}\)[\s\S]{0,300}withUsageSummaryAccess\(request, env\)[\s\S]{0,300}getDebugLogSummary\(env, url\)[\s\S]{0,300}one-bounded-d1-aggregate/,
  'debug usage summary must have an in-memory limit, require its narrow access gate, and expose its bounded cost',
);
assert.match(
  routes,
  /!isAgentApiPath\(path\) && path !== '\/api\/debug\/usage-summary'/,
  'the nsu_ summary read must bypass the generic Bearer D1 rate-limit write because it has its own stricter gate',
);
assert.match(
  routes,
  /async function withUsageSummaryAccess[\s\S]{0,900}withAdmin\(request, env\)[\s\S]{0,900}usageSummaryBearerToken\(request\)[\s\S]{0,900}validateUsageSummaryAccess\(env, token\)/,
  'the narrow debug credential must remain separate from generic administrator authentication',
);
assert.match(
  routes,
  /\/api\/debug\/usage-access-token[\s\S]{0,350}withAdmin\(request, env\)[\s\S]{0,350}getUsageSummaryAccessStatus[\s\S]{0,120}\/api\/debug\/usage-access-token[\s\S]{0,350}withAdmin\(request, env\)[\s\S]{0,350}createUsageSummaryAccess/,
  'usage credential lifecycle routes must require a full administrator session',
);
assert.doesNotMatch(routes, /recordDebugLog\(env,[\s\S]{0,200}(?:authorization|x-admin-session)/i, 'debug logging must never capture auth headers');
const index = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
assert.match(index, /debug_log_cleanup[\s\S]{0,160}cleanupDebugLogs\(env\)/, 'hourly maintenance must clean debug logs');

console.log('debug operation log tests passed');

function d1(db) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async run() { const result = db.prepare(sql).run(...values); return { meta: { changes: Number(result.changes || 0) }, success: true }; },
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
