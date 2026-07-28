const siteName = document.getElementById('siteName');
const summary = document.getElementById('summary');
const targetsRoot = document.getElementById('targets');

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object' || message.type !== 'nie-sla:status') return;
  renderStatus(message.payload);
});

function renderStatus(status) {
  const targets = Array.isArray(status?.targets) ? status.targets : [];
  siteName.textContent = String(status?.name || 'NIE-SLA');
  summary.textContent = `${targets.length} 个监控目标`;
  targetsRoot.replaceChildren(...targets.map(targetCard));
  parent.postMessage({ type: 'nie-sla:resize', height: document.documentElement.scrollHeight }, '*');
}

function targetCard(target) {
  const card = document.createElement('article');
  const ok = Number(target?.ok) === 1;
  const name = document.createElement('strong');
  const state = document.createElement('span');
  card.dataset.ok = String(ok);
  name.textContent = String(target?.name || target?.id || '未命名目标');
  state.textContent = ok ? '运行正常' : '需要检查';
  card.append(name, state);
  return card;
}

parent.postMessage({ type: 'nie-sla:ready' }, '*');
