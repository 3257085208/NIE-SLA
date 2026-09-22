import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import { importNodeGetMigration, previewNodeGetMigration } from '../src/admin/migration.js';

const PANEL = 'https://nodeget.example.test';
const API_KEY = 'ngt_example_api_key';
const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';
const originalFetch = globalThis.fetch;

function panelFetch({ api = { jsonrpc: '2.0', id: 1, result: [UUID_1, UUID_2] }, apiStatus = 200, rpc = null, rpcStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, options });
    if (requestUrl === `${PANEL}/api`) return Response.json(api, { status: apiStatus });
    if (requestUrl === `${PANEL}/api/rpc`) return Response.json(rpc ?? api, { status: rpcStatus });
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

test('nodeget preview posts the uuid list rpc and flags uuids used as names', async () => {
  const env = makeEnv({ targets: [{ id: `nodeget-${UUID_2}`, name: UUID_2, type: 'tcp' }] });
  const calls = panelFetch();
  try {
    const result = await previewNodeGetMigration(
      migrationRequest('/api/admin/migration/nodeget/preview', { panel_url: PANEL, token: API_KEY }),
      env,
    );
    assert.equal(result.ok, true);
    assert.equal(result.source, 'nodeget');
    assert.deepEqual(result.summary, { total: 2, creatable: 1, existing: 1 });
    assert.equal(result.name_hint, 'NodeGet 仅返回节点 UUID，名称需导入后补');
    assert.deepEqual(result.nodes[0], {
      source_id: UUID_1, name: UUID_1, group: '', ip: '', name_missing: true, exists: false, reason: '',
    });
    assert.equal(result.nodes[1].exists, true);
    assert.equal(result.nodes[1].name_missing, true);
    assert.match(result.nodes[1].reason, /已存在/);
    const rpcCall = calls.find((call) => call.url === `${PANEL}/api`);
    assert.equal(rpcCall.options.method, 'POST');
    assert.equal(rpcCall.options.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(rpcCall.options.headers['content-type'], 'application/json');
    assert.equal(rpcCall.options.redirect, 'manual', 'panel redirects must not replay the credential');
    assert.ok(rpcCall.options.signal instanceof AbortSignal, 'panel requests must be abortable');
    assert.deepEqual(JSON.parse(rpcCall.options.body), {
      jsonrpc: '2.0', id: 1, method: 'agent-uuid_list_all', params: {},
    });
    assert.equal(JSON.stringify(result).includes(API_KEY), false, 'the panel api key must never be returned');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('nodeget preview tolerates object entries and falls back to /api/rpc', async () => {
  const env = makeEnv();
  const calls = panelFetch({
    apiStatus: 404,
    rpc: { jsonrpc: '2.0', id: 1, result: [{ uuid: UUID_1, name: 'Tokyo Edge' }, { id: UUID_2, remark: 'Osaka Edge' }] },
  });
  try {
    const result = await previewNodeGetMigration(
      migrationRequest('/api/admin/migration/nodeget/preview', { panel_url: PANEL, token: API_KEY }),
      env,
    );
    assert.deepEqual(calls.map((call) => call.url), [`${PANEL}/api`, `${PANEL}/api/rpc`]);
    assert.equal(result.summary.total, 2);
    assert.equal(result.nodes[0].name, 'Tokyo Edge');
    assert.equal(result.nodes[0].name_missing, false);
    assert.equal(result.nodes[1].name, 'Osaka Edge');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('nodeget import creates targets and returns per-node install commands', async () => {
  const env = makeEnv();
  panelFetch();
  try {
    const result = await importNodeGetMigration(
      migrationRequest('/api/admin/migration/nodeget/import', {
        panel_url: PANEL,
        token: API_KEY,
        nodes: [{ source_id: UUID_1 }, { source_id: UUID_2 }],
      }),
      env,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.created.map((item) => item.id), [`nodeget-${UUID_1}`, `nodeget-${UUID_2}`]);
    assert.equal(result.created[0].name, UUID_1);
    assert.match(result.created[0].install_command, /https:\/\/api\.example\.test\/api\/agent\/install-script/);
    assert.match(result.created[0].install_command, new RegExp(`NIE-SLA target: nodeget-${UUID_1}`));
    assert.match(result.created[0].install_command, /nsi_[a-f0-9]{48}/);
    assert.match(result.created[0].install_command, /sh "\$t" --replace-agent nodeget\)$/, 'the one-command migration must stop the old NodeGet agent');
    assert.equal(result.created[0].install_command.includes(API_KEY), false);

    const stored = env.DB.targets.find((target) => target.id === `nodeget-${UUID_1}`);
    assert.equal(stored.name, UUID_1);
    assert.equal(stored.group_name, 'Default', 'createTarget falls back to its default group when the source has none');
    assert.equal(stored.type, 'tcp');
    assert.equal(stored.target_host, null, 'NodeGet has no IP, so the target is created in no-public-ip mode');
    assert.equal(stored.target_port, null);
    assert.equal(stored.enabled, 1);
    assert.equal(stored.no_public_ip, 1);
    assert.equal(stored.interval_sec, 300);
    assert.equal(env.DB.tickets.length, 2, 'every created target must get its own one-time install ticket');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('nodeget import skips existing targets and rejects unknown ids', async () => {
  const env = makeEnv({ targets: [{ id: `nodeget-${UUID_2}`, name: UUID_2, type: 'tcp' }] });
  panelFetch();
  try {
    const result = await importNodeGetMigration(
      migrationRequest('/api/admin/migration/nodeget/import', {
        panel_url: PANEL,
        token: API_KEY,
        nodes: [{ source_id: UUID_2 }, { source_id: UUID_1 }],
      }),
      env,
    );
    assert.deepEqual(result.skipped, [{ source_id: UUID_2, name: UUID_2, reason: '目标 ID 已存在' }]);
    assert.deepEqual(result.created.map((item) => item.id), [`nodeget-${UUID_1}`]);
    await assert.rejects(
      () => importNodeGetMigration(migrationRequest('/api/admin/migration/nodeget/import', {
        panel_url: PANEL,
        token: API_KEY,
        nodes: [{ source_id: 'unknown-uuid' }],
      }), env),
      (error) => error.status === 400 && /未知节点/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('nodeget panel 401 maps to a clear auth error without falling back', async () => {
  const env = makeEnv();
  const calls = panelFetch({ api: { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'unauthorized' } }, apiStatus: 401 });
  try {
    await assert.rejects(
      () => previewNodeGetMigration(migrationRequest('/api/admin/migration/nodeget/preview', { panel_url: PANEL, token: API_KEY }), env),
      (error) => error.status === 401 && error.message === '面板凭据被拒绝',
    );
    assert.deepEqual(calls.map((call) => call.url), [`${PANEL}/api`]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('nodeget rejects unparseable rpc payloads with the documented error', async () => {
  const env = makeEnv();
  for (const api of [
    { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } },
    { jsonrpc: '2.0', id: 1, result: 'unexpected' },
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: 1, result: 42 },
    { jsonrpc: '2.0', id: 1, result: [12345] },
  ]) {
    panelFetch({ api });
    try {
      await assert.rejects(
        () => previewNodeGetMigration(migrationRequest('/api/admin/migration/nodeget/preview', { panel_url: PANEL, token: API_KEY }), env),
        (error) => error.status === 502 && error.message === 'NodeGet 接口返回无法识别（请在面板确认 JSON-RPC 可用）',
        `${JSON.stringify(api)} must be rejected`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('nodeget migration routes are registered and admin guarded', async () => {
  for (const path of ['/api/admin/migration/nodeget/preview', '/api/admin/migration/nodeget/import']) {
    const response = await worker.fetch(new Request(`https://api.example.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://sla.example.test' },
      body: '{}',
    }), { ALLOWED_ORIGIN: 'https://sla.example.test' }, {});
    assert.equal(response.status, 401, `${path} must require an admin session`);
    assert.match((await response.json()).error, /管理会话/);
  }
});
