(() => {
  const finish = () => {
    document.body?.classList.remove('theme-pending');
    document.body?.classList.add('theme-ready');
  };
  window.NIE_SLA_THEME_BOOT_FALLBACK = window.setTimeout(finish, 5000);
  window.NIE_SLA_THEME_BOOTSTRAP = fetch('/api/themes', {
    cache: 'no-store',
    credentials: 'omit',
    headers: { accept: 'application/json' },
  }).then(async response => {
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }).catch(error => ({ ok: false, error: String(error?.message || error) }));
})();
