import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
body.dataset = {};
globalThis.document = {
  body,
  querySelector() { return null; },
  querySelectorAll() { return []; },
  getElementById() { return null; },
  createElement() { return new ElementStub(); },
};
globalThis.window = globalThis;
window.NIE_SLA_API_BASE = '';
window.location = { search: '', href: 'https://status.example/' };
window.addEventListener = () => {};
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.setInterval = () => 0;
globalThis.localStorage = { getItem: () => '', setItem() {}, removeItem() {} };
let requestedUrl = '';
globalThis.fetch = async (url) => {
  requestedUrl = String(url);
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, name: 'NIE-SLA', days: [], targets: [], summaries: [], incidents: [] }),
  };
};
globalThis.CSS = { escape: (value) => String(value) };

await import('../app.js');
await new Promise((resolve) => setTimeout(resolve, 0));

assert.equal(requestedUrl, '/api/status?days=30&lite=1');
const configSource = readFileSync(new URL('../config.js', import.meta.url), 'utf8');
assert.doesNotMatch(configSource, /searchParams|get\(['"]api['"]\)/);
assert.doesNotMatch(configSource, /api-sla\.niekaixiang\.com/);

console.log('frontend app import smoke test passed');
