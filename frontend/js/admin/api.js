const TOKEN_KEY = "nstatus_admin_t";
const TOKEN_TS_KEY = "nstatus_admin_ts";
const SESSION_KEY = "nstatus_admin_session";
const SESSION_EXP_KEY = "nstatus_admin_session_exp";
const TOKEN_TTL_MS = 86_400_000;

export function createAdminClient({ apiBase, onUnauthorized }) {
  let token = loadToken();

  function loadToken() {
    const sessionValue = sessionStorage.getItem(TOKEN_KEY);
    const sessionSavedAt = Number(sessionStorage.getItem(TOKEN_TS_KEY) || 0);
    if (sessionValue && sessionSavedAt && Date.now() - sessionSavedAt < TOKEN_TTL_MS)
      return sessionValue;

    // One-time migration removes long-lived master credentials from localStorage.
    const legacyValue = localStorage.getItem(TOKEN_KEY);
    const legacySavedAt = Number(localStorage.getItem(TOKEN_TS_KEY) || 0);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_TS_KEY);
    if (!legacyValue || !legacySavedAt || Date.now() - legacySavedAt >= TOKEN_TTL_MS) return "";
    sessionStorage.setItem(TOKEN_KEY, legacyValue);
    sessionStorage.setItem(TOKEN_TS_KEY, String(legacySavedAt));
    return legacyValue;
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

  function setToken(value) {
    token = String(value || "").trim();
  }

  function persistToken() {
    if (!token) return;
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(TOKEN_TS_KEY, String(Date.now()));
  }

  function clearPersistedToken() {
    token = "";
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_TS_KEY);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_TS_KEY);
  }

  function clearAuth() {
    clearPersistedToken();
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
    const forceToken = Boolean(options.forceToken);
    const config = { ...options };
    delete config.noAuthReset;
    delete config.forceToken;
    const session = activeSessionId();
    // After TOTP login, prefer short-lived session only — do not keep shipping master ADMIN_TOKEN.
    const sendToken = forceToken || !session;
    config.headers = {
      "Content-Type": "application/json",
      ...(sendToken && token ? { Authorization: `Bearer ${token}` } : {}),
      ...(session ? { "x-admin-session": session } : {}),
      ...(options.headers || {}),
    };
    const { response, data } = await fetchJson(`${apiBase}${path}`, config);
    if (response.status === 401 && !noAuthReset) {
      clearAuth();
      onUnauthorized?.(data.error || "Token 失效，请重新登录");
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

  return {
    api,
    clearPersistedToken,
    hasSession: () => Boolean(activeSessionId()),
    activeSessionId,
    apiAdmin,
    apiPublic,
    apiTimeout,
    clearAuth,
    getToken: () => token,
    persistToken,
    saveSession,
    setToken,
  };
}
