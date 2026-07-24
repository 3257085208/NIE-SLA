# Cloudflare 一键部署

这是推荐部署方式。整个过程在浏览器中完成，不需要准备 VPS、Node.js、Wrangler 或命令行。

## 部署前准备

只需要：

- 一个 Cloudflare 账号。
- 一个 GitHub 账号。
- 三个互不相同的随机密钥。

建议用密码管理器生成三段至少 32 字节的随机值，并提前保存：

| 名称 | 用途 |
| --- | --- |
| `ADMIN_TOKEN` | 登录管理后台 |
| `AGENT_TOKEN` | 为每台 Agent 派生独立凭据 |
| `TOTP_ENCRYPTION_KEY` | 加密后台 TOTP 密钥 |

不要重复使用密码，也不要把这些值发到论坛、Issue、截图或公开仓库。

## 第一步：点部署按钮

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/3257085208/NIE-SLA)

点击后会进入 Cloudflare 官方部署页面。

## 第二步：授权账号

按页面提示完成：

1. 登录 GitHub。
2. 允许 Cloudflare 读取并 Fork 本仓库。
3. 登录 Cloudflare。
4. 选择要部署到的 Cloudflare 账号。

页面按钮名称可能随 Cloudflare 更新而略有变化，按默认流程继续即可。

## 第三步：填写三个密钥

部署页面会要求填写：

```text
ADMIN_TOKEN
AGENT_TOKEN
TOTP_ENCRYPTION_KEY
```

把准备好的三段随机值分别填入。三项不能相同。

这些值会作为 Cloudflare Secret 保存，不会写入公开代码。

## 第四步：等待构建完成

点击部署后，Cloudflare 会自动完成：

- 创建 Worker。
- 创建并绑定 D1 数据库。
- 创建并绑定 R2 存储桶。
- 配置 Durable Object 与定时任务。
- 下载并校验 Agent Release。
- 构建公开状态页和管理后台。
- 发布到一个 `workers.dev` 地址。

整个过程通常需要几分钟。看到部署成功后，点击 Cloudflare 页面给出的访问地址。

## 第五步：进入后台

状态页地址类似：

```text
https://你的项目.你的账号.workers.dev
```

管理后台地址是在后面加 `/admin`：

```text
https://你的项目.你的账号.workers.dev/admin
```

使用刚才设置的 `ADMIN_TOKEN` 登录。首次登录后建议在“设置”中启用 TOTP。

## 第六步：添加第一台 VPS

登录后台后：

1. 打开“探针”。
2. 点击新增目标。
3. 填写 VPS 名称、地址和端口。
4. 保存后点击该节点的部署按钮。
5. 选择 Linux 或 Windows。
6. 复制页面生成的命令到对应 VPS 执行。

每台 VPS 的命令都包含独立凭据，不要把同一条命令重复用于多台机器，也不要公开完整命令。

Agent 安装成功后，后台会显示最近上报时间，前台会出现 CPU、内存、磁盘、网络和可用率数据。

## 第七步：检查部署结果

确认以下项目：

- 首页可以正常打开。
- `/admin` 可以登录。
- 新增的 Target 出现在前台。
- Agent 最近上报时间持续更新。
- CPU、内存和磁盘数据不是空值。
- Cloudflare HTTP/TCP 检查开始生成日格。

Cloudflare 检查和 Agent 上报是两条独立链路。Agent 在线不代表目标端口一定能被 Cloudflare 访问。

## 后续设置

后台 UI 已提供常用配置入口：

- “设置”：站点名称、Logo、页脚、主题、TOTP 和告警。
- “探针”：节点信息、流量、价格、到期日、Agent 更新和 NodeQuality 报告。
- “Ping”：配置 VPS 主动测量的 TCP 目标。
- “Latency”：添加家庭宽带或其他网络位置的测量节点。
- “主题”与“插件”：分别上传符合规范的 ZIP 包。

第一次部署不需要先配置这些项目，可以在首台 VPS 正常上报后再逐项开启。

## 绑定自己的域名

在 Cloudflare Dashboard 中进入刚部署的 Worker，然后打开“设置”或“域和路由”，添加自定义域名即可。

绑定后使用：

```text
https://你的域名/
https://你的域名/admin
```

不需要修改前端 API 地址，一键部署版默认同域访问。

## 更新项目

Deploy Button 会在你的 GitHub 账号下创建 Fork。需要升级时：

1. 在 GitHub 打开自己的 Fork。
2. 使用 GitHub 提供的同步上游功能更新 `main` 分支。
3. 打开 Cloudflare 项目的部署页面。
4. 重新部署最新提交。

Agent 自动更新由后台开关控制。建议先在一台测试 VPS 上确认新版本，再批量开启。

## 常见问题

### 部署页面要求三个 Secret

这是正常步骤。模板不能替用户预设管理口令。

### 构建失败

先在 Cloudflare 构建日志中查看第一条错误。常见原因是 GitHub 授权未完成、Cloudflare 账号选错或临时下载失败。重新授权后再点一次部署即可。

### 后台能看到节点，但 Agent 没有数据

确认部署命令是在对应 VPS 上执行，并检查：

```bash
sudo cftz status
sudo cftz log 100
```

不要从另一台机器复制旧命令。

### External Latency Agent 显示“未上报”

仅在后台创建记录还不够。必须执行该节点生成的部署命令，并看到返回中的 `accepted` 大于 0。

### 如何彻底删除

在 Cloudflare Dashboard 中删除该 Worker、D1 数据库和 R2 存储桶，再删除 GitHub 中由部署流程创建的 Fork。

## 相关文档

- [后台使用](03-admin.md)
- [Agent 安装与维护](04-agent.md)
- [流量与账单](05-traffic-billing.md)
- [告警配置](06-alerts.md)
- [外部 Latency Agent](13-external-latency-agents.md)
- [主题与插件](14-extensions-developer-guide.md)
