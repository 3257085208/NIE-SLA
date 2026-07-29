use super::{
    drop_samples_through, json_string, sample_json, QueueCommand, SamplePoint, QUEUE_FLUSH_SEC,
};
use anyhow::{Context, Result};
use std::collections::VecDeque;
use std::env;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(super) fn default_queue_file() -> String {
    env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|dir| dir.join("samples-queue.json")))
        .unwrap_or_else(|| PathBuf::from("samples-queue.json"))
        .to_string_lossy()
        .to_string()
}

pub(super) fn load_sample_queue(path: &Path) -> Result<VecDeque<SamplePoint>> {
    if !path.exists() {
        return Ok(VecDeque::new());
    }
    let data = fs::read(path).with_context(|| format!("read sample queue {}", path.display()))?;
    let values: serde_json::Value = serde_json::from_slice(&data)
        .with_context(|| format!("parse sample queue {}", path.display()))?;
    let values = values
        .as_array()
        .with_context(|| format!("sample queue {} is not an array", path.display()))?;
    Ok(values.iter().filter_map(sample_from_json).collect())
}

pub(super) fn save_sample_queue(path: &Path, samples: &VecDeque<SamplePoint>) -> Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if parent != Path::new(".") {
        fs::create_dir_all(parent)
            .with_context(|| format!("create sample queue directory {}", parent.display()))?;
    }
    let (temp, mut file) = create_queue_temp_file(path, parent)?;
    let values: Vec<_> = samples.iter().map(sample_json).collect();
    let write_result = (|| -> Result<()> {
        file.write_all(&serde_json::to_vec(&values)?)
            .with_context(|| format!("write sample queue {}", temp.display()))?;
        file.sync_all()
            .with_context(|| format!("fsync sample queue {}", temp.display()))?;
        drop(file);
        #[cfg(target_os = "windows")]
        if path.exists() {
            fs::remove_file(path)
                .with_context(|| format!("replace sample queue {}", path.display()))?;
        }
        fs::rename(&temp, path)
            .with_context(|| format!("commit sample queue {}", path.display()))?;
        sync_queue_parent(parent)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result
}

fn create_queue_temp_file(path: &Path, parent: &Path) -> Result<(PathBuf, fs::File)> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .context("sample queue path must name a file")?;
    let stamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for _ in 0..32 {
        let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp = parent.join(format!(
            ".{name}.tmp-{}-{stamp}-{counter}",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temp) {
            Ok(file) => return Ok((temp, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("create sample queue {}", temp.display()))
            }
        }
    }
    anyhow::bail!("create unique sample queue temporary file")
}

#[cfg(unix)]
fn sync_queue_parent(parent: &Path) -> Result<()> {
    fs::File::open(parent)
        .with_context(|| format!("open sample queue directory {}", parent.display()))?
        .sync_all()
        .with_context(|| format!("fsync sample queue directory {}", parent.display()))
}

#[cfg(not(unix))]
fn sync_queue_parent(_parent: &Path) -> Result<()> {
    Ok(())
}

pub(super) fn flush_sample_queue(tx: &mpsc::Sender<QueueCommand>) -> Result<()> {
    let (reply_tx, reply_rx) = mpsc::channel();
    tx.send(QueueCommand::Flush(reply_tx))
        .context("request sample queue flush")?;
    reply_rx
        .recv_timeout(Duration::from_secs(30))
        .context("wait for sample queue flush")?
        .map_err(anyhow::Error::msg)
}

pub(super) fn spawn_queue_writer(
    path: PathBuf,
    mut samples: VecDeque<SamplePoint>,
    max_samples: usize,
) -> mpsc::Sender<QueueCommand> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut dirty = false;
        let mut last_flush = Instant::now();
        loop {
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(QueueCommand::Append(sample)) => {
                    samples.push_back(sample);
                    if samples.len() > max_samples {
                        samples.pop_front();
                    }
                    dirty = true;
                }
                Ok(QueueCommand::Acknowledge(ts)) => {
                    drop_samples_through(&mut samples, ts);
                    dirty = persist_sample_queue(&path, &samples);
                    last_flush = Instant::now();
                }
                Ok(QueueCommand::Flush(reply)) => {
                    let result = save_sample_queue(&path, &samples);
                    dirty = result.is_err();
                    last_flush = Instant::now();
                    let _ = reply.send(result.map_err(|error| error.to_string()));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if dirty {
                        persist_sample_queue(&path, &samples);
                    }
                    break;
                }
            }
            if dirty && last_flush.elapsed() >= Duration::from_secs(QUEUE_FLUSH_SEC) {
                dirty = persist_sample_queue(&path, &samples);
                last_flush = Instant::now();
            }
        }
    });
    tx
}

fn persist_sample_queue(path: &Path, samples: &VecDeque<SamplePoint>) -> bool {
    if let Err(err) = save_sample_queue(path, samples) {
        eprintln!(
            "{{\"ok\":false,\"queue_error\":{}}}",
            json_string(&err.to_string())
        );
        return true;
    }
    false
}

fn sample_from_json(value: &serde_json::Value) -> Option<SamplePoint> {
    let ts = value.get("ts")?.as_i64()?;
    if ts <= 0 {
        return None;
    }
    Some(SamplePoint {
        ts,
        cpu: json_f64(value, "cpu"),
        mem: json_f64(value, "mem"),
        disk: json_f64(value, "disk"),
        load: json_f64(value, "load"),
        net_rx: json_f64(value, "net_rx"),
        net_tx: json_f64(value, "net_tx"),
        tcp_conns: value
            .get("tcp_conns")
            .and_then(|item| item.as_u64())
            .unwrap_or(0),
        udp_conns: value
            .get("udp_conns")
            .and_then(|item| item.as_u64())
            .unwrap_or(0),
        disk_read: json_f64(value, "disk_read"),
        disk_write: json_f64(value, "disk_write"),
        cpu_temp: json_f64_opt(value, "cpu_temp"),
        gpu_temp: json_f64_opt(value, "gpu_temp"),
        gpu_util: json_f64_opt(value, "gpu_util"),
        motherboard_temp: json_f64_opt(value, "motherboard_temp"),
        disk_temp: json_f64_opt(value, "disk_temp"),
        chipset_temp: json_f64_opt(value, "chipset_temp"),
    })
}

fn json_f64(value: &serde_json::Value, key: &str) -> f64 {
    value.get(key).and_then(|item| item.as_f64()).unwrap_or(0.0)
}

fn json_f64_opt(value: &serde_json::Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(|item| item.as_f64())
        .filter(|v| v.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_queue_survives_restart_round_trip() {
        let path = env::temp_dir().join(format!("nstatus-queue-{}.json", std::process::id()));
        let samples = VecDeque::from([SamplePoint {
            ts: 123,
            cpu: 12.5,
            mem: 34.5,
            tcp_conns: 7,
            ..SamplePoint::default()
        }]);
        save_sample_queue(&path, &samples).unwrap();
        let loaded = load_sample_queue(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].ts, 123);
        assert_eq!(loaded[0].cpu, 12.5);
        assert_eq!(loaded[0].tcp_conns, 7);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn failed_queue_save_remains_dirty_for_retry() {
        let root = env::temp_dir().join(format!("nstatus-queue-blocked-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(&root);
        fs::write(&root, b"not a directory").unwrap();
        let path = root.join("samples-queue.json");
        let samples = VecDeque::from([SamplePoint {
            ts: 123,
            ..SamplePoint::default()
        }]);
        assert!(persist_sample_queue(&path, &samples));
        let _ = fs::remove_file(root);
    }

    #[test]
    fn corrupt_queue_is_reported_as_an_error() {
        let path =
            env::temp_dir().join(format!("nstatus-queue-corrupt-{}.json", std::process::id()));
        fs::write(&path, b"not json").unwrap();
        let error = load_sample_queue(&path).unwrap_err().to_string();
        assert!(error.contains("parse sample queue"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn non_array_queue_is_reported_as_an_error() {
        let path = env::temp_dir().join(format!(
            "nstatus-queue-object-{}-{:?}.json",
            std::process::id(),
            thread::current().id()
        ));
        fs::write(&path, b"{}").unwrap();
        let error = load_sample_queue(&path).unwrap_err().to_string();
        assert!(error.contains("is not an array"));
        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn queue_save_does_not_follow_a_stale_fixed_temp_symlink() {
        use std::os::unix::fs::symlink;

        let root = env::temp_dir().join(format!(
            "nstatus-queue-symlink-{}-{:?}",
            std::process::id(),
            thread::current().id()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("samples-queue.json");
        let victim = root.join("victim");
        let stale_temp = path.with_extension("json.tmp");
        fs::write(&victim, b"unchanged").unwrap();
        symlink(&victim, &stale_temp).unwrap();
        save_sample_queue(&path, &VecDeque::new()).unwrap();
        assert_eq!(fs::read(&victim).unwrap(), b"unchanged");
        assert!(stale_temp.is_symlink());
        let _ = fs::remove_dir_all(root);
    }
}
