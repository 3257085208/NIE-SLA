use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

// Ping and proxy probes used to spawn (and join) up to 32 short-lived threads
// every cycle; probes now run on a fixed pool that is created once per process.
// Eight workers keep a full probe batch (dozens of targets, 1s TCP timeouts)
// finishing in a few seconds while each idle worker costs only a small stack,
// which matters on the small VPS hosts this agent targets.
pub(super) const POOL_WORKERS: usize = 8;
const WORKER_STACK_BYTES: usize = 256 * 1024;
const JOB_TIMEOUT: Duration = Duration::from_secs(180);

type ProbeJob = Box<dyn FnOnce() + Send + 'static>;

pub(super) struct ProbePool {
    jobs: mpsc::Sender<ProbeJob>,
}

impl ProbePool {
    pub(super) fn new() -> Self {
        let (jobs, rx) = mpsc::channel::<ProbeJob>();
        let rx = Arc::new(Mutex::new(rx));
        for index in 0..POOL_WORKERS {
            let rx = Arc::clone(&rx);
            let name = format!("probe-worker-{index}");
            crate::supervisor::respawn_loop_with_stack(&name, WORKER_STACK_BYTES, move || {
                run_probe_worker(&rx)
            });
        }
        Self { jobs }
    }

    // Runs every job on the pool and collects the results. A panicking job is
    // logged and dropped; a stalled job is abandoned after JOB_TIMEOUT so one
    // wedged probe cannot stop all later batches.
    pub(super) fn run<T, F>(&self, jobs: Vec<F>) -> Vec<T>
    where
        T: Send + 'static,
        F: FnOnce() -> T + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<Option<T>>();
        let mut jobs = jobs.into_iter();
        let mut queued = 0usize;
        for job in jobs.by_ref() {
            let tx = tx.clone();
            let wrapped: ProbeJob = Box::new(move || {
                let parsed = catch_unwind(AssertUnwindSafe(job));
                let value = match parsed {
                    Ok(value) => Some(value),
                    Err(_) => {
                        eprintln!("{{\"ok\":false,\"probe_job_panicked\":true}}");
                        None
                    }
                };
                let _ = tx.send(value);
            });
            if self.jobs.send(wrapped).is_err() {
                eprintln!("{{\"ok\":false,\"probe_pool_unavailable\":true}}");
                break;
            }
            queued += 1;
        }
        let mut results = Vec::with_capacity(queued);
        // A dead pool must never lose probes: run the remainder inline.
        for job in jobs {
            match catch_unwind(AssertUnwindSafe(job)) {
                Ok(value) => results.push(value),
                Err(_) => eprintln!("{{\"ok\":false,\"probe_job_panicked\":true}}"),
            }
        }
        drop(tx);
        let mut received = 0usize;
        while received < queued {
            match rx.recv_timeout(JOB_TIMEOUT) {
                Ok(Some(value)) => results.push(value),
                Ok(None) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    eprintln!("{{\"ok\":false,\"probe_job_timeout\":true}}");
                    break;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            received += 1;
        }
        results
    }
}

fn run_probe_worker(rx: &Mutex<mpsc::Receiver<ProbeJob>>) -> bool {
    loop {
        let job = match rx.lock() {
            Ok(guard) => guard.recv(),
            Err(poisoned) => poisoned.into_inner().recv(),
        };
        match job {
            Ok(job) => job(),
            Err(_) => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn pool_runs_jobs_and_returns_results() {
        let pool = ProbePool::new();
        let jobs: Vec<_> = (0..8).map(|value| move || value * 2).collect();
        let mut results = pool.run(jobs);
        results.sort_unstable();
        assert_eq!(results, vec![0, 2, 4, 6, 8, 10, 12, 14]);
    }

    #[test]
    fn pool_drops_panicking_jobs_without_losing_others() {
        let pool = ProbePool::new();
        let ran = Arc::new(AtomicUsize::new(0));
        let mut jobs: Vec<Box<dyn FnOnce() -> usize + Send>> = Vec::new();
        for value in 0..4 {
            let ran = Arc::clone(&ran);
            jobs.push(Box::new(move || {
                ran.fetch_add(1, Ordering::SeqCst);
                if value == 2 {
                    panic!("simulated probe panic");
                }
                value
            }));
        }
        let mut results = pool.run(jobs);
        results.sort_unstable();
        assert_eq!(results, vec![0, 1, 3]);
        assert_eq!(ran.load(Ordering::SeqCst), 4);
    }
}
