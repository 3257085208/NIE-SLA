# 11 开发、测试与发布

## 仓库结构

```text
agent/src/main.rs       Agent 主循环与采集
agent/src/platform.rs   平台信息和路径
agent/src/queue.rs      有界持久队列
agent/src/updater.rs    更新策略、下载和替换
worker/src/             Worker 模块
worker/src/admin/       后台 CRUD、schema、设置、归档
frontend/app.js         公开页面编排
frontend/js/admin/      后台 API/认证模块
frontend/js/shared/     纯函数和共享格式化
tests/                  前端和仓库级测试
```

新增功能优先进入职责明确的模块，不要继续扩大 `main.rs`、`app.js` 或 `admin.js`。

## 本地检查

```bash
./test.sh
```

测试包含：

- Worker 全部 JS 语法。
- Worker utility 测试。
- ESLint 未定义引用检查。
- 前端模块语法、导入和 smoke test。
- Rust `fmt`、`check`、`test`。
- Linux amd64 release build。
- Shell 语法。
- 安装命令和仓库卫生约束。
- 并发与漏检配置检查。

Windows：

```powershell
& "C:\Program Files\Git\bin\bash.exe" test.sh
```

## Worker 开发

本地开发使用独立 D1/R2 状态，避免误操作生产。所有远程数据库命令显式加 `--remote`；不加时 Wrangler 可能读取本地空数据库。

修改 schema：

1. 使用 `CREATE TABLE IF NOT EXISTS`。
2. 新列迁移允许重复执行。
3. 新旧 schema 读取提供合理回退。
4. 为查询添加必要索引。
5. 在远程部署前用临时数据库测试。

## 前端开发

- 保持原版和卡片主题状态语义一致。
- 所有动态文本先 escape。
- 不在前端写入真实 Token、API secret。
- 变更模块路径时同步 `admin.html` cache key。
- 验证桌面和 390px 手机宽度无横向溢出。
- Web 目标不显示 Agent 专属字段。

## Agent 开发

```bash
cd agent
cargo fmt -- --check
cargo check
cargo test
cargo build --release
```

并发原则：采样不能被上传、Ping 或更新阻塞；队列必须有上限；退出和更新要避免留下重复进程。

完整发布包必须在本机运行：

```bash
cd agent
./build-release.sh
```

该脚本通过 Zig 交叉构建 Linux amd64、arm64、armv7、armv6、386 和 Windows amd64，并在所有目标成功后统一写入 `bin/VERSION` 与 `bin/SHA256SUMS`。GitHub Actions 额度不足期间只保留手动触发入口，不会在 push、PR 或 tag 时自动构建，也不作为发布产物来源。

## 版本发布

建议顺序：

1. 更新 Cargo 版本和 Agent 版本常量。
2. 运行完整测试。
3. 在可信本机运行 `agent/build-release.sh` 构建全部架构。
4. 逐个执行 `--version`。
5. 生成 `SHA256SUMS`。
6. 计算 `SHA256SUMS` 文件自身 SHA-256。
7. 更新 Agent/Frontend 两个 `bin/` 目录。
8. 更新安装器默认版本和 manifest 哈希。
9. 更新 Worker update policy 默认值。
10. 提交、推送 tag。
11. 发布 GitHub Release 资产。
12. 部署 Pages。
13. 部署 Worker。
14. 从生产域名重新下载并校验。
15. 观察少量节点滚动更新，再扩大。

## GitHub Actions 权限

创建 Release 的 workflow 需要：

```yaml
permissions:
  contents: write
```

其他 job 使用最小权限。不要为了修复 403 直接授予所有权限。

## 发布校验

```bash
curl -fsSL https://YOUR-PAGES/bin/VERSION
curl -fsSL https://YOUR-PAGES/bin/SHA256SUMS
sha256sum nstatus-metrics-linux-amd64
```

检查 GitHub main、Release、Pages 和 Worker 四处版本一致。发布成功不等于所有 Agent 已升级；通过 `/api/status` 按 `agent_version` 统计滚动进度。

## 提交规范

- 一个提交解决一个清晰问题。
- 不提交真实密钥、数据库导出、日志和构建缓存。
- 二进制更新与 manifest 同提交。
- 文档写明行为和限制，不承诺平台无法保证的区域/实时性。
- 发布前确认 `git status --short` 为空。

## 回归检查重点

- Cron 是否完成全部目标。
- IPv6/AAAA TCP 探测。
- Agent scoped token。
- TOTP 登录和限流。
- 自动更新开关动态生效。
- Web 目标没有 Agent 状态。
- 前端卡片视觉未被无关改动影响。
- 旧 Agent 重装后不残留废弃进程或 IP 解锁任务。
