# 04 Agent 安装与维护

## 推荐安装

从后台探针列表点击“部署”，复制生成的一键命令。新版命令会自动判断当前是否 root；root 环境不需要 sudo。

生成命令会显式携带 `NSTATUS_PING_TARGETS="*"` 和 `NSTATUS_PING_SEC="20"`，安装脚本也会把这两个值写入 Agent 环境文件。`*` 表示自动拉取后台 Ping 管理里启用的全部目标；如果只想让某台 VPS Ping 指定目标，可以改成逗号分隔的 Ping 目标 ID。

国内网络环境尽量不要把 Agent 的 `NSTATUS_API_BASE` 指向 `workers.dev` 或 `pages.dev`，这些公共后缀可能无法直连。请使用已经绑定到 Pages/Worker 的自定义域名，例如 `https://sla.example.com`；后台从自定义前端域名打开时，生成的一键命令也会优先使用这个自定义域名作为 API 地址。

## systemd 管理

```bash
systemctl status nstatus-metrics
journalctl -u nstatus-metrics -f
systemctl restart nstatus-metrics
```

## cftz 工具

```bash
cftz status      # 查看服务状态
cftz log 100     # 查看最近日志
cftz set         # 重新配置
cftz update      # 更新脚本和二进制
cftz uninstall   # 卸载
```

## 采集内容

Agent 上报 CPU、内存、Swap、磁盘、Load、网络速率、累计收发、TCP/UDP 连接、磁盘 IO、进程数、线程数、主机名、OS、内核、架构、虚拟化、CPU 型号、核心数、运行时长、Agent 版本和 TCP Ping 结果。

## 流量重启原理

Worker 保存“本周期已累计值”和“上次看到的网卡原始累计值”。原始值变大时累加差值；VPS 重启导致原始值变小时，把这次作为新基准，避免误算巨大流量。因此重启不会清空月累计，但重启到下一次上报之间的少量流量可能不会计入。
