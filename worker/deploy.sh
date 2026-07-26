#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

command -v node >/dev/null 2>&1 || { echo "需要 Node.js 22 或更高版本" >&2; exit 1; }
command -v npx >/dev/null 2>&1 || { echo "需要 npm/npx" >&2; exit 1; }

node scripts/prepare-assets.mjs
npx wrangler deploy

echo "NIE-SLA Worker、静态前端、D1 与 R2 已作为同一应用发布。"
