(() => {
  try {
    const theme = localStorage.getItem('nstatus.frontendTheme');
    if (theme === 'classic') document.body.dataset.frontendTheme = theme;
  } catch (_) {}
})();
