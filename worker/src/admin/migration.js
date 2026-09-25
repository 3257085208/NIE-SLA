import { ApiError, safeJson } from '../auth.js';
import { assertPublicHttpUrl, clamp, parseBoolean, sanitizeAgentId, MIN_INTERVAL_SEC } from '../utils.js';
import { createTarget } from './targets.js';
import { getAgentInstallCommand } from './install-command.js';

const PANEL_TIMEOUT_MS = 10_000;
const MAX_IMPORT_NODES = 500;
const DEFAULT_IMPORT_INTERVAL_SEC = 300;
const DEFAULT_TARGET_PORT = 443;
const NEZHA_SERVER_PATH = '/api/v1/server';
const NEZHA_GROUP_PATH = '/api/v1/server-group';
const KOMARI_CLIENT_PATH = '/api/admin/client/list';
const KOMARI_NODES_PATH = '/api/nodes';
const NODEGET_RPC_PATH = '/api';
const NODEGET_RPC_FALLBACK_PATH = '/api/rpc';
const NODEGET_UUID_METHOD = 'agent-uuid_list_all';
const NODEGET_UNRECOGNIZED = 'NodeGet 接口返回无法识别（请在面板确认 JSON-RPC 可用）';

export async function previewNezhaMigration(request, env) {
  const body = await safeJson(request);
  const base = normalizePanelBase(body?.panel_url);
  const token = readPanelToken(body);
  const source = await fetchNezhaSource(base, token);
  const existing = await readExistingTargets(env);
  const nodes = [];
  for (const server of source.servers) {
    const node = buildNezhaNode(server, source.groupMap);
    if (!node) continue;
    const collision = targetCollision(nezhaTargetId(node), node.name, existing);
    nodes.push({
      source_id: node.source_id,
      name: node.name,
      group: node.group,
      ip: node.ip,
      exists: collision.exists,
      reason: collision.reason,
    });
  }
  return {
    ok: true,
    source: 'nezha',
    summary: summarizeNodes(nodes),
    nodes,
    groups: source.groups,
  };
}

export async function importNezhaMigration(request, env) {
  const body = await safeJson(request);
  const base = normalizePanelBase(body?.panel_url);
  const token = readPanelToken(body);
  const options = readImportOptions(body);

  // The client-provided list only selects source ids; names, groups and IPs are
  // always re-read from the panel so a stale preview cannot write blind data.
  const source = await fetchNezhaSource(base, token);
  const fresh = new Map();
  for (const server of source.servers) {
    const node = buildNezhaNode(server, source.groupMap);
    if (node) fresh.set(node.source_id, node);
  }
  return runMigrationImport(request, env, { fresh, targetId: nezhaTargetId, replaceAgent: 'nezha', ...options });
}

export async function previewKomariMigration(request, env) {
  const body = await safeJson(request);
  const base = normalizePanelBase(body?.panel_url);
  const apiKey = readPanelToken(body, 'API Key');
  const clients = await fetchKomariClients(base, apiKey);
  const existing = await readExistingTargets(env);
  const nodes = [];
  for (const client of clients) {
    const node = buildKomariNode(client);
    if (!node) continue;
    const collision = targetCollision(komariTargetId(node), node.name, existing);
    nodes.push({
      source_id: node.source_id,
      name: node.name,
      group: node.group,
      ip: node.ip,
      hidden: node.hidden,
      exists: collision.exists,
      reason: collision.reason,
    });
  }
  return {
    ok: true,
    source: 'komari',
    summary: summarizeNodes(nodes),
    nodes,
  };
}

export async function importKomariMigration(request, env) {
  const body = await safeJson(request);
  const base = normalizePanelBase(body?.panel_url);
  const apiKey = readPanelToken(body, 'API Key');
  const options = readImportOptions(body);
  const clients = await fetchKomariClients(base, apiKey);
  const fresh = new Map();
  for (const client of clients) {
    const node = buildKomariNode(client);
    if (node) fresh.set(node.source_id, node);
  }
  return runMigrationImport(request, env, { fresh, targetId: komariTargetId, replaceAgent: 'komari', ...options });
}

export async function previewNodeGetMigration(request, env) {
  const body = await safeJson(request);
  const base = normalizePanelBase(body?.panel_url);
  const apiKey = readPanelToken(body, 'API Key');
  const entries = await fetchNodeGetNodes(base, apiKey);
  const existing = await readExistingTargets(env);
  const nodes = [];
  for (const entry of entries) {
    const node = buildNodeGetNode(entry);
    if (!node) continue;
    const collision = targetCollision(nodegetTargetId(node), node.name, existing);
    nodes.push({
      source_id: node.source_id,
      name: node.name,
      group: node.group,
      ip: node.ip,
      name_missing: node.name_missing,
      exists: collision.exists,
      reason: collision.reason,
    });
  }
  return {
    ok: true,
    source: 'nodeget',
    summary: summarizeNodes(nodes),
    nodes,
    name_hint: 'NodeGet 仅返回节点 UUID，名称需导入后补',
  };
}

export async function importNodeGetMigration(request, env) {
  const body = await safeJson(request);
  const base = normalizePanelBase(body?.panel_url);
  const apiKey = readPanelToken(body, 'API Key');
  const options = readImportOptions(body);
  const entries = await fetchNodeGetNodes(base, apiKey);
  const fresh = new Map();
  for (const entry of entries) {
    const node = buildNodeGetNode(entry);
    if (node) fresh.set(node.source_id, node);
  }
  return runMigrationImport(request, env, { fresh, targetId: nodegetTargetId, replaceAgent: 'nodeget', ...options });
}

function summarizeNodes(nodes) {
  const creatable = nodes.filter((node) => !node.exists).length;
  return { total: nodes.length, creatable, existing: nodes.length - creatable };
}

function readImportOptions(body) {
  return {
    requested: readRequestedSourceIds(body?.nodes),
    noPublicIp: parseBoolean(body?.no_public_ip, true),
    intervalSec: clamp(Number(body?.interval_sec ?? DEFAULT_IMPORT_INTERVAL_SEC), MIN_INTERVAL_SEC, 86400),
    groupOverride: String(body?.group_name || '').trim(),
  };
}

async function runMigrationImport(request, env, { fresh, requested, targetId, replaceAgent, noPublicIp, intervalSec, groupOverride }) {
  const unknown = requested.filter((sourceId) => !fresh.has(sourceId));
  if (unknown.length) throw new ApiError(400, `包含未知节点：${unknown.slice(0, 3).join('、')}`);

  const existing = await readExistingTargets(env);
  const created = [];
  const skipped = [];
  for (const sourceId of requested) {
    const node = fresh.get(sourceId);
    const id = targetId(node);
    const collision = targetCollision(id, node.name, existing);
    if (collision.exists) {
      skipped.push({ source_id: node.source_id, name: node.name, reason: collision.reason });
      continue;
    }
    try {
      created.push(await createMigrationTarget(request, env, {
        id,
        name: node.name,
        group: groupOverride || node.group,
        ip: node.ip,
        replaceAgent,
        noPublicIp,
        intervalSec,
      }));
      existing.ids.add(id);
      existing.names.add(node.name.trim().toLowerCase());
    } catch (error) {
      skipped.push({ source_id: node.source_id, name: node.name, reason: String(error?.message || '创建失败') });
    }
  }
  return { ok: true, created, skipped };
}

async function createMigrationTarget(request, env, { id, name, group, ip, replaceAgent, noPublicIp, intervalSec }) {
  const { host, port } = splitHostPort(ip);
  const result = await createTarget(jsonRequest({
    id,
    name,
    group_name: group,
    type: 'tcp',
    target_host: host,
    target_port: port,
    enabled: 1,
    no_public_ip: noPublicIp ? 1 : 0,
    interval_sec: intervalSec,
  }), env);
  let installCommand = '';
  try {
    const commandUrl = new URL(request.url);
    commandUrl.pathname = '/api/agent/install-command';
    commandUrl.search = `?target_id=${encodeURIComponent(result.id)}`;
    const command = await getAgentInstallCommand(env, commandUrl, request, { replaceAgent });
    // The raw one-time command carries no node identity (the ticket is opaque),
    // so a sanitized comment line keeps every copied command traceable.
    if (command?.ok && command.linux_command) {
      installCommand = `# NIE-SLA target: ${result.id}\n${String(command.linux_command)}`;
    }
  } catch (_) {
    installCommand = '';
  }
  return { id: result.id, name, install_command: installCommand };
}

function normalizePanelBase(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new ApiError(400, '请填写面板地址');
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new ApiError(400, '面板地址格式无效');
  }
  if (url.protocol !== 'https:') throw new ApiError(400, '面板地址必须为 HTTPS');
  if (url.username || url.password) throw new ApiError(400, '面板地址不能包含账号密码');
  try {
    assertPublicHttpUrl(url.toString());
  } catch (error) {
    throw new ApiError(400, String(error?.message || '面板地址无效'));
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function readPanelToken(body, label = 'API Token') {
  const token = String(body?.token || body?.api_key || '').trim();
  if (!token) throw new ApiError(400, `请填写面板 ${label}`);
  if (token.length > 512) throw new ApiError(400, `面板 ${label} 过长`);
  return token;
}

function readRequestedSourceIds(nodes) {
  if (!Array.isArray(nodes)) throw new ApiError(400, '节点列表无效');
  if (nodes.length > MAX_IMPORT_NODES) throw new ApiError(400, `一次最多导入 ${MAX_IMPORT_NODES} 个节点`);
  const ids = [];
  const seen = new Set();
  for (const item of nodes) {
    const sourceId = item?.source_id == null ? '' : String(item.source_id).trim();
    if (!sourceId) throw new ApiError(400, '节点缺少 source_id');
    if (seen.has(sourceId)) throw new ApiError(400, `节点 ${sourceId} 重复`);
    seen.add(sourceId);
    ids.push(sourceId);
  }
  if (!ids.length) throw new ApiError(400, '未选择任何节点');
  return ids;
}

async function fetchNezhaSource(base, token) {
  const [serversPayload, groupsPayload] = await Promise.all([
    fetchPanelJson(base, token, NEZHA_SERVER_PATH),
    fetchPanelJson(base, token, NEZHA_GROUP_PATH).catch(() => null),
  ]);
  const servers = extractPanelList(serversPayload);
  if (!servers) throw new ApiError(502, '面板接口返回格式不正确');
  const groups = normalizePanelGroups(extractPanelList(groupsPayload));
  return { servers, groups: groups.list, groupMap: groups.map };
}

async function fetchPanelJson(base, token, path, { method = 'GET', body = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PANEL_TIMEOUT_MS);
  try {
    // Redirects are rejected instead of followed: the panel credential must
    // never be replayed to a different host chosen by the remote server.
    const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
    if (body) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new ApiError(502, '面板地址重定向被拒绝');
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      throw new ApiError(401, '面板凭据被拒绝');
    }
    if (response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new ApiError(401, '面板凭据被拒绝（权限不足）');
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      throw new ApiError(404, '接口不存在（请确认版本/路径）');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ApiError(502, `面板返回错误（HTTP ${response.status}）`);
    }
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > 5 * 1024 * 1024) {
      await response.body?.cancel().catch(() => {});
      throw new ApiError(502, '面板返回数据过大');
    }
    try {
      const text = await response.text();
      if (text.length > 5 * 1024 * 1024) throw new ApiError(502, '面板返回数据过大');
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, '面板返回无效数据');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === 'AbortError') throw new ApiError(504, '连接面板超时');
    throw new ApiError(502, '无法连接面板');
  } finally {
    clearTimeout(timer);
  }
}

function extractPanelList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return null;
}

async function fetchKomariClients(base, apiKey) {
  let payload;
  try {
    payload = await fetchPanelJson(base, apiKey, KOMARI_CLIENT_PATH);
  } catch (error) {
    // Komari < 1.0.3 has no admin client endpoint; the public node list still works.
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    payload = await fetchPanelJson(base, apiKey, KOMARI_NODES_PATH);
  }
  const list = extractKomariList(payload);
  if (!list) throw new ApiError(502, '面板接口返回格式不正确');
  return list;
}

function extractKomariList(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['data', 'nodes', 'clients']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return null;
}

function buildKomariNode(client) {
  const sourceId = plainScalar(client?.id) || plainScalar(client?.uuid);
  if (!sourceId) return null;
  const name = plainScalar(client?.name) || plainScalar(client?.remark) || plainScalar(client?.hostname) || `Komari #${sourceId}`;
  const group = joinScalars(client?.group) || plainScalar(client?.group_name) || joinScalars(client?.tags);
  return {
    source_id: sourceId,
    name,
    group,
    ip: pickKomariIp(client),
    hidden: readHiddenFlag(client?.hidden) || readHiddenFlag(client?.hide_for_guest),
  };
}

function pickKomariIp(client) {
  for (const key of ['ip', 'ipv4', 'ipv6', 'host']) {
    const value = firstScalar(client?.[key]);
    if (value) return value;
  }
  return '';
}

async function fetchNodeGetNodes(base, apiKey) {
  let payload;
  try {
    payload = await fetchNodeGetRpc(base, apiKey, NODEGET_RPC_PATH);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    payload = await fetchNodeGetRpc(base, apiKey, NODEGET_RPC_FALLBACK_PATH);
  }
  return extractNodeGetNodes(payload);
}

function fetchNodeGetRpc(base, apiKey, path) {
  return fetchPanelJson(base, apiKey, path, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: NODEGET_UUID_METHOD, params: {} }),
  });
}

function extractNodeGetNodes(payload) {
  const result = Array.isArray(payload) ? payload : payload?.result;
  if (!result || typeof result !== 'object') throw new ApiError(502, NODEGET_UNRECOGNIZED);
  if (Array.isArray(result)) {
    const nodes = result.map(nodeGetEntry).filter(Boolean);
    if (result.length && !nodes.length) throw new ApiError(502, NODEGET_UNRECOGNIZED);
    return nodes;
  }
  const arrayKey = ['uuids', 'list', 'items', 'data', 'nodes'].find((key) => Array.isArray(result[key]));
  if (arrayKey) return result[arrayKey].map(nodeGetEntry).filter(Boolean);
  const nodes = [];
  for (const [key, value] of Object.entries(result)) {
    const sourceId = plainScalar(key);
    if (!sourceId) continue;
    nodes.push({
      source_id: sourceId,
      name: typeof value === 'string' ? value.trim() : (plainScalar(value?.name) || plainScalar(value?.remark)),
      group: joinScalars(value?.group || value?.group_name || value?.tags),
      ip: firstScalar(value?.ip) || firstScalar(value?.ipv4) || firstScalar(value?.ipv6) || firstScalar(value?.host),
    });
  }
  if (!nodes.length) throw new ApiError(502, NODEGET_UNRECOGNIZED);
  return nodes;
}

function nodeGetEntry(item) {
  if (typeof item === 'string') {
    const sourceId = item.trim();
    return sourceId ? { source_id: sourceId, name: '', group: '', ip: '' } : null;
  }
  const sourceId = plainScalar(item?.uuid) || plainScalar(item?.id);
  if (!sourceId) return null;
  return {
    source_id: sourceId,
    name: plainScalar(item?.name) || plainScalar(item?.remark),
    group: joinScalars(item?.group || item?.group_name || item?.tags),
    ip: firstScalar(item?.ip) || firstScalar(item?.ipv4) || firstScalar(item?.ipv6) || firstScalar(item?.host),
  };
}

function buildNodeGetNode(entry) {
  const sourceId = String(entry?.source_id || '').trim();
  if (!sourceId) return null;
  // NodeGet identifies agents by UUID only; the imported name is a placeholder
  // until an operator renames it in the probe list.
  const name = String(entry?.name || '').trim();
  return {
    source_id: sourceId,
    name: name || sourceId,
    group: String(entry?.group || '').trim(),
    ip: String(entry?.ip || '').trim(),
    name_missing: !name,
  };
}

function normalizePanelGroups(list) {
  const groups = [];
  const map = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const id = item?.id == null ? '' : String(item.id).trim();
    if (!id) continue;
    const name = String(item?.name || '').trim();
    map.set(id, name);
    groups.push({ id, name });
  }
  return { list: groups, map };
}

function buildNezhaNode(server, groupMap) {
  const sourceId = server?.id == null ? '' : String(server.id).trim();
  if (!sourceId) return null;
  const name = String(server?.name || '').trim() || `NeZha #${sourceId}`;
  const groupId = server?.group_id == null ? '' : String(server.group_id).trim();
  return {
    source_id: sourceId,
    name,
    group: groupId ? (groupMap.get(groupId) || '') : '',
    ip: pickNezhaIp(server),
  };
}

function pickNezhaIp(server) {
  for (const key of ['ipv4', 'ipv6', 'ip', 'host']) {
    const value = firstScalar(server?.[key]);
    if (value) return value;
  }
  return '';
}

function firstScalar(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstScalar(item);
      if (found) return found;
    }
    return '';
  }
  if (value == null) return '';
  const raw = typeof value === 'object' ? (value.ip || value.addr || value.value || '') : value;
  return String(raw).trim().split(/[\s,;，；]+/).filter(Boolean)[0] || '';
}

function plainScalar(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = plainScalar(item);
      if (found) return found;
    }
    return '';
  }
  if (value == null) return '';
  const raw = typeof value === 'object' ? (value.name || value.value || value.id || '') : value;
  return String(raw).trim();
}

function joinScalars(value) {
  if (Array.isArray(value)) return value.map((item) => joinScalars(item)).filter(Boolean).join(',');
  return plainScalar(value);
}

function readHiddenFlag(value) {
  const raw = plainScalar(value).toLowerCase();
  return raw === '1' || raw === 'true';
}

function nezhaTargetId(node) {
  return sourceTargetId('nezha', node);
}

function komariTargetId(node) {
  return sourceTargetId('komari', node);
}

function nodegetTargetId(node) {
  return sourceTargetId('nodeget', node);
}

function sourceTargetId(prefix, node) {
  const base = sanitizeAgentId(`${prefix}-${node.source_id}`) || sanitizeAgentId(`${prefix}-${node.name}`);
  return base && base !== prefix ? base : fallbackSourceId(prefix, node.source_id || node.name);
}

function fallbackSourceId(prefix, value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

function splitHostPort(ip) {
  const value = String(ip || '').trim();
  // Bracketed IPv6 literal with a port, e.g. [2001:db8::1]:443.
  const bracketed = value.match(/^\[([0-9a-f:]+)\]:(\d{1,5})$/i);
  if (bracketed) {
    const port = Number(bracketed[2]);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return { host: bracketed[1], port };
  }
  const match = value.match(/^([^\s:/]+):(\d{1,5})$/);
  if (match) {
    const port = Number(match[2]);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return { host: match[1], port };
  }
  return { host: value, port: DEFAULT_TARGET_PORT };
}

function targetCollision(targetId, name, existing) {
  if (existing.ids.has(targetId)) return { exists: true, reason: '目标 ID 已存在' };
  const normalizedName = String(name || '').trim().toLowerCase();
  if (normalizedName && existing.names.has(normalizedName)) return { exists: true, reason: '名称已存在' };
  return { exists: false, reason: '' };
}

async function readExistingTargets(env) {
  const rows = await env.DB.prepare(`SELECT id, name FROM targets`).all();
  const ids = new Set();
  const names = new Set();
  for (const row of rows.results || []) {
    ids.add(String(row.id));
    const name = String(row.name || '').trim().toLowerCase();
    if (name) names.add(name);
  }
  return { ids, names };
}

function jsonRequest(body) {
  return new Request('https://nie-sla.internal/admin/migration/target', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
