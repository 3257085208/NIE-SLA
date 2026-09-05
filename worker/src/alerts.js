import { clamp, nowSec, parseBoolean, sanitizeAgentId, isPrivateHost, bytesToBase64, base64ToBytes } from './utils.js';
import { summarizeTrafficWithPending, trafficSettingsFromTarget } from './traffic.js';
import { ApiError, safeJson } from './auth.js';
import { readR2State } from './storage.js';
import { bufferedAgentStateEnabled, mergeAgentMetricRows } from './agent-state.js';
import { readFleetLatestAgentStates } from './telemetry-buffer.js';

const SETTINGS_KEY = 'alert_settings';
const TG_TOKEN_KEY = 'alert_telegram_bot_token';
const RESEND_KEY = 'alert_resend_api_key';
const ALERT_STATE_CACHE = Symbol('alert_state_cache');
const SECRET_PREFIX = 'enc:v1:';
const DEFAULT_TELEGRAM_TEMPLATE = '{{title}}\n{{message}}\n\n{{site_name}} · {{time}}';
const DEFAULT_EMAIL_SUBJECT_TEMPLATE = '{{site_name}} · {{title}}';
const DEFAULT_EMAIL_TEMPLATE = '{{message}}\n\n站点：{{site_name}}\n时间：{{time}}';
const TEMPLATE_KEYS = ['title', 'message', 'site_name', 'time', 'alert_count', 'channel'];
const DEFAULT_SETTINGS = {
  enabled: false,
  telegram_enabled: true,
  telegram_chat_id: '',
  telegram_format: 'plain',
  telegram_template: DEFAULT_TELEGRAM_TEMPLATE,
  telegram_message_thread_id: '',
  telegram_disable_web_preview: true,
  telegram_silent: false,
  email_enabled: false,
  email_from: '',
  email_to: '',
  email_reply_to: '',
  email_format: 'text',
  email_subject_template: DEFAULT_EMAIL_SUBJECT_TEMPLATE,
  email_template: DEFAULT_EMAIL_TEMPLATE,
  offline_minutes: 10,
  repeat_minutes: 360,
  notify_online: true,
  cpu_percent: 90,
  memory_percent: 90,
  disk_percent: 90,
  load1: 0,
  disk_read_mb_s: 0,
  disk_write_mb_s: 0,
  net_rx_mb_s: 0,
  net_tx_mb_s: 0,
  process_count: 0,
  thread_count: 0,
  expiry_days: 7,
  traffic_remaining_percent: 10,
  traffic_remaining_gb: 0,
};

const NUMERIC_FIELDS = new Set([
  'offline_minutes',
  'repeat_minutes',
  'cpu_percent',
  'memory_percent',
  'disk_percent',
  'load1',
  'disk_read_mb_s',
  'disk_write_mb_s',
  'net_rx_mb_s',
  'net_tx_mb_s',
  'process_count',
  'thread_count',
  'expiry_days',
  'traffic_remaining_percent',
  'traffic_remaining_gb',
]);

const BOOLEAN_FIELDS = new Set([
  'enabled',
  'telegram_enabled',
  'telegram_disable_web_preview',
  'telegram_silent',
  'email_enabled',
  'notify_online',
]);

export async function getAlertSettings(env, options = {}) {
  const stored = await readStoredSettings(env);
  const settings = normalizeAlertSettings(stored);
  const token = await telegramToken(env);
  const resendKey = await resendApiKey(env);
  const chatId = telegramChatId(env, settings);
  const out = {
    ...settings,
    telegram_chat_id: chatId || settings.telegram_chat_id || '',
    telegram_bot_token_set: Boolean(token),
    telegram_bot_token_source: String(env.TELEGRAM_BOT_TOKEN || env.TG_BOT_TOKEN || '').trim() ? 'env' : (token ? 'db' : 'none'),
    email_from: emailFrom(env, settings),
    email_to: emailTo(env, settings).join(', '),
    email_reply_to: emailReplyTo(env, settings),
    resend_api_key_set: Boolean(resendKey),
    resend_api_key_source: String(env.RESEND_API_KEY || '').trim() ? 'env' : (resendKey ? 'db' : 'none'),
    last_result: await readAlertLastResult(env),
  };
  if (options.includeSecret) {
    out.telegram_bot_token = token;
    out.resend_api_key = resendKey;
  }
  return out;
}

export async function updateAlertSettings(request, env) {
  if (!env.DB) return { ok: false, error: '缺少 D1 的 DB 绑定' };
  const body = await safeJson(request);
  validateNotificationTemplates(body);
  const previous = await readStoredSettings(env);
  const next = normalizeAlertSettings({ ...previous, ...pickSettings(body) });
  await setMeta(env, SETTINGS_KEY, JSON.stringify(next));

  if (Object.prototype.hasOwnProperty.call(body || {}, 'telegram_bot_token')) {
    const token = String(body.telegram_bot_token || '').trim();
    if (token) await setMeta(env, TG_TOKEN_KEY, await encryptSecret(token, env));
  }
  if (parseBoolean(body?.telegram_bot_token_clear, false)) await setMeta(env, TG_TOKEN_KEY, '');
  if (Object.prototype.hasOwnProperty.call(body || {}, 'resend_api_key')) {
    const key = String(body.resend_api_key || '').trim();
    if (key) await setMeta(env, RESEND_KEY, await encryptSecret(key, env));
  }
  if (parseBoolean(body?.resend_api_key_clear, false)) await setMeta(env, RESEND_KEY, '');
  return { ok: true, ...(await getAlertSettings(env)) };
}

export async function sendTestAlert(request, env) {
  const body = await safeJson(request).catch(() => ({}));
  const settings = await getAlertSettings(env, { includeSecret: true });
  const text = [
    `NIE-SLA 测试报警`,
    `站点：${String(env.PUBLIC_SITE_NAME || 'NIE-SLA')}`,
    `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
    body?.message ? `备注：${String(body.message).slice(0, 200)}` : '',
  ].filter(Boolean).join('\n');
  const channel = String(body?.channel || 'telegram').trim().toLowerCase();
  const result = channel === 'email'
    ? await sendEmail(env, settings, text, 'NIE-SLA 测试报警', 1)
    : await sendTelegram(env, settings, text, 'NIE-SLA 测试报警', 1);
  return { ok: result.ok, error: result.error || undefined };
}

export async function runAlertChecks(env, options = {}) {
  if (!env.DB) return { ok: true, skipped: true, reason: 'no_db' };
  const settings = await getAlertSettings(env, { includeSecret: true });
  if (!settings.enabled && !options.force) return finishAlertRun(env, { ok: true, skipped: true, reason: 'disabled' });
  const channels = configuredAlertChannels(env, settings);
  if (!channels.length) return finishAlertRun(env, { ok: true, skipped: true, reason: 'channels_not_configured' });
  await ensureAlertStateTable(env);

  const [targetRows, metricRows, trafficRows, latestRows, stateRows, bufferedMetrics] = await Promise.all([
    env.DB.prepare(`SELECT * FROM targets WHERE enabled = 1 ORDER BY group_name, name`).all(),
    env.DB.prepare(`SELECT * FROM agent_metrics_state`).all(),
    env.DB.prepare(`SELECT * FROM agent_traffic_monthly`).all(),
    env.DB.prepare(`SELECT * FROM latest_status`).all(),
    env.DB.prepare(`SELECT * FROM alert_state`).all(),
    bufferedAgentStateEnabled(env) ? readFleetLatestAgentStates(env).catch((error) => {
      console.error('Alert buffered Agent metrics unavailable:', String(error?.message || error));
      return {};
    }) : Promise.resolve({}),
  ]);

  const alertEnv = Object.create(env);
  alertEnv[ALERT_STATE_CACHE] = new Map(
    (stateRows.results || []).map((row) => [alertStateKey(row.target_id, row.rule_key), row]),
  );

  const metricsByAgent = new Map();
  for (const row of mergeAgentMetricRows(metricRows.results, bufferedMetrics)) {
    const id = sanitizeAgentId(row.agent_id);
    if (id) metricsByAgent.set(id, row);
  }

  const trafficByKey = new Map();
  for (const row of trafficRows.results || []) {
    trafficByKey.set(`${sanitizeAgentId(row.agent_id)}|${row.month}`, row);
  }

  const latestByTarget = new Map();
  for (const row of latestRows.results || []) {
    if (row.target_id) latestByTarget.set(String(row.target_id), row);
  }
  const r2State = await readR2State(env).catch(() => ({ targets: {} }));
  for (const [targetId, state] of Object.entries(r2State.targets || {})) {
    const current = latestByTarget.get(targetId);
    if (!current || Number(state?.checked_at || 0) > Number(current?.checked_at || 0)) latestByTarget.set(targetId, state);
  }

  const now = nowSec();
  const messages = [];
  const maxMessages = clamp(Number(options.max_messages || env.ALERT_MAX_MESSAGES_PER_RUN || 30), 1, 100);
  for (const target of targetRows.results || []) {
    if (messages.length >= maxMessages) break;
    const targetSettings = targetAlertSettings(target, settings);
    if (!targetSettings.enabled) continue;
    const agentId = sanitizeAgentId(target.id);
    const metric = metricsByAgent.get(agentId) || null;
    const latest = latestByTarget.get(String(target.id)) || null;
    await collectProbeStaleAlert(alertEnv, targetSettings, target, latest, now, messages, maxMessages);
    if (messages.length >= maxMessages) break;
    await collectProbeDownAlert(alertEnv, targetSettings, target, latest, now, messages, maxMessages);
    if (messages.length >= maxMessages) break;
    await collectOfflineAlert(alertEnv, targetSettings, target, metric, now, messages, maxMessages);
    if (messages.length >= maxMessages) break;
    await collectMetricAlerts(alertEnv, targetSettings, target, metric, now, messages, maxMessages);
    if (messages.length >= maxMessages) break;
    await collectExpiryAlert(alertEnv, targetSettings, target, now, messages, maxMessages);
    if (messages.length >= maxMessages) break;
    await collectTrafficAlert(alertEnv, targetSettings, target, trafficByKey, metric, now, messages, maxMessages);
  }

  const sent = [];
  const errors = [];
  const batches = buildAlertBatches(messages);
  let telegramMessages = 0;
  let emailMessages = 0;
  for (const batch of batches) {
    const results = [];
    const title = `NIE-SLA 报警汇总（${batch.items.length} 条）`;
    if (channels.includes('telegram')) {
      const result = await sendTelegram(env, settings, batch.text, title, batch.items.length);
      results.push({ channel: 'telegram', ...result });
      if (result.ok) telegramMessages++;
    }
    if (channels.includes('email')) {
      const result = await sendEmail(env, settings, batch.text, title, batch.items.length);
      results.push({ channel: 'email', ...result });
      if (result.ok) emailMessages++;
    }
    if (results.some((result) => result.ok)) {
      for (const item of batch.items) {
        await item.commit();
        sent.push({ target_id: item.targetId, rule_key: item.ruleKey });
      }
    }
    for (const result of results.filter((item) => !item.ok)) {
      for (const item of batch.items) {
        errors.push({ target_id: item.targetId, rule_key: item.ruleKey, channel: result.channel, error: result.error });
      }
    }
  }
  return finishAlertRun(env, { ok: errors.length === 0, checked: (targetRows.results || []).length, queued: messages.length, sent: sent.length, telegram_messages: telegramMessages, email_messages: emailMessages, errors });
}

function buildAlertBatches(messages, maxChars = 2400) {
  if (!messages.length) return [];
  const batches = [];
  let current = [];
  let currentText = '';
  const headerFor = (start, count = 0) => `NIE-SLA 报警汇总（${messages.length} 条${messages.length > 1 ? `，${start + 1}-${start + count}` : ''}）`;

  const flush = () => {
    if (!current.length) return;
    const start = messages.indexOf(current[0]);
    batches.push({ items: current, text: `${headerFor(start, current.length)}\n${currentText}`.slice(0, 3900) });
    current = [];
    currentText = '';
  };

  messages.forEach((item, index) => {
    const entry = `\n${index + 1}. ${String(item.text || '').trim().replace(/\n{3,}/g, '\n\n').slice(0, 900)}`;
    const candidate = currentText ? `${currentText}\n${entry}` : entry;
    if (current.length && headerFor(index, current.length).length + candidate.length > maxChars) flush();
    current.push(item);
    currentText = currentText ? `${currentText}\n${entry}` : entry;
  });
  flush();
  return batches;
}

async function collectProbeStaleAlert(env, settings, target, latest, now, messages, maxMessages) {
  const ruleKey = 'probe_stale';
  if (isAgentOnlyProbe(target, latest)) {
    await clearIfActive(env, target.id, ruleKey, now);
    return;
  }
  const latestAt = Math.max(Number(latest?.checked_at || 0), Number(target?.last_checked_at || 0));
  if (!latestAt) return;
  const staleSec = now - latestAt;
  const isStale = staleSec >= probeStaleThresholdSec(settings, target);
  const state = await getAlertState(env, target.id, ruleKey);
  if (isStale) {
    const text = [
      `🟠 VPS 探测无数据：${targetLabel(target)}`,
      `最后探测：${formatDateTime(latestAt)}`,
      `已中断：${formatDuration(staleSec)}`,
      `阈值：${formatDuration(probeStaleThresholdSec(settings, target))}`,
    ].join('\n');
    await enqueueActiveAlert(env, settings, messages, maxMessages, target.id, ruleKey, text, { value: staleSec });
  } else if (state?.status === 'active') {
    const text = [
      `🟢 VPS 探测恢复：${targetLabel(target)}`,
      `恢复探测：${formatDateTime(latestAt)}`,
    ].join('\n');
    if (settings.notify_online) {
      messages.push({
        targetId: target.id,
        ruleKey,
        text,
        commit: () => markResolved(env, target.id, ruleKey, now),
      });
    } else {
      await markResolved(env, target.id, ruleKey, now);
    }
  }
}

async function collectProbeDownAlert(env, settings, target, latest, now, messages, maxMessages) {
  const ruleKey = 'probe_down';
  if (!latest || isAgentOnlyProbe(target, latest) || isProbeStale(settings, target, latest, now)) {
    if (isAgentOnlyProbe(target, latest)) await clearIfActive(env, target.id, ruleKey, now);
    return;
  }
  const state = await getAlertState(env, target.id, ruleKey);
  const isDown = Number(latest.ok || 0) !== 1;
  if (isDown) {
    const downAt = Number(latest.current_outage_started_at || latest.checked_at || 0) || now;
    const downSec = now - downAt;
    if (downSec < offlineThresholdSec(settings)) return;
    const text = [
      `🔴 VPS 探测异常：${targetLabel(target)}`,
      `开始时间：${formatDateTime(downAt)}`,
      `已异常：${formatDuration(downSec)}`,
      latest.error ? `错误：${String(latest.error).slice(0, 180)}` : '',
    ].filter(Boolean).join('\n');
    await enqueueActiveAlert(env, settings, messages, maxMessages, target.id, ruleKey, text, { value: downSec });
  } else if (state?.status === 'active') {
    const text = [
      `🟢 VPS 探测恢复：${targetLabel(target)}`,
      `恢复时间：${formatDateTime(Number(latest.checked_at || now))}`,
      latest.latency_ms != null ? `延迟：${Math.round(Number(latest.latency_ms))} ms` : '',
    ].filter(Boolean).join('\n');
    if (settings.notify_online) {
      messages.push({
        targetId: target.id,
        ruleKey,
        text,
        commit: () => markResolved(env, target.id, ruleKey, now),
      });
    } else {
      await markResolved(env, target.id, ruleKey, now);
    }
  }
}

async function collectOfflineAlert(env, settings, target, metric, now, messages, maxMessages) {
  const ruleKey = 'agent_offline';
  const thresholdSec = clamp(Number(settings.offline_minutes || 10), 1, 1440) * 60;
  const seenAt = metricUpdatedAtSec(metric);
  const isOffline = Boolean(seenAt && now - seenAt >= thresholdSec);
  if (!metric && !seenAt) return;
  const label = targetLabel(target);
  const state = await getAlertState(env, target.id, ruleKey);
  if (isOffline) {
    const duration = formatDuration(now - seenAt);
    const text = [
      `🔴 VPS 离线：${label}`,
      `最后上报：${formatDateTime(seenAt)}`,
      `已失联：${duration}`,
      `阈值：${settings.offline_minutes} 分钟`,
    ].join('\n');
    await enqueueActiveAlert(env, settings, messages, maxMessages, target.id, ruleKey, text, { value: now - seenAt });
  } else if (state?.status === 'active') {
    const text = [
      `🟢 VPS 上线：${label}`,
      `恢复上报：${formatDateTime(now)}`,
      seenAt ? `最后上报：${formatDateTime(seenAt)}` : '',
    ].filter(Boolean).join('\n');
    if (settings.notify_online) {
      messages.push({
        targetId: target.id,
        ruleKey,
        text,
        commit: () => markResolved(env, target.id, ruleKey, now),
      });
    } else {
      await markResolved(env, target.id, ruleKey, now);
    }
  }
}

async function collectMetricAlerts(env, settings, target, metric, now, messages, maxMessages) {
  const seenAt = metricUpdatedAtSec(metric);
  if (!metric || !seenAt || now - seenAt > clamp(Number(settings.offline_minutes || 10), 1, 1440) * 120) return;
  const values = metricValues(metric);
  const rules = [
    ['metric_cpu', 'CPU', values.cpuPercent, Number(settings.cpu_percent || 0), '%', (v) => `${v.toFixed(1)}%`],
    ['metric_memory', '内存', values.memoryPercent, Number(settings.memory_percent || 0), '%', (v) => `${v.toFixed(1)}%`],
    ['metric_disk', '硬盘', values.diskPercent, Number(settings.disk_percent || 0), '%', (v) => `${v.toFixed(1)}%`],
    ['metric_load1', '负载', values.load1, Number(settings.load1 || 0), '', (v) => v.toFixed(2)],
    ['metric_disk_read', '磁盘读', values.diskReadBytesSec, Number(settings.disk_read_mb_s || 0) * 1024 * 1024, 'B/s', formatBytesPerSec],
    ['metric_disk_write', '磁盘写', values.diskWriteBytesSec, Number(settings.disk_write_mb_s || 0) * 1024 * 1024, 'B/s', formatBytesPerSec],
    ['metric_net_rx', '下行', values.netRxBytesSec, Number(settings.net_rx_mb_s || 0) * 1024 * 1024, 'B/s', formatBytesPerSec],
    ['metric_net_tx', '上行', values.netTxBytesSec, Number(settings.net_tx_mb_s || 0) * 1024 * 1024, 'B/s', formatBytesPerSec],
    ['metric_process_count', '进程数', values.processCount, Number(settings.process_count || 0), '', (v) => String(Math.round(v))],
    ['metric_thread_count', '线程数', values.threadCount, Number(settings.thread_count || 0), '', (v) => String(Math.round(v))],
  ];
  for (const [ruleKey, label, value, threshold, unit, formatter] of rules) {
    if (messages.length >= maxMessages) return;
    if (!Number.isFinite(value) || !Number.isFinite(threshold) || threshold <= 0) {
      await clearIfActive(env, target.id, ruleKey, now);
      continue;
    }
    if (value > threshold) {
      const thresholdText = unit === 'B/s' ? formatBytesPerSec(threshold) : `${threshold}${unit}`;
      const text = [
        `⚠️ VPS 指标超限：${targetLabel(target)}`,
        `项目：${label}`,
        `当前：${formatter(value)}`,
        `阈值：${thresholdText}`,
        `上报：${formatDateTime(seenAt)}`,
      ].join('\n');
      await enqueueActiveAlert(env, settings, messages, maxMessages, target.id, ruleKey, text, { value });
    } else {
      await clearIfActive(env, target.id, ruleKey, now);
    }
  }
}

async function collectExpiryAlert(env, settings, target, now, messages, maxMessages) {
  const daysThreshold = Number(settings.expiry_days || 0);
  const expiresAt = Number(target.expires_at || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0 || !Number.isFinite(daysThreshold) || daysThreshold <= 0) {
    await clearIfActive(env, target.id, 'expiry', now);
    return;
  }
  const daysLeft = Math.ceil((expiresAt - now) / 86400);
  if (daysLeft < 0 || daysLeft > daysThreshold) {
    await clearIfActive(env, target.id, 'expiry', now);
    return;
  }
  const text = [
    `⏰ VPS 即将到期：${targetLabel(target)}`,
    `到期时间：${formatDateOnly(expiresAt)}`,
    `剩余：${daysLeft} 天`,
    target.price != null ? `费用：${target.price} ${target.currency || 'USD'}${target.billing_cycle ? ` / ${target.billing_cycle}` : ''}` : '',
  ].filter(Boolean).join('\n');
  await enqueueActiveAlert(env, settings, messages, maxMessages, target.id, `expiry:${expiresAt}`, text, { value: daysLeft });
}

async function collectTrafficAlert(env, settings, target, trafficByKey, metric, now, messages, maxMessages) {
  const trafficSettings = trafficSettingsFromTarget(target, env, now);
  if (!trafficSettings.enabled || trafficSettings.quota_bytes <= 0) {
    await clearTrafficStates(env, target.id, now);
    return;
  }
  const row = trafficByKey.get(`${sanitizeAgentId(target.id)}|${trafficSettings.month}`);
  const traffic = summarizeTrafficWithPending(row, trafficSettings, metric);
  const remainingBytes = Math.max(0, traffic.quota_bytes - traffic.total_bytes);
  const remainingPercent = traffic.quota_bytes > 0 ? Math.max(0, 100 - Number(traffic.percent || 0)) : 100;
  const percentLimit = Number(settings.traffic_remaining_percent || 0);
  const gbLimit = Number(settings.traffic_remaining_gb || 0);
  const hitPercent = Number.isFinite(percentLimit) && percentLimit > 0 && remainingPercent <= percentLimit;
  const hitGb = Number.isFinite(gbLimit) && gbLimit > 0 && remainingBytes <= gbLimit * 1024 * 1024 * 1024;
  const ruleKey = `traffic:${traffic.month || trafficSettings.month}`;
  if (!hitPercent && !hitGb) {
    await clearIfActive(env, target.id, ruleKey, now);
    return;
  }
  const reasons = [];
  if (hitPercent) reasons.push(`剩余百分比 ≤ ${percentLimit}%`);
  if (hitGb) reasons.push(`剩余流量 ≤ ${gbLimit} GB`);
  const text = [
    `📉 VPS 流量不足：${targetLabel(target)}`,
    `已用：${formatBytes(traffic.total_bytes)} / ${formatBytes(traffic.quota_bytes)} (${traffic.percent ?? 0}%)`,
    `剩余：${formatBytes(remainingBytes)} (${remainingPercent.toFixed(1)}%)`,
    `计费方式：${traffic.mode_label || traffic.mode}`,
    `周期：${traffic.period_start || '-'} ~ ${traffic.period_end || '-'}`,
    `触发：${reasons.join('，')}`,
  ].join('\n');
  await enqueueActiveAlert(env, settings, messages, maxMessages, target.id, ruleKey, text, { value: remainingBytes });
}

async function enqueueActiveAlert(env, settings, messages, maxMessages, targetId, ruleKey, text, extra = {}) {
  if (messages.length >= maxMessages) return;
  const now = nowSec();
  const state = await getAlertState(env, targetId, ruleKey);
  const repeatSec = clamp(Number(settings.repeat_minutes || 360), 0, 10080) * 60;
  const shouldSend = !state || state.status !== 'active' || !state.last_sent_at || (repeatSec > 0 && now - Number(state.last_sent_at) >= repeatSec);
  if (!shouldSend) return;
  messages.push({
    targetId,
    ruleKey,
    text,
    commit: () => markActive(env, targetId, ruleKey, now, extra.value),
  });
}

async function clearIfActive(env, targetId, ruleKey, now) {
  const state = await getAlertState(env, targetId, ruleKey);
  if (state?.status === 'active') await markResolved(env, targetId, ruleKey, now);
}

async function clearTrafficStates(env, targetId, now) {
  const cache = env[ALERT_STATE_CACHE];
  if (cache) {
    for (const row of cache.values()) {
      if (String(row.target_id) === String(targetId) && String(row.rule_key).startsWith('traffic:') && row.status === 'active') {
        await markResolved(env, targetId, row.rule_key, now);
      }
    }
    return;
  }
  try {
    const rows = await env.DB.prepare(`SELECT rule_key FROM alert_state WHERE target_id = ? AND rule_key LIKE 'traffic:%' AND status = 'active'`).bind(targetId).all();
    for (const row of rows.results || []) await markResolved(env, targetId, row.rule_key, now);
  } catch (_) {}
}

async function getAlertState(env, targetId, ruleKey) {
  const cache = env[ALERT_STATE_CACHE];
  if (cache) return cache.get(alertStateKey(targetId, ruleKey)) || null;
  try {
    return await env.DB.prepare(`SELECT * FROM alert_state WHERE target_id = ? AND rule_key = ?`).bind(targetId, ruleKey).first();
  } catch (_) {
    return null;
  }
}

async function markActive(env, targetId, ruleKey, now, value = null) {
  await env.DB.prepare(`
    INSERT INTO alert_state (target_id, rule_key, status, last_value, opened_at, resolved_at, last_sent_at, updated_at)
    VALUES (?, ?, 'active', ?, ?, NULL, ?, ?)
    ON CONFLICT(target_id, rule_key) DO UPDATE SET
      status='active',
      last_value=excluded.last_value,
      opened_at=CASE WHEN alert_state.status = 'active' THEN alert_state.opened_at ELSE excluded.opened_at END,
      resolved_at=NULL,
      last_sent_at=excluded.last_sent_at,
      updated_at=excluded.updated_at
  `).bind(targetId, ruleKey, value == null ? null : Number(value), now, now, now).run();
  env[ALERT_STATE_CACHE]?.set(alertStateKey(targetId, ruleKey), {
    target_id: targetId,
    rule_key: ruleKey,
    status: 'active',
    last_value: value == null ? null : Number(value),
    opened_at: now,
    resolved_at: null,
    last_sent_at: now,
    updated_at: now,
  });
}

async function markResolved(env, targetId, ruleKey, now) {
  await env.DB.prepare(`
    INSERT INTO alert_state (target_id, rule_key, status, opened_at, resolved_at, last_sent_at, updated_at)
    VALUES (?, ?, 'ok', NULL, ?, NULL, ?)
    ON CONFLICT(target_id, rule_key) DO UPDATE SET
      status='ok',
      resolved_at=excluded.resolved_at,
      updated_at=excluded.updated_at
  `).bind(targetId, ruleKey, now, now).run();
  env[ALERT_STATE_CACHE]?.set(alertStateKey(targetId, ruleKey), {
    ...(env[ALERT_STATE_CACHE]?.get(alertStateKey(targetId, ruleKey)) || {}),
    target_id: targetId,
    rule_key: ruleKey,
    status: 'ok',
    resolved_at: now,
    updated_at: now,
  });
}

function alertStateKey(targetId, ruleKey) {
  return `${String(targetId || '')}\u0000${String(ruleKey || '')}`;
}

async function sendTelegram(env, settings, text, title = 'NIE-SLA 报警', alertCount = 1) {
  const token = settings.telegram_bot_token || await telegramToken(env);
  const chatId = telegramChatId(env, settings);
  if (!token || !chatId) return { ok: false, error: '缺少 Telegram Bot Token 或 Chat ID' };
  try {
    const format = normalizeTelegramFormat(settings.telegram_format);
    const rendered = renderNotificationTemplate(
      settings.telegram_template || DEFAULT_TELEGRAM_TEMPLATE,
      notificationContext(env, title, text, 'telegram', alertCount),
      format,
      'telegram',
    ).slice(0, 3900);
    const threadId = String(settings.telegram_message_thread_id || '').trim();
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: rendered,
        ...(format === 'html' ? { parse_mode: 'HTML' } : {}),
        ...(format === 'markdownv2' ? { parse_mode: 'MarkdownV2' } : {}),
        ...(threadId ? { message_thread_id: Number(threadId) } : {}),
        disable_web_page_preview: settings.telegram_disable_web_preview !== false,
        disable_notification: Boolean(settings.telegram_silent),
      }),
    });
    if (res.ok) return { ok: true };
    const data = await res.text().catch(() => '');
    return { ok: false, error: `Telegram HTTP ${res.status}: ${data.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

async function sendEmail(env, settings, text, title = 'NIE-SLA 报警', alertCount = 1) {
  const apiKey = settings.resend_api_key || await resendApiKey(env);
  const from = emailFrom(env, settings);
  const to = emailTo(env, settings);
  const replyTo = emailReplyTo(env, settings);
  if (!apiKey || !from || !to.length) return { ok: false, error: '缺少 Resend API Key、发件人或收件人' };
  try {
    const context = notificationContext(env, title, text, 'email', alertCount);
    const subject = renderNotificationTemplate(
      settings.email_subject_template || DEFAULT_EMAIL_SUBJECT_TEMPLATE,
      context,
      'plain',
      'subject',
    ).replace(/[\r\n]+/g, ' ').trim().slice(0, 160) || 'NIE-SLA 报警';
    const format = normalizeEmailFormat(settings.email_format);
    const content = renderNotificationTemplate(
      settings.email_template || DEFAULT_EMAIL_TEMPLATE,
      context,
      format,
      'email',
    ).slice(0, 20_000);
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'user-agent': 'NIE-SLA',
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        ...(format === 'html' ? { html: content } : { text: content }),
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (response.ok) return { ok: true };
    const data = await response.text().catch(() => '');
    return { ok: false, error: `Resend HTTP ${response.status}: ${data.slice(0, 200)}` };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function configuredAlertChannels(env, settings) {
  const channels = [];
  if (settings.telegram_enabled && settings.telegram_bot_token && telegramChatId(env, settings)) channels.push('telegram');
  if (settings.email_enabled && settings.resend_api_key && emailFrom(env, settings) && emailTo(env, settings).length) channels.push('email');
  return channels;
}

async function finishAlertRun(env, result) {
  try {
    const now = nowSec();
    const value = JSON.stringify({
      ...result,
      at: now,
      errors: sanitizeAlertErrors(result.errors),
    });
    await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
      WHERE app_meta.updated_at <= ?`)
      .bind('alert_last_result', value, now, now - 300).run();
  } catch (_) {}
  return result;
}

function sanitizeAlertErrors(errors) {
  return (Array.isArray(errors) ? errors : []).slice(0, 10).map((item) => ({
    target_id: item?.target_id || '',
    rule_key: item?.rule_key || '',
    channel: item?.channel || '',
    error: String(item?.error || '')
      .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>')
      .replace(/re_[A-Za-z0-9_-]+/g, 're_<redacted>')
      .slice(0, 300),
  }));
}

async function telegramToken(env) {
  const fromEnv = String(env.TELEGRAM_BOT_TOKEN || env.TG_BOT_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const stored = String(await getMeta(env, TG_TOKEN_KEY) || '').trim();
  if (!stored) return '';
  if (stored.startsWith(SECRET_PREFIX)) {
    try {
      const decrypted = await decryptSecret(stored.slice(SECRET_PREFIX.length), env);
      if (decrypted.needsMigration && primarySecretMaterial(env)) {
        await setMeta(env, TG_TOKEN_KEY, await encryptSecret(decrypted.secret, env));
      }
      return decrypted.secret;
    } catch (_) { return ''; }
  }
  try {
    await setMeta(env, TG_TOKEN_KEY, await encryptSecret(stored, env));
  } catch (_) {}
  return stored;
}

function telegramChatId(env, settings) {
  return String(env.TELEGRAM_CHAT_ID || env.TG_CHAT_ID || settings?.telegram_chat_id || '').trim();
}

async function resendApiKey(env) {
  const fromEnv = String(env.RESEND_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const stored = String(await getMeta(env, RESEND_KEY) || '').trim();
  if (!stored) return '';
  if (stored.startsWith(SECRET_PREFIX)) {
    try {
      const decrypted = await decryptSecret(stored.slice(SECRET_PREFIX.length), env);
      if (decrypted.needsMigration && primarySecretMaterial(env)) {
        await setMeta(env, RESEND_KEY, await encryptSecret(decrypted.secret, env));
      }
      return decrypted.secret;
    } catch (_) { return ''; }
  }
  try { await setMeta(env, RESEND_KEY, await encryptSecret(stored, env)); } catch (_) {}
  return stored;
}

function emailFrom(env, settings) {
  const text = String(env.ALERT_EMAIL_FROM || settings?.email_from || '').trim().replace(/[\r\n]/g, '');
  const display = text.match(/^([^<>]{1,80})\s+<([^<>]+)>$/);
  if (display) {
    const address = normalizeEmailAddress(display[2]);
    return address ? `${display[1].trim()} <${address}>` : '';
  }
  return normalizeEmailAddress(text);
}

function emailTo(env, settings) {
  return String(env.ALERT_EMAIL_TO || settings?.email_to || '')
    .split(',')
    .map(normalizeEmailAddress)
    .filter(Boolean)
    .slice(0, 10);
}

function emailReplyTo(env, settings) {
  return normalizeEmailAddress(env.ALERT_EMAIL_REPLY_TO || settings?.email_reply_to || '');
}

function normalizeEmailAddress(value) {
  const text = String(value || '').trim().replace(/[\r\n]/g, '');
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(text) ? text : '';
}

async function readStoredSettings(env) {
  if (!env.DB) return {};
  try {
    return JSON.parse(await getMeta(env, SETTINGS_KEY) || '{}') || {};
  } catch (_) {
    return {};
  }
}

async function readAlertLastResult(env) {
  try {
    return JSON.parse(await getMeta(env, 'alert_last_result') || 'null') || null;
  } catch (_) {
    return null;
  }
}

function pickSettings(body) {
  const out = {};
  for (const key of [
    ...NUMERIC_FIELDS,
    ...BOOLEAN_FIELDS,
    'telegram_chat_id',
    'telegram_format',
    'telegram_template',
    'telegram_message_thread_id',
    'email_from',
    'email_to',
    'email_reply_to',
    'email_format',
    'email_subject_template',
    'email_template',
  ]) {
    if (Object.prototype.hasOwnProperty.call(body || {}, key)) out[key] = body[key];
  }
  return out;
}

function normalizeAlertSettings(input = {}) {
  const out = { ...DEFAULT_SETTINGS };
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    if (!Object.prototype.hasOwnProperty.call(input || {}, key)) continue;
    if (BOOLEAN_FIELDS.has(key)) out[key] = parseBoolean(input[key], fallback);
    else if (NUMERIC_FIELDS.has(key)) out[key] = normalizeNumber(key, input[key], fallback);
    else out[key] = normalizeStringSetting(key, input[key], fallback);
  }
  return out;
}

function normalizeStringSetting(key, value, fallback) {
  const text = String(value ?? '').replace(/\r/g, '');
  if (key === 'telegram_format') return normalizeTelegramFormat(text);
  if (key === 'email_format') return normalizeEmailFormat(text);
  if (key === 'telegram_message_thread_id') return /^-?\d{1,20}$/.test(text.trim()) ? text.trim() : '';
  if (key === 'telegram_template') return normalizeBodyTemplate(text, fallback, 1500);
  if (key === 'email_subject_template') return (text.trim() || fallback).slice(0, 300);
  if (key === 'email_template') return normalizeBodyTemplate(text, fallback, 12_000);
  return text.trim().slice(0, key === 'email_to' ? 1000 : 320);
}

function validateNotificationTemplates(body) {
  validateTemplateField(body, 'telegram_template', 1500, true);
  validateTemplateField(body, 'email_subject_template', 300, false);
  validateTemplateField(body, 'email_template', 12_000, true);
}

function validateTemplateField(body, key, maxLength, requireMessage) {
  if (!Object.prototype.hasOwnProperty.call(body || {}, key)) return;
  const template = String(body[key] ?? '').replace(/\r/g, '').trim();
  if (!template) return;
  if (template.length > maxLength) throw new ApiError(400, `${templateLabel(key)}过长`);
  const placeholders = [...template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) => match[1]);
  const unknown = placeholders.find((name) => !TEMPLATE_KEYS.includes(name));
  if (unknown) throw new ApiError(400, `未知模板占位符：{{${unknown}}}`);
  for (const name of TEMPLATE_KEYS) {
    if (placeholders.filter((item) => item === name).length > 1) {
      throw new ApiError(400, `占位符 {{${name}}} 只能出现一次`);
    }
  }
  if (requireMessage && !placeholders.includes('message')) {
    throw new ApiError(400, `${templateLabel(key)}必须包含 {{message}}`);
  }
}

function normalizeBodyTemplate(value, fallback, maxLength) {
  const template = String(value || '').trim();
  if (!template) return fallback;
  try {
    validateTemplateField({ template }, 'template', maxLength, true);
    return template;
  } catch (_) {
    return fallback;
  }
}

function templateLabel(key) {
  return key === 'telegram_template' ? 'Telegram 模板' : key === 'email_subject_template' ? '邮件主题模板' : '邮件正文模板';
}

function normalizeTelegramFormat(value) {
  const format = String(value || '').trim().toLowerCase();
  return ['plain', 'html', 'markdownv2'].includes(format) ? format : 'plain';
}

function normalizeEmailFormat(value) {
  return String(value || '').trim().toLowerCase() === 'html' ? 'html' : 'text';
}

function notificationContext(env, title, message, channel, alertCount) {
  return {
    title: String(title || 'NIE-SLA 报警'),
    message: String(message || ''),
    site_name: String(env.PUBLIC_SITE_NAME || 'NIE-SLA'),
    time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    alert_count: String(Math.max(0, Number(alertCount || 0))),
    channel: String(channel || ''),
  };
}

export function renderNotificationTemplate(template, context, format = 'plain', target = 'telegram') {
  const normalizedFormat = target === 'email' ? normalizeEmailFormat(format) : normalizeTelegramFormat(format);
  return String(template || '').replace(/\{\{(title|message|site_name|time|alert_count|channel)\}\}/g, (_, key) => {
    const value = String(context?.[key] ?? '');
    if (normalizedFormat === 'html') {
      const escaped = escapeMarkup(value);
      return target === 'email' && key === 'message' ? escaped.replace(/\n/g, '<br>\n') : escaped;
    }
    if (normalizedFormat === 'markdownv2') return escapeMarkdownV2(value);
    return value;
  });
}

function escapeMarkup(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function escapeMarkdownV2(value) {
  return String(value || '').replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function normalizeNumber(key, value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  const max = {
    offline_minutes: 1440,
    repeat_minutes: 10080,
    cpu_percent: 100,
    memory_percent: 100,
    disk_percent: 100,
    load1: 1000,
    disk_read_mb_s: 100000,
    disk_write_mb_s: 100000,
    net_rx_mb_s: 100000,
    net_tx_mb_s: 100000,
    process_count: 1000000,
    thread_count: 1000000,
    expiry_days: 3650,
    traffic_remaining_percent: 100,
    traffic_remaining_gb: 1048576,
  }[key] ?? 1000000;
  const rounded = key.endsWith('_percent') || key.endsWith('_gb') || key.endsWith('_mb_s') || key === 'load1'
    ? Math.round(Math.min(n, max) * 100) / 100
    : Math.floor(Math.min(n, max));
  return rounded;
}

function targetAlertSettings(target, globalSettings) {
  return {
    ...globalSettings,
    enabled: target.alert_enabled == null ? true : parseBoolean(target.alert_enabled, true),
    expiry_days: overrideNumber(target.alert_expiry_days, globalSettings.expiry_days),
    traffic_remaining_percent: overrideNumber(target.alert_traffic_remaining_percent, globalSettings.traffic_remaining_percent),
    traffic_remaining_gb: overrideNumber(target.alert_traffic_remaining_gb, globalSettings.traffic_remaining_gb),
  };
}

function overrideNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function metricValues(row) {
  const memory = parseJsonSafe(row?.memory);
  const load = parseJsonSafe(row?.load);
  const disk = parseJsonSafe(row?.disk);
  const net = parseJsonSafe(row?.net);
  const diskio = parseJsonSafe(row?.diskio);
  return {
    cpuPercent: Number(row?.cpu_percent || 0),
    memoryPercent: Number(memory.percent || 0),
    diskPercent: Number(disk.percent || 0),
    load1: Number(load.load1 || 0),
    netRxBytesSec: Number(net.rx_bytes_sec || 0),
    netTxBytesSec: Number(net.tx_bytes_sec || 0),
    diskReadBytesSec: Number(diskio.read_bytes_sec || 0),
    diskWriteBytesSec: Number(diskio.write_bytes_sec || 0),
    processCount: Number(row?.process_count || 0),
    threadCount: Number(row?.thread_count || row?.process_count || 0),
  };
}

function parseJsonSafe(value) {
  if (!value) return {};
  if (typeof value === 'object') return Array.isArray(value) ? {} : value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) { return {}; }
}

function metricUpdatedAtSec(row) {
  if (!row?.updated_at) return 0;
  const ts = Math.floor(new Date(row.updated_at).getTime() / 1000);
  return Number.isFinite(ts) ? ts : 0;
}

function offlineThresholdSec(settings) {
  return clamp(Number(settings.offline_minutes || 10), 1, 1440) * 60;
}

function probeStaleThresholdSec(settings, target) {
  const intervalSec = clamp(Number(target?.interval_sec || 300), 60, 86400);
  return Math.max(offlineThresholdSec(settings), intervalSec * 3);
}

function isProbeStale(settings, target, latest, now) {
  const latestAt = Math.max(Number(latest?.checked_at || 0), Number(target?.last_checked_at || 0));
  return Boolean(latestAt && now - latestAt >= probeStaleThresholdSec(settings, target));
}

function isAgentOnlyProbe(target, latest) {
  const error = String(latest?.error || '').toLowerCase();
  return error.includes('private host') || (target?.type === 'tcp' && isPrivateHost(target?.target_host));
}

function targetLabel(target) {
  const name = String(target?.name || target?.id || '').trim();
  const id = String(target?.id || '').trim();
  return name && id && name !== id ? `${name} (${id})` : (name || id || 'unknown');
}

function formatDateTime(ts) {
  if (!ts) return '-';
  return new Date(Number(ts) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function formatDateOnly(ts) {
  if (!ts) return '-';
  return new Date(Number(ts) * 1000).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds || 0)));
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分钟`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时${Math.floor((s % 3600) / 60)}分钟`;
  return `${Math.floor(s / 86400)}天${Math.floor((s % 86400) / 3600)}小时`;
}

function formatBytesPerSec(value) {
  return `${formatBytes(value)}/s`;
}

function formatBytes(value) {
  const n = Math.max(0, Number(value || 0));
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = n;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx++;
  }
  const digits = size >= 100 || idx === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[idx]}`;
}

async function ensureAlertStateTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS alert_state (
    target_id TEXT NOT NULL,
    rule_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    last_value REAL,
    opened_at INTEGER,
    resolved_at INTEGER,
    last_sent_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (target_id, rule_key)
  )`).run();
}

async function getMeta(env, key) {
  if (!env.DB) return null;
  const row = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?`).bind(key).first().catch(() => null);
  return row?.value ?? null;
}

async function setMeta(env, key, value) {
  await env.DB.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(key, String(value), nowSec()).run();
}

export async function migrateAlertEncryption(env) {
  if (!primarySecretMaterial(env)) throw new Error('缺少 ALERT_ENCRYPTION_KEY 或 TOTP_ENCRYPTION_KEY');
  let total = 0;
  let migrated = 0;
  for (const key of [TG_TOKEN_KEY, RESEND_KEY]) {
    const stored = String(await getMeta(env, key) || '').trim();
    if (!stored) continue;
    total += 1;
    if (!stored.startsWith(SECRET_PREFIX)) {
      await setMeta(env, key, await encryptSecret(stored, env));
      migrated += 1;
      continue;
    }
    const decrypted = await decryptSecret(stored.slice(SECRET_PREFIX.length), env);
    if (!decrypted.needsMigration) continue;
    await setMeta(env, key, await encryptSecret(decrypted.secret, env));
    migrated += 1;
  }
  return { total, migrated };
}

async function encryptSecret(secret, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await secretKey(env, ['encrypt']),
    new TextEncoder().encode(secret),
  ));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv, 0);
  combined.set(encrypted, iv.length);
  return SECRET_PREFIX + bytesToBase64(combined);
}

async function decryptSecret(payload, env) {
  const combined = base64ToBytes(payload);
  if (combined.length <= 12) throw new Error('加密的告警密钥无效');
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);
  let lastError = null;
  for (const candidate of secretKeyMaterials(env)) {
    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        await importSecretKey(candidate.material, ['decrypt']),
        encrypted,
      );
      return {
        secret: new TextDecoder().decode(decrypted),
        needsMigration: candidate.source !== 'primary',
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('没有可用的告警密钥加密材料');
}

async function secretKey(env, usages) {
  const material = primarySecretMaterial(env);
  if (!material) throw new Error('将告警密钥保存到 D1 需要配置长期 ALERT_ENCRYPTION_KEY 或 TOTP_ENCRYPTION_KEY');
  return importSecretKey(material, usages);
}

function primarySecretMaterial(env) {
  return String(env.ALERT_ENCRYPTION_KEY || env.TOTP_ENCRYPTION_KEY || '').trim();
}

function secretKeyMaterials(env) {
  const candidates = [
    { material: primarySecretMaterial(env), source: 'primary' },
    { material: String(env.PREVIOUS_ENCRYPTION_KEY || '').trim(), source: 'previous' },
    { material: String(env.ALERT_ENCRYPTION_KEY || '').trim(), source: 'legacy_alert' },
    { material: String(env.TOTP_ENCRYPTION_KEY || '').trim(), source: 'legacy_totp' },
    { material: String(env.ADMIN_PASSWORD || '').trim(), source: 'legacy_admin_password' },
    { material: String(env.ADMIN_TOKEN || '').trim(), source: 'legacy_admin_token' },
  ];
  return candidates.filter((candidate, index) => candidate.material
    && candidates.findIndex((entry) => entry.material === candidate.material) === index);
}

async function importSecretKey(material, usages) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, usages);
}
