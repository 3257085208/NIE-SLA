// Real CF consumption via the account GraphQL API. The user provides a scoped
// API token + account id in settings; numbers here are metered reality, the
// embedded model provides the estimate side of the comparison.
import { ApiError } from '../auth.js';
import { getMeta, setMeta } from './settings.js';

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const CONFIG_TOKEN_KEY = 'cf_usage_api_token';
const CONFIG_ACCOUNT_KEY = 'cf_usage_account_tag';
const CACHE_TTL_MS = 10 * 60 * 1000;

let cache = null;

export async function getUsageActualConfig(env) {
  // No silent catch here: a storage hiccup must surface as "查询失败，请重试",
  // not as "未配置" — the latter would send the user re-creating a perfectly
  // valid token.
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
  // Read the secret directly: getUsageActualConfig intentionally never
  // returns the token (it feeds the settings UI), so destructuring it there
  // would make every query report "未配置" even after a successful save.
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
        d1: d1AnalyticsAdaptiveGroups(limit: 1, filter: { ${window} }) {
          sum { rowsWritten rowsRead }
        }
        durableObjects: durableObjectsInvocationsAdaptiveGroups(limit: 1, filter: { ${window} }) {
          sum { requests wallTime }
        }
      }
    }
  }`).catch((error) => { throw new ApiError(502, `GraphQL 查询失败：${error.message}`); });

  const account = data?.viewer?.accounts?.[0] || {};
  // Adaptive groups return an ARRAY of buckets (even with no dimensions);
  // reading .sum off the array itself silently yields zeros.
  const sumOf = (group) => (Array.isArray(group) ? group[0]?.sum : group?.sum) || {};
  const d1 = sumOf(account.d1);
  const durable = sumOf(account.durableObjects);
  const result = {
    window_hours: Math.min(168, Math.max(1, hours)),
    actual: {
      d1_rows_written: Number(d1.rowsWritten || 0),
      d1_rows_read: Number(d1.rowsRead || 0),
      do_requests: Number(durable.requests || 0),
      do_wall_time_sec: Math.round(Number(durable.wallTime || 0) / 1_000_000),
      workers_calls: null,
      r2_class_a: null,
      r2_class_b: null,
    },
    unavailable: ['workers_calls（免费账户无账户级指标，请在控制台查看）', 'r2_class_a/b（本查询未覆盖）'],
    fetched_at: Math.floor(now / 1000),
  };
  cache = { hours, expiresAt: now + CACHE_TTL_MS, data: result };
  return { ok: true, ...result };
}
