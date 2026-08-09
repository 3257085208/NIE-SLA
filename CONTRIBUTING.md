# 开发指南

NIE-SLA 由三个生产源组成：本仓库（Worker 与 Rust Agent）、`frontend/` 仓库（生产前端）与公开仓库（脱敏展示）。本文件说明在本仓库内的开发、测试与发布流程。

## 仓库结构

- `worker/`：Worker 后端，ES 模块源码在 `worker/src/`。
- `agent/`：Rust Agent、安装器、`cftz` 与本地发布脚本。
- `frontend/`：旧 Pages 前端副本，只读，禁止部署。
- `docs/`：文档，`docs/zh-CN/` 与 `docs/en/`。
- `scripts/`：脱敏导出工具。
- `test.sh`：测试入口。

## 本地开发

Worker：

```bash
cd worker
node --check src/routes.js
node --test tests/*.test.mjs
```

Rust Agent：

```bash
cd agent
cargo fmt -- --check
cargo check --locked
cargo test --locked
```

生产前端源码在 `../frontend`，测试方式见该仓库 README。

## 测试

```bash
bash test.sh
```

测试覆盖 Worker 语法与打包、鉴权、任务白名单、GeoIP、备份恢复、前端模块、Rust fmt/check/test、安装器与 shell 语法。修改 Worker、前端或 Agent 后，发布前必须完整跑一遍。

## Agent 发布

```bash
cd agent
./build-release.sh
```

脚本构建 amd64、arm64、armv7、armv6、386 五个目标，并生成同一批 `VERSION` 与 `SHA256SUMS`。发布流程：

1. 提升 `agent/Cargo.toml` 版本。
2. 本地构建，逐个验证二进制 `--version`。
3. 计算 `SHA256SUMS` 自身的 SHA-256。
4. 更新 Linux 安装器中的默认哈希与版本。
5. 把整批产物同步到生产前端 `bin/`。
6. 跑完整测试。
7. 创建 GitHub Release（Tag `vX.Y.Z`），附加五架构二进制、`VERSION` 与 `SHA256SUMS`。

当前 GitHub Actions 额度不可用，Agent Release 必须在可信本地环境完成。

## Worker 发布

```bash
cd worker
./deploy.sh
```

脚本从生产前端生成 `dist-one-click`，再部署 Worker。发布前检查产物不包含 `AGENTS.md`、测试、Pages Functions、`node_modules` 或开发锁文件。

## 公开脱敏

```bash
node scripts/export-public.mjs          # dry-run，只检查
node scripts/export-public.mjs --apply  # 写入公开仓库
```

导出工具会扫描生产域名、Token、私钥与本机路径。公开仓库只能由该脚本单向生成，禁止手工覆盖。

## 约定

- JS：ES modules，无分号，两空格缩进。
- Rust：`cargo fmt`，少依赖，Agent 不开放入站监听。
- Shell：管理脚本 `set -euo pipefail`；`install.sh` 使用 POSIX sh。
- 版本：应用、Worker 与 Agent 共用 `X.Y.Z`；应用源码 Tag 为 `app-vX.Y.Z`，Agent Release 为 `vX.Y.Z`，两者数字必须一致。
- 禁止从 `_archive/` 或公开仓库复制文件覆盖生产源。
