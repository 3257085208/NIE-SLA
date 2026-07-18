class ClassList {
  add() {}
  remove() {}
  toggle() {}
  contains() { return false; }
}

class ElementStub {
  constructor() {
    this.dataset = {};
    this.classList = new ClassList();
    this.style = {};
    this.hidden = false;
    this.value = '';
    this.innerHTML = '';
    this.textContent = '';
  }

  addEventListener() {}
  setAttribute() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  appendChild() {}
  remove() {}
  getContext() { return null; }
}

const body = new ElementStub();
body.dataset = { frontendTheme: 'cards' };

globalThis.document = {
  body,
  querySelector() { return null; },
  querySelectorAll() { return []; },
  getElementById() { return null; },
  createElement() { return new ElementStub(); },
};

globalThis.window = globalThis;
window.NSTATUS_API_BASE = '';
window.location = { search: '' };
window.addEventListener = () => {};
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.setInterval = () => 0;
globalThis.localStorage = {
  getItem() { return ''; },
  setItem() {},
  removeItem() {},
};
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, name: '聶.NET', days: [], targets: [], summaries: [], incidents: [] }),
});
globalThis.CSS = { escape: (value) => String(value) };

await import('../frontend/app.js');
await new Promise((resolve) => setTimeout(resolve, 0));

const adminSource = readFileSync(new URL('../frontend/js/admin.js', import.meta.url), 'utf8');
assert.match(adminSource, /if \(t\.type === "http"\) return '<span class="hint">不适用<\/span>'/);
assert.match(adminSource, /const agentTag = isWeb\s+\? notApplicable/);
assert.match(adminSource, /isWeb \? "" : '<button class="btn btn-xs" data-a="deploy">部署 Agent<\/button>'/);
assert.match(adminSource, /apiAdmin\("\/api\/targets\/order"/);
assert.match(adminSource, /data-sort-handle/);
assert.match(adminSource, /function bindTargetSorting\(\)/);

console.log('frontend app import smoke test passed');
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
