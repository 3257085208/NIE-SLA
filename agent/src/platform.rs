#[cfg(any(target_os = "linux", test))]
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Default)]
pub(super) struct ThermalSnapshot {
    pub cpu_temp_c: Option<f64>,
    pub gpu_temp_c: Option<f64>,
    pub gpu_util: Option<f64>,
    pub gpu_name: String,
    pub gpu_count: usize,
    pub gpu_accessible: bool,
    pub motherboard_temp_c: Option<f64>,
    pub disk_temp_c: Option<f64>,
    pub chipset_temp_c: Option<f64>,
    pub sensors: Vec<TemperatureSensor>,
}

#[derive(Clone, Debug)]
pub(super) struct TemperatureSensor {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub temp_c: f64,
}

struct GpuCache {
    at: Instant,
    temp_c: Option<f64>,
    util: Option<f64>,
    name: String,
    count: usize,
    accessible: bool,
}

static GPU_CACHE: Mutex<Option<GpuCache>> = Mutex::new(None);
const GPU_CACHE_TTL: Duration = Duration::from_secs(10);

#[cfg(target_os = "linux")]
pub(super) fn net_bytes() -> (u64, u64) {
    let Ok(text) = std::fs::read_to_string("/proc/net/dev") else {
        return (0, 0);
    };
    net_bytes_from_proc(&text)
}

#[cfg(any(target_os = "linux", test))]
fn net_bytes_from_proc(text: &str) -> (u64, u64) {
    let mut rx = 0_u64;
    let mut tx = 0_u64;
    for line in text.lines().skip(2) {
        let Some((iface, data)) = line.split_once(':') else {
            continue;
        };
        if !should_count_network_interface(iface.trim()) {
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

#[cfg(any(target_os = "linux", test))]
fn should_count_network_interface(name: &str) -> bool {
    name != "lo"
        && name != "docker0"
        && name != "cni0"
        && !name.starts_with("veth")
        && !name.starts_with("br-")
        && !name.starts_with("virbr")
        && !name.starts_with("flannel.")
        && !name.starts_with("cali")
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
        if !should_count_disk_device_at(Path::new("/sys/class/block"), name) {
            continue;
        }
        let sectors_read = fields[5].parse::<u64>().unwrap_or(0);
        let sectors_written = fields[9].parse::<u64>().unwrap_or(0);
        read = read.saturating_add(sectors_read.saturating_mul(512));
        write = write.saturating_add(sectors_written.saturating_mul(512));
    }
    (read, write)
}

#[cfg(any(target_os = "linux", test))]
fn should_count_disk_device_at(sys_block: &Path, name: &str) -> bool {
    if name.starts_with("loop") || name.starts_with("ram") || name.starts_with("zram") {
        return false;
    }
    let device = sys_block.join(name);
    if device.join("partition").exists() {
        return false;
    }
    match std::fs::read_dir(device.join("slaves")) {
        Ok(mut entries) => entries.next().is_none(),
        Err(_) => true,
    }
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

/// Detect hypervisor / container / cloud virt. Prefer specific products over bare "kvm".
pub(super) fn virtualization() -> String {
    #[cfg(target_os = "linux")]
    {
        if let Some(value) = detect_container() {
            return value;
        }
        if let Some(value) = detect_via_systemd() {
            return value;
        }
        if let Some(value) = detect_via_sys_hypervisor() {
            return value;
        }
        if let Some(value) = detect_via_cpuinfo() {
            return value;
        }
        if let Some(value) = detect_via_dmi() {
            return value;
        }
        if Path::new("/proc/xen").exists()
            || Path::new("/sys/hypervisor/properties/features").exists()
        {
            return "xen".to_string();
        }
        if Path::new("/proc/vz").exists() || Path::new("/proc/bc").exists() {
            return "openvz".to_string();
        }
        if is_wsl() {
            return "wsl".to_string();
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(value) = detect_windows_virt() {
            return value;
        }
    }
    String::new()
}

pub(super) fn thermal_snapshot() -> ThermalSnapshot {
    let cpu_temp_c = cpu_temperature_c();
    let (gpu_temp_c, gpu_util, gpu_name, gpu_count, gpu_accessible) = gpu_snapshot();
    let sensors = temperature_sensors();
    ThermalSnapshot {
        cpu_temp_c,
        gpu_temp_c,
        gpu_util,
        gpu_name,
        gpu_count,
        gpu_accessible,
        motherboard_temp_c: hottest_sensor(&sensors, "motherboard"),
        disk_temp_c: hottest_sensor(&sensors, "disk"),
        chipset_temp_c: hottest_sensor(&sensors, "chipset"),
        sensors,
    }
}

fn hottest_sensor(sensors: &[TemperatureSensor], kind: &str) -> Option<f64> {
    sensors
        .iter()
        .filter(|sensor| sensor.kind == kind)
        .map(|sensor| sensor.temp_c)
        .reduce(f64::max)
}

#[cfg(target_os = "linux")]
fn detect_container() -> Option<String> {
    if Path::new("/.dockerenv").exists() {
        return Some("docker".to_string());
    }
    if Path::new("/run/.containerenv").exists() {
        return Some("podman".to_string());
    }
    if let Ok(cgroup) = std::fs::read_to_string("/proc/1/cgroup") {
        let cgroup = cgroup.to_lowercase();
        if cgroup.contains("docker") || cgroup.contains("containerd") || cgroup.contains("kubepods")
        {
            return Some("docker".to_string());
        }
        if cgroup.contains("libpod") || cgroup.contains("podman") {
            return Some("podman".to_string());
        }
        if cgroup.contains("/lxc") || cgroup.contains("lxc.payload") {
            return Some("lxc".to_string());
        }
    }
    if is_wsl() {
        return Some("wsl".to_string());
    }
    None
}

#[cfg(target_os = "linux")]
fn is_wsl() -> bool {
    if let Ok(version) = std::fs::read_to_string("/proc/version") {
        let lower = version.to_lowercase();
        if lower.contains("microsoft") || lower.contains("wsl") {
            return true;
        }
    }
    Path::new("/proc/sys/fs/binfmt_misc/WSLInterop").exists()
}

#[cfg(target_os = "linux")]
fn detect_via_systemd() -> Option<String> {
    let named = Command::new("systemd-detect-virt").output().ok()?;
    let text = String::from_utf8_lossy(&named.stdout).trim().to_lowercase();
    if text.is_empty() || text == "none" {
        return None;
    }
    Some(normalize_virt_label(&text))
}

#[cfg(target_os = "linux")]
fn detect_via_sys_hypervisor() -> Option<String> {
    let path = Path::new("/sys/hypervisor/type");
    if !path.exists() {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?.trim().to_lowercase();
    if text.is_empty() {
        return None;
    }
    Some(normalize_virt_label(&text))
}

#[cfg(target_os = "linux")]
fn detect_via_cpuinfo() -> Option<String> {
    let text = std::fs::read_to_string("/proc/cpuinfo")
        .ok()?
        .to_lowercase();
    // CPUID hypervisor leaves fingerprints in model name / flags / vendor-like strings.
    for (needle, label) in [
        ("kvmkvmkvm", "kvm"),
        ("microsoft hv", "hyper-v"),
        ("vmwarevmware", "vmware"),
        ("xenvmmxenvmm", "xen"),
        ("prl hyperv", "parallels"),
        ("bhyve bhyve", "bhyve"),
        ("tcg tcg tcg", "qemu"),
        ("lrpepyh vr", "parallels"),
        ("virtualbox", "virtualbox"),
        ("vboxvbos", "virtualbox"),
    ] {
        if text.contains(needle) {
            return Some(label.to_string());
        }
    }
    if text.contains("hypervisor") {
        // Generic hypervisor bit without vendor — try DMI next, but keep qemu guess low priority
        if text.contains("qemu") {
            return Some("qemu".to_string());
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn detect_via_dmi() -> Option<String> {
    let blobs = [
        read_sys_trim("/sys/class/dmi/id/sys_vendor"),
        read_sys_trim("/sys/class/dmi/id/product_name"),
        read_sys_trim("/sys/class/dmi/id/product_version"),
        read_sys_trim("/sys/class/dmi/id/bios_vendor"),
        read_sys_trim("/sys/class/dmi/id/board_vendor"),
        read_sys_trim("/sys/class/dmi/id/chassis_vendor"),
        read_sys_trim("/sys/devices/virtual/dmi/id/product_name"),
        read_sys_trim("/sys/devices/virtual/dmi/id/sys_vendor"),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase();

    if blobs.is_empty() {
        return None;
    }

    for (needle, label) in [
        ("amazon ec2", "amazon-ec2"),
        ("amazon", "amazon-ec2"),
        ("google", "gce"),
        ("compute engine", "gce"),
        ("microsoft corporation", "hyper-v"),
        ("hyper-v", "hyper-v"),
        ("virtual machine", "hyper-v"),
        ("vmware", "vmware"),
        ("virtualbox", "virtualbox"),
        ("innotek", "virtualbox"),
        ("oracle", "virtualbox"),
        ("xen", "xen"),
        ("bochs", "bochs"),
        ("qemu", "qemu"),
        ("kvm", "kvm"),
        ("openstack", "openstack"),
        ("parallels", "parallels"),
        ("bhyve", "bhyve"),
        ("openvz", "openvz"),
        ("lxc", "lxc"),
        ("alibaba", "aliyun"),
        ("alibabacloud", "aliyun"),
        ("tencent", "tencent"),
        ("huawei", "huawei"),
        ("ucloud", "ucloud"),
        ("digitalocean", "digitalocean"),
        ("linode", "linode"),
        ("vultr", "vultr"),
        ("ovh", "ovh"),
        ("hertzner", "hetzner"),
        ("hetzner", "hetzner"),
        ("proxmox", "kvm"),
        ("rhev", "kvm"),
        ("ovirt", "kvm"),
        ("nutanix", "nutanix"),
        ("nutanix ahv", "nutanix"),
        ("powerkvm", "powerkvm"),
        ("z/vm", "zvm"),
        ("zvm", "zvm"),
        ("uml", "uml"),
        ("apple", "apple-virt"),
        ("virtual", "virtual"),
    ] {
        if blobs.contains(needle) {
            // Avoid labeling bare metal Apple Mac as virtual
            if label == "apple-virt" && !blobs.contains("virtual") {
                continue;
            }
            if label == "virtual" {
                continue;
            }
            return Some(label.to_string());
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn read_sys_trim(path: &str) -> String {
    std::fs::read_to_string(path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

#[cfg(any(target_os = "linux", test))]
fn normalize_virt_label(raw: &str) -> String {
    let v = raw.trim().to_lowercase();
    match v.as_str() {
        "microsoft" | "microsoft-hyper-v" | "hyperv" | "hyper-v" => "hyper-v".to_string(),
        "kvm" | "qemu" | "qemu-kvm" => {
            if v.contains("qemu") && !v.contains("kvm") {
                "qemu".to_string()
            } else {
                "kvm".to_string()
            }
        }
        "vmware" | "vmware-esx" | "vmware-workstation" => "vmware".to_string(),
        "oracle" | "oraclevm" => "virtualbox".to_string(),
        "bochs" => "bochs".to_string(),
        "uml" => "uml".to_string(),
        "xen" | "xen-domU" | "xen-dom0" => "xen".to_string(),
        "lxc" | "lxc-libvirt" => "lxc".to_string(),
        "systemd-nspawn" | "container-other" => "container".to_string(),
        "docker" => "docker".to_string(),
        "podman" => "podman".to_string(),
        "openvz" | "parallels" | "bhyve" | "zvm" | "powervm" | "wsl" => v,
        other if other.is_empty() || other == "none" => String::new(),
        other => other.replace(' ', "-"),
    }
}

#[cfg(target_os = "windows")]
fn detect_windows_virt() -> Option<String> {
    // Lightweight model/manufacturer probe via PowerShell CIM (best-effort).
    let script = r#"
$cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue
$model = ($cs.Model + ' ' + $cs.Manufacturer + ' ' + $cs.SystemFamily)
$model.ToLower()
"#;
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
    for (needle, label) in [
        ("vmware", "vmware"),
        ("virtualbox", "virtualbox"),
        ("innotek", "virtualbox"),
        ("hyper-v", "hyper-v"),
        ("virtual machine", "hyper-v"),
        ("xen", "xen"),
        ("kvm", "kvm"),
        ("qemu", "qemu"),
        ("parallels", "parallels"),
        ("bhyve", "bhyve"),
        ("amazon", "amazon-ec2"),
        ("google", "gce"),
        ("openstack", "openstack"),
    ] {
        if text.contains(needle) {
            return Some(label.to_string());
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn cpu_temperature_c() -> Option<f64> {
    let mut candidates: Vec<(i32, f64)> = Vec::new();

    // thermal_zone* — prefer package/CPU zones
    if let Ok(entries) = std::fs::read_dir("/sys/class/thermal") {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if !name.starts_with("thermal_zone") {
                continue;
            }
            let zone_type = std::fs::read_to_string(path.join("type"))
                .unwrap_or_default()
                .trim()
                .to_lowercase();
            let priority = thermal_zone_priority(&zone_type);
            if priority < 0 {
                continue;
            }
            if let Some(temp) = read_millidegree(path.join("temp")) {
                candidates.push((priority, temp));
            }
        }
    }

    // hwmon sensors
    if let Ok(entries) = std::fs::read_dir("/sys/class/hwmon") {
        for entry in entries.flatten() {
            let path = entry.path();
            let chip = std::fs::read_to_string(path.join("name"))
                .unwrap_or_default()
                .trim()
                .to_lowercase();
            if chip.contains("gpu")
                || chip.contains("amdgpu")
                || chip.contains("nouveau")
                || chip.contains("nvidia")
            {
                continue;
            }
            // collect temp*_input
            if let Ok(files) = std::fs::read_dir(&path) {
                for file in files.flatten() {
                    let fname = file.file_name().to_string_lossy().to_lowercase();
                    if !fname.starts_with("temp") || !fname.ends_with("_input") {
                        continue;
                    }
                    let label = {
                        let label_name = fname.replace("_input", "_label");
                        std::fs::read_to_string(path.join(label_name))
                            .unwrap_or_default()
                            .trim()
                            .to_lowercase()
                    };
                    let Some(temp) = read_millidegree(file.path()) else {
                        continue;
                    };
                    let priority = hwmon_cpu_priority(&chip, &label);
                    if priority >= 0 {
                        candidates.push((priority, temp));
                    }
                }
            }
        }
    }

    if candidates.is_empty() {
        return None;
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    let best = candidates[0].1;
    if best < 1.0 || best > 125.0 {
        return None;
    }
    Some((best * 10.0).round() / 10.0)
}

#[cfg(not(target_os = "linux"))]
fn cpu_temperature_c() -> Option<f64> {
    None
}

#[cfg(target_os = "linux")]
fn thermal_zone_priority(zone_type: &str) -> i32 {
    if zone_type.contains("x86_pkg") || zone_type.contains("pkg_temp") {
        return 100;
    }
    if zone_type.contains("cpu") || zone_type.contains("soc") || zone_type.contains("coretemp") {
        return 90;
    }
    if zone_type.contains("acpitz") || zone_type == "tz00" {
        return 40;
    }
    if zone_type.contains("gpu") || zone_type.contains("nvme") || zone_type.contains("pch") {
        return -1;
    }
    10
}

#[cfg(target_os = "linux")]
fn hwmon_cpu_priority(chip: &str, label: &str) -> i32 {
    if chip.contains("coretemp")
        || chip.contains("k10temp")
        || chip.contains("zenpower")
        || chip.contains("cpu_thermal")
    {
        if label.contains("tctl")
            || label.contains("package")
            || label.contains("tDie")
            || label.contains("tdie")
        {
            return 100;
        }
        if label.contains("core") {
            return 80;
        }
        return 70;
    }
    if label.contains("package") || label.contains("tctl") {
        return 90;
    }
    if label.contains("cpu") {
        return 60;
    }
    -1
}

#[cfg(target_os = "linux")]
fn read_millidegree(path: impl AsRef<Path>) -> Option<f64> {
    let raw = std::fs::read_to_string(path.as_ref())
        .ok()?
        .trim()
        .parse::<f64>()
        .ok()?;
    // Some sensors already report whole degrees; millidegree is typical for hwmon.
    let c = if raw.abs() > 200.0 { raw / 1000.0 } else { raw };
    if c.is_finite() {
        Some(c)
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn temperature_sensors() -> Vec<TemperatureSensor> {
    let mut sensors = Vec::new();
    let Ok(entries) = std::fs::read_dir("/sys/class/hwmon") else {
        return sensors;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let chip = std::fs::read_to_string(path.join("name"))
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        let Ok(files) = std::fs::read_dir(&path) else {
            continue;
        };
        for file in files.flatten() {
            let filename = file.file_name().to_string_lossy().to_lowercase();
            if !filename.starts_with("temp") || !filename.ends_with("_input") {
                continue;
            }
            let Some(temp_c) = read_millidegree(file.path()) else {
                continue;
            };
            if !(1.0..=125.0).contains(&temp_c) {
                continue;
            }
            let label_filename = filename.replace("_input", "_label");
            let raw_label = std::fs::read_to_string(path.join(label_filename))
                .unwrap_or_default()
                .trim()
                .to_string();
            let label_lower = raw_label.to_lowercase();
            let Some(kind) = sensor_kind(&chip, &label_lower) else {
                continue;
            };
            let label = if raw_label.is_empty() {
                format!("{} {}", chip, filename.trim_end_matches("_input"))
            } else {
                raw_label
            };
            let id = format!("{}:{}", chip, filename.trim_end_matches("_input"));
            sensors.push(TemperatureSensor {
                id: id.chars().take(64).collect(),
                label: label.chars().take(64).collect(),
                kind: kind.to_string(),
                temp_c: (temp_c * 10.0).round() / 10.0,
            });
        }
    }
    sensors.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.label.cmp(&b.label)));
    sensors.dedup_by(|a, b| a.id == b.id);
    sensors.truncate(16);
    sensors
}

#[cfg(target_os = "linux")]
fn sensor_kind(chip: &str, label: &str) -> Option<&'static str> {
    if chip.contains("gpu")
        || chip.contains("amdgpu")
        || chip.contains("nouveau")
        || chip.contains("nvidia")
        || label.contains("gpu")
    {
        return None;
    }
    if hwmon_cpu_priority(chip, label) >= 0 {
        return None;
    }
    if chip.contains("nvme")
        || chip.contains("drivetemp")
        || chip.contains("hddtemp")
        || label.contains("drive")
        || label.contains("ssd")
    {
        return Some("disk");
    }
    if label.contains("pch") || label.contains("chipset") || chip.contains("pch") {
        return Some("chipset");
    }
    if label.contains("motherboard")
        || label.contains("mainboard")
        || label == "system"
        || label.contains("board")
        || label.contains("vrm")
        || chip.contains("acpitz")
        || chip.starts_with("nct")
        || chip.starts_with("it8")
        || chip.starts_with("w83")
        || chip.starts_with("f718")
        || chip.contains("asus")
    {
        return Some("motherboard");
    }
    if label.contains("battery") {
        return None;
    }
    Some("other")
}

#[cfg(not(target_os = "linux"))]
fn temperature_sensors() -> Vec<TemperatureSensor> {
    Vec::new()
}

fn gpu_snapshot() -> (Option<f64>, Option<f64>, String, usize, bool) {
    if let Ok(guard) = GPU_CACHE.lock() {
        if let Some(cache) = guard.as_ref() {
            if cache.at.elapsed() < GPU_CACHE_TTL {
                return (
                    cache.temp_c,
                    cache.util,
                    cache.name.clone(),
                    cache.count,
                    cache.accessible,
                );
            }
        }
    }

    let (temp_c, util, name, count) = probe_gpu();
    let accessible = count > 0;
    if let Ok(mut guard) = GPU_CACHE.lock() {
        *guard = Some(GpuCache {
            at: Instant::now(),
            temp_c,
            util,
            name: name.clone(),
            count,
            accessible,
        });
    }
    (temp_c, util, name, count, accessible)
}

fn probe_gpu() -> (Option<f64>, Option<f64>, String, usize) {
    if let Some(result) = probe_nvidia_smi() {
        return result;
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(result) = probe_drm_sysfs() {
            return result;
        }
    }
    (None, None, String::new(), 0)
}

fn probe_nvidia_smi() -> Option<(Option<f64>, Option<f64>, String, usize)> {
    let output = Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,utilization.gpu,temperature.gpu",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut names = Vec::new();
    let mut temps = Vec::new();
    let mut utils = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split(',').map(str::trim).collect();
        if parts.len() < 3 {
            continue;
        }
        names.push(parts[0].to_string());
        if let Ok(u) = parts[1].parse::<f64>() {
            utils.push(u);
        }
        if let Ok(t) = parts[2].parse::<f64>() {
            temps.push(t);
        }
    }
    if names.is_empty() {
        return None;
    }
    let temp = if temps.is_empty() {
        None
    } else {
        Some(temps.iter().sum::<f64>() / temps.len() as f64)
    };
    let util = if utils.is_empty() {
        None
    } else {
        Some(utils.iter().sum::<f64>() / utils.len() as f64)
    };
    let name = if names.len() == 1 {
        names[0].clone()
    } else {
        format!("{} (+{})", names[0], names.len() - 1)
    };
    Some((
        temp.map(|v| (v * 10.0).round() / 10.0),
        util.map(|v| (v * 10.0).round() / 10.0),
        name,
        names.len(),
    ))
}

#[cfg(target_os = "linux")]
fn probe_drm_sysfs() -> Option<(Option<f64>, Option<f64>, String, usize)> {
    let drm = Path::new("/sys/class/drm");
    if !drm.exists() {
        return None;
    }
    let mut count = 0usize;
    let mut temp_sum = 0.0;
    let mut temp_n = 0usize;
    let mut util_sum = 0.0;
    let mut util_n = 0usize;
    let mut name = String::new();

    let entries = std::fs::read_dir(drm).ok()?;
    for entry in entries.flatten() {
        let fname = entry.file_name().to_string_lossy().to_string();
        if !fname.starts_with("card") || fname.contains('-') {
            continue;
        }
        // Containers can see host DRM sysfs without receiving the device.
        // Only report hardware that this Agent can actually open.
        if std::fs::OpenOptions::new()
            .read(true)
            .open(Path::new("/dev/dri").join(&fname))
            .is_err()
        {
            continue;
        }
        let device = entry.path().join("device");
        let vendor = std::fs::read_to_string(device.join("vendor")).unwrap_or_default();
        let busy_path = device.join("gpu_busy_percent");
        let has_busy = busy_path.exists();
        let vendor_name = gpu_vendor_name(vendor.trim());
        if !has_busy && vendor_name.is_none() {
            continue;
        }
        count += 1;
        if name.is_empty() {
            name = std::fs::read_to_string(device.join("product_name"))
                .or_else(|_| std::fs::read_to_string(entry.path().join("device/label")))
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| {
                    vendor_name
                        .map(|value| format!("{value} GPU"))
                        .unwrap_or_else(|| format!("GPU {fname}"))
                })
                .trim()
                .to_string();
        }
        if let Ok(util_raw) = std::fs::read_to_string(&busy_path) {
            if let Ok(u) = util_raw.trim().parse::<f64>() {
                util_sum += u;
                util_n += 1;
            }
        }
        // hwmon under device
        let hwmon_root = device.join("hwmon");
        if let Ok(hws) = std::fs::read_dir(hwmon_root) {
            for hw in hws.flatten() {
                if let Some(t) = read_millidegree(hw.path().join("temp1_input")) {
                    temp_sum += t;
                    temp_n += 1;
                    break;
                }
            }
        }
    }
    if count == 0 {
        return None;
    }
    Some((
        if temp_n > 0 {
            Some(((temp_sum / temp_n as f64) * 10.0).round() / 10.0)
        } else {
            None
        },
        if util_n > 0 {
            Some(((util_sum / util_n as f64) * 10.0).round() / 10.0)
        } else {
            None
        },
        name,
        count,
    ))
}

#[cfg(target_os = "linux")]
fn gpu_vendor_name(vendor: &str) -> Option<&'static str> {
    match vendor.trim().to_ascii_lowercase().as_str() {
        "0x1002" => Some("AMD"),
        "0x10de" => Some("NVIDIA"),
        "0x8086" => Some("Intel"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_virt_labels() {
        assert_eq!(normalize_virt_label("microsoft"), "hyper-v");
        assert_eq!(normalize_virt_label("kvm"), "kvm");
        assert_eq!(normalize_virt_label("qemu"), "qemu");
        assert_eq!(normalize_virt_label("none"), "");
    }

    #[test]
    fn network_totals_exclude_container_peer_and_bridge_interfaces() {
        let proc_net_dev = "Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n  lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0\neth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n wg0: 50 0 0 0 0 0 0 0 60 0 0 0 0 0 0 0\ndocker0: 1000 0 0 0 0 0 0 0 1000 0 0 0 0 0 0 0\nveth123: 1000 0 0 0 0 0 0 0 1000 0 0 0 0 0 0 0\nbr-abcd: 1000 0 0 0 0 0 0 0 1000 0 0 0 0 0 0 0\n";
        assert_eq!(net_bytes_from_proc(proc_net_dev), (150, 260));
        assert!(should_count_network_interface("venet0"));
        assert!(should_count_network_interface("tun0"));
        assert!(!should_count_network_interface("cni0"));
        assert!(!should_count_network_interface("flannel.1"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recognizes_common_gpu_vendors() {
        assert_eq!(gpu_vendor_name("0x1002"), Some("AMD"));
        assert_eq!(gpu_vendor_name("0x10DE"), Some("NVIDIA"));
        assert_eq!(gpu_vendor_name("0x8086"), Some("Intel"));
        assert_eq!(gpu_vendor_name("0xffff"), None);
    }

    #[test]
    fn disk_io_counts_only_leaf_block_devices() {
        let root = std::env::temp_dir().join(format!(
            "nstatus-block-devices-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("vda/slaves")).unwrap();
        std::fs::create_dir_all(root.join("vda1/slaves")).unwrap();
        std::fs::write(root.join("vda1/partition"), "1").unwrap();
        std::fs::create_dir_all(root.join("sda/slaves")).unwrap();
        std::fs::create_dir_all(root.join("dm-0/slaves/sda2")).unwrap();

        assert!(should_count_disk_device_at(&root, "vda"));
        assert!(!should_count_disk_device_at(&root, "vda1"));
        assert!(should_count_disk_device_at(&root, "sda"));
        assert!(!should_count_disk_device_at(&root, "dm-0"));
        assert!(!should_count_disk_device_at(&root, "loop0"));
        assert!(!should_count_disk_device_at(&root, "zram0"));
        let _ = std::fs::remove_dir_all(root);
    }
}
