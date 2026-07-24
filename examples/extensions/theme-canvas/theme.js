const siteName = document.getElementById('siteName');
const summary = document.getElementById('summary');
const targets = document.getElementById('targets');

window.addEventListener('message', (event) => {
  if (event.source !== parent || event.data?.type !== 'nstatus:status') return;
  render(event.data.payload || {});
});

function render(status) {
  const rows = Array.isArray(status.targets) ? status.targets : [];
  siteName.textContent = status.name || 'NIE-SLA';
  summary.textContent = `${rows.length} 个服务`;
  targets.replaceChildren(...rows.map((target) => {
    const card = document.createElement('article');
    card.className = Number(target.ok) === 1 ? 'up' : 'down';
    const title = document.createElement('h2');
    title.textContent = target.name || target.id || '未命名服务';
    const detail = document.createElement('p');
    detail.textContent = `${Number(target.ok) === 1 ? '运行正常' : '服务离线'} · ${Number.isFinite(Number(target.latency_ms)) ? `${Math.round(Number(target.latency_ms))} ms` : '-'}`;
    card.append(title, detail);
    return card;
  }));
  parent.postMessage({ type: 'nstatus:resize', height: document.documentElement.scrollHeight }, '*');
}

parent.postMessage({ type: 'nstatus:ready' }, '*');
