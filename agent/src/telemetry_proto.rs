//! Minimal, dependency-free Protobuf encoder for Agent telemetry.
//!
//! This is intentionally kept as a small wire-format module instead of adding
//! a code-generation dependency to the cross-platform Agent.  The matching
//! decoder lives in the Worker and accepts only protocol version 1.

use std::collections::BTreeMap;

use serde_json::Value;

use super::{AggStats, Metrics, PingResult, SamplePoint, Stats, VpsInfo};

const PROTOCOL_VERSION: u64 = 1;

pub(crate) fn encode_payload(
    agent_id: &str,
    agent_label: &str,
    agent_version: &str,
    capabilities: &Value,
    metrics: &Metrics,
) -> Vec<u8> {
    let mut out = Vec::new();
    field_varint(&mut out, 1, PROTOCOL_VERSION);
    field_string(&mut out, 2, agent_id);
    field_string(&mut out, 3, agent_label);
    field_string(&mut out, 4, agent_version);
    if let Ok(bytes) = serde_json::to_vec(capabilities) {
        field_bytes(&mut out, 5, &bytes);
    }
    field_message(&mut out, 6, &encode_metrics(metrics));
    out
}

fn encode_metrics(metrics: &Metrics) -> Vec<u8> {
    let mut out = Vec::new();
    field_string(&mut out, 1, &metrics.hostname);
    field_varint(&mut out, 2, metrics.process_count as u64);
    field_varint(&mut out, 3, metrics.thread_count as u64);
    field_f64(&mut out, 4, metrics.cpu_percent);
    field_message(&mut out, 5, &encode_memory(&metrics.memory));
    field_message(&mut out, 6, &encode_load(&metrics.load));
    field_message(&mut out, 7, &encode_disk(&metrics.disk));
    field_message(&mut out, 8, &encode_net(&metrics.net));
    field_message(&mut out, 9, &encode_diskio(&metrics.diskio));
    field_varint(&mut out, 10, metrics.uptime_sec);
    if let Some(stats) = &metrics.stats {
        field_message(&mut out, 11, &encode_agg_stats(stats));
    }
    for sample in &metrics.samples {
        field_message(&mut out, 12, &encode_sample(sample));
    }
    if let Some(vps_info) = &metrics.vps_info {
        field_message(&mut out, 13, &encode_vps_info(vps_info));
    }
    for series in encode_ping_series(&metrics.pings) {
        field_message(&mut out, 14, &series);
    }
    out
}

fn encode_memory(memory: &super::MemInfo) -> Vec<u8> {
    let mut out = Vec::new();
    field_varint(&mut out, 1, memory.total_mb);
    field_varint(&mut out, 2, memory.used_mb);
    field_f64(&mut out, 3, memory.percent);
    if let Some(swap) = &memory.swap {
        let mut nested = Vec::new();
        field_varint(&mut nested, 1, swap.total_mb);
        field_varint(&mut nested, 2, swap.used_mb);
        field_f64(&mut nested, 3, swap.percent);
        field_message(&mut out, 4, &nested);
    }
    out
}

fn encode_load(load: &super::LoadInfo) -> Vec<u8> {
    let mut out = Vec::new();
    field_f64(&mut out, 1, load.load1);
    field_f64(&mut out, 2, load.load5);
    field_f64(&mut out, 3, load.load15);
    out
}

fn encode_disk(disk: &super::DiskInfo) -> Vec<u8> {
    let mut out = Vec::new();
    field_f64(&mut out, 1, disk.total_gb);
    field_f64(&mut out, 2, disk.used_gb);
    field_f64(&mut out, 3, disk.avail_gb);
    field_f64(&mut out, 4, disk.percent);
    out
}

fn encode_net(net: &super::NetInfo) -> Vec<u8> {
    let mut out = Vec::new();
    field_f64(&mut out, 1, net.rx_bytes_sec);
    field_f64(&mut out, 2, net.tx_bytes_sec);
    field_varint(&mut out, 3, net.rx_bytes);
    field_varint(&mut out, 4, net.tx_bytes);
    field_varint(&mut out, 5, net.tcp_conns);
    field_varint(&mut out, 6, net.udp_conns);
    out
}

fn encode_diskio(diskio: &super::DiskIoInfo) -> Vec<u8> {
    let mut out = Vec::new();
    field_f64(&mut out, 1, diskio.read_bytes_sec);
    field_f64(&mut out, 2, diskio.write_bytes_sec);
    out
}

fn encode_agg_stats(stats: &AggStats) -> Vec<u8> {
    let mut out = Vec::new();
    for (field, stat) in [
        (1, &stats.cpu),
        (2, &stats.mem),
        (3, &stats.disk),
        (4, &stats.load),
        (5, &stats.net_rx),
        (6, &stats.net_tx),
        (7, &stats.tcp_conns),
        (8, &stats.udp_conns),
        (9, &stats.disk_read),
        (10, &stats.disk_write),
    ] {
        field_message(&mut out, field, &encode_stat(stat));
    }
    out
}

fn encode_stat(stat: &Stats) -> Vec<u8> {
    let mut out = Vec::new();
    field_f64(&mut out, 1, stat.avg);
    field_f64(&mut out, 2, stat.max);
    field_f64(&mut out, 3, stat.min);
    out
}

fn encode_sample(sample: &SamplePoint) -> Vec<u8> {
    let mut out = Vec::new();
    field_varint(&mut out, 1, sample.ts.max(0) as u64);
    field_f64(&mut out, 2, sample.cpu);
    field_f64(&mut out, 3, sample.mem);
    field_f64(&mut out, 4, sample.disk);
    field_f64(&mut out, 5, sample.load);
    field_f64(&mut out, 6, sample.net_rx);
    field_f64(&mut out, 7, sample.net_tx);
    field_varint(&mut out, 8, sample.tcp_conns);
    field_varint(&mut out, 9, sample.udp_conns);
    field_f64(&mut out, 10, sample.disk_read);
    field_f64(&mut out, 11, sample.disk_write);
    for (field, value) in [
        (12, sample.cpu_temp),
        (13, sample.gpu_temp),
        (14, sample.gpu_util),
        (15, sample.motherboard_temp),
        (16, sample.disk_temp),
        (17, sample.chipset_temp),
    ] {
        if let Some(value) = value {
            field_f64(&mut out, field, value);
        }
    }
    out
}

fn encode_vps_info(info: &VpsInfo) -> Vec<u8> {
    let mut out = Vec::new();
    field_string(&mut out, 1, &info.cpu_model);
    field_varint(&mut out, 2, info.cpu_cores as u64);
    field_varint(&mut out, 3, info.physical_cores as u64);
    field_string(&mut out, 4, &info.arch);
    field_varint(&mut out, 5, info.total_mem_mb);
    field_varint(&mut out, 6, info.total_swap_mb);
    field_f64(&mut out, 7, info.total_disk_gb);
    field_string(&mut out, 8, &info.os);
    field_string(&mut out, 9, &info.kernel);
    field_string(&mut out, 10, &info.virtualization);
    if !info.gpu_name.is_empty() {
        field_string(&mut out, 11, &info.gpu_name);
    }
    if info.gpu_count > 0 {
        field_varint(&mut out, 12, info.gpu_count as u64);
    }
    if info.gpu_accessible {
        field_varint(&mut out, 13, 1);
    }
    for (field, value) in [
        (14, info.cpu_temp_c),
        (15, info.gpu_temp_c),
        (16, info.gpu_util),
        (17, info.motherboard_temp_c),
        (18, info.disk_temp_c),
        (19, info.chipset_temp_c),
    ] {
        if let Some(value) = value {
            field_f64(&mut out, field, value);
        }
    }
    for sensor in &info.temperature_sensors {
        let mut nested = Vec::new();
        field_string(&mut nested, 1, &sensor.id);
        field_string(&mut nested, 2, &sensor.label);
        field_string(&mut nested, 3, &sensor.kind);
        field_f64(&mut nested, 4, sensor.temp_c);
        field_message(&mut out, 20, &nested);
    }
    out
}

fn encode_ping_series(pings: &[PingResult]) -> Vec<Vec<u8>> {
    let mut grouped: BTreeMap<&str, Vec<&PingResult>> = BTreeMap::new();
    for ping in pings {
        grouped.entry(&ping.target_id).or_default().push(ping);
    }
    grouped
        .into_iter()
        .map(|(target_id, mut points)| {
            points.sort_by_key(|point| point.ts);
            let t0 = points.first().map(|point| point.ts).unwrap_or(0).max(0);
            let mut out = Vec::new();
            field_string(&mut out, 1, target_id);
            field_varint(&mut out, 2, t0 as u64);
            for point in points {
                let mut nested = Vec::new();
                field_varint(&mut nested, 1, (point.ts - t0).max(0) as u64);
                if let Some(latency) = point.latency_ms {
                    field_f64(&mut nested, 2, latency as f64);
                }
                field_varint(&mut nested, 3, u64::from(point.ok));
                field_message(&mut out, 3, &nested);
            }
            out
        })
        .collect()
}

fn field_string(out: &mut Vec<u8>, field: u64, value: &str) {
    field_bytes(out, field, value.as_bytes());
}

fn field_bytes(out: &mut Vec<u8>, field: u64, value: &[u8]) {
    key(out, field, 2);
    varint(out, value.len() as u64);
    out.extend_from_slice(value);
}

fn field_message(out: &mut Vec<u8>, field: u64, value: &[u8]) {
    field_bytes(out, field, value);
}

fn field_varint(out: &mut Vec<u8>, field: u64, value: u64) {
    key(out, field, 0);
    varint(out, value);
}

fn field_f64(out: &mut Vec<u8>, field: u64, value: f64) {
    key(out, field, 1);
    out.extend_from_slice(&value.to_le_bytes());
}

fn key(out: &mut Vec<u8>, field: u64, wire_type: u64) {
    varint(out, (field << 3) | wire_type);
}

fn varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push((value as u8) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_has_version_and_binary_metrics() {
        let metrics = Metrics::default();
        let payload = encode_payload(
            "agent-a",
            "Agent A",
            "v1.1.22",
            &serde_json::json!({"protocol": 1}),
            &metrics,
        );
        let json_payload = serde_json::json!({
            "agent_id": "agent-a",
            "agent_label": "Agent A",
            "agent_version": "v1.1.22",
            "capabilities": {"protocol": 1},
            "metrics": crate::metrics_json(&metrics),
        })
        .to_string();
        assert!(!payload.is_empty());
        assert_eq!(payload[0], 0x08);
        assert!(payload.len() < 256);
        assert!(payload.len() < json_payload.len());
    }
}
