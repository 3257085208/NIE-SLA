(() => {
  const fallback = window.setTimeout(() => {
    document.body.classList.remove('theme-pending');
    document.body.classList.add('theme-ready');
  }, 12_000);

  window.NSTATUS_THEME_BOOT_FALLBACK = fallback;
  window.NSTATUS_EXTENSION_BOOTSTRAP = fetch('/api/extensions', { cache: 'no-store' })
    .then(async response => {
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    })
    .catch(error => ({ ok: false, error: String(error?.message || error) }));
})();
