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

  if (window.NIE_SLA_TURNSTILE_BOOTSTRAP) return;
  window.NIE_SLA_TURNSTILE_BOOTSTRAP = (async () => {
    try {
      const config = await fetch('/api/turnstile/config', { cache: 'no-store' }).then(r => r.json());
      if (!config?.enabled || !config?.site_key) return;
      if (sessionStorage.getItem('ts_verified')) return;
      const verifiedCookie = document.cookie.split(';').some(c => c.trim().startsWith('ts_ok='));
      if (verifiedCookie) return;
      await new Promise((resolve, reject) => {
        const overlay = document.createElement('div');
        overlay.id = 'turnstile-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--page_background,#f4f8fc);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:20px;font-family:inherit';
        const title = document.createElement('p');
        title.textContent = '人机验证';
        title.style.cssText = 'font-size:18px;font-weight:600;color:var(--ink,#101827)';
        const widget = document.createElement('div');
        widget.className = 'cf-turnstile';
        widget.setAttribute('data-sitekey', config.site_key);
        widget.setAttribute('data-callback', 'onTurnstileSuccess');
        overlay.appendChild(title);
        overlay.appendChild(widget);
        document.body.appendChild(overlay);
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        document.head.appendChild(script);
        window.onTurnstileSuccess = async (token) => {
          try {
            const res = await fetch('/api/turnstile/verify', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token }),
            });
            const data = await res.json();
            if (data.ok) {
              sessionStorage.setItem('ts_verified', '1');
              overlay.remove();
              resolve();
            } else {
              reject(new Error(data.error || '验证失败'));
            }
          } catch (err) { reject(err); }
        };
      });
    } catch (_) {}
  })();
})();
