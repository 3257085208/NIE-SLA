(() => {
  const config = window.NSTATUS_CONFIG || {};
  // SECURITY: never allow URL/query overrides of API base in any shipped copy.
  try { localStorage.removeItem('nstatus.apiBase'); } catch (_) {}
  window.NSTATUS_CONFIG = config;
  window.NSTATUS_API_BASE = config.apiBase || window.NSTATUS_API_BASE || '';
})();
