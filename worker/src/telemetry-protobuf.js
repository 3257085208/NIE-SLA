const MAX_FRAME_BYTES = 220_000;

// This decoder mirrors agent/src/telemetry_proto.rs.  It deliberately accepts
// only the fields used by the Agent telemetry schema and skips unknown fields
// so a future additive schema change can remain backward compatible.
export function decodeAgentMetricsProtobuf(input) {
  const bytes = toBytes(input);
  if (bytes.byteLength > MAX_FRAME_BYTES) throw new Error('metrics 数据过大');
  const reader = new ProtoReader(bytes);
  const body = {
    agent_id: '',
    agent_label: '',
    agent_version: '',
    capabilities: null,
    metrics: null,
  };
  let version = 0;
  while (!reader.done()) {
    const [field, wire] = reader.key();
    switch (field) {
      case 1:
        version = reader.varint();
        break;
      case 2:
        body.agent_id = reader.string();
        break;
      case 3:
        body.agent_label = reader.string();
        break;
      case 4:
        body.agent_version = reader.string();
        break;
      case 5:
        body.capabilities = parseJson(reader.bytes());
        break;
      case 6:
        body.metrics = decodeMetrics(reader.message());
        break;
      default:
        reader.skip(wire);
    }
  }
  if (version !== 1) throw new Error('不支持的 Agent Protobuf 协议版本');
  if (!body.metrics || typeof body.metrics !== 'object') throw new Error('缺少 metrics 对象');
  return body;
}

function decodeMetrics(reader) {
  const value = {
    hostname: '',
    process_count: 0,
    thread_count: 0,
    cpu_percent: 0,
    memory: { total_mb: 0, used_mb: 0, percent: 0 },
    load: { load1: 0, load5: 0, load15: 0 },
    disk: { total_gb: 0, used_gb: 0, avail_gb: 0, percent: 0 },
    net: { rx_bytes_sec: 0, tx_bytes_sec: 0, rx_bytes: 0, tx_bytes: 0, tcp_conns: 0, udp_conns: 0 },
    diskio: { read_bytes_sec: 0, write_bytes_sec: 0 },
    uptime_sec: 0,
  };
  const samples = [];
  const pingSeries = [];
  while (!reader.done()) {
    const [field, wire] = reader.key();
    switch (field) {
      case 1: value.hostname = reader.string(); break;
      case 2: value.process_count = reader.varint(); break;
      case 3: value.thread_count = reader.varint(); break;
      case 4: value.cpu_percent = reader.fixed64(); break;
      case 5: value.memory = decodeMemory(reader.message()); break;
      case 6: value.load = decodeLoad(reader.message()); break;
      case 7: value.disk = decodeDisk(reader.message()); break;
      case 8: value.net = decodeNet(reader.message()); break;
      case 9: value.diskio = decodeDiskio(reader.message()); break;
      case 10: value.uptime_sec = reader.varint(); break;
      case 11: value.stats = decodeAggStats(reader.message()); break;
      case 12: samples.push(decodeSample(reader.message())); break;
      case 13: value.vps_info = decodeVpsInfo(reader.message()); break;
      case 14: pingSeries.push(decodePingSeries(reader.message())); break;
      default: reader.skip(wire);
    }
  }
  if (samples.length) value.samples = samples;
  if (pingSeries.length) value.ping_series = pingSeries;
  return value;
}

function decodeMemory(reader) {
  const value = { total_mb: 0, used_mb: 0, percent: 0 };
  while (!reader.done()) {
    const [field, wire] = reader.key();
    if (field === 1) value.total_mb = reader.varint();
    else if (field === 2) value.used_mb = reader.varint();
    else if (field === 3) value.percent = reader.fixed64();
    else if (field === 4) value.swap = decodeSwap(reader.message());
    else reader.skip(wire);
  }
  return value;
}

function decodeSwap(reader) {
  const value = { total_mb: 0, used_mb: 0, percent: 0 };
  while (!reader.done()) {
    const [field, wire] = reader.key();
    if (field === 1) value.total_mb = reader.varint();
    else if (field === 2) value.used_mb = reader.varint();
    else if (field === 3) value.percent = reader.fixed64();
    else reader.skip(wire);
  }
  return value;
}

function decodeLoad(reader) {
  const value = { load1: 0, load5: 0, load15: 0 };
  while (!reader.done()) {
    const [field, wire] = reader.key();
    if (field === 1) value.load1 = reader.fixed64();
    else if (field === 2) value.load5 = reader.fixed64();
    else if (field === 3) value.load15 = reader.fixed64();
    else reader.skip(wire);
  }
  return value;
}

function decodeDisk(reader) {
  const value = { total_gb: 0, used_gb: 0, avail_gb: 0, percent: 0 };
  while (!reader.done()) {
    const [field, wire] = reader.key();
    if (field === 1) value.total_gb = reader.fixed64();
    else if (field === 2) value.used_gb = reader.fixed64();
    else if (field === 3) value.avail_gb = reader.fixed64();
    else if (field === 4) value.percent = reader.fixed64();
    else reader.skip(wire);
  }
  return value;
}

function decodeNet(reader) {
  const value = { rx_bytes_sec: 0, tx_bytes_sec: 0, rx_bytes: 0, tx_bytes: 0, tcp_conns: 0, udp_conns: 0 };
  while (!reader.done()) {
    const [field, wire] = reader.key();
    if (field === 1) value.rx_bytes_sec = reader.fixed64();
    else if (field === 2) value.tx_bytes_sec = reader.fixed64();
    else if (field === 3) value.rx_bytes = reader.varint();
    else if (field === 4) value.tx_bytes = reader.varint();
    else if (field === 5) value.tcp_conns = reader.varint();
    else if (field === 6) value.udp_conns = reader.varint();
    else reader.skip(wire);
  }
  return value;
}

function decodeDiskio(reader) {
  const value = { read_bytes_sec: 0, write_bytes_sec: 0 };
  while (!reader.done()) {
    const [field, wire] = reader.key();
    if (field === 1) value.read_bytes_sec = reader.fixed64();
    else if (field === 2) value.write_bytes_sec = reader.fixed64();
    else reader.skip(wire);
  }
  return value;
}

function decodeAggStats(reader) {
  const keys = ['cpu', 'mem', 'disk', 'load', 'net_rx', 'net_tx', 'tcp_conns', 'udp_conns', 'disk_read', 'disk_write'];
  const value = {};
  while (!reader.done()) {
    const [field, wire] = reader.key();
    if (field >= 1 && field <= keys.length) value[keys[field - 1]] = decodeStat(reader.message());
    else reader.skip(wire);
  }
  return value;
}

function decodeStat(reader) {
  const value = { avg: 0, max: 0, min: 0 };
  while (!reader.done()) {
    const [field, wire] = reader.key();
    if (field === 1) value.avg = reader.fixed64();
    else if (field === 2) value.max = reader.fixed64();
    else if (field === 3) value.min = reader.fixed64();
    else reader.skip(wire);
  }
  return value;
}

function decodeSample(reader) {
  const value = {
    ts: 0, cpu: 0, mem: 0, disk: 0, load: 0, net_rx: 0, net_tx: 0,
    tcp_conns: 0, udp_conns: 0, disk_read: 0, disk_write: 0,
  };
  const optional = ['cpu_temp', 'gpu_temp', 'gpu_util', 'motherboard_temp', 'disk_temp', 'chipset_temp'];
  while (!reader.done()) {
    const [field, wire] = reader.key();
    if (field === 1) value.ts = reader.varint();
    else if (field >= 2 && field <= 7) value[['cpu', 'mem', 'disk', 'load', 'net_rx', 'net_tx'][field - 2]] = reader.fixed64();
    else if (field === 8) value.tcp_conns = reader.varint();
    else if (field === 9) value.udp_conns = reader.varint();
    else if (field === 10) value.disk_read = reader.fixed64();
    else if (field === 11) value.disk_write = reader.fixed64();
    else if (field >= 12 && field <= 17) value[optional[field - 12]] = reader.fixed64();
    else reader.skip(wire);
  }
  return value;
}

function decodeVpsInfo(reader) {
  const value = {
    cpu_model: '', cpu_cores: 0, physical_cores: 0, arch: '', total_mem_mb: 0,
    total_swap_mb: 0, total_disk_gb: 0, os: '', kernel: '', virtualization: '',
  };
  const optional = ['cpu_temp_c', 'gpu_temp_c', 'gpu_util', 'motherboard_temp_c', 'disk_temp_c', 'chipset_temp_c'];
  while (!reader.done()) {
    const [field, wire] = reader.key();
    if (field === 1) value.cpu_model = reader.string();
    else if (field === 2) value.cpu_cores = reader.varint();
    else if (field === 3) value.physical_cores = reader.varint();
    else if (field === 4) value.arch = reader.string();
    else if (field === 5) value.total_mem_mb = reader.varint();
    else if (field === 6) value.total_swap_mb = reader.varint();
    else if (field === 7) value.total_disk_gb = reader.fixed64();
    else if (field === 8) value.os = reader.string();
    else if (field === 9) value.kernel = reader.string();
    else if (field === 10) value.virtualization = reader.string();
    else if (field === 11) value.gpu_name = reader.string();
    else if (field === 12) value.gpu_count = reader.varint();
    else if (field === 13) value.gpu_accessible = reader.varint() === 1;
    else if (field >= 14 && field <= 19) value[optional[field - 14]] = reader.fixed64();
    else if (field === 20) {
      const sensor = decodeSensor(reader.message());
      (value.temperature_sensors ||= []).push(sensor);
    } else reader.skip(wire);
  }
  return value;
}

function decodeSensor(reader) {
  const value = { id: '', label: '', kind: '', temp_c: 0 };
  while (!reader.done()) {
    const [field, wire] = reader.key();
    if (field === 1) value.id = reader.string();
    else if (field === 2) value.label = reader.string();
    else if (field === 3) value.kind = reader.string();
    else if (field === 4) value.temp_c = reader.fixed64();
    else reader.skip(wire);
  }
  return value;
}

function decodePingSeries(reader) {
  const value = { target_id: '', t0: 0, dt: [], latency_ms: [], ok: [] };
  while (!reader.done()) {
    const [field, wire] = reader.key();
    if (field === 1) value.target_id = reader.string();
    else if (field === 2) value.t0 = reader.varint();
    else if (field === 3) {
      const point = decodePingPoint(reader.message());
      value.dt.push(point.dt);
      value.latency_ms.push(point.latency_ms);
      value.ok.push(point.ok);
    } else reader.skip(wire);
  }
  return value;
}

function decodePingPoint(reader) {
  const value = { dt: 0, latency_ms: null, ok: 0 };
  while (!reader.done()) {
    const [field, wire] = reader.key();
    if (field === 1) value.dt = reader.varint();
    else if (field === 2) value.latency_ms = reader.fixed64();
    else if (field === 3) value.ok = reader.varint() === 1 ? 1 : 0;
    else reader.skip(wire);
  }
  return value;
}

function parseJson(bytes) {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    throw new Error('Agent Protobuf capabilities 无效');
  }
}

function toBytes(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('不支持的 WebSocket 二进制帧');
}

class ProtoReader {
  constructor(bytes) {
    this.data = bytes;
    this.offset = 0;
    this.currentWire = null;
  }

  done() { return this.offset >= this.data.length; }

  key() {
    const value = this.rawVarint();
    const field = Math.floor(value / 8);
    const wire = value & 7;
    if (!field) throw new Error('Agent Protobuf 字段无效');
    this.currentWire = wire;
    return [field, wire];
  }

  varint() {
    this.expectWire(0);
    return this.rawVarint();
  }

  rawVarint() {
    let value = 0n;
    for (let index = 0; index < 10; index += 1) {
      if (this.offset >= this.data.length) throw new Error('Agent Protobuf 数据截断');
      const byte = this.data[this.offset++];
      value |= BigInt(byte & 0x7f) << BigInt(index * 7);
      if ((byte & 0x80) === 0) {
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Agent Protobuf 数值过大');
        return Number(value);
      }
    }
    throw new Error('Agent Protobuf varint 无效');
  }

  fixed64() {
    this.expectWire(1);
    this.ensure(8);
    const value = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 8).getFloat64(0, true);
    this.offset += 8;
    if (!Number.isFinite(value)) throw new Error('Agent Protobuf 浮点数无效');
    return value;
  }

  bytes() {
    this.expectWire(2);
    const length = this.rawVarint();
    this.ensure(length);
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  string() { return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes()); }

  message() { return new ProtoReader(this.bytes()); }

  skip(wire) {
    if (wire === 0) this.rawVarint();
    else if (wire === 1) { this.ensure(8); this.offset += 8; }
    else if (wire === 2) { const length = this.rawVarint(); this.ensure(length); this.offset += length; }
    else if (wire === 5) { this.ensure(4); this.offset += 4; }
    else throw new Error('Agent Protobuf wire type 无效');
  }

  ensure(length) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.data.length) {
      throw new Error('Agent Protobuf 数据截断');
    }
  }

  expectWire(expected) {
    if (this.currentWire !== expected) throw new Error('Agent Protobuf wire type 不匹配');
  }
}
