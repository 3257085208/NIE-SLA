import assert from 'node:assert/strict';
import { decodeAgentMetricsProtobuf } from '../src/telemetry-protobuf.js';

const metrics = concat([
  stringField(1, 'node-a'),
  varintField(2, 17),
  varintField(3, 29),
  fixedField(4, 12.5),
  messageField(5, [
    varintField(1, 4096), varintField(2, 2048), fixedField(3, 50),
    messageField(4, [varintField(1, 1024), varintField(2, 128), fixedField(3, 12.5)]),
  ]),
  messageField(6, [fixedField(1, 1.1), fixedField(2, 2.2), fixedField(3, 3.3)]),
  messageField(7, [fixedField(1, 100), fixedField(2, 50), fixedField(3, 50), fixedField(4, 50)]),
  messageField(8, [fixedField(1, 10), fixedField(2, 20), varintField(3, 1000), varintField(4, 2000), varintField(5, 3), varintField(6, 4)]),
  messageField(9, [fixedField(1, 30), fixedField(2, 40)]),
  varintField(10, 12345),
  messageField(11, [messageField(1, [fixedField(1, 1), fixedField(2, 2), fixedField(3, 0.5)])]),
  messageField(12, [
    varintField(1, 1700000000), fixedField(2, 10), fixedField(3, 20), fixedField(4, 30),
    fixedField(5, 1), fixedField(6, 2), fixedField(7, 3), varintField(8, 4), varintField(9, 5),
    fixedField(10, 6), fixedField(11, 7), fixedField(12, 45),
  ]),
  messageField(13, [
    stringField(1, 'CPU'), varintField(2, 4), varintField(3, 2), stringField(4, 'x86_64'),
    varintField(5, 8192), varintField(6, 1024), fixedField(7, 80), stringField(8, 'Linux'),
    stringField(9, '6.1'), stringField(10, 'kvm'), stringField(11, 'GPU'), varintField(12, 1),
    varintField(13, 1), fixedField(14, 55), messageField(20, [stringField(1, 't1'), stringField(2, 'CPU'), stringField(3, 'thermal'), fixedField(4, 55)]),
  ]),
  messageField(14, [
    stringField(1, 'dns'), varintField(2, 1700000000),
    messageField(3, [varintField(1, 0), varintField(3, 0)]),
    messageField(3, [varintField(1, 20), fixedField(2, 8.5), varintField(3, 1)]),
  ]),
]);

const frame = concat([
  varintField(1, 1),
  stringField(2, 'agent-a'),
  stringField(3, 'Agent A'),
  stringField(4, 'v1.1.22'),
  bytesField(5, new TextEncoder().encode('{"protocol":1}')),
  messageField(6, metrics),
]);

const decoded = decodeAgentMetricsProtobuf(frame);
assert.equal(decoded.agent_id, 'agent-a');
assert.equal(decoded.agent_label, 'Agent A');
assert.equal(decoded.agent_version, 'v1.1.22');
assert.deepEqual(decoded.capabilities, { protocol: 1 });
assert.equal(decoded.metrics.hostname, 'node-a');
assert.equal(decoded.metrics.memory.swap.used_mb, 128);
assert.equal(decoded.metrics.stats.cpu.max, 2);
assert.equal(decoded.metrics.samples[0].cpu_temp, 45);
assert.equal(decoded.metrics.vps_info.temperature_sensors[0].temp_c, 55);
assert.deepEqual(decoded.metrics.ping_series[0].latency_ms, [null, 8.5]);
assert.deepEqual(decoded.metrics.ping_series[0].ok, [0, 1]);

assert.throws(() => decodeAgentMetricsProtobuf(concat([varintField(1, 2), messageField(6, metrics)])), /协议版本/);
assert.throws(() => decodeAgentMetricsProtobuf(concat([fixedField(1, 1)])), /wire type/);
assert.ok(frame.length < JSON.stringify({
  agent_id: 'agent-a', agent_label: 'Agent A', agent_version: 'v1.1.22',
  capabilities: { protocol: 1 }, metrics: decoded.metrics,
}).length, 'representative Protobuf frame should be smaller than the JSON envelope');

console.log(`telemetry protobuf passed: ${frame.length} bytes`);

function varintField(field, value) { return concat([varint((field << 3) | 0), varint(value)]); }
function bytesField(field, value) { return concat([varint((field << 3) | 2), varint(value.length), value]); }
function stringField(field, value) { return bytesField(field, new TextEncoder().encode(value)); }
function messageField(field, value) { return bytesField(field, value instanceof Uint8Array ? value : concat(value)); }
function fixedField(field, value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return concat([varint((field << 3) | 1), bytes]);
}
function varint(value) {
  const out = [];
  let next = Number(value);
  while (next >= 0x80) { out.push((next & 0x7f) | 0x80); next = Math.floor(next / 128); }
  out.push(next);
  return Uint8Array.from(out);
}
function concat(parts) {
  const arrays = parts.flatMap(part => part instanceof Uint8Array ? [part] : part);
  const size = arrays.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of arrays) { result.set(part, offset); offset += part.length; }
  return result;
}
