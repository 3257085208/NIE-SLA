(() => {
  const loginButton = document.getElementById("loginBtn");
  const loginError = document.getElementById("loginErr");
  if (!loginButton || !loginError) return;

  let startupFailure = false;

  function showStartupError() {
    if (window.__NIE_ADMIN_READY__) return;
    startupFailure = true;
    loginError.textContent = "后台脚本加载失败，请刷新页面；若仍失败，请检查部署是否完整。";
    loginError.style.display = "block";
  }

  loginButton.onclick = (event) => {
    if (window.__NIE_ADMIN_READY__) return;
    event.preventDefault();
    showStartupError();
  };

  window.addEventListener("error", (event) => {
    const source = event.target;
    if (source instanceof HTMLScriptElement && !window.__NIE_ADMIN_READY__) showStartupError();
  }, true);
  window.addEventListener("unhandledrejection", () => {
    if (!window.__NIE_ADMIN_READY__) showStartupError();
  });
  window.addEventListener("nie-admin-ready", () => {
    if (startupFailure) {
      loginError.textContent = "";
      loginError.style.display = "none";
    }
  }, { once: true });
})();
