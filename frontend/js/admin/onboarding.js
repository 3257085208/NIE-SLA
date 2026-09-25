import { escapeHtml } from "../shared/html.js?v=20260925-visual7";

const STORAGE_KEY = "nie-sla.onboarding.v1";

export function readOnboardingState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writeOnboardingState(patch) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...(readOnboardingState() || {}), ...patch }));
  } catch (_) {}
}

export function resetOnboarding() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (_) {}
}

export function createOnboarding({ apiPublic, nav, toast, autoOpenDelayMs = 3_000 }) {
  let step = "mode";
  let check = null;
  let verifying = false;
  let verify = null;

  const root = () => document.getElementById("onboarding");
  const card = () => document.getElementById("onboardingCard");

  function finish(patch = {}) {
    writeOnboardingState({ completed: true, completedAt: Date.now(), ...patch });
    close();
    toast?.("新手向导已完成；可在 设置 → 安全 中重新打开", "ok");
  }

  function open(initial = "mode") {
    const el = root();
    if (!el) return;
    step = initial === "check" ? "mode" : initial;
    el.hidden = false;
    el.setAttribute("aria-hidden", "false");
    document.body.classList.add("onboarding-open");
    render();
    card()?.querySelector("button")?.focus?.();
  }

  function close() {
    const el = root();
    if (!el) return;
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
    document.body.classList.remove("onboarding-open");
  }

  function frame(title, body, actions, options = {}) {
    const progress = options.progress
      ? `<div class="onboarding-progress" aria-hidden="true">${options.progress}</div>`
      : "";
    const closeBtn = options.hideClose
      ? ""
      : '<button class="onboarding-close" type="button" data-ob="close" aria-label="关闭向导">×</button>';
    return `
      <div class="onboarding-head">
        <h2 id="onboardingTitle">${escapeHtml(title)}</h2>
        ${closeBtn}
      </div>
      ${progress}
      <div class="onboarding-body">${body}</div>
      <div class="onboarding-actions">${actions}</div>`;
  }

  function stepsBar(active) {
    const total = 5;
    let html = "";
    for (let index = 1; index <= total; index += 1) {
      html += `<i class="${index <= active ? "on" : ""}"></i>`;
    }
    return `<span class="onboarding-progress-bar">${html}</span><span class="onboarding-progress-text">第 ${active} / ${total} 步</span>`;
  }

  function modeView() {
    return frame(
      "欢迎使用 NIE-SLA",
      `<p class="onboarding-lead">这是你第一次部署吗？新手向导会用 5 个步骤带你完成环境自检、接入第一台 VPS 和基本安全设置；随时可以跳过。</p>
       <div class="onboarding-choice">
         <button class="btn btn-primary onboarding-choice-btn" type="button" data-ob="novice"><b>我是第一次部署</b><span>打开新手向导（约 3 分钟）</span></button>
         <button class="btn onboarding-choice-btn" type="button" data-ob="veteran"><b>我已熟悉，直接进入后台</b><span>跳过向导，不再自动弹出</span></button>
       </div>`,
      "",
      { hideClose: true },
    );
  }

  function checkView() {
    let rows = '<div class="loading">检查中...</div>';
    if (check?.error) {
      rows = `<div class="error">检查失败：${escapeHtml(check.error)}</div>`;
    } else if (check) {
      const version = check.version ? ` · v${escapeHtml(check.version)}` : "";
      const service = check.ok ? `<span class="ok">正常${version}</span>` : '<span class="warn">未通过</span>';
      const fleet = check.total > 0
        ? `${check.total} 个目标 · ${check.online} 个在线`
        : '<span class="warn">还没有添加 VPS</span>';
      rows = `
        <ul class="onboarding-checks">
          <li>Worker 服务：${service}</li>
          <li>监控目标：${fleet}</li>
          <li>后台会话：<span class="ok">已登录</span></li>
        </ul>
        <p class="hint">如果刚完成部署，"服务正常"即可继续；目标与在线数会随第一台 VPS 接入后更新。</p>`;
    }
    return frame(
      "第 1 步 · 环境自检",
      rows,
      `<button class="btn" type="button" data-ob="recheck">重新检查</button>
       <button class="btn btn-primary" type="button" data-ob="next">下一步</button>
       <button class="btn btn-link" type="button" data-ob="skip">跳过向导</button>`,
      { progress: stepsBar(1) },
    );
  }

  function addView() {
    return frame(
      "第 2 步 · 接入第一台 VPS",
      `<ol class="onboarding-steps">
         <li>打开左侧「探针」页，点击「+ 新增」填写 VPS 名称与地址并保存。</li>
         <li>在列表中点该 VPS 的「部署命令」，复制生成的一次性安装命令。</li>
         <li>SSH 登录 VPS，以 <code>root</code>（或 <code>sudo</code>）执行这条命令；脚本会自动下载并启动 Agent。</li>
       </ol>
       <p class="hint">安装命令 10 分钟内有效且每台只能使用一次；安装器会校验下载文件的 SHA-256。无 root 权限的机器可在弹窗中选择「无 root 版本」，按提示完成安装。</p>`,
      `<button class="btn" type="button" data-ob="back">上一步</button>
       <button class="btn btn-blue" type="button" data-ob="goto-targets">前往探针页</button>
       <button class="btn btn-primary" type="button" data-ob="next">我已完成安装</button>
       <button class="btn btn-link" type="button" data-ob="skip">跳过向导</button>`,
      { progress: stepsBar(2) },
    );
  }

  function verifyRows() {
    if (!verify) return '<p class="hint">安装完成后 Agent 首次上报通常需要 1-2 分钟。点击下方按钮检查。</p>';
    if (verify.error) return `<div class="error">检查失败：${escapeHtml(verify.error)}</div>`;
    if (verify.online > 0) {
      return `<div class="ok onboarding-verify-ok">已检测到 ${verify.online} 个在线 Agent（共 ${verify.total} 个目标）。接入成功！</div>`;
    }
    return `<div class="warn onboarding-verify-warn">暂未检测到在线 Agent（共 ${verify.total} 个目标）。可能仍在首次上报，请等待 1-2 分钟后重试；若持续离线，可 SSH 到 VPS 执行 <code>sudo cftz status</code> 查看 Agent 服务与日志。</div>`;
  }

  function verifyView() {
    return frame(
      "第 3 步 · 验证心跳",
      verifyRows(),
      `<button class="btn" type="button" data-ob="back">上一步</button>
       <button class="btn btn-blue" type="button" data-ob="verify" ${verifying ? "disabled" : ""}>${verifying ? "检查中..." : "检查在线状态"}</button>
       <button class="btn btn-primary" type="button" data-ob="next">下一步</button>
       <button class="btn btn-link" type="button" data-ob="skip">跳过向导</button>`,
      { progress: stepsBar(3) },
    );
  }

  function securityView() {
    return frame(
      "第 4 步 · 基础安全建议",
      `<ul class="onboarding-checks">
         <li>开启 <b>TOTP 两步验证</b>：设置 → 安全 → TOTP。</li>
         <li>把管理员密码保存到密码管理器，避免与其他服务复用。</li>
         <li>定期导出<b>加密备份</b>：设置 → 系统 → 备份与恢复。</li>
         <li>默认数据保留 72 小时；需要更长历史可在设置 → 系统中调整并使用外部存储建议。</li>
       </ul>`,
      `<button class="btn" type="button" data-ob="back">上一步</button>
       <button class="btn btn-blue" type="button" data-ob="goto-security">打开安全设置</button>
       <button class="btn btn-primary" type="button" data-ob="next">下一步</button>
       <button class="btn btn-link" type="button" data-ob="skip">跳过向导</button>`,
      { progress: stepsBar(4) },
    );
  }

  function doneView() {
    return frame(
      "第 5 步 · 完成",
      `<p class="onboarding-lead">向导到这里就结束了。之后你可以随时在 设置 → 安全 → 新手向导 重新打开。</p>
       <p class="hint">建议接下来：在「探针」页继续添加其余 VPS；在「设置 → 通知」配置离线与到期告警的接收方式。</p>`,
      `<button class="btn" type="button" data-ob="restart">重新查看</button>
       <button class="btn btn-primary" type="button" data-ob="finish">开始使用</button>`,
      { progress: stepsBar(5) },
    );
  }

  function render() {
    const c = card();
    if (!c) return;
    if (step === "mode") c.innerHTML = modeView();
    else if (step === "check") c.innerHTML = checkView();
    else if (step === "add") c.innerHTML = addView();
    else if (step === "verify") c.innerHTML = verifyView();
    else if (step === "security") c.innerHTML = securityView();
    else c.innerHTML = doneView();
    bind(c);
  }

  async function runCheck() {
    check = null;
    render();
    try {
      const [health, status] = await Promise.all([
        apiPublic("/api/health", 8000),
        apiPublic("/api/status?days=1&lite=1", 15000),
      ]);
      const fleet = Array.isArray(status?.targets) ? status.targets : [];
      check = {
        ok: Boolean(health?.ok),
        version: String(health?.version || ""),
        total: fleet.length,
        online: fleet.filter((target) => target.agent_online).length,
      };
    } catch (error) {
      check = { error: error?.message || "无法连接服务" };
    }
    render();
  }

  async function runVerify() {
    verifying = true;
    verify = null;
    render();
    try {
      const status = await apiPublic("/api/status?days=1&lite=1", 15000);
      const fleet = Array.isArray(status?.targets) ? status.targets : [];
      verify = { total: fleet.length, online: fleet.filter((target) => target.agent_online).length };
    } catch (error) {
      verify = { error: error?.message || "无法连接服务" };
    }
    verifying = false;
    render();
  }

  function bind(container) {
    container.querySelectorAll("[data-ob]").forEach((button) => {
      button.onclick = () => {
        const action = button.dataset.ob;
        if (action === "close") return close();
        if (action === "veteran") return finish({ mode: "veteran" });
        if (action === "skip") return finish({ mode: "skipped" });
        if (action === "finish") return finish({ mode: "novice" });
        if (action === "novice") {
          step = "check";
          return runCheck();
        }
        if (action === "recheck") return runCheck();
        if (action === "verify") return runVerify();
        if (action === "back") {
          step = step === "check" ? "mode" : step === "add" ? "check" : step === "verify" ? "add" : "verify";
          return render();
        }
        if (action === "next") {
          step = step === "check" ? "add" : step === "add" ? "verify" : step === "verify" ? "security" : "done";
          return render();
        }
        if (action === "goto-targets") {
          close();
          return nav?.("targets");
        }
        if (action === "goto-security") {
          close();
          nav?.("settings");
          setTimeout(() => document.querySelector('[data-settings-tab="security"]')?.click?.(), 60);
          return undefined;
        }
        if (action === "restart") {
          step = "check";
          return runCheck();
        }
        return undefined;
      };
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) close();
  });

  function isOpen() {
    const el = root();
    return Boolean(el && !el.hidden);
  }

  async function maybeAutoOpen() {
    const state = readOnboardingState();
    if (state?.completed) return;
    // Wait until the dashboard's first renders are done so the lightweight
    // onboarding probe never competes with the initial status build.
    const delay = Math.max(0, Number(autoOpenDelayMs) || 0);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    let total = null;
    try {
      const status = await apiPublic("/api/status?days=1&lite=1", 15_000);
      total = Array.isArray(status?.targets) ? status.targets.length : null;
    } catch (_) {
      total = null;
    }
    if (total && total > 0) {
      writeOnboardingState({ completed: true, autoSkippedAt: Date.now() });
      return;
    }
    if (delay) setTimeout(() => open("mode"), 300);
    else open("mode");
  }

  return { open, close, maybeAutoOpen, reset: resetOnboarding };
}
