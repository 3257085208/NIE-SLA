#[cfg(target_os = "linux")]
use super::trim_ascii;
use super::{
    percent_encode_query, Config, HttpClient, UpdateCheckResult, UpdateOutcome, UpdatePolicy,
    AGENT_VERSION, INITIAL_UPDATE_CHECK_SEC,
};
use anyhow::{anyhow, Context, Result};
#[cfg(any(target_os = "linux", test))]
use sha2::{Digest, Sha256};
#[cfg(target_os = "linux")]
use std::env;
#[cfg(target_os = "linux")]
use std::fs;
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::process::Command;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

pub(super) fn spawn_update_worker(
    cfg: Config,
    http: HttpClient,
) -> mpsc::Receiver<UpdateCheckResult> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(INITIAL_UPDATE_CHECK_SEC));
        loop {
            let checked = check_for_update(&cfg, &http);
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

fn check_for_update(cfg: &Config, http: &HttpClient) -> Result<(UpdateOutcome, u64)> {
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

    if !is_newer_version(&policy.latest_version, AGENT_VERSION)? {
        return Ok((
            UpdateOutcome::Current(format!("v{}", AGENT_VERSION)),
            policy.check_interval_sec,
        ));
    }
    #[cfg(target_os = "linux")]
    let privileged_updater = env::var("NSTATUS_PRIVILEGED_UPDATER")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    #[cfg(not(target_os = "linux"))]
    let privileged_updater = false;

    if policy.auto_update && privileged_updater {
        return Ok((
            UpdateOutcome::Managed(policy.latest_version),
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

#[cfg(target_os = "linux")]
fn install_linux_update(policy: &UpdatePolicy, http: &HttpClient) -> Result<PathBuf> {
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

    let manifest_url = format!("{}/bin/SHA256SUMS", policy.download_base);
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
    let expected_binary_hash = checksum_for_binary(&manifest, &binary_name)?;
    let binary_url = format!("{}/bin/{}", policy.download_base, binary_name);
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
    Ok(current)
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

#[cfg(not(target_os = "linux"))]
pub(super) fn restart_after_update(_executable: &PathBuf) -> Result<()> {
    Ok(())
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
    Ok(format!("nstatus-metrics-linux-{}", arch))
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

#[cfg(any(target_os = "linux", test))]
fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semantic_versions_are_compared_numerically() {
        assert!(is_newer_version("v1.0.9", "1.0.8").unwrap());
        assert!(!is_newer_version("1.0.9", "v1.0.9").unwrap());
        assert!(!is_newer_version("1.0.8", "1.0.9").unwrap());
        assert!(is_newer_version("1.10.0", "1.9.99").unwrap());
        assert!(is_newer_version("1.0", "1.0.0").is_err());
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
