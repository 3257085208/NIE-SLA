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
  groupByOptionsHtml,
  lineTypeOptionsHtml,
  displayGroupName as sharedDisplayGroupName,
} from "./shared/grouping.js";

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
  if (p === "pings") loadPings();
  if (p === "settings") loadSettings();
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

function targetRowHtml(target, index) {
  const status = statusMap.get(target.id) || {};
  const state = targetStatus(status, target);
  const host = targetHostText(target);
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
  const monitorDetails = `<div class="monitoring-stack"><div class="monitoring-item"><span class="monitoring-label">CF</span><div class="status-stack"><div>${statusTag(state.text, state.className)}<strong>${status.latency_ms == null ? "-" : `${Number(status.latency_ms)}ms`}</strong></div><small>${escapeHtml(probeUptime)}</small></div></div><div class="monitoring-item"><span class="monitoring-label">Agent</span>${agentDetails}</div></div>`;
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
      <div class="order-tools">${groupByOptionsHtml(adminGroupBy, "adminGroupBySelect")}<span class="order-state" id="targetOrderState">${targetAdminLoaded ? "已同步" : "读取中"}</span></div>
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
  const sel = byId("adminGroupBySelect");
  if (!sel || sel.dataset.bound) return;
  sel.dataset.bound = "1";
  sel.onchange = () => {
    adminGroupBy = sel.value || "group";
    localStorage.setItem("nstatus.adminGroupBy", adminGroupBy);
    renderTargets();
  };
}

function targetGroupCell(target) {
  const parts = [
    sharedDisplayGroupName(target.group_name),
    target.provider ? `商家:${target.provider}` : "",
    target.location ? `地区:${target.location}` : "",
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

    ${formField("主机", `<input id="mHost" value="${escapeHtml(target.target_host || "")}">`, "ftcp")}
    ${formField("端口", `<input id="mPort" type="number" value="${escapeHtml(target.target_port || "")}">`, "ftcp")}
    ${formField("URL", `<input id="mUrl" value="${escapeHtml(target.url || "")}">`, "fhttp")}
    ${formField("状态码", `<input id="mStatus" value="${escapeHtml(target.expected_status || "200,301,302")}">`, "fhttp")}

    <div class="form-grid">
      ${inputField("标签", "mTags", target.tags || "", 'placeholder="逗号分隔"')}
      ${countryCatalogField(target.location || "")}
      ${searchableCatalogField({
        label: "商家",
        searchId: "mProviderSearch",
        selectId: "mProvider",
        searchPlaceholder: "搜索商家名称",
        options: providerOptionsHtml(target.provider || ""),
      })}
      ${formField("线路类型", `<select id="mLineType">${lineTypeOptionsHtml(target.line_type || "")}</select>`)}
    </div>

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
}

function targetModal(target = null) {
  const isEdit = Boolean(target);
  byId("modal").innerHTML = targetModalHtml(target || {}, isEdit);
  byId("mType").onchange = toggleTargetTypeFields;
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
    tags: byId("mTags")?.value.trim() || "",
    location: byId("mLocation")?.value || "",
    provider: byId("mProvider")?.value || "",
    line_type: byId("mLineType")?.value || "",
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
    if (!b.target_host || !b.target_port) return toast("需要主机和端口", "err");
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
if (adminClient.getToken() || hasSession())
  api("/api/login", { method: "GET", forceToken: Boolean(adminClient.getToken()) })
    .then((d) => {
      if (d.session_valid || !d.totp_required) showApp();
      else showTotpPrompt();
    })
    .catch(() => showLogin());
else showLogin();
