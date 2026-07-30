use crate::updater::{restart_manager_after_update, spawn_manager_update_worker};
use crate::{now_sec, Config, HttpClient, UpdateOutcome, AGENT_VERSION};
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

const HEARTBEAT_MAX_AGE_SEC: u64 = 180;
const HEARTBEAT_INTERVAL_SEC: u64 = 15;
const TASK_POLL_SEC: u64 = crate::tasks::TASK_POLL_SEC;
const SERVICE_RECONCILE_SEC: u64 = 3600;
const AGENT_BINARY: &str = "/opt/nstatus-metrics/nstatus-metrics";
const ENV_FILE: &str = "/opt/nstatus-metrics/nstatus-metrics.env";
const STATE_DIR: &str = "/var/lib/nstatus-metrics";
const MANAGER_STATE_DIR: &str = "/var/lib/nstatus-manager";
const MANAGER_HEARTBEAT: &str = "/var/lib/nstatus-manager/manager-heartbeat";
const TELEMETRY_SERVICE: &str = "nstatus-metrics";
const MANAGER_SERVICE: &str = "nstatus-metrics-tasks";
const UPDATE_BACKUP: &str = "/opt/nstatus-metrics/nstatus-metrics.bak";
const UPDATE_FAILED: &str = "/opt/nstatus-metrics/nstatus-metrics.failed";
const UPDATE_CONFIRMATION: &str = "/var/lib/nstatus-manager/update-confirmed";
const UPDATE_CONFIRM_AFTER_SEC: u64 = 60;
const UPDATE_TELEMETRY_STABILITY_SEC: u64 = 30;
const UPDATE_WATCHDOG_TIMEOUT_SEC: u64 = 180;

pub(crate) fn run(cfg: &Config, http: &HttpClient) -> Result<()> {
    if !cfg!(target_os = "linux") {
        return Err(anyhow!(
            "the privileged Agent manager currently requires Linux"
        ));
    }
    if !is_root() {
        return Err(anyhow!("the Agent manager must run as root"));
    }

    reconcile_service_layout().context("reconcile Agent services")?;
    write_heartbeat(cfg, "current")?;
    retire_legacy_update_job();
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
        let unit = format!("nstatus-metrics-update-watchdog-{}", std::process::id());
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
        "mode": if cfg!(target_os = "linux") { "compatibility" } else { "telemetry_only" },
        "manager_version": Value::Null,
        "privileged": false,
        "actions": if cfg!(target_os = "linux") { vec!["ip_unlock"] } else { Vec::<&str>::new() },
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
    clear_legacy_ping_capability();
    if Path::new("/run/systemd/system").is_dir() && command_exists("systemctl") {
        let telemetry = systemd_telemetry_unit();
        let manager = systemd_manager_unit();
        let changed = write_if_changed(
            Path::new("/etc/systemd/system/nstatus-metrics.service"),
            telemetry.as_bytes(),
        )? | write_if_changed(
            Path::new("/etc/systemd/system/nstatus-metrics-tasks.service"),
            manager.as_bytes(),
        )?;
        if changed {
            run_checked(Command::new("systemctl").arg("daemon-reload"))?;
        }
        let _ = Command::new("systemctl")
            .args(["enable", TELEMETRY_SERVICE, MANAGER_SERVICE])
            .status();
    } else if Path::new("/etc/init.d").is_dir() && command_exists("rc-service") {
        write_if_changed(
            Path::new("/etc/init.d/nstatus-metrics"),
            openrc_telemetry_service().as_bytes(),
        )?;
        write_if_changed(
            Path::new("/etc/init.d/nstatus-metrics-tasks"),
            openrc_manager_service().as_bytes(),
        )?;
        set_executable(Path::new("/etc/init.d/nstatus-metrics"))?;
        set_executable(Path::new("/etc/init.d/nstatus-metrics-tasks"))?;
        let _ = Command::new("rc-update")
            .args(["add", TELEMETRY_SERVICE, "default"])
            .status();
        let _ = Command::new("rc-update")
            .args(["add", MANAGER_SERVICE, "default"])
            .status();
    }
    Ok(())
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

fn retire_legacy_update_job() {
    if Path::new("/run/systemd/system").is_dir() && command_exists("systemctl") {
        let _ = Command::new("systemctl")
            .args(["disable", "--now", "nstatus-metrics-update.timer"])
            .status();
    } else {
        for path in [
            "/etc/periodic/hourly/nstatus-metrics-update",
            "/etc/cron.hourly/nstatus-metrics-update",
        ] {
            if Path::new(path).is_file() && !Path::new(path).is_symlink() {
                let _ = fs::remove_file(path);
            }
        }
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
        "[Unit]\nDescription=NIE-SLA VPS Metrics Agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory={STATE_DIR}\nEnvironmentFile={ENV_FILE}\nExecStart={AGENT_BINARY}\nRestart=always\nRestartSec=15\nUser=nstatus\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths={STATE_DIR}\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=multi-user.target\n"
    )
}

fn systemd_manager_unit() -> String {
    format!(
        "[Unit]\nDescription=NIE-SLA privileged Agent manager\nAfter=network-online.target {TELEMETRY_SERVICE}.service\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory={STATE_DIR}\nEnvironmentFile={ENV_FILE}\nEnvironment=NSTATUS_TASK_RUNNER_ONLY=1\nExecStart={AGENT_BINARY} --task-runner-only\nRestart=always\nRestartSec=20\nUser=root\nPrivateTmp=true\nProtectHome=true\nUMask=0027\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=multi-user.target\n"
    )
}

fn openrc_telemetry_service() -> String {
    format!(
        "#!/sbin/openrc-run\nname=\"{TELEMETRY_SERVICE}\"\ndescription=\"NIE-SLA VPS Metrics Agent\"\n\nstart() {{\n    ebegin \"Starting {TELEMETRY_SERVICE}\"\n    touch \"/var/log/{TELEMETRY_SERVICE}.log\"\n    chown nstatus \"/var/log/{TELEMETRY_SERVICE}.log\" 2>/dev/null || true\n    start-stop-daemon --start --background --make-pidfile \\\n        --pidfile /run/{TELEMETRY_SERVICE}.pid \\\n        --user nstatus \\\n        --exec /bin/sh -- \\\n        -c 'cd \"{STATE_DIR}\"; set -a; . \"{ENV_FILE}\"; set +a; exec \"{AGENT_BINARY}\" >>\"/var/log/{TELEMETRY_SERVICE}.log\" 2>&1'\n    eend $?\n}}\n\nstop() {{\n    ebegin \"Stopping {TELEMETRY_SERVICE}\"\n    start-stop-daemon --stop --pidfile /run/{TELEMETRY_SERVICE}.pid\n    eend $?\n}}\n\ndepend() {{ need net; }}\n"
    )
}

fn openrc_manager_service() -> String {
    format!(
        "#!/sbin/openrc-run\nname=\"{MANAGER_SERVICE}\"\ndescription=\"NIE-SLA privileged Agent manager\"\n\nstart() {{\n    ebegin \"Starting {MANAGER_SERVICE}\"\n    start-stop-daemon --start --background --make-pidfile \\\n        --pidfile /run/{MANAGER_SERVICE}.pid \\\n        --exec /bin/sh -- \\\n        -c 'cd \"{STATE_DIR}\"; set -a; . \"{ENV_FILE}\"; set +a; export NSTATUS_TASK_RUNNER_ONLY=1; exec \"{AGENT_BINARY}\" --task-runner-only >>\"/var/log/{MANAGER_SERVICE}.log\" 2>&1'\n    eend $?\n}}\n\nstop() {{\n    ebegin \"Stopping {MANAGER_SERVICE}\"\n    start-stop-daemon --stop --pidfile /run/{MANAGER_SERVICE}.pid\n    eend $?\n}}\n\ndepend() {{ need net; after {TELEMETRY_SERVICE}; }}\n"
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
            ping_target_refresh_sec: 300,
            ping_targets: "*".into(),
            queue_file: path,
            queue_max_samples: 1000,
            update_check_sec: 3600,
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
        let expected_mode = if cfg!(target_os = "linux") {
            "compatibility"
        } else {
            "telemetry_only"
        };
        assert_eq!(reported_capabilities(&cfg)["mode"], expected_mode);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn manager_unit_has_a_fixed_command_surface() {
        let unit = systemd_manager_unit();
        assert!(unit.contains("ExecStart=/opt/nstatus-metrics/nstatus-metrics --task-runner-only"));
        assert!(!unit.contains("$NSTATUS_TASK"));
        assert!(!unit.contains("curl"));

        let openrc = openrc_manager_service();
        assert!(openrc.contains("start-stop-daemon --start --background --make-pidfile"));
        assert!(openrc.contains("exec \"/opt/nstatus-metrics/nstatus-metrics\" --task-runner-only"));

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
    fn watchdog_accepts_only_semantic_versions() {
        assert_eq!(canonical_version("v1.0.21").unwrap(), "v1.0.21");
        assert_eq!(canonical_version("1.2.3").unwrap(), "v1.2.3");
        assert!(canonical_version("1.2").is_err());
        assert!(canonical_version("1.2.3;reboot").is_err());
        assert!(stable_process_identity(Some("123"), Some("123")));
        assert!(!stable_process_identity(Some("123"), Some("124")));
        assert!(!stable_process_identity(Some("0"), Some("0")));
    }
}
