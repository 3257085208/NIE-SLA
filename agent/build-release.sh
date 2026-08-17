#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$ROOT/bin}"
TOOLCHAIN="${RUST_TOOLCHAIN:-stable}"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target/local-release}"

command -v cargo >/dev/null 2>&1 || { echo "cargo is required" >&2; exit 1; }
command -v rustup >/dev/null 2>&1 || { echo "rustup is required" >&2; exit 1; }
command -v zig >/dev/null 2>&1 || { echo "zig is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
cargo zigbuild --help >/dev/null 2>&1 || { echo "cargo-zigbuild is required" >&2; exit 1; }

targets=(
  x86_64-unknown-linux-musl
  aarch64-unknown-linux-musl
  armv7-unknown-linux-musleabihf
  arm-unknown-linux-musleabi
  i686-unknown-linux-musl
)
outputs=(
  nie-sla-agent-linux-amd64
  nie-sla-agent-linux-arm64
  nie-sla-agent-linux-arm
  nie-sla-agent-linux-armv6
  nie-sla-agent-linux-386
)
jq_assets=(
  jq-linux-amd64
  jq-linux-arm64
  jq-linux-i386
  jq-linux-armhf
  jq-linux-armel
)
jq_hashes=(
  020468de7539ce70ef1bceaf7cde2e8c4f2ca6c3afb84642aabc5c97d9fc2a0d
  6bc62f25981328edd3cfcfe6fe51b073f2d7e7710d7ef7fcdac28d4e384fc3d4
  ee8489cb8acfddf2e6d2ab4308877b5cbb6ec6b55beedb7c6d5a4fafb2879c86
  ac304e50cf7cd24933d83dc7d0e4f79892a71a92fb02336d4ecaffa8933760bd
  b98e283ff26cd7478f6fb18cc081ca0e0cb2e9980300f0bfc8bb26854d347eb2
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
  source="$TARGET_DIR/$target/release/nie-sla-agent"
  [[ -s "$source" ]] || { echo "missing build output: $source" >&2; exit 1; }
  cp "$source" "$staging/$output"
done

legacy_outputs=()
for arch in amd64 arm64 arm armv6 386; do
  legacy="nstatus-metrics-linux-$arch"
  cp "$staging/nie-sla-agent-linux-$arch" "$staging/$legacy"
  legacy_outputs+=("$legacy")
done

for index in "${!jq_assets[@]}"; do
  asset="${jq_assets[$index]}"
  expected="${jq_hashes[$index]}"
  echo "==> Fetching pinned $asset"
  curl -fsSL --retry 3 --retry-all-errors \
    "https://github.com/jqlang/jq/releases/download/jq-1.8.1/$asset" \
    -o "$staging/$asset"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$staging/$asset" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$staging/$asset" | awk '{print $1}')"
  fi
  [[ "$actual" == "$expected" ]] || { echo "jq checksum mismatch: $asset" >&2; exit 1; }
  chmod 755 "$staging/$asset"
done

release_files=("${outputs[@]}" "${legacy_outputs[@]}" "${jq_assets[@]}")

version="$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$ROOT/Cargo.toml" | head -n 1)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "invalid Cargo package version: $version" >&2; exit 1; }
printf 'v%s\n' "$version" > "$staging/VERSION"

(
  cd "$staging"
  : > SHA256SUMS
  for file in "${release_files[@]}"; do
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$file" >> SHA256SUMS
    else
      shasum -a 256 "$file" >> SHA256SUMS
    fi
  done
)

mkdir -p "$OUT_DIR"
for file in "${release_files[@]}" VERSION SHA256SUMS; do
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
