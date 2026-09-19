use std::panic::{catch_unwind, AssertUnwindSafe};
use std::thread;
use std::time::Duration;

// Long-lived workers own state that the rest of the agent depends on (sample
// persistence, uploads, pings, heartbeats). A panicked or unexpectedly exited
// thread used to degrade the process silently until a manual restart; every
// supervised worker is now logged and rebuilt instead.
const RESTART_DELAY: Duration = Duration::from_secs(1);

// `worker` returns `true` when it stopped without a shutdown request and must
// be rebuilt, or `false` when its channels closed because the process is
// shutting down.
pub(super) fn respawn_loop(
    name: &str,
    worker: impl FnMut() -> bool + Send + 'static,
) -> thread::JoinHandle<()> {
    spawn_supervisor(name.to_string(), None, worker)
}

pub(super) fn respawn_loop_with_stack(
    name: &str,
    stack_bytes: usize,
    worker: impl FnMut() -> bool + Send + 'static,
) -> thread::JoinHandle<()> {
    spawn_supervisor(name.to_string(), Some(stack_bytes), worker)
}

fn spawn_supervisor(
    name: String,
    stack_bytes: Option<usize>,
    mut worker: impl FnMut() -> bool + Send + 'static,
) -> thread::JoinHandle<()> {
    let mut builder = thread::Builder::new().name(name.clone());
    if let Some(bytes) = stack_bytes {
        builder = builder.stack_size(bytes);
    }
    let run_name = name.clone();
    let run = move || loop {
        match catch_unwind(AssertUnwindSafe(&mut worker)) {
            Ok(true) => eprintln!(
                "{{\"ok\":false,\"worker_exited\":{}}}",
                crate::json_string(&run_name)
            ),
            Ok(false) => break,
            Err(_) => eprintln!(
                "{{\"ok\":false,\"worker_panicked\":{}}}",
                crate::json_string(&run_name)
            ),
        }
        thread::sleep(RESTART_DELAY);
    };
    match builder.spawn(run) {
        Ok(handle) => handle,
        Err(error) => {
            eprintln!(
                "{{\"ok\":false,\"worker_spawn_error\":{},\"worker\":{}}}",
                crate::json_string(&error.to_string()),
                crate::json_string(&name)
            );
            thread::spawn(|| {})
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn supervisor_rebuilds_a_panicking_worker_until_shutdown() {
        let runs = Arc::new(AtomicUsize::new(0));
        let worker_runs = Arc::clone(&runs);
        let handle = respawn_loop("test-panicking-worker", move || {
            let run = worker_runs.fetch_add(1, Ordering::SeqCst) + 1;
            if run < 3 {
                panic!("simulated worker failure {run}");
            }
            false
        });
        handle.join().unwrap();
        assert_eq!(runs.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn supervisor_stops_when_a_worker_reports_shutdown() {
        let runs = Arc::new(AtomicUsize::new(0));
        let worker_runs = Arc::clone(&runs);
        let handle = respawn_loop("test-shutdown-worker", move || {
            worker_runs.fetch_add(1, Ordering::SeqCst);
            false
        });
        handle.join().unwrap();
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }
}
