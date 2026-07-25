#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$ROOT/bin}"
TOOLCHAIN="${RUST_TOOLCHAIN:-stable}"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target/local-release}"

command -v cargo >/dev/null 2>&1 || { echo "cargo is required" >&2; exit 1; }
command -v rustup >/dev/null 2>&1 || { echo "rustup is required" >&2; exit 1; }
command -v zig >/dev/null 2>&1 || { echo "zig is required" >&2; exit 1; }
cargo zigbuild --help >/dev/null 2>&1 || { echo "cargo-zigbuild is required" >&2; exit 1; }

targets=(
  x86_64-unknown-linux-musl
  aarch64-unknown-linux-musl
  armv7-unknown-linux-musleabihf
  arm-unknown-linux-musleabi
  i686-unknown-linux-musl
  x86_64-pc-windows-gnu
)
outputs=(
  nstatus-metrics-linux-amd64
  nstatus-metrics-linux-arm64
  nstatus-metrics-linux-arm
  nstatus-metrics-linux-armv6
  nstatus-metrics-linux-386
  nstatus-metrics-windows-amd64.exe
)

rustup toolchain install "$TOOLCHAIN" --profile minimal >/dev/null
rustup target add --toolchain "$TOOLCHAIN" "${targets[@]}" >/dev/null

staging="$(mktemp -d "${TMPDIR:-/tmp}/nie-sla-agent-release.XXXXXX")"
trap 'rm -rf -- "$staging"' EXIT
cd "$ROOT"

for index in "${!targets[@]}"; do
  target="${targets[$index]}"
  output="${outputs[$index]}"
  echo "==> Building $output ($target)"
  if [[ "$target" == "arm-unknown-linux-musleabi" ]]; then
    CFLAGS_arm_unknown_linux_musleabi=-mcpu=arm1176jzf_s \
    CARGO_TARGET_ARM_UNKNOWN_LINUX_MUSLEABI_RUSTFLAGS='-C target-cpu=arm1176jzf-s -C link-arg=-mcpu=arm1176jzf_s' \
      cargo "+$TOOLCHAIN" zigbuild --locked --release --target "$target" --target-dir "$TARGET_DIR"
  else
    cargo "+$TOOLCHAIN" zigbuild --locked --release --target "$target" --target-dir "$TARGET_DIR"
  fi
  source="$TARGET_DIR/$target/release/nstatus-metrics"
  [[ "$target" == *windows* ]] && source="$source.exe"
  [[ -s "$source" ]] || { echo "missing build output: $source" >&2; exit 1; }
  cp "$source" "$staging/$output"
done

version="$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$ROOT/Cargo.toml" | head -n 1)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "invalid Cargo package version: $version" >&2; exit 1; }
printf 'v%s\n' "$version" > "$staging/VERSION"

(
  cd "$staging"
  : > SHA256SUMS
  for file in "${outputs[@]}"; do
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$file" >> SHA256SUMS
    else
      shasum -a 256 "$file" >> SHA256SUMS
    fi
  done
)

mkdir -p "$OUT_DIR"
for file in "${outputs[@]}" VERSION SHA256SUMS; do
  cp "$staging/$file" "$OUT_DIR/$file"
done

if command -v sha256sum >/dev/null 2>&1; then
  manifest_hash="$(sha256sum "$OUT_DIR/SHA256SUMS" | awk '{print $1}')"
else
  manifest_hash="$(shasum -a 256 "$OUT_DIR/SHA256SUMS" | awk '{print $1}')"
fi

echo "==> Release artifacts ready in $OUT_DIR"
echo "VERSION=v$version"
echo "SHA256SUMS_SHA256=$manifest_hash"
