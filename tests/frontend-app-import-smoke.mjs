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

const root = path.resolve(import.meta.dirname, '..');
const siblingFrontend = path.resolve(root, '..', 'frontend');
const frontendRoot = existsSync(path.join(siblingFrontend, 'AGENTS.md')) ? siblingFrontend : path.join(root, 'frontend');

await import(pathToFileURL(path.join(frontendRoot, 'app.js')).href);
await new Promise((resolve) => setTimeout(resolve, 0));

const adminSource = readFileSync(path.join(frontendRoot, 'js/admin.js'), 'utf8');
assert.match(adminSource, /if \(t\.type === "http"\) return '<span class="hint">不适用<\/span>'/);
assert.match(adminSource, /const agentTag = isWeb\s+\? notApplicable/);
if (adminSource.includes('btn-deploy')) {
  assert.match(adminSource, /class="btn btn-xs btn-deploy" data-a="deploy" data-target-id=/);
  assert.match(adminSource, /"\/api\/agent\/install-command\?target_id=" \+ encodeURIComponent\(t\.id\)/);
  assert.match(adminSource, /installModeModal\(t, command, rootlessCommand\)/);
  assert.match(adminSource, /trigger\.textContent = oldText;/);
  assert.doesNotMatch(adminSource, /showInstallProgress\(/);
} else {
  assert.match(adminSource, /isWeb \? "" : '<button class="btn btn-xs" data-a="deploy">部署 Agent<\/button>'/);
}
assert.match(adminSource, /apiAdmin\("\/api\/targets\/order"/);
assert.match(adminSource, /data-sort-handle/);
assert.match(adminSource, /function bindTargetSorting\(\)/);

console.log('frontend app import smoke test passed');
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
