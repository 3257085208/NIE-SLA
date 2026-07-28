# 开发、测试与发布

## 生产源

- Rust Agent 与 Worker：本私有仓库。
- 生产前端：同级 `../frontend` 私有仓库。
- 公开仓库：只通过 `scripts/export-public.mjs` 单向脱敏生成。

禁止从公开库或归档目录覆盖生产源。

## 测试

```bash
bash test.sh
```

至少覆盖 Worker 语法与打包、鉴权、任务白名单、GeoIP、备份恢复、前端模块、Rust fmt/check/test、安装器与 shell 语法。

## Agent 本地发布

```bash
cd agent
./build-release.sh
```

脚本构建六个目标并生成同一批 `VERSION` 与 `SHA256SUMS`。然后：

1. 计算 `SHA256SUMS` 自身 SHA-256；
2. 更新 Linux 安装器默认哈希与版本；
3. 同步整批产物到生产前端 `bin/`；
4. 跑完整测试；
5. 验证每个二进制 `--version`；
6. 再创建 Release。

## Worker 与 Static Assets

私有生产发布：

```bash
cd worker
./deploy.sh
```

脚本从生产前端生成 `dist-one-click`，然后部署 Worker。公开一键部署仓库由根目录 `npm run build` 生成同源资源。

发布前检查产物不含 `AGENTS.md`、测试、Pages Functions、node_modules 或废弃的通用扩展运行时；公开主题运行时与示例必须保留。

## 公开脱敏

```bash
node scripts/export-public.mjs
node scripts/export-public.mjs --apply
```

先 dry-run，再应用。导出工具会扫描生产域名、Token、私钥和本机路径。

## 版本

- 应用：`0.x.y-beta.N`，包括 Worker 与同源前端；
- Agent：独立 `vX.Y.Z`；
- 正式稳定版才进入应用 `1.x.x`。
