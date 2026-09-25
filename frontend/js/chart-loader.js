// Loads the Chart.js vendor bundle off the critical path for the public
// status page. app.js initialises charts from the `nie-sla:chartjs-ready`
// event, so deferring the download only shifts when charts become
// interactive — never whether they render. The admin page keeps its own
// eager copy because its dashboards chart immediately.
(() => {
  const ready = () => window.dispatchEvent(new Event('nie-sla:chartjs-ready'));
  if (window.Chart) { ready(); return; }
  const inject = () => {
    if (window.Chart) { ready(); return; }
    const script = document.createElement('script');
    script.src = './vendor/chart.umd.min.js?v=4.4.9';
    script.async = true;
    script.onload = ready;
    script.onerror = () => console.warn('Chart.js 加载失败，响应时间图表已停用。');
    document.head.appendChild(script);
  };
  if (document.readyState === 'complete') inject();
  else window.addEventListener('load', inject, { once: true });
})();
