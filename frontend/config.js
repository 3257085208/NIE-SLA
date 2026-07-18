(() => {
  const config = window.NSTATUS_CONFIG || {};
  // API endpoints are deployment configuration, never user-controlled URL state.
  try {
    localStorage.removeItem('nstatus.apiBase');
  } catch (_) {}
  window.NSTATUS_CONFIG = config;
  window.NSTATUS_API_BASE = config.apiBase || window.NSTATUS_API_BASE || '';
})();
