use anyhow::{anyhow, Context, Result};
use std::collections::VecDeque;
use std::env;
use std::fs;
use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{Disks, System};
use ureq::ResponseExt;

mod dns_compat;
mod geoip;
mod manager;
mod platform;
mod queue;
mod tasks;
mod updater;

use queue::{default_queue_file, load_sample_queue, save_sample_queue, spawn_queue_writer};
use updater::{restart_after_update, spawn_update_worker, UpdateRole};

const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_REPORT_SEC: u64 = 300;
const DEFAULT_SAMPLE_SEC: u64 = 1;
const DEFAULT_PING_SEC: u64 = 20;
const DEFAULT_PING_TARGET_REFRESH_SEC: u64 = 600;
const DEFAULT_UPDATE_CHECK_SEC: u64 = 3600;
const INITIAL_UPDATE_CHECK_SEC: u64 = 60;
const REPORT_MAX_SAMPLES: usize = 300;
const DEFAULT_QUEUE_MAX_SAMPLES: usize = 86_400;
const QUEUE_FLUSH_SEC: u64 = 10;
const MIN_PING_QUEUE_CAPACITY: usize = 200;
const MAX_PING_QUEUE_CAPACITY: usize = 10_000;
const MAX_PING_CONCURRENCY: usize = 32;
const TCP_PING_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_PING_RESOLVED_ADDRESSES: usize = 8;

#[derive(Clone, Debug)]
struct Config {
    api: String,
    token: String,
    agent_id: String,
    agent_label: String,
    sample_sec: u64,
    report_sec: u64,
    ping_sec: u64,
    ping_target_refresh_sec: u64,
    ping_targets: String,
    queue_file: PathBuf,
    queue_max_samples: usize,
    update_check_sec: u64,
    once: bool,
    task_runner_only: bool,
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
    gpu_name: String,
    gpu_count: usize,
    gpu_accessible: bool,
    cpu_temp_c: Option<f64>,
    gpu_temp_c: Option<f64>,
    gpu_util: Option<f64>,
    motherboard_temp_c: Option<f64>,
    disk_temp_c: Option<f64>,
    chipset_temp_c: Option<f64>,
    temperature_sensors: Vec<platform::TemperatureSensor>,
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
    cpu_temp: Option<f64>,
    gpu_temp: Option<f64>,
    gpu_util: Option<f64>,
    motherboard_temp: Option<f64>,
    disk_temp: Option<f64>,
    chipset_temp: Option<f64>,
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
struct UpdateCheckResult {
    result: Result<UpdateOutcome>,
    next_check_sec: u64,
}

#[derive(Debug)]
enum UpdateOutcome {
    Current(String),
    AvailableManual(String),
    Managed(String),
    Installed {
        version: String,
        executable: PathBuf,
    },
}

#[derive(Debug)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct UpdatePolicy {
    auto_update: bool,
    latest_version: String,
    download_base: String,
    manifest_sha256: String,
    check_interval_sec: u64,
}

enum QueueCommand {
    Append(SamplePoint),
    Acknowledge(i64),
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
    let raw_args: Vec<String> = env::args().collect();
    if raw_args.get(1).map(String::as_str) == Some("--dns-compat") {
        return dns_compat::run(&raw_args[2..]);
    }
    if raw_args.get(1).map(String::as_str) == Some("--manager-update-watchdog") {
        let version = raw_args
            .get(2)
            .ok_or_else(|| anyhow!("watchdog Agent version is required"))?;
        if raw_args.len() != 3 {
            return Err(anyhow!("invalid watchdog arguments"));
        }
        return manager::run_update_watchdog(version);
    }
    let cfg = Config::parse()?;
    if cfg.token.is_empty() {
        return Err(anyhow!("NSTATUS_AGENT_TOKEN or --token is required"));
    }
    if cfg.api.is_empty() {
        return Err(anyhow!("NSTATUS_API_BASE or --api is required"));
    }

    let http = HttpClient::new();
    if cfg.task_runner_only {
        return manager::run(&cfg, &http);
    }
    manager::bootstrap_if_root();
    let mut collector = Collector::new();
    let hostname = hostname_string();
    let vps_info = collector.vps_info();
    let mut samples = load_sample_queue(&cfg.queue_file).unwrap_or_default();
    if samples.len() > cfg.queue_max_samples {
        samples.drain(0..samples.len() - cfg.queue_max_samples);
    }
    let mut pings: Vec<PingResult> = Vec::new();
    let mut ping_queue_capacity = MIN_PING_QUEUE_CAPACITY;
    let queue_tx = spawn_queue_writer(
        cfg.queue_file.clone(),
        samples.clone(),
        cfg.queue_max_samples,
    );
    let ping_rx = spawn_ping_worker(cfg.clone(), http.clone());
    let update_rx = if cfg.once {
        None
    } else {
        Some(spawn_update_worker(
            cfg.clone(),
            http.clone(),
            UpdateRole::Telemetry,
        ))
    };
    geoip::spawn_geoip_worker(cfg.clone(), http.clone());
    if !cfg.once {
        tasks::spawn_ip_unlock_fallback(cfg.clone(), http.clone());
    }
    let mut last_report = Instant::now();
    let mut first_report = true;
    let mut uploading = false;
    let mut last_upload_failed = false;
    let retry_sec = cfg.report_sec.min(60).max(10);
    let (upload_tx, upload_rx) = mpsc::channel::<UploadResult>();
    let sample_period = Duration::from_secs(cfg.sample_sec);
    let mut next_sample = Instant::now();

    loop {
        let sample = collector.sample();
        samples.push_back(sample.clone());
        let _ = queue_tx.send(QueueCommand::Append(sample));
        if samples.len() > cfg.queue_max_samples {
            samples.pop_front();
        }

        while let Ok(result) = upload_rx.try_recv() {
            uploading = false;
            match result.result {
                Ok(()) => {
                    last_upload_failed = false;
                    drop_samples_through(&mut samples, result.last_sample_ts);
                    let _ = queue_tx.send(QueueCommand::Acknowledge(result.last_sample_ts));
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

        while let Ok(results) = ping_rx.try_recv() {
            let expected_cycles = cfg.report_sec.div_ceil(cfg.ping_sec).saturating_add(2) as usize;
            ping_queue_capacity = ping_queue_capacity
                .max(expected_cycles.saturating_mul(results.len()))
                .min(MAX_PING_QUEUE_CAPACITY);
            pings.extend(results);
        }
        if pings.len() > ping_queue_capacity {
            let keep_from = pings.len().saturating_sub(ping_queue_capacity);
            pings.drain(0..keep_from);
        }

        if let Some(rx) = &update_rx {
            while let Ok(check) = rx.try_recv() {
                match check.result {
                    Ok(UpdateOutcome::Current(version)) => println!(
                        "{{\"ok\":true,\"update\":\"current\",\"version\":{}}}",
                        json_string(&version)
                    ),
                    Ok(UpdateOutcome::AvailableManual(version)) => println!(
                        "{{\"ok\":true,\"update\":\"available_manual\",\"version\":{},\"command\":\"cftz update\"}}",
                        json_string(&version)
                    ),
                    Ok(UpdateOutcome::Managed(version)) => println!(
                        "{{\"ok\":true,\"update\":\"managed\",\"version\":{}}}",
                        json_string(&version)
                    ),
                    Ok(UpdateOutcome::Installed {
                        version,
                        executable,
                    }) => {
                        save_sample_queue(&cfg.queue_file, &samples)?;
                        println!(
                            "{{\"ok\":true,\"update\":\"installed\",\"version\":{},\"restarting\":true}}",
                            json_string(&version)
                        );
                        restart_after_update(&executable)?;
                        return Ok(());
                    }
                    Err(err) => eprintln!(
                        "{{\"ok\":false,\"update_error\":{},\"retry_sec\":{}}}",
                        json_string(&err.to_string()),
                        check.next_check_sec
                    ),
                }
            }
        }

        let report_due = first_report
            || cfg.once
            || samples.len() > REPORT_MAX_SAMPLES
            || last_report.elapsed() >= Duration::from_secs(cfg.report_sec)
            || (last_upload_failed
                && !samples.is_empty()
                && last_report.elapsed() >= Duration::from_secs(retry_sec));
        if !uploading && report_due {
            let upload_samples: Vec<_> = samples.iter().take(REPORT_MAX_SAMPLES).cloned().collect();
            let mut metrics =
                collector.metrics(&hostname, Some(vps_info.clone()), &upload_samples, &pings);
            metrics.samples = upload_samples.clone();
            metrics.stats = Some(aggregate(&upload_samples));
            let last_sample_ts = upload_samples.last().map(|s| s.ts).unwrap_or(0);
            let last_ping_ts = pings.last().map(|p| p.ts).unwrap_or(0);
            let sample_count = upload_samples.len();
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
                        Ok(()) => {
                            let _ = queue_tx.send(QueueCommand::Acknowledge(result.last_sample_ts));
                            println!(
                                "{{\"ok\":true,\"submitted_at\":{},\"samples\":{},\"pings\":{}}}",
                                now_sec(),
                                result.sample_count,
                                result.ping_count
                            );
                        }
                        Err(err) => return Err(err),
                    }
                }
                break;
            }
        }

        let now = Instant::now();
        next_sample = advance_sample_deadline(next_sample, now, sample_period);
        thread::sleep(next_sample.saturating_duration_since(now));
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
            ping_target_refresh_sec: env_u64(
                "NSTATUS_PING_TARGET_REFRESH_SEC",
                DEFAULT_PING_TARGET_REFRESH_SEC,
            ),
            ping_targets: env_or("NSTATUS_PING_TARGETS", "*"),
            queue_file: PathBuf::from(env_or("NSTATUS_QUEUE_FILE", &default_queue_file())),
            queue_max_samples: env_u64(
                "NSTATUS_QUEUE_MAX_SAMPLES",
                DEFAULT_QUEUE_MAX_SAMPLES as u64,
            ) as usize,
            update_check_sec: env_u64("NSTATUS_UPDATE_CHECK_SEC", DEFAULT_UPDATE_CHECK_SEC),
            once: false,
            task_runner_only: env_or("NSTATUS_TASK_RUNNER_ONLY", "") == "1",
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
                "--ping-target-refresh-sec" => {
                    cfg.ping_target_refresh_sec =
                        parse_u64(args.next(), cfg.ping_target_refresh_sec)
                }
                "--ping-targets" => {
                    cfg.ping_targets = args.next().unwrap_or_else(|| "*".to_string())
                }
                "--queue-file" => cfg.queue_file = PathBuf::from(args.next().unwrap_or_default()),
                "--queue-max-samples" => {
                    cfg.queue_max_samples =
                        parse_u64(args.next(), cfg.queue_max_samples as u64) as usize
                }
                "--once" => cfg.once = true,
                "--task-runner-only" => cfg.task_runner_only = true,
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
        cfg.ping_target_refresh_sec =
            normalize_ping_target_refresh_sec(cfg.ping_target_refresh_sec);
        cfg.queue_max_samples = cfg.queue_max_samples.clamp(REPORT_MAX_SAMPLES, 604_800);
        cfg.update_check_sec = cfg.update_check_sec.clamp(900, 86_400);
        if cfg.agent_id.is_empty() {
            cfg.agent_id = hostname_string();
        }
        if cfg.agent_label.is_empty() {
            cfg.agent_label = cfg.agent_id.clone();
        }
        cfg.api = normalize_api_base(&cfg.api, env_or("NSTATUS_ALLOW_INSECURE_HTTP", "") == "1")?;
        cfg.agent_id = normalize_agent_id(&cfg.agent_id)?;
        cfg.agent_label = cfg.agent_label.chars().take(128).collect();
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
        let thermal = platform::thermal_snapshot();

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
            cpu_temp: thermal.cpu_temp_c,
            gpu_temp: thermal.gpu_temp_c,
            gpu_util: thermal.gpu_util,
            motherboard_temp: thermal.motherboard_temp_c,
            disk_temp: thermal.disk_temp_c,
            chipset_temp: thermal.chipset_temp_c,
        }
    }

    fn metrics(
        &mut self,
        hostname: &str,
        mut vps_info: Option<VpsInfo>,
        samples: &[SamplePoint],
        pings: &[PingResult],
    ) -> Metrics {
        let latest = samples.last().cloned().unwrap_or_else(|| self.sample());
        if let Some(info) = vps_info.as_mut() {
            let thermal = platform::thermal_snapshot();
            info.cpu_temp_c = thermal.cpu_temp_c;
            info.gpu_temp_c = thermal.gpu_temp_c;
            info.gpu_util = thermal.gpu_util;
            info.gpu_name = thermal.gpu_name;
            info.gpu_count = thermal.gpu_count;
            info.gpu_accessible = thermal.gpu_accessible;
            info.motherboard_temp_c = thermal.motherboard_temp_c;
            info.disk_temp_c = thermal.disk_temp_c;
            info.chipset_temp_c = thermal.chipset_temp_c;
            info.temperature_sensors = thermal.sensors;
        }
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
        let thermal = platform::thermal_snapshot();
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
            gpu_name: thermal.gpu_name,
            gpu_count: thermal.gpu_count,
            gpu_accessible: thermal.gpu_accessible,
            cpu_temp_c: thermal.cpu_temp_c,
            gpu_temp_c: thermal.gpu_temp_c,
            gpu_util: thermal.gpu_util,
            motherboard_temp_c: thermal.motherboard_temp_c,
            disk_temp_c: thermal.disk_temp_c,
            chipset_temp_c: thermal.chipset_temp_c,
            temperature_sensors: thermal.sensors,
        }
    }
}

fn submit(cfg: &Config, http: &HttpClient, metrics: Metrics) -> Result<()> {
    let payload = serde_json::json!({
        "agent_id": cfg.agent_id,
        "agent_label": cfg.agent_label,
        "agent_version": format!("v{}", AGENT_VERSION),
        "capabilities": manager::reported_capabilities(cfg),
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
    let mut value = serde_json::json!({
        "ts": s.ts, "cpu": s.cpu, "mem": s.mem, "disk": s.disk, "load": s.load,
        "net_rx": s.net_rx, "net_tx": s.net_tx, "tcp_conns": s.tcp_conns, "udp_conns": s.udp_conns,
        "disk_read": s.disk_read, "disk_write": s.disk_write
    });
    let obj = value.as_object_mut().expect("sample json object");
    if let Some(v) = s.cpu_temp {
        obj.insert("cpu_temp".to_string(), serde_json::json!(v));
    }
    if let Some(v) = s.gpu_temp {
        obj.insert("gpu_temp".to_string(), serde_json::json!(v));
    }
    if let Some(v) = s.gpu_util {
        obj.insert("gpu_util".to_string(), serde_json::json!(v));
    }
    if let Some(v) = s.motherboard_temp {
        obj.insert("motherboard_temp".to_string(), serde_json::json!(v));
    }
    if let Some(v) = s.disk_temp {
        obj.insert("disk_temp".to_string(), serde_json::json!(v));
    }
    if let Some(v) = s.chipset_temp {
        obj.insert("chipset_temp".to_string(), serde_json::json!(v));
    }
    value
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
    let obj = value.as_object_mut().expect("vps info json object");
    if !v.gpu_name.is_empty() {
        obj.insert("gpu_name".to_string(), serde_json::json!(v.gpu_name));
    }
    if v.gpu_count > 0 {
        obj.insert("gpu_count".to_string(), serde_json::json!(v.gpu_count));
    }
    if v.gpu_accessible {
        obj.insert("gpu_accessible".to_string(), serde_json::json!(true));
    }
    if let Some(t) = v.cpu_temp_c {
        obj.insert("cpu_temp_c".to_string(), serde_json::json!(t));
    }
    if let Some(t) = v.gpu_temp_c {
        obj.insert("gpu_temp_c".to_string(), serde_json::json!(t));
    }
    if let Some(u) = v.gpu_util {
        obj.insert("gpu_util".to_string(), serde_json::json!(u));
    }
    if let Some(t) = v.motherboard_temp_c {
        obj.insert("motherboard_temp_c".to_string(), serde_json::json!(t));
    }
    if let Some(t) = v.disk_temp_c {
        obj.insert("disk_temp_c".to_string(), serde_json::json!(t));
    }
    if let Some(t) = v.chipset_temp_c {
        obj.insert("chipset_temp_c".to_string(), serde_json::json!(t));
    }
    if !v.temperature_sensors.is_empty() {
        obj.insert(
            "temperature_sensors".to_string(),
            serde_json::Value::Array(
                v.temperature_sensors
                    .iter()
                    .map(|sensor| {
                        serde_json::json!({
                            "id": sensor.id,
                            "label": sensor.label,
                            "kind": sensor.kind,
                            "temp_c": sensor.temp_c
                        })
                    })
                    .collect(),
            ),
        );
    }
    value
}

fn ping_json(p: &PingResult) -> serde_json::Value {
    serde_json::json!({ "target_id": p.target_id, "ts": p.ts, "latency_ms": p.latency_ms, "ok": p.ok })
}

impl HttpClient {
    fn new() -> Self {
        let config = ureq::Agent::config_builder()
            .user_agent(format!("NIE-SLA-Agent/{}", AGENT_VERSION))
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

    fn get_public(&self, url: &str) -> Result<String> {
        let mut res = self
            .agent
            .get(url)
            .call()
            .map_err(|err| http_error("GET", url, err))?;
        res.body_mut()
            .read_to_string()
            .with_context(|| format!("HTTP GET failed while reading {}", url))
    }

    #[cfg(target_os = "linux")]
    fn get_public_bytes(&self, url: &str) -> Result<Vec<u8>> {
        self.get_public_bytes_limited(url, 32 * 1024 * 1024)
    }

    fn get_public_bytes_limited(&self, url: &str, max_bytes: usize) -> Result<Vec<u8>> {
        if !url.starts_with("https://") {
            return Err(anyhow!("public download URL must use HTTPS"));
        }
        let mut res = self
            .agent
            .get(url)
            .call()
            .map_err(|err| http_error("GET", url, err))?;
        if res.get_uri().scheme_str() != Some("https") {
            return Err(anyhow!("public download redirected away from HTTPS"));
        }
        let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
        res.body_mut()
            .as_reader()
            .take(max_bytes.saturating_add(1) as u64)
            .read_to_end(&mut bytes)
            .with_context(|| format!("HTTP GET failed while reading {}", url))?;
        if bytes.len() > max_bytes {
            return Err(anyhow!("HTTP response from {} exceeds size limit", url));
        }
        Ok(bytes)
    }
}

fn auth_header(token: &str) -> String {
    format!("Bearer {}", token)
}

fn http_error(method: &str, url: &str, err: ureq::Error) -> anyhow::Error {
    anyhow!("HTTP {} failed for {}: {}", method, url, err)
}

fn spawn_ping_worker(cfg: Config, http: HttpClient) -> mpsc::Receiver<Vec<PingResult>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut targets = Vec::new();
        let refresh_period = Duration::from_secs(cfg.ping_target_refresh_sec);
        let mut last_refresh = Instant::now() - refresh_period;
        let mut last_ping = Instant::now() - Duration::from_secs(cfg.ping_sec);
        loop {
            if last_refresh.elapsed() >= refresh_period {
                if let Ok(next) = fetch_ping_targets(&cfg, &http) {
                    targets = next;
                }
                last_refresh = Instant::now();
            }
            if last_ping.elapsed() >= Duration::from_secs(cfg.ping_sec) {
                if tx.send(run_pings(&targets, &cfg.ping_targets)).is_err() {
                    break;
                }
                last_ping = Instant::now();
            }
            thread::sleep(next_ping_worker_sleep(
                last_refresh.elapsed(),
                refresh_period,
                last_ping.elapsed(),
                Duration::from_secs(cfg.ping_sec),
            ));
        }
    });
    rx
}

fn next_ping_worker_sleep(
    refresh_elapsed: Duration,
    refresh_period: Duration,
    ping_elapsed: Duration,
    ping_period: Duration,
) -> Duration {
    refresh_period
        .saturating_sub(refresh_elapsed)
        .min(ping_period.saturating_sub(ping_elapsed))
        .max(Duration::from_millis(50))
}

fn run_pings(targets: &[PingTarget], selector: &str) -> Vec<PingResult> {
    let selected: Vec<_> = targets
        .iter()
        .filter(|target| ping_target_selected(&target.id, selector))
        .cloned()
        .collect();
    let mut results = Vec::with_capacity(selected.len());
    for batch in selected.chunks(MAX_PING_CONCURRENCY) {
        let handles: Vec<_> = batch
            .iter()
            .cloned()
            .map(|target| thread::spawn(move || ping_target(&target)))
            .collect();
        results.extend(handles.into_iter().filter_map(|handle| handle.join().ok()));
    }
    results
}

fn ping_target_selected(id: &str, selector: &str) -> bool {
    let selector = selector.trim();
    selector.is_empty()
        || selector == "*"
        || selector
            .split(',')
            .map(str::trim)
            .any(|candidate| !candidate.is_empty() && candidate == id)
}

fn ping_target(target: &PingTarget) -> PingResult {
    let ts = now_sec();
    let addresses = target
        .target
        .to_socket_addrs()
        .map(|resolved| {
            let mut unique = Vec::new();
            for address in resolved {
                if !unique.contains(&address) {
                    unique.push(address);
                }
                if unique.len() >= MAX_PING_RESOLVED_ADDRESSES {
                    break;
                }
            }
            unique
        })
        .unwrap_or_default();
    let latency_ms = ping_resolved_addresses(&addresses, TCP_PING_TIMEOUT, |address, timeout| {
        let started = Instant::now();
        TcpStream::connect_timeout(&address, timeout)
            .ok()
            .map(|_| started.elapsed().as_millis())
    });
    PingResult {
        target_id: target.id.clone(),
        ts,
        latency_ms,
        ok: latency_ms.is_some(),
    }
}

fn ping_resolved_addresses<F>(
    addresses: &[std::net::SocketAddr],
    timeout: Duration,
    connect: F,
) -> Option<u128>
where
    F: Fn(std::net::SocketAddr, Duration) -> Option<u128> + Sync,
{
    if addresses.is_empty() {
        return None;
    }
    thread::scope(|scope| {
        let (tx, rx) = mpsc::channel();
        for &address in addresses {
            let tx = tx.clone();
            let connect = &connect;
            scope.spawn(move || {
                let _ = tx.send(connect(address, timeout));
            });
        }
        drop(tx);
        rx.into_iter().flatten().min()
    })
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

fn drop_samples_through(samples: &mut VecDeque<SamplePoint>, ts: i64) {
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

fn advance_sample_deadline(previous_deadline: Instant, now: Instant, period: Duration) -> Instant {
    let mut next = previous_deadline + period;
    while next <= now {
        next += period;
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_deadline_does_not_add_work_time_to_the_period() {
        let start = Instant::now();
        let next = advance_sample_deadline(
            start,
            start + Duration::from_millis(3_500),
            Duration::from_secs(1),
        );
        assert_eq!(next.duration_since(start), Duration::from_secs(4));
    }

    #[test]
    fn api_base_rejects_cleartext_remote_credentials() {
        assert_eq!(
            normalize_api_base("https://sla.example.com/", false).unwrap(),
            "https://sla.example.com"
        );
        assert!(normalize_api_base("http://sla.example.com", false).is_err());
        assert!(normalize_api_base("http://sla.example.com", true).is_ok());
        assert!(normalize_api_base("http://127.0.0.1:8787", false).is_ok());
        assert!(normalize_api_base("https://user:pass@sla.example.com", false).is_err());
    }

    #[test]
    fn agent_id_matches_worker_normalization() {
        assert_eq!(normalize_agent_id(" VPS HK / 01 ").unwrap(), "vps-hk-01");
        assert_eq!(normalize_agent_id("NODE_A:01").unwrap(), "node_a:01");
        assert!(normalize_agent_id("中文").is_err());
    }

    #[test]
    fn ping_target_refresh_defaults_to_ten_minutes_and_is_bounded() {
        assert_eq!(DEFAULT_PING_TARGET_REFRESH_SEC, 600);
        assert_eq!(normalize_ping_target_refresh_sec(1), 60);
        assert_eq!(normalize_ping_target_refresh_sec(600), 600);
        assert_eq!(normalize_ping_target_refresh_sec(86_400), 3_600);
        assert_eq!(DEFAULT_PING_SEC, 20);
    }

    #[test]
    fn ping_worker_sleeps_until_the_next_real_deadline() {
        assert_eq!(
            next_ping_worker_sleep(
                Duration::from_secs(100),
                Duration::from_secs(600),
                Duration::from_secs(5),
                Duration::from_secs(20),
            ),
            Duration::from_secs(15),
        );
        assert_eq!(
            next_ping_worker_sleep(
                Duration::from_secs(600),
                Duration::from_secs(600),
                Duration::from_secs(20),
                Duration::from_secs(20),
            ),
            Duration::from_millis(50),
        );
    }

    #[test]
    fn ping_target_selector_supports_all_and_explicit_ids() {
        assert!(ping_target_selected("alpha", "*"));
        assert!(ping_target_selected("alpha", ""));
        assert!(ping_target_selected("alpha", "beta, alpha, gamma"));
        assert!(!ping_target_selected("alpha", "beta,gamma"));
        assert!(!ping_target_selected("alpha", "alphabet"));
    }

    #[test]
    fn tcp_ping_uses_a_strict_one_second_connect_timeout() {
        assert_eq!(TCP_PING_TIMEOUT, Duration::from_secs(1));
    }

    #[test]
    fn tcp_ping_races_resolved_addresses_without_accumulating_failed_attempts() {
        use std::net::{IpAddr, Ipv4Addr, SocketAddr};

        let failed = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 1);
        let successful = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 2);
        let latency =
            ping_resolved_addresses(&[failed, successful], TCP_PING_TIMEOUT, |address, _| {
                (address == successful).then_some(37)
            });

        assert_eq!(latency, Some(37));
    }
}

fn normalize_ping_target_refresh_sec(value: u64) -> u64 {
    value.clamp(60, 3_600)
}

fn trim_ascii(value: impl AsRef<str>) -> String {
    value.as_ref().trim().to_string()
}

fn normalize_api_base(value: &str, allow_insecure_http: bool) -> Result<String> {
    let base = value.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(anyhow!("NSTATUS_API_BASE or --api is required"));
    }
    if base.chars().any(char::is_whitespace) || base.contains('?') || base.contains('#') {
        return Err(anyhow!(
            "Agent API base must be an origin without query or fragment"
        ));
    }
    let (scheme, authority) = base
        .split_once("://")
        .ok_or_else(|| anyhow!("Agent API base must include http:// or https://"))?;
    let authority = authority.split('/').next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return Err(anyhow!("Agent API base has an invalid authority"));
    }
    if scheme.eq_ignore_ascii_case("https") {
        return Ok(base.to_string());
    }
    if !scheme.eq_ignore_ascii_case("http") {
        return Err(anyhow!("Agent API base must use HTTPS"));
    }
    let authority = authority.to_ascii_lowercase();
    let local = authority == "localhost"
        || authority.starts_with("localhost:")
        || authority == "127.0.0.1"
        || authority.starts_with("127.0.0.1:")
        || authority == "[::1]"
        || authority.starts_with("[::1]:");
    if allow_insecure_http || local {
        return Ok(base.to_string());
    }
    Err(anyhow!(
        "Agent API base must use HTTPS; set NSTATUS_ALLOW_INSECURE_HTTP=1 only for trusted private networks"
    ))
}

fn normalize_agent_id(value: &str) -> Result<String> {
    let mut normalized = String::with_capacity(value.len().min(64));
    let mut previous_dash = false;
    for ch in value.trim().to_ascii_lowercase().chars() {
        if normalized.len() >= 64 {
            break;
        }
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-') {
            normalized.push(ch);
            previous_dash = ch == '-';
        } else if !previous_dash && !normalized.is_empty() {
            normalized.push('-');
            previous_dash = true;
        }
    }
    let normalized = normalized.trim_matches('-').to_string();
    if normalized.is_empty() {
        return Err(anyhow!(
            "NSTATUS_AGENT_ID must contain an ASCII letter or number"
        ));
    }
    Ok(normalized)
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
    println!("NIE-SLA Agent v{}", AGENT_VERSION);
    println!("Usage: nstatus-metrics --api URL --token TOKEN [--once|--task-runner-only]");
    println!("  --task-runner-only  Run the privileged fixed-action Manager service");
    println!(
        "Environment: NSTATUS_API_BASE, NSTATUS_AGENT_TOKEN, NSTATUS_AGENT_ID, NSTATUS_AGENT_LABEL, NSTATUS_PING_TARGET_REFRESH_SEC"
    );
}
