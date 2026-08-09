# IPv6、AAAA 与 Cloudflare TCP 探测

IPv6-only VPS 经常出现“Agent 在线但 CF Latency 失败”。本文说明原因与正确配置。

## 先区分方向

```text
Agent 上报：VPS -> HTTPS -> Worker
CF 探测：Worker/DO -> TCP -> VPS
```

第一条成功只证明 VPS 有出站网络，不能证明 Cloudflare 可以从外部连接 VPS 的监听端口。

## IPv6 与端口格式

IPv6 自身包含冒号，拼成 `主机:端口` 时必须加方括号：

```text
[2001:db8::10]:2828
```

项目内部不拼字符串，而是保存两个字段：`target_host = 2001:db8::10`、`target_port = 2828`，调用 `connect({ hostname, port })`。所以后台主机字段只填 IPv6（不带 `[]`），端口填在端口字段；页面展示时格式化为 `[IPv6]:port`。

## 为什么直接 IPv6 可能失败

Workers 的 `cloudflare:sockets` 提供出站 TCP，但有平台限制。官方把以下错误解释为目标地址被判定为不允许连接：

```text
proxy request failed, cannot connect to the specified address
```

常见禁止目标包括：Cloudflare 自己的 IP 段、localhost 与私网地址、连接回发起请求的 Worker（TCP loop）、端口 25，以及平台内部判定的其他地址。Cloudflare 有 IPv6 边缘节点，不代表对所有 IPv6 字面地址、ASN 与路由都保证可达。

## 为什么 AAAA 域名可能成功

DNS-only AAAA 使调用变为：

```text
connect(hostname)
  -> Cloudflare DNS 解析 AAAA
  -> TCP Socket 连接解析后的 IPv6
```

这条路径与直接提交字面地址不同。实际部署中可能出现“字面 IPv6 被拒绝、同地址的 AAAA 域名成功”，说明 VPS 与端口正常，差异在 Cloudflare 的目标解析/策略路径。

## 创建 AAAA

在 DNS 服务商添加：

```text
Type: AAAA
Name: probe-vps
Content: VPS 的公网 IPv6
Proxy status: DNS only
TTL: Auto
```

得到 `probe-vps.example.com -> 2001:db8::10`。域名托管在 Cloudflare 时，灰云是 DNS only，橙云是代理。

## 为什么不能开橙云

开启橙云后，AAAA 查询通常返回 Cloudflare 代理地址而不是 VPS 原始地址；Workers TCP Socket 明确禁止连接 Cloudflare IP，可能直接返回 disallowed address 或 TCP loop。另外 Cloudflare 普通代理不代理任意 TCP 端口，`2828` 这类端口不会因为开橙云自动获得 TCP 代理能力（除非使用 Spectrum 等产品）。

## 后台配置

```text
类型：TCP
主机：probe-vps.example.com
端口：2828
区域：按需要选择，例如 APAC
超时：5000 ms
间隔：300 秒
```

保存后点击立即检查，或等下一次 Cron。成功条件：`ok=1`、`latency_ms` 有数值、错误为空、检查详情显示配置区域。

## VPS 侧检查

```bash
ip -6 addr show scope global
ip -6 route show default
sudo ss -lntp | grep ':2828'
```

理想输出监听 `[::]:2828` 或具体公网 IPv6；只监听 `0.0.0.0:2828` 不一定接受 IPv6。防火墙检查：

```bash
sudo nft list ruleset
sudo ip6tables -S
sudo ufw status verbose
```

还要检查服务商安全组、VPC ACL 与上游防火墙。

从另一条公网 IPv6 测试：

```bash
nc -6 -vz probe-vps.example.com 2828
curl -6 -v telnet://probe-vps.example.com:2828
```

普通公网 IPv6 成功但 Worker 返回 disallowed，偏向 Cloudflare 平台策略；普通公网也失败，先修 VPS 监听或防火墙。

## DNS 验证

```bash
dig AAAA probe-vps.example.com +short
```

检查返回地址是否与 VPS 一致、是否有多个旧地址、是否误开代理、是否存在 split DNS。

## 如何阅读页面

| 页面现象 | 结论 |
| --- | --- |
| Agent 在线，CF Latency 正常 | VPS 在线且 CF 可访问端口 |
| Agent 在线，CF Latency `-` | VPS 能上报，但 CF 无法连接端口 |
| Agent 离线，CF Latency 正常 | 服务端口可访问，但 Agent 停止/上报失败 |
| 两者都离线 | VPS、网络或两条链路同时异常 |

日色块统计 CF 探测成功率，不是 Agent 心跳率。修改 AAAA 后旧红色历史不会被重写，新 5 分钟桶会逐步提高当天成功率。

## 错误对照

- `proxy request failed, cannot connect to the specified address`：目标被拒绝。优先检查是否为 Cloudflare IP、私网、Worker loop、直接 IPv6 字面地址；尝试 DNS-only AAAA。
- `connection refused`：网络到达主机，但端口没有监听或主机明确拒绝。
- `timeout`：防火墙丢包、路由不可达、服务卡死或超时太短。
- `TCP Loop detected`：目标最终回到发起探测的 Worker/Cloudflare 路径。关闭橙云或换真实源站域名。

## 决策树

```text
Agent 是否在线？
  否 -> 查 Agent 服务、Token、HTTPS、日志
  是
   |
CF TCP 是否成功？
  是 -> 配置完成
  否
   |
外部 IPv6 能否连接端口？
  否 -> 查监听、防火墙、安全组、路由
  是
   |
是否直接填写 IPv6？
  是 -> 创建 DNS-only AAAA 后重试
  否
   |
确认域名未开橙云；仍失败则视为 CF 到该前缀的限制
```

## 安全注意

- 探测域名只需 AAAA，不要在 TXT 记录放 Token。
- 不要为探测临时开放不需要的管理端口。
- 选择本来就应公网开放的 TCP 服务端口。
- 用 SSH 端口探测时，仍应使用密钥登录、关闭密码登录并限制管理面。
- 页面可配置隐藏端口与掩码 IP，但 DNS 名称本身是公开信息。

官方参考：https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
