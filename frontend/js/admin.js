import { copyText } from "./install-command.js";
import { createAdminClient } from "./admin/api.js";
import { canShowTemperature } from "./shared/hardware.js";
import {
  CURRENCIES,
  COUNTRIES,
  countryFlagAsset,
  filterCountries,
  filterProviders,
  normalizeCountryCode,
} from "./shared/target-catalogs.js";
import {
  groupByDimension,
  groupByMenuHtml,
  lineTypeOptionsHtml,
  displayGroupName as sharedDisplayGroupName,
} from "./shared/grouping.js?v=20260721-control-harmony";

const CONFIG = window.NSTATUS_CONFIG || {};
const API = String(
  CONFIG.apiBase ||
    window.NSTATUS_API_BASE ||
    "",
).replace(/\/+$/, "");
function byId(id) {
  return document.getElementById(id);
}

const escapeHtml = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
const adminClient = createAdminClient({
  apiBase: API,
  onUnauthorized: (message) => showLogin(message),
});
const {
  api,
  apiAdmin,
  apiPublic,
  apiTimeout,
  clearAuth,
  clearPersistedToken,
  hasSession,
  persistToken,
  saveSession,
  setToken,
} = adminClient;
let targets = [],
  adminGroupBy = localStorage.getItem("nstatus.adminGroupBy") || "group",
  statusMap = new Map(),
  latencyNodes = [],
  pingTargets = [],
  targetRegions = {
    auto: "自动（当前 Worker 执行位置）",
    apac: "亚太",
    weur: "西欧",
    eeur: "东欧",
    enam: "北美东部",
    wnam: "北美西部",
    sam: "南美",
    oc: "大洋洲",
    afr: "非洲",
    me: "中东",
  },
  targetAdminLoaded = false,
  pingAdminLoaded = false,
  targetAdminFailed = false,
  pingAdminFailed = false,
  targetOrderSaving = false;
let toastTimer = 0;
function toast(m, t = "info") {
  const e = byId("toast");
  clearTimeout(toastTimer);
  e.textContent = m;
  e.className = "toast " + t + " show";
  toastTimer = setTimeout(() => e.classList.remove("show"), t === "err" ? 6000 : 3200);
}
function showLogin(message = "", { requireTotp = false } = {}) {
  byId("loginPage").style.display = "flex";
  byId("app").style.display = "none";
  byId("totpRow").style.display = requireTotp ? "block" : "none";
  byId("loginBtn").textContent = requireTotp ? "验证并登录" : "登录";
  byId("loginMsg").style.display = requireTotp ? "block" : "none";
  byId("loginMsg").textContent = requireTotp ? "需要 TOTP 验证码" : "";
  if (adminClient.getToken() && !byId("loginToken").value)
    byId("loginToken").value = adminClient.getToken();
  if (message) {
    byId("loginErr").textContent = message;
    byId("loginErr").style.display = "block";
  } else {
    byId("loginErr").style.display = "none";
  }
}

function showTotpPrompt(message = "需要 TOTP 验证码") {
  showLogin("", { requireTotp: true });
  byId("loginMsg").textContent = message;
  byId("loginTotp").focus();
}

function showApp() {
  byId("loginPage").style.display = "none";
  byId("app").style.display = "block";
  nav("dash");
}
function loading(id, t = "加载中...") {
  byId(id).innerHTML = '<div class="loading">' + escapeHtml(t) + "</div>";
}
function errBox(id, e) {
  byId(id).innerHTML =
    '<div class="error">加载失败：' +
    escapeHtml(e?.message || e || "未知错误") +
    "</div>";
}
function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function isStatusStale(x) {
  const c = Number(x?.checked_at || 0);
  return c && c < nowSec() - Math.max(300, Number(x?.interval_sec || 300)) * 3;
}
function formatDateTime(s) {
  return s
    ? new Date(Number(s) * 1000).toLocaleString("zh-CN", { hour12: false })
    : "-";
}
function formatDuration(s) {
  s = Math.max(0, Number(s || 0));
  if (s < 60) return s + "秒";
  if (s < 3600) return Math.floor(s / 60) + "分";
  if (s < 86400)
    return Math.floor(s / 3600) + "小时" + Math.floor((s % 3600) / 60) + "分";
  return Math.floor(s / 86400) + "天" + Math.floor((s % 86400) / 3600) + "小时";
}
async function login() {
  if (
    byId("totpRow").style.display !== "none" &&
    byId("loginTotp").value.trim()
  ) {
    await verifyLoginTotp();
    return;
  }

  const adminToken = byId("loginToken").value.trim();
  if (!adminToken) return;
  setToken(adminToken);
  saveSession("", "");
  byId("loginBtn").disabled = true;
  byId("loginErr").style.display = "none";
  byId("loginMsg").style.display = "block";
  byId("loginMsg").textContent = "验证 Token...";
  try {
    const d = await apiTimeout("/api/login", { method: "GET", forceToken: true });
    if (d.session_valid) {
      if (d.session_id && d.session_expires_at)
        saveSession(d.session_id, d.session_expires_at);
      // Session-only mode after TOTP: drop master token from storage/header path.
      if (d.auth_mode === "session" || d.totp_required) clearPersistedToken();
      else persistToken();
      showApp();
      return;
    }
    if (d.totp_required) {
      persistToken(); // keep token briefly for TOTP verify only
      showTotpPrompt();
      return;
    }
    persistToken();
    showApp();
  } catch (e) {
    clearAuth();
    byId("loginErr").textContent = e.message;
    byId("loginErr").style.display = "block";
  } finally {
    byId("loginBtn").disabled = false;
  }
}
async function verifyLoginTotp() {
  if (!adminClient.getToken()) setToken(byId("loginToken").value);
  if (!adminClient.getToken()) {
    showLogin("请先输入 ADMIN_TOKEN");
    return;
  }

  const code = byId("loginTotp").value.trim();
  if (!/^\d{6}$/.test(code)) {
    toast("请输入 6 位验证码", "err");
    return;
  }

  byId("loginBtn").disabled = true;
  byId("loginMsg").style.display = "block";
  byId("loginMsg").textContent = "验证 TOTP...";
  try {
    const d = await apiTimeout("/api/totp/verify", {
      method: "POST",
      body: JSON.stringify({ code }),
      forceToken: true,
    });
    if (d.session_id && d.expires_at) saveSession(d.session_id, d.expires_at);
    clearPersistedToken();
    toast("验证通过", "ok");
    showApp();
  } catch (e) {
    byId("loginErr").textContent = e.message;
    byId("loginErr").style.display = "block";
    toast(e.message, "err");
  } finally {
    byId("loginBtn").disabled = false;
    byId("loginMsg").textContent = "需要 TOTP 验证码";
  }
}
function nav(p) {
  document
    .querySelectorAll(".page")
    .forEach((x) => x.classList.toggle("on", x.id === "pg-" + p));
  document
    .querySelectorAll(".nav a")
    .forEach((x) => x.classList.toggle("on", x.dataset.p === p));
  if (p === "dash") loadDash();
  if (p === "targets") loadTargets();
  if (p === "latency") loadLatencyNodes();
  if (p === "pings") loadPings();
  if (p === "themes") loadThemes();
  if (p === "plugins") loadPlugins();
  if (p === "settings") loadSettings();
}

async function loadManagedExtensions(resource) {
  const apiBase = resource === "themes" ? "/api/themes" : "/api/plugins";
  const tableId = resource === "themes" ? "themeTable" : "pluginTable";
  const emptyName = resource === "themes" ? "主题" : "插件";
  loading(tableId);
  try {
    const data = await api(`${apiBase}/manage`);
    const rows = data.extensions || [];
    if (!rows.length) {
      byId(tableId).innerHTML = `<div class="empty">尚未安装${emptyName}。</div>`;
      return;
    }
    byId(tableId).innerHTML = `<div class="extension-grid">${rows.map((extension) => extensionCardHtml(extension, resource)).join("")}</div>`;
  } catch (error) {
    errBox(tableId, error);
  }
}

function loadThemes() { return loadManagedExtensions("themes"); }
function loadPlugins() { return loadManagedExtensions("plugins"); }

function extensionCardHtml(extension, resource) {
  const type = extension.type === "theme" ? "主题" : "插件";
  const state = extension.enabled ? "已启用" : "未启用";
  return `<article class="extension-card${extension.enabled ? " active" : ""}">
    <div class="extension-card-head">
      <div><span>${escapeHtml(type)}</span><h3>${escapeHtml(extension.name)}</h3></div>
      <em>${escapeHtml(state)}</em>
    </div>
    <p>${escapeHtml(extension.description || "暂无说明")}</p>
    <dl>
      <div><dt>ID</dt><dd><code>${escapeHtml(extension.id)}</code></dd></div>
      <div><dt>版本</dt><dd>${escapeHtml(extension.version)}</dd></div>
      <div><dt>作者</dt><dd>${escapeHtml(extension.author || "未署名")}</dd></div>
    </dl>
    <div class="extension-card-actions">
      <button class="btn btn-sm ${extension.enabled ? "" : "btn-primary"}" data-extension-action="toggle" data-extension-resource="${resource}" data-extension-id="${escapeHtml(extension.id)}" data-extension-enabled="${extension.enabled ? "1" : "0"}">${extension.enabled ? "停用" : "启用"}</button>
      <button class="btn btn-sm btn-danger" data-extension-action="delete" data-extension-resource="${resource}" data-extension-id="${escapeHtml(extension.id)}">删除</button>
    </div>
  </article>`;
}

async function uploadExtensionPackage(resource, file) {
  if (!file) return;
  const isTheme = resource === "themes";
  const apiBase = isTheme ? "/api/themes" : "/api/plugins";
  const displayName = isTheme ? "主题" : "插件";
  const inputId = isTheme ? "themeZip" : "pluginZip";
  const button = byId(isTheme ? "uploadThemeBtn" : "uploadPluginBtn");
  if (!file.name.toLowerCase().endsWith(".zip")) return toast(`请选择 ZIP ${displayName}包`, "err");
  if (file.size > 2 * 1024 * 1024) return toast(`${displayName} ZIP 不能超过 2 MB`, "err");
  button.disabled = true;
  button.textContent = "正在校验并上传...";
  try {
    const result = await api(`${apiBase}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", "x-extension-filename": file.name },
      body: file,
    });
    toast(`已安装 ${result.extension.name}，请确认后启用`, "ok");
    await loadManagedExtensions(resource);
  } catch (error) {
    toast(error.message, "err");
  } finally {
    button.disabled = false;
    button.textContent = `上传${displayName} ZIP`;
    byId(inputId).value = "";
  }
}

async function toggleExtension(resource, id, enabled) {
  const apiBase = resource === "themes" ? "/api/themes" : "/api/plugins";
  try {
    await api(`${apiBase}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !enabled }) });
    toast(enabled ? "已停用" : "已启用", "ok");
    await loadManagedExtensions(resource);
  } catch (error) { toast(error.message, "err"); }
}

async function removeExtension(resource, id) {
  const apiBase = resource === "themes" ? "/api/themes" : "/api/plugins";
  if (!confirm(`确认删除 ${id}？其 R2 文件也会被删除。`)) return;
  try {
    await api(`${apiBase}/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("已删除", "ok");
    await loadManagedExtensions(resource);
  } catch (error) { toast(error.message, "err"); }
}
async function loadDash() {
  loading("dStats");
  loading("dMetrics");
  try {
    const d = await api("/api/status?days=30");
    renderStats(d);
    renderIncidents(d.incidents || []);
    renderMetrics();
  } catch (e) {
    errBox("dStats", e);
    errBox("dMetrics", e);
  }
}
function renderStats(d) {
  const targets = d.targets || [];
  const checkedTargets = targets.filter((target) => target.checked_at);
  const onlineCount = checkedTargets.filter(
    (target) => Number(target.ok) === 1 && !isStatusStale(target),
  ).length;
  const downCount = checkedTargets.filter(
    (target) => Number(target.ok) === 0,
  ).length;
  const pendingCount = targets.length - checkedTargets.length;
  const latencies = checkedTargets
    .filter((target) => Number(target.ok) === 1 && target.latency_ms != null)
    .map((target) => Number(target.latency_ms));
  const averageLatency = latencies.length
    ? Math.round(
        latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
      )
    : null;

  byId("dStats").innerHTML = [
    statCard(
      downCount || "✓",
      downCount ? "故障" : "正常",
      downCount ? "down" : "ok",
    ),
    statCard(onlineCount, "在线", "ok"),
    pendingCount ? statCard(pendingCount, "待定") : "",
    statCard(targets.length, "总数"),
    statCard(averageLatency == null ? "-" : `${averageLatency}ms`, "平均延迟"),
  ].join("");
}

function statCard(value, label, className = "") {
  const extraClass = className ? ` ${className}` : "";
  return `
    <div class="stat${extraClass}">
      <div class="v">${escapeHtml(value)}</div>
      <div class="l">${escapeHtml(label)}</div>
    </div>`;
}

function renderIncidents(list) {
  if (!list.length) {
    byId("dIncidents").innerHTML = '<div class="empty">暂无事件</div>';
    return;
  }

  const rows = list.slice(0, 20).map(incidentRowHtml).join("");
  byId("dIncidents").innerHTML = `
    <div class="table-scroll">
      <table class="incident-table">
        <thead>
          <tr>
            <th>目标</th>
            <th>开始</th>
            <th>恢复</th>
            <th>持续</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function incidentRowHtml(incident) {
  const startedAt = Number(incident.started_at || nowSec());
  const recoveredAt = Number(incident.recovered_at || 0);
  const duration = recoveredAt ? recoveredAt - startedAt : nowSec() - startedAt;
  const state = recoveredAt
    ? statusTag("已恢复", "tag-on")
    : statusTag("故障中", "tag-off");
  return `
    <tr>
      <td>${escapeHtml(incident.name || incident.target_id)}</td>
      <td>${formatDateTime(startedAt)}</td>
      <td>${formatDateTime(recoveredAt)}</td>
      <td>${formatDuration(duration)}</td>
      <td>${state}</td>
    </tr>`;
}
async function renderMetrics() {
  try {
    const d = await api("/api/agent/metrics"),
      m = d.latest;
    if (!m) {
      byId("dMetrics").innerHTML = '<div class="empty">暂无 Agent</div>';
      return;
    }
    const cpu = Number(m.cpu_percent || 0),
      mem = Number(m.memory?.percent || 0),
      disk = Number(m.disk?.percent || 0);
    byId("dMetrics").innerHTML =
      metricCard("CPU", cpu.toFixed(1) + "%", cpu) +
      metricCard("内存", mem.toFixed(1) + "%", mem) +
      metricCard("磁盘", disk.toFixed(1) + "%", disk) +
      simple("负载", Number(m.load?.load1 || 0).toFixed(2)) +
      simple("下载", formatBytesPerSecond(Number(m.net?.rx_bytes_sec || 0))) +
      simple("上传", formatBytesPerSecond(Number(m.net?.tx_bytes_sec || 0))) +
      simple("线程", Number(m.thread_count || m.process_count || 0).toFixed(0));
    const v = m.vps_info || {},
      rows = [];
    if (m.uptime_sec) rows.push(["在线时长", formatDuration(m.uptime_sec)]);
    if (v.cpu_model)
      rows.push(["CPU", v.cpu_model + (v.cpu_cores ? " ×" + v.cpu_cores : "")]);
    if (v.os) rows.push(["系统", v.os]);
    if (v.kernel) rows.push(["内核", v.kernel]);
    if (v.virtualization) rows.push(["虚拟化", v.virtualization]);
    if (v.gpu_name) rows.push(["GPU", v.gpu_name + (v.gpu_count > 1 ? ` x${v.gpu_count}` : "")]);
    if (canShowTemperature(v) && v.cpu_temp_c != null) rows.push(["CPU 温度", Number(v.cpu_temp_c).toFixed(1) + "°C"]);
    if (canShowTemperature(v) && v.gpu_temp_c != null) rows.push(["GPU 温度", Number(v.gpu_temp_c).toFixed(1) + "°C"]);
    if (v.gpu_util != null) rows.push(["GPU 占用", Number(v.gpu_util).toFixed(1) + "%"]);
    if (m.agent_version) rows.push(["版本", m.agent_version]);
    if (m.updated_at)
      rows.push([
        "更新",
        new Date(m.updated_at).toLocaleString("zh-CN", { hour12: false }),
      ]);
    if (rows.length) {
      byId("dVps").innerHTML = rows
        .map(
          (r) =>
            `<div class="vi"><div class="vl">${escapeHtml(r[0])}</div><div class="vv">${escapeHtml(r[1])}</div></div>`,
        )
        .join("");
      byId("dVps").style.display = "grid";
      byId("dVpsN").style.display = "none";
    }
  } catch {
    byId("dMetrics").innerHTML = '<div class="empty">暂无 Agent</div>';
  }
}
function metricCard(l, t, v) {
  const c = v > 90 ? "down" : v > 70 ? "warn" : "ok";
  return `<div class="mi"><div class="ml">${l}</div><div class="mv">${t}</div><div class="mb"><div class="mf ${c}" style="width:${Math.max(0, Math.min(100, v))}%"></div></div></div>`;
}
function simple(l, t) {
  return `<div class="mi"><div class="ml">${l}</div><div class="mv">${t}</div></div>`;
}
function formatBytesPerSecond(b) {
  return b >= 1e6
    ? (b / 1e6).toFixed(1) + " MB/s"
    : b >= 1e3
      ? (b / 1e3).toFixed(1) + " KB/s"
      : b.toFixed(0) + " B/s";
}
function formatBytes(b) {
  b = Number(b || 0);
  return b >= 1099511627776
    ? (b / 1099511627776).toFixed(2) + " TB"
    : b >= 1073741824
      ? (b / 1073741824).toFixed(1) + " GB"
      : b >= 1048576
        ? (b / 1048576).toFixed(1) + " MB"
        : b >= 1024
          ? (b / 1024).toFixed(1) + " KB"
          : b.toFixed(0) + " B";
}
function dateInput(sec) {
  const n = Number(sec || 0);
  if (!n) return "";
  const d = new Date(n * 1000);
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function trafficCell(t, s = {}) {
  if (t.type === "http") return '<span class="hint">不适用</span>';
  const tr = s.agent_metrics?.traffic || t.traffic || {};
  if (!tr.enabled) return '<span class="tag tag-off">未启用</span>';
  const quota = Number(tr.quota_bytes || 0),
    total = Number(tr.total_bytes || 0),
    reset = tr.reset_day ? ` · ${tr.reset_day}日重置` : "";
  return `<span class="tag tag-on">已启用</span><br><small class="hint">${formatBytes(total)}${quota ? " / " + formatBytes(quota) : ""}${tr.percent != null ? " · " + tr.percent + "%" : ""}${reset}</small>`;
}
async function loadTargets() {
  loading(
    "tTable",
    "\u52a0\u8f7d\u63a2\u9488\u4e2d\uff0c\u5148\u663e\u793a\u6700\u65b0\u72b6\u6001...",
  );
  targets = [];
  statusMap = new Map();
  targetAdminLoaded = false;
  targetAdminFailed = false;
  let shown = false;
  try {
    const sd = await apiPublic("/api/status?days=1&lite=1", 15000);
    targets = sd.targets || [];
    (sd.targets || []).forEach((t) => statusMap.set(t.id, t));
    renderTargets();
    shown = targets.length > 0;
  } catch (e) {}
  try {
    const d = await apiAdmin("/api/targets", {}, 30000);
    targets = d.targets || targets;
    if (d.regions && typeof d.regions === "object") {
      targetRegions = Object.fromEntries(
        Object.keys(d.regions).map((code) => [code, targetRegions[code] || d.regions[code]]),
      );
    }
    targetAdminLoaded = true;
    renderTargets();
  } catch (e) {
    targetAdminFailed = true;
    if (!shown) {
      errBox("tTable", e);
    } else {
      renderTargets();
      toast(
        "\u7ba1\u7406\u64cd\u4f5c\u52a0\u8f7d\u8f83\u6162\uff0c\u5df2\u5148\u663e\u793a\u63a2\u9488\u72b6\u6001",
        "info",
      );
    }
  }
}

function selectedAttr(condition) {
  return condition ? " selected" : "";
}

function checkedAttr(condition) {
  return condition ? " checked" : "";
}

function statusTag(text, className) {
  return `<span class="tag ${className}">${escapeHtml(text)}</span>`;
}

function targetStatus(status, target) {
  const agentStatus = status.status_source === "agent";
  const checked = agentStatus ? Boolean(status.last_metrics_at) : Boolean(status.checked_at);
  const up = checked && (agentStatus ? status.agent_online === true : Number(status.ok) === 1);
  const delayed =
    up && isStatusStale({ ...status, interval_sec: target.interval_sec });
  if (!checked) return { text: "待检查", className: "tag-warn" };
  if (up && !delayed) return { text: target.type === "http" ? "正常" : "在线", className: "tag-on" };
  if (delayed) return { text: "延迟", className: "tag-warn" };
  return { text: target.type === "http" ? "故障" : "离线", className: "tag-off" };
}

function targetHostText(target) {
  if (target.type === "http") return target.url || "";
  return [target.target_host, target.target_port].filter(Boolean).join(":");
}

function isAgentOnline(status) {
  if (status.status_source === "agent" && typeof status.agent_online === "boolean")
    return status.agent_online;
  if (!status.last_metrics_at) return false;
  const lastMetricsAt = Math.floor(
    new Date(status.last_metrics_at).getTime() / 1000,
  );
  return nowSec() - lastMetricsAt < Number(status.agent_offline_after_sec || 900);
}

function targetActionsHtml(target) {
  if (!targetAdminLoaded) {
    return targetAdminFailed
      ? '<button class="btn btn-xs btn-blue" data-a="reload">重试管理</button>'
      : '<span class="tag tag-warn">管理加载中</span>';
  }

  return [
    `<button class="btn btn-xs" data-a="toggle">${target.enabled ? "禁用" : "启用"}</button>`,
    '<button class="btn btn-xs btn-blue" data-a="edit">编辑</button>',
    '<button class="btn btn-xs btn-danger" data-a="delete">删除</button>',
  ].join("");
}

function nodeQualityEditorValue(target = {}) {
  const raw = target.nq_report;
  if (!raw) return '';
  try {
    const report = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return String(report?.raw || '').trim();
  } catch (_) {
    return String(raw || '').trim();
  }
}

function targetRowHtml(target, index) {
  const status = statusMap.get(target.id) || {};
  const state = targetStatus(status, target);
  const host = targetHostText(target);
  const noPublicIp = Number(target.no_public_ip || status.no_public_ip || 0) === 1;
  const typeTag =
    target.type === "http"
      ? statusTag("HTTP", "tag-http")
      : statusTag("TCP", "tag-tcp");
  const isWeb = target.type === "http";
  const notApplicable = '<span class="hint">不适用</span>';
  const agentTag = isWeb
    ? notApplicable
    : isAgentOnline(status)
      ? statusTag("在线", "tag-on")
      : statusTag("离线", "tag-off");
  const enabledTag = target.enabled
    ? statusTag("已启用", "tag-on")
    : statusTag("已禁用", "tag-off");

  const probeUptime = status.status_source === "agent"
    ? (status.agent_online === true ? "Agent 在线" : "Agent 离线")
    : status.uptime_24h == null
      ? "暂无 24h 数据"
      : `24h ${Number(status.uptime_24h).toFixed(2)}%`;
  const agentDetails = isWeb
    ? notApplicable
    : `<div class="status-stack"><div>${agentTag}<code>${escapeHtml(status.agent_version || "-")}</code></div><small>${status.machine_uptime_sec ? `运行 ${escapeHtml(formatDuration(status.machine_uptime_sec))}` : "暂无运行时长"}</small></div>`;
  const cfDetails = noPublicIp
    ? ""
    : `<div class="monitoring-item"><span class="monitoring-label">CF</span><div class="status-stack"><div>${statusTag(state.text, state.className)}<strong>${status.latency_ms == null ? "-" : `${Number(status.latency_ms)}ms`}</strong></div><small>${escapeHtml(probeUptime)}</small></div></div>`;
  const monitorDetails = `<div class="monitoring-stack">${cfDetails}<div class="monitoring-item"><span class="monitoring-label">Agent</span>${agentDetails}</div></div>`;
  const cells = [
    `<div class="sort-cell"><button type="button" class="drag-handle" data-sort-handle title="拖动排序" aria-label="拖动 ${escapeHtml(target.name)} 排序">⠿</button><span class="sort-index">${index + 1}</span><span class="mobile-order"><button type="button" data-a="move-up" title="上移" aria-label="上移">↑</button><button type="button" data-a="move-down" title="下移" aria-label="下移">↓</button></span></div>`,
    `<div class="target-summary"><div><b>${escapeHtml(target.name)}</b>${typeTag}${enabledTag}</div><code>${escapeHtml(target.id)}</code><span title="${escapeHtml(host)}">${escapeHtml(host || "-")}</span><span class="group-cell" title="${escapeHtml(targetGroupCell(target))}">${escapeHtml(targetGroupCell(target))}</span></div>`,
    monitorDetails,
    trafficCell(target, status),
    `<div class="actions">${isWeb ? "" : `<button type="button" class="btn btn-xs btn-deploy" data-a="deploy" data-target-id="${escapeHtml(target.id)}">部署 Agent</button>`}${targetActionsHtml(target)}</div>`,
  ];

  return `
    <tr data-i="${index}" data-id="${escapeHtml(target.id)}" draggable="${targetAdminLoaded ? "true" : "false"}">
      <td>${cells[0]}</td>
      <td class="name-cell">${cells[1]}</td>
      <td>${cells[2]}</td>
      <td>${cells[3]}</td>
      <td>${cells[4]}</td>
    </tr>`;
}

function renderTargets() {
  if (!targets.length) {
    byId("tTable").innerHTML = '<div class="empty">暂无探针</div>';
    return;
  }

  let rowIndex = 0;
  let rows = "";
  if (adminGroupBy !== "group") {
    const grouped = groupByDimension(targets, adminGroupBy);
    rows = Object.entries(grouped)
      .sort((a, b) => a[0].localeCompare(b[0], "zh-CN"))
      .map(([name, list]) => {
        const head = `<tr class="group-sep"><td colspan="5"><strong>${escapeHtml(name)}</strong> · ${list.length}</td></tr>`;
        const body = list.map((target) => targetRowHtml(target, rowIndex++)).join("");
        return head + body;
      })
      .join("");
  } else {
    rows = targets.map((target, index) => targetRowHtml(target, index)).join("");
  }
  byId("tTable").innerHTML = `
    <div class="target-order-bar">
      <div><strong>显示顺序</strong><span>拖动左侧手柄；可按商家/地区/价格/线路分组查看</span></div>
      <div class="order-tools">${groupByMenuHtml(adminGroupBy, "adminGroupByMenu")}<span class="order-state" id="targetOrderState">${targetAdminLoaded ? "已同步" : "读取中"}</span></div>
    </div>
    <div class="table-scroll">
      <table class="targets-table">
        <thead>
          <tr>
            <th>排序</th>
            <th>目标</th>
            <th>监控状态</th>
            <th>流量</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  bindTargetSorting();
  bindAdminGroupBy();
}

function bindAdminGroupBy() {
  const root = byId("adminGroupByMenu");
  const trigger = root?.querySelector(".group-by-trigger");
  const menu = root?.querySelector(".group-by-menu");
  const options = [...(menu?.querySelectorAll(".group-by-option") || [])];
  if (!root || !trigger || !menu || root.dataset.bound) return;
  root.dataset.bound = "1";

  const setOpen = (open, focusSelected = false) => {
    root.classList.toggle("is-open", open);
    trigger.setAttribute("aria-expanded", String(open));
    menu.hidden = !open;
    if (open && focusSelected) {
      (options.find(option => option.getAttribute("aria-selected") === "true") || options[0])?.focus();
    }
  };
  const choose = value => {
    adminGroupBy = value || "group";
    localStorage.setItem("nstatus.adminGroupBy", adminGroupBy);
    renderTargets();
  };

  trigger.onclick = event => {
    event.stopPropagation();
    setOpen(menu.hidden);
  };
  trigger.onkeydown = event => {
    if (!["ArrowDown", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    setOpen(true, true);
  };
  menu.onclick = event => {
    const option = event.target.closest("[data-group-value]");
    if (option) choose(option.dataset.groupValue);
  };
  menu.onkeydown = event => {
    const current = event.target.closest(".group-by-option");
    if (!current) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      trigger.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(current.dataset.groupValue);
      return;
    }
    const offset = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!offset) return;
    event.preventDefault();
    const index = options.indexOf(current);
    options[(index + offset + options.length) % options.length]?.focus();
  };
  root.onfocusout = event => {
    if (!root.contains(event.relatedTarget)) setOpen(false);
  };
}

document.addEventListener("click", () => {
  document.querySelectorAll(".group-by-control.is-open").forEach(root => {
    root.classList.remove("is-open");
    root.querySelector(".group-by-trigger")?.setAttribute("aria-expanded", "false");
    const menu = root.querySelector(".group-by-menu");
    if (menu) menu.hidden = true;
  });
});

function targetGroupCell(target) {
  const parts = [
    sharedDisplayGroupName(target.group_name),
    target.provider ? `商家:${target.provider}` : "",
    target.location || target.city ? `地区:${[target.location, target.city].filter(Boolean).join(" · ")}` : "",
    target.line_type ? `线路:${target.line_type}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function targetByAction(button) {
  const targetId = button?.dataset.targetId || button?.closest("tr")?.dataset.id || "";
  return targets.find(target => target.id === targetId);
}

function orderedTargetIdsFromTable() {
  return [...byId("tTable").querySelectorAll("tbody tr[data-id]")].map(row => row.dataset.id);
}

function applyTargetOrder(ids) {
  const byTargetId = new Map(targets.map(target => [target.id, target]));
  targets = ids.map(id => byTargetId.get(id)).filter(Boolean);
}

async function persistTargetOrder(ids) {
  if (!targetAdminLoaded || targetOrderSaving || !ids.length) return;
  targetOrderSaving = true;
  const state = byId("targetOrderState");
  if (state) {
    state.textContent = "保存中";
    state.classList.add("saving");
  }
  try {
    const result = await apiAdmin("/api/targets/order", {
      method: "PATCH",
      body: JSON.stringify({ ids }),
    }, 30000);
    applyTargetOrder(result.ids || ids);
    renderTargets();
    toast("排序已同步到前台", "ok");
  } catch (error) {
    toast(error.message, "err");
    await loadTargets();
  } finally {
    targetOrderSaving = false;
  }
}

function bindTargetSorting() {
  const table = byId("tTable").querySelector(".targets-table");
  const body = table?.tBodies?.[0];
  if (!body || !targetAdminLoaded) return;
  let draggedRow = null;
  let armedId = "";
  let originalOrder = [];

  body.addEventListener("pointerdown", event => {
    const handle = event.target.closest("[data-sort-handle]");
    armedId = handle?.closest("tr[data-id]")?.dataset.id || "";
  });
  body.addEventListener("dragstart", event => {
    const row = event.target.closest("tr[data-id]");
    if (!row || row.dataset.id !== armedId || targetOrderSaving) {
      event.preventDefault();
      return;
    }
    draggedRow = row;
    originalOrder = orderedTargetIdsFromTable();
    row.classList.add("is-dragging");
    table.classList.add("is-sorting");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", row.dataset.id);
  });
  body.addEventListener("dragover", event => {
    if (!draggedRow) return;
    event.preventDefault();
    const over = event.target.closest("tr[data-id]");
    if (!over || over === draggedRow) return;
    const rect = over.getBoundingClientRect();
    body.insertBefore(draggedRow, event.clientY < rect.top + rect.height / 2 ? over : over.nextSibling);
  });
  body.addEventListener("drop", event => event.preventDefault());
  body.addEventListener("dragend", () => {
    if (!draggedRow) return;
    draggedRow.classList.remove("is-dragging");
    table.classList.remove("is-sorting");
    const ids = orderedTargetIdsFromTable();
    draggedRow = null;
    armedId = "";
    if (ids.join("|") !== originalOrder.join("|")) persistTargetOrder(ids);
  });
}

function moveTarget(target, offset) {
  if (!target || targetOrderSaving) return;
  const index = targets.findIndex(item => item.id === target.id);
  const nextIndex = index + offset;
  if (index < 0 || nextIndex < 0 || nextIndex >= targets.length) return;
  const next = [...targets];
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  targets = next;
  renderTargets();
  persistTargetOrder(next.map(item => item.id));
}

function formField(label, html, className = "") {
  const extraClass = className ? ` ${className}` : "";
  return `<div class="f${extraClass}"><label>${escapeHtml(label)}</label>${html}</div>`;
}

function inputField(label, id, value = "", attrs = "") {
  return formField(
    label,
    `<input id="${id}" value="${escapeHtml(value)}" ${attrs}>`,
  );
}

function targetBillingOptions(cycle) {
  const options = [
    ["", "未设置"],
    ["hourly", "小时计费"],
    ["monthly", "月付"],
    ["yearly", "年付"],
    ["lifetime", "买断/永久"],
    ["onetime", "一次性/旧"],
  ];
  return options
    .map(
      ([value, label]) =>
        `<option value="${value}"${selectedAttr(cycle === value)}>${label}</option>`,
    )
    .join("");
}

function trafficModeOptions(mode = "total") {
  const options = [
    ["total", "双向合计（上行+下行）"],
    ["tx", "仅上行 / 出站"],
    ["rx", "仅下行 / 入站"],
    ["max", "上下行较大值"],
  ];
  return options
    .map(
      ([value, label]) =>
        `<option value="${value}"${selectedAttr((mode || "total") === value)}>${label}</option>`,
    )
    .join("");
}

function nullableInputValue(value) {
  return value === undefined || value === null ? "" : escapeHtml(value);
}

function targetRegionOptions(region = "auto") {
  const current = String(region || "auto").toLowerCase();
  return Object.entries(targetRegions)
    .map(
      ([value, label]) =>
        `<option value="${escapeHtml(value)}"${selectedAttr(current === value)}>${escapeHtml(label)} (${escapeHtml(value)})</option>`,
    )
    .join("");
}

function targetGroupOptions(type = "tcp", current = "") {
  const selected = /^web$/i.test(current) || (!current && type === "http") ? "Web" : "VPS";
  return ["VPS", "Web"]
    .map((value) => `<option value="${value}"${selectedAttr(selected === value)}>${value}</option>`)
    .join("");
}

function countryOptionsHtml(current = "", query = "") {
  const selected = normalizeCountryCode(current);
  const countries = filterCountries(query);
  const selectedCountry = COUNTRIES.find((country) => country.code === selected);
  const options = selectedCountry && !countries.includes(selectedCountry)
    ? [selectedCountry, ...countries]
    : countries;
  return [
    '<option value="">请选择国家或地区</option>',
    ...options.map((country) =>
      `<option value="${country.code}"${selectedAttr(country.code === selected)}>${escapeHtml(country.name)} (${country.code})</option>`),
  ].join("");
}

function providerOptionsHtml(current = "", query = "") {
  const selected = String(current || "").trim();
  const providers = filterProviders(query);
  const options = selected && !providers.includes(selected)
    ? [selected, ...providers]
    : providers;
  return [
    '<option value="">请选择商家</option>',
    ...options.map((provider) =>
      `<option value="${escapeHtml(provider)}"${selectedAttr(provider === selected)}>${escapeHtml(provider)}</option>`),
  ].join("");
}

function currencyOptionsHtml(current = "USD") {
  const selected = String(current || "USD").trim().toUpperCase();
  return CURRENCIES.map((currency) =>
    `<option value="${currency.code}"${selectedAttr(currency.code === selected)}>${escapeHtml(currency.name)} (${currency.code})</option>`).join("");
}

function searchableCatalogField({ label, searchId, selectId, searchPlaceholder, options }) {
  return formField(label, `
    <div class="catalog-select">
      <input type="search" id="${searchId}" placeholder="${escapeHtml(searchPlaceholder)}" autocomplete="off">
      <select id="${selectId}">${options}</select>
    </div>`);
}

function countryCatalogField(current = "") {
  const code = normalizeCountryCode(current);
  const asset = countryFlagAsset(code);
  return formField("位置", `
    <div class="catalog-select">
      <input type="search" id="mLocationSearch" placeholder="搜索中文名、英文名或代码" autocomplete="off">
      <div class="country-select-row">
        <img id="mLocationFlag" class="country-flag-preview" src="${escapeHtml(asset)}" alt=""${asset ? "" : " hidden"}>
        <select id="mLocation" required>${countryOptionsHtml(current)}</select>
      </div>
    </div>`);
}

function updateCountryPreview(code) {
  const preview = byId("mLocationFlag");
  if (!preview) return;
  const country = COUNTRIES.find((item) => item.code === code);
  const asset = countryFlagAsset(code);
  preview.hidden = !asset;
  preview.src = asset;
  preview.alt = country ? `${country.name}国旗` : "";
}

function bindCatalogSearch(searchId, selectId, renderOptions, onChange = () => {}) {
  const search = byId(searchId);
  const select = byId(selectId);
  if (!search || !select) return;
  search.oninput = () => {
    select.innerHTML = renderOptions(select.value, search.value);
    onChange(select.value);
  };
  search.onkeydown = (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    select.focus();
  };
  select.onchange = () => onChange(select.value);
  onChange(select.value);
}

function displayGroupName(value) {
  return sharedDisplayGroupName(value);
}

function nullableNumber(id) {
  const raw = (byId(id)?.value || "").trim();
  if (raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function targetModalHtml(target, isEdit) {
  const cycle = target.billing_cycle || "";
  const type = target.type || "tcp";
  const alertEnabled = target.alert_enabled === undefined ? true : Number(target.alert_enabled) !== 0;
  return `
    <h3>${isEdit ? "编辑" : "新增"}探针</h3>
    ${inputField("ID", "mId", target.id || "", isEdit ? "readonly" : "")}
    ${inputField("名称", "mName", target.name || "")}

    <div class="form-grid">
      ${formField(
        "类型",
        `
        <select id="mType">
          <option value="tcp"${selectedAttr(type === "tcp")}>TCP</option>
          <option value="http"${selectedAttr(type === "http")}>HTTP</option>
        </select>`,
      )}
      ${formField("分组", `<select id="mGroup">${targetGroupOptions(type, target.group_name)}</select>`)}
    </div>

    <div class="form-grid ftcp">
      ${formField("主机 / IP", `<input id="mHost" value="${escapeHtml(target.target_host || "")}">`)}
      ${formField("端口", `<input id="mPort" type="number" value="${escapeHtml(target.target_port || "")}">`)}
    </div>
    ${formField(
      "公网探测",
      `<label class="switch-line"><input type="checkbox" id="mNoPublicIp"${checkedAttr(Number(target.no_public_ip || 0))}><span>无公网 IP，仅使用 Agent 在线状态</span></label><p class="hint">停止 Cloudflare 与外部 Latency 节点探测；前台隐藏 Latency，SLA 仅按 Agent 心跳记录。</p>`,
      "ftcp",
    )}
    ${formField("URL", `<input id="mUrl" value="${escapeHtml(target.url || "")}">`, "fhttp")}
    ${formField("状态码", `<input id="mStatus" value="${escapeHtml(target.expected_status || "200,301,302")}">`, "fhttp")}

    <div class="form-grid">
      ${inputField("标签", "mTags", target.tags || "", 'placeholder="逗号分隔"')}
      ${countryCatalogField(target.location || "")}
      ${formField("城市", `<input id="mCity" value="${escapeHtml(target.city || "")}" placeholder="例如 Los Angeles / 东京" maxlength="64"><p class="hint">可选。前台显示为「国家 · 城市」。</p>`)}
      ${searchableCatalogField({
        label: "商家",
        searchId: "mProviderSearch",
        selectId: "mProvider",
        searchPlaceholder: "搜索商家名称",
        options: providerOptionsHtml(target.provider || ""),
      })}
      ${formField("线路类型", `<select id="mLineType">${lineTypeOptionsHtml(target.line_type || "")}</select>`)}
    </div>
    ${formField("NodeQuality 报告", `<textarea id="mNqReport" rows="8" placeholder="粘贴 NodeQuality 原始报告（包含 ::: tab-item、ANSI 文本和图片链接）">${escapeHtml(nodeQualityEditorValue(target))}</textarea><p class="hint">保存后前台 VPS 卡片会显示 NQ 按钮。再次保存空白内容会清除报告。</p>`)}

    <div class="form-grid">
      ${formField("到期时间", `<input id="mExpires" type="date" value="${dateInput(target.expires_at)}">`)}
      ${formField("费用", `<input id="mPrice" type="number" min="0" step="0.01" value="${escapeHtml(target.price ?? "")}">`)}
    </div>

    <div class="form-grid">
      ${formField("币种", `<select id="mCurrency">${currencyOptionsHtml(target.currency || "USD")}</select><p class="hint currency-note">汇率每日自动更新，前台统一换算为人民币。</p>`)}
      ${formField("计费周期", `<select id="mBilling">${targetBillingOptions(cycle)}</select>`)}
    </div>

    <div class="form-grid">
      ${formField("间隔秒", `<input id="mInterval" type="number" min="300" value="${escapeHtml(target.interval_sec || 300)}">`)}
      ${formField("Cloudflare 探测区域", `<select id="mRegion">${targetRegionOptions(target.probe_region)}</select>`)}
    </div>
    <p class="hint">选择指定大区后由对应 Cloudflare Durable Object 执行探测；更改后无需重新部署 Worker。</p>
    ${formField(
      "本 VPS 流量统计",
      `
      <label class="switch-line">
        <input type="checkbox" id="mTrafficEnabled"${checkedAttr(Number(target.traffic_enabled || 0))}>
        <span>启用流量累计</span>
      </label>
      <p class="hint">设置到期时间后，流量会按到期日号每月重置。</p>`,
      "fvps",
    )}

    <div class="form-grid fvps">
      ${formField("本 VPS 每月流量上限 GB", `<input id="mTrafficQuota" type="number" min="0" step="0.1" value="${escapeHtml(target.traffic_quota_gb || 0)}">`)}
      ${formField("流量计费方式", `<select id="mTrafficMode">${trafficModeOptions(target.traffic_mode)}</select>`)}
    </div>

    ${formField(
      "此探针报警",
      `
      <label class="switch-line">
        <input type="checkbox" id="mAlertEnabled"${checkedAttr(alertEnabled)}>
        <span>启用此探针的 Telegram 报警</span>
      </label>
      <p class="hint">以下阈值留空时使用“设置 → Telegram 报警”的全局规则。</p>`,
    )}

    <div class="form-grid">
      ${formField("到期前 N 天报警", `<input id="mAlertExpiryDays" type="number" min="0" step="1" placeholder="全局" value="${nullableInputValue(target.alert_expiry_days)}">`)}
      ${formField("流量剩余 % 报警", `<input id="mAlertTrafficPercent" type="number" min="0" max="100" step="0.1" placeholder="全局" value="${nullableInputValue(target.alert_traffic_remaining_percent)}">`, "fvps")}
    </div>
    ${formField("流量剩余 GB 报警", `<input id="mAlertTrafficGb" type="number" min="0" step="0.1" placeholder="全局" value="${nullableInputValue(target.alert_traffic_remaining_gb)}">`, "fvps")}

    <div class="ma">
      <button class="btn" data-close>取消</button>
      <button class="btn btn-primary" id="saveTarget">保存</button>
    </div>`;
}

function toggleTargetTypeFields() {
  const isTcp = byId("mType").value === "tcp";
  const group = byId("mGroup");
  if (group) group.value = isTcp ? "VPS" : "Web";
  document.querySelectorAll(".ftcp").forEach((item) => {
    item.style.display = isTcp ? "block" : "none";
  });
  document.querySelectorAll(".fhttp").forEach((item) => {
    item.style.display = isTcp ? "none" : "block";
  });
  document.querySelectorAll(".fvps").forEach((item) => {
    item.style.display = isTcp ? "block" : "none";
  });
  toggleNoPublicIpFields();
}

function toggleNoPublicIpFields() {
  const noPublicIp = byId("mType")?.value === "tcp" && !!byId("mNoPublicIp")?.checked;
  for (const id of ["mHost", "mPort", "mRegion"]) {
    const field = byId(id);
    if (field) field.disabled = noPublicIp;
  }
}

function targetModal(target = null) {
  const isEdit = Boolean(target);
  byId("modal").innerHTML = targetModalHtml(target || {}, isEdit);
  byId("mType").onchange = toggleTargetTypeFields;
  byId("mNoPublicIp").onchange = toggleNoPublicIpFields;
  bindCatalogSearch("mLocationSearch", "mLocation", countryOptionsHtml, updateCountryPreview);
  bindCatalogSearch("mProviderSearch", "mProvider", providerOptionsHtml);
  toggleTargetTypeFields();
  byId("saveTarget").onclick = () => saveTarget(isEdit);
  openModal();
}

async function saveTarget(edit) {
  const btn = byId("saveTarget");
  if (btn?.disabled) return;
  const priceRaw = (byId("mPrice")?.value || "").trim();
  const price = priceRaw === "" ? null : Number(priceRaw);
  if (priceRaw !== "" && !Number.isFinite(price))
    return toast("费用需要是数字", "err");
  const b = {
    name: byId("mName").value.trim(),
    type: byId("mType").value,
    group_name: byId("mGroup").value === "Web" ? "Web" : "VPS",
    interval_sec: Number(byId("mInterval").value) || 300,
    probe_region: byId("mRegion")?.value || "auto",
    no_public_ip: byId("mType").value === "tcp" && !!byId("mNoPublicIp")?.checked,
    tags: byId("mTags")?.value.trim() || "",
    location: byId("mLocation")?.value || "",
    city: (byId("mCity")?.value || "").trim().slice(0, 64),
    provider: byId("mProvider")?.value || "",
    line_type: byId("mLineType")?.value || "",
    nq_report: (byId("mNqReport")?.value || "").trim(),
    expires_at: byId("mExpires")?.value || null,
    price,
    billing_cycle: byId("mBilling")?.value || "",
    currency: byId("mCurrency")?.value || "USD",
    traffic_enabled: byId("mType").value === "tcp" && !!byId("mTrafficEnabled")?.checked,
    traffic_quota_gb: byId("mType").value === "tcp" ? Number(byId("mTrafficQuota")?.value) || 0 : 0,
    traffic_mode: byId("mTrafficMode")?.value || "total",
    alert_enabled: !!byId("mAlertEnabled")?.checked,
    alert_expiry_days: nullableNumber("mAlertExpiryDays"),
    alert_traffic_remaining_percent: byId("mType").value === "tcp" ? nullableNumber("mAlertTrafficPercent") : null,
    alert_traffic_remaining_gb: byId("mType").value === "tcp" ? nullableNumber("mAlertTrafficGb") : null,
  };
  const id = byId("mId").value.trim();
  if (id && !edit) b.id = id;
  if (!b.name) return toast("名称不能为空", "err");
  if (!b.location) return toast("请选择国家或地区", "err");
  if (b.type === "tcp") {
    b.target_host = byId("mHost").value.trim();
    b.target_port = Number(byId("mPort").value) || 0;
    if (!b.no_public_ip && (!b.target_host || !b.target_port)) return toast("需要主机和端口，或选择“无公网 IP”", "err");
  } else {
    b.url = byId("mUrl").value.trim();
    b.expected_status = byId("mStatus").value.trim() || "200,301,302";
    if (!b.url) return toast("需要 URL", "err");
  }
  const oldText = btn?.textContent || "保存";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "保存中...";
  }
  try {
    await apiAdmin(
      edit ? "/api/targets/" + encodeURIComponent(id) : "/api/targets",
      { method: edit ? "PATCH" : "POST", body: JSON.stringify(b) },
      30000,
    );
    toast("已保存", "ok");
    closeModal();
    loadTargets();
  } catch (e) {
    toast(e.message, "err");
  } finally {
    if (btn && document.body.contains(btn)) {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }
}
async function toggleTarget(t) {
  try {
    await api("/api/targets/" + encodeURIComponent(t.id), {
      method: "PATCH",
      body: JSON.stringify({ enabled: !t.enabled }),
    });
    toast("已更新", "ok");
    loadTargets();
  } catch (e) {
    toast(e.message, "err");
  }
}
async function deleteTarget(t) {
  if (!confirm("删除 " + t.name + "？")) return;
  try {
    await api("/api/targets/" + encodeURIComponent(t.id), { method: "DELETE" });
    toast("已删除", "ok");
    loadTargets();
  } catch (e) {
    toast(e.message, "err");
  }
}
function showInstallCommands(t, data) {
  const linuxCommand = data.linux_command || data.command || "";
  const windowsCommand = data.windows_command || "";
  byId("modal").innerHTML = `
    <h3>部署 Agent · ${escapeHtml(t.name || t.id)}</h3>
    <div class="install-command-block">
      <div class="install-command-head"><strong>Linux</strong><button class="btn btn-sm btn-blue" type="button" data-copy-install="linux">复制 Linux 命令</button></div>
      <pre class="code">${escapeHtml(linuxCommand)}</pre>
    </div>
    ${windowsCommand ? `<div class="install-command-block"><div class="install-command-head"><strong>Windows PowerShell</strong><button class="btn btn-sm btn-blue" type="button" data-copy-install="windows">复制 Windows 命令</button></div><pre class="code">${escapeHtml(windowsCommand)}</pre></div>` : ""}
    <div class="ma"><button class="btn" type="button" data-close>关闭</button></div>`;
  byId("modal").querySelectorAll("[data-copy-install]").forEach((button) => {
    button.onclick = async () => {
      const command = button.dataset.copyInstall === "windows" ? windowsCommand : linuxCommand;
      try {
        await copyText(command);
        toast(`已复制 ${button.dataset.copyInstall === "windows" ? "Windows" : "Linux"} 安装命令`, "ok");
      } catch (error) {
        toast(error?.message || "复制失败，请手动选择命令", "err");
      }
    };
  });
  openModal();
}

function showInstallProgress(t) {
  byId("modal").innerHTML = `
    <h3>部署 Agent · ${escapeHtml(t.name || t.id)}</h3>
    <div class="install-progress" role="status">
      <span class="install-spinner" aria-hidden="true"></span>
      <div><strong>正在生成安装命令</strong><p>正在校验管理会话并向 Worker 请求专用 Token...</p></div>
    </div>
    <div class="ma"><button class="btn" type="button" data-close>取消</button></div>`;
  openModal();
}

function showInstallError(t, error) {
  byId("modal").innerHTML = `
    <h3>部署 Agent · ${escapeHtml(t.name || t.id)}</h3>
    <div class="install-error" role="alert"><strong>安装命令生成失败</strong><p>${escapeHtml(error?.message || "未知错误")}</p></div>
    <div class="ma"><button class="btn" type="button" data-close>关闭</button><button class="btn btn-primary" type="button" data-retry-install>重试</button></div>`;
  byId("modal").querySelector("[data-retry-install]").onclick = () => deploy(t);
  openModal();
}

async function deploy(t, trigger = null) {
  if (!t?.id) {
    toast("无法识别当前探针，请刷新后台后重试", "err");
    return;
  }
  const oldText = trigger?.textContent || "部署 Agent";
  if (trigger) {
    trigger.disabled = true;
    trigger.textContent = "生成中...";
  }
  showInstallProgress(t);
  toast("正在生成安装命令...", "info");
  try {
    const d = await apiAdmin(
      "/api/agent/install-command?target_id=" + encodeURIComponent(t.id),
      {},
      20000,
    );
    const cmd = d.linux_command || d.command;
    if (!cmd)
      throw new Error(d.error || "Worker 未返回安装命令");
    showInstallCommands(t, d);
    try {
      await copyText(cmd);
      toast("已生成并复制“" + (t.name || t.id) + "”的 Linux 安装命令", "ok");
    } catch (_) {
      toast("命令已生成；浏览器未允许自动复制，请在窗口中手动复制", "info");
    }
  } catch (e) {
    showInstallError(t, e);
    toast("生成安装命令失败：" + (e?.message || "未知错误"), "err");
  } finally {
    if (trigger && document.body.contains(trigger)) {
      trigger.disabled = false;
      trigger.textContent = oldText;
    }
  }
}

async function loadLatencyNodes() {
  loading("latencyTable", "加载 Latency 节点...");
  try {
    const data = await apiAdmin("/api/latency-agents", {}, 30000);
    latencyNodes = data.nodes || [];
    renderLatencyNodes();
  } catch (error) {
    errBox("latencyTable", error);
  }
}

function renderLatencyNodes() {
  const builtin = `
    <tr class="latency-builtin-row">
      <td><code>cloudflare</code></td>
      <td><strong>Cloudflare</strong><small class="table-note">系统默认来源</small></td>
      <td><span class="tag tag-on">内置 · 启用</span></td>
      <td>全球边缘网络</td>
      <td><span class="muted">固定保留，不可删除</span></td>
    </tr>`;
  const external = latencyNodes.map((node, index) => `
    <tr data-i="${index}">
      <td><code>${escapeHtml(node.id)}</code></td>
      <td>${escapeHtml(node.name)}</td>
      <td><span class="tag ${Number(node.enabled) ? "tag-on" : "tag-off"}">${Number(node.enabled) ? "启用" : "停用"}</span></td>
      <td>${node.last_seen_at ? escapeHtml(new Date(Number(node.last_seen_at) * 1000).toLocaleString("zh-CN")) : "尚未上报"}</td>
      <td><div class="actions">
        <button class="btn btn-xs btn-deploy" data-a="latency-deploy">部署</button>
        <button class="btn btn-xs" data-a="latency-edit">编辑</button>
        <button class="btn btn-xs" data-a="latency-toggle">${Number(node.enabled) ? "停用" : "启用"}</button>
        <button class="btn btn-xs btn-danger" data-a="latency-delete">删除</button>
      </div></td>
    </tr>`).join("");
  byId("latencyTable").innerHTML = `
    <div class="table-scroll">
      <table class="pings-table latency-nodes-table">
        <thead><tr><th>ID</th><th>显示名称</th><th>状态</th><th>最近上报</th><th>操作</th></tr></thead>
        <tbody>${builtin}${external}</tbody>
      </table>
    </div>`;
}

function latencyNodeModal(node = null) {
  const edit = Boolean(node);
  byId("modal").innerHTML = `
    <h3>${edit ? "编辑" : "新增"} Latency 节点</h3>
    ${edit ? inputField("ID", "latencyNodeId", node.id, "readonly") : ""}
    ${inputField("显示名称", "latencyNodeName", node?.name || "", 'placeholder="例如：东京 IIJ、洛杉矶 CN2"')}
    <p class="hint">名称会显示在前台 Latency 列表中；此节点与 VPS Agent、Ping 功能完全独立。</p>
    <div class="ma"><button class="btn" data-close>取消</button><button class="btn btn-primary" id="saveLatencyNode">保存</button></div>`;
  byId("saveLatencyNode").onclick = () => saveLatencyNode(node);
  openModal();
}

async function saveLatencyNode(node = null) {
  const name = byId("latencyNodeName").value.trim();
  if (!name) return toast("请填写 Latency 节点名称", "err");
  const button = byId("saveLatencyNode");
  button.disabled = true;
  try {
    await apiAdmin(node ? `/api/latency-agents/${encodeURIComponent(node.id)}` : "/api/latency-agents", {
      method: node ? "PATCH" : "POST",
      body: JSON.stringify({ name }),
    }, 30000);
    closeModal();
    toast("Latency 节点已保存", "ok");
    loadLatencyNodes();
  } catch (error) {
    toast(error.message, "err");
    button.disabled = false;
  }
}

async function toggleLatencyNode(node) {
  try {
    await apiAdmin(`/api/latency-agents/${encodeURIComponent(node.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !Number(node.enabled) }) });
    toast("Latency 节点状态已更新", "ok");
    loadLatencyNodes();
  } catch (error) {
    toast(error.message, "err");
  }
}

async function deleteLatencyNode(node) {
  if (!confirm(`删除 Latency 节点“${node.name}”及其历史数据？`)) return;
  try {
    await apiAdmin(`/api/latency-agents/${encodeURIComponent(node.id)}`, { method: "DELETE" });
    toast("Latency 节点已删除", "ok");
    loadLatencyNodes();
  } catch (error) {
    toast(error.message, "err");
  }
}

async function deployLatencyNode(node, trigger = null) {
  if (trigger) trigger.disabled = true;
  byId("modal").innerHTML = `<h3>部署 Latency 节点 · ${escapeHtml(node.name)}</h3><div class="install-progress" role="status"><span class="install-spinner" aria-hidden="true"></span><div><strong>正在生成独立安装命令</strong><p>该命令不会安装 VPS 监控 Agent。</p></div></div>`;
  openModal();
  try {
    const data = await apiAdmin(`/api/latency-agent/install-command?node_id=${encodeURIComponent(node.id)}`, {}, 20000);
    const command = data.linux_command || "";
    if (!command) throw new Error(data.error || "Worker 未返回安装命令");
    byId("modal").innerHTML = `
      <h3>部署 Latency 节点 · ${escapeHtml(node.name)}</h3>
      <p class="hint">独立 Latency 安装器，只执行 TCP 延迟测量，不采集 VPS 资源，也不属于 Ping。</p>
      <div class="install-command-block"><div class="install-command-head"><strong>Linux</strong><button class="btn btn-sm btn-blue" id="copyLatencyInstall">复制安装命令</button></div><pre class="code">${escapeHtml(command)}</pre></div>
      <div class="ma"><button class="btn" data-close>关闭</button></div>`;
    byId("copyLatencyInstall").onclick = async () => {
      try { await copyText(command); toast("已复制 Latency 节点安装命令", "ok"); }
      catch (error) { toast(error.message || "复制失败", "err"); }
    };
    try { await copyText(command); toast("已生成并复制独立 Latency 安装命令", "ok"); }
    catch (_) { toast("命令已生成，请在窗口中手动复制", "info"); }
  } catch (error) {
    byId("modal").innerHTML = `<h3>部署 Latency 节点 · ${escapeHtml(node.name)}</h3><div class="install-error" role="alert"><strong>安装命令生成失败</strong><p>${escapeHtml(error.message || "未知错误")}</p></div><div class="ma"><button class="btn" data-close>关闭</button></div>`;
    toast(error.message, "err");
  } finally {
    if (trigger && document.body.contains(trigger)) trigger.disabled = false;
  }
}

async function loadPings() {
  loading(
    "pTable",
    "\u52a0\u8f7d Ping \u76ee\u6807\u4e2d\uff0c\u5148\u5c1d\u8bd5\u663e\u793a\u5df2\u91c7\u96c6\u6570\u636e...",
  );
  pingTargets = [];
  pingAdminLoaded = false;
  pingAdminFailed = false;
  let shown = false;
  try {
    const pd = await apiPublic("/api/agent/pings?hours=1", 15000);
    pingTargets = pd.targets || [];
    renderPings();
    shown = pingTargets.length > 0;
  } catch (e) {}
  try {
    const d = await apiAdmin("/api/ping-targets", {}, 30000);
    pingTargets = d.targets || pingTargets;
    pingAdminLoaded = true;
    renderPings();
  } catch (e) {
    pingAdminFailed = true;
    if (!shown) {
      errBox("pTable", e);
    } else {
      renderPings();
      toast(
        "Ping \u7ba1\u7406\u64cd\u4f5c\u52a0\u8f7d\u8f83\u6162\uff0c\u5df2\u5148\u663e\u793a Ping \u76ee\u6807",
        "info",
      );
    }
  }
}

function renderPings() {
  if (!pingTargets.length) {
    byId("pTable").innerHTML = '<div class="empty">暂无 Ping 目标</div>';
    return;
  }

  const rows = pingTargets
    .map((ping, index) => pingRowHtml(ping, index))
    .join("");
  byId("pTable").innerHTML = `
    <div class="table-scroll">
      <table class="pings-table">
        <thead>
          <tr>
            <th>#</th>
            <th>ID</th>
            <th>名称</th>
            <th>目标</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function pingActionsHtml(ping) {
  if (!pingAdminLoaded) {
    return pingAdminFailed
      ? '<button class="btn btn-xs btn-blue" data-a="reload">重试管理</button>'
      : '<span class="tag tag-warn">管理加载中</span>';
  }

  return [
    `<button class="btn btn-xs" data-a="toggle">${ping.enabled ? "禁用" : "启用"}</button>`,
    '<button class="btn btn-xs btn-blue" data-a="edit">编辑</button>',
    '<button class="btn btn-xs btn-danger" data-a="delete">删</button>',
  ].join("");
}

function pingRowHtml(ping, index) {
  const enabled =
    ping.enabled !== 0
      ? statusTag("已启用", "tag-on")
      : statusTag("已禁用", "tag-off");
  return `
    <tr data-i="${index}">
      <td>${index + 1}</td>
      <td><code>${escapeHtml(ping.id)}</code></td>
      <td>${escapeHtml(ping.name)}</td>
      <td><code>${escapeHtml(ping.target || "-")}</code></td>
      <td>${enabled}</td>
      <td><div class="actions">${pingActionsHtml(ping)}</div></td>
    </tr>`;
}
function pingModal(p = null) {
  const isEdit = Boolean(p);
  const ping = p || {};
  byId("modal").innerHTML = `
    <h3>${isEdit ? "编辑" : "新增"} Ping</h3>
    ${inputField("ID", "pId", ping.id || "", isEdit ? "readonly" : "")}
    ${inputField("名称", "pName", ping.name || "")}
    ${inputField("目标", "pTarget", ping.target || "", 'placeholder="host:port"')}
    <div class="ma">
      <button class="btn" data-close>取消</button>
      <button class="btn btn-primary" id="savePing">保存</button>
    </div>`;
  byId("savePing").onclick = () => savePing(isEdit);
  openModal();
}
async function savePing(edit) {
  const id = byId("pId").value.trim(),
    name = byId("pName").value.trim(),
    target = byId("pTarget").value.trim();
  if (!name || !target) return toast("名称和目标必填", "err");
  try {
    await api(
      edit
        ? "/api/ping-targets/" + encodeURIComponent(id)
        : "/api/ping-targets",
      {
        method: edit ? "PATCH" : "POST",
        body: JSON.stringify({ id: id || undefined, name, target }),
      },
    );
    toast("已保存", "ok");
    closeModal();
    loadPings();
  } catch (e) {
    toast(e.message, "err");
  }
}
async function togglePing(p) {
  try {
    await api("/api/ping-targets/" + encodeURIComponent(p.id), {
      method: "PATCH",
      body: JSON.stringify({ enabled: !p.enabled }),
    });
    toast("已更新", "ok");
    loadPings();
  } catch (e) {
    toast(e.message, "err");
  }
}
async function deletePing(p) {
  if (!confirm("删除 " + p.name + "？")) return;
  try {
    await api("/api/ping-targets/" + encodeURIComponent(p.id), {
      method: "DELETE",
    });
    toast("已删除", "ok");
    loadPings();
  } catch (e) {
    toast(e.message, "err");
  }
}
async function loadSettings() {
  loadSysInfo();
  loadTotp();
  loadTheme();
  loadAgentUpdate();
  loadTraffic();
  loadAlerts();
  loadAppearance();
}

const appearanceSections = [
  { title: '品牌与页头', fields: [
    ['site_name', '站点名称'], ['site_subtitle', '页头副标题'], ['hero_subtitle', '状态横幅下方说明'], ['page_title', '浏览器页面标题'],
    ['favicon_url', '浏览器图标 URL'], ['brand_home_url', '左上角品牌链接'], ['brand_logo_url', '左上角 Logo URL'],
    ['brand_logo_alt', 'Logo 替代文字'], ['brand_logo_height', 'Logo 高度（20-64px）', 'number'],
    ['brand_avatar_url', '卡片主题头像 URL'],
    ['header_right_mode', '右上角显示方式', 'select', [['image', '显示图片'], ['text', '显示文字'], ['hidden', '隐藏']]],
    ['header_right_text', '右上角文字'], ['header_right_image_url', '右上角图片 URL'],
    ['header_right_image_alt', '右上角图片替代文字'], ['header_right_image_width', '右上角图片宽度（40-240px）', 'number'],
    ['header_right_link', '右上角跳转链接'],
  ] },
  { title: '状态与导航文案', fields: [
    ['search_placeholder', '列表主题搜索提示'], ['cards_search_placeholder', '卡片主题搜索提示'], ['group_by_title', '分组栏标题'],
    ['banner_normal', '全部正常文案'], ['banner_down', '服务离线文案'], ['banner_degraded', '数据延迟文案'],
    ['banner_unknown', '等待检查文案'], ['summary_total', '服务总数摘要'], ['summary_up', '正常服务摘要'],
    ['summary_down', '离线服务摘要'], ['summary_degraded', '延迟服务摘要'], ['summary_unknown', '待检查服务摘要'],
    ['summary_latency', '平均延迟摘要'], ['summary_updated', '更新时间摘要'],
  ] },
  { title: '内容区文案', fields: [
    ['incident_title', '故障区标题'], ['incident_empty', '无故障摘要'], ['incident_empty_detail', '无故障详情'],
    ['checks_title', '最近检查标题'], ['checks_hint', '最近检查提示'], ['checks_empty', '未选择服务提示'],
    ['checks_unselected', '未选择服务标题'], ['checks_no_records', '无检查记录提示'], ['no_search_results', '无搜索结果提示'],
    ['chart_title', '响应时间图表标题'], ['chart_unselected', '图表未选择提示'], ['latency_title', '卡片延迟区标题'],
    ['latency_subtitle', '卡片延迟区副标题'], ['vps_details_label', 'VPS 详情折叠标题'],
  ] },
  { title: '页脚与颜色', fields: [
    ['footer_text', '页脚文案'], ['footer_link_text', '页脚链接文字'], ['footer_link_url', '页脚链接 URL'],
    ['accent_color', '强调色', 'color'], ['page_background', '页面背景色', 'color'], ['surface_color', '内容表面色', 'color'],
  ] },
  { title: '首页显示区域', fields: [
    ['show_header', '显示页头', 'checkbox'], ['show_banner', '显示状态横幅', 'checkbox'], ['show_summary', '显示状态摘要', 'checkbox'],
    ['show_search', '显示搜索框', 'checkbox'], ['show_group_by', '显示分组栏', 'checkbox'],
    ['show_region_filter', '卡片主题显示地区筛选', 'checkbox'], ['show_card_sidebar', '卡片主题显示统计侧栏', 'checkbox'],
    ['show_incidents', '显示故障记录', 'checkbox'], ['show_chart', '显示监控图表', 'checkbox'],
    ['show_card_latency', '卡片显示 Latency 区', 'checkbox'], ['show_vps_details', '显示 VPS 详情', 'checkbox'],
    ['show_checks', '显示最近检查', 'checkbox'],
    ['show_footer', '显示页脚', 'checkbox'],
  ] },
];

function appearanceFieldHtml(field, appearance) {
  const [key, label, type = 'text', options = []] = field;
  const value = appearance[key];
  if (type === 'checkbox') {
    return `<label class="appearance-switch"><span>${escapeHtml(label)}</span><input data-appearance-key="${escapeHtml(key)}" type="checkbox"${checkedAttr(value === true)}></label>`;
  }
  if (type === 'select') {
    return `<label><span>${escapeHtml(label)}</span><select data-appearance-key="${escapeHtml(key)}">${options.map(([id, text]) => `<option value="${escapeHtml(id)}"${selectedAttr(value === id)}>${escapeHtml(text)}</option>`).join('')}</select></label>`;
  }
  return `<label><span>${escapeHtml(label)}</span><input data-appearance-key="${escapeHtml(key)}" value="${escapeHtml(value ?? '')}" type="${type}"></label>`;
}

async function loadAppearance() {
  const box = byId('sAppearance');
  if (!box) return;
  try {
    const d = await api('/api/settings');
    const appearance = d.appearance || {};
    box.innerHTML = `<div class="appearance-editor">${appearanceSections.map(section => `<fieldset><legend>${escapeHtml(section.title)}</legend><div class="appearance-form">${section.fields.map(field => appearanceFieldHtml(field, appearance)).join('')}</div></fieldset>`).join('')}</div><p class="hint">文案支持 <code>{count}</code>、<code>{value}</code> 和 <code>{site_name}</code> 占位符；图片与链接仅接受 HTTPS 或站内相对路径。</p><div class="appearance-actions"><button class="btn btn-primary" id="saveAppearance">保存外观</button><button class="btn" id="resetAppearance">恢复默认</button></div>`;
    byId('saveAppearance').onclick = () => saveAppearance(false);
    byId('resetAppearance').onclick = () => saveAppearance(true);
  } catch (e) { errBox('sAppearance', e); }
}

async function saveAppearance(reset) {
  const appearance = {};
  if (!reset) document.querySelectorAll('[data-appearance-key]').forEach((input) => {
    appearance[input.dataset.appearanceKey] = input.type === 'checkbox' ? input.checked : input.value;
  });
  try {
    const d = await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ appearance }) });
    toast(reset ? '已恢复默认外观' : '外观设置已保存', 'ok');
    loadAppearance();
  } catch (e) { toast(e.message, 'err'); }
}
async function loadTheme() {
  try {
    const d = await api("/api/settings");
    const cur = d.frontend_theme || "classic";
    byId("sTheme").innerHTML =
      '<p class="hint">选择首页展示风格；原版 UI 保留，卡片风格为额外主题。</p><div class="seg" id="themeBtns"><button class="btn ' +
      (cur === "classic" ? "on" : "") +
      '" data-theme="classic">原版列表</button><button class="btn ' +
      (cur === "cards" ? "on" : "") +
      '" data-theme="cards">卡片风格</button></div>';
    document
      .querySelectorAll("#themeBtns button")
      .forEach((b) => (b.onclick = () => saveTheme(b.dataset.theme)));
  } catch (e) {
    errBox("sTheme", e);
  }
}
async function saveTheme(theme) {
  try {
    const d = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ frontend_theme: theme }),
    });
    toast(
      "前端样式已切换为 " +
        (d.frontend_theme === "cards" ? "卡片风格" : "原版列表"),
      "ok",
    );
    loadTheme();
  } catch (e) {
    toast(e.message, "err");
  }
}
async function loadAgentUpdate() {
  try {
    const d = await api("/api/settings");
    const enabled = d.agent_auto_update === true;
    byId("sAgentUpdate").innerHTML =
      '<label class="switch-line"><input type="checkbox" id="agentAutoUpdate"' +
      (enabled ? " checked" : "") +
      "><span>发现新版本后自动更新</span></label>" +
      '<p class="hint">关闭时 Agent 不会修改自身；需要用户在 VPS 中执行 <code>cftz update</code>。开启后仍会先完成版本与 SHA-256 校验。目前仅 Linux 支持自动安装，旧版 Agent 需要先手动更新一次。</p>';
    byId("agentAutoUpdate").onchange = saveAgentUpdate;
  } catch (e) {
    errBox("sAgentUpdate", e);
  }
}
async function saveAgentUpdate() {
  const input = byId("agentAutoUpdate");
  const enabled = !!input?.checked;
  if (input) input.disabled = true;
  try {
    const d = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ agent_auto_update: enabled }),
    });
    toast(
      d.agent_auto_update ? "Agent 自动更新已开启" : "Agent 自动更新已关闭",
      "ok",
    );
  } catch (e) {
    if (input) input.checked = !enabled;
    toast(e.message, "err");
  } finally {
    if (input) input.disabled = false;
  }
}
async function loadTraffic() {
  try {
    await api("/api/settings");
    byId("sTraffic").innerHTML =
      `<p class="hint">流量统计按 VPS 单独设置。到“探针管理”里编辑某台 VPS，可单独开启流量累计并设置该 VPS 的每月上限。</p><div class="traffic-settings"><p class="hint">如果设置了到期时间，流量会按照到期时间的日号每月重置；未设置到期时间时按自然月重置。数据保存在 CF/D1。</p></div>`;
  } catch (e) {
    errBox("sTraffic", e);
  }
}
async function loadAlerts() {
  const box = byId("sAlerts");
  if (!box) return;
  try {
    const d = await api("/api/alerts/settings");
    box.innerHTML = alertSettingsHtml(d);
    byId("saveAlerts").onclick = saveAlerts;
    byId("testAlert").onclick = testAlert;
    byId("runAlertCheck").onclick = runAlertCheck;
  } catch (e) {
    errBox("sAlerts", e);
  }
}

function alertSettingsHtml(d) {
  const tokenHint = d.telegram_bot_token_set
    ? `已配置${d.telegram_bot_token_source === "env" ? "（环境变量）" : "（后台保存）"}；留空不修改`
    : "未配置，请填写 Bot Token";
  return `
    <div class="traffic-settings alert-settings">
      <label class="switch-line">
        <input type="checkbox" id="aEnabled"${checkedAttr(d.enabled)}>
        <span>启用 Telegram 报警</span>
      </label>
      <div class="form-grid">
        ${formField("Bot Token", `<input id="aToken" type="password" placeholder="${escapeHtml(tokenHint)}">`)}
        ${formField("Chat ID", `<input id="aChat" value="${escapeHtml(d.telegram_chat_id || "")}" placeholder="-100xxxxxxxxxx">`)}
      </div>
      <div class="form-grid">
        ${formField("离线超过 N 分钟", `<input id="aOffline" type="number" min="1" step="1" value="${escapeHtml(d.offline_minutes)}">`)}
        ${formField("重复提醒冷却分钟", `<input id="aRepeat" type="number" min="0" step="1" value="${escapeHtml(d.repeat_minutes)}">`)}
      </div>
      <label class="switch-line">
        <input type="checkbox" id="aNotifyOnline"${checkedAttr(d.notify_online)}>
        <span>恢复上线时也推送</span>
      </label>

      <p class="hint">资源阈值填 0 表示关闭该项。CPU / 内存 / 硬盘为百分比，IO / Net 单位为 MB/s。</p>
      <div class="form-grid alert-grid">
        ${formField("CPU %", `<input id="aCpu" type="number" min="0" max="100" step="0.1" value="${escapeHtml(d.cpu_percent)}">`)}
        ${formField("内存 %", `<input id="aMem" type="number" min="0" max="100" step="0.1" value="${escapeHtml(d.memory_percent)}">`)}
        ${formField("硬盘 %", `<input id="aDisk" type="number" min="0" max="100" step="0.1" value="${escapeHtml(d.disk_percent)}">`)}
        ${formField("负载 load1", `<input id="aLoad" type="number" min="0" step="0.01" value="${escapeHtml(d.load1)}">`)}
        ${formField("磁盘读 MB/s", `<input id="aDiskRead" type="number" min="0" step="0.1" value="${escapeHtml(d.disk_read_mb_s)}">`)}
        ${formField("磁盘写 MB/s", `<input id="aDiskWrite" type="number" min="0" step="0.1" value="${escapeHtml(d.disk_write_mb_s)}">`)}
        ${formField("下行 MB/s", `<input id="aNetRx" type="number" min="0" step="0.1" value="${escapeHtml(d.net_rx_mb_s)}">`)}
        ${formField("上行 MB/s", `<input id="aNetTx" type="number" min="0" step="0.1" value="${escapeHtml(d.net_tx_mb_s)}">`)}
        ${formField("进程数", `<input id="aProcess" type="number" min="0" step="1" value="${escapeHtml(d.process_count)}">`)}
        ${formField("线程数", `<input id="aThread" type="number" min="0" step="1" value="${escapeHtml(d.thread_count)}">`)}
      </div>

      <p class="hint">到期和流量规则可以在每台 VPS 编辑窗口里单独覆盖；留空则使用下面的全局值。</p>
      <div class="form-grid">
        ${formField("到期前 N 天", `<input id="aExpiry" type="number" min="0" step="1" value="${escapeHtml(d.expiry_days)}">`)}
        ${formField("流量剩余 %", `<input id="aTrafficPct" type="number" min="0" max="100" step="0.1" value="${escapeHtml(d.traffic_remaining_percent)}">`)}
      </div>
      ${formField("流量剩余 GB", `<input id="aTrafficGb" type="number" min="0" step="0.1" value="${escapeHtml(d.traffic_remaining_gb)}">`)}

      <div class="ma alert-actions">
        <button class="btn" id="runAlertCheck">立即检查</button>
        <button class="btn btn-blue" id="testAlert">测试 TG</button>
        <button class="btn btn-primary" id="saveAlerts">保存报警设置</button>
      </div>
    </div>`;
}

function alertSettingsPayload() {
  const token = (byId("aToken")?.value || "").trim();
  const payload = {
    enabled: !!byId("aEnabled")?.checked,
    telegram_chat_id: byId("aChat")?.value.trim() || "",
    offline_minutes: Number(byId("aOffline")?.value) || 10,
    repeat_minutes: Number(byId("aRepeat")?.value) || 0,
    notify_online: !!byId("aNotifyOnline")?.checked,
    cpu_percent: Number(byId("aCpu")?.value) || 0,
    memory_percent: Number(byId("aMem")?.value) || 0,
    disk_percent: Number(byId("aDisk")?.value) || 0,
    load1: Number(byId("aLoad")?.value) || 0,
    disk_read_mb_s: Number(byId("aDiskRead")?.value) || 0,
    disk_write_mb_s: Number(byId("aDiskWrite")?.value) || 0,
    net_rx_mb_s: Number(byId("aNetRx")?.value) || 0,
    net_tx_mb_s: Number(byId("aNetTx")?.value) || 0,
    process_count: Number(byId("aProcess")?.value) || 0,
    thread_count: Number(byId("aThread")?.value) || 0,
    expiry_days: Number(byId("aExpiry")?.value) || 0,
    traffic_remaining_percent: Number(byId("aTrafficPct")?.value) || 0,
    traffic_remaining_gb: Number(byId("aTrafficGb")?.value) || 0,
  };
  if (token) payload.telegram_bot_token = token;
  return payload;
}

async function saveAlerts() {
  const btn = byId("saveAlerts");
  const oldText = btn?.textContent || "保存报警设置";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "保存中...";
  }
  try {
    await api("/api/alerts/settings", {
      method: "PATCH",
      body: JSON.stringify(alertSettingsPayload()),
    });
    toast("报警设置已保存", "ok");
    loadAlerts();
    return true;
  } catch (e) {
    toast(e.message, "err");
    return false;
  } finally {
    if (btn && document.body.contains(btn)) {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }
}

async function testAlert() {
  try {
    if ((await saveAlerts()) === false) return;
    await api("/api/alerts/test", { method: "POST", body: "{}" });
    toast("测试报警已发送", "ok");
  } catch (e) {
    toast(e.message, "err");
  }
}

async function runAlertCheck() {
  try {
    const d = await api("/api/alerts/check", { method: "POST", body: "{}" });
    toast(`检查完成，发送 ${d.sent || 0} 条`, d.ok ? "ok" : "err");
  } catch (e) {
    toast(e.message, "err");
  }
}
async function loadSysInfo() {
  try {
    const d = await api("/api/status?days=1");
    byId("sInfo").innerHTML =
      infoRow("名称", d.name || "聶.NET") +
      infoRow("时区", d.timezone?.label || "UTC+8") +
      infoRow("目标数", d.targets?.length || 0) +
      infoRow("存储", d.storage?.mode || "D1");
  } catch (e) {
    errBox("sInfo", e);
  }
}
function infoRow(k, v) {
  return `<div class="ir"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`;
}
async function loadTotp() {
  try {
    const d = await api("/api/login");
    byId("sTotp").innerHTML = d.totp_enabled
      ? '<p style="color:#059669;font-weight:800">✓ TOTP 已启用</p><button class="btn btn-danger btn-sm" id="disableTotp">关闭</button>'
      : '<p class="hint">未启用</p><button class="btn btn-primary btn-sm" id="initTotp">启用</button>';
    byId("disableTotp") && (byId("disableTotp").onclick = disableTotp);
    byId("initTotp") && (byId("initTotp").onclick = initTotp);
  } catch (e) {
    errBox("sTotp", e);
  }
}
async function initTotp() {
  try {
    const d = await api("/api/totp/setup", { method: "POST", body: "{}" });
    byId("sTotp").innerHTML =
      `<p>密钥</p><pre class="code">${escapeHtml(d.secret)}</pre><div class="f"><label>验证码</label><input id="totpCode" maxlength="6"></div><button class="btn btn-primary btn-sm" id="verifyTotp">确认</button>`;
    byId("verifyTotp").onclick = verifyTotp;
  } catch (e) {
    toast(e.message, "err");
  }
}
async function verifyTotp() {
  const code = byId("totpCode").value.trim();
  try {
    const d = await api("/api/totp/verify", {
      method: "POST",
      body: JSON.stringify({ code }),
      noAuthReset: true,
      forceToken: true,
    });
    if (d.session_id && d.expires_at) saveSession(d.session_id, d.expires_at);
    clearPersistedToken();
    toast("已启用", "ok");
    loadTotp();
  } catch (e) {
    toast(e.message, "err");
  }
}
async function disableTotp() {
  if (!confirm("关闭 TOTP？")) return;
  try {
    await api("/api/totp/disable", { method: "POST", body: "{}" });
    toast("已关闭", "ok");
    loadTotp();
  } catch (e) {
    toast(e.message, "err");
  }
}
function openModal() {
  byId("overlay").classList.add("on");
}
function closeModal() {
  byId("overlay").classList.remove("on");
  byId("modal").innerHTML = "";
}
byId("loginBtn").onclick = login;
byId("loginToken").onkeydown = (e) => {
  if (e.key === "Enter") login();
};
byId("loginTotp").onkeydown = (e) => {
  if (e.key === "Enter") verifyLoginTotp();
};
byId("logoutBtn").onclick = () => {
  clearAuth();
  location.reload();
};
byId("nav").onclick = (e) => {
  const a = e.target.closest("a[data-p]");
  if (a) {
    e.preventDefault();
    nav(a.dataset.p);
  }
};
byId("addTargetBtn").onclick = () => targetModal();
byId("addLatencyBtn").onclick = () => latencyNodeModal();
byId("probeBtn").onclick = async () => {
  try {
    const d = await api("/api/probe-now", { method: "POST", body: "{}" });
    toast("完成 " + (d.count ?? 0) + " 个", "ok");
    loadTargets();
  } catch (e) {
    toast(e.message, "err");
  }
};
byId("addPingBtn").onclick = () => pingModal();
byId("uploadThemeBtn").onclick = () => byId("themeZip").click();
byId("themeZip").onchange = () => uploadExtensionPackage("themes", byId("themeZip").files?.[0]);
byId("uploadPluginBtn").onclick = () => byId("pluginZip").click();
byId("pluginZip").onchange = () => uploadExtensionPackage("plugins", byId("pluginZip").files?.[0]);
function handleManagedExtensionClick(event) {
  const button = event.target.closest("button[data-extension-action]");
  if (!button) return;
  const id = button.dataset.extensionId;
  const resource = button.dataset.extensionResource;
  if (button.dataset.extensionAction === "toggle") toggleExtension(resource, id, button.dataset.extensionEnabled === "1");
  if (button.dataset.extensionAction === "delete") removeExtension(resource, id);
}
byId("themeTable").onclick = handleManagedExtensionClick;
byId("pluginTable").onclick = handleManagedExtensionClick;
byId("archiveBtn").onclick = async () => {
  try {
    await api("/api/archive", { method: "POST", body: "{}" });
    toast("归档完成", "ok");
  } catch (e) {
    toast(e.message, "err");
  }
};
byId("syncBtn").onclick = async () => {
  try {
    const d = await api("/api/sync-targets", { method: "POST", body: "{}" });
    toast("同步 " + (d.count ?? 0) + " 个", "ok");
  } catch (e) {
    toast(e.message, "err");
  }
};
byId("overlay").onclick = (e) => {
  if (e.target.closest("[data-close]")) closeModal();
};
byId("overlay").oncontextmenu = (e) => {
  if (e.target === byId("overlay")) e.preventDefault();
};
byId("tTable").onclick = (e) => {
  const b = e.target.closest("button[data-a]");
  if (!b) return;
  const t = targetByAction(b);
  if (b.dataset.a === "edit") targetModal(t);
  if (b.dataset.a === "toggle") toggleTarget(t);
  if (b.dataset.a === "delete") deleteTarget(t);
  if (b.dataset.a === "deploy") deploy(t, b);
  if (b.dataset.a === "move-up") moveTarget(t, -1);
  if (b.dataset.a === "move-down") moveTarget(t, 1);
  if (b.dataset.a === "reload") loadTargets();
};
byId("pTable").onclick = (e) => {
  const b = e.target.closest("button[data-a]");
  if (!b) return;
  const p = pingTargets[Number(b.closest("tr").dataset.i)];
  if (b.dataset.a === "edit") pingModal(p);
  if (b.dataset.a === "toggle") togglePing(p);
  if (b.dataset.a === "delete") deletePing(p);
  if (b.dataset.a === "reload") loadPings();
};
byId("latencyTable").onclick = (e) => {
  const button = e.target.closest("button[data-a]");
  if (!button) return;
  const node = latencyNodes[Number(button.closest("tr")?.dataset.i)];
  if (!node) return;
  if (button.dataset.a === "latency-deploy") deployLatencyNode(node, button);
  if (button.dataset.a === "latency-edit") latencyNodeModal(node);
  if (button.dataset.a === "latency-toggle") toggleLatencyNode(node);
  if (button.dataset.a === "latency-delete") deleteLatencyNode(node);
};
if (adminClient.getToken() || hasSession())
  api("/api/login", { method: "GET", forceToken: Boolean(adminClient.getToken()) })
    .then((d) => {
      if (d.session_valid || !d.totp_required) showApp();
      else showTotpPrompt();
    })
    .catch(() => showLogin());
else showLogin();
