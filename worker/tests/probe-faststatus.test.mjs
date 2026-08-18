import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fastStatusDueInterval, groupTargetsByRegion, historyDueIntervalSec } from '../src/probe.js';

const NOW = 1_800_000_000;

test('local healthy target uses the economic fast-status interval', () => {
  assert.equal(fastStatusDueInterval({ probe_region: 'auto' }, null, NOW, 900, {}), 900);
});

test('region fast status is a fallback above the history cadence', () => {
  const target = { probe_region: 'hkg' };
  assert.equal(fastStatusDueInterval(target, null, NOW, 900, {}), 900);
  assert.equal(fastStatusDueInterval(target, null, NOW, 900, { FAST_STATUS_REGION_INTERVAL_SEC: '300' }), 900);
  assert.equal(fastStatusDueInterval(target, null, NOW, 900, { FAST_STATUS_REGION_INTERVAL_SEC: '1200' }), 1200);
});

test('recently failed target keeps the normal cadence', () => {
  const previous = { ok: 0, current_outage_started_at: NOW - 600 };
  assert.equal(fastStatusDueInterval({ probe_region: 'auto' }, previous, NOW, 900, {}), 120);
});

test('long outage target degrades to the down interval', () => {
  const previous = { ok: 0, current_outage_started_at: NOW - 1_800 };
  assert.equal(fastStatusDueInterval({ probe_region: 'auto' }, previous, NOW, 900, {}), 120);
  assert.equal(fastStatusDueInterval({ probe_region: 'auto' }, previous, NOW, 900, { FAST_STATUS_DOWN_INTERVAL_SEC: '300' }), 300);
});

test('healthy previous state keeps the base cadence', () => {
  const previous = { ok: 1, current_outage_started_at: null };
  assert.equal(fastStatusDueInterval({ probe_region: 'auto' }, previous, NOW, 900, {}), 900);
});

test('history probes keep region targets on the target cadence by default', () => {
  assert.equal(historyDueIntervalSec({ probe_region: 'auto', interval_sec: 300 }, {}), 900);
});

test('history probes can throttle region targets via env', () => {
  const target = { probe_region: 'hkg', interval_sec: 300 };
  assert.equal(historyDueIntervalSec(target, {}), 900);
  assert.equal(historyDueIntervalSec(target, { HISTORY_PROBE_REGION_INTERVAL_SEC: '600' }), 900);
  assert.equal(historyDueIntervalSec(target, { HISTORY_PROBE_REGION_INTERVAL_SEC: '1200' }), 1200);
});

test('failed targets use the short recovery cadence', () => {
  assert.equal(historyDueIntervalSec({ probe_region: 'auto', interval_sec: 900 }, {}, { ok: 0 }), 120);
  assert.equal(historyDueIntervalSec({ probe_region: 'auto', interval_sec: 900 }, { HISTORY_PROBE_DOWN_INTERVAL_SEC: '300' }, { ok: 0 }), 300);
});

test('region batching groups targets by probe region', () => {
  const targets = [
    { id: 'a', probe_region: 'apac' },
    { id: 'b', probe_region: 'wnam' },
    { id: 'c', probe_region: 'auto' },
    { id: 'd', probe_region: 'apac' },
  ];
  assert.deepEqual(groupTargetsByRegion(targets), [
    { region: 'apac', targets: [targets[0], targets[3]] },
    { region: 'wnam', targets: [targets[1]] },
    { region: 'auto', targets: [targets[2]] },
  ]);
});

test('region batching treats missing region as auto and keeps empty input stable', () => {
  assert.deepEqual(groupTargetsByRegion(), []);
  assert.deepEqual(groupTargetsByRegion([]), []);
  assert.deepEqual(groupTargetsByRegion([{ id: 'x' }]), [{ region: 'auto', targets: [{ id: 'x' }] }]);
});
