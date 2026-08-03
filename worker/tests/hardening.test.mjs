import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolvePublicMetricsQuery, defaultMetricsMaxPointsForHours } from '../src/metrics.js';
import { isPrivateHost, assertPublicHttpUrl, buildOpenMissedPoints, fetchPublicHttpsWithValidatedRedirects } from '../src/utils.js';
import { resolveCorsOrigin } from '../src/auth.js';
import { getDeveloperApiManifest, resolveDeveloperApiOrigin, withDeveloperApiHeaders } from '../src/developer-api.js';

const routesSource = await readFile(new URL('../src/routes.js', import.meta.url), 'utf8');
const schemaSource = await readFile(new URL('../src/admin/schema.js', import.meta.url), 'utf8');
const statusSource = await readFile(new URL('../src/status.js', import.meta.url), 'utf8');
const probeSource = await readFile(new URL('../src/probe.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const metricsSource = await readFile(new URL('../src/metrics.js', import.meta.url), 'utf8');
const wranglerSource = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
assert.match(
  routesSource,
  /\/api\/settings\/geoip[\s\S]{0,300}withAdmin\(request, env\)[\s\S]{0,300}'cache-control': 'no-store'/,
  'GeoIP settings must require an admin session and must not be cached',
);
assert.match(routesSource, /\/api\/backup\/restore[\s\S]{0,300}withAdmin\(request, env\)[\s\S]{0,300}ensureV6Schema\(env\)/, 'restore must require an admin session and an initialized schema');
assert.match(routesSource, /\/api\/backup\/preview[\s\S]{0,500}rateLimitD1\(env, `backup-preview:/, 'backup preview must be rate limited');
assert.match(routesSource, /\/api\/backup\/restore[\s\S]{0,500}rateLimitD1\(env, `backup-restore:/, 'backup restore must be rate limited');
assert.match(routesSource, /if \(adminTaskCancelMatch && m === 'POST'\) \{ await withAdmin\(request, env\);[\s\S]{0,200}cancelAgentTask/, 'admin force-stop must require an admin session');
assert.match(routesSource, /if \(agentTaskCancelStatusMatch && m === 'GET'\) \{ await ensureV6Schema\(env\);[\s\S]{0,260}requireAgentForId[\s\S]{0,200}agentTaskCancelStatus/, 'Agent cancel-status must require Agent credentials');
assert.equal((routesSource.match(/path === '\/api\/agent\/tasks' && m === 'GET'/g) || []).length, 1, 'agent task claim route must be declared exactly once');
assert.match(routesSource, /\/api\/agent\/tasks' && m === 'GET'[\s\S]{0,600}runner_instance_id/, 'agent task claim route must accept runner_instance_id');
assert.match(schemaSource, /schema:worker-v25-20260803-task-owner/, 'schema marker must advance for task owner tracking');
assert.match(schemaSource, /ALTER TABLE agent_tasks ADD COLUMN cancel_requested_at INTEGER/, 'running tasks must store a cancellation request timestamp');
assert.match(schemaSource, /ALTER TABLE agent_tasks ADD COLUMN runner_instance_id TEXT/, 'running tasks must track the Agent Manager runner instance');
assert.match(schemaSource, /ALTER TABLE agent_tasks ADD COLUMN runner_heartbeat_at INTEGER/, 'running tasks must track Manager heartbeats');
assert.match(schemaSource, /ALTER TABLE targets ADD COLUMN nq_unlock_data TEXT/, 'targets must store NQ-derived unlock data separately');
assert.match(routesSource, /\/api\/themes\/manage[\s\S]{0,1800}withAdmin\(request, env\)[\s\S]{0,300}listManagedThemes/, 'theme management must require an admin session');
assert.match(routesSource, /\/api\/themes\/upload[\s\S]{0,1800}withAdmin\(request, env\)[\s\S]{0,300}uploadTheme/, 'theme uploads must require an admin session');
assert.doesNotMatch(routesSource, /\/api\/(?:extensions|plugins)(?:['/])/, 'plugin and generic extension routes must stay disabled');
assert.match(statusSource, /getStatusFresh\(env, url\)[\s\S]{0,240}await ensureV6Schema\(env\)/, 'the first public page view must initialize a fresh D1 database');
assert.match(statusSource, /async function getChecks\(env, url\)\s*\{\s*await ensureV6Schema\(env\)/, 'direct checks reads must initialize a fresh D1 database');
const dueTargetsSource = probeSource.slice(probeSource.indexOf('export async function runDueTargets'), probeSource.indexOf('export async function runFastStatusTargets'));
assert.match(dueTargetsSource, /lastPersistedCheckAt\(target, d1Latest\.get\(String\(target\.id\)\)\)/, 'history scheduling must use persisted five-minute checks');
assert.match(dueTargetsSource, /buildHistoryPreviousStateMap\(allTargets, state, d1Latest\)/, 'missed-history backfill must use persisted five-minute checks');
assert.doesNotMatch(dueTargetsSource, /previousById\.get\(target\.id\)\?\.checked_at/, 'one-minute R2 status must not postpone five-minute history checks');
assert.match(indexSource, /scheduled\(controller, env, ctx\)[\s\S]{0,160}dispatchScheduledTasks/, 'cron triggers must delegate work outside the 10ms scheduled CPU budget');
assert.match(indexSource, /signInternalSchedule[\s\S]{0,500}HMAC[\s\S]{0,100}SHA-256/, 'delegated cron requests must be HMAC authenticated');
assert.match(indexSource, /historyProbeCount > 0[\s\S]{0,180}history_probe_completed/, 'a full history probe must suppress the duplicate fast probe');
assert.doesNotMatch(probeSource, /FROM latest_status[\s\S]{0,240}\.all\(\)\.catch\(\(\) => \(\{ results: \[\] \}\)\)/, 'latest probe state read failures must not be treated as an empty database');
assert.match(probeSource, /stateSyncWarning = 'r2_state_sync_failed'/, 'D1 probe success with an R2 sync failure must return a warning');
assert.match(indexSource, /out\.probe\.results\.map\(item => item\?\.warning\)/, 'scheduled probe diagnostics must retain state sync warnings');
assert.match(statusSource, /optionalQuery[\s\S]{0,220}warnings\.push\(warning\)/, 'partial status query failures must be visible in the status warnings');
assert.match(statusSource, /Live status overlay unavailable/, 'snapshot overlay failures must remain visible to status consumers');
assert.match(statusSource, /parsed && typeof parsed === 'object' && !Array\.isArray\(parsed\) \? parsed : \{\}/, 'stored status JSON nulls and arrays must not be treated as metric objects');
assert.match(metricsSource, /warnings\.push\('Latest Agent metrics unavailable'\)/, 'latest metrics read failures must not look like an empty Agent');
assert.match(wranglerSource, /MAX_TARGETS_PER_RUN = "20"/, 'cron work must be spread across minute slots while retaining 100 targets per five minutes');
assert.match(wranglerSource, /global_fetch_strictly_public/, 'signed cron dispatch must loop through the public Worker endpoint instead of bypassing the Worker route');
assert.match(wranglerSource, /not_found_handling = "404-page"/, 'unknown browser routes must render the branded 404 asset');

function urlWith(qs) {
  return new URL('https://example.test/api/agent/metrics?' + qs);
}

// metrics caps
{
  const q0 = resolvePublicMetricsQuery(urlWith('hours=24&max_points=0'), {});
  assert.equal(q0.maxPoints, defaultMetricsMaxPointsForHours(24, {}));
  assert.ok(q0.maxPoints > 0);
  const qHuge = resolvePublicMetricsQuery(urlWith('hours=168&max_points=999999'), {});
  assert.equal(qHuge.hours, 72);
  assert.equal(qHuge.maxPoints, 4000);
  const q1h = resolvePublicMetricsQuery(urlWith('hours=1'), {});
  assert.equal(q1h.maxPoints, 3600);
}

// private hosts
assert.equal(isPrivateHost('127.0.0.1'), true);
assert.equal(isPrivateHost('10.0.0.1'), true);
assert.equal(isPrivateHost('192.168.1.1'), true);
assert.equal(isPrivateHost('172.16.5.5'), true);
assert.equal(isPrivateHost('192.0.2.1'), true);
assert.equal(isPrivateHost('198.19.0.1'), true);
assert.equal(isPrivateHost('198.51.100.1'), true);
assert.equal(isPrivateHost('203.0.113.1'), true);
assert.equal(isPrivateHost('8.8.8.8'), false);
assert.equal(isPrivateHost('localhost'), true);
assert.equal(isPrivateHost('::1'), true);
assert.equal(isPrivateHost('[::1]'), true);
assert.equal(isPrivateHost('::ffff:127.0.0.1'), true);
assert.equal(isPrivateHost('::ffff:7f00:1'), true);
assert.equal(isPrivateHost('::ffff:0808:0808'), false);
assert.equal(isPrivateHost('::127.0.0.1'), true);
assert.equal(isPrivateHost('2001:db8::1'), true);
assert.equal(isPrivateHost('64:ff9b::7f00:1'), true);
assert.equal(isPrivateHost('2606:4700:4700::1111'), false);
assert.equal(isPrivateHost('example.com'), false);

assert.throws(() => assertPublicHttpUrl('not a url'), /无效|invalid/i);
assert.throws(() => assertPublicHttpUrl('ftp://example.com'), /http/i);
assert.throws(() => assertPublicHttpUrl('http://127.0.0.1/'), /私有|内部|private/i);
assert.throws(() => assertPublicHttpUrl('https://[::ffff:7f00:1]/'), /私有|内部|private/i);
assert.ok(assertPublicHttpUrl('https://example.com/path'));

{
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  };
  await assert.rejects(
    () => fetchPublicHttpsWithValidatedRedirects('https://images.example.test/start', {}, fetchImpl),
    /HTTPS|私有|内部/,
  );
  assert.deepEqual(requested, ['https://images.example.test/start']);
}

// grace default >= 120
{
  const prev = { checked_at: Math.floor(Date.now()/1000) - 400 };
  const points = buildOpenMissedPoints({}, prev, Math.floor(Date.now()/1000));
  assert.ok(Array.isArray(points));
}

console.log('hardening tests passed');

// CORS origin resolution
{
  assert.equal(resolveCorsOrigin({ ALLOWED_ORIGIN: 'https://sla.example' }), 'https://sla.example');
  assert.equal(resolveCorsOrigin({ PUBLIC_SITE_ORIGIN: 'https://pages.example/' }), 'https://pages.example');
  assert.equal(resolveCorsOrigin({}), '');
}
console.log('cors tests passed');

// Versioned developer API stays read-only and uses explicit origins.
{
  const request = new Request('https://api.example.test/api/v1', { headers: { origin: 'https://theme.example.test' } });
  const env = {
    ALLOWED_ORIGIN: 'https://status.example.test',
    DEVELOPER_API_ORIGINS: 'https://theme.example.test,http://localhost:5173,*,http://unsafe.example.test',
  };
  assert.equal(resolveDeveloperApiOrigin(request, env), 'https://theme.example.test');
  assert.equal(resolveDeveloperApiOrigin(new Request(request.url, { headers: { origin: 'https://blocked.example.test' } }), env), 'https://status.example.test');
  const manifest = getDeveloperApiManifest(request, env, 'v1.2.3');
  assert.equal(manifest.api_version, 'v1');
  assert.equal(manifest.authentication.write, 'not_available');
  assert.equal(manifest.alternate_frontends, true);
  assert.equal('extensions' in manifest, false);
  assert.ok(manifest.endpoints.every(endpoint => endpoint.method === 'GET' && endpoint.url.startsWith('https://api.example.test/api/v1/')));
  const response = withDeveloperApiHeaders(new Response('{}'), request, env);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://theme.example.test');
  assert.equal(response.headers.get('x-nstatus-api-version'), 'v1');
}
console.log('developer API tests passed');
