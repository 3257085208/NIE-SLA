# Agent

Agent 是 VPS 侧的 Rust 采集器，只主动访问 Worker，不监听端口。详细说明（环境变量、命令、更新）见 `agent/README_zh.md`，本文讲部署与排障。

## 部署

后台创建目标后点击“部署 Agent”，复制该节点专用命令在 VPS 上执行。命令包含 scoped Token、Agent ID、API/下载地址、期望版本与 manifest 哈希，属于敏感凭据。

安装器识别架构、校验 manifest 与二进制、验证版本、停止旧进程，再安装 systemd 或 OpenRC 服务。重复运行最新命令可安全更新并清理旧版残留。

安装后：

```text
/opt/nstatus-metrics/nstatus-metrics
/opt/nstatus-metrics/nstatus-metrics.env
/usr/local/bin/cftz
systemd 或 OpenRC 服务 nstatus-metrics
```

## 数据流

- 每 1 秒采样 CPU、内存、磁盘、负载、IO、网络、进程/线程、运行时长、温度。
- 每 300 秒批量上报，离线样本进入本地有界队列。
- 每 20 秒对后台配置的目标做 TCP Ping。
- 上报原始累计网卡计数，供 Worker 做月度流量核算。

## 自动更新

后台开关动态控制。开启后 Agent 下次检查策略时更新；关闭后不主动修改自身；手动 `cftz update` 不受开关限制。更新前验证 `SHA256SUMS` 固定哈希、二进制哈希与版本，失败保留旧版本。

## Beta 动作

Agent 轮询 `/api/agent/tasks` 领取任务。只支持 NodeQuality 与 IPv4 解锁两个编译进二进制的动作，由 root Manager 执行，遥测服务保持低权限。任务接口只返回动作枚举，不返回脚本文本、参数或任意 stdin。

## 排障

Agent 离线：检查服务状态、Token、API 域名与 HTTPS 连通性。

```bash
sudo cftz status
sudo cftz log 100
sudo systemctl status nstatus-metrics --no-pager
```

Beta 按钮长期排队：Agent 版本过旧、root 通道未就绪、或 API 域名不可达。重新执行该节点最新部署命令后再看：

```bash
sudo cftz status
sudo journalctl -u nstatus-metrics -n 100 --no-pager
```

NQ 失败常见原因：系统权限、缺少依赖、上游脚本不可用。IP 解锁失败常见原因：上游返回格式变化、VPS 没有可用 IPv4。
