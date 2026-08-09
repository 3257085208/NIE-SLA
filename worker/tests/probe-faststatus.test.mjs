import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fastStatusDueInterval } from '../src/probe.js';

const NOW = 1_800_000_000;

test('local target uses the base fast-status interval', () => {
  assert.equal(fastStatusDueInterval({ probe_region: 'auto' }, null, NOW, 120, {}), 120);
});

test('region target is throttled to the region interval', () => {
  const target = { probe_region: 'hkg' };
  assert.equal(fastStatusDueInterval(target, null, NOW, 120, {}), 180);
  assert.equal(fastStatusDueInterval(target, null, NOW, 120, { FAST_STATUS_REGION_INTERVAL_SEC: '300' }), 300);
});

test('recently failed target keeps the normal cadence', () => {
  const previous = { ok: 0, current_outage_started_at: NOW - 600 };
  assert.equal(fastStatusDueInterval({ probe_region: 'auto' }, previous, NOW, 120, {}), 120);
});

test('long outage target degrades to the down interval', () => {
  const previous = { ok: 0, current_outage_started_at: NOW - 1_800 };
  assert.equal(fastStatusDueInterval({ probe_region: 'auto' }, previous, NOW, 120, {}), 600);
  assert.equal(fastStatusDueInterval({ probe_region: 'auto' }, previous, NOW, 120, { FAST_STATUS_DOWN_INTERVAL_SEC: '900' }), 900);
});

test('healthy previous state keeps the base cadence', () => {
  const previous = { ok: 1, current_outage_started_at: null };
  assert.equal(fastStatusDueInterval({ probe_region: 'auto' }, previous, NOW, 120, {}), 120);
});
