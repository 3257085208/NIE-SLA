import { agentInstallCommandFromPayload, latencyInstallCommandFromPayload, copyText } from "./install-command.js?v=20260803-v1113";
import { createAdminClient } from "./admin/api.js?v=20260803-v1113";
import { latestAgentTaskMaps, shouldOpenNodeQualityReport } from "./admin/task-history.js?v=20260803-v1113";
import { nqOptionsHtml, readNqOptions } from "./admin/nq-options.js?v=20260803-v1113";
import { dailyFleetSlaSeries, targetSlaPercentage } from "./shared/sla.js";
import { bindNodeQualityModal, buildNqModalHtml, normalizeNqReportLink, renderUnlockServicesReportHtml, trimReportAdFooter } from "./shared/nodequality.js?v=20260803-v1113";
import {
  CURRENCIES,
  PROVIDERS,
} from "./shared/target-catalogs.js";
import {
  groupByDimension,
  groupByMenuHtml,
  lineTypeOptionsHtml,
  normalizeGroupByMode,
  displayGroupName as sharedDisplayGroupName,
} from "./shared/grouping.js?v=20260803-v1113";
import { readStorage, writeStorage } from "./shared/storage.js?v=20260803-v1113";

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
  apiAuth,
  apiPublic,
  apiTimeout,
  clearAuth,
  hasSession,
  saveSession,
} = adminClient;
let githubTicket = "";
let appUpdateInfo = null;
let targets = [],
  adminGroupBy = normalizeGroupByMode(readStorage("localStorage", "nstatus.adminGroupBy", "group")),
  statusMap = new Map(),
  latencyNodes = [],
  latencyBuiltin = null,
  pingTargets = [],
  agentTasks = new Map(),
  agentTasksByAction = new Map(),
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
  pingIntervalSec = 20,
  targetOrderSaving = false,
  selectedTargetIds = new Set();
let pendingBulkUpdate = null;
let agentTaskLoadFailures = 0;
let agentTaskLoadWarning = "";
let managedThemes = [];
let toastTimer = 0;
let vpsSlaChart = null;
let modalReturnFocus = null;
let modalCancelHandler = null;
function toast(m, t = "info") {
  const e = byId("toast");
  clearTimeout(toastTimer);
  e.textContent = m;
  e.className = "toast " + t + " show";
  toastTimer = setTimeout(() => e.classList.remove("show"), t === "err" ? 6000 : 3200);
}
function showLogin(message = "", { requireTotp = false, provider = "password" } = {}) {
  byId("loginPage").style.display = "flex";
  byId("app").style.display = "none";
  byId("passwordLoginFields").style.display = provider === "github" ? "none" : "block";
  byId("totpRow").style.display = requireTotp ? "block" : "none";
  byId("loginBtn").textContent = requireTotp ? "验证并登录" : "登录";
  byId("loginMsg").style.display = requireTotp ? "block" : "none";
  byId("loginMsg").textContent = requireTotp
    ? provider === "github" ? "GitHub 已验证，请输入 TOTP 验证码" : "需要 TOTP 验证码"
    : "";
  if (message) {
    byId("loginErr").textContent = message;
    byId("loginErr").style.display = "block";
  } else {
    byId("loginErr").style.display = "none";
  }
}

function showTotpPrompt(message = "需要 TOTP 验证码", provider = "password") {
  showLogin("", { requireTotp: true, provider });
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
function isStatusStale() {
  return false;
}

function configuredChartColor(value, fallback) {
  const color = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : fallback;
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
  const code = byId("loginTotp").value.trim();
  if (byId("totpRow").style.display !== "none" && !/^\d{6}$/.test(code)) {
    toast("请输入 6 位验证码", "err");
    return;
  }
  byId("loginBtn").disabled = true;
  byId("loginErr").style.display = "none";
  byId("loginMsg").style.display = "block";
  byId("loginMsg").textContent = githubTicket ? "验证 GitHub 登录..." : "验证账号...";
  try {
    const d = githubTicket
      ? await apiAuth("/api/auth/github/complete", {
          method: "POST",
          body: JSON.stringify({ ticket: githubTicket, totp: code }),
        })
      : await passwordLogin(code);
    if (d.totp_required) {
      showTotpPrompt(undefined, githubTicket ? "github" : "password");
      return;
    }
    if (!d.session_id || !d.session_expires_at) throw new Error("登录响应缺少会话");
    saveSession(d.session_id, d.session_expires_at);
    githubTicket = "";
    byId("loginPassword").value = "";
    byId("loginTotp").value = "";
    showApp();
  } catch (e) {
    byId("loginErr").textContent = e.message;
    byId("loginErr").style.display = "block";
  } finally {
    byId("loginBtn").disabled = false;
  }
}
async function passwordLogin(totp) {
  const username = byId("loginUsername").value.trim();
  const password = byId("loginPassword").value;
  if (!username || !password) throw new Error("请输入账号和密码");
  return apiAuth("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password, totp }),
  });
}
async function loadAuthConfig() {
  try {
    const config = await apiPublic("/api/auth/config");
    byId("githubLoginWrap").hidden = !config.github_enabled;
  } catch (_) {
    byId("githubLoginWrap").hidden = true;
  }
}
async function completeGitHubRedirect() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const ticket = params.get("github_ticket") || "";
  const error = params.get("github_error") || "";
  if (!ticket && !error) return false;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  if (error) {
    showLogin(error);
    return true;
  }
  githubTicket = ticket;
  showLogin("", { provider: "github" });
  await login();
  return true;
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
  if (p === "settings") loadSettings();
}

async function loadThemes() {
  loading("themeTable");
  try {
    const data = await apiAdmin("/api/themes/manage", {}, 20_000);
    managedThemes = Array.isArray(data.themes) ? data.themes : [];
    if (!managedThemes.length) {
      byId("themeTable").innerHTML = `<div class="theme-empty"><strong>尚未安装第三方主题</strong><span>上传符合规范的 ZIP 后，可在这里检查信息并手动启用。</span></div>`;
      return;
    }
    byId("themeTable").innerHTML = `<div class="theme-grid">${managedThemes.map(themeCardHtml).join("")}</div>`;
  } catch (error) {
    managedThemes = [];
    errBox("themeTable", error);
  }
}

function themeCardHtml(theme) {
  const mode = theme.mode === "canvas" ? "交互画布" : "CSS 样式";
  const digest = String(theme.package_sha256 || "");
  const uploadedAt = Number(theme.uploaded_at || 0);
  return `<article class="theme-card${theme.enabled ? " active" : ""}">
    <div class="theme-card-head">
      <div><span>${escapeHtml(mode)}</span><h3>${escapeHtml(theme.name || theme.id)}</h3></div>
      <em>${theme.enabled ? "正在使用" : "未启用"}</em>
    </div>
    <p>${escapeHtml(theme.description || "作者未提供主题说明。")}</p>
    <dl>
      <div><dt>ID</dt><dd><code>${escapeHtml(theme.id)}</code></dd></div>
      <div><dt>版本</dt><dd>${escapeHtml(theme.version || "-")}</dd></div>
      <div><dt>作者</dt><dd>${escapeHtml(theme.author || "未署名")}</dd></div>
      <div><dt>许可</dt><dd>${escapeHtml(theme.license || "未声明")}</dd></div>
      <div><dt>上传</dt><dd>${uploadedAt ? escapeHtml(formatDateTime(uploadedAt)) : "旧版导入"}</dd></div>
      <div><dt>SHA-256</dt><dd><code title="${escapeHtml(digest)}">${escapeHtml(digest ? `${digest.slice(0, 16)}...` : "未记录")}</code></dd></div>
    </dl>
    <div class="theme-card-actions">
      <button class="btn btn-sm ${theme.enabled ? "" : "btn-primary"}" type="button" data-theme-action="toggle" data-theme-id="${escapeHtml(theme.id)}">${theme.enabled ? "停用并恢复原版" : "启用主题"}</button>
      <button class="btn btn-sm btn-danger" type="button" data-theme-action="delete" data-theme-id="${escapeHtml(theme.id)}">删除</button>
    </div>
  </article>`;
}

async function uploadThemePackage(file) {
  if (!file) return;
  const input = byId("themeZip");
  const button = byId("uploadThemeBtn");
  if (!file.name.toLowerCase().endsWith(".zip")) {
    input.value = "";
    return toast("请选择 ZIP 主题包", "err");
  }
  if (!file.size || file.size > 8 * 1024 * 1024) {
    input.value = "";
    return toast("主题 ZIP 必须小于 8 MB", "err");
  }
  button.disabled = true;
  button.textContent = "正在校验并上传...";
  try {
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    const result = await apiAdmin("/api/themes/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "x-theme-sha256": sha256,
      },
      body: file,
    }, 60_000);
    toast(`已安装 ${result.theme?.name || file.name}，主题默认保持停用`, "ok");
    await loadThemes();
  } catch (error) {
    toast(error.message, "err");
  } finally {
    input.value = "";
    button.disabled = false;
    button.textContent = "上传主题 ZIP";
  }
}

function confirmThemeAction(theme, action) {
  const isDelete = action === "delete";
  const enabling = !isDelete && !theme.enabled;
  const title = isDelete ? "删除第三方主题" : (enabling ? "启用第三方主题" : "恢复原版主题");
  const detail = isDelete
    ? "主题记录及其 R2 文件将被永久删除；如果它正在使用，公开页会恢复原版。"
    : enabling
      ? "启用后会替换当前主题。第三方主题来自独立开发者，请确认来源和 SHA-256 后继续。"
      : "停用后公开状态页将在下次刷新时恢复 NIE-SLA 原版界面。";
  byId("modal").className = "modal theme-confirm-modal";
  byId("modal").innerHTML = `<div class="theme-confirm-head"><span>THIRD-PARTY THEME</span><h3>${title}</h3></div>
    <p class="theme-confirm-name">${escapeHtml(theme.name || theme.id)} <code>${escapeHtml(theme.version || "")}</code></p>
    <p class="hint">${detail}</p>
    <div class="ma"><button class="btn" type="button" data-close>取消</button><button class="btn ${isDelete ? "btn-danger" : "btn-primary"}" type="button" id="confirmThemeAction">${isDelete ? "确认删除" : "确认"}</button></div>`;
  byId("confirmThemeAction").onclick = () => applyThemeAction(theme, action);
  openModal();
}

async function applyThemeAction(theme, action) {
  const button = byId("confirmThemeAction");
  button.disabled = true;
  button.textContent = action === "delete" ? "正在删除..." : "正在应用...";
  try {
    if (action === "delete") {
      await apiAdmin(`/api/themes/${encodeURIComponent(theme.id)}`, { method: "DELETE" }, 30_000);
      toast("主题已删除", "ok");
    } else {
      await apiAdmin(`/api/themes/${encodeURIComponent(theme.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !theme.enabled }),
      }, 30_000);
      toast(theme.enabled ? "已恢复原版主题" : "第三方主题已启用", "ok");
    }
    closeModal();
    await loadThemes();
  } catch (error) {
    button.disabled = false;
    button.textContent = action === "delete" ? "确认删除" : "重试";
    toast(error.message, "err");
  }
}
async function loadDash() {
  loading("dStats");
  loading("dVpsSla");
  try {
    const d = await api("/api/status?days=30");
    renderStats(d);
    renderIncidents(d.incidents || []);
    renderVpsSla(d);
  } catch (e) {
    errBox("dStats", e);
    errBox("dVpsSla", e);
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
function renderVpsSla(data) {
  const days = data.days || [];
  const summaries = new Map(
    (data.summaries || []).map((summary) => [`${summary.target_id}:${summary.day}`, summary]),
  );
  const rows = (data.targets || [])
    .filter((target) => target.type === "tcp")
    .map((target) => ({
      target,
      sla: targetSlaPercentage(target.id, days, summaries),
    }))
    .sort((a, b) => {
      if (a.sla == null && b.sla != null) return 1;
      if (a.sla != null && b.sla == null) return -1;
      if (a.sla !== b.sla) return Number(b.sla) - Number(a.sla);
      return String(a.target.name || "").localeCompare(String(b.target.name || ""), "zh-CN");
    });

  if (!rows.length) {
    byId("dVpsSla").innerHTML = '<div class="empty">暂无 VPS</div>';
    return;
  }

  const measured = rows.filter((row) => row.sla != null);
  const fleetSla = measured.length
    ? measured.reduce((sum, row) => sum + row.sla, 0) / measured.length
    : null;
  const healthyCount = measured.filter((row) => row.sla >= 99).length;
  const warningCount = measured.filter((row) => row.sla < 99).length;
  const fleetClass = slaClassName(fleetSla);
  const dailySeries = dailyFleetSlaSeries(rows.map((row) => row.target.id), days, summaries);
  byId("dVpsSla").innerHTML = `
    <div class="vps-sla-summary">
      <div class="vps-sla-total ${fleetClass}"><strong>${fleetSla == null ? "-" : `${fleetSla.toFixed(3)}%`}</strong><span>整体 SLA</span></div>
      <div><strong>${measured.length}</strong><span>已统计 / ${rows.length} 台</span></div>
      <div><strong>${healthyCount}</strong><span>达到 99%</span></div>
      <div class="${warningCount ? "is-warning" : ""}"><strong>${warningCount}</strong><span>低于 99%</span></div>
    </div>
    <div class="vps-sla-chart-block">
      <div class="vps-sla-chart-head"><strong>每日整体 SLA</strong><span>虚线为 99% 参考值</span></div>
      <div class="vps-sla-chart-wrap"><canvas id="vpsSlaChart" role="img" aria-label="最近 30 天每日整体 SLA 趋势"></canvas></div>
    </div>
    <div class="vps-sla-list">
      ${rows.map(({ target, sla }) => {
        const currentOnline = target.status_source === "agent"
          ? target.agent_online === true
          : Number(target.ok) === 1;
        const currentKnown = target.status_source === "agent"
          ? target.agent_online != null
          : target.checked_at != null;
        const currentClass = !currentKnown ? "unknown" : currentOnline ? "online" : "offline";
        const currentLabel = !currentKnown ? "待检查" : currentOnline ? "当前在线" : "当前离线";
        return `<div class="vps-sla-item">
          <span class="vps-sla-state ${currentClass}" title="${currentLabel}"></span>
          <strong title="${escapeHtml(target.name)}">${escapeHtml(target.name)}</strong>
          <span class="vps-sla-value ${slaClassName(sla)}">${sla == null ? "暂无数据" : `${sla.toFixed(2)}%`}</span>
        </div>`;
      }).join("")}
    </div>`;
  renderVpsSlaChart(dailySeries);
}

function renderVpsSlaChart(series) {
  vpsSlaChart?.destroy();
  vpsSlaChart = null;
  const canvas = byId("vpsSlaChart");
  if (!canvas || typeof window.Chart !== "function") return;
  const measured = series.map((point) => point.value).filter((value) => value != null);
  const minimum = measured.length ? Math.max(0, Math.floor(Math.min(...measured) - 3)) : 0;
  const context = canvas.getContext("2d");
  const fill = context.createLinearGradient(0, 0, 0, 190);
  fill.addColorStop(0, "rgba(21, 151, 84, .22)");
  fill.addColorStop(1, "rgba(21, 151, 84, .015)");
  vpsSlaChart = new window.Chart(context, {
    type: "line",
    data: {
      labels: series.map((point) => String(point.day || "").slice(5)),
      datasets: [
        {
          label: "整体 SLA",
          data: series.map((point) => point.value),
          borderColor: "#159754",
          backgroundColor: fill,
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 4,
          pointBackgroundColor: "#ffffff",
          pointBorderColor: "#159754",
          tension: .28,
          fill: true,
          spanGaps: false,
        },
        {
          label: "99% 参考值",
          data: series.map(() => 99),
          borderColor: "rgba(194, 65, 58, .62)",
          borderWidth: 1,
          borderDash: [5, 5],
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 280 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => items.length ? series[items[0].dataIndex]?.day || "" : "",
            label: (item) => item.datasetIndex === 0 && item.raw != null ? `整体 SLA：${Number(item.raw).toFixed(2)}%` : "99% 参考值",
            afterLabel: (item) => item.datasetIndex === 0 ? `统计节点：${series[item.dataIndex]?.target_count || 0} 台` : "",
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#728096", maxTicksLimit: 10, font: { size: 10 } } },
        y: {
          min: minimum,
          max: 100,
          grid: { color: "rgba(203, 213, 225, .55)" },
          ticks: { color: "#728096", maxTicksLimit: 5, callback: (value) => `${value}%`, font: { size: 10 } },
        },
      },
    },
  });
}

function slaClassName(value) {
  if (value == null) return "sla-unknown";
  if (value >= 99) return "sla-good";
  if (value >= 95) return "sla-warn";
  return "sla-bad";
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
    percent = tr.percent == null ? null : Number(tr.percent),
    resetDay = Number(tr.reset_day);
  const percentText = percent != null && Number.isFinite(percent) ? ` · ${percent}%` : "";
  const reset = Number.isInteger(resetDay) && resetDay >= 1 && resetDay <= 31 ? ` · ${resetDay}日重置` : "";
  return `<span class="tag tag-on">已启用</span><br><small class="hint">${escapeHtml(formatBytes(total))}${quota ? " / " + escapeHtml(formatBytes(quota)) : ""}${escapeHtml(percentText)}${escapeHtml(reset)}</small>`;
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
    await loadAgentTasks(false);
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

function betaTaskControlsHtml(target) {
  if (target.type !== "tcp" || !targetAdminLoaded) return "";
  const actionTasks = ["nodequality", "ip_unlock"]
    .map((action) => agentTasksByAction.get(`${target.id}:${action}`))
    .filter(Boolean);
  const active = actionTasks.some((task) => ["queued", "running"].includes(task.status));
  const runtime = target.agent_runtime || {};
  const capabilities = runtime.capabilities || {};
  const actions = new Set(Array.isArray(capabilities.actions) ? capabilities.actions : []);
  const nqAvailable = actions.has("nodequality");
  const unlockAvailable = actions.has("ip_unlock");
  const managerState = capabilities.mode === "manager"
    ? "Manager 已接管"
    : capabilities.mode === "compatibility"
      ? "兼容模式，仅 IP 解锁"
      : runtime.last_metrics_at
        ? "等待 Agent 自动更新"
        : "Agent 尚未上报";
  const nqTask = agentTasksByAction.get(`${target.id}:nodequality`);
  const reportUrl = target.nq_url || nqTask?.result?.report_url || "";
  const taskStates = actionTasks.map((task) => {
    const queuedTooLong = task.status === "queued"
      && Number(task.requested_at || 0) > 0
      && nowSec() - Number(task.requested_at) >= 120;
    const cancelling = task.status === "running" && Number(task.cancel_requested_at || 0) > 0;
    const state = {
      queued: queuedTooLong ? "排队超过 2 分钟，请检查 Manager 状态" : "排队中",
      running: cancelling ? "停止中" : "运行中",
      succeeded: "已完成",
      failed: "失败",
      expired: "已过期",
      cancelled: "已取消",
    }[task.status] || task.status;
    const stopButton = ["queued", "running"].includes(task.status)
      ? `<button type="button" class="btn btn-xs btn-danger" data-a="task-cancel" data-task-id="${escapeHtml(task.id)}"${cancelling ? " disabled" : ""} title="强制停止任务，Agent 会终止脚本进程组">${cancelling ? "停止中" : "强制停止"}</button>`
      : "";
    return `<span class="task-state-wrap"><button type="button" class="task-state task-${escapeHtml(task.status)}" data-a="task-details" data-task-action="${escapeHtml(task.action)}" title="查看任务详情">${escapeHtml(task.action_label || "任务")} · ${escapeHtml(state)}</button>${stopButton}</span>`;
  }).join("");
  return `<div class="beta-task-actions">
    <div class="beta-task-meta">
      <span class="beta-label">Beta 功能</span>
      <small class="task-mode" title="Agent ${escapeHtml(runtime.agent_version || "未知版本")}">${escapeHtml(managerState)}</small>
    </div>
    <div class="beta-task-buttons">
      <button type="button" class="btn btn-xs" data-a="task-nq"${active || !nqAvailable ? " disabled" : ""} title="${escapeHtml(nqAvailable ? "运行固定 NodeQuality 任务" : "此 Agent 尚未上报 NQ 能力")}">运行 NQ</button>
      <button type="button" class="btn btn-xs" data-a="task-unlock"${active || !unlockAvailable ? " disabled" : ""} title="${escapeHtml(unlockAvailable ? "运行固定 IP 解锁任务" : "此 Agent 尚未上报 IP 解锁能力")}">IP 解锁</button>
      ${reportUrl ? `<a class="btn btn-xs btn-blue" href="${escapeHtml(reportUrl)}" target="_blank" rel="noopener noreferrer">NQ 报告</a>` : ""}
    </div>
    ${taskStates}
  </div>`;
}

function showAgentTaskDiagnostic(target, task, loadError = "") {
  const resultText = task.result ? JSON.stringify(task.result, null, 2) : "";
  const imageUpload = task.action === "nodequality" ? task.result?.image_upload : null;
  const imageUploadNotice = imageUpload && (!imageUpload.uploaded || imageUpload.errors?.length)
    ? `<div class="task-detail-error">NQ 图片未完成生成：${escapeHtml(imageUpload.errors?.join("；") || (imageUpload.reason === "image_service_unavailable" ? "公益 NQ 图片服务暂时不可用，请稍后重试。" : "没有生成网络质量/回程路由图片。"))}</div>`
    : "";
  const cancelling = task.status === "running" && Number(task.cancel_requested_at || 0) > 0;
  const statusLabel = {
    queued: "排队中",
    running: cancelling ? "停止中" : "运行中",
    succeeded: "已完成",
    failed: "失败",
    expired: "已过期",
    cancelled: "已取消",
  }[task.status] || task.status || "未知";
  byId("modal").className = "modal task-details-modal";
  byId("modal").innerHTML = `
    <h3>${escapeHtml(task.action_label || "Agent 任务")}</h3>
    <div class="task-detail-grid">
      <span>VPS</span><strong>${escapeHtml(target.name)}</strong>
      <span>状态</span><strong>${escapeHtml(statusLabel)}</strong>
      <span>Agent</span><strong>${escapeHtml(task.agent_version || "-")}</strong>
    </div>
    ${loadError ? `<div class="task-detail-error">报告加载失败：${escapeHtml(loadError)}</div>` : ""}
    ${task.error ? `<div class="task-detail-error">${escapeHtml(task.error)}</div>` : ""}
    ${imageUploadNotice}
    ${task.output_excerpt ? `<h4>输出摘要</h4><pre class="task-detail-output">${escapeHtml(task.output_excerpt)}</pre>` : ""}
    ${resultText ? `<h4>任务结果</h4><pre class="task-detail-output">${escapeHtml(resultText)}</pre>` : ""}
    <div class="ma">${["queued", "running"].includes(task.status) ? `<button type="button" class="btn btn-danger" id="forceStopTask"${cancelling ? " disabled" : ""}>${cancelling ? "停止中" : "强制停止"}</button>` : ""}<button type="button" class="btn" data-close>关闭</button></div>`;
  openModal();
  const stopButton = byId("forceStopTask");
  if (stopButton) {
    stopButton.onclick = async () => {
      stopButton.disabled = true;
      stopButton.textContent = "停止中...";
      await forceStopAgentTask(task.id);
      showAgentTaskDetails(target, task.action);
    };
  }
}

function closeAdminNodeQualityReport() {
  const root = document.querySelector('.nq-modal-root[data-admin-nq-report]');
  const returnFocus = root?.returnFocus;
  root?.remove();
  document.body.classList.remove("nq-modal-open");
  if (returnFocus?.isConnected && typeof returnFocus.focus === "function") returnFocus.focus();
}

async function showNodeQualityReport(target, task) {
  closeModal();
  closeAdminNodeQualityReport();
  const root = document.createElement("div");
  root.className = "nq-modal-root";
  root.dataset.adminNqReport = "";
  root.returnFocus = document.activeElement;
  root.innerHTML = `<div class="nq-modal-backdrop"><div class="nq-modal nq-modal-loading" role="dialog" aria-modal="true" aria-label="NodeQuality 报告"><div class="nq-modal-head"><div><strong>NodeQuality</strong><span>${escapeHtml(target.name)}</span></div><button type="button" class="nq-close" data-nq-close aria-label="关闭">×</button></div><div class="nq-loading">正在加载完整报告...</div></div></div>`;
  document.body.appendChild(root);
  document.body.classList.add("nq-modal-open");
  bindNodeQualityModal(root);
  root.addEventListener("click", (event) => {
    if (event.target.closest(".nq-close") || event.target.classList.contains("nq-modal-backdrop")) closeAdminNodeQualityReport();
  });
  try {
    const report = await apiPublic(`/api/nq/${encodeURIComponent(target.id)}`);
    if (!root.isConnected) return;
    report.name ||= target.name;
    root.innerHTML = buildNqModalHtml(report);
    bindNodeQualityModal(root);
  } catch (error) {
    if (!root.isConnected) return;
    const reportLink = normalizeNqReportLink(task?.result?.report_url);
    root.innerHTML = `<div class="nq-modal-backdrop"><div class="nq-modal" role="dialog" aria-modal="true" aria-label="NodeQuality 报告"><div class="nq-modal-head"><div><strong>NodeQuality</strong><span>${escapeHtml(target.name)}</span></div><button type="button" class="nq-close" data-nq-close aria-label="关闭">×</button></div><div class="nq-empty">报告加载失败：${escapeHtml(error.message || "未知错误")}<br>这条任务没有可展示的完整报告，请重新运行 NQ。${reportLink ? `<br><a href="${escapeHtml(reportLink)}" target="_blank" rel="noopener noreferrer">打开原报告</a>` : ""}</div></div></div>`;
    bindNodeQualityModal(root);
  }
}

function showIpUnlockTaskReport(target, task) {
  closeModal();
  closeAdminNodeQualityReport();
  const root = document.createElement("div");
  root.className = "nq-modal-root";
  root.dataset.adminNqReport = "";
  root.returnFocus = document.activeElement;
  const statusLabel = ({
    succeeded: "已完成",
    failed: "失败",
    queued: "排队中",
    running: task.status === "running" && Number(task.cancel_requested_at || 0) > 0 ? "停止中" : "运行中",
    expired: "已过期",
    cancelled: "已取消",
  }[task.status] || task.status || "未知");
  const report = {
    name: target.name,
    report_time: `${statusLabel} · ${task.finished_at ? formatDateTime(task.finished_at) : "尚未完成"}`,
    tabs: [{ id: "ip", title: "IP质量", content: "" }],
  };
  const reportText = typeof task?.result?.report === "string" && task.result.report.trim() ? trimReportAdFooter(task.result.report) : "";
  if (reportText) {
    report.tabs[0].content = reportText;
  } else {
    const services = Array.isArray(task?.result?.services) ? task.result.services : [];
    const servicesHtml = renderUnlockServicesReportHtml(services);
    report.tabs[0].content = "";
  }
  root.innerHTML = buildNqModalHtml(report, { title: "IP 解锁" });
  const panel = root.querySelector('.nq-panel[data-nq-panel="ip"]');
  if (panel) {
    if (!reportText) {
      const services = Array.isArray(task?.result?.services) ? task.result.services : [];
      panel.innerHTML = renderUnlockServicesReportHtml(services) || '<div class="nq-empty">未解析到可显示的 IPv4 解锁服务</div>';
    }
    const cancelling = task.status === "running" && Number(task.cancel_requested_at || 0) > 0;
    const notices = [];
    if (task.error) notices.push(`<div class="task-detail-error">${escapeHtml(task.error)}</div>`);
    if (task.output_excerpt) notices.push(`<details class="ip-unlock-raw"><summary>原始输出</summary><pre class="task-detail-output">${escapeHtml(task.output_excerpt)}</pre></details>`);
    if (["queued", "running"].includes(task.status)) notices.push(`<button type="button" class="btn btn-danger" data-ip-unlock-force-stop${cancelling ? " disabled" : ""}>${cancelling ? "停止中" : "强制停止"}</button>`);
    panel.insertAdjacentHTML("beforeend", notices.join(""));
  }
  document.body.appendChild(root);
  document.body.classList.add("nq-modal-open");
  bindNodeQualityModal(root);
  root.addEventListener("click", (event) => {
    const forceStop = event.target.closest("[data-ip-unlock-force-stop]");
    if (forceStop) {
      forceStop.disabled = true;
      forceStop.textContent = "停止中...";
      void forceStopAgentTask(task.id).then(() => showAgentTaskDetails(target, task.action));
      return;
    }
    if (event.target.closest(".nq-close") || event.target.classList.contains("nq-modal-backdrop")) closeAdminNodeQualityReport();
  });
}

function showAgentTaskDetails(target, action = "") {
  const task = action
    ? agentTasksByAction.get(`${target.id}:${action}`)
    : agentTasks.get(target.id);
  if (!task) return toast("暂无任务详情", "err");
  if (shouldOpenNodeQualityReport(task)) {
    void showNodeQualityReport(target, task);
    return;
  }
  if (task.action === "ip_unlock") {
    showIpUnlockTaskReport(target, task);
    return;
  }
  showAgentTaskDiagnostic(target, task);
}

async function loadAgentTasks(render = true) {
  if (!hasSession()) return;
  try {
    const data = await api("/api/agent-tasks?limit=100");
    const latest = latestAgentTaskMaps(data.tasks);
    agentTasks = latest.byAgent;
    agentTasksByAction = latest.byAction;
    const onTargetsPage = render && byId("pg-targets")?.classList.contains("on");
    if (agentTaskLoadFailures || agentTaskLoadWarning) {
      agentTaskLoadFailures = 0;
      agentTaskLoadWarning = "";
    }
    if (onTargetsPage) renderTargets();
  } catch (error) {
    agentTaskLoadFailures += 1;
    if (agentTaskLoadFailures >= 2 && targets.length && byId("pg-targets")?.classList.contains("on")) {
      agentTaskLoadWarning = `任务状态刷新失败：${error.message || "未知错误"}，正在自动重试。`;
      renderTargets();
    }
  }
}

function runAgentTask(target, action) {
  const label = action === "nodequality" ? "NodeQuality" : "IP 解锁";
  const detail = action === "nodequality"
    ? "Agent 将运行固定的 NodeQuality 官方脚本，通常需要数分钟，可能需要较高系统权限。"
    : "Agent 将运行固定的 IP.Check.Place 脚本，只保存 IPv4 解锁结果，不保存纯净度。";
  byId("modal").className = "modal task-confirm-modal";
  byId("modal").innerHTML = `
    <h3>运行 ${escapeHtml(label)}</h3>
    <p class="task-confirm-target">${escapeHtml(target.name)}</p>
    <p class="hint">${escapeHtml(detail)}</p>
    ${action === "nodequality" ? nqOptionsHtml() : ""}
    <div class="bulk-target-warning">Beta 功能只会运行内置固定脚本，提交后可在当前列表查看执行状态。</div>
    <div class="ma"><button type="button" class="btn" data-close>取消</button><button type="button" class="btn btn-primary" id="confirmAgentTask">确认运行</button></div>`;
  byId("confirmAgentTask").onclick = () => queueAgentTask(target, action, label);
  openModal();
}

async function queueAgentTask(target, action, label) {
  const button = byId("confirmAgentTask");
  if (button) {
    button.disabled = true;
    button.textContent = "提交中...";
  }
  try {
    await apiAdmin("/api/agent-tasks", {
      method: "POST",
      body: JSON.stringify({ agent_id: target.id, action, options: action === "nodequality" ? readNqOptions(byId("modal")) : undefined }),
    }, 30000);
    closeModal();
    toast(`${label} 已排队，Agent 最多约 5 分钟内领取`, "ok");
    await loadAgentTasks();
  } catch (error) {
    toast(error.message, "err");
    if (button && document.body.contains(button)) {
      button.disabled = false;
      button.textContent = "确认运行";
    }
    try { await loadAgentTasks(); } catch (_) {}
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
    `<div class="actions target-actions"><div class="target-action-main">${isWeb ? "" : `<button type="button" class="btn btn-xs btn-deploy" data-a="deploy" data-target-id="${escapeHtml(target.id)}">部署 Agent</button>`}${targetActionsHtml(target)}</div>${isWeb ? "" : betaTaskControlsHtml(target)}</div>`,
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

  const currentVpsIds = new Set(targets.filter(target => target.type === "tcp").map(target => target.id));
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
    ${targetBulkBarHtml(currentVpsIds.size)}
    ${agentTaskLoadWarning ? `<div class="task-load-warning" role="status">${escapeHtml(agentTaskLoadWarning)}</div>` : ""}
    <div class="target-order-bar${targetAdminLoaded && currentVpsIds.size ? " has-bulk" : ""}">
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
  bindTargetBulkControls();
}

function targetBulkBarHtml(vpsCount) {
  if (!targetAdminLoaded || !vpsCount) return "";
  return `<div class="target-bulk-bar">
    <div><strong>批量管理</strong><span class="target-bulk-count">可一次修改多台 VPS 的商家、到期时间、费用、流量与报警设置</span></div>
    <div class="target-bulk-actions"><button type="button" class="btn btn-sm btn-primary" id="editBulkTargets">批量设置</button><button type="button" class="btn btn-sm" id="runBulkNq">批量运行 NQ</button><button type="button" class="btn btn-sm" id="runBulkUnlock">批量 IP 解锁</button></div>
  </div>`;
}

function bindTargetBulkControls() {
  if (byId("editBulkTargets")) byId("editBulkTargets").onclick = () => openBulkTargetPicker();
  if (byId("runBulkNq")) byId("runBulkNq").onclick = () => openBulkTargetPicker(false, () => bulkTaskModal("nodequality"), 50);
  if (byId("runBulkUnlock")) byId("runBulkUnlock").onclick = () => openBulkTargetPicker(false, () => bulkTaskModal("ip_unlock"), 50);
}

function bulkTargetSelectionLimit() {
  const limit = Number(byId("modal")?.dataset.bulkSelectionLimit || 0);
  return Number.isInteger(limit) && limit > 0 ? limit : Infinity;
}

function refreshBulkTargetPicker() {
  const boxes = [...byId("modal").querySelectorAll("[data-bulk-target]")];
  const selectedCount = selectedTargetIds.size;
  const selectionLimit = bulkTargetSelectionLimit();
  const visible = boxes.filter(box => !box.closest(".bulk-target-option")?.hidden);
  const selectAll = byId("bulkPickerSelectAll");
  if (selectAll) {
    const selectedVisible = visible.filter(box => box.checked).length;
    selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  }
  if (byId("bulkPickerCount")) byId("bulkPickerCount").textContent = `已选 ${selectedCount}${Number.isFinite(selectionLimit) ? ` / ${selectionLimit}` : ""} 台`;
  if (byId("nextBulkTargets")) byId("nextBulkTargets").disabled = selectedCount === 0;
}

function openBulkTargetPicker(preserveSelection = false, next = bulkTargetModal, selectionLimit = Infinity) {
  const vpsTargets = targets.filter(target => target.type === "tcp");
  if (!preserveSelection) selectedTargetIds = new Set();
  pendingBulkUpdate = null;
  byId("modal").className = "modal bulk-target-picker-modal";
  byId("modal").dataset.bulkSelectionLimit = Number.isFinite(selectionLimit) ? String(selectionLimit) : "";
  byId("modal").innerHTML = `
    <h3>选择 VPS</h3>
    <div class="bulk-picker-tools"><input id="bulkTargetSearch" type="search" placeholder="搜索名称、ID、商家或地区" autocomplete="off"><label class="target-select-all"><input type="checkbox" id="bulkPickerSelectAll"><span>选择当前结果</span></label></div>
    <div class="bulk-target-picker-list">${vpsTargets.map(target => `<label class="bulk-target-option" data-search="${escapeHtml([target.name, target.id, target.provider, target.location, target.city].filter(Boolean).join(" ").toLowerCase())}"><input type="checkbox" data-bulk-target="${escapeHtml(target.id)}"${checkedAttr(selectedTargetIds.has(target.id))}><span><strong>${escapeHtml(target.name)}</strong><small>${escapeHtml([target.provider, target.location, target.city].filter(Boolean).join(" · ") || target.id)}</small></span></label>`).join("")}</div>
    <div class="ma"><span class="bulk-picker-count" id="bulkPickerCount">已选 0 台</span><button type="button" class="btn" data-close>取消</button><button type="button" class="btn btn-primary" id="nextBulkTargets" disabled>下一步</button></div>`;
  const boxes = [...byId("modal").querySelectorAll("[data-bulk-target]")];
  for (const box of boxes) box.onchange = () => {
    if (box.checked && !selectedTargetIds.has(box.dataset.bulkTarget) && selectedTargetIds.size >= bulkTargetSelectionLimit()) {
      box.checked = false;
      toast(`一次最多选择 ${bulkTargetSelectionLimit()} 台 VPS`, "err");
    } else if (box.checked) selectedTargetIds.add(box.dataset.bulkTarget);
    else selectedTargetIds.delete(box.dataset.bulkTarget);
    refreshBulkTargetPicker();
  };
  byId("bulkTargetSearch").oninput = event => {
    const query = event.target.value.trim().toLowerCase();
    for (const option of byId("modal").querySelectorAll(".bulk-target-option")) {
      const haystack = `${option.dataset.search || ""} ${option.textContent || ""}`.toLowerCase();
      option.hidden = Boolean(query && !haystack.includes(query));
    }
    refreshBulkTargetPicker();
  };
  byId("bulkPickerSelectAll").onchange = event => {
    for (const box of boxes) {
      if (box.closest(".bulk-target-option")?.hidden) continue;
      if (event.target.checked && !box.checked && selectedTargetIds.size >= bulkTargetSelectionLimit()) continue;
      box.checked = event.target.checked;
      if (box.checked) selectedTargetIds.add(box.dataset.bulkTarget);
      else selectedTargetIds.delete(box.dataset.bulkTarget);
    }
    refreshBulkTargetPicker();
  };
  byId("nextBulkTargets").onclick = next;
  refreshBulkTargetPicker();
  openModal();
}

function bulkTaskModal(action) {
  const selected = targets.filter((target) => target.type === "tcp" && selectedTargetIds.has(target.id));
  if (!selected.length) return toast("请选择至少一台 VPS", "err");
  const label = action === "nodequality" ? "NodeQuality" : "IP 解锁";
  byId("modal").className = "modal bulk-confirm-modal";
  byId("modal").innerHTML = `<h3>批量运行 ${escapeHtml(label)}</h3><p>将向 <strong>${selected.length}</strong> 台在线 VPS 排队提交任务；离线、能力不匹配或已有任务的 VPS 会单独返回原因。</p><div class="bulk-confirm-targets">${selected.slice(0, 14).map((target) => `<span>${escapeHtml(target.name)}</span>`).join("")}${selected.length > 14 ? `<span>另 ${selected.length - 14} 台</span>` : ""}</div>${action === "nodequality" ? nqOptionsHtml() : ""}<div class="bulk-target-warning">每台 VPS 仍保持单任务互斥，任务会在各 Agent 独立执行。</div><div class="ma"><button type="button" class="btn" data-close>取消</button><button type="button" class="btn btn-primary" id="confirmBulkTask">确认排队</button></div>`;
  byId("confirmBulkTask").onclick = () => queueBulkAgentTasks(selected.map((target) => target.id), action, label);
}

async function queueBulkAgentTasks(ids, action, label) {
  const options = action === "nodequality" ? readNqOptions(byId("modal")) : undefined;
  const count = ids.length;
  selectedTargetIds.clear();
  closeModal();
  toast(`正在为 ${count} 台 VPS 排队...`, "info");
  try {
    const result = await apiAdmin("/api/agent-tasks", { method: "POST", body: JSON.stringify({ agent_ids: ids, action, options }) }, 60000);
    const rejected = Array.isArray(result.rejected) ? result.rejected.length : 0;
    toast(`已排队 ${result.created?.length || 0} 台${rejected ? `，${rejected} 台未提交` : ""}`, rejected && !result.created?.length ? "err" : "ok");
    try { await loadAgentTasks(); } catch (_) {}
  } catch (error) {
    toast(error.message, "err");
    try { await loadAgentTasks(); } catch (_) {}
  }
}

async function forceStopAgentTask(taskId) {
  try {
    await apiAdmin(`/api/agent-tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" }, 15000);
    toast("已提交强制停止，Agent 检测到后会自动终止脚本", "ok");
    await loadAgentTasks();
  } catch (error) {
    toast(error.message, "err");
    try { await loadAgentTasks(); } catch (_) {}
  }
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
    adminGroupBy = normalizeGroupByMode(value);
    writeStorage("localStorage", "nstatus.adminGroupBy", adminGroupBy);
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
    target.line_type ? `机器:${target.line_type}` : "",
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

function bulkField(key, label, control, note = "") {
  return `<div class="bulk-field" data-bulk-field="${key}">
    <label class="bulk-field-toggle"><input type="checkbox" data-bulk-enable="${key}"><span>${escapeHtml(label)}</span></label>
    <div class="bulk-field-control">${control}${note ? `<small class="hint">${escapeHtml(note)}</small>` : ""}</div>
  </div>`;
}

function bulkBooleanOptions(onLabel = "开启", offLabel = "关闭") {
  return `<option value="true">${escapeHtml(onLabel)}</option><option value="false">${escapeHtml(offLabel)}</option>`;
}

function bulkTargetModal() {
  const selected = targets.filter(target => target.type === "tcp" && selectedTargetIds.has(target.id));
  if (!selected.length) return toast("请先选择 VPS", "err");
  const preview = selected.slice(0, 5).map(target => target.name).join("、");
  byId("modal").className = "modal bulk-target-modal";
  byId("modal").innerHTML = `
    <h3>批量设置 VPS</h3>
    <p class="hint bulk-target-summary">已选择 <b>${selected.length}</b> 台：${escapeHtml(preview)}${selected.length > 5 ? ` 等 ${selected.length} 台` : ""}</p>
    <p class="bulk-target-warning">只有左侧已勾选的字段会被覆盖；未勾选字段保持原值。</p>
    <div class="bulk-edit-form">
      <fieldset class="bulk-section"><legend>基础资料</legend><div class="bulk-edit-grid">
        ${bulkField("provider", "商家", `<select id="bulkProvider" disabled>${providerOptionsHtml("")}</select><input id="bulkProviderCustom" maxlength="80" placeholder="填写自定义商家" hidden disabled>`)}
        ${bulkField("line_type", "机器类型", `<select id="bulkLineType" disabled>${lineTypeOptionsHtml("")}</select>`)}
        ${bulkField("expires_at", "到期时间", '<input id="bulkExpires" type="date" disabled>', "留空并保存可清除到期时间")}
      </div></fieldset>
      <fieldset class="bulk-section"><legend>费用</legend><div class="bulk-edit-grid">
        ${bulkField("price", "费用", '<input id="bulkPrice" type="number" min="0" step="0.01" placeholder="留空清除" disabled>')}
        ${bulkField("currency", "币种", `<select id="bulkCurrency" disabled>${currencyOptionsHtml("USD")}</select>`)}
        ${bulkField("billing_cycle", "计费周期", `<select id="bulkBilling" disabled>${targetBillingOptions("")}</select>`)}
      </div></fieldset>
      <fieldset class="bulk-section"><legend>流量</legend><div class="bulk-edit-grid">
        ${bulkField("traffic_enabled", "流量统计", `<select id="bulkTrafficEnabled" disabled>${bulkBooleanOptions()}</select>`)}
        ${bulkField("traffic_quota_gb", "每月流量上限 GB", '<input id="bulkTrafficQuota" type="number" min="0" max="1048576" step="0.1" value="0" disabled>')}
        ${bulkField("traffic_mode", "流量计费方式", `<select id="bulkTrafficMode" disabled>${trafficModeOptions("total")}</select>`)}
        ${bulkField("traffic_reset_day", "流量重置日", '<input id="bulkTrafficResetDay" type="number" min="1" max="31" step="1" value="1" disabled>', "修改后按每日记录重算当前周期")}
      </div></fieldset>
      <fieldset class="bulk-section"><legend>单机报警</legend><div class="bulk-edit-grid">
        ${bulkField("alert_enabled", "目标报警", `<select id="bulkAlertEnabled" disabled>${bulkBooleanOptions()}</select>`)}
        ${bulkField("alert_expiry_days", "到期前 N 天", '<input id="bulkAlertExpiryDays" type="number" min="0" max="3650" step="1" placeholder="留空使用全局" disabled>')}
        ${bulkField("alert_traffic_remaining_percent", "流量剩余 %", '<input id="bulkAlertTrafficPercent" type="number" min="0" max="100" step="0.1" placeholder="留空使用全局" disabled>')}
        ${bulkField("alert_traffic_remaining_gb", "流量剩余 GB", '<input id="bulkAlertTrafficGb" type="number" min="0" max="1048576" step="0.1" placeholder="留空使用全局" disabled>')}
      </div></fieldset>
    </div>
    <div class="ma"><button type="button" class="btn" id="backBulkTargets">上一步</button><button type="button" class="btn btn-primary" id="saveBulkTargets">下一步</button></div>`;

  for (const toggle of byId("modal").querySelectorAll("[data-bulk-enable]")) {
    toggle.onchange = () => toggleBulkField(toggle);
  }
  byId("bulkProvider").onchange = toggleBulkCustomProvider;
  byId("backBulkTargets").onclick = () => openBulkTargetPicker(true);
  byId("saveBulkTargets").onclick = saveBulkTargets;
}

function toggleBulkField(toggle) {
  const field = toggle.closest(".bulk-field");
  field.classList.toggle("is-enabled", toggle.checked);
  for (const control of field.querySelectorAll(".bulk-field-control input, .bulk-field-control select, .bulk-field-control textarea")) {
    control.disabled = !toggle.checked;
  }
  if (toggle.dataset.bulkEnable === "provider") toggleBulkCustomProvider();
}

function toggleBulkCustomProvider() {
  const custom = byId("bulkProviderCustom");
  const enabled = !!byId("modal").querySelector('[data-bulk-enable="provider"]')?.checked;
  const active = enabled && byId("bulkProvider")?.value === "__custom__";
  if (!custom) return;
  custom.hidden = !active;
  custom.disabled = !active;
}

function bulkNullableNumber(id, label, max) {
  const raw = (byId(id)?.value || "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > max) throw new Error(`${label}数值无效`);
  return value;
}

function saveBulkTargets() {
  const ids = targets.filter(target => target.type === "tcp" && selectedTargetIds.has(target.id)).map(target => target.id);
  if (!ids.length) return toast("选择已失效，请刷新后重试", "err");
  const enabled = new Set([...byId("modal").querySelectorAll("[data-bulk-enable]:checked")].map(input => input.dataset.bulkEnable));
  if (!enabled.size) return toast("请至少勾选一个要修改的字段", "err");
  const changes = {};
  try {
    if (enabled.has("provider")) changes.provider = byId("bulkProvider").value === "__custom__" ? byId("bulkProviderCustom").value.trim() : byId("bulkProvider").value;
    if (enabled.has("line_type")) changes.line_type = byId("bulkLineType").value;
    if (enabled.has("expires_at")) changes.expires_at = byId("bulkExpires").value || null;
    if (enabled.has("price")) changes.price = bulkNullableNumber("bulkPrice", "费用", 100000000);
    if (enabled.has("currency")) changes.currency = byId("bulkCurrency").value;
    if (enabled.has("billing_cycle")) changes.billing_cycle = byId("bulkBilling").value;
    if (enabled.has("traffic_enabled")) changes.traffic_enabled = byId("bulkTrafficEnabled").value === "true";
    if (enabled.has("traffic_quota_gb")) changes.traffic_quota_gb = bulkNullableNumber("bulkTrafficQuota", "流量上限", 1048576) ?? 0;
    if (enabled.has("traffic_mode")) changes.traffic_mode = byId("bulkTrafficMode").value;
    if (enabled.has("traffic_reset_day")) {
      const day = Number(byId("bulkTrafficResetDay").value);
      if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("流量重置日需要是 1–31 的整数");
      changes.traffic_reset_day = day;
    }
    if (enabled.has("alert_enabled")) changes.alert_enabled = byId("bulkAlertEnabled").value === "true";
    if (enabled.has("alert_expiry_days")) changes.alert_expiry_days = bulkNullableNumber("bulkAlertExpiryDays", "到期报警天数", 3650);
    if (enabled.has("alert_traffic_remaining_percent")) changes.alert_traffic_remaining_percent = bulkNullableNumber("bulkAlertTrafficPercent", "流量报警百分比", 100);
    if (enabled.has("alert_traffic_remaining_gb")) changes.alert_traffic_remaining_gb = bulkNullableNumber("bulkAlertTrafficGb", "流量报警值", 1048576);
  } catch (error) {
    return toast(error.message, "err");
  }
  const labels = [...byId("modal").querySelectorAll("[data-bulk-enable]:checked")].map(input => input.closest(".bulk-field")?.querySelector(".bulk-field-toggle span")?.textContent).filter(Boolean);
  pendingBulkUpdate = { ids, changes, labels };
  const selected = targets.filter(target => ids.includes(target.id));
  byId("modal").className = "modal bulk-confirm-modal";
  byId("modal").innerHTML = `
    <h3>确认批量设置</h3>
    <p>将修改 <strong>${ids.length}</strong> 台 VPS 的：${escapeHtml(labels.join("、"))}</p>
    <div class="bulk-confirm-targets">${selected.slice(0, 12).map(target => `<span>${escapeHtml(target.name)}</span>`).join("")}${selected.length > 12 ? `<span>另 ${selected.length - 12} 台</span>` : ""}</div>
    ${enabled.has("traffic_reset_day") ? '<div class="bulk-target-warning">流量会按已有每日记录重新汇总。</div>' : ""}
    <div class="ma"><button type="button" class="btn" id="backBulkFields">返回修改</button><button type="button" class="btn btn-primary" id="confirmBulkTargets">确认应用</button></div>`;
  byId("backBulkFields").onclick = bulkTargetModal;
  byId("confirmBulkTargets").onclick = applyBulkTargets;
}

async function applyBulkTargets() {
  const { ids, changes } = pendingBulkUpdate || {};
  if (!ids?.length || !changes) return toast("批量设置已失效，请重新操作", "err");
  const button = byId("confirmBulkTargets");
  button.disabled = true;
  button.textContent = "批量保存中...";
  try {
    const result = await apiAdmin("/api/targets/bulk", { method: "PATCH", body: JSON.stringify({ ids, changes }) }, 60000);
    selectedTargetIds.clear();
    pendingBulkUpdate = null;
    closeModal();
    toast(`已更新 ${result.count || ids.length} 台 VPS`, "ok");
    await loadTargets();
  } catch (error) {
    toast(error.message, "err");
    if (document.body.contains(button)) {
      button.disabled = false;
      button.textContent = "确认应用";
    }
  }
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

function providerOptionsHtml(current = "") {
  const selected = String(current || "").trim();
  const custom = Boolean(selected && !PROVIDERS.includes(selected));
  return [
    '<option value="">请选择商家</option>',
    ...PROVIDERS.map((provider) =>
      `<option value="${escapeHtml(provider)}"${selectedAttr(provider === selected)}>${escapeHtml(provider)}</option>`),
    `<option value="__custom__"${selectedAttr(custom)}>自定义商家</option>`,
  ].join("");
}

function toggleCustomProvider() {
  const custom = byId("mProviderCustom");
  if (!custom) return;
  const active = byId("mProvider")?.value === "__custom__";
  custom.hidden = !active;
  custom.disabled = !active;
  if (active) custom.focus();
}

function currencyOptionsHtml(current = "USD") {
  const selected = String(current || "USD").trim().toUpperCase();
  return CURRENCIES.map((currency) =>
    `<option value="${currency.code}"${selectedAttr(currency.code === selected)}>${escapeHtml(currency.name)} (${currency.code})</option>`).join("");
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
    <input id="mOriginalTrafficResetDay" type="hidden" value="${escapeHtml(target.traffic_reset_day ?? 1)}">
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
      ${formField("自动位置", `<div class="auto-location-preview"><strong>${escapeHtml([target.location, target.city].filter(Boolean).join(" · ") || "等待 Agent 获取")}</strong><span>${target.location_source ? `来源 ${escapeHtml(target.location_source)}` : "安装或更新 Agent 后自动获取"}${target.location_updated_at ? ` · ${escapeHtml(formatDateTime(target.location_updated_at))}` : ""}</span></div>`)}
      ${formField("商家", `<select id="mProvider">${providerOptionsHtml(target.provider || "")}</select><input id="mProviderCustom" maxlength="80" placeholder="填写自定义商家" value="${escapeHtml(PROVIDERS.includes(target.provider || "") ? "" : target.provider || "")}">`)}
      ${formField("机器类型", `<select id="mLineType">${lineTypeOptionsHtml(target.line_type || "")}</select>`)}
    </div>
    <p class="hint fvps">国家与城市由 Agent 根据出口 IPv4/IPv6 自动获取；定位服务商在“设置 → 自动地理位置”中统一选择。</p>

    <div class="form-grid">
      ${formField("到期时间（可选）", `<input id="mExpires" type="date" value="${dateInput(target.expires_at)}">`)}
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
      <p class="hint">流量周期只按独立的重置日计算，与 VPS 到期时间互不影响。</p>`,
      "fvps",
    )}

    <div class="form-grid fvps">
      ${formField("本 VPS 每月流量上限 GB", `<input id="mTrafficQuota" type="number" min="0" step="0.1" value="${escapeHtml(target.traffic_quota_gb || 0)}">`)}
      ${formField("流量重置日（每月）", `<input id="mTrafficResetDay" type="number" min="1" max="31" step="1" value="${escapeHtml(target.traffic_reset_day ?? 1)}"><p class="hint">填写 1–31；短月份自动使用当月最后一天。</p>`)}
    </div>
    ${formField("流量计费方式", `<select id="mTrafficMode">${trafficModeOptions(target.traffic_mode)}</select>`, "fvps")}

    ${formField(
      "此探针报警",
      `
      <label class="switch-line">
        <input type="checkbox" id="mAlertEnabled"${checkedAttr(alertEnabled)}>
        <span>启用此探针的报警规则</span>
      </label>
      <p class="hint">以下阈值留空时使用“设置 → 报警通知”的全局规则。</p>`,
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
  byId("mProvider").onchange = toggleCustomProvider;
  toggleCustomProvider();
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
  const trafficResetDay = Number(byId("mTrafficResetDay")?.value || 1);
  if (!Number.isInteger(trafficResetDay) || trafficResetDay < 1 || trafficResetDay > 31)
    return toast("流量重置日需要是 1–31 的整数", "err");
  const originalTrafficResetDay = Number(byId("mOriginalTrafficResetDay")?.value || 1);
  if (edit && trafficResetDay !== originalTrafficResetDay && !confirm("修改流量重置日会立即切换当前统计周期，并按已有的每日记录重新汇总。统计结果可能随周期范围变化，是否继续？")) return;
  const b = {
    name: byId("mName").value.trim(),
    type: byId("mType").value,
    group_name: byId("mGroup").value === "Web" ? "Web" : "VPS",
    interval_sec: Number(byId("mInterval").value) || 300,
    probe_region: byId("mRegion")?.value || "auto",
    no_public_ip: byId("mType").value === "tcp" && !!byId("mNoPublicIp")?.checked,
    tags: byId("mTags")?.value.trim() || "",
    provider: byId("mProvider")?.value === "__custom__"
      ? (byId("mProviderCustom")?.value || "").trim().slice(0, 80)
      : byId("mProvider")?.value || "",
    line_type: byId("mLineType")?.value || "",
    expires_at: byId("mExpires")?.value || null,
    price,
    billing_cycle: byId("mBilling")?.value || "",
    currency: byId("mCurrency")?.value || "USD",
    traffic_enabled: byId("mType").value === "tcp" && !!byId("mTrafficEnabled")?.checked,
    traffic_quota_gb: byId("mType").value === "tcp" ? Number(byId("mTrafficQuota")?.value) || 0 : 0,
    traffic_mode: byId("mTrafficMode")?.value || "total",
    traffic_reset_day: byId("mType").value === "tcp" ? trafficResetDay : 1,
    alert_enabled: !!byId("mAlertEnabled")?.checked,
    alert_expiry_days: nullableNumber("mAlertExpiryDays"),
    alert_traffic_remaining_percent: byId("mType").value === "tcp" ? nullableNumber("mAlertTrafficPercent") : null,
    alert_traffic_remaining_gb: byId("mType").value === "tcp" ? nullableNumber("mAlertTrafficGb") : null,
  };
  const id = byId("mId").value.trim();
  if (id && !edit) b.id = id;
  if (!b.name) return toast("名称不能为空", "err");
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
  toast("正在生成安装命令...", "info");
  try {
    const d = await apiAdmin(
      "/api/agent/install-command?target_id=" + encodeURIComponent(t.id),
      {},
      20000,
    );
    const cmd = agentInstallCommandFromPayload(d, t.id);
    await copyText(cmd);
    toast("已复制“" + (t.name || t.id) + "”的 Agent 安装命令（含一次性凭据，10 分钟内有效）", "ok");
  } catch (e) {
    toast("安装命令复制失败：" + (e?.message || "未知错误"), "err");
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
    latencyBuiltin = data.builtin || { id: "cloudflare", name: "Cloudflare", color: "#159754", builtin: true, enabled: true };
    renderLatencyNodes();
  } catch (error) {
    errBox("latencyTable", error);
  }
}

function renderLatencyNodes() {
  const builtinColor = configuredChartColor(latencyBuiltin?.color, "#159754");
  const builtin = `
    <tr class="latency-builtin-row">
      <td><code>cloudflare</code></td>
      <td><span class="chart-color-swatch" style="--chart-color:${builtinColor}"></span><strong>Cloudflare</strong><small class="table-note">系统默认来源</small></td>
      <td><span class="tag tag-on">内置 · 启用</span></td>
      <td>全球边缘网络</td>
      <td><div class="actions"><span class="muted">固定保留，不可删除</span><button class="btn btn-xs" data-a="latency-edit">编辑颜色</button></div></td>
    </tr>`;
  const external = latencyNodes.map((node, index) => `
    <tr data-i="${index}">
      <td><code>${escapeHtml(node.id)}</code></td>
      <td><span class="chart-color-swatch" style="--chart-color:${configuredChartColor(node.color, '#2e7dd7')}"></span>${escapeHtml(node.name)}</td>
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
  const builtin = node?.builtin || String(node?.id || "") === "cloudflare";
  byId("modal").innerHTML = `
    <h3>${edit ? "编辑" : "新增"} Latency 节点</h3>
    ${edit ? inputField("ID", "latencyNodeId", node.id, "readonly") : ""}
    ${inputField("显示名称", "latencyNodeName", node?.name || "", builtin ? "readonly" : 'placeholder="例如：东京 IIJ、洛杉矶 CN2"')}
    ${formField("曲线颜色", `<input id="latencyNodeColor" type="color" value="${configuredChartColor(node?.color, builtin ? '#159754' : '#2e7dd7')}">`)}
    <p class="hint">${builtin ? "Cloudflare 为系统内置来源，名称与启用状态固定，只可修改曲线颜色。" : "名称用于后台识别及详细延迟图表；VPS 列表不显示节点名称与延迟。此节点与 VPS Agent、Ping 功能完全独立。"}</p>
    <div class="ma"><button class="btn" data-close>取消</button><button class="btn btn-primary" id="saveLatencyNode">保存</button></div>`;
  byId("saveLatencyNode").onclick = () => saveLatencyNode(node);
  openModal();
}

async function saveLatencyNode(node = null) {
  const builtin = node?.builtin || String(node?.id || "") === "cloudflare";
  const name = byId("latencyNodeName").value.trim();
  const color = configuredChartColor(byId("latencyNodeColor")?.value, builtin ? '#159754' : '#2e7dd7');
  if (!builtin && !name) return toast("请填写 Latency 节点名称", "err");
  const button = byId("saveLatencyNode");
  button.disabled = true;
  try {
    await apiAdmin(node ? `/api/latency-agents/${encodeURIComponent(node.id)}` : "/api/latency-agents", {
      method: node ? "PATCH" : "POST",
      body: JSON.stringify(builtin ? { color } : { name, color }),
    }, 30000);
    closeModal();
    toast(builtin ? "Cloudflare 曲线颜色已更新" : "Latency 节点已保存", "ok");
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
  if (!node?.id) {
    toast("无法识别当前 Latency 节点，请刷新后台后重试", "err");
    return;
  }
  const oldText = trigger?.textContent || "部署";
  if (trigger) {
    trigger.disabled = true;
    trigger.textContent = "生成中...";
  }
  toast("正在生成 Latency 安装命令...", "info");
  try {
    const data = await apiAdmin(`/api/latency-agent/install-command?node_id=${encodeURIComponent(node.id)}`, {}, 20000);
    const command = latencyInstallCommandFromPayload(data, node.id);
    await copyText(command);
    toast("已复制 Latency 节点安装命令（含一次性凭据，10 分钟内有效）", "ok");
  } catch (error) {
    toast("Latency 安装命令复制失败：" + (error?.message || "未知错误"), "err");
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
    pingIntervalSec = Number(d.ping_interval_sec || 20);
    if (byId("pingIntervalSec")) byId("pingIntervalSec").value = String(pingIntervalSec);
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

async function savePingInterval() {
  const input = byId("pingIntervalSec");
  const interval = Number(input?.value);
  if (!Number.isInteger(interval) || interval < 5 || interval > 300) {
    return toast("Ping 间隔必须是 5-300 秒之间的整数", "err");
  }
  const button = byId("savePingInterval");
  button.disabled = true;
  try {
    const result = await apiAdmin("/api/ping-config", {
      method: "PATCH",
      body: JSON.stringify({ ping_interval_sec: interval }),
    });
    pingIntervalSec = Number(result.ping_interval_sec || interval);
    input.value = String(pingIntervalSec);
    toast(`Ping 间隔已更新为 ${pingIntervalSec} 秒，Agent 将自动应用`, "ok");
    await loadPings();
  } catch (error) {
    toast(error.message, "err");
  } finally {
    button.disabled = false;
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
            <th>颜色</th>
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
      <td><span class="chart-color-swatch" style="--chart-color:${configuredChartColor(ping.color, '#159754')}"></span><code>${escapeHtml(configuredChartColor(ping.color, '#159754'))}</code></td>
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
    ${formField("曲线颜色", `<input id="pColor" type="color" value="${configuredChartColor(ping.color, '#159754')}">`)}
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
    color = configuredChartColor(byId("pColor")?.value, '#159754'),
    target = byId("pTarget").value.trim();
  if (!name || !target) return toast("名称和目标必填", "err");
  try {
    await api(
      edit
        ? "/api/ping-targets/" + encodeURIComponent(id)
        : "/api/ping-targets",
      {
        method: edit ? "PATCH" : "POST",
        body: JSON.stringify({ id: id || undefined, name, target, color }),
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
  loadAppUpdate();
  loadTotp();
  loadEncryption();
  loadAccount();
  loadAdminPath();
  loadGeoIp();
  loadBackup();
  loadAgentOrigin();
  loadAgentUpdate();
  loadTraffic();
  loadAlerts();
  loadAppearance();
  loadDebugLogs();
}

async function loadEncryption() {
  const box = byId("sEncryption");
  if (!box) return;
  try {
    const data = await apiAdmin("/api/security/encryption");
    const primary = data.primary_configured
      ? '<span class="tag tag-on">已配置</span>'
      : '<span class="tag tag-warn">未配置</span>';
    const previous = data.previous_configured
      ? '<span class="tag tag-warn">轮换中</span>'
      : '<span class="tag tag-off">未启用</span>';
    box.innerHTML = `
      <div class="security-key-status"><span>长期密钥</span>${primary}</div>
      <div class="security-key-status"><span>上一把密钥</span>${previous}</div>
      <p class="hint">迁移会用当前长期密钥重新封装 TOTP、Agent Token 与通知凭据，不会改变 Agent Token。</p>
      <button type="button" class="btn btn-sm btn-blue" id="migrateEncryption"${data.primary_configured ? "" : " disabled"}>检查并迁移</button>
      <p class="backup-status" id="encryptionStatus" role="status" aria-live="polite" hidden></p>`;
    byId("migrateEncryption").onclick = migrateEncryption;
  } catch (error) {
    errBox("sEncryption", error);
  }
}

async function migrateEncryption() {
  const button = byId("migrateEncryption");
  const status = byId("encryptionStatus");
  if (button) button.disabled = true;
  if (status) {
    status.hidden = false;
    status.className = "backup-status info";
    status.textContent = "正在检查并重加密现有凭据...";
  }
  try {
    const data = await apiAdmin("/api/security/encryption/migrate", { method: "POST" }, 60000);
    const migrated = Object.values(data.results || {}).reduce((sum, item) => sum + Number(item?.migrated || 0), 0);
    if (!data.ok) throw new Error((data.errors || []).map((item) => `${item.component}: ${item.error}`).join("；") || data.error || "迁移未完成");
    if (status) {
      status.className = "backup-status ok";
      status.textContent = `密钥检查完成，已重加密 ${migrated} 条记录。`;
    }
    toast("加密材料检查完成", "ok");
    setTimeout(loadEncryption, 800);
  } catch (error) {
    if (status) {
      status.className = "backup-status err";
      status.textContent = `迁移失败：${error.message}`;
    }
    toast(`密钥迁移失败：${error.message}`, "err");
  } finally {
    if (button) button.disabled = false;
  }
}

async function loadGeoIp() {
  const box = byId("sGeoIp");
  if (!box) return;
  try {
    const data = await api("/api/settings/geoip");
    box.innerHTML = `
      <div class="f"><label>IP 定位服务商</label><select id="geoIpProvider">${(data.providers || []).map((provider) => `<option value="${escapeHtml(provider.id)}"${selectedAttr(provider.id === data.provider)}>${escapeHtml(provider.name)}${provider.city ? "" : "（仅国家）"}</option>`).join("")}</select></div>
      <div class="f" id="geoIpCustomRow"><label>自定义 HTTPS JSON 接口</label><input id="geoIpCustomUrl" type="url" value="${escapeHtml(data.custom_url || "")}" placeholder="https://geo.example.com/lookup"></div>
      <p class="hint">Agent 启动后自动查询出口 IPv4/IPv6，此后每 24 小时刷新。自定义接口需返回 <code>ip/ipv4/ipv6</code>、<code>country_code</code>、<code>country</code>、<code>city</code>。</p>
      <button class="btn btn-primary btn-sm" id="saveGeoIp">保存定位设置</button>`;
    const toggle = () => { byId("geoIpCustomRow").hidden = byId("geoIpProvider").value !== "custom"; };
    byId("geoIpProvider").onchange = toggle;
    byId("saveGeoIp").onclick = saveGeoIp;
    toggle();
  } catch (error) {
    errBox("sGeoIp", error);
  }
}

async function saveGeoIp() {
  const button = byId("saveGeoIp");
  if (button) button.disabled = true;
  try {
    await api("/api/settings/geoip", {
      method: "PATCH",
      body: JSON.stringify({ provider: byId("geoIpProvider").value, custom_url: byId("geoIpCustomUrl").value.trim() }),
    });
    toast("自动地理位置设置已保存", "ok");
    loadGeoIp();
  } catch (error) {
    toast(error.message, "err");
  } finally {
    if (button) button.disabled = false;
  }
}

function loadBackup() {
  const box = byId("sBackup");
  if (!box) return;
  box.innerHTML = `
    <p class="hint">便携备份包含节点、检测、账单、外观和 Agent 连接域名，不包含 D1/R2 历史。建议保留下方受保护凭据，迁移到全新 Worker 与 D1 后，已安装 Agent 可继续连接。</p>
    <label class="switch-line"><input id="backupSecrets" type="checkbox" checked><span>保留 Agent/TOTP/通知凭据（推荐，密码加密）</span></label>
    <p class="hint backup-warning">Agent Token 只会出现在备份密码加密的数据包内，恢复时自动使用新部署长期密钥重新封装。轮换密钥前请先在“安全 → 数据加密密钥”完成迁移检查。</p>
    <div class="backup-actions"><button class="btn btn-blue btn-sm" id="exportBackup">导出备份</button><button class="btn btn-sm" id="chooseRestoreBackup">恢复备份</button></div>
    <p class="backup-status" id="backupStatus" role="status" aria-live="polite" hidden></p>`;
  byId("exportBackup").onclick = downloadBackup;
  byId("chooseRestoreBackup").onclick = () => byId("restoreBackupFile").click();
  byId("restoreBackupFile").onchange = restoreBackupFile;
}

async function downloadBackup() {
  const includeSecrets = !!byId("backupSecrets")?.checked;
  let password = "";
  if (includeSecrets) {
    password = await requestBackupPassword();
    if (!password) return;
  }
  const button = byId("exportBackup");
  const oldText = button?.textContent || "导出备份";
  if (button) {
    button.disabled = true;
    button.textContent = includeSecrets ? "正在加密..." : "正在生成...";
    button.setAttribute("aria-busy", "true");
  }
  setBackupStatus(includeSecrets ? "正在加密 Agent Token 与敏感设置，请不要关闭页面..." : "正在生成普通备份...", "info");
  try {
    const data = await apiAdmin("/api/backup/export", {
      method: "POST",
      body: JSON.stringify({ include_secrets: includeSecrets, password }),
    }, 60000);
    const blob = new globalThis.Blob([JSON.stringify(data.backup, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `nie-sla-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    setBackupStatus(includeSecrets ? "受保护备份已生成并开始下载。" : "普通备份已生成并开始下载。", "ok");
    toast("备份已导出并开始下载", "ok");
  } catch (error) {
    const message = error?.message || "未知错误";
    setBackupStatus(`备份导出失败：${message}`, "err");
    toast(`备份导出失败：${message}`, "err");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = oldText;
      button.removeAttribute("aria-busy");
    }
  }
}

function requestBackupPassword({ restore = false } = {}) {
  return new Promise((resolve) => {
    const modal = byId("modal");
    let settled = false;
    modal.className = "modal backup-password-modal";
    modal.innerHTML = `
      <h3>${restore ? "解锁受保护备份" : "加密受保护备份"}</h3>
      <p class="hint">${restore ? "输入导出时设置的备份密码，验证通过后才能预览并恢复敏感凭据。" : "设置至少 10 位密码，用于加密 Agent Token、TOTP 与通知凭据。此密码无法找回。"}</p>
      <div class="f"><label for="backupPassword">备份密码</label><input id="backupPassword" type="password" minlength="10" autocomplete="${restore ? "current-password" : "new-password"}" spellcheck="false"></div>
      <div class="error" id="backupPasswordError" role="alert" hidden></div>
      <div class="ma"><button type="button" class="btn" data-close>取消</button><button type="button" class="btn btn-primary" id="confirmBackupPassword">${restore ? "解锁并预览" : "继续加密"}</button></div>`;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      modalCancelHandler = null;
      closeModal();
      resolve(value);
    };
    modalCancelHandler = () => {
      if (settled) return;
      settled = true;
      resolve("");
    };
    byId("confirmBackupPassword").onclick = () => {
      const input = byId("backupPassword");
      const error = byId("backupPasswordError");
      const value = input.value;
      if (value.length < 10) {
        error.textContent = "密码至少需要 10 位，尚未开始处理备份。";
        error.hidden = false;
        input.focus();
        return;
      }
      finish(value);
    };
    byId("backupPassword").onkeydown = (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      byId("confirmBackupPassword").click();
    };
    openModal();
  });
}

function setBackupStatus(message, type = "info") {
  const status = byId("backupStatus");
  if (!status) return;
  status.hidden = !message;
  status.textContent = message || "";
  status.className = `backup-status ${type}`;
}

async function restoreBackupFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return toast("备份文件不能超过 2 MB", "err");
  try {
    const backup = JSON.parse(await file.text());
    const password = backup.sensitive ? await requestBackupPassword({ restore: true }) : "";
    if (backup.sensitive && !password) return;
    const preview = await api("/api/backup/preview", {
      method: "POST",
      body: JSON.stringify({ backup, password }),
    });
    const counts = preview.preview?.counts || {};
    const tokenCount = Number(preview.preview?.sensitive_counts?.agent_tokens || 0);
    const legacyCredentialCount = Number(preview.preview?.sensitive_counts?.agent_credentials || 0);
    const secretWarning = backup.sensitive
      ? tokenCount > 0
        ? `\n\n受保护数据包含 ${tokenCount} 个可迁移 Agent Token；恢复时会使用当前部署密钥重新封装。`
        : legacyCredentialCount > 0
          ? `\n\n这是旧格式受保护备份，包含 ${legacyCredentialCount} 个 Agent 凭据。原节点可继续认证，但读取或重新生成命令可能仍需原加密密钥。`
          : "\n\n此文件包含受密码保护的敏感配置，但没有 Agent Token。"
      : "\n\n此普通备份不含 Agent 凭据；恢复到新 D1 后，原 VPS Agent 无法自动重新认证。";
    if (!confirm(`将恢复 ${counts.targets || 0} 个目标、${counts.ping_targets || 0} 个 Ping 目标和 ${counts.latency_agents || 0} 个 Latency Agent。\n\n默认采用合并模式；恢复前会自动在 R2 创建快照。${secretWarning}\n\n继续？`)) return;
    await api("/api/backup/restore", {
      method: "POST",
      body: JSON.stringify({ backup, password, mode: "merge", confirm: "RESTORE" }),
    });
    toast("备份恢复完成", "ok");
    loadTargets();
  } catch (error) {
    toast(error.message, "err");
  }
}

async function loadAppUpdate(refresh = false) {
  const box = byId("sAppUpdate");
  if (!box) return;
  box.innerHTML = '<div class="loading compact">正在检查版本...</div>';
  try {
    const data = await api(`/api/system/update${refresh ? "?refresh=1" : ""}`);
    appUpdateInfo = data;
    const status = data.update_available
      ? '<span class="tag tag-warn">发现新版本</span>'
      : '<span class="tag tag-on">已是最新版</span>';
    box.innerHTML = `
      <div class="app-update-versions">
        <div><span>当前版本</span><b>v${escapeHtml(data.current_version || "-")}</b></div>
        <div><span>最新版本</span><b>v${escapeHtml(data.latest_version || "-")}</b></div>
      </div>
      <div class="app-update-status">${status}${data.stale ? `<span class="hint">${data.update_source === "bundled" ? "官方源暂时受限，使用当前部署版本" : "官方源暂时受限，使用缓存结果"}</span>` : ""}</div>
      <p class="hint">发布时间：${escapeHtml(formatUpdateTime(data.published_at))}</p>
      <p class="hint app-update-note">部署仓库默认每 ${escapeHtml(data.automatic_check_hours || 6)} 小时自动检查并应用稳定更新，无需填写仓库或 Token。</p>
      <div class="app-update-actions">
        <button class="btn btn-sm" id="checkAppUpdate">检查更新</button>
        <button class="btn btn-primary btn-sm" id="showAppUpdateGuide">更新指引</button>
        <button class="btn btn-sm" id="showAppUpdateChangelog">更新日志</button>
      </div>`;
    byId("checkAppUpdate").onclick = () => loadAppUpdate(true);
    byId("showAppUpdateGuide").onclick = showAppUpdateGuide;
    byId("showAppUpdateChangelog").onclick = showAppUpdateChangelog;
  } catch (error) {
    appUpdateInfo = null;
    errBox("sAppUpdate", error);
  }
}

function showAppUpdateChangelog() {
  const data = appUpdateInfo || {};
  const changelog = Array.isArray(data.changelog) && data.changelog.length
    ? `<ul class="app-update-log app-update-log-modal">${data.changelog.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : '<p class="hint">该版本没有单独的更新说明。</p>';
  byId("modal").innerHTML = `
    <h3>${escapeHtml(data.title || "更新日志")}</h3>
    <p class="hint">v${escapeHtml(data.latest_version || "-")} · ${escapeHtml(formatUpdateTime(data.published_at))}</p>
    ${changelog}
    <div class="ma"><button class="btn" type="button" data-close>关闭</button></div>`;
  openModal();
}

function showAppUpdateGuide() {
  byId("modal").innerHTML = `
    <h3>立即更新</h3>
    <p class="hint">系统会每 6 小时自动检查。需要立即更新时，只需在一键部署生成的仓库运行一次工作流：</p>
    <ol class="app-update-guide">
      <li>打开一键部署时生成的 GitHub 仓库。</li>
      <li>进入 <b>Actions</b> 页面。</li>
      <li>选择 <b>NIE-SLA Online Update</b>。</li>
      <li>点击 <b>Run workflow</b>，无需填写参数。</li>
    </ol>
    <p class="hint">工作流会保留现有 Cloudflare 资源绑定，验证通过后由 Cloudflare 自动重新部署。</p>
    <div class="ma">
      <button class="btn" type="button" data-close>关闭</button>
      <a class="btn btn-primary" href="https://github.com/?tab=repositories" target="_blank" rel="noopener noreferrer">打开仓库列表</a>
    </div>`;
  openModal();
}

function formatUpdateTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toLocaleString("zh-CN", { hour12: false }) : "未知";
}

async function loadAdminPath() {
  const box = byId("sAdminPath");
  if (!box) return;
  try {
    const data = await api("/api/settings");
    const path = data.admin_path || "/admin";
    box.innerHTML = `
      <div class="f"><label>入口路径</label><input id="adminPath" value="${escapeHtml(path)}" maxlength="65" autocomplete="off" spellcheck="false"></div>
      <p class="hint">使用 3-64 位字母、数字、连字符或下划线。修改后旧入口会返回 404；它只能减少扫描噪声，不能代替账号密码与 TOTP。</p>
      <div class="admin-path-actions"><button class="btn btn-primary btn-sm" id="saveAdminPath">保存路径</button><a class="btn btn-sm" id="openAdminPath" href="${escapeHtml(path)}">打开当前入口</a></div>`;
    byId("saveAdminPath").onclick = saveAdminPath;
  } catch (error) {
    errBox("sAdminPath", error);
  }
}

async function saveAdminPath() {
  const button = byId("saveAdminPath");
  const value = byId("adminPath")?.value.trim() || "";
  if (button) button.disabled = true;
  try {
    const data = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ admin_path: value }),
    });
    const path = data.admin_path || "/admin";
    toast(`后台入口已改为 ${path}`, "ok");
    loadAdminPath();
  } catch (error) {
    toast(error.message, "err");
  } finally {
    if (button) button.disabled = false;
  }
}

const appearanceSections = [
  { title: '品牌与页头', fields: [
    ['site_name', '站点名称'], ['site_subtitle', '页头副标题'], ['hero_subtitle', '状态横幅下方说明'], ['page_title', '浏览器页面标题'],
    ['favicon_url', '浏览器图标 URL'], ['brand_home_url', '左上角品牌链接'], ['brand_logo_url', '左上角 Logo URL'],
    ['brand_logo_alt', 'Logo 替代文字'], ['brand_logo_height', 'Logo 高度（20-64px）', 'number'],
    ['header_right_mode', '右上角显示方式', 'select', [['image', '显示图片'], ['text', '显示文字'], ['hidden', '隐藏']]],
    ['header_right_text', '右上角文字'], ['header_right_image_url', '右上角图片 URL'],
    ['header_right_image_alt', '右上角图片替代文字'], ['header_right_image_width', '右上角图片宽度（40-240px）', 'number'],
    ['header_right_link', '右上角跳转链接'],
  ] },
  { title: '状态与导航文案', fields: [
    ['search_placeholder', '搜索框提示'], ['group_by_title', '分组栏标题'],
    ['banner_normal', '全部正常文案'], ['banner_down', '服务离线文案'], ['banner_degraded', '数据延迟文案'],
    ['banner_unknown', '等待检查文案'], ['summary_total', '服务总数摘要'], ['summary_up', '正常服务摘要'],
    ['summary_down', '离线服务摘要'], ['summary_degraded', '延迟服务摘要'], ['summary_unknown', '待检查服务摘要'],
    ['summary_latency', '平均延迟摘要'], ['summary_updated', '更新时间摘要'],
  ] },
  { title: '内容区文案', fields: [
    ['incident_title', '故障区标题'], ['incident_empty', '无故障摘要'], ['incident_empty_detail', '无故障详情'],
    ['checks_title', '最近检查标题'], ['checks_hint', '最近检查提示'], ['checks_empty', '未选择服务提示'],
    ['checks_unselected', '未选择服务标题'], ['checks_no_records', '无检查记录提示'], ['no_search_results', '无搜索结果提示'],
    ['chart_title', '响应时间图表标题'], ['chart_unselected', '图表未选择提示'], ['vps_details_label', 'VPS 详情折叠标题'],
  ] },
  { title: '页脚与颜色', fields: [
    ['footer_text', '页脚文案'], ['footer_link_text', '页脚链接文字'], ['footer_link_url', '页脚链接 URL'],
    ['accent_color', '强调色', 'color'], ['page_background', '页面背景色', 'color'], ['surface_color', '内容表面色', 'color'],
  ] },
  { title: '首页显示区域', fields: [
    ['show_header', '显示页头', 'checkbox'], ['show_banner', '显示状态横幅', 'checkbox'], ['show_summary', '显示状态摘要', 'checkbox'],
    ['show_search', '显示搜索框', 'checkbox'], ['show_group_by', '显示分组栏', 'checkbox'],
    ['show_incidents', '显示故障记录', 'checkbox'], ['show_chart', '显示监控图表', 'checkbox'],
    ['show_vps_details', '显示 VPS 详情', 'checkbox'],
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
async function loadAgentOrigin() {
  const box = byId("sAgentOrigin");
  if (!box) return;
  try {
    const d = await api("/api/settings");
    box.innerHTML = `
      <div class="f"><label for="agentPublicBase">自定义 HTTPS 域名</label><input id="agentPublicBase" type="url" inputmode="url" autocomplete="url" value="${escapeHtml(d.agent_public_base || "")}" placeholder="https://agent.example.com"></div>
      <p class="hint">该域名必须已路由到当前 Worker，并能访问 <code>/api</code>、<code>/install.sh</code> 与 <code>/bin</code>。保存后，新生成的 Agent/Latency 安装命令及自动更新都会使用它；留空恢复自动选择。</p>
      <button class="btn btn-primary btn-sm" id="saveAgentOrigin">保存连接域名</button>`;
    byId("saveAgentOrigin").onclick = saveAgentOrigin;
  } catch (e) {
    errBox("sAgentOrigin", e);
  }
}
async function saveAgentOrigin() {
  const input = byId("agentPublicBase");
  const button = byId("saveAgentOrigin");
  if (button) button.disabled = true;
  try {
    const d = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ agent_public_base: input?.value.trim() || "" }),
    });
    if (input) input.value = d.agent_public_base || "";
    toast(d.agent_public_base ? "Agent 连接域名已保存" : "已恢复自动选择 Agent 连接域名", "ok");
  } catch (e) {
    toast(e.message, "err");
  } finally {
    if (button) button.disabled = false;
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
      '<p class="hint">关闭时 Agent 不会修改自身；需要用户在 VPS 中执行 <code>cftz update</code>。开启后只会安装更高版本，并先完成版本与 SHA-256 校验，绝不会自动降级。目前仅 Linux 支持自动安装；旧安装需要重新粘贴一次最新部署命令，以安装 root updater 和定时器。</p>';
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
      `<p class="hint">流量统计按 VPS 单独设置。到“探针管理”里编辑某台 VPS，可分别设置每月上限、计费方式和流量重置日。</p><div class="traffic-settings"><p class="hint">流量重置日与 VPS 到期时间完全独立；续期或修改到期时间不会改变流量周期。数据保存在 CF/D1。</p></div>`;
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
    byId("testTelegramAlert").onclick = () => testAlert("telegram");
    byId("testEmailAlert").onclick = () => testAlert("email");
    byId("runAlertCheck").onclick = runAlertCheck;
  } catch (e) {
    errBox("sAlerts", e);
  }
}

function alertSettingsHtml(d) {
  const tokenHint = d.telegram_bot_token_set
    ? `已配置${d.telegram_bot_token_source === "env" ? "（环境变量）" : "（后台保存）"}；留空不修改`
    : "未配置，请填写 Bot Token";
  const resendHint = d.resend_api_key_set
    ? `已配置${d.resend_api_key_source === "env" ? "（环境变量）" : "（后台保存）"}；留空不修改`
    : "未配置，请填写 Resend API Key";
  return `
    <div class="traffic-settings alert-settings">
      <label class="switch-line">
        <input type="checkbox" id="aEnabled"${checkedAttr(d.enabled)}>
        <span>启用报警规则</span>
      </label>
      <fieldset class="alert-channel">
        <legend>Telegram</legend>
        <label class="switch-line">
          <input type="checkbox" id="aTelegramEnabled"${checkedAttr(d.telegram_enabled)}>
          <span>发送 Telegram 通知</span>
        </label>
        <div class="form-grid">
          ${formField("Bot Token", `<input id="aToken" type="password" placeholder="${escapeHtml(tokenHint)}">`)}
          ${formField("Chat ID", `<input id="aChat" value="${escapeHtml(d.telegram_chat_id || "")}" placeholder="-100xxxxxxxxxx">`)}
          ${formField("消息格式", `<select id="aTelegramFormat"><option value="plain"${selectedAttr(d.telegram_format === "plain")}>纯文本</option><option value="html"${selectedAttr(d.telegram_format === "html")}>HTML</option><option value="markdownv2"${selectedAttr(d.telegram_format === "markdownv2")}>MarkdownV2</option></select>`)}
          ${formField("Topic / Thread ID（可选）", `<input id="aTelegramThread" inputmode="numeric" value="${escapeHtml(d.telegram_message_thread_id || "")}" placeholder="论坛话题 ID">`)}
        </div>
        <div class="alert-option-row">
          <label class="switch-line"><input type="checkbox" id="aTelegramPreview"${checkedAttr(d.telegram_disable_web_preview)}><span>关闭链接预览</span></label>
          <label class="switch-line"><input type="checkbox" id="aTelegramSilent"${checkedAttr(d.telegram_silent)}><span>静默发送</span></label>
        </div>
        ${formField("Telegram 消息模板", `<textarea id="aTelegramTemplate" class="alert-template" rows="7">${escapeHtml(d.telegram_template || "")}</textarea>`)}
      </fieldset>
      <fieldset class="alert-channel">
        <legend>电子邮件 · Resend</legend>
        <label class="switch-line">
          <input type="checkbox" id="aEmailEnabled"${checkedAttr(d.email_enabled)}>
          <span>发送电子邮件通知</span>
        </label>
        <div class="form-grid alert-email-grid">
          ${formField("Resend API Key", `<input id="aResendKey" type="password" placeholder="${escapeHtml(resendHint)}">`)}
          ${formField("发件人", `<input id="aEmailFrom" type="email" value="${escapeHtml(d.email_from || "")}" placeholder="NIE-SLA &lt;status@example.com&gt;">`)}
          ${formField("收件人", `<input id="aEmailTo" value="${escapeHtml(d.email_to || "")}" placeholder="owner@example.com">`)}
          ${formField("Reply-To（可选）", `<input id="aEmailReplyTo" type="email" value="${escapeHtml(d.email_reply_to || "")}" placeholder="reply@example.com">`)}
          ${formField("邮件格式", `<select id="aEmailFormat"><option value="text"${selectedAttr(d.email_format === "text")}>纯文本</option><option value="html"${selectedAttr(d.email_format === "html")}>HTML</option></select>`)}
          ${formField("邮件主题模板", `<input id="aEmailSubjectTemplate" value="${escapeHtml(d.email_subject_template || "")}">`)}
        </div>
        ${formField("邮件正文模板", `<textarea id="aEmailTemplate" class="alert-template" rows="8">${escapeHtml(d.email_template || "")}</textarea>`)}
        <p class="hint">多个收件人用英文逗号分隔；发件域名必须已在 Resend 验证。</p>
      </fieldset>
      <p class="hint alert-placeholder-hint">模板占位符：<code>{{title}}</code> <code>{{message}}</code> <code>{{site_name}}</code> <code>{{time}}</code> <code>{{alert_count}}</code> <code>{{channel}}</code>。正文必须包含且只能包含一个 <code>{{message}}</code>，其余占位符也不要重复。</p>
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
        <button class="btn btn-blue" id="testTelegramAlert">测试 Telegram</button>
        <button class="btn btn-blue" id="testEmailAlert">测试邮件</button>
        <button class="btn btn-primary" id="saveAlerts">保存报警设置</button>
      </div>
    </div>`;
}

function alertSettingsPayload() {
  const token = (byId("aToken")?.value || "").trim();
  const payload = {
    enabled: !!byId("aEnabled")?.checked,
    telegram_enabled: !!byId("aTelegramEnabled")?.checked,
    telegram_chat_id: byId("aChat")?.value.trim() || "",
    telegram_format: byId("aTelegramFormat")?.value || "plain",
    telegram_template: byId("aTelegramTemplate")?.value || "",
    telegram_message_thread_id: byId("aTelegramThread")?.value.trim() || "",
    telegram_disable_web_preview: !!byId("aTelegramPreview")?.checked,
    telegram_silent: !!byId("aTelegramSilent")?.checked,
    email_enabled: !!byId("aEmailEnabled")?.checked,
    email_from: byId("aEmailFrom")?.value.trim() || "",
    email_to: byId("aEmailTo")?.value.trim() || "",
    email_reply_to: byId("aEmailReplyTo")?.value.trim() || "",
    email_format: byId("aEmailFormat")?.value || "text",
    email_subject_template: byId("aEmailSubjectTemplate")?.value || "",
    email_template: byId("aEmailTemplate")?.value || "",
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
  const resendKey = (byId("aResendKey")?.value || "").trim();
  if (resendKey) payload.resend_api_key = resendKey;
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

async function testAlert(channel) {
  try {
    if ((await saveAlerts()) === false) return;
    await api("/api/alerts/test", { method: "POST", body: JSON.stringify({ channel }) });
    toast(channel === "email" ? "测试邮件已发送" : "测试 Telegram 已发送", "ok");
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
    const [d, health] = await Promise.all([api("/api/status?days=1"), api("/api/health")]);
    byId("sInfo").innerHTML =
      infoRow("名称", d.name || "聶.NET") +
      infoRow("版本", health.version ? `v${health.version}` : "-") +
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
async function loadDebugLogs() {
  const box = byId("sDebugLogs");
  if (!box) return;
  try {
    const data = await api("/api/debug/logs?limit=200");
    const logs = Array.isArray(data.logs) ? data.logs : [];
    box.innerHTML = `<details class="debug-log-details">
      <summary><span class="debug-log-summary-title">系统调试日志</span><span class="debug-log-count">${logs.length} 条记录</span></summary>
      <div class="debug-log-toolbar"><button class="btn btn-sm" id="debugLogsRefresh">刷新</button></div>
      ${logs.length ? `<div class="debug-log-scroll"><div class="debug-log-list">${logs.map(renderDebugLogRow).join("")}</div></div>` : '<p class="hint">暂无日志</p>'}
    </details>`;
    byId("debugLogsRefresh").onclick = loadDebugLogs;
  } catch (e) {
    errBox("sDebugLogs", e);
  }
}
function renderDebugLogRow(log) {
  const status = Number(log.status || 0);
  return `<div class="debug-log-row">
    <span class="dl-time" title="${escapeHtml(log.ts)}">${escapeHtml(formatLogTime(log.ts))}</span>
    <span class="dl-ip">${escapeHtml(log.ip || "-")}</span>
    <span class="dl-method ${escapeHtml(String(log.method || "").toLowerCase())}">${escapeHtml(log.method || "-")}</span>
    <span class="dl-path" title="${escapeHtml(log.path || "")}">${escapeHtml(log.path || "-")}</span>
    <span class="dl-summary">${escapeHtml(log.summary || "-")}</span>
    <span class="dl-status${status >= 400 ? " bad" : ""}">${escapeHtml(String(status || "-"))}</span>
    <span class="dl-actor">${escapeHtml(log.actor || "-")}</span>
  </div>`;
}
function formatLogTime(ts) {
  const value = Number(ts || 0);
  if (!value) return "-";
  return new Date(value * 1000).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
async function loadAccount() {
  const box = byId("sAccount");
  if (!box) return;
  try {
    const [account, loginState] = await Promise.all([
      api("/api/auth/account"),
      api("/api/login"),
    ]);
    const currentUsername = String(account.username || "admin");
    const source = account.credentials_source === "db" ? "后台账号" : "环境变量（首次修改后迁移）";
    box.innerHTML = `
      <div class="account-form">
        ${formField("当前管理员账号", `<input id="accountCurrentUsername" value="${escapeHtml(currentUsername)}" readonly aria-readonly="true" autocomplete="off">`)}
        ${formField("新管理员账号", '<input id="accountUsername" name="nie-sla-new-admin-username" autocomplete="off" autocapitalize="none" spellcheck="false" data-1p-ignore data-lpignore="true" placeholder="留空则保持当前账号">')}
        ${formField("当前密码", '<input id="accountCurrentPassword" type="password" autocomplete="current-password">')}
        ${formField("新密码", `<input id="accountNewPassword" type="password" minlength="${escapeHtml(account.password_min_length || 9)}" maxlength="256" pattern="(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{9,256}" autocomplete="new-password">`)}
        ${formField("确认新密码", `<input id="accountConfirmPassword" type="password" minlength="${escapeHtml(account.password_min_length || 9)}" maxlength="256" pattern="(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{9,256}" autocomplete="new-password">`)}
        ${loginState.totp_enabled ? formField("TOTP 验证码", '<input id="accountTotp" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code" required><p class="hint">当前已启用 TOTP，修改账号密码时必须填写当期 6 位验证码。</p>') : ""}
      </div>
      <p class="hint">密码至少 9 位，且必须包含大写字母、小写字母、数字和特殊符号。当前来源：${escapeHtml(source)}。保存后其他设备会退出登录。</p>
      <p class="account-save-status" id="accountSaveStatus" role="status" hidden></p>
      <button type="button" class="btn btn-primary btn-sm" id="saveAccount">更新账号密码</button>`;
    byId("saveAccount").onclick = saveAccount;
  } catch (error) {
    errBox("sAccount", error);
  }
}

function accountSaveStatus(message, type = 'info') {
  const status = byId('accountSaveStatus');
  if (!status) return;
  status.hidden = false;
  status.className = `account-save-status ${type}`;
  status.textContent = message;
}

async function saveAccount() {
  const button = byId("saveAccount");
  const currentUsername = byId("accountCurrentUsername")?.value.trim() || "";
  const requestedUsername = byId("accountUsername")?.value.trim() || "";
  const changeUsername = Boolean(requestedUsername);
  const username = requestedUsername || currentUsername;
  const currentPassword = byId("accountCurrentPassword")?.value || "";
  const newPassword = byId("accountNewPassword")?.value || "";
  const confirmPassword = byId("accountConfirmPassword")?.value || "";
  const totp = byId("accountTotp")?.value.trim() || "";
  if (!currentUsername || !/^[A-Za-z0-9._@-]{3,64}$/.test(username)) {
    accountSaveStatus("管理员账号需为 3-64 位字母、数字或 . _ @ -", "err");
    return toast("管理员账号格式不正确", "err");
  }
  if (!currentPassword || !newPassword || !confirmPassword) {
    accountSaveStatus("请完整填写当前密码和新密码", "err");
    return toast("请完整填写当前密码和新密码", "err");
  }
  if (newPassword.length < 9 || newPassword.length > 256 || !/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
    accountSaveStatus("密码至少 9 位，且必须包含大写字母、小写字母、数字和特殊符号", "err");
    return toast("密码至少 9 位，且必须包含大写字母、小写字母、数字和特殊符号", "err");
  }
  if (newPassword !== confirmPassword) {
    accountSaveStatus("两次输入的新密码不一致", "err");
    return toast("两次输入的新密码不一致", "err");
  }
  const totpInput = byId("accountTotp");
  if (totpInput && !/^\d{6}$/.test(totp)) {
    const message = totp ? "TOTP 验证码必须是 6 位数字" : "请输入当前的 6 位 TOTP 验证码";
    accountSaveStatus(message, "err");
    totpInput.focus();
    return toast(message, "err");
  }
  button.disabled = true;
  button.textContent = "更新中...";
  accountSaveStatus("正在验证并更新账号密码...", "info");
  let failed = false;
  try {
    const result = await apiTimeout("/api/auth/account", {
      method: "PATCH",
      cache: "no-store",
      body: JSON.stringify({
        username,
        current_username: currentUsername,
        change_username: changeUsername,
        current_password: currentPassword,
        new_password: newPassword,
        confirm_password: confirmPassword,
        totp,
      }),
    }, 30000);
    if (!result.logout_required) throw new Error("账号已更新，但服务端未确认会话撤销");
    if (result.username !== username || Boolean(result.username_changed) !== changeUsername) {
      throw new Error("服务端未确认管理员账号变更，请重新登录后检查");
    }
    clearAuth();
    byId("loginUsername").value = result.username;
    byId("loginPassword").value = "";
    showLogin("账号密码已更新，请使用新账号密码重新登录");
  } catch (error) {
    failed = true;
    const message = String(error?.message || "账号密码更新失败，请确认当前密码和 TOTP 后重试");
    accountSaveStatus(message, "err");
    toast(message, "err");
  } finally {
    if (document.body.contains(button)) {
      button.disabled = false;
      button.textContent = failed ? "重试更新" : "更新账号密码";
    }
  }
}

function setupSettingsTabs() {
  const buttons = [...document.querySelectorAll("[data-settings-tab]")];
  const panels = [...document.querySelectorAll("[data-settings-panel]")];
  const validTabs = new Set(buttons.map((button) => button.dataset.settingsTab));
  const savedTab = readStorage("localStorage", "nstatus.settingsTab", "");
  const initial = validTabs.has(savedTab)
    ? savedTab
    : "appearance";
  const activate = (tab) => {
    if (!validTabs.has(tab)) return;
    for (const button of buttons) {
      const active = button.dataset.settingsTab === tab;
      button.classList.toggle("on", active);
      button.setAttribute("aria-selected", String(active));
    }
    for (const panel of panels) {
      const active = panel.dataset.settingsPanel === tab;
      panel.classList.toggle("on", active);
      panel.hidden = !active;
    }
    writeStorage("localStorage", "nstatus.settingsTab", tab);
  };
  for (const button of buttons) button.onclick = () => activate(button.dataset.settingsTab);
  activate(initial);
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
    });
    if (d.session_id && d.expires_at) saveSession(d.session_id, d.expires_at);
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
  const overlay = byId("overlay");
  const modal = byId("modal");
  modalReturnFocus = document.activeElement?.isConnected ? document.activeElement : null;
  overlay.classList.add("on");
  overlay.setAttribute("aria-hidden", "false");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", modal.querySelector("h1, h2, h3, h4")?.textContent?.trim() || "管理操作");
  modal.tabIndex = -1;
  document.body.classList.add("admin-modal-open");
  Promise.resolve().then(() => {
    const initial = modal.querySelector('input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])');
    (initial || modal).focus();
  });
}
function closeModal() {
  const overlay = byId("overlay");
  const modal = byId("modal");
  const cancelHandler = modalCancelHandler;
  modalCancelHandler = null;
  const returnFocus = modalReturnFocus;
  const wasOpen = overlay.classList.contains("on");
  overlay.classList.remove("on");
  overlay.setAttribute("aria-hidden", "true");
  modal.innerHTML = "";
  modal.className = "modal";
  modal.removeAttribute("role");
  modal.removeAttribute("aria-modal");
  modal.removeAttribute("aria-label");
  modal.removeAttribute("tabindex");
  document.body.classList.remove("admin-modal-open");
  modalReturnFocus = null;
  if (wasOpen && returnFocus?.isConnected && typeof returnFocus.focus === "function") returnFocus.focus();
  if (cancelHandler) cancelHandler();
}
byId("loginBtn").onclick = login;
byId("loginUsername").onkeydown = (e) => {
  if (e.key === "Enter") login();
};
byId("loginPassword").onkeydown = (e) => {
  if (e.key === "Enter") login();
};
byId("loginTotp").onkeydown = (e) => {
  if (e.key === "Enter") login();
};
byId("githubLoginBtn").onclick = () => location.assign(`${API}/api/auth/github/start`);
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
byId("themeZip").onchange = () => uploadThemePackage(byId("themeZip").files?.[0]);
byId("themeTable").onclick = (event) => {
  const button = event.target.closest("button[data-theme-action]");
  if (!button) return;
  const theme = managedThemes.find(item => item.id === button.dataset.themeId);
  if (theme) confirmThemeAction(theme, button.dataset.themeAction);
};
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
byId("overlay").onkeydown = (event) => {
  if (event.key !== "Tab" || !byId("overlay").classList.contains("on")) return;
  const focusable = [...byId("modal").querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.hidden && element.getAttribute("aria-hidden") !== "true");
  if (!focusable.length) {
    event.preventDefault();
    byId("modal").focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
};
byId("overlay").oncontextmenu = (e) => {
  if (e.target === byId("overlay")) e.preventDefault();
};
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (document.querySelector('.nq-modal-root[data-admin-nq-report]')) closeAdminNodeQualityReport();
  else if (byId("overlay").classList.contains("on")) closeModal();
});
byId("tTable").onclick = (e) => {
  const b = e.target.closest("button[data-a]");
  if (!b) return;
  const t = targetByAction(b);
  if (b.dataset.a === "edit") targetModal(t);
  if (b.dataset.a === "toggle") toggleTarget(t);
  if (b.dataset.a === "delete") deleteTarget(t);
  if (b.dataset.a === "deploy") deploy(t, b);
  if (b.dataset.a === "task-nq") runAgentTask(t, "nodequality");
  if (b.dataset.a === "task-unlock") runAgentTask(t, "ip_unlock");
  if (b.dataset.a === "task-details") showAgentTaskDetails(t, b.dataset.taskAction || "");
  if (b.dataset.a === "task-cancel") forceStopAgentTask(b.dataset.taskId);
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
byId("savePingInterval").onclick = savePingInterval;
byId("latencyTable").onclick = (e) => {
  const button = e.target.closest("button[data-a]");
  if (!button) return;
  const row = button.closest("tr");
  const node = row?.classList?.contains("latency-builtin-row") ? latencyBuiltin : latencyNodes[Number(row?.dataset?.i)];
  if (!node) return;
  if (button.dataset.a === "latency-deploy") deployLatencyNode(node, button);
  if (button.dataset.a === "latency-edit") latencyNodeModal(node);
  if (button.dataset.a === "latency-toggle") toggleLatencyNode(node);
  if (button.dataset.a === "latency-delete") deleteLatencyNode(node);
};
setInterval(() => {
  if (byId("pg-targets")?.classList.contains("on")) loadAgentTasks();
}, 15_000);
window.__NIE_ADMIN_READY__ = true;
window.dispatchEvent(new Event("nie-admin-ready"));
setupSettingsTabs();
loadAuthConfig();
if (await completeGitHubRedirect()) {
  // OAuth completion owns the initial login state.
} else if (hasSession())
  api("/api/login", { method: "GET" })
    .then((d) => {
      if (d.session_valid) showApp();
      else showLogin();
    })
    .catch(() => showLogin());
else showLogin();
