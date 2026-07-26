# 运维、备份与迁移

## 日常检查

```bash
curl -fsSL https://你的域名/api/health
curl -fsSL https://你的域名/bin/VERSION
curl -fsSL https://你的域名/bin/SHA256SUMS
```

同时检查 Worker Cron、D1/R2 用量、后台最近上报、通知失败和外部 Latency Agent 最近上报时间。

## 备份策略

建议在以下操作前同时导出普通备份和敏感备份：

- 切换部署架构；
- 修改 D1/R2 绑定；
- 批量调整节点；
- 更新大版本；
- 更换 Cloudflare 账号。

敏感备份密码与文件分开保存。备份不包含完整 R2 历史。

## 恢复

1. 选择备份文件。
2. 输入敏感备份密码。
3. 点击预览并核对记录数。
4. 选择合并或替换。
5. 输入确认词。
6. 执行恢复。
7. 检查 R2 中的恢复前快照。
8. 验证节点 ID、Agent 凭据、通知和外观。

恢复失败时不要反复点击。先保留 R2 快照并查看 Worker 日志。

## Pages + Worker 迁移

优先把原 D1、R2 直接绑定到单 Worker，并保持 Agent API 域名。这样 Agent 无需更新配置，高频历史也继续存在。

若跨账号迁移，先部署空控制面，再恢复加密备份，然后单独迁移 R2。完成前保留旧部署。

## Beta 任务排障

按钮长期排队：

- Agent 版本过旧；
- Linux 未安装 `nstatus-metrics-tasks` 服务；
- root runner 未启动；
- Agent API 域名不可达。

重新执行该节点最新部署命令，然后检查：

```bash
systemctl status nstatus-metrics
systemctl status nstatus-metrics-tasks
journalctl -u nstatus-metrics-tasks -n 100 --no-pager
```

NQ 失败可能来自系统权限、缺少依赖、脚本超时或上游不可用。IP 解锁失败可能来自上游返回格式变化或目标 VPS 没有可用 IPv4。

## Agent 更新

安装器和自动更新必须同时校验：

- `VERSION`；
- `SHA256SUMS` 的固定哈希；
- 对应二进制 SHA-256。

不要只替换单个二进制或只改版本文件。

## 常见故障

| 现象 | 检查 |
| --- | --- |
| 首页 404 | Static Assets 构建、Worker 路由 |
| API 正常但样式旧 | 重新生成 `dist-one-click`，清浏览器缓存 |
| Agent 在线但 CF Latency 无数据 | 公网端口、DNS-only AAAA、Cloudflare TCP 限制 |
| 外部 Latency 只有一个点 | 服务重复、旧进程、Token、上报日志 |
| 城市为空 | GeoIP 服务商能力、IPv4/IPv6 出口、Agent 日志 |
| 恢复后 Agent 离线 | 是否恢复敏感凭据、ID/API 域名是否保持 |
