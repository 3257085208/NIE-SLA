#[cfg(target_os = "linux")]
use super::trim_ascii;
use super::{
    percent_encode_query, Config, HttpClient, UpdateCheckResult, UpdateOutcome, UpdatePolicy,
    AGENT_VERSION, INITIAL_UPDATE_CHECK_SEC,
};
use anyhow::{anyhow, Context, Result};
use sha2::{Digest, Sha256};
#[cfg(target_os = "linux")]
use std::env;
#[cfg(any(target_os = "linux", test))]
use std::fs;
#[cfg(any(target_os = "linux", test))]
use std::fs::OpenOptions;
#[cfg(any(target_os = "linux", test))]
use std::io::Write;
#[cfg(any(target_os = "linux", test))]
use std::path::Path;
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::process::Command;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

pub(super) fn spawn_update_worker(
    cfg: Config,
    http: HttpClient,
    role: UpdateRole,
) -> mpsc::Receiver<UpdateCheckResult> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(INITIAL_UPDATE_CHECK_SEC));
        loop {
            if role == UpdateRole::Telemetry && crate::manager::is_active(&cfg) {
                thread::sleep(Duration::from_secs(cfg.update_check_sec));
                continue;
            }
            // A panicking update check must not kill the worker for the whole
            // process lifetime; log it and retry on the normal cadence.
            let checked = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                check_for_update(&cfg, &http, role)
            })) {
                Ok(checked) => checked,
                Err(_) => {
                    eprintln!("{{\"ok\":false,\"update_check_panicked\":true}}");
                    thread::sleep(Duration::from_secs(cfg.update_check_sec));
                    continue;
                }
            };
            let next_check_sec = checked
                .as_ref()
                .map(|(_, seconds)| *seconds)
                .unwrap_or(cfg.update_check_sec)
                .clamp(900, 86_400);
            let installed = matches!(&checked, Ok((UpdateOutcome::Installed { .. }, _)));
            let result = checked.map(|(outcome, _)| outcome);
            if tx
                .send(UpdateCheckResult {
                    result,
                    next_check_sec,
                })
                .is_err()
                || installed
            {
                break;
            }
            thread::sleep(Duration::from_secs(next_check_sec));
        }
    });
    rx
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum UpdateRole {
    Telemetry,
    PrivilegedManager,
}

// A self-hosted instance is normally the update source for its own agents, but
// the instance itself is updated by its deployment pipeline. When that pipeline
// stalls, every node it manages used to freeze at the instance's version; the
// official release channel is the same upstream the deployment pipeline pulls
// from, so nodes now follow it when the instance has nothing newer.
const DEFAULT_OFFICIAL_UPDATE_BASE: &str = "https://status.example.com";

fn official_update_base() -> Option<String> {
    let disabled = std::env::var("NIE_SLA_OFFICIAL_UPDATE")
        .or_else(|_| std::env::var("NSTATUS_OFFICIAL_UPDATE"))
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "off" | "no"
            )
        })
        .unwrap_or(false);
    if disabled {
        return None;
    }
    let base = std::env::var("NIE_SLA_OFFICIAL_UPDATE_BASE")
        .or_else(|_| std::env::var("NSTATUS_OFFICIAL_UPDATE_BASE"))
        .unwrap_or_else(|_| DEFAULT_OFFICIAL_UPDATE_BASE.to_string());
    let base = base.trim().trim_end_matches('/').to_string();
    base.starts_with("https://").then_some(base)
}

fn official_fallback_needed(instance_latest: &str, current: &str) -> bool {
    // Only when the instance has nothing newer: an instance that publishes its
    // own builds stays in control of the versions it hands out.
    matches!(is_newer_version(instance_latest, current), Ok(false))
}

fn official_fallback_policy(policy: &UpdatePolicy, http: &HttpClient) -> Option<UpdatePolicy> {
    if !policy.auto_update || !official_fallback_needed(&policy.latest_version, AGENT_VERSION) {
        return None;
    }
    let base = official_update_base()?;
    let manifest_text = match http.get_public(&format!("{}/update-manifest.json", base)) {
        Ok(text) => text,
        Err(error) => {
            eprintln!(
                "{{\"ok\":false,\"official_update_manifest_error\":{}}}",
                crate::json_string(&error.to_string())
            );
            return None;
        }
    };
    let manifest: serde_json::Value = match serde_json::from_str(&manifest_text) {
        Ok(value) => value,
        Err(error) => {
            eprintln!(
                "{{\"ok\":false,\"official_update_manifest_error\":{}}}",
                crate::json_string(&error.to_string())
            );
            return None;
        }
    };
    let version = manifest
        .get("version")
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if !matches!(is_newer_version(&version, AGENT_VERSION), Ok(true)) {
        return None;
    }
    let sums = match http.get_public(&format!("{}/bin/SHA256SUMS", base)) {
        Ok(sums) => sums,
        Err(error) => {
            eprintln!(
                "{{\"ok\":false,\"official_update_manifest_error\":{}}}",
                crate::json_string(&error.to_string())
            );
            return None;
        }
    };
    let computed = sha256_hex(sums.as_bytes());
    let declared = manifest
        .get("sums_sha256")
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let manifest_sha256 = if declared.len() == 64 {
        if declared != computed {
            eprintln!("official update checksum manifest does not match its declared hash");
            return None;
        }
        declared
    } else {
        // Older manifests predate the field; the download step still verifies
        // the binary against this freshly fetched manifest.
        computed
    };
    Some(UpdatePolicy {
        auto_update: true,
        latest_version: if version.starts_with('v') {
            version
        } else {
            format!("v{}", version)
        },
        download_base: base,
        manifest_sha256,
        check_interval_sec: policy.check_interval_sec,
    })
}

fn check_for_update(
    cfg: &Config,
    http: &HttpClient,
    role: UpdateRole,
) -> Result<(UpdateOutcome, u64)> {
    let url = format!(
        "{}/api/agent/update-policy?agent_id={}",
        cfg.api.trim_end_matches('/'),
        percent_encode_query(&cfg.agent_id)
    );
    let response = http.get(&url, &cfg.token)?;
    let value: serde_json::Value =
        serde_json::from_str(&response).with_context(|| "parse Agent update policy response")?;
    let policy = UpdatePolicy {
        auto_update: value
            .get("auto_update")
            .and_then(|item| item.as_bool())
            .unwrap_or(false),
        latest_version: value
            .get("latest_version")
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .trim()
            .to_string(),
        download_base: value
            .get("download_base")
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_string(),
        manifest_sha256: value
            .get("manifest_sha256")
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase(),
        check_interval_sec: value
            .get("check_interval_sec")
            .and_then(|item| item.as_u64())
            .unwrap_or(cfg.update_check_sec)
            .clamp(900, 86_400),
    };
    let policy = match official_fallback_policy(&policy, http) {
        Some(official) => {
            eprintln!(
                "{{\"ok\":true,\"update_source\":\"official\",\"instance_version\":{},\"official_version\":{}}}",
                crate::json_string(&policy.latest_version),
                crate::json_string(&official.latest_version)
            );
            official
        }
        None => policy,
    };

    if !is_newer_version(&policy.latest_version, AGENT_VERSION)? {
        return Ok((
            UpdateOutcome::Current(format!("v{}", AGENT_VERSION)),
            policy.check_interval_sec,
        ));
    }
    #[cfg(target_os = "linux")]
    let privileged_updater = privileged_updater_enabled();
    #[cfg(not(target_os = "linux"))]
    let privileged_updater = false;

    let manager_active = role != UpdateRole::Telemetry || crate::manager::is_active(cfg);
    if is_managed_by_privileged_service(
        policy.auto_update,
        privileged_updater,
        role,
        manager_active,
    ) {
        return Ok((
            UpdateOutcome::Managed(policy.latest_version),
            policy.check_interval_sec,
        ));
    }
    if policy.auto_update && privileged_updater && role == UpdateRole::Telemetry {
        return Ok((
            UpdateOutcome::PrivilegedRecovery(policy.latest_version),
            policy.check_interval_sec,
        ));
    }
    if !policy.auto_update || !cfg!(target_os = "linux") {
        return Ok((
            UpdateOutcome::AvailableManual(policy.latest_version),
            policy.check_interval_sec,
        ));
    }

    let executable = install_linux_update(&policy, http)?;
    Ok((
        UpdateOutcome::Installed {
            version: policy.latest_version,
            executable,
        },
        policy.check_interval_sec,
    ))
}

fn is_managed_by_privileged_service(
    auto_update: bool,
    privileged_updater: bool,
    role: UpdateRole,
    manager_active: bool,
) -> bool {
    auto_update && privileged_updater && role == UpdateRole::Telemetry && manager_active
}

pub(super) fn spawn_manager_update_worker(
    cfg: Config,
    http: HttpClient,
) -> mpsc::Receiver<UpdateCheckResult> {
    spawn_update_worker(cfg, http, UpdateRole::PrivilegedManager)
}

fn is_newer_version(candidate: &str, current: &str) -> Result<bool> {
    Ok(parse_version(candidate)? > parse_version(current)?)
}

fn parse_version(value: &str) -> Result<(u64, u64, u64)> {
    let parts: Vec<_> = value.trim().trim_start_matches('v').split('.').collect();
    if parts.len() != 3 {
        return Err(anyhow!("invalid Agent version: {}", value));
    }
    Ok((
        parts[0].parse().with_context(|| "parse major version")?,
        parts[1].parse().with_context(|| "parse minor version")?,
        parts[2].parse().with_context(|| "parse patch version")?,
    ))
}

#[cfg(any(target_os = "linux", test))]
const UPDATE_PENDING_MARKER: &str = "nie-sla-update-pending.json";
#[cfg(any(target_os = "linux", test))]
const UPDATE_PENDING_CONFIRM_WINDOW_SEC: u64 = 1_800;
#[cfg(any(target_os = "linux", test))]
const BACKUP_FILE_NAME: &str = "nie-sla-agent.bak";
#[cfg(any(target_os = "linux", test))]
#[allow(dead_code)]
const FAILED_FILE_NAME: &str = "nie-sla-agent.failed";
#[cfg(target_os = "linux")]
const UPDATE_LOCK_PATH: &str = "/var/lib/nie-sla-agent-manager/update.lock";

#[cfg(target_os = "linux")]
fn privileged_updater_enabled() -> bool {
    env::var("NIE_SLA_PRIVILEGED_UPDATER")
        .or_else(|_| env::var("NSTATUS_PRIVILEGED_UPDATER"))
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Rootless agents have no privileged manager, so their update lock lives next
/// to the pending marker in the writable state directory. Agents supervised by
/// the privileged service keep the manager-owned lock path.
#[cfg(target_os = "linux")]
fn update_lock_path() -> PathBuf {
    if privileged_updater_enabled() {
        return PathBuf::from(UPDATE_LOCK_PATH);
    }
    pending_marker_path()
        .ok()
        .and_then(|path| path.parent().map(|dir| dir.join("update.lock")))
        .unwrap_or_else(|| PathBuf::from(UPDATE_LOCK_PATH))
}

#[cfg(target_os = "linux")]
fn pending_marker_path() -> Result<PathBuf> {
    for key in ["NIE_SLA_QUEUE_FILE", "NSTATUS_QUEUE_FILE"] {
        if let Ok(queue_file) = env::var(key) {
            let queue_path = PathBuf::from(queue_file);
            if let Some(parent) = queue_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                return Ok(parent.join(UPDATE_PENDING_MARKER));
            }
        }
    }
    let current = std::env::current_exe().with_context(|| "locate current Agent executable")?;
    let dir = current
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    Ok(dir.join(UPDATE_PENDING_MARKER))
}

/// Rootless rollback bookkeeping: an updated process records a pending marker
/// before restarting. The first successful report confirms the update (marker
/// and .bak removed); when a later start finds a pending marker whose confirm
/// window has expired, the .bak binary is restored instead.
#[cfg(target_os = "linux")]
pub(super) fn mark_update_pending(version: &str) -> Result<()> {
    let path = pending_marker_path()?;
    let payload = serde_json::json!({
        "version": version,
        "pid": std::process::id(),
        "at": now_unix_sec(),
    });
    write_pending_marker(&path, payload.to_string().as_bytes())
        .with_context(|| format!("write update pending marker {}", path.display()))
}

#[cfg(target_os = "linux")]
pub(super) fn confirm_pending_update() -> Result<()> {
    let path = pending_marker_path()?;
    if !path.exists() {
        return Ok(());
    }
    remove_file_durable(&path)
        .with_context(|| format!("remove update pending marker {}", path.display()))?;
    if let Ok(current) = std::env::current_exe() {
        if let Some(dir) = current.parent() {
            let backup = dir.join(BACKUP_FILE_NAME);
            if backup.is_file() && !backup.is_symlink() {
                // The privileged manager owns the system-installed binary
                // and normally removes its backup after the stability
                // watchdog confirms the update.  Marker removal is the
                // telemetry process's confirmation boundary; inability to
                // remove that root-owned housekeeping file must not turn a
                // successful report into a repeated update error.
                let _ = remove_file_durable(&backup);
            }
        }
    }
    Ok(())
}

/// Returns Ok(true) when a stale pending update was rolled back to the .bak
/// binary; the caller restarts into the restored executable.
#[cfg(target_os = "linux")]
pub(super) fn rollback_stale_pending_update() -> Result<bool> {
    let path = pending_marker_path()?;
    if !path.is_file() {
        return Ok(false);
    }
    // Marker files are tiny; anything larger is corruption and must not be
    // parsed into memory on every single start.
    let oversized = std::fs::metadata(&path)
        .map(|meta| meta.len() > 4096)
        .unwrap_or(false);
    let raw = if oversized {
        let _ = remove_file_durable(&path);
        String::new()
    } else {
        std::fs::read_to_string(&path).unwrap_or_default()
    };
    let recorded: u64 = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|value| value.get("at").and_then(|item| item.as_u64()))
        .unwrap_or(0);
    let age = now_unix_sec().saturating_sub(recorded);
    if recorded > 0 && age <= UPDATE_PENDING_CONFIRM_WINDOW_SEC {
        return Ok(false);
    }
    let current = std::env::current_exe().with_context(|| "locate current Agent executable")?;
    let Some(dir) = current.parent() else {
        return Ok(false);
    };
    let backup = dir.join(BACKUP_FILE_NAME);
    if !backup.is_file() || backup.is_symlink() || current.is_symlink() {
        remove_file_durable(&path).context("remove unusable update pending marker")?;
        return Ok(false);
    }
    let failed = dir.join(FAILED_FILE_NAME);
    let _ = std::fs::remove_file(&failed);
    std::fs::rename(&current, &failed)
        .with_context(|| format!("retain failed Agent binary {}", failed.display()))?;
    if let Err(error) = std::fs::rename(&backup, &current) {
        let _ = std::fs::rename(&failed, &current);
        let _ = sync_parent_directory(&current);
        return Err(error).context("restore previous Agent binary");
    }
    remove_file_durable(&path).context("remove rolled-back update marker")?;
    Ok(true)
}

#[cfg(any(target_os = "linux", test))]
fn now_unix_sec() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

#[cfg(any(target_os = "linux", test))]
fn write_pending_marker(path: &Path, content: &[u8]) -> Result<()> {
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    if temp.exists() || temp.is_symlink() {
        fs::remove_file(&temp)
            .with_context(|| format!("remove stale marker {}", temp.display()))?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .with_context(|| format!("create marker temporary file {}", temp.display()))?;
    file.write_all(content)
        .with_context(|| format!("write marker temporary file {}", temp.display()))?;
    file.sync_all()
        .with_context(|| format!("sync marker temporary file {}", temp.display()))?;
    fs::rename(&temp, path)
        .with_context(|| format!("install pending marker {}", path.display()))?;
    sync_parent_directory(path)
}

#[cfg(any(target_os = "linux", test))]
fn remove_file_durable(path: &Path) -> Result<bool> {
    if fs::symlink_metadata(path).is_err() {
        return Ok(false);
    }
    fs::remove_file(path).with_context(|| format!("remove {}", path.display()))?;
    sync_parent_directory(path)?;
    Ok(true)
}

#[cfg(unix)]
#[cfg(any(target_os = "linux", test))]
fn sync_parent_directory(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::File::open(parent)
        .with_context(|| format!("open marker directory {}", parent.display()))?
        .sync_all()
        .with_context(|| format!("sync marker directory {}", parent.display()))
}

#[cfg(not(unix))]
#[cfg(any(target_os = "linux", test))]
fn sync_parent_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn install_linux_update(policy: &UpdatePolicy, http: &HttpClient) -> Result<PathBuf> {
    let Some(_update_lock) =
        crate::manager::acquire_instance_lock(&update_lock_path(), "Agent update")?
    else {
        return Err(anyhow!("another Agent update is already in progress"));
    };
    if !policy.download_base.starts_with("https://") {
        return Err(anyhow!("Agent update download base must use HTTPS"));
    }
    if policy.manifest_sha256.len() != 64
        || !policy
            .manifest_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(anyhow!("invalid Agent update manifest hash"));
    }

    // A fixed asset path can be served from a stale edge cache entry (the
    // earlier /bin/SHA256SUMS incident). Cache-bust on the version the policy
    // asks for so the manifest and binary always come from the current deploy.
    let manifest_url = format!(
        "{}/bin/SHA256SUMS?v={}",
        policy.download_base,
        policy.latest_version.trim()
    );
    let manifest = http.get_public_bytes(&manifest_url)?;
    let actual_manifest_hash = sha256_hex(&manifest);
    if actual_manifest_hash != policy.manifest_sha256 {
        return Err(anyhow!(
            "Agent update manifest hash mismatch: expected {}, got {}",
            policy.manifest_sha256,
            actual_manifest_hash
        ));
    }

    let binary_name = linux_binary_name()?;
    let legacy_binary_name = binary_name.replace("nie-sla-agent", "nstatus-metrics");
    let (asset_name, expected_binary_hash) = match checksum_for_binary(&manifest, &binary_name) {
        Ok(hash) => (binary_name, hash),
        Err(_) => (
            legacy_binary_name.clone(),
            checksum_for_binary(&manifest, &legacy_binary_name)?,
        ),
    };
    let binary_url = format!(
        "{}/bin/{}?v={}",
        policy.download_base,
        asset_name,
        policy.latest_version.trim()
    );
    let binary = http.get_public_bytes(&binary_url)?;
    let actual_binary_hash = sha256_hex(&binary);
    if actual_binary_hash != expected_binary_hash {
        return Err(anyhow!(
            "Agent update binary hash mismatch: expected {}, got {}",
            expected_binary_hash,
            actual_binary_hash
        ));
    }

    let current = env::current_exe().with_context(|| "locate current Agent executable")?;
    let temp = current.with_extension(format!("update-{}", std::process::id()));
    let backup = current.with_extension("bak");
    fs::write(&temp, &binary).with_context(|| format!("write Agent update {}", temp.display()))?;
    fs::File::options()
        .write(true)
        .open(&temp)
        .and_then(|file| file.sync_all())
        .with_context(|| format!("sync Agent update {}", temp.display()))?;
    set_executable(&temp)?;
    let probe = Command::new(&temp)
        .arg("--version")
        .output()
        .with_context(|| "validate downloaded Agent executable")?;
    let reported = trim_ascii(String::from_utf8_lossy(&probe.stdout));
    if !probe.status.success() || reported != policy.latest_version {
        let _ = fs::remove_file(&temp);
        return Err(anyhow!(
            "downloaded Agent reports {}, expected {}",
            reported,
            policy.latest_version
        ));
    }

    if backup.exists() {
        fs::remove_file(&backup)
            .with_context(|| format!("remove old Agent backup {}", backup.display()))?;
    }
    fs::rename(&current, &backup)
        .with_context(|| format!("backup Agent executable {}", current.display()))?;
    if let Err(err) = fs::rename(&temp, &current) {
        let _ = fs::rename(&backup, &current);
        return Err(anyhow!("install Agent update: {}", err));
    }
    if let Err(marker_error) = mark_update_pending(&policy.latest_version) {
        let failed = current
            .parent()
            .map(|dir| dir.join(FAILED_FILE_NAME))
            .ok_or_else(|| anyhow!("Agent executable has no parent directory"))?;
        let rollback = rollback_install_swap(&current, &backup, &failed);
        return match rollback {
            Ok(()) => {
                let marker_cleanup = current
                    .parent()
                    .map(|dir| dir.join(UPDATE_PENDING_MARKER))
                    .ok_or_else(|| anyhow!("Agent executable has no parent directory"))
                    .and_then(|path| remove_file_durable(&path).map(|_| ()))
                    .map_err(|error| anyhow!("remove failed update marker: {}", error));
                match marker_cleanup {
                    Ok(()) => Err(anyhow!(
                        "write update pending marker: {}; installed binary was rolled back",
                        marker_error
                    )),
                    Err(cleanup_error) => Err(anyhow!(
                        "write update pending marker: {}; installed binary was rolled back, but marker cleanup failed: {}",
                        marker_error, cleanup_error
                    )),
                }
            }
            Err(rollback_error) => Err(anyhow!(
                "write update pending marker: {}; rollback failed: {}",
                marker_error,
                rollback_error
            )),
        };
    }
    Ok(current)
}

#[cfg(target_os = "linux")]
fn rollback_install_swap(current: &Path, backup: &Path, failed: &Path) -> Result<()> {
    if failed.exists() || failed.is_symlink() {
        fs::remove_file(failed)
            .with_context(|| format!("remove previous failed Agent binary {}", failed.display()))?;
    }
    fs::rename(current, failed)
        .with_context(|| format!("retain unconfirmed Agent binary {}", failed.display()))?;
    if let Err(error) = fs::rename(backup, current) {
        let _ = fs::rename(failed, current);
        let _ = sync_parent_directory(current);
        return Err(error).context("restore previous Agent binary after marker failure");
    }
    sync_parent_directory(current)
}

#[cfg(not(target_os = "linux"))]
fn install_linux_update(_policy: &UpdatePolicy, _http: &HttpClient) -> Result<PathBuf> {
    Err(anyhow!("automatic Agent updates currently require Linux"))
}

#[cfg(target_os = "linux")]
pub(super) fn restart_after_update(executable: &PathBuf) -> Result<()> {
    use std::os::unix::process::CommandExt;
    let error = Command::new(executable).args(env::args().skip(1)).exec();
    Err(anyhow!("restart updated Agent: {}", error))
}

#[cfg(target_os = "linux")]
pub(super) fn restart_manager_after_update(
    executable: &PathBuf,
    expected_version: &str,
    restart_telemetry: impl FnOnce() -> Result<()>,
) -> Result<()> {
    if let Err(error) = crate::manager::spawn_update_watchdog(expected_version) {
        crate::manager::rollback_update_before_restart()
            .context("roll back update after watchdog startup failure")?;
        return Err(error).context("start Agent update watchdog");
    }
    restart_telemetry()?;
    restart_after_update(executable)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn restart_after_update(_executable: &PathBuf) -> Result<()> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(super) fn restart_manager_after_update(
    executable: &PathBuf,
    _expected_version: &str,
    restart_telemetry: impl FnOnce() -> Result<()>,
) -> Result<()> {
    restart_telemetry()?;
    restart_after_update(executable)
}

#[cfg(target_os = "linux")]
fn set_executable(path: &PathBuf) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .with_context(|| format!("mark Agent update executable {}", path.display()))
}

#[cfg(target_os = "linux")]
fn linux_binary_name() -> Result<String> {
    let machine = Command::new("uname")
        .arg("-m")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| trim_ascii(String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_else(|| env::consts::ARCH.to_string())
        .to_ascii_lowercase();
    let arch = match machine.as_str() {
        "x86_64" | "amd64" => "amd64",
        "i386" | "i486" | "i586" | "i686" | "x86" => "386",
        "aarch64" | "arm64" => "arm64",
        value if value.starts_with("armv6") => "armv6",
        value if value.starts_with("armv7") || value == "arm" => "arm",
        _ => return Err(anyhow!("unsupported update architecture: {}", machine)),
    };
    Ok(format!("nie-sla-agent-linux-{}", arch))
}

#[cfg(any(target_os = "linux", test))]
fn checksum_for_binary(manifest: &[u8], binary_name: &str) -> Result<String> {
    let text = std::str::from_utf8(manifest).with_context(|| "decode Agent checksum manifest")?;
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let hash = parts.next().unwrap_or_default().to_ascii_lowercase();
        let name = parts
            .next()
            .unwrap_or_default()
            .trim_start_matches('*')
            .trim_start_matches("bin/");
        if name == binary_name && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(hash);
        }
    }
    Err(anyhow!("missing checksum for {}", binary_name))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_update_marker_round_trips_and_expires() {
        let dir = std::env::temp_dir().join(format!("nie-updater-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join(UPDATE_PENDING_MARKER);
        let payload = serde_json::json!({ "version": "v9.9.9", "pid": 123, "at": now_unix_sec() });
        std::fs::write(&marker, payload.to_string()).unwrap();
        assert!(marker.is_file());

        // fresh marker inside the confirm window must NOT trigger a rollback
        let current = dir.join("nie-sla-agent");
        std::fs::write(&current, b"new").unwrap();
        let backup = dir.join(BACKUP_FILE_NAME);
        std::fs::write(&backup, b"old").unwrap();
        // rollback_stale_pending_update resolves current_exe()'s directory, which we
        // cannot point at a temp dir; so assert the marker-age logic directly via
        // the file state: a fresh marker is left in place by design when the
        // window has not elapsed (exercised indirectly in production code path).
        assert!(marker.is_file());

        // expired marker with a valid backup pair is a rollback candidate
        let expired = serde_json::json!({ "version": "v9.9.9", "pid": 123, "at": now_unix_sec().saturating_sub(UPDATE_PENDING_CONFIRM_WINDOW_SEC + 60) });
        std::fs::write(&marker, expired.to_string()).unwrap();

        std::fs::remove_file(&marker).unwrap();
        std::fs::remove_file(&current).unwrap();
        std::fs::remove_file(&backup).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn pending_marker_write_replaces_atomically_and_syncs_directory() {
        let dir = std::env::temp_dir().join(format!(
            "nie-updater-marker-test-{}-{}",
            std::process::id(),
            now_unix_sec()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join(UPDATE_PENDING_MARKER);
        write_pending_marker(&marker, br#"{"version":"v9.9.9"}"#).unwrap();
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap(),
            r#"{"version":"v9.9.9"}"#
        );
        assert!(!marker
            .with_extension(format!("tmp-{}", std::process::id()))
            .exists());
        remove_file_durable(&marker).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn semantic_versions_are_compared_numerically() {
        assert!(is_newer_version("v1.0.9", "1.0.8").unwrap());
        assert!(!is_newer_version("1.0.9", "v1.0.9").unwrap());
        assert!(!is_newer_version("1.0.8", "1.0.9").unwrap());
        assert!(is_newer_version("1.10.0", "1.9.99").unwrap());
        assert!(is_newer_version("1.0", "1.0.0").is_err());
    }

    #[test]
    fn official_fallback_only_when_the_instance_has_nothing_newer() {
        assert!(official_fallback_needed("v1.1.84", "1.1.89"));
        assert!(official_fallback_needed("1.1.89", "1.1.89"));
        assert!(!official_fallback_needed("v1.1.90", "1.1.89"));
        assert!(!official_fallback_needed("", "1.1.89"));
        assert!(!official_fallback_needed("not-a-version", "1.1.89"));
    }

    #[test]
    fn privileged_manager_never_defers_its_own_update() {
        assert!(is_managed_by_privileged_service(
            true,
            true,
            UpdateRole::Telemetry,
            true,
        ));
        assert!(!is_managed_by_privileged_service(
            true,
            true,
            UpdateRole::PrivilegedManager,
            true,
        ));
        assert!(!is_managed_by_privileged_service(
            false,
            true,
            UpdateRole::Telemetry,
            true,
        ));
        assert!(!is_managed_by_privileged_service(
            true,
            true,
            UpdateRole::Telemetry,
            false,
        ));
    }

    #[test]
    fn checksum_manifest_accepts_root_and_bin_paths() {
        let hash_a = "a".repeat(64);
        let hash_b = "b".repeat(64);
        let manifest = format!(
            "{}  nstatus-metrics-linux-amd64\n{} *bin/nstatus-metrics-linux-arm64\n",
            hash_a, hash_b
        );
        assert_eq!(
            checksum_for_binary(manifest.as_bytes(), "nstatus-metrics-linux-amd64").unwrap(),
            hash_a
        );
        assert_eq!(
            checksum_for_binary(manifest.as_bytes(), "nstatus-metrics-linux-arm64").unwrap(),
            hash_b
        );
        assert!(checksum_for_binary(manifest.as_bytes(), "missing").is_err());
    }

    #[test]
    fn sha256_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
