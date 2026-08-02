import { ApiError, safeJson } from '../auth.js';
import { nowSec, sanitizeAgentId } from '../utils.js';
import { normalizeNodeQualityReport, normalizeNodeQualityReportUrl, sanitizeAnsiContent } from '../nodequality.js';
import { uploadNodeQualityReportImages } from '../nq-image-host.js';

export const AGENT_TASK_ACTIONS = Object.freeze({
  nodequality: { timeout_sec: null, label: 'NodeQuality' },
  ip_unlock: { timeout_sec: 600, label: 'IP 解锁' },
});
const NQ_TASK_EXPIRES_SEC = 7 * 24 * 60 * 60;
export const NQ_OPTION_DEFAULTS = Object.freeze({ hardware: 'f', ip: 'y', net: 'y', route: 'y' });
const NQ_OPTION_ALLOWED = Object.freeze({
  hardware: new Set(['y', 'f', 'v', 'n']),
  ip: new Set(['y', 'n']),
  net: new Set(['y', 'l', 'n']),
  route: new Set(['y', 'n']),
});

export function normalizeNqOptions(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const [key, fallback] of Object.entries(NQ_OPTION_DEFAULTS)) {
    const candidate = String(raw[key] ?? fallback).trim().toLowerCase();
    normalized[key] = NQ_OPTION_ALLOWED[key].has(candidate) ? candidate : fallback;
  }
  return normalized;
}

const MAX_RESULT_BYTES = 256 * 1024;
const MAX_EXCERPT_CHARS = 16 * 1024;
const MAX_IP_UNLOCK_REPORT_CHARS = 64 * 1024;
const AGENT_TASK_POLL_SEC = 300;

const MAX_BULK_AGENT_TASKS = 50;


async function resolveAgentTarget(env, agentIdValue) {
  const raw = String(agentIdValue || '').trim();
  const canonical = sanitizeAgentId(raw);
  if (!canonical) return { target: null, canonical: '' };
  const exact = await env.DB.prepare(`SELECT id, name, type, enabled FROM targets WHERE id = ?`).bind(raw).first();
  if (exact) return { target: exact, canonical };
  const canonicalTarget = await env.DB.prepare(`SELECT id, name, type, enabled FROM targets WHERE id = ?`).bind(canonical).first();
  if (canonicalTarget) return { target: canonicalTarget, canonical };
  const rows = await env.DB.prepare(`SELECT id, name, type, enabled FROM targets WHERE enabled = 1 AND type = 'tcp'`).all();
  for (const row of rows.results || []) {
    if (sanitizeAgentId(row.id) === canonical) return { target: row, canonical };
  }
  return { target: null, canonical };
}

async function agentTaskIds(env, agentIdValue) {
  const { target, canonical } = await resolveAgentTarget(env, agentIdValue);
  const ids = canonical ? [canonical] : [];
  if (target && ids.indexOf(target.id) < 0) ids.push(target.id);
  return ids;
}

function inClause(values) {
  return (values || []).map(() => '?').join(',');
}

export async function createAgentTask(request, env) {
  const body = await safeJson(request, 16 * 1024);
  const rawAgentId = String(body?.agent_id || '').trim();
  const action = String(body?.action || '').trim();
  const nqOptions = action === 'nodequality' ? normalizeNqOptions(body?.options) : null;
  if (Array.isArray(body?.agent_ids)) return createAgentTasks(env, body.agent_ids, action, nqOptions);
  if (!sanitizeAgentId(rawAgentId)) throw new ApiError(400, '请选择 Agent');
  return createAgentTaskForAgent(env, rawAgentId, action, nqOptions);
}

export async function createAgentTasks(env, agentIdsValue, action, options = null) {
  const nqOptions = action === 'nodequality' ? normalizeNqOptions(options) : null;
  const seen = new Set();
  const ids = [];
  for (const value of Array.isArray(agentIdsValue) ? agentIdsValue : []) {
    const raw = String(value || '').trim();
    const canonical = sanitizeAgentId(raw);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    ids.push(raw);
  }
  if (!ids.length) throw new ApiError(400, '请选择至少一台 VPS');
  if (ids.length > MAX_BULK_AGENT_TASKS) throw new ApiError(400, `一次最多运行 ${MAX_BULK_AGENT_TASKS} 台 VPS`);
  const created = [];
  const rejected = [];
  for (const agentId of ids) {
    try {
      created.push((await createAgentTaskForAgent(env, agentId, action, nqOptions)).task);
    } catch (error) {
      rejected.push({ agent_id: agentId, error: String(error?.message || '无法排队').slice(0, 200) });
    }
  }
  return { ok: true, bulk: true, action, requested: ids.length, created, rejected };
}

async function createAgentTaskForAgent(env, agentId, action, options = null) {
  const nqOptions = action === 'nodequality' ? normalizeNqOptions(options) : null;
  const policy = AGENT_TASK_ACTIONS[action];
  if (!policy) throw new ApiError(400, '只允许 NodeQuality 或 IP 解锁任务');


  const { target, canonical } = await resolveAgentTarget(env, agentId);
  if (!target || target.type !== 'tcp' || Number(target.enabled || 0) !== 1) {
    throw new ApiError(404, 'Agent 对应的 VPS 不存在或已停用');
  }
  const runtime = await env.DB.prepare(`SELECT updated_at, capabilities FROM agent_metrics_state WHERE agent_id = ?`)
    .bind(canonical).first().catch(() => null);
  const capabilities = parseCapabilities(runtime?.capabilities);
  const lastSeen = Math.floor(new Date(runtime?.updated_at || 0).getTime() / 1000);
  if (!runtime || !lastSeen || nowSec() - lastSeen > 900) {
    throw new ApiError(409, 'Agent 当前离线，暂时不能下发任务');
  }
  if (!capabilities?.actions?.includes(action)) {
    throw new ApiError(409, action === 'nodequality'
      ? '该 VPS 尚未启用 root Manager，请等待自动迁移或查看 Agent 状态'
      : '该 Agent 版本尚不支持此任务，请等待自动更新');
  }
  const taskIds = await agentTaskIds(env, agentId);
  const active = await env.DB.prepare(`SELECT id, action, status FROM agent_tasks WHERE agent_id IN (${inClause(taskIds)}) AND status IN ('queued', 'running') LIMIT 1`)
    .bind(...taskIds).first();
  if (active) throw new ApiError(409, '该 Agent 已有任务正在排队或运行');

  const now = nowSec();
  const id = crypto.randomUUID();
  const expiresAt = now + (policy.timeout_sec ?? NQ_TASK_EXPIRES_SEC) + 900;
  await env.DB.prepare(`INSERT INTO agent_tasks (id, agent_id, action, options, status, requested_at, expires_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?)`)
    .bind(id, agentId, action, nqOptions ? JSON.stringify(nqOptions) : null, now, expiresAt).run();
  return { ok: true, task: taskForAdmin({ id, agent_id: agentId, action, options: nqOptions, status: 'queued', requested_at: now, expires_at: expiresAt }) };
}

function parseCapabilities(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || Number(parsed.protocol) !== 1 || !Array.isArray(parsed.actions)) return null;
    return { actions: parsed.actions.filter(action => AGENT_TASK_ACTIONS[action]) };
  } catch (_) {
    return null;
  }
}

export async function listAgentTasks(env, url) {
  await expireStaleTasks(env);
  const rawAgentId = String(url?.searchParams?.get('agent_id') || '').trim();
  const agentId = sanitizeAgentId(rawAgentId);
  const limit = Math.min(100, Math.max(1, Number(url?.searchParams?.get('limit') || 30)));
  const taskIds = agentId ? await agentTaskIds(env, rawAgentId) : [];
  const rows = taskIds.length
    ? await env.DB.prepare(`SELECT * FROM agent_tasks WHERE agent_id IN (${inClause(taskIds)}) ORDER BY requested_at DESC LIMIT ?`).bind(...taskIds, limit).all()
    : await env.DB.prepare(`SELECT * FROM agent_tasks ORDER BY requested_at DESC LIMIT ?`).bind(limit).all();
  return { ok: true, beta: true, actions: publicActions(), tasks: (rows.results || []).map(taskForAdmin) };
}

export async function claimAgentTask(env, agentIdValue, allowedActionsValue = '') {
  const rawAgentId = String(agentIdValue || '').trim();
  const agentId = sanitizeAgentId(rawAgentId);
  if (!agentId) throw new ApiError(400, '缺少 agent_id');
  const allowedActions = normalizeAllowedActions(allowedActionsValue);
  const taskIds = await agentTaskIds(env, rawAgentId);
  await expireStaleTasks(env, rawAgentId);
  const queued = allowedActions.length === 1
    ? await env.DB.prepare(`SELECT id FROM agent_tasks
      WHERE agent_id IN (${inClause(taskIds)}) AND status = 'queued' AND expires_at > ? AND action = ?
      ORDER BY requested_at ASC LIMIT 1`).bind(...taskIds, nowSec(), allowedActions[0]).first()
    : await env.DB.prepare(`SELECT id FROM agent_tasks
      WHERE agent_id IN (${inClause(taskIds)}) AND status = 'queued' AND expires_at > ?
      ORDER BY requested_at ASC LIMIT 1`).bind(...taskIds, nowSec()).first();
  if (!queued) return { ok: true, beta: true, poll_after_sec: AGENT_TASK_POLL_SEC, task: null };

  const claimedAt = nowSec();
  const update = await env.DB.prepare(`UPDATE agent_tasks SET status = 'running', claimed_at = ?
    WHERE id = ? AND agent_id IN (${inClause(taskIds)}) AND status = 'queued'`)
    .bind(claimedAt, queued.id, ...taskIds).run();
  if (Number(update?.meta?.changes || 0) < 1) return { ok: true, beta: true, poll_after_sec: AGENT_TASK_POLL_SEC, task: null };
  const row = await env.DB.prepare(`SELECT * FROM agent_tasks WHERE id = ?`).bind(queued.id).first();
  const policy = AGENT_TASK_ACTIONS[row.action];
  return {
    ok: true,
    beta: true,
    poll_after_sec: AGENT_TASK_POLL_SEC,
    task: {
      id: row.id,
      action: row.action,
      timeout_sec: policy.timeout_sec,
      ...(row.action === 'nodequality' ? { options: parseStoredOptions(row.options) } : {}),
    },
  };
}

function normalizeAllowedActions(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const actions = [...new Set(raw.split(',').map((item) => item.trim()).filter((item) => AGENT_TASK_ACTIONS[item]))];
  if (!actions.length) throw new ApiError(400, '没有可用的任务类型');
  if (actions.length !== 1) throw new ApiError(400, '每个受限任务领取器只能声明一种能力');
  return actions;
}

export async function completeAgentTask(request, env, taskId, agentIdValue) {
  const agentId = sanitizeAgentId(agentIdValue || '');
  const row = await env.DB.prepare(`SELECT * FROM agent_tasks WHERE id = ?`).bind(taskId).first();
  if (!row || sanitizeAgentId(row.agent_id) !== agentId) throw new ApiError(404, '任务不存在');
  if (row.status !== 'running') throw new ApiError(409, '任务不在运行状态');

  const body = await safeJson(request, MAX_RESULT_BYTES);
  const succeeded = body?.status === 'succeeded';
  if (!succeeded && body?.status !== 'failed') throw new ApiError(400, '任务状态只能是 succeeded 或 failed');
  const result = succeeded ? normalizeTaskResult(row.action, body?.result) : null;
  const error = String(body?.error || '').trim().slice(0, 2000) || null;
  const excerpt = String(body?.output_excerpt || '').slice(0, MAX_EXCERPT_CHARS) || null;
  const agentVersion = String(body?.agent_version || '').trim().slice(0, 32) || null;
  const finishedAt = nowSec();
  let normalizedNq = succeeded && row.action === 'nodequality' && result?.report
    ? normalizeAgentNodeQualityReport(result, finishedAt)
    : null;
  let imageUpload = null;
  if (normalizedNq) {
    try {
      const target = await env.DB.prepare('SELECT name FROM targets WHERE id = ?').bind(row.agent_id).first().catch(() => null);
      const uploaded = await uploadNodeQualityReportImages(env, normalizedNq, {
        agentId,
        targetName: String(target?.name || '').trim(),
        finishedAt,
      });
      normalizedNq = uploaded.normalized;
      imageUpload = uploaded.status;
    } catch (uploadError) {
      imageUpload = { enabled: true, uploaded: 0, errors: [String(uploadError?.message || '图床上传失败').slice(0, 180)] };
    }
  } else if (succeeded && row.action === 'nodequality') {
    imageUpload = { enabled: true, uploaded: 0, errors: ['Agent 未返回可保存的 NodeQuality 报告内容'] };
  }
  const storedResult = result && row.action === 'nodequality'
    ? {
        report_url: result.report_url,
        report_saved: Boolean(normalizedNq?.report),
        tabs: normalizedNq?.summary?.tabs || [],
        image_upload: imageUpload,
      }
    : result;
  await env.DB.prepare(`UPDATE agent_tasks SET status = ?, finished_at = ?, result = ?, error = ?, output_excerpt = ?, agent_version = ?
    WHERE id = ? AND agent_id = ? AND status = 'running'`)
    .bind(succeeded ? 'succeeded' : 'failed', finishedAt, storedResult ? JSON.stringify(storedResult) : null, error, excerpt, agentVersion, taskId, row.agent_id).run();

  if (succeeded && row.action === 'nodequality' && result?.report_url) {
    await env.DB.prepare(`UPDATE targets SET nq_url = ?, nq_report = COALESCE(?, nq_report), nq_updated_at = ?, updated_at = ? WHERE id = ?`)
      .bind(result.report_url, normalizedNq?.report || null, finishedAt, finishedAt, row.agent_id).run();
  }
  if (succeeded && row.action === 'ip_unlock' && Array.isArray(result?.services)) {
    await env.DB.prepare(`UPDATE targets SET unlock_data = ?, unlock_updated_at = ?, updated_at = ? WHERE id = ?`)
      .bind(JSON.stringify({ checked_at: finishedAt, source: 'IP.Check.Place', services: result.services }), finishedAt, finishedAt, row.agent_id).run();
  }
  return { ok: true, task: taskForAdmin({ ...row, status: succeeded ? 'succeeded' : 'failed', finished_at: finishedAt, result: storedResult ? JSON.stringify(storedResult) : null, error, output_excerpt: excerpt, agent_version: agentVersion }) };
}

export async function cancelAgentTask(env, taskId) {
  const now = nowSec();
  const result = await env.DB.prepare(`UPDATE agent_tasks SET status = 'cancelled', finished_at = ?
    WHERE id = ? AND status = 'queued'`).bind(now, taskId).run();
  if (Number(result?.meta?.changes || 0) < 1) throw new ApiError(409, '只有排队中的任务可以取消');
  return { ok: true };
}

const IP_REPORT_TAIL_MARKERS = [/今日IP检测量/, /总检测量/, /感谢使用xy系列脚本/, /报告链接/, /Report Link/];

function plainReportLine(raw) {
  return String(raw || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').trim();
}

function trimReportAdFooter(text) {
  const lines = String(text || '').split(/\r?\n/);
  let cut = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = plainReportLine(lines[i]);
    if (IP_REPORT_TAIL_MARKERS.some((item) => item.test(line))) cut = i;
  }
  if (cut < 0) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = plainReportLine(lines[i]);
      if (line.startsWith('TERM environment variable not set.') || /^[A-Z][A-Z0-9.]{5,}$/.test(line)) {
        cut = i - 1;
        break;
      }
    }
  }
  const body = cut >= 0 ? lines.slice(0, cut + 1).join('\n') : String(text || '');
  const trimmed = body.replace(/\s+$/u, '');
  return cut >= 0 && cut + 1 < lines.length ? `${trimmed}\n` : trimmed;
}

export function normalizeTaskResult(action, value) {
  const result = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (action === 'nodequality') {
    const reportUrl = String(result.report_url || '').trim();
    const normalizedUrl = normalizeNodeQualityReportUrl(reportUrl);
    if (!normalizedUrl) {
      throw new ApiError(400, 'NodeQuality 结果必须是 https://nodequality.com/r/<报告ID>');
    }
    const report = result.report && typeof result.report === 'object' && !Array.isArray(result.report)
      ? result.report
      : null;
    return { report_url: normalizedUrl, report };
  }
  if (action === 'ip_unlock') {
    const services = Array.isArray(result.services) ? result.services.slice(0, 20).map(normalizeUnlockService).filter(Boolean) : [];
    if (!services.length) throw new ApiError(400, 'IP 解锁结果中没有可识别的 IPv4 解锁数据');
    const rawReport = typeof result.report === 'string' && result.report.trim()
      ? trimReportAdFooter(sanitizeAnsiContent(result.report))
      : '';
    const report = rawReport ? rawReport.slice(0, MAX_IP_UNLOCK_REPORT_CHARS) : null;
    return { services, ...(report ? { report } : {}) };
  }
  throw new ApiError(400, '未知任务类型');
}

function normalizeAgentNodeQualityReport(result, finishedAt) {
  try {
    return normalizeNodeQualityReport({ ...result.report, link: result.report_url, source: 'agent' }, { now: finishedAt });
  } catch (error) {
    throw new ApiError(400, `Agent 返回的 NodeQuality 报告无法解析：${error.message}`);
  }
}

function normalizeUnlockService(item) {
  if (!item || typeof item !== 'object') return null;
  const name = String(item.name || item.id || '').trim().slice(0, 40);
  const status = String(item.status || '').trim().slice(0, 80);
  const region = String(item.region || '').trim().slice(0, 40);
  const method = String(item.method || '').trim().slice(0, 40);
  if (!name || (!status && !region && !method)) return null;
  const id = String(item.id || name).toLowerCase().replace(/[^a-z0-9_+-]/g, '_').slice(0, 40);
  return { id, name, status, region, method };
}

function parseStoredOptions(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return normalizeNqOptions(parsed);
  } catch (_) {
    return { ...NQ_OPTION_DEFAULTS };
  }
}

async function expireStaleTasks(env, agentId = '') {
  const now = nowSec();
  const taskIds = agentId ? await agentTaskIds(env, agentId) : [];
  if (taskIds.length) {
    await env.DB.prepare(`UPDATE agent_tasks SET status = 'expired', finished_at = ?
      WHERE agent_id IN (${inClause(taskIds)}) AND status IN ('queued', 'running') AND expires_at <= ?`).bind(now, ...taskIds, now).run();
  } else {
    await env.DB.prepare(`UPDATE agent_tasks SET status = 'expired', finished_at = ?
      WHERE status IN ('queued', 'running') AND expires_at <= ?`).bind(now, now).run();
  }
}

function taskForAdmin(row) {
  let result = null;
  try { result = row?.result ? JSON.parse(row.result) : null; } catch (_) {}
  const invalidNodeQualityResult = row.action === 'nodequality'
    && result?.report_url
    && !normalizeNodeQualityReportUrl(result.report_url);
  if (row.action === 'nodequality' && result?.report_url && !invalidNodeQualityResult) {
    result.report_url = normalizeNodeQualityReportUrl(result.report_url);
  } else if (invalidNodeQualityResult) {
    result = null;
  }
  return {
    id: row.id,
    agent_id: row.agent_id,
    action: row.action,
    action_label: AGENT_TASK_ACTIONS[row.action]?.label || row.action,
    status: invalidNodeQualityResult && row.status === 'succeeded' ? 'failed' : row.status,
    requested_at: Number(row.requested_at || 0) || null,
    claimed_at: Number(row.claimed_at || 0) || null,
    finished_at: Number(row.finished_at || 0) || null,
    expires_at: Number(row.expires_at || 0) || null,
    options: row.action === 'nodequality' ? parseStoredOptions(row.options) : null,
    result,
    error: row.error || (invalidNodeQualityResult ? '旧任务没有生成有效的 NodeQuality 报告链接，请重新运行 NQ' : null),
    output_excerpt: row.output_excerpt || null,
    agent_version: row.agent_version || null,
  };
}

function publicActions() {
  return Object.entries(AGENT_TASK_ACTIONS).map(([id, action]) => ({ id, ...action }));
}
