(() => {
  try {
    const theme = localStorage.getItem('nstatus.frontendTheme');
    if (theme === 'classic' || theme === 'cards') document.body.dataset.frontendTheme = theme;
  } catch (_) {}
})();
