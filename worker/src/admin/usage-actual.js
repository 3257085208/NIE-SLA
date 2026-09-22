import { ApiError } from '../auth.js';
import { getMeta, setMeta } from './settings.js';

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const CONFIG_TOKEN_KEY = 'cf_usage_api_token';
const CONFIG_ACCOUNT_KEY = 'cf_usage_account_tag';
const CACHE_TTL_MS = 10 * 60 * 1000;

let cache = null;

export async function getUsageActualConfig(env) {
  const [token, accountTag] = await Promise.all([
    getMeta(env, CONFIG_TOKEN_KEY),
    getMeta(env, CONFIG_ACCOUNT_KEY),
  ]);
  return { configured: Boolean(token && accountTag), account_tag: accountTag || null };
}

export async function saveUsageActualConfig(env, { apiToken, accountTag }) {
  const token = String(apiToken || '').trim();
  const tag = String(accountTag || '').trim().replace(/[^0-9a-f]/gi, '');
  if (!/^[0-9a-f]{32,64}$/i.test(tag)) throw new ApiError(400, 'Account ID 必须是 32 位十六进制');
  if (token.length < 20 || /\s/.test(token)) throw new ApiError(400, 'API Token 格式无效');
  await setMeta(env, CONFIG_TOKEN_KEY, token);
  await setMeta(env, CONFIG_ACCOUNT_KEY, tag);
  cache = null;
  return { ok: true, configured: true, account_tag: tag };
}

async function gql(token, query, variables) {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Cloudflare API HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(body.errors.map((error) => error.message).join('; ').slice(0, 300));
  return body.data;
}

export async function fetchActualUsage(env, hours = 24) {
  let token, accountTag;
  try {
    token = await getMeta(env, CONFIG_TOKEN_KEY);
    accountTag = await getMeta(env, CONFIG_ACCOUNT_KEY);
  } catch (configError) {
    return { ok: false, error: `读取配置失败（请重试）：${configError.message}`, retryable: true };
  }
  if (!token || !accountTag) return { ok: false, error: '尚未配置 Cloudflare API Token，请先在上方保存' };
  const now = Date.now();
  if (cache?.hours === hours && cache.expiresAt > now) return { ok: true, ...cache.data, cached: true };

  const since = new Date(now - Math.min(168, Math.max(1, hours)) * 3_600_000).toISOString().slice(0, 19) + 'Z';
  const until = new Date(now).toISOString().slice(0, 19) + 'Z';
  const window = `datetime_geq: "${since}", datetime_lt: "${until}"`;

  const data = await gql(token, `query {
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        workers: workersInvocationsAdaptive(limit: 10000, filter: { ${window} }) {
          sum { requests errors }
        }
        d1: d1AnalyticsAdaptiveGroups(limit: 100, filter: { ${window} }) {
          dimensions { databaseId }
          sum { rowsWritten rowsRead readQueries writeQueries }
        }
        durableObjects: durableObjectsInvocationsAdaptiveGroups(limit: 1, filter: { ${window} }) {
          sum { requests wallTime }
        }
        r2: r2OperationsAdaptiveGroups(limit: 50, filter: { ${window} }) {
          dimensions { actionType }
          sum { requests }
        }
      }
    }
  }`).catch((error) => { throw new ApiError(502, `GraphQL 查询失败：${error.message}`); });

  const account = data?.viewer?.accounts?.[0] || {};
  const sumOf = (group) => (Array.isArray(group) ? group[0]?.sum : group?.sum) || {};
  const sumAll = (group, key) => (Array.isArray(group) ? group : [group])
    .reduce((total, item) => total + Number(item?.sum?.[key] || 0), 0);
  const ownD1Ids = String(env.USAGE_D1_DATABASE_IDS || '279ad7f9-0b69-49aa-90eb-c42321eda6c3')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const d1Groups = Array.isArray(account.d1) ? account.d1 : [account.d1];
  const d1Total = { rowsWritten: 0, rowsRead: 0, readQueries: 0, writeQueries: 0 };
  const d1Own = { rowsWritten: 0, rowsRead: 0, readQueries: 0, writeQueries: 0 };
  const d1ByDatabase = [];
  for (const group of d1Groups) {
    const sum = group?.sum || {};
    const row = {
      database_id: String(group?.dimensions?.databaseId || ''),
      rows_written: Number(sum.rowsWritten || 0),
      rows_read: Number(sum.rowsRead || 0),
      read_queries: Number(sum.readQueries || 0),
      write_queries: Number(sum.writeQueries || 0),
    };
    d1ByDatabase.push(row);
    for (const key of Object.keys(d1Total)) d1Total[key] += Number(sum[key] || 0);
    if (ownD1Ids.includes(row.database_id)) {
      for (const key of Object.keys(d1Own)) d1Own[key] += Number(sum[key] || 0);
    }
  }
  const d1 = d1Own;
  const durable = sumOf(account.durableObjects);
  const r2ClassA = new Set(['PutObject', 'CopyObject', 'ListObjects', 'ListObjectsV2', 'ListBuckets', 'HeadBucket', 'DeleteObject', 'DeleteObjects', 'CreateMultipartUpload', 'CompleteMultipartUpload', 'UploadPart', 'UploadPartCopy']);
  let r2A = 0;
  let r2B = 0;
  for (const group of Array.isArray(account.r2) ? account.r2 : [account.r2]) {
    const type = String(group?.dimensions?.actionType || '');
    const count = Number(group?.sum?.requests || 0);
    if (r2ClassA.has(type)) r2A += count;
    else r2B += count;
  }
  const result = {
    window_hours: Math.min(168, Math.max(1, hours)),
    actual: {
      workers_calls: sumAll(account.workers, 'requests'),
      d1_rows_written: Number(d1.rowsWritten || 0),
      d1_rows_read: Number(d1.rowsRead || 0),
      d1_queries: Number(d1.readQueries || 0) + Number(d1.writeQueries || 0),
      do_requests: Number(durable.requests || 0),
      do_wall_time_sec: Math.round(Number(durable.wallTime || 0) / 1_000_000),
      r2_class_a: r2A,
      r2_class_b: r2B,
      r2_requests: r2A + r2B,
    },
    d1_scope: 'own',
    d1_database_ids: ownD1Ids,
    d1_by_database: d1ByDatabase,
    actual_account: {
      d1_rows_written: d1Total.rowsWritten,
      d1_rows_read: d1Total.rowsRead,
      d1_queries: d1Total.readQueries + d1Total.writeQueries,
    },
    unavailable: ['DO SQLite 行写入（GraphQL 未暴露，请在控制台查看）'],
    fetched_at: Math.floor(now / 1000),
  };
  cache = { hours, expiresAt: now + CACHE_TTL_MS, data: result };
  return { ok: true, ...result };
}
