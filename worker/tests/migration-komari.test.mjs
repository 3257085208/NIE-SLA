import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import { importKomariMigration, previewKomariMigration } from '../src/admin/migration.js';

const PANEL = 'https://komari.example.test';
const API_KEY = 'kmr_example_api_key';
const originalFetch = globalThis.fetch;

const CLIENTS = [
  { id: 11, name: 'Tokyo Edge', group: 'JP', ip: '203.0.113.10', hidden: true },
  { uuid: 'c-2', remark: 'Osaka Edge', group_name: 'US', ipv4: ['198.51.100.20:8443', '198.51.100.21'], hide_for_guest: 1 },
  { id: 'c-3', hostname: 'Tagged Host', tags: ['edge', 'eu'], ip: '198.51.100.30' },
];

function panelFetch({ clients = CLIENTS, clientStatus = 200, publicClients = null, publicStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, options });
    if (requestUrl === `${PANEL}/api/admin/client/list`) return Response.json({ status: 'success', data: clients }, { status: clientStatus });
    if (requestUrl === `${PANEL}/api/nodes`) return Response.json(publicClients || { data: clients }, { status: publicStatus });
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

test('komari preview maps client fields and flags existing nodes without leaking the api key', async () => {
  const env = makeEnv({ targets: [{ id: 'komari-c-2', name: 'Osaka Edge', type: 'tcp' }] });
  const calls = panelFetch();
  try {
    const result = await previewKomariMigration(
      migrationRequest('/api/admin/migration/komari/preview', { panel_url: PANEL, token: API_KEY }),
      env,
    );
    assert.equal(result.ok, true);
    assert.equal(result.source, 'komari');
    assert.deepEqual(result.summary, { total: 3, creatable: 2, existing: 1 });
    assert.deepEqual(result.nodes[0], {
      source_id: '11', name: 'Tokyo Edge', group: 'JP', ip: '203.0.113.10',
      hidden: true, exists: false, reason: '',
    });
    assert.equal(result.nodes[1].source_id, 'c-2');
    assert.equal(result.nodes[1].name, 'Osaka Edge');
    assert.equal(result.nodes[1].group, 'US');
    assert.equal(result.nodes[1].ip, '198.51.100.20:8443');
    assert.equal(result.nodes[1].hidden, true);
    assert.equal(result.nodes[1].exists, true);
    assert.match(result.nodes[1].reason, /已存在/);
    assert.equal(result.nodes[2].name, 'Tagged Host');
    assert.equal(result.nodes[2].group, 'edge,eu');
    assert.equal(result.nodes[2].hidden, false);
    const clientCall = calls.find((call) => call.url === `${PANEL}/api/admin/client/list`);
    assert.equal(clientCall.options.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(clientCall.options.redirect, 'manual', 'panel redirects must not replay the credential');
    assert.ok(clientCall.options.signal && typeof clientCall.options.signal.aborted === 'boolean', 'panel requests must be abortable');
    assert.equal(JSON.stringify(result).includes(API_KEY), false, 'the panel api key must never be returned');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('komari preview falls back to /api/nodes and tolerates wrapped shapes', async () => {
  const env = makeEnv();
  const calls = panelFetch({
    clientStatus: 404,
    publicClients: { nodes: CLIENTS },
  });
  try {
    const result = await previewKomariMigration(
      migrationRequest('/api/admin/migration/komari/preview', { panel_url: PANEL, token: API_KEY }),
      env,
    );
    assert.equal(result.summary.total, 3);
    assert.deepEqual(calls.map((call) => call.url), [`${PANEL}/api/admin/client/list`, `${PANEL}/api/nodes`]);
    assert.equal(calls[1].options.headers.authorization, `Bearer ${API_KEY}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('komari import creates targets and returns per-node install commands', async () => {
  const env = makeEnv();
  panelFetch();
  try {
    const result = await importKomariMigration(
      migrationRequest('/api/admin/migration/komari/import', {
        panel_url: PANEL,
        token: API_KEY,
        nodes: [
          { source_id: 'c-2', name: 'stale name', group: 'stale', ip: 'stale' },
          { source_id: '11', name: 'Tokyo Edge', group: 'JP', ip: '203.0.113.10' },
        ],
      }),
      env,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.created.map((item) => item.id), ['komari-c-2', 'komari-11']);
    const osaka = result.created[0];
    assert.match(osaka.install_command, /https:\/\/api\.example\.test\/api\/agent\/install-script/);
    assert.match(osaka.install_command, /NIE-SLA target: komari-c-2/);
    assert.match(osaka.install_command, /nsi_[a-f0-9]{48}/);
    assert.match(osaka.install_command, /sh "\$t" --replace-agent komari\)$/, 'the one-command migration must stop the old Komari agent');
    assert.equal(osaka.install_command.includes(API_KEY), false);

    const storedOsaka = env.DB.targets.find((target) => target.id === 'komari-c-2');
    assert.equal(storedOsaka.name, 'Osaka Edge');
    assert.equal(storedOsaka.group_name, 'US');
    assert.equal(storedOsaka.type, 'tcp');
    assert.equal(storedOsaka.target_host, '198.51.100.20');
    assert.equal(storedOsaka.target_port, 8443);
    assert.equal(storedOsaka.enabled, 1);
    assert.equal(storedOsaka.no_public_ip, 1);
    assert.equal(storedOsaka.interval_sec, 300);
    const storedTokyo = env.DB.targets.find((target) => target.id === 'komari-11');
    assert.equal(storedTokyo.name, 'Tokyo Edge');
    assert.equal(storedTokyo.group_name, 'JP');
    assert.equal(storedTokyo.target_host, '203.0.113.10');
    assert.equal(storedTokyo.target_port, 443);
    assert.equal(env.DB.tickets.length, 2, 'every created target must get its own one-time install ticket');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('komari import skips existing targets and rejects duplicate or unknown ids', async () => {
  const env = makeEnv({ targets: [{ id: 'komari-c-2', name: 'Osaka Edge', type: 'tcp' }] });
  panelFetch();
  try {
    const result = await importKomariMigration(
      migrationRequest('/api/admin/migration/komari/import', {
        panel_url: PANEL,
        token: API_KEY,
        nodes: [{ source_id: 'c-2' }, { source_id: '11' }],
      }),
      env,
    );
    assert.deepEqual(result.skipped, [{ source_id: 'c-2', name: 'Osaka Edge', reason: '目标 ID 已存在' }]);
    assert.deepEqual(result.created.map((item) => item.id), ['komari-11']);
    await assert.rejects(
      () => importKomariMigration(migrationRequest('/api/admin/migration/komari/import', {
        panel_url: PANEL,
        token: API_KEY,
        nodes: [{ source_id: '11' }, { source_id: '11' }],
      }), env),
      (error) => error.status === 400 && /重复/.test(error.message),
    );
    await assert.rejects(
      () => importKomariMigration(migrationRequest('/api/admin/migration/komari/import', {
        panel_url: PANEL,
        token: API_KEY,
        nodes: [{ source_id: '404' }],
      }), env),
      (error) => error.status === 400 && /未知节点/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('komari panel 401 maps to a clear auth error without falling back', async () => {
  const env = makeEnv();
  const calls = panelFetch({ clients: [], clientStatus: 401 });
  try {
    await assert.rejects(
      () => previewKomariMigration(migrationRequest('/api/admin/migration/komari/preview', { panel_url: PANEL, token: API_KEY }), env),
      (error) => error.status === 401 && error.message === '面板凭据被拒绝',
    );
    assert.deepEqual(calls.map((call) => call.url), [`${PANEL}/api/admin/client/list`]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('komari migration routes are registered and admin guarded', async () => {
  for (const path of ['/api/admin/migration/komari/preview', '/api/admin/migration/komari/import']) {
    const response = await worker.fetch(new Request(`https://api.example.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://sla.example.test' },
      body: '{}',
    }), { ALLOWED_ORIGIN: 'https://sla.example.test' }, {});
    assert.equal(response.status, 401, `${path} must require an admin session`);
    assert.match((await response.json()).error, /管理会话/);
  }
});

test('komari panel timeout maps to a clear error', async () => {
  const env = makeEnv();
  globalThis.fetch = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  try {
    await assert.rejects(
      () => previewKomariMigration(migrationRequest('/api/admin/migration/komari/preview', { panel_url: PANEL, token: API_KEY }), env),
      (error) => error.status === 504 && error.message === '连接面板超时',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
