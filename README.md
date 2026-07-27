<div align="center">

# NIE-SLA

**运行在 Cloudflare 上的状态页与 VPS 探针**

**Beta · 0.24.0-beta.15**

Worker Static Assets + D1 + R2 + Durable Objects + Rust Agent

[![Agent Version](docs/badges/agent-version.svg)](https://github.com/3257085208/NIE-SLA/releases)
[![Public CI](https://github.com/3257085208/NIE-SLA/actions/workflows/public-ci.yml/badge.svg?branch=main)](https://github.com/3257085208/NIE-SLA/actions/workflows/public-ci.yml)
[![License](docs/badges/license.svg)](LICENSE)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/3257085208/NIE-SLA)

[部署教程](https://nie-sla.pages.dev/quickstart/) · [完整文档](https://nie-sla.pages.dev/) · [English](README.en.md) · [安全说明](SECURITY.md)

</div>

## 项目简介

NIE-SLA 把 Cloudflare 公网探测、公开状态页和 VPS 系统数据放在一起。控制面运行在 Cloudflare，VPS 安装主动上报的 Rust Agent，不需要购买中心服务器，也不需要开放 Agent 管理端口。

当前项目处于 Beta，适合个人与小型团队自托管、测试和逐步上线。

## 一键部署

1. 点击上方 **Deploy to Cloudflare**。
2. 登录并授权 GitHub、Cloudflare。
3. 填写后台账号、后台密码和后台路径。
4. 等待构建完成，打开 Worker 地址。
5. 访问 `Worker 地址 + 后台路径`，登录后跟随 UI 添加 VPS。

不需要填写 Agent Token。每台 VPS 的 Token 会在后台首次生成部署命令时随机创建。TOTP 默认关闭。

新部署使用一个 Worker 同时承载静态前端、管理后台、API、D1、R2、Durable Objects 与每分钟 Cron，不需要单独创建 Pages。

## 主要能力

| 能力 | 说明 |
| --- | --- |
| 公网探测 | Cloudflare HTTP/TCP、当前状态、SLA、事件与多区域探测 |
| Rust Agent | CPU、内存、磁盘、负载、IO、网络、进程、线程、运行时长与温度 |
| 网络测量 | Cloudflare Latency、Agent TCP Ping、External Latency Agent |
| 节点管理 | 商家、自定义商家、机器类型、标签、价格、到期时间和独立流量重置日 |
| 自动 GeoIP | Agent 查询 IPv4/IPv6；可选 IP.SB、Cloudflare、IPIP.net 或自定义 HTTPS JSON |
| 流量 | 低写入每日账本、额度、统计方式与修改重置日后重算 |
| 通知 | Telegram 与邮件，支持测试、格式和模板 |
| 安全 | 账号密码 Session、可选 OAuth/TOTP、每节点 Token、校验和更新 |
| 备份 | 普通/加密敏感备份、预览、合并/替换恢复和恢复前 R2 快照 |
| 开发接口 | `/api/v1` 公开只读接口，可用于第三方前端 |

## 固定 Beta 动作

后台可手动触发 NodeQuality 与 IPv4 解锁检测。两者均为固定动作，不接受任意命令、参数、脚本地址、stdin 或定时计划。

- NodeQuality 固定输入 `v/y/y/y`，后台只保存并展示 `nodequality.com` 报告链接。
- IPv4 解锁使用 `IP.Check.Place` JSON 模式，只保存最终媒体解锁字段，不保存纯净度。
- 缺少 `dig` 或 `nslookup` 时使用 Agent 内置受限解析器，不安装软件、不要求 root，并保留报告原始地区值。
- Linux 主遥测服务继续低权限运行，常驻 root Manager 只识别编译进 Agent 的动作，并负责校验更新、维护服务和上报能力。

以后增删固定动作只更新同一 Agent 二进制，不再新增 VPS 服务。已有 Manager、root 更新任务或 root 主进程的旧安装会自动迁移；后台只会标出确实缺少 root 通道的极早期节点。

## 从旧 Pages + Worker 迁移

优先复用原 D1、R2、Agent API 域名和加密密钥。这样已有 Agent ID 与 Token 不变，VPS 无需逐台重装。

后台提供便携备份与密码保护敏感备份用于兜底。高频历史不写入 JSON，复用原 R2 才能完整保留。

## 安全边界

- Agent 只主动 HTTPS 上报，不监听远程管理端口。
- 每台 Agent 使用独立 scoped Token。
- 管理 API 只接受短期 Session。
- 不提供 Web Shell 和任意定时脚本。
- 主题/插件上传、包运行时与市场导入当前已移除。
- 安装和更新校验版本、manifest 与二进制 SHA-256。
- 敏感备份使用 PBKDF2-SHA256 与 AES-256-GCM。

## 本地验证

```bash
bash test.sh
```

Agent release 在本地生成：

```bash
cd agent
./build-release.sh
```

## License

[MIT](LICENSE)
