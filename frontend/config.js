(() => {
  const config = window.NSTATUS_CONFIG || {};

  try {
    localStorage.removeItem('nstatus.apiBase');
  } catch (_) {}
  window.NSTATUS_CONFIG = config;
  window.NSTATUS_API_BASE = config.apiBase || window.NSTATUS_API_BASE || '';
})();
