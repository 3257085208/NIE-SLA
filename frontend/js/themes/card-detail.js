export function cardThemeDetailPageHtml(cardHtml, sideHtml = '') {
  return `
    <section class="node-detail-page">
      <div class="node-detail-nav">
        <button type="button" class="node-detail-back" data-card-back>← 返回节点列表</button>
      </div>
      <div class="node-detail-layout">
        <aside class="node-detail-summary">
          ${cardHtml}
          ${sideHtml}
        </aside>
        <section class="node-detail-workspace">
          <div class="node-detail-chart-slot card-soft"></div>
          <div class="node-detail-checks-slot"></div>
        </section>
      </div>
    </section>
  `;
}

export function mountCardThemeDetailChecksPanel(panel, slot) {
  if (!panel || !slot) return;

  if (panel.parentNode !== slot) {
    slot.appendChild(panel);
  }

  if (!panel.classList.contains('node-detail-checks')) {
    panel.classList.add('node-detail-checks', 'is-collapsed');
  }

  const head = panel.querySelector('.checks-head');
  if (!head) return;

  let toggle = panel.querySelector('[data-checks-toggle]');
  if (!toggle) {
    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'checks-toggle';
    toggle.dataset.checksToggle = 'true';
    head.appendChild(toggle);
  }

  updateChecksToggle(panel, toggle);

  if (toggle.dataset.bound === 'true') return;
  toggle.dataset.bound = 'true';
  toggle.addEventListener('click', () => {
    panel.classList.toggle('is-collapsed');
    updateChecksToggle(panel, toggle);
  });
}

function updateChecksToggle(panel, toggle) {
  const collapsed = panel.classList.contains('is-collapsed');
  toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.textContent = collapsed ? '显示' : '隐藏';
}
