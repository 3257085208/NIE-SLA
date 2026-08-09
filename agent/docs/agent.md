# Agent 指南

Rust Agent 的完整说明见 `agent/README_zh.md`（中文）与 `agent/README.md`（英文）。系统级教程在 `docs/zh-CN/04-agent.md` 与 `docs/en/04-agent.md`。

要点：

- 每 1 秒采样，每 300 秒批量上报，离线样本进入本地有界队列。
- 每 20 秒对后台配置的目标做 TCP Ping。
- 安装命令由后台按节点生成，包含一次性安装票据与 scoped Token。
- 自动更新由后台开关控制，更新前逐级校验哈希。
- 固定 Beta 动作（NodeQuality、IPv4 解锁）由 root Manager 执行，遥测服务低权限运行。
