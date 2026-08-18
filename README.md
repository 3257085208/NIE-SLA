<div align="center">

# NIE-SLA

**运行在 Cloudflare 上的状态页与 VPS 探针**

**Stable · 1.1.15**

Worker Static Assets + D1 + R2 + Durable Objects + Rust Agent

[![Agent Version](docs/badges/agent-version.svg)](https://github.com/3257085208/NIE-SLA/releases)
[![License](docs/badges/license.svg)](LICENSE)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/3257085208/NIE-SLA)

[部署教程](https://nie-sla.pages.dev/quickstart/) · [完整文档](https://nie-sla.pages.dev/) · [English](README.en.md) · [安全说明](SECURITY.md)

</div>

## 这是什么

NIE-SLA 把 Cloudflare 的公网探测、公开状态页和 VPS 系统数据放在一起。控制面运行在 Cloudflare，VPS 上安装主动上报的 Rust Agent，不需要中心服务器，也不需要给 Agent 开放管理端口。项目使用正式稳定版本，适合个人与小型团队自托管。

## 一键部署

1. 点击上方 **Deploy to Cloudflare**。
2. 登录并授权 GitHub、Cloudflare。
3. 填写后台账号、后台密码、后台路径和独立长期加密密钥。
4. 等待构建完成，打开 Worker 地址。
5. 访问 `Worker 地址 + 后台路径`，登录后按界面引导添加 VPS。

不需要填写 Agent Token。每台 VPS 的 Token 在后台首次生成部署命令时随机创建。`TOTP_ENCRYPTION_KEY` 使用至少 32 位随机值并长期保持不变；TOTP 默认关闭。

新部署用一个 Worker 同时承载静态前端、管理后台、API、D1、R2、Durable Objects 与每分钟 Cron，不需要单独创建 Pages。

### Agent 下载链

本仓库是自托管用户唯一的公开分发入口。Cloudflare 构建按 `update-manifest.json` 固定的版本下载本仓库 Release 资产，校验 `VERSION` 与 `SHA256SUMS` 后打包到部署实例的 `/bin`。

VPS 上的 Agent 安装与后续更新从用户自己的 Worker/站点 `/bin` 下载，不在每台 VPS 上查询 GitHub API。GitHub Release 负责公开分发，已部署站点负责实际 Agent 下载。

## 功能

- 公网探测：Cloudflare HTTP/TCP、当前状态、SLA、事件与多区域探测。
- Rust Agent：CPU、内存、磁盘、负载、IO、网络、进程、线程、运行时长与温度。
- 网络测量：Cloudflare Latency、Agent TCP/HTTP 探测、External Latency Agent。
- 节点管理：商家、自定义商家、机器类型、标签、价格、到期时间和独立流量重置日。
- 自动 GeoIP：Agent 查询 IPv4/IPv6，可选 IP.SB、Cloudflare、IPIP.net 或自定义 HTTPS JSON。
- 流量：低写入每日账本、额度、统计方式与修改重置日后的重算。
- 通知：Telegram 与邮件，支持测试、格式与模板。
- 安全：账号密码 Session、可选 OAuth/TOTP、每节点 Token、校验和更新。
- 备份：普通/加密敏感备份、预览、合并/替换恢复与恢复前 R2 快照。
- 开发接口：`/api/v1` 公开只读接口，可用于第三方前端。
- 第三方主题：SHA-256 校验的 CSS 主题与隔离的 Canvas 完整布局主题。

## 固定 Beta 动作

后台可以手动触发 NodeQuality 与 IPv4 解锁检测。两者都是固定动作，不接受任意命令、参数、脚本地址、stdin 或定时计划；入口脚本使用随站点发布的已审计源码快照并校验 SHA-256。

- NodeQuality 四项测试在后台分别选择：HardwareQuality `y/f/v/n`、IPQuality `y/n`、NetQuality `y/l/n`、回程路由 `y/n`，默认 `f/y/y/y`；当前版本不设置外部超时，后台保存结构化报告与受限的 `nodequality.com` 报告链接。
- Worker 可以把网络质量与回程路由渲染成 SVG 上传，图床凭据只存在于 Worker Secret，公开图片地址由本站代理隐藏，失败时回退文本报告。
- IPv4 解锁使用 `IP.Check.Place` 完整报告模式（`-4 -n -p`），保存最多 64 KiB 的有界完整报告与最终媒体解锁结果；隐私模式不向第三方上传报告。
- 缺少 `dig` 或 `nslookup` 时使用 Agent 内置受限解析器，不安装软件、不要求 root。
- 固定诊断由 root-only Manager 执行以保留 raw socket 与路由探测能力；Linux 主遥测服务保持低权限。以后增删固定动作只更新同一个 Agent 二进制，已有安装会自动迁移。

## NQ 公益依赖说明

NodeQuality 脚本默认从维护者公益加速站下载官方脚本、组件、BenchOs 与 Geekbench 5 安装包，失败时回退官方源与镜像。非官方一键部署实例的 NQ 网络/回程图片默认提交到维护者公益 Broker，只发送有界的 `network`/`route` 报告文本，不携带 Agent Token 或图床 Token；官方维护实例使用自己的 S3 Secret 在本站生成图片。公益链路的实际地址随部署代码分发，不依赖文档中的示例域名。

## 迁移

旧 Pages + Worker 部署复用原 D1、R2、Agent API 域名、Target ID、节点凭据与加密材料后，已安装 Agent 无需重装即可继续上报。便携备份作为迁移兜底；完整高频历史在 R2 中。

## 安全

- Agent 只主动出站，每节点独立 Token，安装票据一次性有效。
- 后台账号密码 + 短期 Session，可选 OAuth 白名单与 TOTP。
- 安装与更新校验版本、manifest 与二进制 SHA-256。
- 不提供 Web Shell、任意命令或任意定时脚本。
- 主题需管理员上传并复核 SHA-256；Canvas 主题沙箱隔离，只读脱敏状态。
- 插件、后台脚本、市场导入与任意扩展执行不开放。
- TOTP、可恢复 Agent Token 与通知密钥使用独立长期加密材料。
- 敏感备份使用 PBKDF2-SHA256 与 AES-256-GCM。

## 本地验证

```bash
bash test.sh
```

Agent Release 在本地生成：

```bash
cd agent
./build-release.sh
```

## 主题开发

后台支持上传经过 SHA-256 校验的 CSS 与 Canvas 主题 ZIP。Manifest、沙箱消息协议、移动端与发布要求见[第三方主题开发规范](docs/zh-CN/14-third-party-themes.md)，可运行源码位于 `examples/themes/`。

## License

[MIT](LICENSE)
