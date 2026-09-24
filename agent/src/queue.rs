use super::{json_string, sample_json, QueueCommand, SamplePoint, QUEUE_FLUSH_SEC};
use anyhow::{anyhow, Context, Result};
use serde::de::{SeqAccess, Visitor};
use serde::Deserializer;
use std::collections::VecDeque;
use std::env;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
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

// Even a streaming parse keeps the whole queue in memory as sample structs;
// this bound only stops absurd files (for example a legacy queue copied over
// by the installer) from being read at all. The streaming visitor below
// means the transient memory cost no longer scales with the file size.
const MAX_QUEUE_LOAD_BYTES: u64 = 64 * 1024 * 1024;

struct QueueStreamVisitor {
    queue: VecDeque<SamplePoint>,
    dropped: usize,
}

impl<'de> Visitor<'de> for QueueStreamVisitor {
    type Value = (VecDeque<SamplePoint>, usize);

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("an array of sample points")
    }

    fn visit_seq<A>(mut self, mut seq: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        // Elements are decoded and converted one at a time; the intermediate
        // JSON value is dropped immediately, so peak memory stays bounded by
        // the largest single sample instead of the whole file.
        while let Some(value) = seq.next_element::<serde_json::Value>()? {
            match sample_from_json(&value) {
                Some(sample) => self.queue.push_back(sample),
                None => self.dropped += 1,
            }
        }
        Ok((self.queue, self.dropped))
    }
}

pub(super) fn load_sample_queue(path: &Path) -> Result<VecDeque<SamplePoint>> {
    if !path.exists() {
        return Ok(VecDeque::new());
    }
    let size = fs::metadata(path)
        .with_context(|| format!("stat sample queue {}", path.display()))?
        .len();
    if size > MAX_QUEUE_LOAD_BYTES {
        let parked = path.with_extension("json.oversized");
        let _ = fs::remove_file(&parked);
        let _ = fs::rename(path, &parked);
        return Err(anyhow!(
            "sample queue {} is too large to load ({} bytes, limit {}); parked as {}",
            path.display(),
            size,
            MAX_QUEUE_LOAD_BYTES,
            parked.display()
        ));
    }
    let file =
        fs::File::open(path).with_context(|| format!("read sample queue {}", path.display()))?;
    let mut deserializer = serde_json::Deserializer::from_reader(std::io::BufReader::new(file));
    let (queue, dropped) = deserializer
        .deserialize_seq(QueueStreamVisitor {
            queue: VecDeque::new(),
            dropped: 0,
        })
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("invalid type") {
                anyhow!(
                    "sample queue {} is not an array: {}",
                    path.display(),
                    message
                )
            } else {
                anyhow!("parse sample queue {}: {}", path.display(), message)
            }
        })?;
    deserializer
        .end()
        .map_err(|error| anyhow!("parse sample queue {}: {}", path.display(), error))?;
    if dropped > 0 {
        // A damaged entry must not vanish silently: visibility matters more
        // than the (bounded) extra log line.
        eprintln!("{{\"ok\":false,\"queue_load_dropped_samples\":{dropped}}}");
    }
    Ok(queue)
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
    let write_result = (|| -> Result<()> {
        // Stream the array element by element instead of building a full
        // serde_json::Value DOM first: the previous collect() created a
        // multi-hundred-megabyte transient allocation for large backlogs.
        file.write_all(b"[")
            .with_context(|| format!("write sample queue {}", temp.display()))?;
        for (index, sample) in samples.iter().enumerate() {
            if index > 0 {
                file.write_all(b",")
                    .with_context(|| format!("write sample queue {}", temp.display()))?;
            }
            serde_json::to_writer(&mut file, &sample_json(sample))
                .with_context(|| format!("write sample queue {}", temp.display()))?;
        }
        file.write_all(b"]")
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
    samples: VecDeque<SamplePoint>,
    max_samples: usize,
) -> mpsc::Sender<QueueCommand> {
    let (tx, rx) = mpsc::channel();
    let rx = Arc::new(Mutex::new(rx));
    let mut initial_samples = Some(samples);
    crate::supervisor::respawn_loop("queue-writer", move || {
        let samples = match initial_samples.take() {
            Some(samples) => samples,
            // A rebuilt writer reloads the durable tail; only appends that were
            // still inside the panicked thread can be lost.
            None => match load_sample_queue(&path) {
                Ok(samples) => samples,
                Err(error) => {
                    eprintln!(
                        "{{\"ok\":false,\"queue_reload_error\":{}}}",
                        json_string(&error.to_string())
                    );
                    VecDeque::new()
                }
            },
        };
        run_queue_writer(&path, samples, max_samples, &rx)
    });
    tx
}

fn run_queue_writer(
    path: &Path,
    mut samples: VecDeque<SamplePoint>,
    max_samples: usize,
    rx: &Mutex<mpsc::Receiver<QueueCommand>>,
) -> bool {
    let mut dirty = false;
    let mut last_flush = Instant::now();
    loop {
        let received = match rx.lock() {
            Ok(guard) => guard.recv_timeout(Duration::from_secs(1)),
            Err(poisoned) => poisoned.into_inner().recv_timeout(Duration::from_secs(1)),
        };
        match received {
            Ok(QueueCommand::Append(sample)) => {
                samples.push_back(sample);
                if samples.len() > max_samples {
                    samples.pop_front();
                }
                dirty = true;
            }
            Ok(QueueCommand::AcknowledgeCount(count)) => {
                // Count-based drop stays correct across clock steps where
                // a timestamp comparison would delete fresh samples.
                samples.drain(0..count.min(samples.len()));
                shrink_queue_capacity(&mut samples);
                dirty = persist_sample_queue(path, &samples);
                last_flush = Instant::now();
            }
            Ok(QueueCommand::Flush(reply)) => {
                let result = save_sample_queue(path, &samples);
                dirty = result.is_err();
                last_flush = Instant::now();
                let _ = reply.send(result.map_err(|error| error.to_string()));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if dirty {
                    persist_sample_queue(path, &samples);
                }
                return false;
            }
        }
        if dirty && last_flush.elapsed() >= Duration::from_secs(QUEUE_FLUSH_SEC) {
            dirty = persist_sample_queue(path, &samples);
            last_flush = Instant::now();
        }
    }
}

fn shrink_queue_capacity(samples: &mut VecDeque<SamplePoint>) {
    // A burst (offline period, failed uploads) can grow the queue far beyond
    // its steady size; without this the capacity stays resident forever.
    if samples.capacity() > samples.len().saturating_add(1024) {
        samples.shrink_to_fit();
    }
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
        load5: json_f64(value, "load5"),
        load15: json_f64(value, "load15"),
        process_count: value
            .get("process_count")
            .and_then(|item| item.as_u64())
            .unwrap_or(0) as u32,
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
    use std::thread;

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
    fn oversized_queue_is_parked_instead_of_loaded() {
        let dir = env::temp_dir().join(format!("nstatus-queue-oversized-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("samples-queue.json");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_QUEUE_LOAD_BYTES + 1).unwrap();
        drop(file);
        let error = load_sample_queue(&path).unwrap_err().to_string();
        assert!(error.contains("too large"), "unexpected error: {error}");
        assert!(!path.exists(), "oversized queue must be moved aside");
        assert!(dir.join("samples-queue.json.oversized").is_file());
        let _ = fs::remove_dir_all(&dir);
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
