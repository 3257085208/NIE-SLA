# Cloudflare 一键部署（新手版）

这是推荐部署方式。第一次部署不需要命令行，也不需要先购买服务器作为控制端。

## 先准备四项内容

1. 一个 GitHub 账号。
2. 一个 Cloudflare 账号。
3. 一个后台账号，例如 `admin`。
4. 三段互不相同的密码或密钥。

建议用密码管理器生成并保存：

| 部署页面名称 | 应填写什么 |
| --- | --- |
| `ADMIN_USERNAME` | 后台账号，例如 `admin` |
| `ADMIN_PASSWORD` | 至少 20 位的随机密码 |
| `AGENT_TOKEN` | 至少 32 字节的随机值 |
| `TOTP_ENCRYPTION_KEY` | 另一段至少 32 字节的随机值 |

不要把这些内容发到论坛、Issue、截图或公开仓库。

## 第一步：点击部署按钮

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/3257085208/NIE-SLA)

进入页面后按提示继续即可。Cloudflare 可能会先要求登录 GitHub并创建 Fork，这是正常流程。

## 第二步：授权 GitHub 和 Cloudflare

依次完成：

1. 登录 GitHub。
2. 同意 Cloudflare 创建项目 Fork。
3. 登录 Cloudflare。
4. 选择自己的 Cloudflare 账号。
5. 填写上面的四项部署变量。
6. 点击部署。

其余选项第一次使用保持默认即可。

## 第三步：等待部署完成

Cloudflare 会自动完成：

- 构建 Worker 和网页。
- 创建 D1 数据库。
- 创建 R2 存储桶。
- 配置每分钟定时任务。
- 配置 Durable Object。
- 下载并校验 Agent 发布文件。

通常需要几分钟。完成后页面会给出一个 `workers.dev` 地址。

## 第四步：登录后台

假设部署后的地址是：

```text
https://你的项目.你的账号.workers.dev
```

后台地址就是：

```text
https://你的项目.你的账号.workers.dev/admin
```

使用刚才填写的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录。

登录后建议打开“设置 → TOTP”，用验证器应用开启二次验证。

## 第五步：添加第一台 VPS

进入后台后：

1. 打开“探针”。
2. 点击“新增”。
3. 填写 VPS 名称、主机和端口。
4. 保存。
5. 点击该 VPS 的“部署”。
6. 选择 Linux 或 Windows。
7. 把页面生成的命令放到对应 VPS 执行。

每台 VPS 的命令都包含独立凭据，不要把一台机器的命令复制给另一台，也不要公开完整命令。

Agent 上报成功后，前台会出现 CPU、内存、磁盘、网络和可用率数据。

## 第六步：检查是否正常

确认：

- 首页可以打开。
- `/admin` 可以用账号密码登录。
- 新增的 VPS 出现在首页。
- 后台“最近上报”持续更新。
- CPU、内存和磁盘不再是空值。
- 当前状态通常在约 1 分钟内刷新。

实时状态和 SLA 历史是两层数据：当前状态默认每分钟更新，日格与 SLA 历史仍按 5 分钟保存，避免快速耗尽 Cloudflare 免费额度。

## 可选：启用 GitHub 登录

不需要 GitHub 登录可以跳过本节。

### 1. 创建 GitHub OAuth App

打开 GitHub：

```text
Settings → Developer settings → OAuth Apps → New OAuth App
```

填写：

| GitHub 字段 | 内容 |
| --- | --- |
| Application name | `NIE-SLA` 或任意名称 |
| Homepage URL | 你的状态页地址 |
| Authorization callback URL | `你的状态页地址/api/auth/github/callback` |

例如：

```text
https://status.example.com/api/auth/github/callback
```

创建后记下 `Client ID`，再点击生成 `Client Secret`。

### 2. 添加 Cloudflare 变量

打开 Cloudflare Dashboard 中刚部署的 Worker，进入“设置 → 变量和机密”，添加：

| 名称 | 内容 |
| --- | --- |
| `GITHUB_OAUTH_CLIENT_ID` | GitHub Client ID |
| `GITHUB_OAUTH_CLIENT_SECRET` | GitHub Client Secret，类型选 Secret |
| `GITHUB_OAUTH_ALLOWED_USERS` | 允许登录的 GitHub 用户名；多个用英文逗号分隔 |

保存并重新打开 `/admin`，登录框会出现“使用 GitHub 登录”。没有出现在白名单中的 GitHub 账号无法进入后台。已启用 TOTP 时，GitHub 登录也需要验证码。

## 可选：启用邮件报警

邮件使用 Resend 的 HTTPS API，不需要在 Worker 中运行 SMTP。

1. 注册 Resend。
2. 在 Resend 验证自己的发件域名。
3. 创建 API Key。
4. 打开后台“设置 → 报警通知”。
5. 开启“电子邮件通知”。
6. 填写 API Key、发件人和收件人。
7. 先保存，再点击“测试邮件”。

多个收件人用英文逗号分隔。发件人必须属于已在 Resend 验证的域名。

## 绑定自己的域名

在 Cloudflare Dashboard 中打开 Worker 的“域和路由”，添加自己的域名。绑定后首页和 `/admin` 继续使用同一个域名。

如果启用了 GitHub 登录，域名改变后还要同步修改 GitHub OAuth App 的 Homepage URL 和 callback URL。

## 更新

一键部署会在 GitHub 账号下创建 Fork。升级时：

1. 打开自己的 Fork。
2. 点击 GitHub 的“Sync fork”。
3. 回到 Cloudflare 重新部署最新提交。

Agent 自动更新由后台开关控制，建议先用一台 VPS 验证新版本。

## 常见问题

### 老版本升级后密码是什么

默认账号是 `admin`。如果还没有设置 `ADMIN_PASSWORD`，旧 `ADMIN_TOKEN` 会暂时作为登录密码，登录后应尽快在 Cloudflare 中设置新的 `ADMIN_PASSWORD`。

### 后台能看到 VPS，但没有 Agent 数据

确认在对应 VPS 执行了该节点生成的部署命令，然后运行：

```bash
sudo cftz status
sudo cftz log 100
```

### GitHub 按钮没有出现

检查三个 `GITHUB_OAUTH_*` 变量是否都已设置，并确认 callback URL 与当前状态页域名完全一致。

### 测试邮件失败

先检查 Resend 发件域名是否验证完成，再检查 API Key、发件人和收件人。后台会显示 Resend 返回的 HTTP 错误。

### External Latency Agent 显示未上报

创建后台记录后还必须执行该节点生成的部署命令，并确认返回中的 `accepted` 大于 0。

## 下一步

- [后台使用](03-admin.md)
- [Agent 安装与维护](04-agent.md)
- [报警通知](06-alerts.md)
- [外部 Latency Agent](13-external-latency-agents.md)
- [主题与插件](14-extensions-developer-guide.md)
