import { SUPPORTED_CURRENCIES } from './settings.js';

const BULK_TARGET_FIELDS = new Set([
  'provider', 'line_type', 'expires_at', 'price', 'currency', 'billing_cycle',
  'traffic_enabled', 'traffic_quota_gb', 'traffic_mode', 'traffic_reset_day',
  'alert_enabled', 'alert_expiry_days', 'alert_traffic_remaining_percent',
  'alert_traffic_remaining_gb',
]);
const BILLING_CYCLES = new Set(['', 'hourly', 'monthly', 'yearly', 'lifetime', 'onetime']);
const TRAFFIC_MODES = new Set(['total', 'tx', 'rx', 'max']);

export function normalizeBulkTargetUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bulkError('请求格式无效');
  if (!Array.isArray(body.ids)) return bulkError('请选择要修改的 VPS');
  const ids = [...new Set(body.ids.map(value => String(value || '').trim()).filter(Boolean))];
  if (!ids.length) return bulkError('请选择要修改的 VPS');
  if (ids.length > 100) return bulkError('单次最多批量修改 100 台 VPS');
  if (ids.some(id => id.length > 128)) return bulkError('目标 ID 无效');
  if (!body.changes || typeof body.changes !== 'object' || Array.isArray(body.changes)) return bulkError('请选择至少一个要修改的字段');

  const keys = Object.keys(body.changes);
  if (!keys.length) return bulkError('请选择至少一个要修改的字段');
  const unsupported = keys.find(key => !BULK_TARGET_FIELDS.has(key));
  if (unsupported) return bulkError(`不支持批量修改字段：${unsupported}`);

  const changes = { ...body.changes };
  for (const key of ['provider', 'line_type']) {
    if (!(key in changes)) continue;
    changes[key] = String(changes[key] ?? '').trim();
    const maxLength = key === 'provider' ? 80 : 40;
    if (changes[key].length > maxLength) return bulkError(`${key === 'provider' ? '商家' : '机器类型'}内容过长`);
  }
  if ('expires_at' in changes && !validBulkExpiry(changes.expires_at)) return bulkError('到期时间格式无效');
  if ('price' in changes && !validNullableNumber(changes.price, 100000000)) return bulkError('费用必须是大于或等于 0 的数字');
  if ('currency' in changes) {
    changes.currency = String(changes.currency || '').trim().toUpperCase();
    if (!SUPPORTED_CURRENCIES.has(changes.currency)) return bulkError('币种不受支持');
  }
  if ('billing_cycle' in changes) {
    changes.billing_cycle = String(changes.billing_cycle || '').trim();
    if (!BILLING_CYCLES.has(changes.billing_cycle)) return bulkError('计费周期无效');
  }
  for (const key of ['traffic_enabled', 'alert_enabled']) {
    if (key in changes && typeof changes[key] !== 'boolean') return bulkError(`${key === 'traffic_enabled' ? '流量统计' : '目标报警'}必须为开启或关闭`);
  }
  if ('traffic_quota_gb' in changes && !validRequiredNumber(changes.traffic_quota_gb, 1048576)) return bulkError('流量上限必须是 0–1048576 GB');
  if ('traffic_mode' in changes) {
    changes.traffic_mode = String(changes.traffic_mode || '').trim().toLowerCase();
    if (!TRAFFIC_MODES.has(changes.traffic_mode)) return bulkError('流量计费方式无效');
  }
  if ('traffic_reset_day' in changes) {
    const day = Number(changes.traffic_reset_day);
    if (!Number.isInteger(day) || day < 1 || day > 31) return bulkError('流量重置日需要是 1–31 的整数');
    if (ids.length > 15) return bulkError('流量重置日涉及历史重算，单次最多修改 15 台 VPS');
    changes.traffic_reset_day = day;
  }
  if ('alert_expiry_days' in changes && !validNullableNumber(changes.alert_expiry_days, 3650)) return bulkError('到期报警天数必须是 0–3650');
  if ('alert_traffic_remaining_percent' in changes && !validNullableNumber(changes.alert_traffic_remaining_percent, 100)) return bulkError('流量报警百分比必须是 0–100');
  if ('alert_traffic_remaining_gb' in changes && !validNullableNumber(changes.alert_traffic_remaining_gb, 1048576)) return bulkError('流量报警值必须是 0–1048576 GB');
  return { ok: true, ids, changes };
}

export async function applyBulkTargetColumns(env, ids, changes, now) {
  const placeholders = ids.map(() => '?').join(',');
  const rows = await env.DB.prepare(`SELECT * FROM targets WHERE id IN (${placeholders})`).bind(...ids).all();
  const byId = new Map((rows.results || []).map(row => [String(row.id), row]));
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) return { ...bulkError(`有 ${missing.length} 个目标不存在，请刷新后重试`), byId };
  if (ids.some(id => byId.get(id)?.type !== 'tcp')) return { ...bulkError('批量设置仅支持 VPS 目标'), byId };

  const columns = Object.keys(changes);
  const updates = [env.DB.prepare(`UPDATE targets SET ${columns.map(column => `${column} = ?`).join(', ')}, updated_at = ? WHERE id IN (${placeholders})`)
    .bind(...columns.map(column => changes[column]), now, ...ids)];
  const nodeColumnMap = {
    provider: 'provider', line_type: 'machine_type', expires_at: 'expires_at', price: 'price',
    currency: 'currency', billing_cycle: 'billing_cycle', traffic_enabled: 'traffic_enabled',
    traffic_quota_gb: 'traffic_quota_gb', traffic_mode: 'traffic_mode', traffic_reset_day: 'traffic_reset_day',
    alert_enabled: 'alert_enabled', alert_expiry_days: 'alert_expiry_days',
    alert_traffic_remaining_percent: 'alert_traffic_remaining_percent',
    alert_traffic_remaining_gb: 'alert_traffic_remaining_gb',
  };
  const nodeColumns = columns.filter(column => nodeColumnMap[column]);
  if (nodeColumns.length) {
    const emptyStringColumns = new Set(['provider', 'line_type', 'billing_cycle']);
    updates.push(env.DB.prepare(`UPDATE nodes SET ${nodeColumns.map(column => `${nodeColumnMap[column]} = ?`).join(', ')}, updated_at = ? WHERE id IN (${placeholders})`)
      .bind(...nodeColumns.map(column => changes[column] ?? (emptyStringColumns.has(column) ? '' : null)), now, ...ids));
  }
  await env.DB.batch(updates);
  return { ok: true, count: ids.length, byId };
}

function validBulkExpiry(value) {
  if (value === null || value === '') return true;
  const source = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) {
    const parsed = new Date(`${source}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === source;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function validRequiredNumber(value, max) {
  const numeric = Number(value);
  return value !== '' && value !== null && Number.isFinite(numeric) && numeric >= 0 && numeric <= max;
}

function validNullableNumber(value, max) {
  return value === null || value === '' || validRequiredNumber(value, max);
}

function bulkError(error) {
  return { ok: false, error };
}
