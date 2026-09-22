import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import { importNezhaMigration, previewNezhaMigration } from '../src/admin/migration.js';

const PANEL = 'https://nezha.example.test';
const TOKEN = 'nzp_example_panel_token';
const originalFetch = globalThis.fetch;

const SERVERS = [
  { id: 1, name: 'Tokyo Edge', group_id: 7, hide_for_guest: true, ipv4: '203.0.113.10' },
  { id: 2, name: 'Osaka Edge', group_id: 8, ipv4: ['198.51.100.20:8443', '198.51.100.21'] },
];
const GROUPS = [{ id: 7, name: 'JP' }, { id: 8, name: 'US' }];

function panelFetch({ servers = SERVERS, groups = GROUPS, serverStatus = 200, groupStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, options });
    if (requestUrl === `${PANEL}/api/v1/server`) return Response.json(servers, { status: serverStatus });
    if (requestUrl === `${PANEL}/api/v1/server-group`) return Response.json(groups, { status: groupStatus });
    return new Response('not found', { status: 404 });
  };
  return calls;
}

function migrationRequest(path, body) {
  return new Request(`https://admin.example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://sla.example.test' },
    body: JSON.stringify(body),
  });
}

function memoryDb(initialTargets = []) {
  const targets = initialTargets.map((target) => ({ ...target }));
  const meta = new Map();
  const credentials = new Map();
  const tickets = [];
  return {
    targets,
    meta,
    credentials,
    tickets,
    prepare(sql) {
      const statement = {
        values: [],
        bind(...values) {
          statement.values = values;
          return statement;
        },
        async first() {
          const values = statement.values;
          if (/SELECT value FROM app_meta/i.test(sql)) return meta.has(String(values[0])) ? { value: meta.get(String(values[0])) } : null;
          if (/SELECT token_hash, token_ciphertext FROM agent_credentials/i.test(sql)) return credentials.get(`${values[0]}:${values[1]}`) || null;
          if (/SELECT id, name FROM targets WHERE id = \?/i.test(sql)) {
            const row = targets.find((target) => target.id === values[0]);
            return row ? { id: row.id, name: row.name } : null;
          }
          if (/SELECT \* FROM targets WHERE id = \?/i.test(sql)) {
            const row = targets.find((target) => target.id === values[0]);
            return row ? { ...row } : null;
          }
          if (/SELECT MAX\(sort_order\)/i.test(sql)) {
            const value = targets.reduce((max, target) => Math.max(max, Number(target.sort_order) || 0), 0);
            return { value: value || null };
          }
          return null;
        },
        async all() {
          if (/SELECT id, name FROM targets/i.test(sql)) return { results: targets.map((target) => ({ id: target.id, name: target.name })) };
          if (/SELECT id FROM targets/i.test(sql)) return { results: targets.map((target) => ({ id: target.id })) };
          return { results: [] };
        },
        async run() {
          const values = statement.values;
          if (/INSERT INTO targets/i.test(sql)) {
            targets.push({
              id: values[0], name: values[1], group_name: values[2], type: values[3],
              target_host: values[4], target_port: values[5], url: values[6], method: values[7],
              expected_status: values[8], timeout_ms: values[9], interval_sec: values[10],
              probe_region: values[11], enabled: values[12], no_public_ip: values[13],
              sort_order: values[14], created_at: values[15], updated_at: values[16],
            });
          } else if (/INSERT INTO app_meta/i.test(sql)) {
            meta.set(String(values[0]), String(values[1]));
          } else if (/INSERT OR IGNORE INTO agent_credentials/i.test(sql)) {
            credentials.set(`${values[0]}:${values[1]}`, { token_hash: values[2], token_ciphertext: values[3] });
          } else if (/INSERT INTO agent_install_tickets/i.test(sql)) {
            tickets.push(values);
          }
          return { success: true };
        },
      };
      return statement;
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
      return [];
    },
  };
}

function makeEnv({ targets = [] } = {}) {
  return {
    DB: memoryDb(targets),
    AGENT_TOKEN: 'panel-test-agent-secret',
    PUBLIC_AGENT_INSTALL_BASE: 'https://install.example.test',
    PUBLIC_AGENT_API_BASE: 'https://api.example.test',
  };
}

test('nezha preview lists creatable and existing nodes without leaking the token', async () => {
  const env = makeEnv({ targets: [{ id: 'nezha-2', name: 'Osaka Edge', type: 'tcp' }] });
  const calls = panelFetch();
  try {
    const result = await previewNezhaMigration(
      migrationRequest('/api/admin/migration/nezha/preview', { panel_url: PANEL, token: TOKEN }),
      env,
    );
    assert.equal(result.ok, true);
    assert.equal(result.source, 'nezha');
    assert.deepEqual(result.summary, { total: 2, creatable: 1, existing: 1 });
    assert.deepEqual(result.groups, [{ id: '7', name: 'JP' }, { id: '8', name: 'US' }]);
    assert.deepEqual(result.nodes[0], {
      source_id: '1', name: 'Tokyo Edge', group: 'JP', ip: '203.0.113.10', exists: false, reason: '',
    });
    assert.equal(result.nodes[1].source_id, '2');
    assert.equal(result.nodes[1].group, 'US');
    assert.equal(result.nodes[1].exists, true);
    assert.match(result.nodes[1].reason, /已存在/);
    const serverCall = calls.find((call) => call.url === `${PANEL}/api/v1/server`);
    assert.equal(serverCall.options.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(serverCall.options.redirect, 'manual', 'panel redirects must not replay the credential');
    assert.ok(serverCall.options.signal && typeof serverCall.options.signal.aborted === 'boolean', 'panel requests must be abortable');
    assert.equal(JSON.stringify(result).includes(TOKEN), false, 'the panel token must never be returned');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('nezha preview tolerates wrapped payloads and missing groups', async () => {
  const env = makeEnv();
  panelFetch({
    servers: { code: 0, message: 'success', data: SERVERS },
    groups: { code: 0, message: 'success', data: GROUPS },
    groupStatus: 404,
  });
  try {
    const result = await previewNezhaMigration(
      migrationRequest('/api/admin/migration/nezha/preview', { panel_url: PANEL, token: TOKEN }),
      env,
    );
    assert.equal(result.summary.total, 2);
    assert.equal(result.nodes[0].group, '', 'a missing group endpoint must not fail the preview');
    assert.deepEqual(result.groups, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('nezha import creates targets and returns per-node install commands', async () => {
  const env = makeEnv();
  panelFetch();
  try {
    const result = await importNezhaMigration(
      migrationRequest('/api/admin/migration/nezha/import', {
        panel_url: PANEL,
        token: TOKEN,
        nodes: [
          { source_id: '2', name: 'stale name', group: 'stale', ip: 'stale' },
          { source_id: '1', name: 'Tokyo Edge', group: 'JP', ip: '203.0.113.10' },
        ],
      }),
      env,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.created.map((item) => item.id), ['nezha-2', 'nezha-1']);
    const tokyo = result.created[1];
    assert.match(tokyo.install_command, /https:\/\/api\.example\.test\/api\/agent\/install-script/);
    assert.match(tokyo.install_command, /NIE-SLA target: nezha-1/);
    assert.match(tokyo.install_command, /nsi_[a-f0-9]{48}/);
    assert.match(tokyo.install_command, /sh "\$t" --replace-agent nezha\)$/, 'the one-command migration must stop the old NeZha agent');
    assert.equal(tokyo.install_command.includes(TOKEN), false);
    assert.match(result.created[0].install_command, /NIE-SLA target: nezha-2/);
    assert.match(result.created[0].install_command, /--replace-agent nezha\)$/);

    const storedTokyo = env.DB.targets.find((target) => target.id === 'nezha-1');
    assert.equal(storedTokyo.name, 'Tokyo Edge');
    assert.equal(storedTokyo.group_name, 'JP');
    assert.equal(storedTokyo.type, 'tcp');
    assert.equal(storedTokyo.target_host, '203.0.113.10');
    assert.equal(storedTokyo.target_port, 443);
    assert.equal(storedTokyo.enabled, 1);
    assert.equal(storedTokyo.no_public_ip, 1);
    assert.equal(storedTokyo.interval_sec, 300);
    const storedOsaka = env.DB.targets.find((target) => target.id === 'nezha-2');
    assert.equal(storedOsaka.target_host, '198.51.100.20');
    assert.equal(storedOsaka.target_port, 8443);
    assert.equal(storedOsaka.group_name, 'US');
    assert.equal(env.DB.tickets.length, 2, 'every created target must get its own one-time install ticket');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('nezha import skips existing targets and rejects duplicate or unknown ids', async () => {
  const env = makeEnv({ targets: [{ id: 'nezha-2', name: 'Osaka Edge', type: 'tcp' }] });
  panelFetch();
  try {
    const result = await importNezhaMigration(
      migrationRequest('/api/admin/migration/nezha/import', {
        panel_url: PANEL,
        token: TOKEN,
        nodes: [{ source_id: '2' }, { source_id: '1' }],
      }),
      env,
    );
    assert.deepEqual(result.skipped, [{ source_id: '2', name: 'Osaka Edge', reason: '目标 ID 已存在' }]);
    assert.deepEqual(result.created.map((item) => item.id), ['nezha-1']);
    await assert.rejects(
      () => importNezhaMigration(migrationRequest('/api/admin/migration/nezha/import', {
        panel_url: PANEL,
        token: TOKEN,
        nodes: [{ source_id: '1' }, { source_id: '1' }],
      }), env),
      (error) => error.status === 400 && /重复/.test(error.message),
    );
    await assert.rejects(
      () => importNezhaMigration(migrationRequest('/api/admin/migration/nezha/import', {
        panel_url: PANEL,
        token: TOKEN,
        nodes: [{ source_id: '404' }],
      }), env),
      (error) => error.status === 400 && /未知节点/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('nezha migration rejects insecure panel urls before any network call', async () => {
  const env = makeEnv();
  for (const [panelUrl, expected] of [
    ['http://nezha.example.test', /HTTPS/],
    ['ftp://nezha.example.test', /HTTPS/],
    ['https://user:pass@nezha.example.test', /账号密码/],
    ['https://127.0.0.1', /私有|内部/],
    ['not-a-url', /格式无效/],
  ]) {
    await assert.rejects(
      () => previewNezhaMigration(migrationRequest('/api/admin/migration/nezha/preview', { panel_url: panelUrl, token: TOKEN }), env),
      (error) => error.status === 400 && expected.test(error.message),
      `${panelUrl} must be rejected`,
    );
  }
  assert.equal(globalThis.fetch, originalFetch, 'invalid panel urls must not reach fetch');
});

test('nezha panel 401 and 404 responses map to clear errors', async () => {
  const env = makeEnv();
  panelFetch({ servers: { code: 1, message: 'unauthorized' }, groups: [], serverStatus: 401 });
  try {
    await assert.rejects(
      () => previewNezhaMigration(migrationRequest('/api/admin/migration/nezha/preview', { panel_url: PANEL, token: TOKEN }), env),
      (error) => error.status === 401 && error.message === '面板凭据被拒绝',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  panelFetch({ servers: [], groups: [], serverStatus: 404 });
  try {
    await assert.rejects(
      () => previewNezhaMigration(migrationRequest('/api/admin/migration/nezha/preview', { panel_url: PANEL, token: TOKEN }), env),
      (error) => error.status === 404 && error.message === '接口不存在（请确认版本/路径）',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('migration routes are registered and admin guarded', async () => {
  for (const path of ['/api/admin/migration/nezha/preview', '/api/admin/migration/nezha/import']) {
    const response = await worker.fetch(new Request(`https://api.example.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://sla.example.test' },
      body: '{}',
    }), { ALLOWED_ORIGIN: 'https://sla.example.test' }, {});
    assert.equal(response.status, 401, `${path} must require an admin session`);
    assert.match((await response.json()).error, /管理会话/);
  }
});

test('nezha panel timeout maps to a clear error', async () => {
  const env = makeEnv();
  globalThis.fetch = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  try {
    await assert.rejects(
      () => previewNezhaMigration(migrationRequest('/api/admin/migration/nezha/preview', { panel_url: PANEL, token: TOKEN }), env),
      (error) => error.status === 504 && error.message === '连接面板超时',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
