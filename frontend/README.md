# CloudflareStatus / 聶.NET 前端

本目录是 NIE-SLA 的 Cloudflare Pages 前端，同时包含公开状态页、管理后台、Pages Functions API 代理、Agent 安装脚本和发布二进制。

完整系统文档见 [NIE-SLA 中文主手册](https://github.com/3257085208/NIE-SLA/blob/main/README.zh-CN.md)。Worker/Agent 源码也位于该仓库。

## 目录

| 路径 | 说明 |
| --- | --- |
| `index.html` | 公开状态页入口 |
| `app.js` | 公开页面状态与交互编排 |
| `style.css` | 公开页面样式和主题 |
| `admin.html` | 管理后台入口 |
| `js/admin.js` | 后台 UI 编排 |
| `js/admin/api.js` | Token、TOTP session 与 API 客户端 |
| `js/shared/` | 共享纯函数 |
| `functions/api/[[path]].js` | Pages 到 Worker 的 API 代理 |
| `config.js` | API Base 配置 |
| `bin/` | Agent VERSION、SHA256SUMS 和二进制 |
| `install.sh`/`install.ps1` | Linux/Windows 安装入口 |

## 配置 API

`config.js`：

```js
window.NSTATUS_API_BASE = "https://YOUR-WORKER.example";
```

不要在该文件放 Admin Token 或 Agent Token。它会公开下载到每个访客浏览器。

## 部署

```bash
npx wrangler login
npx wrangler pages deploy . --project-name nstatus
```

也可使用 Pages GitHub 集成。部署后检查 Deployment 对应 commit，并访问：

```text
https://YOUR-PAGES/
https://YOUR-PAGES/admin.html
https://YOUR-PAGES/bin/VERSION
https://YOUR-PAGES/bin/SHA256SUMS
```

## 两种状态不要混淆

- Agent 在线：VPS 最近仍在主动上传。
- CF 状态/Latency：Cloudflare 是否能主动连接目标。
- 日色块：当前表示 CF 每日探测成功率。

因此 Agent 在线但 CF Latency 为 `-` 并不矛盾。

## IPv6-only TCP 目标

推荐使用 DNS-only AAAA 域名：

```text
probe-vps.example.com AAAA 2001:db8::10
Cloudflare Proxy: DNS only
```

不要开启橙云。Cloudflare Workers TCP Sockets 可能拒绝直接 IPv6 字面地址；连接 Cloudflare 自己的代理 IP 也被禁止。

完整教程见 [IPv6、AAAA 与 CF TCP 探测](https://github.com/3257085208/NIE-SLA/blob/main/docs/zh-CN/12-ipv6-cloudflare-probe.md)。

## Agent 发布文件

`bin/` 必须整体来自同一次 release：

```text
VERSION
SHA256SUMS
nstatus-metrics-linux-*
nstatus-metrics-windows-amd64.exe
```

更新流程：

1. 构建并验证全部架构。
2. 生成 `SHA256SUMS`。
3. 计算 manifest 文件自身 SHA-256。
4. 同步全部文件到 `bin/`。
5. 更新安装器默认版本/manifest 哈希。
6. 部署 Pages。
7. 从生产域名重新下载并校验。

只替换二进制或只替换 VERSION 都会造成安装校验失败。

## 后台认证

后台不会把凭据写进源码。Admin Token 与 TOTP session 保存在当前标签页 `sessionStorage`，关闭标签页后失效。启用 TOTP 后，管理 API 同时要求 Token 和有效 session。

## 本地检查

从完整仓库根目录运行：

```bash
./test.sh
```

会检查前端语法、模块导入、共享函数和 smoke test。手动还应验证桌面和移动端、两种主题、登录/TOTP、目标排序、Web 目标不显示 Agent 字段。

## 安全

- 动态 HTML 必须转义。
- 不在 localStorage 长期保存 Admin Token。
- 不在静态文件中放 secret。
- 完整 Agent 安装命令包含 scoped Token，禁止公开。
- Pages 自定义域名和 Worker API 都使用 HTTPS。

## License

MIT
