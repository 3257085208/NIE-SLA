import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { minMax, timeAgoSec } from '../js/shared/format.js';
import { hexToRgba } from '../js/shared/chart-data.js';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'real chart functions must remain available');
  return source.slice(from, to);
}

// Run the real rendering and column decoding functions without booting the page
// or making network requests. The expected statistics below are fixed fixtures.
const chartSource = [
  between('function metricRangeLabel(', 'function ensureChecksForSelectedRange('),
  between('function normalizeAgentMetricsPayload(', 'function renderVPSInfo('),
  between('function clearMetricChart()', 'function updateMetricsChart()'),
  between('function updateMetricsChart()', 'function getChartPointsForRange('),
].join('\n');
const now = 1_800_000_000;
class FixedDate extends Date {
  static now() { return now * 1000; }
}
const timestamp = (seconds) => new Date(seconds * 1000).toISOString();
const samples = [
  { ts: now - 26 * 3600, cpu: 100, mem: 100, disk: 100 },
  { ts: now - 8 * 3600, cpu: 98, mem: 98, disk: 98 },
  { ts: now - 2 * 3600, cpu: 70, mem: 70, disk: 70 },
  { ts: now - 900, cpu: 90, mem: 90, disk: 90 },
  { ts: now - 1, cpu: 2, mem: 2, disk: 2 },
];

function latestReport() {
  return {
    updated_at: timestamp(now - 1),
    cpu_percent: 2,
    memory: { percent: 2 },
    disk: { percent: 2 },
    stats: Object.fromEntries(['cpu', 'mem', 'disk'].map(metric => [metric, { avg: 1.5, min: 1, max: 2 }])),
  };
}

function render({ metric = 'cpu', range = '1h', latest = latestReport(), history = samples, format = 'rows', loading = false, error = '', chart = true } = {}) {
  const payload = { latest: structuredClone(latest), history: structuredClone(history) };
  if (format === 'columns') {
    const t0 = history[0]?.ts ?? now;
    const fields = [...new Set(history.flatMap(point => Object.keys(point).filter(key => key !== 'ts')))];
    payload.series = {
      t0,
      dt: history.map(point => point.ts - t0),
      fields,
      values: Object.fromEntries(fields.map(field => [field, history.map(point => point[field])])),
    };
    delete payload.history;
  }
  const state = {
    selectedMetric: metric,
    selectedMetricRange: range,
    selectedName: 'Metric fixture',
    targetMetrics: payload,
    metricsLoading: loading,
    metricsError: error,
    chart: chart ? { data: { datasets: [] }, options: { scales: { x: {}, y: {} } }, update() {} } : null,
  };
  const els = Object.fromEntries(['chartTitle', 'chartServiceName', 'chartMeta', 'chartAvg'].map(key => [key, { textContent: '' }]));
  const context = vm.createContext({
    state, els, Date: FixedDate, minMax, timeAgoSec, hexToRgba,
    updateChartZoomButton() {},
  });
  vm.runInContext(chartSource, context);
  vm.runInContext('state.targetMetrics = normalizeAgentMetricsPayload(state.targetMetrics); updateMetricsChart();', context);
  return {
    meta: els.chartMeta.textContent,
    current: els.chartAvg.textContent,
    datasets: JSON.parse(JSON.stringify(state.chart?.data.datasets || [])),
  };
}

function summary(result, { average, minimum, maximum, count }) {
  assert.ok(result.meta.includes('平均 ' + average + '%'), result.meta);
  assert.ok(result.meta.includes('最小 ' + minimum + '%'), result.meta);
  assert.ok(result.meta.includes('最大 ' + maximum + '%'), result.meta);
  assert.ok(result.meta.endsWith(count + ' 个采样点'), result.meta);
}

const ranges = [
  { range: '1h', average: '46.0', maximum: '90.0', values: [90, 2] },
  { range: '6h', average: '54.0', maximum: '90.0', values: [70, 90, 2] },
  { range: '24h', average: '65.0', maximum: '98.0', values: [98, 70, 90, 2] },
];
for (const metric of ['cpu', 'mem', 'disk']) {
  for (const format of ['rows', 'columns']) {
    for (const expected of ranges) {
      test(metric + ' ' + format + ' ' + expected.range + ' summary follows the plotted window', () => {
        const result = render({ metric, format, range: expected.range });
        summary(result, { ...expected, minimum: '2.0', count: expected.values.length });
        assert.deepEqual(result.datasets[0].data.map(point => point.y), expected.values);
        assert.equal(result.current, '当前：2.0%');
      });
    }
  }
}

test('reports without batch statistics retain the history summary', () => {
  const latest = latestReport();
  delete latest.stats;
  summary(render({ latest }), { average: '46.0', minimum: '2.0', maximum: '90.0', count: 2 });
});

test('zero samples are counted even when the latest batch has nonzero statistics', () => {
  const result = render({ history: [{ ts: now - 2, cpu: 0 }, { ts: now - 1, cpu: 0 }] });
  summary(result, { average: '0.0', minimum: '0.0', maximum: '0.0', count: 2 });
  assert.deepEqual(result.datasets[0].data.map(point => point.y), [0, 0]);
});

test('display rounding does not change the precision of plotted samples', () => {
  const result = render({ history: [{ ts: now - 2, cpu: 90.125 }, { ts: now - 1, cpu: 2.375 }] });
  summary(result, { average: '46.3', minimum: '2.4', maximum: '90.1', count: 2 });
  assert.deepEqual(result.datasets[0].data.map(point => point.y), [90.125, 2.375]);
});

test('a recent latest-only report retains its single plotted point', () => {
  const result = render({ latest: { ...latestReport(), cpu_percent: 17 }, history: [] });
  summary(result, { average: '17.0', minimum: '17.0', maximum: '17.0', count: 1 });
  assert.deepEqual(result.datasets[0].data.map(point => point.y), [17]);
});

test('old history is not replaced by batch statistics', () => {
  const result = render({ history: [samples[0]] });
  assert.match(result.meta, /1h内暂无采样点/);
  assert.deepEqual(result.datasets, []);
});

test('an old latest-only report does not invent a point in the selected window', () => {
  const result = render({ latest: { ...latestReport(), updated_at: timestamp(now - 7200) }, history: [] });
  assert.match(result.meta, /1h内暂无采样点/);
  assert.deepEqual(result.datasets, []);
});

test('missing latest data retains the installation hint', () => {
  const result = render({ latest: null });
  assert.match(result.meta, /暂无监控数据/);
  assert.equal(result.current, '-');
  assert.deepEqual(result.datasets, []);
});

test('the summary remains available before Chart is ready', () => {
  summary(render({ chart: false }), { average: '46.0', minimum: '2.0', maximum: '90.0', count: 2 });
});

test('loading clears the summary and chart', () => {
  const result = render({ loading: true });
  assert.match(result.meta, /正在加载最近 1 小时/);
  assert.equal(result.current, '-');
  assert.deepEqual(result.datasets, []);
});

test('a request error remains visible', () => {
  const result = render({ error: 'fixture request failed' });
  assert.equal(result.meta, 'fixture request failed');
  assert.equal(result.current, '-');
  assert.deepEqual(result.datasets, []);
});

for (const control of [
  { metric: 'load', points: [{ load1: 1, load5: 2, load15: 3 }, { load1: 4, load5: 5, load15: 6 }], expected: [[1, 4], [2, 5], [3, 6]] },
  { metric: 'net', points: [{ net_rx: 10, net_tx: 20 }, { net_rx: 30, net_tx: 40 }], expected: [[10, 30], [20, 40]] },
  { metric: 'diskio', points: [{ disk_read: 10, disk_write: 20 }, { disk_read: 30, disk_write: 40 }], expected: [[10, 30], [20, 40]] },
  { metric: 'conns', points: [{ tcp_conns: 10, udp_conns: 20 }, { tcp_conns: 30, udp_conns: 40 }], expected: [[10, 30], [20, 40]] },
  { metric: 'proc', points: [{ process_count: 10 }, { process_count: 30 }], expected: [[10, 30]] },
]) {
  test(control.metric + ' retains its dedicated chart series', () => {
    const history = control.points.map((point, index) => ({ ts: now - 2 + index, ...point }));
    const result = render({ metric: control.metric, history });
    assert.deepEqual(result.datasets.map(dataset => dataset.data.map(point => point.y)), control.expected);
  });
}
