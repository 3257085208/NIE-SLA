#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

command -v node >/dev/null 2>&1 || { echo "需要 Node.js 22 或更高版本" >&2; exit 1; }
command -v npx >/dev/null 2>&1 || { echo "需要 npm/npx" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "需要 npm 以验证生产 Frontend" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "需要 tar 以从固定 Git commit 生成前端资产" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "需要 git 以校验发布来源" >&2; exit 1; }

if [[ ! "${NIE_SLA_FRONTEND_REF:-}" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "正式部署必须设置 NIE_SLA_FRONTEND_REF 为已审阅的 40 位 Frontend commit SHA" >&2
  exit 1
fi

FRONTEND_ROOT="${NIE_SLA_FRONTEND_ROOT:-$ROOT/../../frontend}"
FRONTEND_HEAD="$(git -C "$FRONTEND_ROOT" rev-parse --verify HEAD^{commit} 2>/dev/null || true)"
FRONTEND_REF_COMMIT="$(git -C "$FRONTEND_ROOT" rev-parse --verify "${NIE_SLA_FRONTEND_REF}^{commit}" 2>/dev/null || true)"
if [[ -z "$FRONTEND_HEAD" || -z "$FRONTEND_REF_COMMIT" || "$FRONTEND_HEAD" != "$FRONTEND_REF_COMMIT" ]]; then
  echo "NIE_SLA_FRONTEND_REF 必须与当前已审阅的 Frontend HEAD 完全一致；测试门禁不能覆盖另一个 commit" >&2
  exit 1
fi

echo "运行本地发布门禁..."
bash "$ROOT/../test.sh"
export NIE_SLA_FRONTEND_REF

node scripts/prepare-assets.mjs
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';

const provenance = JSON.parse(await readFile('dist-one-click/build-provenance.json', 'utf8'));
if (provenance.schema !== 'nie-sla-build-provenance-v1') throw new Error('build provenance schema mismatch');
if (provenance.asset_source !== 'git-archive') throw new Error('build provenance is not Git archive based');
if (!/^[0-9a-f]{40}$/u.test(provenance.agent_commit) || !/^[0-9a-f]{40}$/u.test(provenance.frontend_commit)) {
  throw new Error('build provenance commit is not immutable');
}
if (provenance.agent_commit !== provenance.worker_commit) throw new Error('Agent/Worker provenance mismatch');
if (provenance.frontend_ref !== process.env.NIE_SLA_FRONTEND_REF) throw new Error('Frontend ref provenance mismatch');
if (!provenance.agent_release) throw new Error('Agent release tag is missing');
console.log(`provenance verified: Agent ${provenance.agent_commit.slice(0, 12)}, Frontend ${provenance.frontend_commit.slice(0, 12)}`);
NODE

DRY_RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nie-sla-wrangler-dry-run.XXXXXX")"
trap 'rm -rf -- "$DRY_RUN_DIR"' EXIT
node scripts/verify-assets.mjs
npx wrangler deploy --dry-run --outdir "$DRY_RUN_DIR"
npx wrangler deploy

echo "NIE-SLA Worker、静态前端、D1 与 R2 已作为同一应用发布。"
