use crate::{percent_encode_query, Config, HttpClient, AGENT_VERSION};
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, SystemTime};

pub(crate) const TASK_POLL_SEC: u64 = 300;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_EXCERPT_CHARS: usize = 16 * 1024;
const IP_UNLOCK_ARGS: [&str; 4] = ["-4", "-j", "-n", "-p"];
const SYSTEM_TASK_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const OPTIONAL_DIG_HELPER: &[u8] =
    b"#!/bin/sh\nexec \"$NSTATUS_DNS_COMPAT_EXECUTABLE\" --dns-compat dig \"$@\"\n";
const OPTIONAL_NSLOOKUP_HELPER: &[u8] =
    b"#!/bin/sh\nexec \"$NSTATUS_DNS_COMPAT_EXECUTABLE\" --dns-compat nslookup \"$@\"\n";
const JQ_RELEASE_BASE: &str = "https://github.com/jqlang/jq/releases/download/jq-1.8.1";
const MAX_JQ_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct JqAsset {
    name: &'static str,
    sha256: &'static str,
}

pub(crate) fn spawn_ip_unlock_fallback(cfg: Config, http: HttpClient) {
    if !cfg!(target_os = "linux") {
        return;
    }
    thread::spawn(move || {
        run_ip_unlock_fallback_loop(&cfg, &http);
    });
}

pub(crate) fn poll_once_manager(cfg: &Config, http: &HttpClient) -> Result<()> {
    poll_once(cfg, http, None)
}

fn run_ip_unlock_fallback_loop(cfg: &Config, http: &HttpClient) {
    loop {
        if dedicated_task_runner_is_recent(cfg) {
            thread::sleep(Duration::from_secs(TASK_POLL_SEC));
            continue;
        }
        if let Err(error) = poll_once(cfg, http, Some("ip_unlock")) {
            eprintln!(
                "{{\"ok\":false,\"task_error\":{}}}",
                serde_json::to_string(&error.to_string())
                    .unwrap_or_else(|_| "\"task failed\"".into())
            );
        }
        thread::sleep(Duration::from_secs(TASK_POLL_SEC));
    }
}

fn poll_once(cfg: &Config, http: &HttpClient, allowed_actions: Option<&str>) -> Result<()> {
    let mut url = format!(
        "{}/api/agent/tasks?agent_id={}",
        cfg.api.trim_end_matches('/'),
        percent_encode_query(&cfg.agent_id)
    );
    if let Some(actions) = allowed_actions {
        url.push_str("&actions=");
        url.push_str(&percent_encode_query(actions));
    }
    let response: Value = serde_json::from_str(&http.get(&url, &cfg.token)?)?;
    let Some(task) = response.get("task").filter(|value| !value.is_null()) else {
        return Ok(());
    };
    let task_id = task
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("task response has no id"))?;
    let action = task
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("task response has no action"))?;
    let timeout_sec = task
        .get("timeout_sec")
        .and_then(Value::as_u64)
        .unwrap_or(600)
        .clamp(30, 1800);

    let outcome = execute_fixed_task(cfg, http, action, timeout_sec);
    let payload = match outcome {
        Ok(result) => json!({
            "status": "succeeded",
            "result": result.result,
            "output_excerpt": result.excerpt,
            "agent_version": format!("v{}", AGENT_VERSION),
        }),
        Err(error) => json!({
            "status": "failed",
            "error": error.to_string(),
            "agent_version": format!("v{}", AGENT_VERSION),
        }),
    };
    let result_url = format!(
        "{}/api/agent/tasks/{}?agent_id={}",
        cfg.api.trim_end_matches('/'),
        percent_encode_query(task_id),
        percent_encode_query(&cfg.agent_id)
    );
    http.post_json(&result_url, &cfg.token, &payload.to_string())?;
    Ok(())
}

fn dedicated_task_runner_is_recent(cfg: &Config) -> bool {
    crate::manager::is_active(cfg)
}

struct TaskOutput {
    result: Value,
    excerpt: String,
}

fn execute_fixed_task(
    cfg: &Config,
    http: &HttpClient,
    action: &str,
    timeout_sec: u64,
) -> Result<TaskOutput> {
    if !cfg!(target_os = "linux") {
        return Err(anyhow!("Beta task actions currently require Linux"));
    }
    match action {
        "nodequality" => run_nodequality(cfg, http, timeout_sec),
        "ip_unlock" => run_ip_unlock(cfg, http, timeout_sec),
        _ => Err(anyhow!("unsupported fixed task action")),
    }
}

fn run_nodequality(cfg: &Config, http: &HttpClient, timeout_sec: u64) -> Result<TaskOutput> {
    let output = run_fixed_remote_script(
        cfg,
        http,
        timeout_sec.min(1800),
        "https://run.NodeQuality.com",
        &[],
        Some(b"v\ny\ny\ny\n"),
    )?;
    ensure_script_success(&output)?;
    let clean = strip_ansi_codes(&output.text);
    let report_url = extract_report_url(&clean)
        .ok_or_else(|| anyhow!("NodeQuality completed without a report URL"))?;
    Ok(TaskOutput {
        result: json!({ "report_url": report_url }),
        excerpt: output_excerpt(&clean),
    })
}

fn run_ip_unlock(cfg: &Config, http: &HttpClient, timeout_sec: u64) -> Result<TaskOutput> {
    let output = run_fixed_remote_script(
        cfg,
        http,
        timeout_sec.min(600),
        "https://IP.Check.Place",
        &IP_UNLOCK_ARGS,
        None,
    )?;
    if let Some(result) = parse_ip_unlock_task_output(&output.text) {
        return Ok(result);
    }
    ensure_script_success(&output)?;
    Err(anyhow!("IP unlock check produced no IPv4 unlock rows"))
}

fn parse_ip_unlock_task_output(output: &str) -> Option<TaskOutput> {
    let clean = strip_ansi_codes(output);
    let services = parse_unlock_json(&clean).unwrap_or_else(|| parse_unlock_services(&clean));
    if services.is_empty() {
        return None;
    }
    Some(TaskOutput {
        result: json!({ "services": services }),
        excerpt: output_excerpt(&unlock_section(&clean)),
    })
}

struct FixedScriptOutput {
    text: String,
    status: std::process::ExitStatus,
}

fn ensure_script_success(output: &FixedScriptOutput) -> Result<()> {
    if output.status.success() {
        return Ok(());
    }
    Err(anyhow!(
        "fixed Beta task exited with {}; {}",
        output.status,
        output_excerpt(&strip_ansi_codes(&output.text))
    ))
}

fn parse_unlock_json(output: &str) -> Option<Vec<Value>> {
    output.match_indices('{').find_map(|(start, _)| {
        let value = serde_json::Deserializer::from_str(&output[start..])
            .into_iter::<Value>()
            .next()?
            .ok()?;
        unlock_services_from_json(&value)
    })
}

fn unlock_services_from_json(value: &Value) -> Option<Vec<Value>> {
    let media = value.get("Media")?.as_object()?;
    let keys = [
        ("tiktok", "TikTok", "TikTok"),
        ("disney_plus", "Disney+", "DisneyPlus"),
        ("netflix", "Netflix", "Netflix"),
        ("youtube", "Youtube", "Youtube"),
        ("amazon_pv", "AmazonPV", "AmazonPrimeVideo"),
        ("reddit", "Reddit", "Reddit"),
        ("chatgpt", "ChatGPT", "ChatGPT"),
    ];
    let services = keys
        .iter()
        .filter_map(|(id, name, key)| {
            let item = media.get(*key)?.as_object()?;
            let status = json_text(item.get("Status"));
            let region = json_text(item.get("Region"));
            let method = json_text(item.get("Type"));
            (!status.is_empty() || !region.is_empty() || !method.is_empty()).then(|| {
                json!({ "id": id, "name": name, "status": status, "region": region, "method": method })
            })
        })
        .collect::<Vec<_>>();
    (!services.is_empty()).then_some(services)
}

fn json_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().chars().take(80).collect(),
        Some(value) if !value.is_null() => value.to_string().chars().take(80).collect(),
        _ => String::new(),
    }
}

fn run_fixed_remote_script(
    cfg: &Config,
    http: &HttpClient,
    timeout_sec: u64,
    url: &str,
    args: &[&str],
    stdin: Option<&[u8]>,
) -> Result<FixedScriptOutput> {
    if !matches!(
        url,
        "https://run.NodeQuality.com" | "https://IP.Check.Place"
    ) {
        return Err(anyhow!("unsupported fixed task source"));
    }
    let task_dir = secure_task_directory(cfg)?.join(format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::create_dir(&task_dir).context("create isolated fixed task directory")?;
    set_private_directory_permissions(&task_dir)?;
    let _cleanup = TaskDirectoryCleanup(task_dir.clone());
    let script_path = task_dir.join("task.sh");
    let agent_executable =
        env::current_exe().context("locate Agent DNS compatibility executable")?;
    let script = http.get_public_bytes_limited(url, 2 * 1024 * 1024)?;
    if script.is_empty() {
        return Err(anyhow!("fixed Beta task download is empty"));
    }
    let mut script_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&script_path)
        .context("create fixed Beta task file")?;
    set_private_file_permissions(&script_path)?;
    script_file
        .write_all(&script)
        .context("write fixed Beta task file")?;
    drop(script_file);
    let task_path = prepare_fixed_task_path(&task_dir, url, SYSTEM_TASK_PATH, http, &cfg.api)?;

    let mut child = Command::new("timeout")
        .arg(format!("{}s", timeout_sec))
        .arg("bash")
        .arg(&script_path)
        .args(args)
        .current_dir(&task_dir)
        .env_clear()
        .env("PATH", task_path)
        .env("HOME", &task_dir)
        .env("LANG", "C.UTF-8")
        .env("NSTATUS_DNS_COMPAT_EXECUTABLE", agent_executable)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("failed to start fixed Beta task")?;
    if let (Some(input), Some(mut handle)) = (stdin, child.stdin.take()) {
        handle
            .write_all(input)
            .context("failed to send fixed task input")?;
    }
    let stdout = child.stdout.take().context("capture fixed task stdout")?;
    let stderr = child.stderr.take().context("capture fixed task stderr")?;
    let stdout_reader = thread::spawn(move || read_capped(stdout, MAX_OUTPUT_BYTES / 2));
    let stderr_reader = thread::spawn(move || read_capped(stderr, MAX_OUTPUT_BYTES / 2));
    let status = child.wait().context("failed to wait for fixed Beta task")?;
    let mut bytes = stdout_reader.join().unwrap_or_default();
    bytes.push(b'\n');
    bytes.extend(stderr_reader.join().unwrap_or_default());
    let text = String::from_utf8_lossy(&bytes).to_string();
    Ok(FixedScriptOutput { text, status })
}

fn prepare_fixed_task_path(
    task_dir: &Path,
    url: &str,
    system_path: &str,
    http: &HttpClient,
    api_base: &str,
) -> Result<OsString> {
    if url != "https://IP.Check.Place" {
        return Ok(OsString::from(system_path));
    }
    let needs_dig = !task_command_exists(system_path, "dig");
    let needs_nslookup = !task_command_exists(system_path, "nslookup");
    let needs_jq = !task_command_exists(system_path, "jq");
    if !needs_dig && !needs_nslookup && !needs_jq {
        return Ok(OsString::from(system_path));
    }

    let bin_dir = task_dir.join("bin");
    fs::create_dir(&bin_dir).context("create fixed task compatibility directory")?;
    set_private_directory_permissions(&bin_dir)?;
    if needs_dig {
        // The upstream script treats an optional DNSBL lookup as fatal after media checks.
        write_private_executable(
            &bin_dir.join("dig"),
            OPTIONAL_DIG_HELPER,
            "optional DNS compatibility helper",
        )?;
    }
    if needs_nslookup {
        write_private_executable(
            &bin_dir.join("nslookup"),
            OPTIONAL_NSLOOKUP_HELPER,
            "optional DNS compatibility helper",
        )?;
    }
    if needs_jq {
        install_pinned_task_jq(http, &bin_dir, api_base)?;
    }

    let mut path = bin_dir.into_os_string();
    path.push(":");
    path.push(system_path);
    Ok(path)
}

fn install_pinned_task_jq(http: &HttpClient, bin_dir: &Path, api_base: &str) -> Result<()> {
    let asset = jq_asset_for_current_target()
        .ok_or_else(|| anyhow!("IP unlock compatibility does not support this CPU architecture"))?;
    let mut failures = Vec::new();
    for url in jq_download_urls(api_base, asset) {
        match http.get_public_bytes_limited(&url, MAX_JQ_BYTES) {
            Ok(bytes) => {
                let actual = format!("{:x}", Sha256::digest(&bytes));
                if actual == asset.sha256 {
                    return write_private_executable(
                        &bin_dir.join("jq"),
                        &bytes,
                        "pinned jq compatibility asset",
                    );
                }
                failures.push(format!("{} returned SHA-256 {}", url, actual));
            }
            Err(error) => failures.push(format!("{}: {:#}", url, error)),
        }
    }
    Err(anyhow!(
        "download pinned jq compatibility asset {} failed: {}",
        asset.name,
        failures.join("; ")
    ))
}

fn jq_download_urls(api_base: &str, asset: JqAsset) -> [String; 2] {
    [
        format!("{}/bin/{}", api_base.trim_end_matches('/'), asset.name),
        format!("{}/{}", JQ_RELEASE_BASE, asset.name),
    ]
}

fn jq_asset_for_current_target() -> Option<JqAsset> {
    let abi = if cfg!(target_abi = "eabihf") {
        "eabihf"
    } else {
        ""
    };
    jq_asset_for(std::env::consts::ARCH, abi)
}

fn jq_asset_for(arch: &str, abi: &str) -> Option<JqAsset> {
    match (arch, abi) {
        ("x86_64", _) => Some(JqAsset {
            name: "jq-linux-amd64",
            sha256: "020468de7539ce70ef1bceaf7cde2e8c4f2ca6c3afb84642aabc5c97d9fc2a0d",
        }),
        ("aarch64", _) => Some(JqAsset {
            name: "jq-linux-arm64",
            sha256: "6bc62f25981328edd3cfcfe6fe51b073f2d7e7710d7ef7fcdac28d4e384fc3d4",
        }),
        ("x86", _) => Some(JqAsset {
            name: "jq-linux-i386",
            sha256: "ee8489cb8acfddf2e6d2ab4308877b5cbb6ec6b55beedb7c6d5a4fafb2879c86",
        }),
        ("arm", "eabihf") => Some(JqAsset {
            name: "jq-linux-armhf",
            sha256: "ac304e50cf7cd24933d83dc7d0e4f79892a71a92fb02336d4ecaffa8933760bd",
        }),
        ("arm", _) => Some(JqAsset {
            name: "jq-linux-armel",
            sha256: "b98e283ff26cd7478f6fb18cc081ca0e0cb2e9980300f0bfc8bb26854d347eb2",
        }),
        _ => None,
    }
}

fn write_private_executable(path: &Path, contents: &[u8], label: &str) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("create {}", label))?;
    file.write_all(contents)
        .with_context(|| format!("write {}", label))?;
    drop(file);
    set_private_executable_permissions(path)
}

#[cfg(unix)]
fn task_command_exists(system_path: &str, name: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;

    system_path.split(':').any(|directory| {
        let Ok(metadata) = fs::metadata(Path::new(directory).join(name)) else {
            return false;
        };
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    })
}

#[cfg(not(unix))]
fn task_command_exists(_system_path: &str, _name: &str) -> bool {
    false
}

struct TaskDirectoryCleanup(PathBuf);

impl Drop for TaskDirectoryCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(unix)]
fn set_private_executable_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(not(unix))]
fn set_private_executable_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn secure_task_directory(cfg: &Config) -> Result<PathBuf> {
    use std::os::unix::fs::MetadataExt;

    let uid = fs::metadata("/proc/self")
        .context("inspect fixed task process identity")?
        .uid();
    let path = task_runtime_directory(&cfg.queue_file, uid);
    prepare_secure_task_directory(&path, uid)?;
    Ok(path)
}

#[cfg(any(target_os = "linux", all(test, unix)))]
fn prepare_secure_task_directory(path: &Path, uid: u32) -> Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    fs::create_dir_all(&path).context("create fixed task runtime directory")?;
    let metadata = fs::symlink_metadata(&path).context("inspect fixed task runtime directory")?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != uid
        || metadata.mode() & 0o022 != 0
    {
        return Err(anyhow!(
            "fixed task runtime directory is not owned by the Agent process and private"
        ));
    }
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn secure_task_directory(_cfg: &Config) -> Result<PathBuf> {
    Err(anyhow!("fixed Beta tasks currently require Linux"))
}

#[cfg(any(target_os = "linux", test))]
fn task_runtime_directory(queue_file: &Path, uid: u32) -> PathBuf {
    if uid == 0 {
        return PathBuf::from("/var/lib/nstatus-manager/tasks");
    }
    queue_file
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("/var/lib/nstatus-metrics"))
        .join("tasks")
}

fn read_capped<R: Read>(mut reader: R, limit: usize) -> Vec<u8> {
    let mut kept = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0u8; 8192];
    while let Ok(count) = reader.read(&mut buffer) {
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(kept.len());
        kept.extend_from_slice(&buffer[..count.min(remaining)]);
    }
    kept
}

fn extract_report_url(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .filter_map(|part| part.find("https://").map(|index| &part[index..]))
        .map(|part| part.trim_matches(|ch: char| "[]()<>\"'，。；;：:".contains(ch)))
        .find(|part| {
            part.starts_with("https://")
                && (part.to_ascii_lowercase().contains("nodequality")
                    || part.to_ascii_lowercase().contains("report"))
        })
        .map(|value| value.chars().take(2000).collect())
}

pub(crate) fn parse_unlock_services(output: &str) -> Vec<Value> {
    let clean = strip_ansi_codes(output);
    let lines: Vec<String> = clean
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    let start = lines
        .iter()
        .rposition(|line| line.contains("服务商") && line.contains("TikTok"))
        .or_else(|| {
            lines
                .iter()
                .rposition(|line| line.contains("流媒体") && line.contains("解锁"))
        })
        .unwrap_or(0);
    let section = &lines[start..lines.len().min(start + 14)];
    let providers = section
        .iter()
        .find(|line| line.contains("服务商"))
        .map(|line| unlock_row_values(line))
        .unwrap_or_default();
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
                None
            } else {
                Some(json!({ "id": id, "name": name, "status": status, "region": region, "method": method }))
            }
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

fn unlock_section(output: &str) -> String {
    let lines: Vec<&str> = output.lines().collect();
    let start = lines
        .iter()
        .rposition(|line| line.contains("服务商") && line.contains("TikTok"))
        .unwrap_or(0);
    lines[start..lines.len().min(start + 14)].join("\n")
}

pub(crate) fn strip_ansi_codes(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for code in chars.by_ref() {
                if ('@'..='~').contains(&code) {
                    break;
                }
            }
        } else if ch != '\r' {
            out.push(ch);
        }
    }
    out
}

fn output_excerpt(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    chars[chars.len().saturating_sub(MAX_EXCERPT_CHARS)..]
        .iter()
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_task_polling_uses_the_cost_aware_interval() {
        assert_eq!(TASK_POLL_SEC, 300);
    }

    #[test]
    fn extracts_nodequality_report_url() {
        assert_eq!(
            extract_report_url("完成：https://nodequality.com/r/abc123。"),
            Some("https://nodequality.com/r/abc123".to_string())
        );
    }

    #[test]
    fn parses_only_unlock_grid() {
        let output = "纯净度： 99\n服务商： TikTok Disney+ Netflix Youtube AmazonPV Reddit ChatGPT\n状态： 解锁 失败 解锁 解锁 解锁 解锁 解锁\n地区： [US] [] [US] [US] [US] [US] [US]\n方式： 原生 DNS 原生 原生 原生 原生 原生";
        let services = parse_unlock_services(output);
        assert_eq!(services.len(), 7);
        assert_eq!(services[0]["name"], "TikTok");
        assert_eq!(services[0]["status"], "解锁");
        assert!(services
            .iter()
            .all(|service| service.get("purity").is_none()));
    }

    #[test]
    fn usable_unlock_rows_are_kept_even_when_optional_checks_fail() {
        let output = "服务商： TikTok Disney+ Netflix Youtube AmazonPV Reddit ChatGPT\n状态： 解锁 失败 解锁 解锁 解锁 解锁 解锁\n地区： [US] [] [US] [US] [US] [US] [US]\n方式： 原生 DNS 原生 原生 原生 原生 原生\nbash: dig: command not found";
        let result = parse_ip_unlock_task_output(output).unwrap();
        assert_eq!(result.result["services"].as_array().unwrap().len(), 7);
        assert!(result.excerpt.contains("服务商"));
    }

    #[test]
    fn parses_structured_ip_check_media_only() {
        let output = r#"progress\n{"Score":{"IP2Location":99},"Media":{"TikTok":{"Status":"Yes","Region":"US","Type":"Native"},"Netflix":{"Status":"No","Region":"null","Type":"null"}}}"#;
        let services = parse_unlock_json(output).unwrap();
        assert_eq!(services.len(), 2);
        assert_eq!(services[0]["name"], "TikTok");
        assert_eq!(services[0]["region"], "US");
        assert!(services
            .iter()
            .all(|service| service.get("purity").is_none()));
    }

    #[test]
    fn parses_structured_media_from_mixed_output() {
        let output = r#"ad {not-json}\nprogress\n{"Media":{"TikTok":{"Status":"Yes","Region":"JP","Type":"Native"}}}\nbash: dig: command not found"#;
        let services = parse_unlock_json(output).unwrap();
        assert_eq!(services.len(), 1);
        assert_eq!(services[0]["region"], "JP");
    }

    #[test]
    fn ip_unlock_never_installs_dependencies_or_uploads_a_report() {
        assert_eq!(IP_UNLOCK_ARGS, ["-4", "-j", "-n", "-p"]);
        assert!(!IP_UNLOCK_ARGS.contains(&"-y"));
        assert!(IP_UNLOCK_ARGS.contains(&"-j"));
    }

    #[test]
    fn compatibility_tasks_use_the_unprivileged_agent_state_directory() {
        let queue = Path::new("/var/lib/nstatus-metrics/samples-queue.json");
        assert_eq!(
            task_runtime_directory(queue, 1000),
            PathBuf::from("/var/lib/nstatus-metrics/tasks")
        );
        assert_eq!(
            task_runtime_directory(queue, 0),
            PathBuf::from("/var/lib/nstatus-manager/tasks")
        );
    }

    #[cfg(unix)]
    #[test]
    fn compatibility_task_directory_is_private_and_rejects_symlinks() {
        use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

        let base = std::env::temp_dir().join(format!(
            "nie-sla-task-sandbox-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&base).unwrap();
        let uid = fs::metadata(&base).unwrap().uid();
        let tasks = base.join("tasks");
        prepare_secure_task_directory(&tasks, uid).unwrap();
        assert_eq!(
            fs::metadata(&tasks).unwrap().permissions().mode() & 0o777,
            0o700
        );

        fs::remove_dir(&tasks).unwrap();
        symlink(base.parent().unwrap(), &tasks).unwrap();
        assert!(prepare_secure_task_directory(&tasks, uid).is_err());
        fs::remove_file(&tasks).unwrap();
        fs::remove_dir(&base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn ip_unlock_uses_ephemeral_dns_helpers() {
        use std::os::unix::fs::PermissionsExt;

        let base = std::env::temp_dir().join(format!(
            "nie-sla-task-path-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&base).unwrap();
        let bin = base.join("bin");
        fs::create_dir(&bin).unwrap();
        let dig = bin.join("dig");
        write_private_executable(&dig, OPTIONAL_DIG_HELPER, "test dig helper").unwrap();
        assert_eq!(
            fs::metadata(&dig).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let output = Command::new(&dig)
            .env("NSTATUS_DNS_COMPAT_EXECUTABLE", "/bin/echo")
            .arg("example.com")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            "--dns-compat dig example.com"
        );
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn pinned_jq_assets_cover_every_linux_release_architecture() {
        assert_eq!(jq_asset_for("x86_64", "").unwrap().name, "jq-linux-amd64");
        assert_eq!(jq_asset_for("aarch64", "").unwrap().name, "jq-linux-arm64");
        assert_eq!(jq_asset_for("x86", "").unwrap().name, "jq-linux-i386");
        assert_eq!(
            jq_asset_for("arm", "eabihf").unwrap().name,
            "jq-linux-armhf"
        );
        assert_eq!(jq_asset_for("arm", "eabi").unwrap().name, "jq-linux-armel");
        assert!(jq_asset_for("m68k", "").is_none());
    }

    #[test]
    fn pinned_jq_prefers_the_configured_worker_asset() {
        let asset = jq_asset_for("x86_64", "").unwrap();
        let urls = jq_download_urls("https://status.example.com/", asset);
        assert_eq!(urls[0], "https://status.example.com/bin/jq-linux-amd64");
        assert_eq!(
            urls[1],
            "https://github.com/jqlang/jq/releases/download/jq-1.8.1/jq-linux-amd64"
        );
    }
}
