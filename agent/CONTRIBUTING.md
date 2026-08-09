# Agent 开发与发布

本目录是 NIE-SLA 的 Rust Agent：采集器、安装器、`cftz` 管理命令、任务运行器与发布脚本。完整系统文档见仓库根 `README.zh-CN.md`。

## 源码布局

- `src/main.rs`：入口、采样与上报循环、更新流程。
- `src/tasks.rs`：固定 Beta 动作（NodeQuality、IPv4 解锁）的运行器。
- `src/manager.rs`：root Manager，负责动作执行、服务布局与更新。
- `src/updater.rs`：校验链更新。
- `cftz`：节点管理命令（status/log/update/set/admin/totp-setup/uninstall）。
- `install.sh` / `setup.sh`：安装入口与后端，分别校验下级哈希。
- `build-release.sh`：本地五架构发布构建。
- `DEPRECATED_PYTHON.md`：旧 Python 外部 Agent 说明。

## 本地验证

```bash
cargo fmt -- --check
cargo check --locked
cargo test --locked
```

`bash ../test.sh` 会连同 Worker、前端、安装器一起跑完整测试。

## 发布

```bash
./build-release.sh
```

1. 先提升 `Cargo.toml` 版本。
2. 构建五个目标并逐个验证 `--version`。
3. 计算 `SHA256SUMS` 自身哈希，更新安装器默认值。
4. 把 `bin/` 整批产物同步到生产前端 `bin/`。
5. 跑完整测试。
6. 创建 Release（Tag `vX.Y.Z`），附二进制、`VERSION` 与 `SHA256SUMS`。

## 约束

- Agent 不开放入站监听，只主动访问 Worker HTTPS。
- 固定动作只接受编译进二进制的枚举；禁止把任意命令、URL、参数、stdin 或计划任务接入任务系统。
- 遥测服务低权限运行；root 能力只属于 Manager 的两个固定动作。
- 更新必须先验证版本、manifest 与二进制哈希，失败保留旧版本。
- 发布产物必须与 `VERSION`、`SHA256SUMS` 同批生成。
