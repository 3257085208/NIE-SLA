#!/usr/bin/env bash
# NStatus Agent 一键更新脚本
set -euo pipefail

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'
DEFAULT_SHA256SUMS_SHA256=""

ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
info() { echo -e "  ${CYAN}→${NC} $*"; }
err()  { echo -e "  ${RED}✗${NC} $*" >&2; }
title(){ echo -e "\n${BOLD}$*${NC}"; }

download_to() {
    local url="$1" out="$2"
    if command -v curl >/dev/null 2>&1; then curl -fsSL "$url" -o "$out"
    elif command -v wget >/dev/null 2>&1; then wget -q "$url" -O "$out"
    else err "需要 curl 或 wget"; exit 1; fi
}

sha256_file() {
    local file="$1"
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$file" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$file" | awk '{print $1}'
    elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$file" | awk '{print $NF}'
    else err "需要 sha256sum、shasum 或 openssl 用于校验"; exit 1; fi
}

verify_binary_checksum() {
    local file="$1" name="$2" sums="$3" expected="${NSTATUS_EXPECTED_SHA256:-}"
    if [[ -z "$expected" ]]; then
        download_to "$CHECKSUM_URL" "$sums"
        local sums_expected="${NSTATUS_SHA256SUMS_SHA256:-$DEFAULT_SHA256SUMS_SHA256}" sums_actual
        sums_actual="$(sha256_file "$sums")"
        if [[ -n "$sums_expected" && "${sums_actual,,}" != "${sums_expected,,}" ]]; then
            err "校验清单验证失败"
            err "期望: $sums_expected"
            err "实际: $sums_actual"
            exit 1
        fi
        expected="$(awk -v name="${name}" '$2 == name || $2 == "bin/" name { print $1; exit }' "$sums")"
    fi
    if [[ -z "$expected" ]]; then err "未找到 ${name} 的校验值"; exit 1; fi
    local actual
    actual="$(sha256_file "$file")"
    if [[ "${actual,,}" != "${expected,,}" ]]; then
        err "${name} 校验失败"
        err "期望: $expected"
        err "实际: $actual"
        exit 1
    fi
    ok "SHA256 校验通过"
}

# 检查权限
if [[ $EUID -ne 0 ]]; then
   err "需要 root 权限，请使用 sudo"
   exit 1
fi

title "NStatus Agent 更新"

# 检测架构
case "$(uname -m)" in
    x86_64|amd64) ARCH="amd64" ;;
    i386|i486|i586|i686) ARCH="386" ;;
    aarch64|arm64) ARCH="arm64" ;;
    armv5*) ARCH="armv5" ;;
    armv6*) ARCH="armv6" ;;
    armv7l|armv7*|armhf) ARCH="arm" ;;
    *) err "unsupported architecture: $(uname -m)"; exit 1 ;;
esac

DOWNLOAD_BASE="${DOWNLOAD_BASE:-https://status.example.com}"
DOWNLOAD_URL="${DOWNLOAD_URL:-${DOWNLOAD_BASE%/}/bin/nstatus-metrics-linux-${ARCH}}"
CHECKSUM_URL="${CHECKSUM_URL:-${DOWNLOAD_BASE%/}/bin/SHA256SUMS}"
BINARY_NAME="nstatus-metrics-linux-${ARCH}"
BINARY_PATH="${NSTATUS_BINARY_PATH:-/opt/nstatus-metrics/nstatus-metrics}"
if [[ ! -f "$BINARY_PATH" && -f "/usr/local/bin/nstatus-metrics" && ! -L "/usr/local/bin/nstatus-metrics" ]]; then
    BINARY_PATH="/usr/local/bin/nstatus-metrics"
fi
BACKUP_PATH="${BINARY_PATH}.bak"

# 检查当前版本
if [[ -f "$BINARY_PATH" ]]; then
    CURRENT_VERSION=$("$BINARY_PATH" --version 2>&1 || echo "unknown")
    info "当前版本: $CURRENT_VERSION"
else
    info "未检测到已安装的 Agent"
fi

# 备份当前版本
if [[ -f "$BINARY_PATH" ]]; then
    cp "$BINARY_PATH" "$BACKUP_PATH"
    ok "已备份当前版本"
fi

# 下载新版本
info "正在下载最新版本..."
mkdir -p "$(dirname "$BINARY_PATH")"
SUMS_TMP="$(mktemp)"
trap 'rm -f "${BINARY_PATH}.tmp" "$SUMS_TMP"' EXIT INT TERM
if download_to "$DOWNLOAD_URL" "${BINARY_PATH}.tmp"; then
    verify_binary_checksum "${BINARY_PATH}.tmp" "$BINARY_NAME" "$SUMS_TMP"
    chmod +x "${BINARY_PATH}.tmp"
    mv "${BINARY_PATH}.tmp" "$BINARY_PATH"
    ln -sf "$BINARY_PATH" /usr/local/bin/nstatus-metrics 2>/dev/null || true
    chown nstatus:nstatus "$BINARY_PATH" 2>/dev/null || chown nstatus "$BINARY_PATH" 2>/dev/null || true
    ok "下载完成"
else
    err "下载失败"
    if [[ -f "$BACKUP_PATH" ]]; then
        mv "$BACKUP_PATH" "$BINARY_PATH"
        ok "已恢复备份"
    fi
    exit 1
fi

# 重启服务
info "重启服务..."
if command -v systemctl &>/dev/null; then
    systemctl restart nstatus-metrics
    ok "服务已重启"
elif command -v rc-service &>/dev/null; then
    rc-service nstatus-metrics restart
    ok "服务已重启"
fi

# 检查新版本
sleep 2
NEW_VERSION=$("$BINARY_PATH" --version 2>&1 || echo "unknown")
ok "新版本: $NEW_VERSION"

# 清理备份
rm -f "$BACKUP_PATH"

title "更新完成！"
echo ""
info "查看服务状态:"
if command -v systemctl &>/dev/null; then
    systemctl status nstatus-metrics --no-pager || true
else
    rc-service nstatus-metrics status || true
fi

echo ""
echo -e "${GREEN}${BOLD}✅ Agent 已更新并运行${NC}"
echo ""
