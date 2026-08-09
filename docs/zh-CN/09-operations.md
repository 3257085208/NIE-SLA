# 运维、备份与迁移

## 日常检查

```bash
curl -fsSL https://你的域名/api/health
curl -fsSL https://你的域名/bin/VERSION
curl -fsSL https://你的域名/bin/SHA256SUMS
```

同时检查：Worker Cron 运行记录、D1/R2 用量、后台 Agent 在线与版本、通知失败、外部 Latency Agent 最近上报时间。

## 备份

建议在以下操作前同时导出普通备份与敏感备份：切换部署架构、修改 D1/R2 绑定、批量调整节点、更新大版本、更换 Cloudflare 账号。

受保护备份默认包含每节点 Agent Token。Token 只在备份密码加密的数据包内，恢复时用新部署的加密材料重新封装，因此跨账号或重建 D1 后不需要逐台重装 Agent。取消“保留凭据”后生成的普通备份不含 Token。备份密码与文件分开保存；任何 JSON 备份都不包含完整 R2 历史。

## 恢复

1. 选择备份文件。
2. 输入敏感备份密码。
3. 预览并核对记录数。
4. 选择合并或替换。
5. 输入确认词。
6. 执行恢复。
7. 检查 R2 中的恢复前快照。
8. 验证节点 ID、Agent 凭据、通知与外观。

恢复失败时不要反复点击。先保留 R2 快照并查看 Worker 日志。

## Pages + Worker 迁移

同账号迁移优先把原 D1、R2 直接绑定到单 Worker，并保持 Agent API 域名，Agent 无需更新配置，高频历史继续存在。

跨账号迁移：先部署空控制面，再恢复受保护备份，然后单独迁移 R2。恢复确认中应显示可迁移 Agent Token 数量；完成前保留旧部署。

在后台“设置 → Agent → Agent 连接域名”填写已路由到新 Worker 的公网 HTTPS Origin，可让安装、API 与更新避开默认 `workers.dev`。地址不能包含路径、查询参数或账号密码，必须同时提供 `/api`、`/install.sh` 与 `/bin`。

## Beta 任务排障

按钮长期排队：Agent 版本过旧、root 通道未就绪、API 域名不可达。重新执行该节点最新部署命令，然后检查：

```bash
sudo systemctl status nstatus-metrics --no-pager
sudo cftz status
sudo cftz log 100
```

NQ 失败可能来自系统权限、缺少依赖、脚本超时或上游不可用；IP 解锁失败可能来自上游返回格式变化或 VPS 没有可用 IPv4。
