use crate::{percent_encode_query, Config, HttpClient, AGENT_VERSION};
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

const TASK_POLL_SEC: u64 = 60;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_EXCERPT_CHARS: usize = 16 * 1024;

pub(crate) fn run_task_worker(cfg: &Config, http: &HttpClient) -> Result<()> {
    loop {
        if let Err(error) = poll_once(cfg, http) {
            eprintln!(
                "{{\"ok\":false,\"task_error\":{}}}",
                serde_json::to_string(&error.to_string())
                    .unwrap_or_else(|_| "\"task failed\"".into())
            );
        }
        thread::sleep(Duration::from_secs(TASK_POLL_SEC));
    }
}

fn poll_once(cfg: &Config, http: &HttpClient) -> Result<()> {
    let url = format!(
        "{}/api/agent/tasks?agent_id={}",
        cfg.api.trim_end_matches('/'),
        percent_encode_query(&cfg.agent_id)
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
    let timeout_sec = task
        .get("timeout_sec")
        .and_then(Value::as_u64)
        .unwrap_or(600)
        .clamp(30, 1800);

    let outcome = execute_fixed_task(action, timeout_sec);
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

fn execute_fixed_task(action: &str, timeout_sec: u64) -> Result<TaskOutput> {
    if !cfg!(target_os = "linux") {
        return Err(anyhow!("Beta task actions currently require Linux"));
    }
    match action {
        "nodequality" => run_nodequality(timeout_sec),
        "ip_unlock" => run_ip_unlock(timeout_sec),
        _ => Err(anyhow!("unsupported fixed task action")),
    }
}

fn run_nodequality(timeout_sec: u64) -> Result<TaskOutput> {
    let output = run_fixed_shell(
        timeout_sec.min(1800),
        "bash <(curl -fsSL --proto '=https' --tlsv1.2 https://run.NodeQuality.com)",
        Some(b"v\ny\ny\ny\n"),
    )?;
    let clean = strip_ansi_codes(&output);
    let report_url = extract_report_url(&clean)
        .ok_or_else(|| anyhow!("NodeQuality completed without a report URL"))?;
    Ok(TaskOutput {
        result: json!({ "report_url": report_url }),
        excerpt: output_excerpt(&clean),
    })
}

fn run_ip_unlock(timeout_sec: u64) -> Result<TaskOutput> {
    let output = run_fixed_shell(
        timeout_sec.min(600),
        "bash <(curl -fsSL --proto '=https' --tlsv1.2 https://IP.Check.Place) -4 -j -y",
        None,
    )?;
    let clean = strip_ansi_codes(&output);
    let services = parse_unlock_json(&clean).unwrap_or_else(|| parse_unlock_services(&clean));
    if services.is_empty() {
        return Err(anyhow!("IP unlock check produced no IPv4 unlock rows"));
    }
    Ok(TaskOutput {
        result: json!({ "services": services }),
        excerpt: output_excerpt(&unlock_section(&clean)),
    })
}

fn parse_unlock_json(output: &str) -> Option<Vec<Value>> {
    let start = output.find('{')?;
    let end = output.rfind('}')?;
    let value: Value = serde_json::from_str(&output[start..=end]).ok()?;
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

fn run_fixed_shell(timeout_sec: u64, script: &str, stdin: Option<&[u8]>) -> Result<String> {
    let mut child = Command::new("timeout")
        .arg(format!("{}s", timeout_sec))
        .arg("bash")
        .arg("-lc")
        .arg(script)
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
    let output = child
        .wait_with_output()
        .context("failed to wait for fixed Beta task")?;
    let mut bytes = output.stdout;
    bytes.push(b'\n');
    bytes.extend_from_slice(&output.stderr);
    if bytes.len() > MAX_OUTPUT_BYTES {
        bytes.truncate(MAX_OUTPUT_BYTES);
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    if !output.status.success() {
        return Err(anyhow!(
            "fixed Beta task exited with {}; {}",
            output.status,
            output_excerpt(&strip_ansi_codes(&text))
        ));
    }
    Ok(text)
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
}
