(() => {
  const config = window.NSTATUS_CONFIG || {};
  const params = new URLSearchParams(window.location.search);
  const apiFromUrl = (params.get('api') || '').replace(/\/+$/, '');
  let storedApi = '';
  try {
    if (apiFromUrl) localStorage.setItem('nstatus.apiBase', apiFromUrl);
    storedApi = localStorage.getItem('nstatus.apiBase') || '';
  } catch (_) {}
  window.NSTATUS_CONFIG = config;
  window.NSTATUS_API_BASE = config.apiBase || apiFromUrl || storedApi || window.NSTATUS_API_BASE || '';
})();
