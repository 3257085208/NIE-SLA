import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOnboarding, readOnboardingState, resetOnboarding } from '../js/admin/onboarding.js';

function makeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function makeElement() {
  return {
    innerHTML: '',
    hidden: true,
    onclick: null,
    dataset: {},
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    focus() {},
    click() {
      this.onclick?.();
    },
    querySelector(selector) {
      if (selector === 'button') return this.buttons?.[0] || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector !== '[data-ob]') return [];
      this.buttons = [...this.innerHTML.matchAll(/data-ob="([a-z-]+)"/g)].map((match) => {
        const button = makeElement();
        button.dataset.ob = match[1];
        return button;
      });
      return this.buttons;
    },
  };
}

const root = makeElement();
const card = makeElement();
const documentStub = {
  getElementById(id) {
    if (id === 'onboarding') return root;
    if (id === 'onboardingCard') return card;
    return null;
  },
  querySelector() {
    return null;
  },
  addEventListener() {},
  body: { classList: { add() {}, remove() {} } },
};

globalThis.document = documentStub;
globalThis.localStorage = makeStorage();

function makeOnboarding(overrides = {}) {
  return createOnboarding({
    apiPublic: overrides.apiPublic || (async () => ({ targets: [] })),
    nav: overrides.nav || (() => {}),
    toast: overrides.toast || (() => {}),
    autoOpenDelayMs: 0,
  });
}

test('veteran mode completes the wizard without auto-opening again', async () => {
  resetOnboarding();
  const onboarding = makeOnboarding();
  onboarding.open('mode');
  assert.match(card.innerHTML, /我是第一次部署/, 'mode view must offer the novice entry');
  const veteran = card.buttons.find((button) => button.dataset.ob === 'veteran');
  veteran.click();
  assert.equal(root.hidden, true, 'wizard closes after choosing the veteran path');
  assert.equal(readOnboardingState()?.completed, true);
  await onboarding.maybeAutoOpen();
  assert.equal(root.hidden, true, 'completed wizard must not auto-open again');
});

test('novice flow walks through check, add, verify, security and done steps', async () => {
  resetOnboarding();
  const onboarding = makeOnboarding({ apiPublic: async () => ({ ok: true, version: '1.1.100', targets: [] }) });
  onboarding.open('mode');
  card.buttons.find((button) => button.dataset.ob === 'novice').click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(card.innerHTML, /环境自检/, 'novice flow starts with the self-check step');
  card.buttons.find((button) => button.dataset.ob === 'next').click();
  assert.match(card.innerHTML, /接入第一台 VPS/, 'second step explains the install flow');
  card.buttons.find((button) => button.dataset.ob === 'next').click();
  assert.match(card.innerHTML, /验证心跳/, 'third step verifies the first heartbeat');
  card.buttons.find((button) => button.dataset.ob === 'next').click();
  assert.match(card.innerHTML, /基础安全建议/, 'fourth step lists security basics');
  card.buttons.find((button) => button.dataset.ob === 'next').click();
  assert.match(card.innerHTML, /向导到这里就结束了/, 'final step summarises the wizard');
  card.buttons.find((button) => button.dataset.ob === 'finish').click();
  assert.equal(readOnboardingState()?.completed, true);
  assert.equal(readOnboardingState()?.mode, 'novice');
});

test('skip link finishes the wizard from any step', () => {
  resetOnboarding();
  const onboarding = makeOnboarding();
  onboarding.open('mode');
  card.buttons.find((button) => button.dataset.ob === 'novice').click();
  card.buttons.find((button) => button.dataset.ob === 'skip').click();
  assert.equal(readOnboardingState()?.mode, 'skipped');
  assert.equal(root.hidden, true);
});

test('maybeAutoOpen stays quiet for deployments that already have targets', async () => {
  resetOnboarding();
  const onboarding = makeOnboarding({ apiPublic: async () => ({ targets: [{ id: 'a' }] }) });
  await onboarding.maybeAutoOpen();
  assert.equal(root.hidden, true, 'existing deployments are not interrupted');
  assert.equal(readOnboardingState()?.completed, true);
});

test('maybeAutoOpen opens for a fresh deployment without targets', async () => {
  resetOnboarding();
  const onboarding = makeOnboarding({ apiPublic: async () => ({ targets: [] }) });
  await onboarding.maybeAutoOpen();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(root.hidden, false, 'fresh deployments see the mode chooser');
  assert.match(card.innerHTML, /欢迎使用 NIE-SLA/);
  onboarding.close();
});
