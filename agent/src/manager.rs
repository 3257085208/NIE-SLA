use crate::updater::{restart_manager_after_update, spawn_manager_update_worker};
use crate::{now_sec, Config, HttpClient, UpdateOutcome, AGENT_VERSION};
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

const HEARTBEAT_MAX_AGE_SEC: u64 = 180;
const HEARTBEAT_INTERVAL_SEC: u64 = 15;
const TASK_POLL_SEC: u64 = crate::tasks::TASK_POLL_SEC;
const SERVICE_RECONCILE_SEC: u64 = 3600;
const AGENT_BINARY: &str = "/opt/nie-sla-agent/nie-sla-agent";
const CFTZ_BINARY: &str = "/usr/local/bin/cftz";
const ENV_FILE: &str = "/opt/nie-sla-agent/nie-sla-agent.env";
const STATE_DIR: &str = "/var/lib/nie-sla-agent";
const MANAGER_STATE_DIR: &str = "/var/lib/nie-sla-agent-manager";
const MANAGER_HEARTBEAT: &str = "/var/lib/nie-sla-agent-manager/manager-heartbeat";
const TELEMETRY_SERVICE: &str = "nie-sla-agent";
const MANAGER_SERVICE: &str = "nie-sla-agent-manager";
const UPDATE_TIMER: &str = "nie-sla-agent-update.timer";
const UPDATE_BACKUP: &str = "/opt/nie-sla-agent/nie-sla-agent.bak";
const UPDATE_FAILED: &str = "/opt/nie-sla-agent/nie-sla-agent.failed";
const UPDATE_CONFIRMATION: &str = "/var/lib/nie-sla-agent-manager/update-confirmed";
const UPDATE_CONFIRM_AFTER_SEC: u64 = 60;
const UPDATE_TELEMETRY_STABILITY_SEC: u64 = 30;
const UPDATE_WATCHDOG_TIMEOUT_SEC: u64 = 180;
const LEGACY_SERVICE_NAMES: [&str; 4] = [
    "nstatus-metrics.service",
    "nstatus-metrics-tasks.service",
    "nstatus-agent.service",
    "nstatus-agent-tasks.service",
];
const LEGACY_TIMER_NAMES: [&str; 4] = [
    "nstatus-metrics-update.timer",
    "nstatus-agent-update.timer",
    "nstatus-metrics-update.service",
    "nstatus-agent-update.service",
];
const LEGACY_PROCESS_NAMES: [&str; 3] =
    ["nstatus-metrics", "nstatus-metrics-tasks", "nstatus-agent"];

pub(crate) struct InstanceLock {
    _file: File,
}

pub(crate) fn acquire_instance_lock(path: &Path, label: &str) -> Result<Option<InstanceLock>> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    if let Some(parent) = parent {
        fs::create_dir_all(parent)
            .with_context(|| format!("create {label} instance lock directory"))?;
    }
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(path)
        .with_context(|| format!("open {label} instance lock {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::WouldBlock {
                return Ok(None);
            }
            return Err(error).with_context(|| format!("lock {label} instance {}", path.display()));
        }
    }
    Ok(Some(InstanceLock { _file: file }))
}

pub(crate) fn run(cfg: &Config, http: &HttpClient) -> Result<()> {
    if !cfg!(target_os = "linux") {
        return Err(anyhow!(
            "the privileged Agent manager currently requires Linux"
        ));
    }
    if !is_root() {
        return Err(anyhow!("the Agent manager must run as root"));
    }

    ensure_manager_state_dir()?;
    let lock_path = Path::new(MANAGER_STATE_DIR).join("manager.lock");
    let Some(_instance_lock) = acquire_instance_lock(&lock_path, "manager")? else {
        eprintln!("{{\"ok\":true,\"manager\":\"already_running\"}}");
        return Ok(());
    };
    reconcile_service_layout().context("reconcile Agent services")?;
    write_heartbeat(cfg, "current")?;
    spawn_heartbeat(cfg.clone());
    spawn_update_confirmation();
    let updates = spawn_manager_update_worker(cfg.clone(), http.clone());
    let mut last_task_poll = Instant::now() - Duration::from_secs(TASK_POLL_SEC);
    let mut last_reconcile = Instant::now();

    loop {
        while let Ok(check) = updates.try_recv() {
            match check.result {
                Ok(UpdateOutcome::Installed {
                    version,
                    executable,
                }) => {
                    write_heartbeat(cfg, "restarting")?;
                    println!(
                        "{{\"ok\":true,\"manager_update\":\"installed\",\"version\":{},\"restarting\":true}}",
                        serde_json::to_string(&version).unwrap_or_else(|_| "\"unknown\"".into())
                    );
                    restart_manager_after_update(&executable, &version, restart_telemetry_service)?;
                }
                Ok(UpdateOutcome::Current(version)) | Ok(UpdateOutcome::Managed(version)) => {
                    println!(
                        "{{\"ok\":true,\"manager_update\":\"current\",\"version\":{}}}",
                        serde_json::to_string(&version).unwrap_or_else(|_| "\"unknown\"".into())
                    );
                }
                Ok(UpdateOutcome::AvailableManual(version)) => eprintln!(
                    "{{\"ok\":false,\"manager_update\":\"disabled\",\"version\":{}}}",
                    serde_json::to_string(&version).unwrap_or_else(|_| "\"unknown\"".into())
                ),
                Ok(UpdateOutcome::PrivilegedRecovery(version)) => eprintln!(
                    "{{\"ok\":false,\"manager_update\":\"recovery_pending\",\"version\":{}}}",
                    serde_json::to_string(&version).unwrap_or_else(|_| "\"unknown\"".into())
                ),
                Err(error) => eprintln!(
                    "{{\"ok\":false,\"manager_update_error\":{},\"retry_sec\":{}}}",
                    serde_json::to_string(&error.to_string())
                        .unwrap_or_else(|_| "\"update failed\"".into()),
                    check.next_check_sec
                ),
            }
        }

        if last_task_poll.elapsed() >= Duration::from_secs(TASK_POLL_SEC) {
            if let Err(error) = crate::tasks::poll_once_manager(cfg, http) {
                eprintln!(
                    "{{\"ok\":false,\"task_error\":{}}}",
                    serde_json::to_string(&error.to_string())
                        .unwrap_or_else(|_| "\"task failed\"".into())
                );
            }
            last_task_poll = Instant::now();
        }
        if last_reconcile.elapsed() >= Duration::from_secs(SERVICE_RECONCILE_SEC) {
            if let Err(error) = reconcile_service_layout() {
                eprintln!(
                    "{{\"ok\":false,\"manager_reconcile_error\":{}}}",
                    serde_json::to_string(&error.to_string())
                        .unwrap_or_else(|_| "\"reconcile failed\"".into())
                );
            }
            last_reconcile = Instant::now();
        }
        thread::sleep(Duration::from_secs(HEARTBEAT_INTERVAL_SEC));
    }
}

fn spawn_heartbeat(cfg: Config) {
    thread::spawn(move || loop {
        if let Err(error) = write_heartbeat(&cfg, "current") {
            eprintln!(
                "{{\"ok\":false,\"manager_heartbeat_error\":{}}}",
                serde_json::to_string(&error.to_string())
                    .unwrap_or_else(|_| "\"heartbeat failed\"".into())
            );
        }
        thread::sleep(Duration::from_secs(HEARTBEAT_INTERVAL_SEC));
    });
}

pub(crate) fn bootstrap_if_root() {
    if !cfg!(target_os = "linux") || !is_root() {
        return;
    }
    if reconcile_service_layout().is_err() {
        return;
    }
    if Path::new("/run/systemd/system").is_dir() && command_exists("systemctl") {
        let _ = Command::new("systemctl")
            .args(["enable", "--now", MANAGER_SERVICE])
            .status();
    } else if command_exists("rc-service") {
        let _ = Command::new("rc-service")
            .args([MANAGER_SERVICE, "start"])
            .status();
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn spawn_update_watchdog(expected_version: &str) -> Result<()> {
    if !cfg!(target_os = "linux") || !is_root() {
        return Err(anyhow!("the Agent update watchdog requires Linux root"));
    }
    let expected_version = canonical_version(expected_version)?;
    let backup = Path::new(UPDATE_BACKUP);
    if !backup.is_file() || backup.is_symlink() {
        return Err(anyhow!("verified Agent update backup is unavailable"));
    }
    let _ = fs::remove_file(UPDATE_CONFIRMATION);

    if Path::new("/run/systemd/system").is_dir() && command_exists("systemd-run") {
        let unit = format!("nie-sla-agent-update-watchdog-{}", std::process::id());
        run_checked(
            Command::new("systemd-run")
                .arg("--quiet")
                .arg(format!("--unit={unit}"))
                .arg(UPDATE_BACKUP)
                .arg("--manager-update-watchdog")
                .arg(&expected_version),
        )?;
    } else {
        Command::new(UPDATE_BACKUP)
            .arg("--manager-update-watchdog")
            .arg(&expected_version)
            .env_clear()
            .env(
                "PATH",
                "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("start Agent update watchdog")?;
    }
    Ok(())
}

pub(crate) fn run_update_watchdog(expected_version: &str) -> Result<()> {
    if !cfg!(target_os = "linux") || !is_root() {
        return Err(anyhow!("the Agent update watchdog requires Linux root"));
    }
    let expected_version = canonical_version(expected_version)?;
    for _ in 0..(UPDATE_WATCHDOG_TIMEOUT_SEC / 5) {
        thread::sleep(Duration::from_secs(5));
        if fs::read_to_string(UPDATE_CONFIRMATION)
            .ok()
            .is_some_and(|value| value.trim() == expected_version)
        {
            let _ = fs::remove_file(UPDATE_CONFIRMATION);
            let _ = fs::remove_file(UPDATE_BACKUP);
            return Ok(());
        }
    }

    rollback_failed_update()?;
    restart_all_services()?;
    Err(anyhow!(
        "Agent Manager {} did not pass its stability window; restored the previous binary",
        expected_version
    ))
}

fn spawn_update_confirmation() {
    if !Path::new(UPDATE_BACKUP).is_file() || Path::new(UPDATE_BACKUP).is_symlink() {
        return;
    }
    thread::spawn(|| {
        thread::sleep(Duration::from_secs(UPDATE_CONFIRM_AFTER_SEC));
        let first_telemetry = telemetry_process_identity();
        thread::sleep(Duration::from_secs(UPDATE_TELEMETRY_STABILITY_SEC));
        let second_telemetry = telemetry_process_identity();
        if !stable_process_identity(first_telemetry.as_deref(), second_telemetry.as_deref()) {
            eprintln!(
                "{{\"ok\":false,\"manager_update_confirmation_error\":\"telemetry service did not remain stable\"}}"
            );
            return;
        }
        let version = format!("v{}\n", AGENT_VERSION);
        let result = ensure_manager_state_dir()
            .and_then(|_| atomic_write_shared(Path::new(UPDATE_CONFIRMATION), version.as_bytes()));
        if let Err(error) = result {
            eprintln!(
                "{{\"ok\":false,\"manager_update_confirmation_error\":{}}}",
                serde_json::to_string(&error.to_string())
                    .unwrap_or_else(|_| "\"confirmation failed\"".into())
            );
        }
    });
}

fn telemetry_process_identity() -> Option<String> {
    if Path::new("/run/systemd/system").is_dir() && command_exists("systemctl") {
        let active = Command::new("systemctl")
            .args(["is-active", "--quiet", TELEMETRY_SERVICE])
            .status()
            .ok()?
            .success();
        if !active {
            return None;
        }
        let output = Command::new("systemctl")
            .args(["show", "--property=MainPID", "--value", TELEMETRY_SERVICE])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let pid = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return pid.bytes().all(|byte| byte.is_ascii_digit()).then_some(pid);
    }
    if command_exists("rc-service") {
        if !Command::new("rc-service")
            .args([TELEMETRY_SERVICE, "status"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()?
            .success()
        {
            return None;
        }
        let pid = fs::read_to_string(format!("/run/{TELEMETRY_SERVICE}.pid"))
            .ok()?
            .trim()
            .to_string();
        return pid.bytes().all(|byte| byte.is_ascii_digit()).then_some(pid);
    }
    None
}

fn stable_process_identity(first: Option<&str>, second: Option<&str>) -> bool {
    matches!((first, second), (Some(a), Some(b)) if a == b && a != "0" && !a.is_empty())
}

fn canonical_version(version: &str) -> Result<String> {
    let normalized = version.strip_prefix('v').unwrap_or(version);
    let parts: Vec<_> = normalized.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(anyhow!("invalid watchdog Agent version"));
    }
    Ok(format!("v{normalized}"))
}

#[cfg(target_os = "linux")]
pub(crate) fn rollback_update_before_restart() -> Result<()> {
    rollback_failed_update()
}

fn rollback_failed_update() -> Result<()> {
    let current = Path::new(AGENT_BINARY);
    let backup = Path::new(UPDATE_BACKUP);
    let failed = Path::new(UPDATE_FAILED);
    if !current.is_file() || current.is_symlink() || !backup.is_file() || backup.is_symlink() {
        return Err(anyhow!("refusing unsafe Agent update rollback paths"));
    }
    if failed.exists() || failed.is_symlink() {
        fs::remove_file(failed).context("remove previous failed Agent binary")?;
    }
    fs::rename(current, failed).context("retain failed Agent binary")?;
    if let Err(error) = fs::rename(backup, current) {
        let _ = fs::rename(failed, current);
        return Err(anyhow!("restore previous Agent binary: {}", error));
    }
    let _ = fs::remove_file(UPDATE_CONFIRMATION);
    Ok(())
}

fn restart_all_services() -> Result<()> {
    if Path::new("/run/systemd/system").is_dir() && command_exists("systemctl") {
        run_checked(Command::new("systemctl").args(["restart", TELEMETRY_SERVICE, MANAGER_SERVICE]))
    } else if command_exists("rc-service") {
        run_checked(Command::new("rc-service").args([TELEMETRY_SERVICE, "restart"]))?;
        run_checked(Command::new("rc-service").args([MANAGER_SERVICE, "restart"]))
    } else {
        Err(anyhow!("unable to restart Agent services after rollback"))
    }
}

pub(crate) fn reported_capabilities(cfg: &Config) -> Value {
    if let Some(value) = read_fresh_heartbeat(&heartbeat_path(cfg)) {
        return value;
    }
    json!({
        "protocol": 1,
        "mode": "telemetry_only",
        "manager_version": Value::Null,
        "privileged": false,
        "actions": Vec::<&str>::new(),
        "updated_at": now_sec(),
    })
}

pub(crate) fn is_active(cfg: &Config) -> bool {
    read_fresh_heartbeat(&heartbeat_path(cfg)).is_some()
}

fn write_heartbeat(cfg: &Config, update_state: &str) -> Result<()> {
    let path = heartbeat_path(cfg);
    let payload = json!({
        "protocol": 1,
        "mode": "manager",
        "manager_version": format!("v{}", AGENT_VERSION),
        "privileged": true,
        "actions": ["nodequality", "ip_unlock"],
        "service_schema": 1,
        "update_state": update_state,
        "updated_at": now_sec(),
    });
    ensure_manager_state_dir()?;
    atomic_write_shared(&path, format!("{}\n", payload).as_bytes())
}

fn read_fresh_heartbeat(path: &Path) -> Option<Value> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    #[cfg(unix)]
    if !cfg!(test) {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != 0 || metadata.permissions().mode() & 0o022 != 0 {
            return None;
        }
    }
    let modified = metadata.modified().ok()?;
    if SystemTime::now().duration_since(modified).ok()?.as_secs() > HEARTBEAT_MAX_AGE_SEC {
        return None;
    }
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    if value.get("protocol").and_then(Value::as_u64) != Some(1)
        || value.get("mode").and_then(Value::as_str) != Some("manager")
        || value.get("privileged").and_then(Value::as_bool) != Some(true)
    {
        return None;
    }
    let actions = value.get("actions")?.as_array()?;
    if actions
        .iter()
        .any(|action| !matches!(action.as_str(), Some("nodequality") | Some("ip_unlock")))
    {
        return None;
    }
    Some(value)
}

fn heartbeat_path(cfg: &Config) -> PathBuf {
    if cfg!(test) {
        cfg.queue_file.with_file_name("task-runner-heartbeat")
    } else {
        PathBuf::from(MANAGER_HEARTBEAT)
    }
}

fn ensure_manager_state_dir() -> Result<()> {
    fs::create_dir_all(MANAGER_STATE_DIR).context("create Agent Manager state directory")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = fs::symlink_metadata(MANAGER_STATE_DIR)
            .context("inspect Agent Manager state directory")?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != 0
            || metadata.mode() & 0o022 != 0
        {
            return Err(anyhow!(
                "Agent Manager state directory is not root-owned and protected"
            ));
        }
        fs::set_permissions(MANAGER_STATE_DIR, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

fn is_root() -> bool {
    fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find(|line| line.starts_with("Uid:"))
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|uid| uid.parse::<u32>().ok())
        })
        == Some(0)
}

fn reconcile_service_layout() -> Result<()> {
    if !Path::new(AGENT_BINARY).is_file() || !Path::new(ENV_FILE).is_file() {
        return Ok(());
    }
    if Path::new(AGENT_BINARY).is_symlink() || Path::new(ENV_FILE).is_symlink() {
        return Err(anyhow!("refusing to reconcile symlinked Agent paths"));
    }
    cleanup_legacy_services();
    clear_legacy_ping_capability();
    if Path::new("/run/systemd/system").is_dir() && command_exists("systemctl") {
        let telemetry = systemd_telemetry_unit();
        let manager = systemd_manager_unit();
        let recovery_service = systemd_recovery_update_service();
        let recovery_timer = systemd_recovery_update_timer();
        let changed = write_if_changed(
            Path::new("/etc/systemd/system/nie-sla-agent.service"),
            telemetry.as_bytes(),
        )? | write_if_changed(
            Path::new("/etc/systemd/system/nie-sla-agent-manager.service"),
            manager.as_bytes(),
        )? | write_if_changed(
            Path::new("/etc/systemd/system/nie-sla-agent-update.service"),
            recovery_service.as_bytes(),
        )? | write_if_changed(
            Path::new("/etc/systemd/system/nie-sla-agent-update.timer"),
            recovery_timer.as_bytes(),
        )?;
        if changed {
            run_checked(Command::new("systemctl").arg("daemon-reload"))?;
        }
        let _ = Command::new("systemctl")
            .args(["enable", TELEMETRY_SERVICE, MANAGER_SERVICE])
            .status();
        let _ = Command::new("systemctl")
            .args(["enable", "--now", UPDATE_TIMER])
            .status();
    } else if Path::new("/etc/init.d").is_dir() && command_exists("rc-service") {
        write_if_changed(
            Path::new("/etc/init.d/nie-sla-agent"),
            openrc_telemetry_service().as_bytes(),
        )?;
        write_if_changed(
            Path::new("/etc/init.d/nie-sla-agent-manager"),
            openrc_manager_service().as_bytes(),
        )?;
        set_executable(Path::new("/etc/init.d/nie-sla-agent"))?;
        set_executable(Path::new("/etc/init.d/nie-sla-agent-manager"))?;
        let _ = Command::new("rc-update")
            .args(["add", TELEMETRY_SERVICE, "default"])
            .status();
        let _ = Command::new("rc-update")
            .args(["add", MANAGER_SERVICE, "default"])
            .status();
        install_openrc_recovery_job()?;
    }
    Ok(())
}

fn cleanup_legacy_services() {
    if Path::new("/run/systemd/system").is_dir() && command_exists("systemctl") {
        for unit in LEGACY_SERVICE_NAMES.iter().chain(LEGACY_TIMER_NAMES.iter()) {
            let _ = Command::new("systemctl")
                .args(["disable", "--now", unit])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    } else if command_exists("rc-service") {
        for service in [
            "nstatus-metrics",
            "nstatus-metrics-tasks",
            "nstatus-agent",
            "nstatus-agent-tasks",
        ] {
            let _ = Command::new("rc-service")
                .args([service, "stop"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = Command::new("rc-update")
                .args(["del", service, "default"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
    if command_exists("pkill") {
        for process in LEGACY_PROCESS_NAMES {
            let _ = Command::new("pkill")
                .args(["-x", process])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

fn clear_legacy_ping_capability() {
    if cfg!(target_os = "linux") && command_exists("setcap") {
        let _ = Command::new("setcap")
            .args(["-r", AGENT_BINARY])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

fn restart_telemetry_service() -> Result<()> {
    if Path::new("/run/systemd/system").is_dir() && command_exists("systemctl") {
        run_checked(Command::new("systemctl").args(["restart", TELEMETRY_SERVICE]))
    } else if command_exists("rc-service") {
        run_checked(Command::new("rc-service").args([TELEMETRY_SERVICE, "restart"]))
    } else {
        Ok(())
    }
}

fn command_exists(name: &str) -> bool {
    Command::new(name)
        .arg("--help")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
}

fn run_checked(command: &mut Command) -> Result<()> {
    let rendered = format!("{:?}", command);
    let status = command
        .status()
        .with_context(|| format!("run {rendered}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow!("{} exited with {}", rendered, status))
    }
}

fn write_if_changed(path: &Path, content: &[u8]) -> Result<bool> {
    if fs::read(path).ok().as_deref() == Some(content) {
        return Ok(false);
    }
    atomic_write(path, content)?;
    Ok(true)
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or_else(|| anyhow!("path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    if temp.exists() || temp.is_symlink() {
        fs::remove_file(&temp).context("remove stale temporary file")?;
    }
    fs::write(&temp, content).with_context(|| format!("write {}", temp.display()))?;
    fs::rename(&temp, path).with_context(|| format!("install {}", path.display()))
}

fn atomic_write_shared(path: &Path, content: &[u8]) -> Result<()> {
    atomic_write(path, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o644))?;
    }
    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<()> {
    Ok(())
}

fn systemd_telemetry_unit() -> String {
    format!(
        "[Unit]\nDescription=NIE-SLA VPS Metrics Agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory={STATE_DIR}\nEnvironmentFile={ENV_FILE}\nExecStart={AGENT_BINARY}\nRestart=always\nRestartSec=15\nUser=nie-sla\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths={STATE_DIR}\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=multi-user.target\n"
    )
}

fn systemd_manager_unit() -> String {
    format!(
        "[Unit]\nDescription=NIE-SLA privileged Agent manager\nAfter=network-online.target {TELEMETRY_SERVICE}.service\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory={STATE_DIR}\nEnvironmentFile={ENV_FILE}\nEnvironment=NIE_SLA_TASK_RUNNER_ONLY=1\nExecStart={AGENT_BINARY} --task-runner-only\nRestart=always\nRestartSec=20\nUser=root\nPrivateTmp=true\nProtectHome=true\nUMask=0027\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=multi-user.target\n"
    )
}

fn systemd_recovery_update_service() -> String {
    format!(
        "[Unit]\nDescription=NIE-SLA privileged Agent recovery update\nAfter=network-online.target\n\n[Service]\nType=oneshot\nExecCondition=/bin/sh -c '! systemctl is-active --quiet {MANAGER_SERVICE}'\nExecStart={CFTZ_BINARY} update --automatic\n"
    )
}

fn systemd_recovery_update_timer() -> String {
    "[Unit]\nDescription=Recover NIE-SLA Agent manager and verified updates\n\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=1h\nRandomizedDelaySec=5min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n".to_string()
}

fn openrc_telemetry_service() -> String {
    format!(
        "#!/sbin/openrc-run\nname=\"{TELEMETRY_SERVICE}\"\ndescription=\"NIE-SLA VPS Metrics Agent\"\n\nstart() {{\n    ebegin \"Starting {TELEMETRY_SERVICE}\"\n    touch \"/var/log/{TELEMETRY_SERVICE}.log\"\n    chown nie-sla \"/var/log/{TELEMETRY_SERVICE}.log\" 2>/dev/null || true\n    start-stop-daemon --start --background --make-pidfile \\\n        --pidfile /run/{TELEMETRY_SERVICE}.pid \\\n        --user nie-sla \\\n        --exec /bin/sh -- \\\n        -c 'cd \"{STATE_DIR}\"; set -a; . \"{ENV_FILE}\"; set +a; exec \"{AGENT_BINARY}\" >>\"/var/log/{TELEMETRY_SERVICE}.log\" 2>&1'\n    eend $?\n}}\n\nstop() {{\n    ebegin \"Stopping {TELEMETRY_SERVICE}\"\n    start-stop-daemon --stop --pidfile /run/{TELEMETRY_SERVICE}.pid\n    eend $?\n}}\n\ndepend() {{ need net; }}\n"
    )
}

fn openrc_manager_service() -> String {
    format!(
        "#!/sbin/openrc-run\nname=\"{MANAGER_SERVICE}\"\ndescription=\"NIE-SLA privileged Agent manager\"\n\nstart() {{\n    ebegin \"Starting {MANAGER_SERVICE}\"\n    start-stop-daemon --start --background --make-pidfile \\\n        --pidfile /run/{MANAGER_SERVICE}.pid \\\n        --exec /bin/sh -- \\\n        -c 'cd \"{STATE_DIR}\"; set -a; . \"{ENV_FILE}\"; set +a; export NIE_SLA_TASK_RUNNER_ONLY=1; exec \"{AGENT_BINARY}\" --task-runner-only >>\"/var/log/{MANAGER_SERVICE}.log\" 2>&1'\n    eend $?\n}}\n\nstop() {{\n    ebegin \"Stopping {MANAGER_SERVICE}\"\n    start-stop-daemon --stop --pidfile /run/{MANAGER_SERVICE}.pid\n    eend $?\n}}\n\ndepend() {{ need net; after {TELEMETRY_SERVICE}; }}\n"
    )
}

fn install_openrc_recovery_job() -> Result<()> {
    let path = [
        Path::new("/etc/periodic/hourly/nie-sla-agent-update"),
        Path::new("/etc/cron.hourly/nie-sla-agent-update"),
    ]
    .into_iter()
    .find(|path| path.parent().is_some_and(Path::is_dir));
    let Some(path) = path else {
        return Ok(());
    };
    write_if_changed(path, openrc_recovery_update_job().as_bytes())?;
    set_executable(path)
}

fn openrc_recovery_update_job() -> String {
    format!(
        "#!/bin/sh\nif rc-service {MANAGER_SERVICE} status >/dev/null 2>&1; then\n  exit 0\nfi\nexec {CFTZ_BINARY} update --automatic >>/var/log/nie-sla-agent-update.log 2>&1\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config(path: PathBuf) -> Config {
        Config {
            api: "https://example.com".into(),
            token: "token".into(),
            agent_id: "agent-a".into(),
            agent_label: "Agent A".into(),
            sample_sec: 1,
            report_sec: 300,
            ping_sec: 20,
            ping_target_refresh_sec: 1800,
            ping_targets: "*".into(),
            queue_file: path,
            queue_max_samples: 1000,
            update_check_sec: 86_400,
            ws_enabled: false,
            once: false,
            task_runner_only: false,
        }
    }

    #[test]
    fn accepts_only_fresh_allow_listed_manager_heartbeat() {
        let base = std::env::temp_dir().join(format!(
            "nie-sla-manager-heartbeat-{}-{}",
            std::process::id(),
            now_sec()
        ));
        let cfg = test_config(base.join("queue.json"));
        fs::create_dir_all(&base).unwrap();
        fs::write(
            heartbeat_path(&cfg),
            json!({
                "protocol": 1,
                "mode": "manager",
                "privileged": true,
                "actions": ["nodequality", "ip_unlock"],
                "updated_at": now_sec()
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(reported_capabilities(&cfg)["mode"], "manager");
        fs::write(
            heartbeat_path(&cfg),
            json!({
                "protocol": 1,
                "mode": "manager",
                "privileged": true,
                "actions": ["arbitrary_shell"],
                "updated_at": now_sec()
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(reported_capabilities(&cfg)["mode"], "telemetry_only");
        assert_eq!(reported_capabilities(&cfg)["actions"], json!([]));
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn manager_unit_has_a_fixed_command_surface() {
        let unit = systemd_manager_unit();
        assert!(unit.contains("ExecStart=/opt/nie-sla-agent/nie-sla-agent --task-runner-only"));
        assert!(unit.contains("User=root"));
        assert!(!unit.contains("$NSTATUS_TASK"));
        assert!(!unit.contains("curl"));

        let openrc = openrc_manager_service();
        assert!(openrc.contains("start-stop-daemon --start --background --make-pidfile"));
        assert!(openrc.contains("exec \"/opt/nie-sla-agent/nie-sla-agent\" --task-runner-only"));
        assert!(!openrc.contains("--user nie-sla"));

        let path = std::env::temp_dir().join(format!(
            "nie-sla-openrc-manager-{}-{}",
            std::process::id(),
            now_sec()
        ));
        fs::write(&path, openrc).unwrap();
        let status = Command::new("sh").arg("-n").arg(&path).status().unwrap();
        let _ = fs::remove_file(path);
        assert!(status.success());
    }

    #[test]
    fn privileged_recovery_jobs_run_only_while_manager_is_down() {
        let systemd = systemd_recovery_update_service();
        assert!(systemd.contains(
            "ExecCondition=/bin/sh -c '! systemctl is-active --quiet nie-sla-agent-manager'"
        ));
        assert!(systemd.contains("ExecStart=/usr/local/bin/cftz update --automatic"));

        let openrc = openrc_recovery_update_job();
        assert!(openrc.contains("rc-service nie-sla-agent-manager status"));
        assert!(openrc.contains("exec /usr/local/bin/cftz update --automatic"));
    }

    #[test]
    fn watchdog_accepts_only_semantic_versions() {
        assert_eq!(canonical_version("v1.0.21").unwrap(), "v1.0.21");
        assert_eq!(canonical_version("1.2.3").unwrap(), "v1.2.3");
        assert!(canonical_version("1.2").is_err());
        assert!(canonical_version("1.2.3;reboot").is_err());
        assert!(stable_process_identity(Some("123"), Some("123")));
        assert!(!stable_process_identity(Some("123"), Some("124")));
        assert!(!stable_process_identity(Some("0"), Some("0")));
    }

    #[test]
    fn instance_lock_rejects_a_second_process() {
        let path = std::env::temp_dir().join(format!(
            "nie-sla-instance-lock-{}-{}",
            std::process::id(),
            now_sec()
        ));
        let first = acquire_instance_lock(&path, "test")
            .unwrap()
            .expect("first lock");
        let second = acquire_instance_lock(&path, "test").unwrap();
        assert!(second.is_none());
        drop(first);
        let third = acquire_instance_lock(&path, "test").unwrap();
        assert!(third.is_some());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn legacy_cleanup_contract_covers_previous_service_names() {
        assert!(LEGACY_SERVICE_NAMES.contains(&"nstatus-metrics.service"));
        assert!(LEGACY_SERVICE_NAMES.contains(&"nstatus-agent.service"));
        assert!(LEGACY_TIMER_NAMES.contains(&"nstatus-metrics-update.timer"));
        assert!(LEGACY_PROCESS_NAMES.contains(&"nstatus-metrics"));
    }
}
