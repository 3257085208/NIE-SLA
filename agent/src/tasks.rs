use crate::{percent_encode_query, Config, HttpClient, AGENT_VERSION};
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, OnceLock,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

pub(crate) const TASK_POLL_SEC: u64 = 300;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_EXCERPT_CHARS: usize = 16 * 1024;
const MAX_NODEQUALITY_ARTIFACT_BYTES: usize = 24 * 1024;
const MAX_NODEQUALITY_CAPTURE_CHARS: usize = 180 * 1024;
const IP_UNLOCK_TIMEOUT_SEC: u64 = 600;
const NODEQUALITY_CAPTURE_BEGIN: &str = "__NSTATUS_NQ_ARTIFACTS_V1_BEGIN__";
const NODEQUALITY_CAPTURE_END: &str = "__NSTATUS_NQ_ARTIFACTS_V1_END__";

pub(crate) fn runner_instance_id() -> &'static str {
    static RUNNER_INSTANCE_ID: OnceLock<String> = OnceLock::new();
    RUNNER_INSTANCE_ID.get_or_init(|| {
        let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "unknown-boot".to_string());
        let pid = std::process::id();
        let start_nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!("{}-{}-{}", boot_id, pid, start_nanos)
    })
}
const IP_UNLOCK_ARGS: [&str; 3] = ["-4", "-n", "-p"];
const MAX_IP_UNLOCK_REPORT_CHARS: usize = 64 * 1024;
const SYSTEM_TASK_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const OPTIONAL_DIG_HELPER: &[u8] =
    b"#!/bin/sh\nexec \"$NSTATUS_DNS_COMPAT_EXECUTABLE\" --dns-compat dig \"$@\"\n";
const OPTIONAL_NSLOOKUP_HELPER: &[u8] =
    b"#!/bin/sh\nexec \"$NSTATUS_DNS_COMPAT_EXECUTABLE\" --dns-compat nslookup \"$@\"\n";
const JQ_RELEASE_BASE: &str = "https://github.com/jqlang/jq/releases/download/jq-1.8.1";
const MAX_JQ_BYTES: usize = 4 * 1024 * 1024;
const NODEQUALITY_SCRIPT_SHA256: &str =
    "ecdfcc0ef06b9fae4a669d36687bca84f6da5b59d2f1380b289f1ed2c462bd9e";
const IP_UNLOCK_SCRIPT_SHA256: &str =
    "69e7a8d0b9018a508fa7a54a3f7e98c9fa8c19eeb6995d60675070361cb76c03";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct JqAsset {
    name: &'static str,
    sha256: &'static str,
}

pub(crate) fn poll_once_manager(cfg: &Config, http: &HttpClient) -> Result<()> {
    poll_once(cfg, http)
}

fn poll_once(cfg: &Config, http: &HttpClient) -> Result<()> {
    let url = format!(
        "{}/api/agent/tasks?agent_id={}&runner_instance_id={}",
        cfg.api.trim_end_matches('/'),
        percent_encode_query(&cfg.agent_id),
        percent_encode_query(runner_instance_id())
    );
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
    let timeout_sec = task.get("timeout_sec").and_then(Value::as_u64);
    let options = task.get("options").cloned();

    let cancellation = TaskCancellation::new(cfg, http, task_id);
    let outcome = execute_fixed_task(
        cfg,
        http,
        action,
        timeout_sec,
        options.as_ref(),
        Some(&cancellation),
    );
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

struct TaskOutput {
    result: Value,
    excerpt: String,
}

struct TaskCancellation {
    api: String,
    token: String,
    agent_id: String,
    task_id: String,
    http: HttpClient,
}

impl TaskCancellation {
    fn new(cfg: &Config, http: &HttpClient, task_id: &str) -> Self {
        Self {
            api: cfg.api.trim_end_matches('/').to_string(),
            token: cfg.token.clone(),
            agent_id: cfg.agent_id.clone(),
            task_id: task_id.to_string(),
            http: http.clone(),
        }
    }

    fn is_cancelled(&self) -> bool {
        let url = format!(
            "{}/api/agent/tasks/{}/cancel-status?agent_id={}",
            self.api,
            percent_encode_query(&self.task_id),
            percent_encode_query(&self.agent_id),
        );
        let Ok(body) = self.http.get(&url, &self.token) else {
            return false;
        };
        match serde_json::from_str::<Value>(&body) {
            Ok(value) => value.get("cancelled").and_then(Value::as_bool) == Some(true),
            Err(_) => false,
        }
    }
}

#[derive(Default)]
struct NodeQualityArtifacts {
    header: String,
    hardware: String,
    ip: String,
    network: String,
    route: String,
}

fn execute_fixed_task(
    cfg: &Config,
    http: &HttpClient,
    action: &str,
    timeout_sec: Option<u64>,
    options: Option<&Value>,
    cancellation: Option<&TaskCancellation>,
) -> Result<TaskOutput> {
    if !cfg!(target_os = "linux") {
        return Err(anyhow!("Beta task actions currently require Linux"));
    }
    match action {
        "nodequality" => run_nodequality(cfg, http, options, cancellation),
        "ip_unlock" => run_ip_unlock(cfg, http, timeout_sec, cancellation),
        _ => Err(anyhow!("unsupported fixed task action")),
    }
}

fn run_nodequality(
    cfg: &Config,
    http: &HttpClient,
    options: Option<&Value>,
    cancellation: Option<&TaskCancellation>,
) -> Result<TaskOutput> {
    let stdin = nodequality_stdin(options);
    let accelerator = nodequality_accelerator(options);
    let output = run_fixed_remote_script(
        cfg,
        http,
        None,
        "https://run.NodeQuality.com",
        &[],
        Some(&stdin),
        &[("NQ_ACCELERATOR", accelerator.as_str())],
        cancellation,
    )?;
    nodequality_task_output(&output)
}

fn nodequality_stdin(options: Option<&Value>) -> Vec<u8> {
    let option = |key: &str, allowed: &[&str], fallback: &str| -> String {
        let value = options
            .and_then(|value| value.get(key))
            .and_then(Value::as_str)
            .map(|text| text.trim().to_ascii_lowercase())
            .unwrap_or_else(|| fallback.to_string());
        if allowed.iter().any(|candidate| *candidate == value) {
            value
        } else {
            fallback.to_string()
        }
    };
    format!(
        "{}\n{}\n{}\n{}\n",
        option("hardware", &["y", "f", "v", "n"], "f"),
        option("ip", &["y", "n"], "y"),
        option("net", &["y", "l", "n"], "y"),
        option("route", &["y", "n"], "y"),
    )
    .into_bytes()
}

fn nodequality_accelerator(options: Option<&Value>) -> String {
    let value = options
        .and_then(|value| value.get("accelerator"))
        .and_then(Value::as_str)
        .map(|text| text.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "auto".to_string());
    match value.as_str() {
        "cf" => value,
        _ => "auto".to_string(),
    }
}

fn nodequality_task_output(output: &FixedScriptOutput) -> Result<TaskOutput> {
    let clean = strip_ansi_codes(&output.text);
    if let Some(report_url) = extract_report_url(&clean) {
        let report = nodequality_report(&report_url, output.nodequality.as_ref());
        return Ok(TaskOutput {
            result: json!({ "report_url": report_url, "report": report }),
            excerpt: format!("NodeQuality 测试完成：{}", report_url),
        });
    }
    ensure_script_success(output)?;
    Err(anyhow!("NodeQuality completed without a report URL"))
}

fn run_ip_unlock(
    cfg: &Config,
    http: &HttpClient,
    timeout_sec: Option<u64>,
    cancellation: Option<&TaskCancellation>,
) -> Result<TaskOutput> {
    let output = run_fixed_remote_script(
        cfg,
        http,
        Some(
            timeout_sec
                .unwrap_or(IP_UNLOCK_TIMEOUT_SEC)
                .min(IP_UNLOCK_TIMEOUT_SEC),
        ),
        "https://IP.Check.Place",
        &IP_UNLOCK_ARGS,
        None,
        &[],
        cancellation,
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
        result: json!({ "services": services, "report": ip_unlock_report_text(output) }),
        excerpt: output_excerpt(&unlock_section(&clean)),
    })
}

struct FixedScriptOutput {
    text: String,
    status: std::process::ExitStatus,
    nodequality: Option<NodeQualityArtifacts>,
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

#[allow(clippy::too_many_arguments)]
fn run_fixed_remote_script(
    cfg: &Config,
    http: &HttpClient,
    timeout_sec: Option<u64>,
    url: &str,
    args: &[&str],
    stdin: Option<&[u8]>,
    envs: &[(&str, &str)],
    cancellation: Option<&TaskCancellation>,
) -> Result<FixedScriptOutput> {
    if !matches!(
        url,
        "https://run.NodeQuality.com" | "https://IP.Check.Place"
    ) {
        return Err(anyhow!("unsupported fixed task source"));
    }
    // These pinned diagnostics need raw sockets and system tools, so only the root manager may run them.
    ensure_privileged_fixed_task_context()?;
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
    let mirrored_url = fixed_script_asset_url(&cfg.api, url)?;
    let mut script = http.get_public_bytes_limited(&mirrored_url, 2 * 1024 * 1024)?;
    if script.is_empty() {
        return Err(anyhow!("fixed Beta task download is empty"));
    }
    let expected_script_sha256 = fixed_script_sha256(url)?;
    let actual_script_sha256 = sha256_hex(&script);
    if actual_script_sha256 != expected_script_sha256 {
        return Err(anyhow!(
            "fixed task source changed; refusing unreviewed script {}",
            url
        ));
    }
    let nodequality_result_dir = if url == "https://run.NodeQuality.com" {
        let path = task_dir.join("nodequality-result");
        fs::create_dir(&path).context("create NodeQuality result directory")?;
        set_private_directory_permissions(&path)?;
        script = inject_nodequality_capture(&script)?;
        Some(path)
    } else {
        None
    };
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
    reject_task_symlinks(&task_dir)?;

    let mut command = fixed_task_command(timeout_sec);
    command
        .arg(&script_path)
        .args(args)
        .current_dir(&task_dir)
        .env_clear()
        .env("PATH", task_path)
        .env("HOME", &task_dir)
        .env("LANG", "C.UTF-8")
        .env("NSTATUS_DNS_COMPAT_EXECUTABLE", agent_executable)
        .envs(envs.iter().copied())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = &nodequality_result_dir {
        command.env("NSTATUS_NQ_RESULTS_DIR", path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().context("failed to start fixed Beta task")?;
    if let (Some(input), Some(mut handle)) = (stdin, child.stdin.take()) {
        handle
            .write_all(input)
            .context("failed to send fixed task input")?;
    }
    let stdout = child.stdout.take().context("capture fixed task stdout")?;
    let stderr = child.stderr.take().context("capture fixed task stderr")?;
    let (status, bytes) =
        collect_task_output(&mut child, stdout, stderr, timeout_sec, cancellation)?;
    let text = String::from_utf8_lossy(&bytes).to_string();
    let disk_artifacts = nodequality_result_dir
        .as_deref()
        .map(read_nodequality_artifacts)
        .transpose()?;
    let nodequality = merge_nodequality_artifacts(
        parse_nodequality_artifacts_from_output(&text),
        disk_artifacts,
    );
    Ok(FixedScriptOutput {
        text,
        status,
        nodequality,
    })
}

fn fixed_script_sha256(url: &str) -> Result<&'static str> {
    match url {
        "https://run.NodeQuality.com" => Ok(NODEQUALITY_SCRIPT_SHA256),
        "https://IP.Check.Place" => Ok(IP_UNLOCK_SCRIPT_SHA256),
        _ => Err(anyhow!("unsupported fixed task source")),
    }
}

fn fixed_script_asset_url(api_base: &str, url: &str) -> Result<String> {
    let asset = match url {
        "https://run.NodeQuality.com" => "nodequality.sh",
        "https://IP.Check.Place" => "ip-check.sh",
        _ => return Err(anyhow!("unsupported fixed task source")),
    };
    Ok(format!(
        "{}/vendor/tasks/{}",
        api_base.trim_end_matches('/'),
        asset
    ))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(target_os = "linux")]
fn ensure_privileged_fixed_task_context() -> Result<()> {
    if unsafe { libc::geteuid() } != 0 {
        return Err(anyhow!(
            "NodeQuality and IP unlock tasks require the privileged Agent manager"
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn ensure_privileged_fixed_task_context() -> Result<()> {
    Err(anyhow!("fixed Beta tasks currently require Linux"))
}

fn fixed_task_command(timeout_sec: Option<u64>) -> Command {
    if let Some(secs) = timeout_sec {
        let mut command = Command::new("timeout");
        command
            .args(["-k", "5s"])
            .arg(format!("{}s", secs))
            .arg("bash");
        command
    } else {
        Command::new("bash")
    }
}

fn reject_task_symlinks(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).context("inspect task sandbox path")?;
    if metadata.file_type().is_symlink() {
        return Err(anyhow!("task sandbox must not contain symbolic links"));
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path).context("inspect task sandbox directory")? {
            reject_task_symlinks(&entry?.path())?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn terminate_task_process_group(child: &mut Child) -> Option<ExitStatus> {
    let pid = child.id() as i32;
    if pid <= 1 {
        return None;
    }
    unsafe {
        libc::killpg(pid, libc::SIGTERM);
    }
    for _ in 0..25 {
        if let Some(status) = child.try_wait().ok().flatten() {
            return Some(status);
        }
        thread::sleep(Duration::from_millis(200));
    }
    unsafe {
        libc::killpg(pid, libc::SIGKILL);
    }
    child.wait().ok()
}

#[cfg(unix)]
fn collect_task_output(
    child: &mut Child,
    stdout: ChildStdout,
    stderr: ChildStderr,
    timeout_sec: Option<u64>,
    cancellation: Option<&TaskCancellation>,
) -> Result<(ExitStatus, Vec<u8>)> {
    let stop = Arc::new(AtomicBool::new(false));
    let hard_deadline =
        timeout_sec.map(|sec| Instant::now() + Duration::from_secs(sec.saturating_add(5)));
    let stdout_stop = Arc::clone(&stop);
    let stderr_stop = Arc::clone(&stop);
    let stdout_reader = thread::spawn(move || {
        read_pipe_tail_bounded(stdout, MAX_OUTPUT_BYTES / 2, stdout_stop, hard_deadline)
    });
    let stderr_reader = thread::spawn(move || {
        read_pipe_tail_bounded(stderr, MAX_OUTPUT_BYTES / 2, stderr_stop, hard_deadline)
    });
    let mut last_cancel_check = Instant::now() - Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().context("failed to poll fixed Beta task")? {
            break status;
        }
        let now = Instant::now();
        if hard_deadline.is_some_and(|deadline| now >= deadline) {
            if let Some(status) = terminate_task_process_group(child) {
                break status;
            }
            break child
                .wait()
                .context("failed to wait for timed-out fixed Beta task")?;
        }
        if now.duration_since(last_cancel_check) >= Duration::from_secs(2) {
            last_cancel_check = now;
            if let Some(cancellation) = cancellation {
                if cancellation.is_cancelled() {
                    if let Some(status) = terminate_task_process_group(child) {
                        break status;
                    }
                    break child
                        .wait()
                        .context("failed to wait for cancelled fixed Beta task")?;
                }
            }
        }
        thread::sleep(Duration::from_millis(200));
    };
    stop.store(true, Ordering::Release);
    let mut bytes = stdout_reader.join().unwrap_or_default();
    bytes.push(b'\n');
    bytes.extend(stderr_reader.join().unwrap_or_default());
    Ok((status, bytes))
}

#[cfg(not(unix))]
fn collect_task_output(
    child: &mut Child,
    stdout: ChildStdout,
    stderr: ChildStderr,
    _timeout_sec: Option<u64>,
    _cancellation: Option<&TaskCancellation>,
) -> Result<(ExitStatus, Vec<u8>)> {
    let stdout_reader = thread::spawn(move || read_tail_capped(stdout, MAX_OUTPUT_BYTES / 2));
    let stderr_reader = thread::spawn(move || read_tail_capped(stderr, MAX_OUTPUT_BYTES / 2));
    let status = child.wait().context("failed to wait for fixed Beta task")?;
    let mut bytes = stdout_reader.join().unwrap_or_default();
    bytes.push(b'\n');
    bytes.extend(stderr_reader.join().unwrap_or_default());
    Ok((status, bytes))
}

fn inject_nodequality_capture(script: &[u8]) -> Result<Vec<u8>> {
    let source = String::from_utf8(script.to_vec()).context("NodeQuality script is not UTF-8")?;
    let marker = "    upload_result\n";
    let capture = concat!(
        "    if [[ -n \"${NSTATUS_NQ_RESULTS_DIR:-}\" ]]; then\n",
        "        cp \"$result_directory\"/header_info.log \"$NSTATUS_NQ_RESULTS_DIR\"/ 2>/dev/null || true\n",
        "        cp \"$result_directory\"/hardware_quality.log \"$NSTATUS_NQ_RESULTS_DIR\"/ 2>/dev/null || true\n",
        "        cp \"$result_directory\"/ip_quality.log \"$NSTATUS_NQ_RESULTS_DIR\"/ 2>/dev/null || true\n",
        "        cp \"$result_directory\"/net_quality.log \"$NSTATUS_NQ_RESULTS_DIR\"/ 2>/dev/null || true\n",
        "        cp \"$result_directory\"/backroute_trace.log \"$NSTATUS_NQ_RESULTS_DIR\"/ 2>/dev/null || true\n",
        "        printf '\\n__NSTATUS_NQ_ARTIFACTS_V1_BEGIN__\\n'\n",
        "        printf 'header:'; [[ -f \"$result_directory\"/header_info.log ]] && head -c 24576 \"$result_directory\"/header_info.log | base64 | tr -d '\\r\\n'; printf '\\n'\n",
        "        printf 'hardware:'; [[ -f \"$result_directory\"/hardware_quality.log ]] && head -c 24576 \"$result_directory\"/hardware_quality.log | base64 | tr -d '\\r\\n'; printf '\\n'\n",
        "        printf 'ip:'; [[ -f \"$result_directory\"/ip_quality.log ]] && head -c 24576 \"$result_directory\"/ip_quality.log | base64 | tr -d '\\r\\n'; printf '\\n'\n",
        "        printf 'network:'; [[ -f \"$result_directory\"/net_quality.log ]] && head -c 24576 \"$result_directory\"/net_quality.log | base64 | tr -d '\\r\\n'; printf '\\n'\n",
        "        printf 'route:'; [[ -f \"$result_directory\"/backroute_trace.log ]] && head -c 24576 \"$result_directory\"/backroute_trace.log | base64 | tr -d '\\r\\n'; printf '\\n'\n",
        "        printf '__NSTATUS_NQ_ARTIFACTS_V1_END__\\n'\n",
        "    fi\n",
        "    upload_result\n",
    );
    if !source.contains(marker) {
        return Err(anyhow!(
            "NodeQuality script no longer exposes the expected upload step"
        ));
    }
    Ok(source.replacen(marker, capture, 1).into_bytes())
}

fn merge_nodequality_artifacts(
    primary: Option<NodeQualityArtifacts>,
    fallback: Option<NodeQualityArtifacts>,
) -> Option<NodeQualityArtifacts> {
    match (primary, fallback) {
        (Some(mut primary), Some(fallback)) => {
            for (field, fallback_value) in [
                (&mut primary.header, fallback.header),
                (&mut primary.hardware, fallback.hardware),
                (&mut primary.ip, fallback.ip),
                (&mut primary.network, fallback.network),
                (&mut primary.route, fallback.route),
            ] {
                if field.is_empty() {
                    *field = fallback_value;
                }
            }
            Some(primary)
        }
        (Some(primary), None) => Some(primary),
        (None, fallback) => fallback,
    }
}

fn parse_nodequality_artifacts_from_output(output: &str) -> Option<NodeQualityArtifacts> {
    let begin = output.rfind(NODEQUALITY_CAPTURE_BEGIN)? + NODEQUALITY_CAPTURE_BEGIN.len();
    let remaining = output.get(begin..)?;
    let end = remaining.find(NODEQUALITY_CAPTURE_END)?;
    let block = remaining.get(..end)?;
    if block.len() > MAX_NODEQUALITY_CAPTURE_CHARS {
        return None;
    }
    Some(NodeQualityArtifacts {
        header: decode_nodequality_capture_field(block, "header"),
        hardware: decode_nodequality_capture_field(block, "hardware"),
        ip: decode_nodequality_capture_field(block, "ip"),
        network: decode_nodequality_capture_field(block, "network"),
        route: decode_nodequality_capture_field(block, "route"),
    })
}

fn decode_nodequality_capture_field(block: &str, name: &str) -> String {
    let prefix = format!("{name}:");
    let max_encoded_len = MAX_NODEQUALITY_ARTIFACT_BYTES.div_ceil(3) * 4;
    let Some(encoded) = block
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .filter(|value| value.len() <= max_encoded_len)
    else {
        return String::new();
    };
    let Ok(decoded) = BASE64_STANDARD.decode(encoded) else {
        return String::new();
    };
    if decoded.len() > MAX_NODEQUALITY_ARTIFACT_BYTES {
        return String::new();
    }
    String::from_utf8_lossy(&decoded).trim().to_string()
}

fn read_nodequality_artifacts(path: &Path) -> Result<NodeQualityArtifacts> {
    Ok(NodeQualityArtifacts {
        header: read_text_file_capped(&path.join("header_info.log"))?,
        hardware: read_text_file_capped(&path.join("hardware_quality.log"))?,
        ip: read_text_file_capped(&path.join("ip_quality.log"))?,
        network: read_text_file_capped(&path.join("net_quality.log"))?,
        route: read_text_file_capped(&path.join("backroute_trace.log"))?,
    })
}

fn read_text_file_capped(path: &Path) -> Result<String> {
    if !path.exists() {
        return Ok(String::new());
    }
    let file = fs::File::open(path)
        .with_context(|| format!("open NodeQuality artifact {}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(MAX_NODEQUALITY_ARTIFACT_BYTES as u64)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read NodeQuality artifact {}", path.display()))?;
    Ok(String::from_utf8_lossy(&bytes).trim().to_string())
}

fn nodequality_report(report_url: &str, artifacts: Option<&NodeQualityArtifacts>) -> Value {
    let Some(artifacts) = artifacts else {
        return Value::Null;
    };
    let basic = [artifacts.header.trim(), artifacts.hardware.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut tabs = Vec::new();
    for (id, title, content) in [
        ("basic", "基本信息", basic.as_str()),
        ("ip", "IP质量", artifacts.ip.as_str()),
        ("network", "网络质量", artifacts.network.as_str()),
        ("route", "回程路由", artifacts.route.as_str()),
    ] {
        if !content.trim().is_empty() {
            tabs.push(json!({ "id": id, "title": title, "kind": "ansi", "content": content }));
        }
    }
    if tabs.is_empty() {
        Value::Null
    } else {
        json!({ "version": 1, "source": "agent", "link": report_url, "tabs": tabs })
    }
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

    fs::create_dir_all(path).context("create fixed task runtime directory")?;
    let metadata = fs::symlink_metadata(path).context("inspect fixed task runtime directory")?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != uid
        || metadata.mode() & 0o022 != 0
    {
        return Err(anyhow!(
            "fixed task runtime directory is not owned by the Agent process and private"
        ));
    }
    // Child sandboxes remain 0700; the root-owned parent only permits traversal.
    fs::set_permissions(path, fs::Permissions::from_mode(0o711))?;
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

#[cfg(any(test, not(unix)))]
fn read_tail_capped<R: Read>(mut reader: R, limit: usize) -> Vec<u8> {
    let mut kept = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0u8; 8192];
    while let Ok(count) = reader.read(&mut buffer) {
        if count == 0 {
            break;
        }
        if count >= limit {
            kept.clear();
            kept.extend_from_slice(&buffer[count - limit..count]);
            continue;
        }
        let overflow = kept.len().saturating_add(count).saturating_sub(limit);
        if overflow > 0 {
            kept.drain(..overflow);
        }
        kept.extend_from_slice(&buffer[..count]);
    }
    kept
}

#[cfg(unix)]
fn read_pipe_tail_bounded<R>(
    mut reader: R,
    limit: usize,
    stop: Arc<AtomicBool>,
    hard_deadline: Option<Instant>,
) -> Vec<u8>
where
    R: Read + std::os::fd::AsRawFd,
{
    use std::io::ErrorKind;
    let fd = reader.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Vec::new();
    }

    let mut kept = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0u8; 8192];
    let mut stop_deadline = None;
    loop {
        let now = Instant::now();
        if stop.load(Ordering::Acquire) && stop_deadline.is_none() {
            stop_deadline = Some(now + Duration::from_millis(100));
        }
        if hard_deadline.is_some_and(|deadline| now >= deadline)
            || stop_deadline.is_some_and(|deadline| now >= deadline)
        {
            break;
        }
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => append_tail(&mut kept, &buffer[..count], limit),
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                let mut poll_fd = libc::pollfd {
                    fd,
                    events: libc::POLLIN | libc::POLLHUP,
                    revents: 0,
                };
                unsafe {
                    libc::poll(&mut poll_fd, 1, 25);
                }
            }
            Err(_) => break,
        }
    }
    kept
}

fn append_tail(kept: &mut Vec<u8>, bytes: &[u8], limit: usize) {
    if bytes.len() >= limit {
        kept.clear();
        kept.extend_from_slice(&bytes[bytes.len() - limit..]);
        return;
    }
    let overflow = kept.len().saturating_add(bytes.len()).saturating_sub(limit);
    if overflow > 0 {
        kept.drain(..overflow);
    }
    kept.extend_from_slice(bytes);
}

fn extract_report_url(output: &str) -> Option<String> {
    let direct = output
        .split_whitespace()
        .filter_map(|part| part.find("https://").map(|index| &part[index..]))
        .map(|part| part.trim_matches(|ch: char| "[](){}<>\"',，。；;：:".contains(ch)))
        .filter_map(normalize_nodequality_report_url)
        .next_back();
    direct.or_else(|| {
        extract_nodequality_token(output).map(|token| format!("https://nodequality.com/r/{token}"))
    })
}

fn normalize_nodequality_report_url(value: &str) -> Option<String> {
    let raw = value.split(['?', '#']).next()?.trim_end_matches('/');
    let lower = raw.to_ascii_lowercase();
    let prefix_len = if lower.starts_with("https://nodequality.com/r/") {
        "https://nodequality.com/r/".len()
    } else if lower.starts_with("https://www.nodequality.com/r/") {
        "https://www.nodequality.com/r/".len()
    } else {
        return None;
    };
    let path = &raw[prefix_len..];
    valid_nodequality_token(path).then(|| format!("https://nodequality.com/r/{path}"))
}

fn extract_nodequality_token(output: &str) -> Option<String> {
    output
        .match_indices('{')
        .filter_map(|(start, _)| {
            serde_json::Deserializer::from_str(&output[start..])
                .into_iter::<Value>()
                .next()?
                .ok()
        })
        .filter(|value| value.get("success").and_then(Value::as_bool) != Some(false))
        .filter_map(|value| {
            value
                .pointer("/data/token")
                .or_else(|| value.get("token"))
                .and_then(Value::as_str)
                .filter(|token| valid_nodequality_token(token))
                .map(str::to_string)
        })
        .next_back()
}

fn valid_nodequality_token(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
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
    let mut line_start = 0usize;
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for code in chars.by_ref() {
                if ('@'..='~').contains(&code) {
                    break;
                }
            }
        } else if ch == '\r' {
            if chars.peek() != Some(&'\n') {
                out.truncate(line_start);
            }
        } else {
            out.push(ch);
            if ch == '\n' {
                line_start = out.len();
            }
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

fn ip_unlock_report_text(value: &str) -> String {
    let lines: Vec<&str> = value.lines().collect();
    let mut end = lines.len();
    let mut footer = None;
    for (index, raw_line) in lines.iter().enumerate() {
        let plain = strip_ansi_codes(raw_line);
        let line = plain.trim();
        if line.contains("今日IP检测量")
            || line.contains("总检测量")
            || line.contains("感谢使用xy系列脚本")
            || line.contains("报告链接")
            || line.contains("Report Link")
        {
            footer = Some(index);
        }
    }
    if let Some(index) = footer {
        end = index + 1;
    } else {
        for (index, raw_line) in lines.iter().enumerate() {
            let plain = strip_ansi_codes(raw_line);
            let line = plain.trim();
            if line.starts_with("TERM environment variable not set.") || is_report_ad_banner(line) {
                end = index;
                break;
            }
        }
    }
    lines[..end]
        .join("\n")
        .trim_end()
        .chars()
        .take(MAX_IP_UNLOCK_REPORT_CHARS)
        .collect()
}

fn is_report_ad_banner(line: &str) -> bool {
    let trimmed = line.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    chars.len() >= 6
        && chars
            .iter()
            .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || *ch == '.')
        && chars.iter().any(|ch| ch.is_ascii_uppercase())
        && !trimmed.contains('：')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_task_polling_uses_the_cost_aware_interval() {
        assert_eq!(TASK_POLL_SEC, 300);
    }

    #[test]
    fn runner_instance_id_is_stable_and_safe_for_query_strings() {
        let first = runner_instance_id();
        let second = runner_instance_id();
        assert_eq!(first, second);
        assert!(!first.is_empty());
        assert!(first
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '.' | '_' | '~')));
    }

    #[test]
    fn extracts_nodequality_report_url() {
        assert_eq!(
            extract_report_url("完成：https://nodequality.com/r/abc12345。"),
            Some("https://nodequality.com/r/abc12345".to_string())
        );
    }

    #[test]
    fn ignores_script_entrypoint_and_builds_report_url_from_upload_token() {
        let output = concat!(
            "脚本入口：https://run.NodeQuality.com\n",
            "{\"success\":true,\"data\":{\"token\":\"VLDpQuy3AFgJ8e3f4QA8BerZwBEwEldB\"}}\n",
        );
        assert_eq!(
            extract_report_url(output),
            Some("https://nodequality.com/r/VLDpQuy3AFgJ8e3f4QA8BerZwBEwEldB".to_string())
        );
        assert_eq!(extract_report_url("https://run.nodequality.com/"), None);
        assert_eq!(
            extract_report_url("https://api.nodequality.com/api/v1/record"),
            None
        );
        assert_eq!(extract_report_url("https://nodequality.com/"), None);
        assert_eq!(
            extract_report_url(concat!(
                "脚本入口：https://run.NodeQuality.com\n",
                "测试完成，点击查看你的结果链接： ",
                "https://nodequality.com/r/VLDpQuy3AFgJ8e3f4QA8BerZwBEwEldB\n",
            )),
            Some("https://nodequality.com/r/VLDpQuy3AFgJ8e3f4QA8BerZwBEwEldB".to_string())
        );
    }

    #[test]
    fn injects_capture_before_the_official_upload_step() {
        let script = b"main(){\n    upload_result\n    post_cleanup\n}\n";
        let patched = String::from_utf8(inject_nodequality_capture(script).unwrap()).unwrap();
        assert!(patched.contains("fi\n    upload_result\n"));
        assert!(patched.contains("backroute_trace.log"));
        assert!(patched.contains(NODEQUALITY_CAPTURE_BEGIN));
        assert!(patched.contains(NODEQUALITY_CAPTURE_END));
        assert!(patched.find("header_info.log").unwrap() < patched.find("upload_result").unwrap());
        assert!(patched.find("upload_result").unwrap() < patched.find("post_cleanup").unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn injected_capture_survives_the_upstream_cleanup_boundary() {
        let base = std::env::temp_dir().join(format!(
            "nie-sla-nq-capture-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let results = base.join("results");
        let captured = base.join("captured");
        fs::create_dir_all(&results).unwrap();
        fs::create_dir_all(&captured).unwrap();
        for (name, content) in [
            ("header_info.log", "header"),
            ("hardware_quality.log", "hardware"),
            ("ip_quality.log", "ip"),
            ("net_quality.log", "\u{1b}[32m网络成功\u{1b}[0m"),
            ("backroute_trace.log", "route"),
        ] {
            fs::write(results.join(name), content).unwrap();
        }
        let script = b"upload_result(){ printf 'https://nodequality.com/r/testtoken\\n'; }\nmain(){\n    result_directory=\"$1\"\n    upload_result\n}\nmain \"$@\"\n";
        let patched = String::from_utf8(inject_nodequality_capture(script).unwrap()).unwrap();
        let output = Command::new("bash")
            .args(["-c", &patched, "--"])
            .arg(&results)
            .env("NSTATUS_NQ_RESULTS_DIR", &captured)
            .output()
            .unwrap();
        assert!(output.status.success());
        let text = String::from_utf8(output.stdout).unwrap();
        let artifacts = parse_nodequality_artifacts_from_output(&text).unwrap();
        assert_eq!(artifacts.header, "header");
        assert_eq!(artifacts.hardware, "hardware");
        assert_eq!(artifacts.ip, "ip");
        assert_eq!(artifacts.network, "\u{1b}[32m网络成功\u{1b}[0m");
        assert_eq!(artifacts.route, "route");
        assert!(text.find(NODEQUALITY_CAPTURE_END).unwrap() < text.find("https://").unwrap());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn streamed_nodequality_capture_is_bounded_and_fills_from_disk() {
        let malformed =
            format!("{NODEQUALITY_CAPTURE_BEGIN}\nnetwork:not-base64!\n{NODEQUALITY_CAPTURE_END}");
        assert!(parse_nodequality_artifacts_from_output(&malformed)
            .unwrap()
            .network
            .is_empty());
        let oversized = format!(
            "{NODEQUALITY_CAPTURE_BEGIN}{}{NODEQUALITY_CAPTURE_END}",
            "x".repeat(MAX_NODEQUALITY_CAPTURE_CHARS + 1)
        );
        assert!(parse_nodequality_artifacts_from_output(&oversized).is_none());

        let merged = merge_nodequality_artifacts(
            Some(NodeQualityArtifacts {
                network: "streamed network".into(),
                ..NodeQualityArtifacts::default()
            }),
            Some(NodeQualityArtifacts {
                header: "disk header".into(),
                route: "disk route".into(),
                ..NodeQualityArtifacts::default()
            }),
        )
        .unwrap();
        assert_eq!(merged.header, "disk header");
        assert_eq!(merged.network, "streamed network");
        assert_eq!(merged.route, "disk route");
    }

    #[test]
    fn nodequality_defaults_to_fast_hardware_mode() {
        assert_eq!(nodequality_stdin(None), b"f\ny\ny\ny\n");
        assert_eq!(nodequality_accelerator(None), "auto");
    }

    #[test]
    fn nodequality_options_map_to_stdin_with_allowlist() {
        let options = json!({"hardware": "v", "ip": "n", "net": "l", "route": "n"});
        assert_eq!(nodequality_stdin(Some(&options)), b"v\nn\nl\nn\n");
        assert_eq!(nodequality_accelerator(Some(&options)), "auto");
        let invalid = json!({"hardware": "x", "ip": "maybe", "net": "z", "route": ""});
        assert_eq!(nodequality_stdin(Some(&invalid)), b"f\ny\ny\ny\n");
        assert_eq!(nodequality_accelerator(Some(&invalid)), "auto");
        let forced = json!({"accelerator": "cf"});
        assert_eq!(nodequality_accelerator(Some(&forced)), "cf");
        let removed_earthone = json!({"accelerator": "eo"});
        assert_eq!(nodequality_accelerator(Some(&removed_earthone)), "auto");
        let invalid_accelerator = json!({"accelerator": "evil"});
        assert_eq!(nodequality_accelerator(Some(&invalid_accelerator)), "auto");
    }

    #[cfg(unix)]
    #[test]
    fn nodequality_report_url_wins_over_upstream_cleanup_exit_code() {
        use std::os::unix::process::ExitStatusExt;

        let output = FixedScriptOutput {
            text: "Fio test 85%\rFio test 100%\nhttps://nodequality.com/r/abc12345\n".into(),
            status: std::process::ExitStatus::from_raw(256),
            nodequality: None,
        };
        let result = nodequality_task_output(&output).unwrap();
        assert_eq!(
            result.result["report_url"],
            "https://nodequality.com/r/abc12345"
        );
    }

    #[test]
    fn terminal_progress_keeps_only_the_latest_frame() {
        assert_eq!(
            strip_ansi_codes("Fio 84%\rFio 85%\rFio 86%\nreport\n"),
            "Fio 86%\nreport\n"
        );
    }

    #[test]
    fn capped_task_output_keeps_the_tail() {
        let output = read_tail_capped(std::io::Cursor::new(b"0123456789"), 6);
        assert_eq!(output, b"456789");
    }

    #[cfg(unix)]
    #[test]
    fn task_output_reader_stops_when_a_descendant_keeps_the_pipe_open() {
        use std::io::Write;
        use std::os::unix::net::UnixStream;
        use std::sync::mpsc;

        let (reader, mut inherited_writer) = UnixStream::pair().unwrap();
        inherited_writer.write_all(b"task output").unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let reader_stop = Arc::clone(&stop);
        let (result_tx, result_rx) = mpsc::channel();
        thread::spawn(move || {
            let output = read_pipe_tail_bounded(
                reader,
                1024,
                reader_stop,
                Some(Instant::now() + Duration::from_secs(5)),
            );
            result_tx.send(output).unwrap();
        });

        stop.store(true, Ordering::Release);
        let output = result_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("reader must not wait for an inherited writer to close");
        assert_eq!(output, b"task output");
    }

    #[cfg(unix)]
    #[test]
    fn terminate_task_process_group_kills_descendants() {
        use std::io::{BufRead, BufReader};
        use std::os::unix::process::CommandExt;

        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 30 & echo $!; wait")
            .process_group(0)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn descendant test shell");
        let mut pid_text = String::new();
        let mut stdout = BufReader::new(child.stdout.take().expect("capture descendant pid"));
        stdout
            .read_line(&mut pid_text)
            .expect("read descendant pid");
        drop(stdout);
        let grandchild: i32 = pid_text.trim().parse().expect("parse descendant pid");
        let status = terminate_task_process_group(&mut child).expect("task group should be reaped");
        assert!(!status.success());
        assert_eq!(
            unsafe { libc::kill(grandchild, 0) },
            -1,
            "descendant must be terminated with the task group"
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
        assert!(result.result["report"].as_str().unwrap().contains("服务商"));
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
        assert_eq!(IP_UNLOCK_ARGS, ["-4", "-n", "-p"]);
        assert!(!IP_UNLOCK_ARGS.contains(&"-y"));
        assert!(!IP_UNLOCK_ARGS.contains(&"-j"));
    }

    #[test]
    fn ip_unlock_report_is_bounded_to_64_kib() {
        let text = "a".repeat(70 * 1024);
        assert_eq!(
            ip_unlock_report_text(&text).chars().count(),
            MAX_IP_UNLOCK_REPORT_CHARS
        );
        assert_eq!(ip_unlock_report_text("short").chars().count(), 5);
    }

    #[test]
    fn ip_unlock_report_strips_ad_footer() {
        let output = concat!(
            "IP质量体检报告：117.55.*.*\n",
            "五、流媒体解锁检测\n",
            "服务商： TikTok Netflix\n",
            "状态： 解锁 解锁\n",
            "========================================================================\n",
            "今日IP检测量：1；总检测量：2。感谢使用xy系列脚本！\n",
            "TERM environment variable not set.\n",
            "SPONSORSPONSORSPONSOR\n",
            "IPWOIPWOIPWO https://www.ipwo.net/\n",
        );
        let report = ip_unlock_report_text(output);
        assert!(report.contains("今日IP检测量"));
        assert!(!report.contains("SPONSOR"));
        assert!(!report.contains("TERM environment"));
        assert!(!report.contains("ipwo.net"));
    }

    #[test]
    fn ip_unlock_report_falls_back_before_unknown_ad_banner() {
        let output = concat!(
            "IP质量体检报告：117.55.*.*\n",
            "五、流媒体解锁检测\n",
            "服务商： TikTok Netflix\n",
            "状态： 解锁 解锁\n",
            "NEWSPONSORBANNER\n",
            "https://example.com/ad\n",
        );
        let report = ip_unlock_report_text(output);
        assert!(!report.contains("NEWSPONSORBANNER"));
        assert!(!report.contains("example.com/ad"));
    }

    #[test]
    fn fixed_task_timeouts_are_action_specific() {
        assert_eq!(IP_UNLOCK_TIMEOUT_SEC, 600);
    }

    #[test]
    fn fixed_tasks_run_directly_under_the_privileged_manager() {
        use std::ffi::OsStr;

        let direct = fixed_task_command(None);
        assert_eq!(direct.get_program(), OsStr::new("bash"));
        let timed = fixed_task_command(Some(600));
        assert_eq!(timed.get_program(), OsStr::new("timeout"));
        assert_eq!(
            timed.get_args().collect::<Vec<_>>(),
            vec![
                OsStr::new("-k"),
                OsStr::new("5s"),
                OsStr::new("600s"),
                OsStr::new("bash")
            ]
        );
    }

    #[test]
    fn fixed_task_privilege_gate_matches_the_host_context() {
        let result = ensure_privileged_fixed_task_context();
        #[cfg(target_os = "linux")]
        {
            assert_eq!(result.is_ok(), unsafe { libc::geteuid() } == 0);
        }
        #[cfg(not(target_os = "linux"))]
        assert!(result.is_err());
    }

    #[test]
    fn privileged_remote_task_entrypoints_are_checksum_pinned() {
        for (url, expected) in [
            ("https://run.NodeQuality.com", NODEQUALITY_SCRIPT_SHA256),
            ("https://IP.Check.Place", IP_UNLOCK_SCRIPT_SHA256),
        ] {
            assert_eq!(fixed_script_sha256(url).unwrap(), expected);
            assert_eq!(expected.len(), 64);
            assert!(expected.bytes().all(|byte| byte.is_ascii_hexdigit()));
        }
        assert!(fixed_script_sha256("https://example.com/task.sh").is_err());
        assert_eq!(
            fixed_script_asset_url("https://status.example.com/", "https://run.NodeQuality.com")
                .unwrap(),
            "https://status.example.com/vendor/tasks/nodequality.sh"
        );
        assert_eq!(
            fixed_script_asset_url("https://status.example.com", "https://IP.Check.Place").unwrap(),
            "https://status.example.com/vendor/tasks/ip-check.sh"
        );
    }

    #[test]
    fn task_runtime_directory_separates_manager_and_telemetry_state() {
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
            0o711
        );
        let child = tasks.join("child");
        fs::create_dir(&child).unwrap();
        set_private_directory_permissions(&child).unwrap();
        assert_eq!(
            fs::metadata(&child).unwrap().permissions().mode() & 0o777,
            0o700
        );

        fs::remove_dir(&child).unwrap();
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
