import assert from 'node:assert/strict';
import { pingSeriesToPoints } from '../src/metrics.js';

const t0 = Math.floor(Date.now() / 1000) - 1000;
const series = Array.from({ length: 5 }, (_, target) => ({
  target_id: `target-${target + 1}`,
  t0,
  dt: Array.from({ length: 1000 }, (_, index) => index),
  latency_ms: Array.from({ length: 1000 }, (_, index) => index % 17 === 0 ? null : 20 + index % 30),
  ok: Array.from({ length: 1000 }, (_, index) => index % 17 === 0 ? 0 : 1),
}));
const decoded = pingSeriesToPoints(series);
assert.equal(decoded.error, '');
assert.equal(decoded.pings.length, 5000);
assert.equal(decoded.pings[0].latency_ms, null);
assert.equal(decoded.pings[0].ok, 0);
assert.ok(JSON.stringify({ ping_series: series }).length < 200_000, 'a full 5000-point report must fit the Worker body limit');

const normalReport = series.map(item => ({
  ...item,
  dt: item.dt.slice(0, 300),
  latency_ms: item.latency_ms.slice(0, 300),
  ok: item.ok.slice(0, 300),
}));
assert.equal(pingSeriesToPoints(normalReport).pings.length, 1500, 'one 5-minute report at 1s across five targets has 1500 points');
assert.ok(JSON.stringify({ ping_series: normalReport }).length * 100 < 20_000_000, '100-node aggregate payload stays bounded');

assert.match(pingSeriesToPoints([{ target_id: 'x', t0, dt: [0], latency_ms: [], ok: [1] }]).error, /matching lengths/);
assert.match(pingSeriesToPoints([{ target_id: 'x', t0, dt: [-1], latency_ms: [1], ok: [1] }]).error, /invalid sample/);
assert.match(pingSeriesToPoints([{ target_id: 'x', t0, dt: [0], latency_ms: [1], ok: [2] }]).error, /invalid sample/);
assert.match(pingSeriesToPoints([...series, { ...series[0], target_id: 'overflow', dt: [0], latency_ms: [1], ok: [1] }]).error, /max 5000/);

const clamped = pingSeriesToPoints([{
  target_id: 'target-1',
  t0,
  dt: [0, 1, 2, 3],
  latency_ms: [1500, 999, -5, Number.NaN],
  ok: [1, 1, 1, 1],
}]);
assert.equal(clamped.error, '', 'out-of-range latencies must be clamped, not rejected');
assert.deepEqual(clamped.pings.map(ping => ping.latency_ms), [null, 999, null, null], 'latencies above 1000ms clamp to null like legacy normalizePingPoint');
assert.deepEqual(clamped.pings.map(ping => ping.ok), [0, 1, 0, 0], 'clamped samples are loss samples (ok=0)');

console.log('compact Ping series tests passed');
