use anyhow::{anyhow, Context, Result};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{Disks, System};

const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_REPORT_SEC: u64 = 300;
const DEFAULT_SAMPLE_SEC: u64 = 1;
const DEFAULT_PING_SEC: u64 = 20;
const DEFAULT_UNLOCK_CHECK_SEC: u64 = 300;
const DEFAULT_UNLOCK_CHECK_TIMEOUT_SEC: u64 = 90;
const DEFAULT_UNLOCK_CHECK_URL: &str = "https://IP.Check.Place";
const MAX_SAMPLES: usize = 310;

#[derive(Clone, Debug)]
struct Config {
    api: String,
    token: String,
    agent_id: String,
    agent_label: String,
    sample_sec: u64,
    report_sec: u64,
    ping_sec: u64,
    ping_targets: String,
    unlock_check_enabled: bool,
    unlock_check_sec: u64,
    unlock_check_url: String,
    unlock_check_timeout_sec: u64,
    once: bool,
}

#[derive(Clone)]
struct HttpClient {
    agent: ureq::Agent,
}

#[derive(Clone, Debug, Default)]
struct MemInfo {
    total_mb: u64,
    used_mb: u64,
    percent: f64,
    swap: Option<SwapInfo>,
}

#[derive(Clone, Debug, Default)]
struct SwapInfo {
    total_mb: u64,
    used_mb: u64,
    percent: f64,
}

#[derive(Clone, Debug, Default)]
struct LoadInfo {
    load1: f64,
    load5: f64,
    load15: f64,
}

#[derive(Clone, Debug, Default)]
struct DiskInfo {
    total_gb: f64,
    used_gb: f64,
    avail_gb: f64,
    percent: f64,
}

#[derive(Clone, Debug, Default)]
struct NetInfo {
    rx_bytes_sec: f64,
    tx_bytes_sec: f64,
    rx_bytes: u64,
    tx_bytes: u64,
    tcp_conns: u64,
    udp_conns: u64,
}

#[derive(Clone, Debug, Default)]
struct DiskIoInfo {
    read_bytes_sec: f64,
    write_bytes_sec: f64,
}

#[derive(Clone, Debug, Default)]
struct Stats {
    avg: f64,
    max: f64,
    min: f64,
}

#[derive(Clone, Debug, Default)]
struct AggStats {
    cpu: Stats,
    mem: Stats,
    disk: Stats,
    load: Stats,
    net_rx: Stats,
    net_tx: Stats,
    tcp_conns: Stats,
    udp_conns: Stats,
    disk_read: Stats,
    disk_write: Stats,
}

#[derive(Clone, Debug, Default)]
struct VpsInfo {
    cpu_model: String,
    cpu_cores: usize,
    physical_cores: usize,
    arch: String,
    total_mem_mb: u64,
    total_swap_mb: u64,
    total_disk_gb: f64,
    os: String,
    kernel: String,
    virtualization: String,
    unlock: Option<UnlockInfo>,
}

#[derive(Clone, Debug, Default)]
struct UnlockInfo {
    checked_at: i64,
    source: String,
    services: Vec<UnlockServiceResult>,
}

#[derive(Clone, Debug, Default)]
struct UnlockServiceResult {
    id: String,
    name: String,
    status: String,
    region: String,
    method: String,
}

#[derive(Clone, Debug, Default)]
struct SamplePoint {
    ts: i64,
    cpu: f64,
    mem: f64,
    disk: f64,
    load: f64,
    net_rx: f64,
    net_tx: f64,
    tcp_conns: u64,
    udp_conns: u64,
    disk_read: f64,
    disk_write: f64,
}

#[derive(Clone, Debug, Default)]
struct Metrics {
    hostname: String,
    process_count: usize,
    thread_count: usize,
    cpu_percent: f64,
    memory: MemInfo,
    load: LoadInfo,
    disk: DiskInfo,
    net: NetInfo,
    diskio: DiskIoInfo,
    uptime_sec: u64,
    stats: Option<AggStats>,
    samples: Vec<SamplePoint>,
    vps_info: Option<VpsInfo>,
    pings: Vec<PingResult>,
}

#[derive(Debug)]
struct UploadResult {
    result: Result<()>,
    last_sample_ts: i64,
    last_ping_ts: i64,
    sample_count: usize,
    ping_count: usize,
}

#[derive(Debug)]
struct UnlockCheckResult {
    result: Result<UnlockInfo>,
}

#[derive(Clone, Debug)]
struct PingTarget {
    id: String,
    target: String,
    enabled: bool,
}

#[derive(Clone, Debug)]
struct PingResult {
    target_id: String,
    ts: i64,
    latency_ms: Option<u128>,
    ok: bool,
}

#[derive(Default)]
struct Collector {
    sys: System,
    disks: Disks,
    prev_net: Option<(Instant, u64, u64)>,
    prev_disk: Option<(Instant, u64, u64)>,
}

fn main() {
    if let Err(err) = run() {
        eprintln!(
            "{{\"ok\":false,\"error\":{}}}",
            json_string(&err.to_string())
        );
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cfg = Config::parse()?;
    if cfg.token.is_empty() {
        return Err(anyhow!("NSTATUS_AGENT_TOKEN or --token is required"));
    }
    if cfg.api.is_empty() {
        return Err(anyhow!("NSTATUS_API_BASE or --api is required"));
    }

    let http = HttpClient::new();
    let mut collector = Collector::new();
    let hostname = hostname_string();
    let mut vps_info = collector.vps_info();
    let mut samples: Vec<SamplePoint> = Vec::new();
    let mut pings: Vec<PingResult> = Vec::new();
    let mut ping_targets: Vec<PingTarget> = Vec::new();
    let mut last_report = Instant::now();
    let mut first_report = true;
    let mut uploading = false;
    let mut last_upload_failed = false;
    let retry_sec = cfg.report_sec.min(60).max(10);
    let (upload_tx, upload_rx) = mpsc::channel::<UploadResult>();
    let mut last_ping = Instant::now() - Duration::from_secs(cfg.ping_sec);
    let mut last_ping_refresh = Instant::now() - Duration::from_secs(60);
    let (unlock_tx, unlock_rx) = mpsc::channel::<UnlockCheckResult>();
    let mut unlock_running = false;
    let mut last_unlock_check = Instant::now() - Duration::from_secs(cfg.unlock_check_sec);

    loop {
        while let Ok(result) = upload_rx.try_recv() {
            uploading = false;
            match result.result {
                Ok(()) => {
                    last_upload_failed = false;
                    drop_samples_through(&mut samples, result.last_sample_ts);
                    drop_pings_through(&mut pings, result.last_ping_ts);
                    println!(
                        "{{\"ok\":true,\"submitted_at\":{},\"samples\":{},\"pings\":{}}}",
                        now_sec(),
                        result.sample_count,
                        result.ping_count
                    );
                }
                Err(err) => {
                    last_upload_failed = true;
                    eprintln!(
                        "{{\"ok\":false,\"error\":{}}}",
                        json_string(&err.to_string())
                    );
                }
            }
        }

        while let Ok(result) = unlock_rx.try_recv() {
            unlock_running = false;
            match result.result {
                Ok(info) => vps_info.unlock = Some(info),
                Err(err) => eprintln!(
                    "{{\"ok\":false,\"unlock_error\":{}}}",
                    json_string(&err.to_string())
                ),
            }
        }

        let sample = collector.sample();
        samples.push(sample.clone());
        if samples.len() > MAX_SAMPLES {
            samples.remove(0);
        }

        if last_ping_refresh.elapsed() >= Duration::from_secs(60) {
            ping_targets = fetch_ping_targets(&cfg, &http).unwrap_or_default();
            last_ping_refresh = Instant::now();
        }
        if last_ping.elapsed() >= Duration::from_secs(cfg.ping_sec) {
            pings.extend(run_pings(&ping_targets, &cfg.ping_targets));
            if pings.len() > 200 {
                let keep_from = pings.len().saturating_sub(200);
                pings.drain(0..keep_from);
            }
            last_ping = Instant::now();
        }

        if cfg.unlock_check_enabled
            && !unlock_running
            && last_unlock_check.elapsed() >= Duration::from_secs(cfg.unlock_check_sec)
        {
            let cfg_for_unlock = cfg.clone();
            let tx = unlock_tx.clone();
            unlock_running = true;
            last_unlock_check = Instant::now();
            thread::spawn(move || {
                let result = run_unlock_check(&cfg_for_unlock);
                let _ = tx.send(UnlockCheckResult { result });
            });
        }

        let report_due = first_report
            || cfg.once
            || last_report.elapsed() >= Duration::from_secs(cfg.report_sec)
            || (last_upload_failed
                && !samples.is_empty()
                && last_report.elapsed() >= Duration::from_secs(retry_sec));
        if !uploading && report_due {
            let mut metrics =
                collector.metrics(&hostname, Some(vps_info.clone()), &samples, &pings);
            metrics.samples = samples.clone();
            metrics.stats = Some(aggregate(&samples));
            let last_sample_ts = samples.last().map(|s| s.ts).unwrap_or(0);
            let last_ping_ts = pings.last().map(|p| p.ts).unwrap_or(0);
            let sample_count = samples.len();
            let ping_count = pings.len();
            let cfg_for_upload = cfg.clone();
            let http_for_upload = http.clone();
            let tx = upload_tx.clone();
            uploading = true;
            first_report = false;
            last_report = Instant::now();
            thread::spawn(move || {
                let result = submit(&cfg_for_upload, &http_for_upload, metrics);
                let _ = tx.send(UploadResult {
                    result,
                    last_sample_ts,
                    last_ping_ts,
                    sample_count,
                    ping_count,
                });
            });
            if cfg.once {
                if let Ok(result) = upload_rx.recv() {
                    match result.result {
                        Ok(()) => println!(
                            "{{\"ok\":true,\"submitted_at\":{},\"samples\":{},\"pings\":{}}}",
                            now_sec(),
                            result.sample_count,
                            result.ping_count
                        ),
                        Err(err) => return Err(err),
                    }
                }
                break;
            }
        }

        thread::sleep(Duration::from_secs(cfg.sample_sec));
    }
    Ok(())
}

impl Config {
    fn parse() -> Result<Self> {
        let mut cfg = Config {
            api: env_or("NSTATUS_API_BASE", ""),
            token: env_or("NSTATUS_AGENT_TOKEN", ""),
            agent_id: env_or("NSTATUS_AGENT_ID", &hostname_string()),
            agent_label: env_or("NSTATUS_AGENT_LABEL", &hostname_string()),
            sample_sec: env_u64("NSTATUS_SAMPLE_SEC", DEFAULT_SAMPLE_SEC),
            report_sec: env_u64("NSTATUS_INTERVAL_SEC", DEFAULT_REPORT_SEC),
            ping_sec: env_u64("NSTATUS_PING_SEC", DEFAULT_PING_SEC),
            ping_targets: env_or("NSTATUS_PING_TARGETS", "*"),
            unlock_check_enabled: env_bool(
                "NSTATUS_UNLOCK_CHECK_ENABLED",
                cfg!(target_os = "linux"),
            ),
            unlock_check_sec: env_u64("NSTATUS_UNLOCK_CHECK_SEC", DEFAULT_UNLOCK_CHECK_SEC),
            unlock_check_url: env_or("NSTATUS_UNLOCK_CHECK_URL", DEFAULT_UNLOCK_CHECK_URL),
            unlock_check_timeout_sec: env_u64(
                "NSTATUS_UNLOCK_CHECK_TIMEOUT_SEC",
                DEFAULT_UNLOCK_CHECK_TIMEOUT_SEC,
            ),
            once: false,
        };

        let mut args = env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--api" => cfg.api = args.next().unwrap_or_default(),
                "--token" => cfg.token = args.next().unwrap_or_default(),
                "--agent-id" => cfg.agent_id = args.next().unwrap_or_default(),
                "--agent-label" => cfg.agent_label = args.next().unwrap_or_default(),
                "--sample-sec" => cfg.sample_sec = parse_u64(args.next(), cfg.sample_sec),
                "--report-sec" | "--interval" => {
                    cfg.report_sec = parse_u64(args.next(), cfg.report_sec)
                }
                "--ping-sec" => cfg.ping_sec = parse_u64(args.next(), cfg.ping_sec),
                "--ping-targets" => {
                    cfg.ping_targets = args.next().unwrap_or_else(|| "*".to_string())
                }
                "--unlock-check" => cfg.unlock_check_enabled = true,
                "--no-unlock-check" => cfg.unlock_check_enabled = false,
                "--unlock-check-sec" => {
                    cfg.unlock_check_sec = parse_u64(args.next(), cfg.unlock_check_sec)
                }
                "--unlock-check-url" => {
                    cfg.unlock_check_url = args
                        .next()
                        .unwrap_or_else(|| DEFAULT_UNLOCK_CHECK_URL.to_string())
                }
                "--unlock-check-timeout" => {
                    cfg.unlock_check_timeout_sec =
                        parse_u64(args.next(), cfg.unlock_check_timeout_sec)
                }
                "--once" => cfg.once = true,
                "--version" | "-V" => {
                    println!("v{}", AGENT_VERSION);
                    std::process::exit(0);
                }
                "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                _ => {}
            }
        }

        cfg.sample_sec = cfg.sample_sec.clamp(1, 3600);
        cfg.report_sec = cfg.report_sec.clamp(30, 3600);
        cfg.ping_sec = cfg.ping_sec.clamp(5, 600);
        cfg.unlock_check_sec = cfg.unlock_check_sec.clamp(60, 86_400);
        cfg.unlock_check_timeout_sec = cfg.unlock_check_timeout_sec.clamp(15, 300);
        if cfg.agent_id.is_empty() {
            cfg.agent_id = hostname_string();
        }
        if cfg.agent_label.is_empty() {
            cfg.agent_label = cfg.agent_id.clone();
        }
        Ok(cfg)
    }
}

impl Collector {
    fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();
        thread::sleep(Duration::from_millis(200));
        sys.refresh_cpu();
        Collector {
            sys,
            disks: Disks::new_with_refreshed_list(),
            prev_net: None,
            prev_disk: None,
        }
    }

    fn sample(&mut self) -> SamplePoint {
        self.sys.refresh_cpu();
        self.sys.refresh_memory();
        self.disks.refresh_list();
        self.disks.refresh();

        let now = Instant::now();
        let (rx_raw, tx_raw) = platform::net_bytes();
        let (net_rx, net_tx) = rate_pair(&mut self.prev_net, now, rx_raw, tx_raw);
        let (read_raw, write_raw) = platform::disk_io_bytes();
        let (disk_read, disk_write) = rate_pair(&mut self.prev_disk, now, read_raw, write_raw);
        let (tcp_conns, udp_conns) = platform::connection_counts();
        let memory = self.memory();
        let disk = self.disk();
        let load = load_info();

        SamplePoint {
            ts: now_sec(),
            cpu: round2(self.sys.global_cpu_info().cpu_usage() as f64),
            mem: memory.percent,
            disk: disk.percent,
            load: load.load1,
            net_rx,
            net_tx,
            tcp_conns,
            udp_conns,
            disk_read,
            disk_write,
        }
    }

    fn metrics(
        &mut self,
        hostname: &str,
        vps_info: Option<VpsInfo>,
        samples: &[SamplePoint],
        pings: &[PingResult],
    ) -> Metrics {
        let latest = samples.last().cloned().unwrap_or_else(|| self.sample());
        self.sys.refresh_processes();
        let process_count = self.sys.processes().len();
        let thread_count = self
            .sys
            .processes()
            .values()
            .map(|process| process.tasks().map(|tasks| tasks.len()).unwrap_or(1))
            .sum();
        Metrics {
            hostname: hostname.to_string(),
            process_count,
            thread_count,
            cpu_percent: latest.cpu,
            memory: self.memory(),
            load: load_info(),
            disk: self.disk(),
            net: NetInfo {
                rx_bytes_sec: latest.net_rx,
                tx_bytes_sec: latest.net_tx,
                rx_bytes: platform::net_bytes().0,
                tx_bytes: platform::net_bytes().1,
                tcp_conns: latest.tcp_conns,
                udp_conns: latest.udp_conns,
            },
            diskio: DiskIoInfo {
                read_bytes_sec: latest.disk_read,
                write_bytes_sec: latest.disk_write,
            },
            uptime_sec: System::uptime(),
            stats: None,
            samples: Vec::new(),
            vps_info,
            pings: pings.to_vec(),
        }
    }

    fn memory(&self) -> MemInfo {
        let total = bytes_to_mb(self.sys.total_memory());
        let used = bytes_to_mb(self.sys.used_memory());
        let swap_total = bytes_to_mb(self.sys.total_swap());
        let swap_used = bytes_to_mb(self.sys.used_swap());
        MemInfo {
            total_mb: total,
            used_mb: used,
            percent: pct(used as f64, total as f64),
            swap: if swap_total > 0 {
                Some(SwapInfo {
                    total_mb: swap_total,
                    used_mb: swap_used,
                    percent: pct(swap_used as f64, swap_total as f64),
                })
            } else {
                None
            },
        }
    }

    fn disk(&self) -> DiskInfo {
        let mut total = 0_u64;
        let mut avail = 0_u64;
        for disk in self.disks.list() {
            total = total.saturating_add(disk.total_space());
            avail = avail.saturating_add(disk.available_space());
        }
        let used = total.saturating_sub(avail);
        DiskInfo {
            total_gb: bytes_to_gb(total),
            used_gb: bytes_to_gb(used),
            avail_gb: bytes_to_gb(avail),
            percent: pct(used as f64, total as f64),
        }
    }

    fn vps_info(&mut self) -> VpsInfo {
        let memory = self.memory();
        let disk = self.disk();
        let cpu_model = self
            .sys
            .cpus()
            .first()
            .map(|c| c.brand().to_string())
            .unwrap_or_default();
        VpsInfo {
            cpu_model,
            cpu_cores: self.sys.cpus().len(),
            physical_cores: self
                .sys
                .physical_core_count()
                .unwrap_or_else(|| self.sys.cpus().len()),
            arch: env::consts::ARCH.to_string(),
            total_mem_mb: memory.total_mb,
            total_swap_mb: memory.swap.as_ref().map(|s| s.total_mb).unwrap_or(0),
            total_disk_gb: disk.total_gb,
            os: os_label(),
            kernel: System::kernel_version().unwrap_or_default(),
            virtualization: platform::virtualization(),
            unlock: None,
        }
    }
}

fn submit(cfg: &Config, http: &HttpClient, metrics: Metrics) -> Result<()> {
    let payload = serde_json::json!({
        "agent_id": cfg.agent_id,
        "agent_label": cfg.agent_label,
        "agent_version": format!("v{}", AGENT_VERSION),
        "metrics": metrics_json(&metrics),
    });
    let url = format!("{}/api/agent/metrics", cfg.api.trim_end_matches('/'));
    let body = payload.to_string();
    http.post_json(&url, &cfg.token, &body)
        .map_err(|err| anyhow!("submit failed for {}: {}", url, err))?;
    println!("{{\"ok\":true,\"submitted_at\":{}}}", now_sec());
    Ok(())
}

fn fetch_ping_targets(cfg: &Config, http: &HttpClient) -> Result<Vec<PingTarget>> {
    let url = format!(
        "{}/api/agent/ping-targets?agent_id={}",
        cfg.api.trim_end_matches('/'),
        percent_encode_query(&cfg.agent_id)
    );
    let text = http.get(&url, &cfg.token)?;
    let value: serde_json::Value = serde_json::from_str(&text)?;
    if !value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Ok(Vec::new());
    }
    let targets = value
        .get("targets")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.to_string();
            let target = item.get("target")?.as_str()?.to_string();
            let enabled = item
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            Some(PingTarget {
                id,
                target,
                enabled,
            })
        })
        .filter(|t| t.enabled)
        .collect();
    Ok(targets)
}

fn percent_encode_query(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

fn metrics_json(m: &Metrics) -> serde_json::Value {
    let mut value = serde_json::json!({
        "hostname": m.hostname,
        "process_count": m.process_count,
        "thread_count": m.thread_count,
        "cpu_percent": m.cpu_percent,
        "memory": mem_json(&m.memory),
        "load": { "load1": m.load.load1, "load5": m.load.load5, "load15": m.load.load15 },
        "disk": { "total_gb": m.disk.total_gb, "used_gb": m.disk.used_gb, "avail_gb": m.disk.avail_gb, "percent": m.disk.percent },
        "net": {
            "rx_bytes_sec": m.net.rx_bytes_sec,
            "tx_bytes_sec": m.net.tx_bytes_sec,
            "rx_bytes": m.net.rx_bytes,
            "tx_bytes": m.net.tx_bytes,
            "tcp_conns": m.net.tcp_conns,
            "udp_conns": m.net.udp_conns
        },
        "diskio": { "read_bytes_sec": m.diskio.read_bytes_sec, "write_bytes_sec": m.diskio.write_bytes_sec },
        "uptime_sec": m.uptime_sec
    });
    let obj = value.as_object_mut().expect("metrics json object");
    if let Some(stats) = &m.stats {
        obj.insert("stats".to_string(), agg_stats_json(stats));
    }
    if !m.samples.is_empty() {
        obj.insert(
            "samples".to_string(),
            serde_json::Value::Array(m.samples.iter().map(sample_json).collect()),
        );
    }
    if let Some(info) = &m.vps_info {
        obj.insert("vps_info".to_string(), vps_info_json(info));
    }
    if !m.pings.is_empty() {
        obj.insert(
            "pings".to_string(),
            serde_json::Value::Array(m.pings.iter().map(ping_json).collect()),
        );
    }
    value
}

fn mem_json(m: &MemInfo) -> serde_json::Value {
    let mut value =
        serde_json::json!({ "total_mb": m.total_mb, "used_mb": m.used_mb, "percent": m.percent });
    if let Some(swap) = &m.swap {
        value.as_object_mut().unwrap().insert(
            "swap".to_string(),
            serde_json::json!({
                "total_mb": swap.total_mb,
                "used_mb": swap.used_mb,
                "percent": swap.percent
            }),
        );
    }
    value
}

fn agg_stats_json(s: &AggStats) -> serde_json::Value {
    serde_json::json!({
        "cpu": stat_json(&s.cpu), "mem": stat_json(&s.mem), "disk": stat_json(&s.disk), "load": stat_json(&s.load),
        "net_rx": stat_json(&s.net_rx), "net_tx": stat_json(&s.net_tx), "tcp_conns": stat_json(&s.tcp_conns),
        "udp_conns": stat_json(&s.udp_conns), "disk_read": stat_json(&s.disk_read), "disk_write": stat_json(&s.disk_write)
    })
}

fn stat_json(s: &Stats) -> serde_json::Value {
    serde_json::json!({ "avg": s.avg, "max": s.max, "min": s.min })
}

fn sample_json(s: &SamplePoint) -> serde_json::Value {
    serde_json::json!({
        "ts": s.ts, "cpu": s.cpu, "mem": s.mem, "disk": s.disk, "load": s.load,
        "net_rx": s.net_rx, "net_tx": s.net_tx, "tcp_conns": s.tcp_conns, "udp_conns": s.udp_conns,
        "disk_read": s.disk_read, "disk_write": s.disk_write
    })
}

fn vps_info_json(v: &VpsInfo) -> serde_json::Value {
    let mut value = serde_json::json!({
        "cpu_model": v.cpu_model,
        "cpu_cores": v.cpu_cores,
        "physical_cores": v.physical_cores,
        "arch": v.arch,
        "total_mem_mb": v.total_mem_mb,
        "total_swap_mb": v.total_swap_mb,
        "total_disk_gb": v.total_disk_gb,
        "os": v.os,
        "kernel": v.kernel,
        "virtualization": v.virtualization
    });
    if let Some(unlock) = &v.unlock {
        value
            .as_object_mut()
            .unwrap()
            .insert("unlock".to_string(), unlock_json(unlock));
    }
    value
}

fn unlock_json(unlock: &UnlockInfo) -> serde_json::Value {
    serde_json::json!({
        "checked_at": unlock.checked_at,
        "source": unlock.source,
        "services": unlock.services.iter().map(|service| serde_json::json!({
            "id": service.id,
            "name": service.name,
            "status": service.status,
            "region": service.region,
            "method": service.method,
        })).collect::<Vec<_>>()
    })
}

fn ping_json(p: &PingResult) -> serde_json::Value {
    serde_json::json!({ "target_id": p.target_id, "ts": p.ts, "latency_ms": p.latency_ms, "ok": p.ok })
}

impl HttpClient {
    fn new() -> Self {
        let _ = rustls_rustcrypto::provider().install_default();
        let config = ureq::Agent::config_builder()
            .user_agent(format!("NStatus-Agent/{}", AGENT_VERSION))
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_send_request(Some(Duration::from_secs(10)))
            .timeout_recv_response(Some(Duration::from_secs(30)))
            .timeout_recv_body(Some(Duration::from_secs(30)))
            .build();
        Self {
            agent: ureq::Agent::new_with_config(config),
        }
    }

    fn get(&self, url: &str, token: &str) -> Result<String> {
        let mut res = self
            .agent
            .get(url)
            .header("Authorization", auth_header(token))
            .call()
            .map_err(|err| http_error("GET", url, err))?;
        res.body_mut()
            .read_to_string()
            .with_context(|| format!("HTTP GET failed while reading {}", url))
    }

    fn post_json(&self, url: &str, token: &str, body: &str) -> Result<String> {
        let mut res = self
            .agent
            .post(url)
            .header("Authorization", auth_header(token))
            .header("Content-Type", "application/json")
            .send(body)
            .map_err(|err| http_error("POST", url, err))?;
        res.body_mut()
            .read_to_string()
            .with_context(|| format!("HTTP POST failed while reading {}", url))
    }
}

fn auth_header(token: &str) -> String {
    format!("Bearer {}", token)
}

fn http_error(method: &str, url: &str, err: ureq::Error) -> anyhow::Error {
    anyhow!("HTTP {} failed for {}: {}", method, url, err)
}

fn run_pings(targets: &[PingTarget], selector: &str) -> Vec<PingResult> {
    let selected = selected_targets(selector);
    let handles: Vec<_> = targets
        .iter()
        .filter(|t| selected.is_none() || selected.as_ref().unwrap().contains(&t.id))
        .cloned()
        .map(|target| thread::spawn(move || ping_target(&target)))
        .collect();

    handles
        .into_iter()
        .filter_map(|handle| handle.join().ok())
        .collect()
}

fn ping_target(target: &PingTarget) -> PingResult {
    let ts = now_sec();
    let timeout = Duration::from_secs(3);
    let start = Instant::now();
    let mut ok = false;
    let mut latency_ms = None;
    if let Ok(addrs) = target.target.to_socket_addrs() {
        for addr in addrs {
            if TcpStream::connect_timeout(&addr, timeout).is_ok() {
                ok = true;
                latency_ms = Some(start.elapsed().as_millis());
                break;
            }
        }
    }
    PingResult {
        target_id: target.id.clone(),
        ts,
        latency_ms,
        ok,
    }
}

fn selected_targets(selector: &str) -> Option<HashSet<String>> {
    let text = selector.trim();
    if text.is_empty() || text == "*" {
        return None;
    }
    Some(
        text.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
    )
}

fn run_unlock_check(cfg: &Config) -> Result<UnlockInfo> {
    if !cfg!(target_os = "linux") {
        return Err(anyhow!("unlock check is only supported on Linux"));
    }
    let url = cfg.unlock_check_url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(anyhow!(
            "NSTATUS_UNLOCK_CHECK_URL must start with http:// or https://"
        ));
    }

    let timeout_sec = cfg.unlock_check_timeout_sec;
    let curl_timeout_sec = timeout_sec.clamp(15, 60).to_string();
    let output = Command::new("timeout")
        .arg(format!("{}s", timeout_sec))
        .arg("bash")
        .arg("-lc")
        .arg("bash <(curl -fsSL --max-time \"$NSTATUS_UNLOCK_CURL_TIMEOUT\" \"$NSTATUS_UNLOCK_CHECK_URL\")")
        .env("NSTATUS_UNLOCK_CHECK_URL", url)
        .env("NSTATUS_UNLOCK_CURL_TIMEOUT", curl_timeout_sec)
        .output()
        .with_context(|| "failed to start unlock check command")?;

    let mut text = String::new();
    text.push_str(&String::from_utf8_lossy(&output.stdout));
    if !output.stderr.is_empty() {
        text.push('\n');
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    if text.len() > 256 * 1024 {
        text.truncate(256 * 1024);
    }

    let services = parse_unlock_services(&text);
    if services.is_empty() {
        if !output.status.success() {
            return Err(anyhow!(
                "unlock check exited with {}; no supported services parsed",
                output.status
            ));
        }
        return Err(anyhow!("unlock check produced no supported service rows"));
    }

    Ok(UnlockInfo {
        checked_at: now_sec(),
        source: unlock_source_label(url),
        services,
    })
}

fn parse_unlock_services(output: &str) -> Vec<UnlockServiceResult> {
    let clean = strip_ansi_codes(output);
    let lines: Vec<String> = clean
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    let start = lines
        .iter()
        .position(|line| line.contains("服务商") && line.contains("TikTok"))
        .or_else(|| {
            lines
                .iter()
                .position(|line| line.contains("流媒体") && line.contains("解锁"))
        })
        .unwrap_or(0);
    let section = &lines[start..lines.len().min(start + 12)];
    let service_line = section
        .iter()
        .find(|line| line.contains("服务商"))
        .map(String::as_str)
        .unwrap_or_default();
    let providers = unlock_row_values(service_line);
    let statuses = unlock_section_row(section, "状态");
    let regions = unlock_section_row(section, "地区");
    let methods = unlock_section_row(section, "方式");

    unlock_service_order()
        .iter()
        .enumerate()
        .filter_map(|(default_index, (id, name))| {
            let key = service_key(name);
            let index = providers
                .iter()
                .position(|provider| service_key(provider) == key)
                .unwrap_or(default_index);
            let status = statuses.get(index).cloned().unwrap_or_default();
            let region = regions.get(index).cloned().unwrap_or_default();
            let method = methods.get(index).cloned().unwrap_or_default();
            if status.is_empty() && region.is_empty() && method.is_empty() {
                return None;
            }
            Some(UnlockServiceResult {
                id: (*id).to_string(),
                name: (*name).to_string(),
                status,
                region,
                method,
            })
        })
        .collect()
}

fn unlock_service_order() -> [(&'static str, &'static str); 7] {
    [
        ("tiktok", "TikTok"),
        ("disney_plus", "Disney+"),
        ("netflix", "Netflix"),
        ("youtube", "Youtube"),
        ("amazon_pv", "AmazonPV"),
        ("reddit", "Reddit"),
        ("chatgpt", "ChatGPT"),
    ]
}

fn unlock_section_row(lines: &[String], label: &str) -> Vec<String> {
    lines
        .iter()
        .find(|line| {
            line.starts_with(label)
                || line.contains(&format!("{}:", label))
                || line.contains(&format!("{}：", label))
        })
        .map(|line| unlock_row_values(line))
        .unwrap_or_default()
}

fn unlock_row_values(line: &str) -> Vec<String> {
    let after = line
        .split_once(':')
        .map(|(_, value)| value)
        .or_else(|| line.split_once('：').map(|(_, value)| value))
        .unwrap_or(line);
    after
        .split_whitespace()
        .map(|part| part.trim().trim_matches('\u{feff}').to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

fn service_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

fn strip_ansi_codes(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if matches!(chars.peek(), Some('[')) {
                let _ = chars.next();
                while let Some(next) = chars.next() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            } else {
                let _ = chars.next();
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn unlock_source_label(url: &str) -> String {
    let without_scheme = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url)
        .trim_end_matches('/');
    without_scheme
        .split('/')
        .next()
        .unwrap_or(DEFAULT_UNLOCK_CHECK_URL)
        .to_string()
}

fn aggregate(samples: &[SamplePoint]) -> AggStats {
    AggStats {
        cpu: stats(samples.iter().map(|s| s.cpu)),
        mem: stats(samples.iter().map(|s| s.mem)),
        disk: stats(samples.iter().map(|s| s.disk)),
        load: stats(samples.iter().map(|s| s.load)),
        net_rx: stats(samples.iter().map(|s| s.net_rx)),
        net_tx: stats(samples.iter().map(|s| s.net_tx)),
        tcp_conns: stats(samples.iter().map(|s| s.tcp_conns as f64)),
        udp_conns: stats(samples.iter().map(|s| s.udp_conns as f64)),
        disk_read: stats(samples.iter().map(|s| s.disk_read)),
        disk_write: stats(samples.iter().map(|s| s.disk_write)),
    }
}

fn drop_samples_through(samples: &mut Vec<SamplePoint>, ts: i64) {
    if ts <= 0 {
        return;
    }
    samples.retain(|sample| sample.ts > ts);
}

fn drop_pings_through(pings: &mut Vec<PingResult>, ts: i64) {
    if ts <= 0 {
        return;
    }
    pings.retain(|ping| ping.ts > ts);
}

fn trim_ascii(value: impl AsRef<str>) -> String {
    value.as_ref().trim().to_string()
}

fn stats<I>(values: I) -> Stats
where
    I: Iterator<Item = f64>,
{
    let mut count = 0_f64;
    let mut sum = 0_f64;
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for value in values {
        if !value.is_finite() {
            continue;
        }
        count += 1.0;
        sum += value;
        min = min.min(value);
        max = max.max(value);
    }
    if count == 0.0 {
        return Stats::default();
    }
    Stats {
        avg: round2(sum / count),
        max: round2(max),
        min: round2(min),
    }
}

fn load_info() -> LoadInfo {
    let load = System::load_average();
    LoadInfo {
        load1: round2(load.one),
        load5: round2(load.five),
        load15: round2(load.fifteen),
    }
}

fn rate_pair(
    prev: &mut Option<(Instant, u64, u64)>,
    now: Instant,
    current_a: u64,
    current_b: u64,
) -> (f64, f64) {
    let out = if let Some((prev_at, prev_a, prev_b)) = prev.as_ref() {
        let dt = now.duration_since(*prev_at).as_secs_f64().max(0.001);
        let a = current_a.saturating_sub(*prev_a) as f64 / dt;
        let b = current_b.saturating_sub(*prev_b) as f64 / dt;
        (round2(a), round2(b))
    } else {
        (0.0, 0.0)
    };
    *prev = Some((now, current_a, current_b));
    out
}

fn os_label() -> String {
    let name = System::name().unwrap_or_default();
    let version = System::os_version().unwrap_or_default();
    let label = format!("{} {}", name, version).trim().to_string();
    if label.is_empty() {
        env::consts::OS.to_string()
    } else {
        label
    }
}

fn hostname_string() -> String {
    for key in ["NSTATUS_HOSTNAME", "HOSTNAME", "COMPUTERNAME"] {
        if let Ok(value) = env::var(key) {
            let value = trim_ascii(value);
            if !value.is_empty() {
                return value;
            }
        }
    }
    if let Ok(value) = fs::read_to_string("/etc/hostname") {
        let value = trim_ascii(value);
        if !value.is_empty() {
            return value;
        }
    }
    if let Ok(out) = Command::new("hostname").output() {
        if out.status.success() {
            let value = trim_ascii(String::from_utf8_lossy(&out.stdout));
            if !value.is_empty() {
                return value;
            }
        }
    }
    "nstatus-agent".to_string()
}

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_u64(key: &str, default: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

fn env_bool(key: &str, default: bool) -> bool {
    match env::var(key) {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "on" => true,
            "0" | "false" | "off" => false,
            _ => default,
        },
        Err(_) => default,
    }
}

fn parse_u64(value: Option<String>, default: u64) -> u64 {
    value.and_then(|s| s.parse().ok()).unwrap_or(default)
}

fn now_sec() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn pct(used: f64, total: f64) -> f64 {
    if total <= 0.0 {
        0.0
    } else {
        round2((used / total) * 100.0)
    }
}

fn bytes_to_mb(bytes: u64) -> u64 {
    bytes / 1024 / 1024
}

fn bytes_to_gb(bytes: u64) -> f64 {
    round2(bytes as f64 / 1024.0 / 1024.0 / 1024.0)
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"error\"".to_string())
}

fn print_help() {
    println!("NStatus Agent v{}", AGENT_VERSION);
    println!("Usage: nstatus-metrics --api URL --token TOKEN [--once]");
    println!(
        "Environment: NSTATUS_API_BASE, NSTATUS_AGENT_TOKEN, NSTATUS_AGENT_ID, NSTATUS_AGENT_LABEL"
    );
    println!(
        "Unlock check: NSTATUS_UNLOCK_CHECK_ENABLED=0|1, NSTATUS_UNLOCK_CHECK_SEC=300, NSTATUS_UNLOCK_CHECK_URL=https://IP.Check.Place"
    );
}

mod platform {
    #[cfg(target_os = "linux")]
    pub fn net_bytes() -> (u64, u64) {
        let Ok(text) = std::fs::read_to_string("/proc/net/dev") else {
            return (0, 0);
        };
        let mut rx = 0_u64;
        let mut tx = 0_u64;
        for line in text.lines().skip(2) {
            let Some((iface, data)) = line.split_once(':') else {
                continue;
            };
            let iface = iface.trim();
            if iface == "lo" {
                continue;
            }
            let fields: Vec<&str> = data.split_whitespace().collect();
            if fields.len() >= 16 {
                rx = rx.saturating_add(fields[0].parse::<u64>().unwrap_or(0));
                tx = tx.saturating_add(fields[8].parse::<u64>().unwrap_or(0));
            }
        }
        (rx, tx)
    }

    #[cfg(not(target_os = "linux"))]
    pub fn net_bytes() -> (u64, u64) {
        (0, 0)
    }

    #[cfg(target_os = "linux")]
    pub fn disk_io_bytes() -> (u64, u64) {
        let Ok(text) = std::fs::read_to_string("/proc/diskstats") else {
            return (0, 0);
        };
        let mut read = 0_u64;
        let mut write = 0_u64;
        for line in text.lines() {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 14 {
                continue;
            }
            let name = fields[2];
            if name.starts_with("loop") || name.starts_with("ram") {
                continue;
            }
            let sectors_read = fields[5].parse::<u64>().unwrap_or(0);
            let sectors_written = fields[9].parse::<u64>().unwrap_or(0);
            read = read.saturating_add(sectors_read.saturating_mul(512));
            write = write.saturating_add(sectors_written.saturating_mul(512));
        }
        (read, write)
    }

    #[cfg(not(target_os = "linux"))]
    pub fn disk_io_bytes() -> (u64, u64) {
        (0, 0)
    }

    #[cfg(target_os = "linux")]
    pub fn connection_counts() -> (u64, u64) {
        let tcp = count_conn_file("/proc/net/tcp") + count_conn_file("/proc/net/tcp6");
        let udp = count_conn_file("/proc/net/udp") + count_conn_file("/proc/net/udp6");
        (tcp, udp)
    }

    #[cfg(target_os = "linux")]
    fn count_conn_file(path: &str) -> u64 {
        std::fs::read_to_string(path)
            .map(|s| s.lines().skip(1).count() as u64)
            .unwrap_or(0)
    }

    #[cfg(not(target_os = "linux"))]
    pub fn connection_counts() -> (u64, u64) {
        (0, 0)
    }

    pub fn virtualization() -> String {
        #[cfg(target_os = "linux")]
        {
            if std::path::Path::new("/proc/xen").exists() {
                return "xen".to_string();
            }
            if let Ok(product) = std::fs::read_to_string("/sys/class/dmi/id/product_name") {
                let p = product.trim().to_lowercase();
                if p.contains("kvm") {
                    return "kvm".to_string();
                }
                if p.contains("vmware") {
                    return "vmware".to_string();
                }
                if p.contains("virtualbox") {
                    return "virtualbox".to_string();
                }
                if p.contains("hyper-v") || p.contains("hyperv") {
                    return "hyper-v".to_string();
                }
            }
            if let Ok(cgroup) = std::fs::read_to_string("/proc/1/cgroup") {
                let c = cgroup.to_lowercase();
                if c.contains("docker") {
                    return "docker".to_string();
                }
                if c.contains("lxc") {
                    return "lxc".to_string();
                }
            }
        }
        String::new()
    }
}
