<div align="center">

# NIE-SLA

**运行在 Cloudflare 上的状态页与 VPS 探针**

**Stable · 1.1.0**

Worker Static Assets + D1 + R2 + Durable Objects + Rust Agent

[![Agent Version](docs/badges/agent-version.svg)](https://github.com/3257085208/NIE-SLA/releases)
[![Public CI](https://github.com/3257085208/NIE-SLA/actions/workflows/public-ci.yml/badge.svg?branch=main)](https://github.com/3257085208/NIE-SLA/actions/workflows/public-ci.yml)
[![License](docs/badges/license.svg)](LICENSE)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/3257085208/NIE-SLA)

[部署教程](https://nie-sla.pages.dev/quickstart/) · [完整文档](https://nie-sla.pages.dev/) · [English](README.en.md) · [安全说明](SECURITY.md)

</div>

## 项目简介

NIE-SLA 把 Cloudflare 公网探测、公开状态页和 VPS 系统数据放在一起。控制面运行在 Cloudflare，VPS 安装主动上报的 Rust Agent，不需要购买中心服务器，也不需要开放 Agent 管理端口。

当前项目使用正式稳定版本，适合个人与小型团队自托管和持续升级。

## 一键部署

1. 点击上方 **Deploy to Cloudflare**。
2. 登录并授权 GitHub、Cloudflare。
3. 填写后台账号、后台密码、后台路径和独立长期加密密钥。
4. 等待构建完成，打开 Worker 地址。
5. 访问 `Worker 地址 + 后台路径`，登录后跟随 UI 添加 VPS。

不需要填写 Agent Token。每台 VPS 的 Token 会在后台首次生成部署命令时随机创建。`TOTP_ENCRYPTION_KEY` 应使用至少 32 位随机值并长期保持不变；TOTP 默认关闭。

新部署使用一个 Worker 同时承载静态前端、管理后台、API、D1、R2、Durable Objects 与每分钟 Cron，不需要单独创建 Pages。

### Agent 下载链

本仓库是开源用户唯一需要使用的公开分发入口。Cloudflare 构建按 `update-manifest.json` 固定的版本直接下载本仓库 Release 资产，校验 `VERSION` 与 `SHA256SUMS` 后打包到部署实例的 `/bin`。

VPS 上的 Agent 安装和后续更新从该用户自己的 Worker/站点 `/bin` 下载，不会在每台 VPS 上查询 GitHub API。Release 因此负责公开分发，已部署站点负责实际 Agent 下载。

## 主要能力

| 能力 | 说明 |
| --- | --- |
| 公网探测 | Cloudflare HTTP/TCP、当前状态、SLA、事件与多区域探测 |
| Rust Agent | CPU、内存、磁盘、负载、IO、网络、进程、线程、运行时长与温度 |
| 网络测量 | Cloudflare Latency、Agent TCP/HTTP 探测、External Latency Agent |
| 节点管理 | 商家、自定义商家、机器类型、标签、价格、到期时间和独立流量重置日 |
| 自动 GeoIP | Agent 查询 IPv4/IPv6；可选 IP.SB、Cloudflare、IPIP.net 或自定义 HTTPS JSON |
| 流量 | 低写入每日账本、额度、统计方式与修改重置日后重算 |
| 通知 | Telegram 与邮件，支持测试、格式和模板 |
| 安全 | 账号密码 Session、可选 OAuth/TOTP、每节点 Token、校验和更新 |
| 备份 | 普通/加密敏感备份、预览、合并/替换恢复和恢复前 R2 快照 |
| 开发接口 | `/api/v1` 公开只读接口，可用于第三方前端 |
| 第三方主题 | SHA-256 校验的 CSS 主题与隔离 Canvas 完整布局主题 |

## 固定 Beta 动作

后台可手动触发 NodeQuality 与 IPv4 解锁检测。两者均为固定动作，不接受任意命令、参数、脚本地址、stdin 或定时计划。

- NodeQuality 四项测试可在后台分别选择：HardwareQuality `y/f/v/n`、IPQuality `y/n`、NetQuality `y/l/n`、回程路由 `y/n`，默认 `f/y/y/y`；任务不再设置外部超时，后台保存结构化报告与经过限制的 `nodequality.com` 报告链接。
- Worker 可把网络质量与回程路由渲染成 SVG，通过固定 S3 渠道上传且目录留空；图床凭据只存在于 Worker Secret，上游图片地址由本站代理隐藏，失败时回退到文本报告。
- IPv4 解锁使用 `IP.Check.Place` JSON 模式，只保存最终媒体解锁字段，不保存纯净度。
- 缺少 `dig` 或 `nslookup` 时使用 Agent 内置受限解析器，不安装软件、不要求 root，并保留报告原始地区值。
- 两个入口脚本使用随站点发布的已审计源码快照并校验 SHA-256；固定诊断由 root-only Manager 直接执行，以保留 raw socket、路由探测和必要系统工具能力。
- Linux 主遥测服务继续低权限运行，常驻 root Manager 只识别编译进 Agent 的动作，并负责校验更新、维护服务和上报能力。

以后增删固定动作只更新同一 Agent 二进制，不再新增 VPS 服务。已有 Manager、root 更新任务或 root 主进程的旧安装会自动迁移；后台只会标出确实缺少 root 通道的极早期节点。

## 从旧 Pages + Worker 迁移

优先复用原 D1、R2、Agent API 域名和加密密钥。这样已有 Agent ID 与 Token 不变，VPS 无需逐台重装。

无法复用原 D1 时，在旧后台导出默认勾选的密码保护备份。新格式会在恢复时使用新部署的加密材料重新封装每节点 Token，原 VPS 无需重新安装；取消勾选后得到的普通可分享备份不含凭据。高频历史不写入 JSON，复用原 R2 才能完整保留。

如果 `workers.dev` 在节点网络中不可达，可在“设置 → Agent → Agent 连接域名”填写已路由到当前 Worker 的自定义公网 HTTPS Origin。新安装命令、Latency Agent 与自动更新会统一使用该地址。

## 安全边界

- Agent 只主动 HTTPS 上报，不监听远程管理端口。
- 每台 Agent 使用独立 scoped Token。
- 管理 API 只接受短期 Session。
- 不提供 Web Shell 和任意定时脚本。
- 第三方主题上传后默认停用；Canvas 无同源权限且只有脱敏只读状态。
- 插件、后台脚本、市场导入和任意扩展执行不开放。
- 安装和更新校验版本、manifest 与二进制 SHA-256。
- TOTP、可恢复 Agent Token 和后台保存的通知密钥使用独立长期密钥；管理员密码不再作为新密文的加密材料。
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

## 主题开发

后台支持上传经过 SHA-256 校验的 CSS 与 Canvas 主题 ZIP。Manifest、沙箱消息协议、移动端与发布要求见[第三方主题开发规范](docs/zh-CN/14-third-party-themes.md)，可运行源码位于 `examples/themes/`。

## License

[MIT](LICENSE)
