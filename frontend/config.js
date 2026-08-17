(() => {
  const config = window.NIE_SLA_CONFIG || window.NSTATUS_CONFIG || {};

  try {
    localStorage.removeItem('nie-sla.apiBase');
    localStorage.removeItem('nstatus.apiBase');
  } catch (_) {}
  window.NIE_SLA_CONFIG = config;
  window.NSTATUS_CONFIG = config;
  window.NIE_SLA_API_BASE = config.apiBase || window.NIE_SLA_API_BASE || window.NSTATUS_API_BASE || '';
  window.NSTATUS_API_BASE = window.NIE_SLA_API_BASE;
})();
