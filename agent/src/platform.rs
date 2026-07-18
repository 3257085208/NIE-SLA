#[cfg(target_os = "linux")]
pub(super) fn net_bytes() -> (u64, u64) {
    let Ok(text) = std::fs::read_to_string("/proc/net/dev") else {
        return (0, 0);
    };
    let mut rx = 0_u64;
    let mut tx = 0_u64;
    for line in text.lines().skip(2) {
        let Some((iface, data)) = line.split_once(':') else {
            continue;
        };
        if iface.trim() == "lo" {
            continue;
        }
        let fields: Vec<&str> = data.split_whitespace().collect();
        if fields.len() >= 16 {
            rx = rx.saturating_add(fields[0].parse::<u64>().unwrap_or(0));
            tx = tx.saturating_add(fields[8].parse::<u64>().unwrap_or(0));
        }
    }
    (rx, tx)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn net_bytes() -> (u64, u64) {
    (0, 0)
}

#[cfg(target_os = "linux")]
pub(super) fn disk_io_bytes() -> (u64, u64) {
    let Ok(text) = std::fs::read_to_string("/proc/diskstats") else {
        return (0, 0);
    };
    let mut read = 0_u64;
    let mut write = 0_u64;
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 14 {
            continue;
        }
        let name = fields[2];
        if name.starts_with("loop") || name.starts_with("ram") {
            continue;
        }
        let sectors_read = fields[5].parse::<u64>().unwrap_or(0);
        let sectors_written = fields[9].parse::<u64>().unwrap_or(0);
        read = read.saturating_add(sectors_read.saturating_mul(512));
        write = write.saturating_add(sectors_written.saturating_mul(512));
    }
    (read, write)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn disk_io_bytes() -> (u64, u64) {
    (0, 0)
}

#[cfg(target_os = "linux")]
pub(super) fn connection_counts() -> (u64, u64) {
    let tcp = count_conn_file("/proc/net/tcp") + count_conn_file("/proc/net/tcp6");
    let udp = count_conn_file("/proc/net/udp") + count_conn_file("/proc/net/udp6");
    (tcp, udp)
}

#[cfg(target_os = "linux")]
fn count_conn_file(path: &str) -> u64 {
    std::fs::read_to_string(path)
        .map(|value| value.lines().skip(1).count() as u64)
        .unwrap_or(0)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn connection_counts() -> (u64, u64) {
    (0, 0)
}

pub(super) fn virtualization() -> String {
    #[cfg(target_os = "linux")]
    {
        if std::path::Path::new("/proc/xen").exists() {
            return "xen".to_string();
        }
        if let Ok(product) = std::fs::read_to_string("/sys/class/dmi/id/product_name") {
            let product = product.trim().to_lowercase();
            if product.contains("kvm") {
                return "kvm".to_string();
            }
            if product.contains("vmware") {
                return "vmware".to_string();
            }
            if product.contains("virtualbox") {
                return "virtualbox".to_string();
            }
            if product.contains("hyper-v") || product.contains("hyperv") {
                return "hyper-v".to_string();
            }
        }
        if let Ok(cgroup) = std::fs::read_to_string("/proc/1/cgroup") {
            let cgroup = cgroup.to_lowercase();
            if cgroup.contains("docker") {
                return "docker".to_string();
            }
            if cgroup.contains("lxc") {
                return "lxc".to_string();
            }
        }
    }
    String::new()
}
