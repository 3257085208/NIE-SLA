# CloudflareStatus / 聶.NET 前端

本目录是 NIE-SLA 的 Cloudflare Pages 前端，同时包含公开状态页、管理后台、Pages Functions API 代理、Agent 安装脚本和发布二进制。

完整系统文档见 [NIE-SLA-Agent 中文主手册](https://github.com/3257085208/NIE-SLA-Agent/blob/main/README.zh-CN.md)。Worker/Agent 源码也位于该仓库。

## 目录

| 路径 | 说明 |
| --- | --- |
| `index.html` | 公开状态页入口 |
| `app.js` | 公开页面状态与交互编排 |
| `style.css` | 公开页面样式和主题 |
| `admin.html` | 管理后台入口 |
| `js/admin.js` | 后台 UI 编排 |
| `js/admin/api.js` | 账号密码/GitHub 登录后的 Session API 客户端 |
| `js/shared/` | 共享纯函数 |
| `functions/api/[[path]].js` | Pages 到 Worker 的 API 代理 |
| `config.js` | API Base 配置 |
| `bin/` | Agent VERSION、SHA256SUMS 和二进制 |
| `install.sh`/`install.ps1` | Linux/Windows Rust Agent 安装入口 |
| `install-latency.sh` | 外部 Latency Agent 的 Linux/systemd 安装入口 |
| `latency-agent.py` | 从独立网络位置测量公开 TCP 目标的轻量服务 |

## 配置 API

`config.js`：

```js
window.NSTATUS_API_BASE = "https://YOUR-WORKER.example";
```

不要在该文件放管理员密码、Session 或 Agent Token。它会公开下载到每个访客浏览器。

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

## 四种数据不要混淆

- Agent 在线：VPS 最近仍在主动上传。
- CF 状态/Latency：Cloudflare 是否能主动连接目标。
- Agent TCP Ping：被监控 VPS 到后台 Ping 目标的延迟。
- 外部 Latency Agent：独立 Linux 节点到所有公开 TCP 目标的延迟。
- 日色块：当前表示 CF 每日探测成功率。

因此 Agent 在线但 CF Latency 为 `-` 并不矛盾。

后台“Latency”页新增节点后，还必须执行该节点当前生成的部署命令。成功安装会输出 `{"ok":true,"targets":N,"accepted":N}`；只有成功上报后，后台“最近上报”和公开页面的外部 Latency 来源才会出现。

重复执行当前部署命令会先停止旧服务和所有残留 Latency 进程，再启动唯一的新实例。后台“Agent 自动更新”开关也控制外部 Latency Agent；旧节点需要重新执行一次最新命令，之后才能按策略自动更新。

完整教程见 [外部 Latency Agent 部署与排障](https://github.com/3257085208/NIE-SLA-Agent/blob/main/docs/zh-CN/13-external-latency-agents.md)。

## 主题与插件

后台“主题”和“插件”是两个独立页面，分别使用 `/api/themes/*` 与 `/api/plugins/*` 上传和管理 `nstatus-extension-v1` ZIP。内置只保留 `classic`；官方卡片布局也通过主题 ZIP 启用。主题支持低风险 CSS 模式和隔离的全布局 canvas 模式，插件继续在 sandbox iframe 中通过只读消息 API 获取公开状态；停用主题会回退到 `classic`。

包格式与 `/api/v1` 见[扩展开发指南](https://github.com/3257085208/NIE-SLA-Agent/blob/main/docs/zh-CN/14-extensions-developer-guide.md)，独立仓库、工程命令、测试、SemVer、许可证与发布标准见[主题规范](https://github.com/3257085208/NIE-SLA-Agent/blob/main/docs/zh-CN/15-theme-development-standard.md)和[插件规范](https://github.com/3257085208/NIE-SLA-Agent/blob/main/docs/zh-CN/16-plugin-development-standard.md)。

## 后台外观配置

后台“系统设置 → 前端外观与文案”可以直接调整内置主题的站点标题、Favicon、左侧 Logo/头像/副标题、品牌链接、右上角图片或文字、状态与内容区文案、页脚、三组基础颜色，以及页头、图表、Latency、VPS 详情等区域的显示开关。配置来自公开状态响应的 `frontend.appearance`，无需重新发布 Pages；URL、颜色、尺寸和枚举均由 Worker 校验并带安全默认值。

## IPv6-only TCP 目标

推荐使用 DNS-only AAAA 域名：

```text
probe-vps.example.com AAAA 2001:db8::10
Cloudflare Proxy: DNS only
```

不要开启橙云。Cloudflare Workers TCP Sockets 可能拒绝直接 IPv6 字面地址；连接 Cloudflare 自己的代理 IP 也被禁止。

完整教程见 [IPv6、AAAA 与 CF TCP 探测](https://github.com/3257085208/NIE-SLA-Agent/blob/main/docs/zh-CN/12-ipv6-cloudflare-probe.md)。

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

后台不会把凭据写进源码。账号密码只发送到登录端点且不会保存；登录成功后的 Session 保存在当前标签页 `sessionStorage`，关闭标签页后失效。管理 API 只接受有效 Session。可选 GitHub OAuth 使用账号白名单和一次性票据，启用 TOTP 后仍需第二因素。

## 本地检查

从完整仓库根目录运行：

```bash
./test.sh
```

会检查前端语法、模块导入、共享函数和 smoke test。手动还应验证桌面和移动端、两种主题、登录/TOTP、目标排序、Web 目标不显示 Agent 字段。

## 安全

- 动态 HTML 必须转义。
- 不在 localStorage 保存管理员密码或 Session。
- 不在静态文件中放 secret。
- 完整 Agent 安装命令包含 scoped Token，禁止公开。
- Pages 自定义域名和 Worker API 都使用 HTTPS。

## License

MIT
