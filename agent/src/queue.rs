use super::{
    drop_samples_through, json_string, sample_json, QueueCommand, SamplePoint, QUEUE_FLUSH_SEC,
};
use anyhow::{Context, Result};
use std::collections::VecDeque;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

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
    Ok(values
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(sample_from_json)
        .collect())
}

pub(super) fn save_sample_queue(path: &Path, samples: &VecDeque<SamplePoint>) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create sample queue directory {}", parent.display()))?;
    }
    let temp = path.with_extension("json.tmp");
    let values: Vec<_> = samples.iter().map(sample_json).collect();
    {
        use std::io::Write;
        let mut file = fs::File::create(&temp)
            .with_context(|| format!("create sample queue {}", temp.display()))?;
        file.write_all(&serde_json::to_vec(&values)?)
            .with_context(|| format!("write sample queue {}", temp.display()))?;
        file.sync_all()
            .with_context(|| format!("fsync sample queue {}", temp.display()))?;
    }
    #[cfg(target_os = "windows")]
    if path.exists() {
        fs::remove_file(path)
            .with_context(|| format!("replace sample queue {}", path.display()))?;
    }
    fs::rename(&temp, path).with_context(|| format!("commit sample queue {}", path.display()))
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
                    if let Err(err) = save_sample_queue(&path, &samples) {
                        eprintln!(
                            "{{\"ok\":false,\"queue_error\":{}}}",
                            json_string(&err.to_string())
                        );
                    }
                    dirty = false;
                    last_flush = Instant::now();
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if dirty {
                        let _ = save_sample_queue(&path, &samples);
                    }
                    break;
                }
            }
            if dirty && last_flush.elapsed() >= Duration::from_secs(QUEUE_FLUSH_SEC) {
                if let Err(err) = save_sample_queue(&path, &samples) {
                    eprintln!(
                        "{{\"ok\":false,\"queue_error\":{}}}",
                        json_string(&err.to_string())
                    );
                }
                dirty = false;
                last_flush = Instant::now();
            }
        }
    });
    tx
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
}
