const SESSION_KEY = "nstatus_admin_session";
const SESSION_EXP_KEY = "nstatus_admin_session_exp";

export function createAdminClient({ apiBase, onUnauthorized }) {
  for (const storage of [sessionStorage, localStorage]) {
    storage.removeItem("nstatus_admin_t");
    storage.removeItem("nstatus_admin_ts");
  }

  function activeSessionId() {
    const session = sessionStorage.getItem(SESSION_KEY);
    const expiresAt = Number(sessionStorage.getItem(SESSION_EXP_KEY) || 0);
    if (session && expiresAt && Date.now() < expiresAt) return session;
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_EXP_KEY);
    return "";
  }

  function saveSession(id, expiresAt) {
    if (id && expiresAt) {
      sessionStorage.setItem(SESSION_KEY, id);
      sessionStorage.setItem(SESSION_EXP_KEY, String(Number(expiresAt) * 1000));
      return;
    }
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_EXP_KEY);
  }

  function clearAuth() {
    saveSession("", "");
  }

  async function fetchJson(url, options = {}, label = "API") {
    const response = await fetch(url, options);
    const text = await response.text();
    try {
      return { response, data: text ? JSON.parse(text) : {} };
    } catch {
      throw new Error(`${label} 返回非 JSON: ${text.slice(0, 120)}`);
    }
  }

  async function api(path, options = {}) {
    const noAuthReset = Boolean(options.noAuthReset);
    const config = { ...options };
    delete config.noAuthReset;
    const session = activeSessionId();
    config.headers = {
      "Content-Type": "application/json",
      ...(session ? { "x-admin-session": session } : {}),
      ...(options.headers || {}),
    };
    const { response, data } = await fetchJson(`${apiBase}${path}`, config);
    if (response.status === 401 && !noAuthReset) {
      clearAuth();
      onUnauthorized?.(data.error || "会话失效，请重新登录");
      throw new Error(data.error || "未授权");
    }
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function withTimeout(ms, timeoutMessage, task) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await task(controller.signal);
    } catch (error) {
      if (error.name === "AbortError") throw new Error(timeoutMessage);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function apiTimeout(path, options = {}, ms = 12_000) {
    return withTimeout(ms, "API 请求超时，请检查 Worker/CORS", (signal) =>
      api(path, { ...options, signal, noAuthReset: true }),
    );
  }

  function apiAdmin(path, options = {}, ms = 12_000) {
    return withTimeout(
      ms,
      `API 请求超过 ${Math.round(ms / 1000)} 秒，Worker 可能在冷启动或 D1/R2 较慢，请稍后重试`,
      (signal) => api(path, { ...options, signal }),
    );
  }

  function apiPublic(path, ms = 15_000) {
    return withTimeout(ms, `API 请求超过 ${Math.round(ms / 1000)} 秒`, async (signal) => {
      const { response, data } = await fetchJson(`${apiBase}${path}`, {
        signal,
        cache: "no-store",
      });
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    });
  }

  function apiAuth(path, options = {}, ms = 12_000) {
    return withTimeout(ms, "登录请求超时，请检查 Worker/CORS", async (signal) => {
      const { response, data } = await fetchJson(`${apiBase}${path}`, {
        ...options,
        signal,
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });
      if (!response.ok || data.ok === false)
        throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    });
  }

  return {
    api,
    hasSession: () => Boolean(activeSessionId()),
    activeSessionId,
    apiAdmin,
    apiPublic,
    apiAuth,
    apiTimeout,
    clearAuth,
    saveSession,
  };
}
