#!/bin/bash

current_time="$(date +%Y_%m_%d_%H_%M_%S)"
work_dir=".nodequality$current_time"
bench_os_url="https://github.com/LloydAsp/NodeQuality/releases/download/v0.0.2/BenchOs.tar.gz"
raw_file_prefix="https://raw.githubusercontent.com/LloydAsp/NodeQuality/refs/heads/main"

if uname -m | grep -Eq 'arm|aarch64'; then
    bench_os_url="https://github.com/LloydAsp/NodeQuality/releases/download/v0.0.2/BenchOs-arm.tar.gz"
fi

github_mirrors=(
    "https://ghfast.top"
    "https://gh.ddlc.top"
)
accelerator_domestic="https://mirror-eo.i8-mc.cn"
accelerator_overseas="https://mirror-cf.example.com"
accelerator_base="$accelerator_overseas"
accelerator_override="${NQ_ACCELERATOR:-auto}"
bench_os_sha256_x86_64="5f844e73941c3623175c5cdc16b01db34c155d0d1bd9b0cf71f3d72e8b1148e1"
bench_os_sha256_arm="a4dd4e55b129157a02dab437b78e41b5797a7a79a0f0b7febdecab8eb2a312c7"
nexttrace_sha256="cffdcbbb4ed328b9a4e238dde9cb68d4263b3a5769f340d8a55a98fa8e99294c"

header_info_filename=header_info.log
ip_quality_filename=ip_quality.log
ip_quality_json_filename=ip_quality.json
hardware_quality_filename=hardware_quality.log
hardware_quality_json_filename=hardware_quality.json
net_quality_filename=net_quality.log
net_quality_json_filename=net_quality.json
backroute_trace_filename=backroute_trace.log
backroute_trace_json_filename=backroute_trace.json
port_filename=port.log

lang="cn"
opt_ipv=""
opt_lang=""
err_code=0

declare -A LANG
# ===== English =====
LANG[en.err01]="Error: work_dir does not contain 'nodequality'!"
LANG[en.err02]="Error: Unsupported parameters!"
LANG[en.err03]="Error: the specified work_dir does not exist or is not readable/writable!"
LANG[en.cleanup]="Cleaning, please wait a moment."
LANG[en.clean_fail]="An unexpected situation occurred: the BenchOS directory mount was not cleaned up properly. For safety, please reboot and then delete this directory."
LANG[en.ask_hq]="Run HardwareQuality test? (Enter for default 'y', 'f' for fast mode, 'v' for all test details) [y/f/v/n]: "
LANG[en.ask_iq]="Run IPQuality test? (Enter for default 'y') [y/n]: "
LANG[en.ask_nq]="Run NetQuality test? (Enter for default 'y', 'l' for low-data mode) [y/l/n]: "
LANG[en.ask_bt]="Run Backroute Trace test? (Enter for default 'y') [y/n]: "
LANG[en.cleanup_before]="Clean Up before Installation"
LANG[en.loadbench]="Load BenchOs"
LANG[en.basicinfo]="Hardware Info"
LANG[en.run_hq]="Running Hardware Quality Test..."
LANG[en.run_iq]="Running IP Quality Test..."
LANG[en.run_nq]="Running Network Quality Test..."
LANG[en.run_bt]="Running Backroute Trace..."
LANG[en.cleanup_after]="Clean Up after Installation"
# ===== Chinese =====
LANG[cn.err01]="错误：work_dir不包含'nodequality'！"
LANG[cn.err02]="错误：不支持的参数！"
LANG[cn.err03]="错误：指定的 work_dir 不存在，或不可读/不可写！"
LANG[cn.cleanup]="清理中，请稍后。"
LANG[cn.clean_fail]="出现了预料之外的情况，BenchOS目录的挂载未被清理干净，保险起见请重启后删除该目录。"
LANG[cn.ask_hq]="运行 HardwareQuality 测试？（回车默认 'y'，'f' 为快速模式，'v' 为深度模式）[y/f/v/n]："
LANG[cn.ask_iq]="运行 IPQuality 测试？（回车默认 'y'）[y/n]："
LANG[cn.ask_nq]="运行 NetQuality 测试？（回车默认 'y'，'l' 为低流量模式）[y/l/n]："
LANG[cn.ask_bt]="运行 回程路由追踪（Backroute Trace）测试？（回车默认 'y'）[y/n]："
LANG[cn.cleanup_before]="安装前清理"
LANG[cn.loadbench]="加载 BenchOs"
LANG[cn.basicinfo]="硬件信息"
LANG[cn.run_hq]="正在运行硬件质量测试..."
LANG[cn.run_iq]="正在运行 IP 质量测试..."
LANG[cn.run_nq]="正在运行网络质量测试..."
LANG[cn.run_bt]="正在运行回程路由追踪..."
LANG[cn.cleanup_after]="安装后清理"

function L(){
    local key="${lang}.${1}"
    echo "${LANG[$key]:-${LANG[en.$1]}}"
}


function start_ascii() {
    echo -e "\e[1;36m"
    cat <<'EOF'

███╗   ██╗ ██████╗ ██████╗ ███████╗ ██████╗ ██╗   ██╗ █████╗ ██╗     ██╗████████╗██╗   ██╗
████╗  ██║██╔═══██╗██╔══██╗██╔════╝██╔═══██╗██║   ██║██╔══██╗██║     ██║╚══██╔══╝╚██╗ ██╔╝
██╔██╗ ██║██║   ██║██║  ██║█████╗  ██║   ██║██║   ██║███████║██║     ██║   ██║    ╚████╔╝ 
██║╚██╗██║██║   ██║██║  ██║██╔══╝  ██║▄▄ ██║██║   ██║██╔══██║██║     ██║   ██║     ╚██╔╝  
██║ ╚████║╚██████╔╝██████╔╝███████╗╚██████╔╝╚██████╔╝██║  ██║███████╗██║   ██║      ██║   
╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ ╚══════╝ ╚══▀▀═╝  ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝   ╚═╝      ╚═╝   

EOF
    if [[ "$lang" == "en" ]]; then
        cat <<'EOF'
Benchmark script for server, collects basic hardware information, IP quality and network quality

The benchmark will be performed in a temporary system, and all traces will be deleted after that.
Therefore, it has no impact on the original environment and supports almost all linux systems.

Author: Lloyd@nodeseek.com
Github: github.com/LloydAsp/NodeQuality
Command: bash <(curl -sL https://run.NodeQuality.com)
EOF
    else
        cat <<'EOF'
网络服务器的专业测评脚本，检测硬件质量、IP质量和网络质量

脚本测试是纯净的，在临时系统中执行，之后所有的痕迹都会被删除
因此，它不会对原始环境产生任何影响，并且支持几乎所有 Linux 系统

作者：Lloyd@nodeseek.com
仓库：github.com/LloydAsp/NodeQuality
命令：bash <(curl -sL https://run.NodeQuality.com)
EOF
    fi
    echo -e "\033[0m"
}

function _red() {
    echo -e "\033[0;31m$1\033[0m"
}

function _yellow() {
    echo -e "\033[0;33m$1\033[0m"
}

function _blue() {
    echo -e "\033[0;36m$1\033[0m"
}

function _green() {
    echo -e "\033[0;32m$1\033[0m"
}

function _red_bold() {
    echo -e "\033[1;31m$1\033[0m"
}

function _yellow_bold() {
    echo -e "\033[1;33m$1\033[0m"
}

function _blue_bold() {
    echo -e "\033[1;36m$1\033[0m"
}

function _green_bold() {
    echo -e "\033[1;32m$1\033[0m"
}

function get_opts(){
    while getopts "D:d:46Ee" opt; do
        case $opt in
            4)
                if [[ "$opt_ipv" == "-6" ]]; then
                    opt_ipv=""
                else
                    opt_ipv="-4"
                fi
                ;;
            6)
                if [[ "$opt_ipv" == "-4" ]]; then
                    opt_ipv=""
                else
                    opt_ipv="-6"
                fi
                ;;
            D|d)
                local opt_dir="${OPTARG%/}"
                if [[ ! -d "$opt_dir" || ! -r "$opt_dir" || ! -w "$opt_dir" ]]; then
                    echo "$(L err03)"
                    exit 1
                else
                    work_dir="${opt_dir}/${work_dir}"
                fi
                ;;
            E|e)
                lang="en"
                opt_lang="-E"
                ;;
            \?) 
                echo "$(L err02)"
                ;;
        esac
    done
}

function pre_init(){
    mkdir -p "$work_dir"
    cd $work_dir
    work_dir="$(pwd)"
}

function pre_cleanup(){
    # incase interupted last time
    clear_mount
    if [[ "$work_dir" == *"nodequality"* ]]; then
        rm -rf "${work_dir}"/*
    else
        echo "$(L err01)"
        exit 1
    fi
}

function clear_mount(){
    swapoff $work_dir/swap 2>/dev/null

    umount $work_dir/BenchOs/proc/ 2> /dev/null
    umount $work_dir/BenchOs/sys/ 2> /dev/null
    umount -R $work_dir/BenchOs/dev/ 2> /dev/null
}

function file_sha256(){
    local file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file" | awk '{print $1}'
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$file" | awk '{print $NF}'
    else
        echo ""
    fi
}

function fetch_raw(){
    local path="$1"
    curl -fsSL --max-time 30 "$accelerator_base/p/raw.githubusercontent.com/LloydAsp/NodeQuality/refs/heads/main/$path" 2>/dev/null \
        || curl -fsSL --max-time 60 "https://raw.githubusercontent.com/LloydAsp/NodeQuality/refs/heads/main/$path"
}

function fetch_script(){
    local direct="$1"
    local host
    host="$(printf '%s' "$direct" | sed -E 's#^https://([^/]+).*#\1#' | tr 'A-Z' 'a-z')"
    curl -fsSL --max-time 30 "$accelerator_base/p/$host" 2>/dev/null || curl -fsSL --max-time 60 "$direct"
}

function detect_accelerator_base(){
    if [[ "$accelerator_override" == "eo" ]]; then
        accelerator_base="$accelerator_domestic"
        echo "NIE Proxy accelerator: $accelerator_base (forced=eo)"
        return
    fi
    if [[ "$accelerator_override" == "cf" ]]; then
        accelerator_base="$accelerator_overseas"
        echo "NIE Proxy accelerator: $accelerator_base (forced=cf)"
        return
    fi
    local country=""
    country="$(curl -fsS --max-time 8 https://api-ipv4.ip.sb/geoip 2>/dev/null | sed -n 's/.*"country_code":"\([A-Z][A-Z]\)".*/\1/p')"
    if [[ -z "$country" ]]; then
        country="$(curl -fsS --max-time 8 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | awk -F= '$1=="loc"{print $2}')"
    fi
    if [[ -z "$country" ]] && curl -fsS --max-time 8 https://myip.ipip.net/json 2>/dev/null | grep -q '中国'; then
        country="CN"
    fi
    if [[ "$country" == "CN" ]]; then
        accelerator_base="$accelerator_domestic"
    elif [[ -z "$country" ]]; then
        local eo_ms cf_ms
        eo_ms="$(curl -sS -o /dev/null --max-time 6 -w '%{time_total}' "$accelerator_domestic/health" 2>/dev/null || true)"
        cf_ms="$(curl -sS -o /dev/null --max-time 6 -w '%{time_total}' "$accelerator_overseas/health" 2>/dev/null || true)"
        if [[ -n "$eo_ms" && -n "$cf_ms" ]]; then
            if awk -v a="$eo_ms" -v b="$cf_ms" 'BEGIN{exit !(a < b)}'; then
                accelerator_base="$accelerator_domestic"
            fi
        elif [[ -n "$eo_ms" ]]; then
            accelerator_base="$accelerator_domestic"
        fi
    else
        accelerator_base="$accelerator_overseas"
    fi
    echo "NIE Proxy accelerator: $accelerator_base (country=${country:-latency})"
}

function download_with_mirrors(){
    local url="$1"
    local output="$2"
    local expected_sha256="$3"
    local candidates=("$url")
    if [[ "$url" == https://github.com/* ]]; then
        candidates=("$accelerator_base/p/github.com${url#https://github.com}" "$url")
        for mirror in "${github_mirrors[@]}"; do
            candidates+=("$mirror/$url")
        done
    fi
    local candidate
    for candidate in "${candidates[@]}"; do
        echo "Downloading from $candidate"
        rm -f "$output"
        if curl -fL --retry 2 --retry-delay 2 --connect-timeout 15 --speed-limit 32768 --speed-time 30 -o "$output" "$candidate"; then
            local actual
            actual="$(file_sha256 "$output")"
            if [[ -n "$expected_sha256" ]]; then
                if [[ "$actual" == "$expected_sha256" ]]; then
                    return 0
                fi
                echo "SHA-256 mismatch, trying next mirror"
                rm -f "$output"
            else
                return 0
            fi
        else
            echo "Download failed, trying next mirror"
            rm -f "$output"
        fi
    done
    return 1
}

function chroot_download_with_mirrors(){
    local dst="$1"
    local url="$2"
    local expected_sha256="$3"
    local candidates=("$url")
    if [[ "$url" == https://github.com/* ]]; then
        candidates=("$accelerator_base/p/github.com${url#https://github.com}" "$url")
        for mirror in "${github_mirrors[@]}"; do
            candidates+=("$mirror/$url")
        done
    fi
    local candidate
    for candidate in "${candidates[@]}"; do
        echo "Downloading nexttrace from $candidate"
        chroot "$work_dir/BenchOs" /bin/bash -c "if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 --connect-timeout 15 --speed-limit 32768 --speed-time 20 -o '$dst' '$candidate'; elif command -v wget >/dev/null 2>&1; then wget --timeout=30 --tries=2 -qO '$dst' '$candidate'; else exit 127; fi"
        if [[ -s "$work_dir/BenchOs$dst" ]]; then
            local actual
            actual="$(file_sha256 "$work_dir/BenchOs$dst")"
            if [[ -n "$expected_sha256" ]]; then
                if [[ "$actual" == "$expected_sha256" ]]; then
                    chroot "$work_dir/BenchOs" /bin/bash -c "chmod u+x '$dst'"
                    return 0
                fi
                echo "nexttrace SHA-256 mismatch, trying next mirror"
                chroot "$work_dir/BenchOs" /bin/bash -c "rm -f '$dst'"
            else
                chroot "$work_dir/BenchOs" /bin/bash -c "chmod u+x '$dst'"
                return 0
            fi
        fi
    done
    return 1
}

function load_bench_os(){
    cd $work_dir
    rm -rf BenchOs

    local expected_sha256="$bench_os_sha256_x86_64"
    if uname -m | grep -Eq 'arm|aarch64'; then
        expected_sha256="$bench_os_sha256_arm"
    fi
    if ! download_with_mirrors "$bench_os_url" BenchOs.tar.gz "$expected_sha256"; then
        echo "Failed to download BenchOs from all mirrors"
        exit 1
    fi
    tar -xzf BenchOs.tar.gz
    cd $work_dir/BenchOs

    mount -t proc /proc proc/
    mount --bind /sys sys/
    mount --rbind /dev dev/
    mount --make-rslave dev

    rm etc/resolv.conf 2>/dev/null
    cp /etc/resolv.conf etc/resolv.conf
}

function chroot_run(){
    chroot $work_dir/BenchOs /bin/bash -c "$*"
}

function load_part(){
    # gb5-test.sh, swap part
    . <(fetch_raw "part/swap.sh")
}

function load_3rd_program(){
    if ! chroot_download_with_mirrors "/usr/local/bin/nexttrace" "https://github.com/nxtrace/NTrace-core/releases/download/v1.3.7/nexttrace_linux_amd64" "$nexttrace_sha256"; then
        echo "Failed to download nexttrace from all mirrors"
        exit 1
    fi
}

function run_header(){
    chroot_run bash <(fetch_raw "part/header.sh")
}

function detect_virt() {
    if [[ -f /run/systemd/container ]]; then
        cat /run/systemd/container
        return
    fi
    if [[ -f /.dockerenv ]]; then
        echo docker
        return
    fi
    if [[ -f /run/.containerenv ]]; then
        echo podman
        return
    fi
    if grep -qa 'lxc' /proc/1/cgroup 2>/dev/null; then
        echo lxc
        return
    fi
    if grep -qa 'hypervisor' /proc/cpuinfo 2>/dev/null; then
        echo kvm
        return
    fi
    echo none
}

############ 以下内容为HQ预处理部分 ############
function detect_testdev_type(){
    local dev="$1"
    dev="$(readlink -f "$dev" 2>/dev/null)"
    if [[ "$dev" == /dev/md* ]]; then
        local lvl
        lvl=$(
            awk -v md="$(basename "$dev")" '
                $1 == md {
                    for (i=1;i<=NF;i++)
                        if ($i ~ /^raid[0-9]+$/) {
                            print toupper($i)
                            exit
                        }
                }
            ' /proc/mdstat
        )
        [[ -n "$lvl" ]] && echo "$lvl" || echo "RAID"
        return
    fi
    if [[ "$dev" == /dev/mapper/* || "$dev" == /dev/dm-* ]]; then
        echo "LVM"
        return
    fi
    if lsblk -no TYPE "$dev" 2>/dev/null | grep -qE 'disk|part'; then
        echo "DISK"
        return
    fi
    echo ""
}

function get_testdev_members_from_diskinfo(){
    local dev="$1"
    local i
    for ((i=1; i<=diskinfo[raid_count]; i++)); do
        if [[ "${diskinfo[raid$i.name]}" == "$dev" ]]; then
            echo "${diskinfo[raid$i.devs]}"
            return
        fi
    done
}

function get_testdev_mount_from_diskinfo(){
    local dev="$1"
    local i
    for ((i=1; i<=diskinfo[raid_count]; i++)); do
        if [[ "${diskinfo[raid$i.name]}" == "$dev" ]]; then
            echo "${diskinfo[raid$i.mount]}"
            return
        fi
    done
}

function get_md_mount(){
    local md="$1"
    local mp=""
    mp="$(findmnt -n -o TARGET "/dev/$md" 2>/dev/null)"
    [[ -n "$mp" ]] && { echo "$mp"; return; }
    mp="$(
        lsblk -o NAME,PKNAME,TYPE,MOUNTPOINT -r 2>/dev/null \
        | awk -v md="$md" '$2==md && $4!="" {print $4}' \
        | sort -u | paste -sd "," -
    )"
    [[ -n "$mp" ]] && echo "$mp"
}

function pre_fetch_info(){
    local virt_type="$(detect_virt)"
    declare -gA osinfo
    osinfo[proc]=$(ps -e 2>/dev/null | wc -l | tr -d ' ')
    if command -v loginctl >/dev/null 2>&1; then
        tmpuc="$(loginctl list-users 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')"
        [[ "$tmpuc" -gt 0 ]] && osinfo[user]="$tmpuc"
    elif [[ "$(uname -s)" == "Darwin" ]]; then
        tmpuc="$(stat -f '%Su' /dev/console 2>/dev/null | wc -l | tr -d ' ')"
        [[ "$tmpuc" -gt 0 ]] && osinfo[user]="$tmpuc"
    else
        tmpuc="$(who 2>/dev/null | wc -l | tr -d ' ')"
        [[ "$tmpuc" -gt 0 ]] && osinfo[user]="$tmpuc"
    fi
    if [[ "${virt_type}" =~ ^(docker|podman|lxc|container)$ ]] && [[ "$(ps -p 1 -o comm= 2>/dev/null)" != "systemd" ]]; then
        osinfo[svcr]=""
        osinfo[svct]=""
    elif command -v systemctl >/dev/null 2>&1; then
        osinfo[svcr]=$(systemctl list-units --type=service --state=running 2>/dev/null | grep '\.service' | wc -l | tr -d ' ')
        osinfo[svct]=$(systemctl list-unit-files --type=service 2>/dev/null | grep '\.service' | wc -l | tr -d ' ')
    elif command -v rc-service >/dev/null 2>&1; then
        osinfo[svcr]=$(rc-service -r 2>/dev/null | wc -l | tr -d ' ')
        osinfo[svct]=$(rc-service -l 2>/dev/null | wc -l | tr -d ' ')
    elif [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
        osinfo[svcr]=$(launchctl list 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')
        osinfo[svct]="${osinfo[svcr]}"
    fi
    declare -gA meminfo
    case "${virt_type}" in
        kvm)
            if lsmod 2>/dev/null | grep -q '^virtio_balloon'; then
                meminfo[balloon]=1
            else
                meminfo[balloon]=0
            fi
            if [[ -r /sys/kernel/mm/ksm/run ]] && [[ "$(cat /sys/kernel/mm/ksm/run)" == "1" ]]; then
                meminfo[ksm]=1
            else
                meminfo[ksm]=0
            fi
            ;;
        lxc)
            meminfo[neighbor]=$(ls /sys/devices/virtual/block 2>/dev/null | grep -c '^dm')
            ;;
    esac
    declare -gA diskinfo
    local ridx=0
    if [[ -r /proc/mdstat ]]; then
        while read -r line; do
            if [[ "$line" =~ ^(md[0-9]+)[[:space:]]*:[[:space:]]*active[[:space:]]+([a-z0-9]+)[[:space:]]+(.*)$ ]]; then
                ((ridx++))
                local rname="${BASH_REMATCH[1]}"
                local rlevel="${BASH_REMATCH[2]}"
                local rdevs="${BASH_REMATCH[3]}"
                rlevel="${rlevel^^}"
                rdevs="$(awk '{for(i=1;i<=NF;i++) if ($i ~ /\[[0-9]+\]/) printf "%s ", $i}' <<<"$rdevs")"
                rdevs="${rdevs% }"
                diskinfo["raid$ridx.name"]="$rname"
                diskinfo["raid$ridx.level"]="$rlevel"
                diskinfo["raid$ridx.devs"]="$rdevs"
                diskinfo["raid$ridx.mount"]="$(get_md_mount "$rname")"
            fi
        done < /proc/mdstat
    fi
    diskinfo[raid_count]="$ridx"
    diskinfo[testdir]="${work_dir%/*}"
    diskinfo[testdev]=$(df --output=source "$work_dir" | awk 'NR==2')
    diskinfo[testdev_type]=$(detect_testdev_type "${diskinfo[testdev]}")
    diskinfo[testdev]="${diskinfo[testdev]#/dev/}"
    if [[ "${diskinfo[testdev_type]}" == RAID* ]]; then
        diskinfo[testdev_members]=$(get_testdev_members_from_diskinfo "${diskinfo[testdev]}")
        diskinfo[testdev_mount]=$(get_testdev_mount_from_diskinfo "${diskinfo[testdev]}")
    fi
}
############ 以上内容为HQ预处理部分 ############

function run_HardwareQuality(){
    local params=""
    [[ "$run_hardware_quality_test" =~ ^[Ff]$ ]] && params=" -F"
    [[ "$run_hardware_quality_test" =~ ^[Vv]$ ]] && params=" -V"
    pre_fetch_info # HQ预处理
    payload=$(declare -p osinfo meminfo diskinfo) # HQ预处理
    fetch_script https://Hardware.Check.Place | chroot_run "env NQENV=$(printf '%q' "$payload") bash -s -- $opt_lang $params -y -o /result/$hardware_quality_json_filename" # HQ预处理
    # 原始语句为：chroot_run bash <(curl -Ls https://Hardware.Check.Place) $opt_lang -y -o /result/$hardware_quality_json_filename
}


function run_ip_quality(){
    chroot_run bash <(fetch_script https://IP.Check.Place) $opt_ipv $opt_lang -y -o /result/$ip_quality_json_filename
}

function run_net_quality(){
    local params=""
    [[ "$run_net_quality_test" =~ ^[Ll]$ ]] && params=" -L"
    chroot_run bash <(fetch_script https://Net.Check.Place) $opt_ipv $opt_lang $params -y -o /result/$net_quality_json_filename
}

function run_net_trace(){
    chroot_run bash <(fetch_script https://Net.Check.Place) $opt_ipv $opt_lang -R -n -S 123 -o /result/$backroute_trace_json_filename
}

uploadAPI="https://api.nodequality.com/api/v1/record"
function upload_result(){

    chroot_run zip -j - "/result/*" > $work_dir/result.zip

    base64 $work_dir/result.zip | curl -X POST  --data-binary @- $uploadAPI

    echo
}

function post_cleanup(){
    chroot_run umount -R /dev &> /dev/null
    clear_mount

    post_check_mount

    rm -rf $work_dir/BenchOs

    if [[ "$work_dir" == *"nodequality"* ]]; then
        rm -rf "${work_dir}"/
    else
        echo "$(L err01)"
        exit 1
    fi

    exit 1
}

function sig_cleanup(){
    trap '' INT TERM SIGHUP EXIT
    _green_bold "$(L cleanup)"
    post_cleanup
}

function post_check_mount(){
    if mount | grep nodequality$current_time ; then
        echo "$(L clean_fail)" | tee $work_dir/error.log >&2
        exit
    fi
}


function ask_question(){
    local yellow='\033[1;33m'  # Set yellow color
    local reset='\033[0m'      # Reset to default color

    echo -en "${yellow}$(L ask_hq)${reset}"
    read run_hardware_quality_test
    run_hardware_quality_test=${run_hardware_quality_test:-y}

    echo -en "${yellow}$(L ask_iq)${reset}"
    read run_ip_quality_test
    run_ip_quality_test=${run_ip_quality_test:-y}

    echo -en "${yellow}$(L ask_nq)${reset}"
    read run_net_quality_test
    run_net_quality_test=${run_net_quality_test:-y}

    echo -en "${yellow}$(L ask_bt)${reset}"
    read run_net_trace_test
    run_net_trace_test=${run_net_trace_test:-y}
}

function main(){
    trap 'sig_cleanup' INT TERM SIGHUP EXIT

    start_ascii
    detect_accelerator_base

    ask_question

    _green_bold "$(L cleanup_before)"
    pre_init
    pre_cleanup
    _green_bold "$(L loadbench)"
    load_bench_os

    load_part
    load_3rd_program

    _green_bold "$(L basicinfo)"

    result_directory=$work_dir/BenchOs/result
    mkdir -p $result_directory
    run_header > $result_directory/$header_info_filename

    if [[ "$run_hardware_quality_test" =~ ^[YyFfVv]$ ]]; then
        _green_bold "$(L run_hq)"
        run_HardwareQuality | tee $result_directory/$hardware_quality_filename
    fi

    if [[ "$run_ip_quality_test" =~ ^[Yy]$ ]]; then
        _green_bold "$(L run_iq)"
        run_ip_quality | tee $result_directory/$ip_quality_filename
    fi

    if [[ "$run_net_quality_test" =~ ^[YyLl]$ ]]; then
        _green_bold "$(L run_nq)"
        run_net_quality | tee $result_directory/$net_quality_filename
    fi

    if [[ "$run_net_trace_test" =~ ^[Yy]$ ]]; then
        _green_bold "$(L run_bt)"
        run_net_trace | tee $result_directory/$backroute_trace_filename
    fi

    upload_result
    _green_bold "$(L cleanup_after)"
    post_cleanup
}

get_opts "$@"
main
