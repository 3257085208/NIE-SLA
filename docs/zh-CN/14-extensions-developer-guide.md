# 14 主题、插件与开发者 API

NStatus 扩展系统允许管理员在后台上传 ZIP 包，并在不替换生产前端代码的情况下启用第三方主题或插件。v1 同时提供低风险 CSS 主题和高自由度的隔离交互画布。

## 能力与边界

| 类型 | 能力 | 安全边界 |
| --- | --- | --- |
| 原版主题 | 稳定的 `classic` 基础布局 | 内置代码 |
| CSS 主题 | 覆盖公开前端 CSS，可选择 `classic` 或卡片布局基座 | 不能执行脚本 |
| 交互画布主题 | 在独立页面中自行实现完整布局、交互与图表 | 无同源权限的 sandbox iframe，只能走只读消息 API |
| 第三方插件 | 增加独立面板并读取公开状态快照 | 在无 `allow-same-origin` 的 sandbox iframe 内运行 |
| 开发者 API | 构建替代前端、机器人、面板和只读集成 | `/api/v1` 只读，无管理写权限 |

交互画布主题和第三方插件都不能直接访问主页面 DOM、`sessionStorage`、后台 Token 或管理接口，且 iframe CSP 禁止主动联网。它们通过 `postMessage` 接收脱敏公开状态；交互主题还可以请求白名单内的只读开发者 API。

## 安装与回退

1. 后台进入“主题”或“插件”页面；两种包使用独立入口和存储路径。
2. 点击对应的“上传主题 ZIP”或“上传插件 ZIP”，选择不超过 8 MB 的包。
3. 后台先计算 ZIP SHA-256，Worker 对请求头和收到的完整包再次计算并比对，再校验清单、路径、文件类型、文件数和解压体积。
4. 新上传的扩展默认停用，管理员确认名称、作者和版本后手动启用。
5. 插件可以同时启用多个；第三方主题最多启用一个。
6. 停用第三方主题后，前端立即回到内置 `classic` 主题。

相同 `id` 的新 ZIP 会替换旧版本并保留其启用状态。删除扩展会删除注册记录和该版本的 R2 文件。

主题和插件建议各自维护为独立源码仓库。平台通用包格式、安全边界与 API 以本文为准；更严格的工程目录、命令、测试、版本和发布标准分别见 [15 主题工程与开发标准](15-theme-development-standard.md) 和 [16 插件工程与开发标准](16-plugin-development-standard.md)。

本规范参考了 NodeGet 将主题作为独立项目、使用显式清单、固定构建产物和标准开发命令的工程组织思路，但没有复制其实现。NStatus 扩展格式与 NodeGet 不兼容：CSS 主题不能执行脚本，交互主题与插件只能在 sandbox iframe 中获得 `status:read`，不能直接访问 DOM、管理 Token、网络或写接口。

## ZIP 通用规范

ZIP 根目录必须直接包含 `manifest.json`，不能再套一层目录：

```text
manifest.json
theme.css
assets/logo.webp
```

通用限制：

- ZIP 最大 8 MB，解压后最大 16 MB。
- 最多 300 个文件，单文件最大 4 MB。
- `manifest.json` 最大 64 KiB，必须是严格 UTF-8 JSON。
- 禁止绝对路径、空路径、`..`、反斜杠路径、目录穿越、重复文件名、控制字符、非 NFC Unicode、尾部空格/点和超过 8 层的路径。
- 允许扩展名：`.css`、`.html`、`.js`、`.json`、`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.svg`、`.woff`、`.woff2`。
- `id` 必须匹配 `[a-z][a-z0-9-]{2,48}`，发布后应保持不变。
- `classic`、`cards`、`admin`、`api`、`themes`、`plugins`、`extensions` 是系统保留 ID。
- `version` 必须使用 SemVer，例如 `1.2.0`。
- `schema` 固定为 `nstatus-extension-v1`。
- 推荐声明 HTTPS `repository`、`homepage`、SPDX 风格 `license` 和包内 `preview`。
- 可声明精确的 `files` 数组；其中可包含或省略根 `manifest.json`，平台会自动归一化。其余条目必须与 ZIP 内文件完全一致，不能夹带未列出的文件。
- 后台与 Worker 会分别计算完整 ZIP 的 SHA-256；不一致会拒绝上传。Worker 保存最终校验值，后台显示其前 16 位用于核对发布物。

在示例目录内创建包：

```bash
cd examples/extensions/theme-minimal
zip -r ../minimal-green-theme.zip .
```

不要压缩外层 `theme-minimal/` 目录本身，否则 `manifest.json` 不在 ZIP 根目录。

使用后台上传时，浏览器会自动发送 `x-extension-sha256`。直接调用管理 API 的工具也必须发送 64 位小写十六进制 SHA-256，并使用 `application/zip`、`application/x-zip-compressed` 或 `application/octet-stream` Content-Type；Worker 不接受只靠文件名判断的上传。

## 安全与供应链模型

- CSS 主题只能提供样式；需要脚本的 canvas 主题和插件使用双层隔离：iframe `sandbox="allow-scripts"`，HTML 响应自身也带 CSP `sandbox allow-scripts`。即使直接打开扩展 HTML，也没有同源存储、联网、表单、对象、Worker 或子页面权限。
- SVG 可包含主动内容，因此响应使用无脚本 CSP 与 `sandbox`；扩展资源同时带 `nosniff`、Referrer Policy 和受限 Permissions Policy。
- ZIP 先校验 Magic、Content-Type、客户端 SHA、压缩目录、Manifest 和真实解压字节数。不能只相信 ZIP 头声明的大小。
- 新版本写入独立 R2 revision。只有所有文件成功后才切换注册表；文件写入或注册表保存失败会删除新 revision，旧版本继续可用。注册表切换后才清理旧 revision。
- 扩展默认停用。管理员应核对作者、源码 tag、许可证、版本和发布页 SHA-256 后再启用；同 ID 升级也应重新审查权限与文件清单。
- 当前版本故意不提供“输入 URL/市场地址后由 Worker 下载并安装”。这避免把一个尚未充分约束的 SSRF 与供应链入口暴露给生产环境。

这些边界对照了公开项目中的成熟做法：Komari 对主题包、单文件、总解压量和 Manifest 分别限额，并在市场安装中绑定 SHA-256、限制响应体、校验每次重定向并对 DNS 失败采用 fail-closed；哪吒的受限 HTTP 客户端拒绝重定向、过滤内网地址并把连接固定到已校验 IP，更新接口也使用期望 SHA；NodeGet 将主题维护为独立工程，生成显式文件清单和可复现 ZIP。NStatus 采用其中的限额、校验、最小权限和独立发布思想，但不复制它们的运行时。

未来若增加远程市场，合并前必须同时实现：仅公网 HTTPS、DNS 全地址校验与连接固定、每一跳重定向重新校验、重定向次数/超时/响应体上限、目录清单与包 SHA 强绑定、下载后仍执行本章全部本地 ZIP 校验。任何一项失败都必须拒绝安装，不能回退到不安全下载。

## 主题开发规范

最小 `manifest.json`：

```json
{
  "schema": "nstatus-extension-v1",
  "id": "my-status-theme",
  "name": "My Status Theme",
  "version": "1.0.0",
  "type": "theme",
  "mode": "css",
  "author": "Developer Name",
  "description": "Short description",
  "base_theme": "classic",
  "styles": ["theme.css"]
}
```

字段规则：

- `mode` 默认为 `css`；CSS 主题必须声明 1 到 4 个 `styles`。
- `base_theme` 可为 `classic` 或 `cards`。`cards` 是只向主题包开放的布局基座，不再是后台可直接选择的内置主题。
- `styles` 必须包含 1 到 4 个 ZIP 内存在的 CSS 文件，按数组顺序加载。
- CSS 主题没有 `entry`，也不允许 JavaScript 生命周期。
- 主题应优先覆盖稳定 CSS 变量，而不是依赖深层 DOM：`--bg`、`--paper`、`--text`、`--soft`、`--muted`、`--line`、`--line-strong`、`--green`、`--green-dark`、`--green-soft`、`--red`、`--yellow`、`--blue`、`--radius`、`--shadow`、`--shadow-hover`、`--font`。
- 需要按扩展定向样式时使用 `body[data-extension-theme="EXTENSION_ID"]`。
- 必须同时检查桌面和移动端，不能隐藏状态、错误、Token 警告或可访问性焦点。

完整最小示例位于 `examples/extensions/theme-minimal/`。

官方卡片主题源包位于 `examples/extensions/theme-cards/`。将该目录中的 `manifest.json` 与 `theme.css` 放在 ZIP 根目录上传，即可启用原卡片布局。

### 交互画布主题

需要完全自定义 DOM、布局、交互或图表时使用隔离画布：

```json
{
  "schema": "nstatus-extension-v1",
  "id": "my-canvas-theme",
  "name": "My Canvas Theme",
  "version": "1.0.0",
  "type": "theme",
  "mode": "canvas",
  "entry": "index.html",
  "permissions": ["status:read"],
  "height": 900
}
```

画布 iframe 使用 `sandbox="allow-scripts"`，没有 `allow-same-origin`。主题发送 `{ type: "nstatus:ready" }` 后会收到与插件相同的 `nstatus:status` 消息；内容高度变化时发送 `{ type: "nstatus:resize", height }`。

主题需要历史数据时发送受控请求：

```js
parent.postMessage({
  type: 'nstatus:request',
  request_id: 'metrics-1',
  resource: 'metrics',
  query: { agent_id: 'vps-a', hours: 6 }
}, '*');
```

允许的 `resource` 只有 `status`、`checks`、`metrics`、`pings`、`latency`。父页面返回 `nstatus:response`，并强制使用 `/api/v1/*`、`credentials: omit`；主题不能指定 URL、方法、请求头或管理端点。完整示例位于 `examples/extensions/theme-canvas/`。

## 插件开发规范

插件清单：

```json
{
  "schema": "nstatus-extension-v1",
  "id": "my-status-plugin",
  "name": "My Status Plugin",
  "version": "1.0.0",
  "type": "plugin",
  "author": "Developer Name",
  "description": "Adds a read-only status panel",
  "entry": "index.html",
  "permissions": ["status:read"],
  "height": 360
}
```

v1 规则：

- `entry` 必须指向 ZIP 内的 HTML 文件。
- 唯一权限是 `status:read`；声明其他权限会拒绝安装。
- `height` 限制为 200 到 1200 像素，插件可以在运行时请求调整。
- HTML 内联脚本会被 CSP 拒绝，必须使用 `<script src="plugin.js"></script>`。
- CSP 为 `default-src 'none'`、`connect-src 'none'`、`form-action 'none'`；资源必须来自包内。
- iframe 使用 `sandbox="allow-scripts"`，没有 `allow-same-origin`、弹窗、表单或顶层导航权限。

### 消息协议

插件加载后通知父页面：

```js
parent.postMessage({ type: 'nstatus:ready' }, '*');
```

父页面发送状态：

```js
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'nstatus:status') return;
  const { api_version, payload } = event.data;
  // api_version === 'v1'; payload 与 GET /api/v1/status 的结构一致。
});
```

请求调整面板高度：

```js
parent.postMessage({ type: 'nstatus:resize', height: 480 }, '*');
```

父页面只接受来自已注册 iframe `contentWindow` 的已知消息，最终高度仍会限制在 200 到 1200。完整示例位于 `examples/extensions/plugin-status-summary/`。

## 版本化开发者 API

发现入口：

```bash
curl -fsSL https://YOUR-API/api/v1
```

稳定只读端点：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1` 或 `/api/v1/manifest` | 版本、能力和端点发现 |
| GET | `/api/v1/status?days=30&lite=1` | 公开状态、目标、汇总、事件和当前指标 |
| GET | `/api/v1/checks?target_id=ID&hours=72&limit=864` | 可用性检查历史 |
| GET | `/api/v1/metrics?agent_id=ID&hours=6` | VPS 指标历史 |
| GET | `/api/v1/pings?agent_id=ID&hours=6` | Agent TCP Ping 历史 |
| GET | `/api/v1/latency?target_id=ID&hours=24` | 外部 Latency 历史 |

响应带 `X-NStatus-API-Version: v1`。v1 可以增加可选字段，但不会静默删除或重命名已有字段。客户端必须忽略未知字段并处理 `null`。

服务端调用不受浏览器 CORS 影响。浏览器替代前端需要将精确 HTTPS Origin 加入 Worker 变量：

```toml
DEVELOPER_API_ORIGINS = "https://theme-dev.example.com,http://localhost:5173"
```

不支持 `*`；HTTP 只允许 localhost。这个白名单只作用于 `/api/v1` 只读端点，不会开放 Admin 或 Agent 写接口。

## 发布检查表

- `manifest.json` 在 ZIP 根目录且版本已提升。
- 没有 Token、私有 IP、生产域名、用户数据或构建缓存。
- CSS 主题在其声明的基础结构和移动端验证；交互主题在 320、375、768、1280、1440 宽度验证。
- 插件只消费收到的 `payload`，不假设所有字段存在。
- 所有文本通过 `textContent` 写入；不要把 API 字段直接拼接到 `innerHTML`。
- 停用、删除、同 ID 升级和回退到原版均已测试。
- 第三方包应提供源码、许可证、校验值和变更记录，管理员安装前应审阅。

扩展包不是 Cloudflare Worker 插件，也不能执行管理操作。需要写入目标、触发探测或读取私密配置的集成，必须等待未来的 scoped API Key 权限模型，不能复用 `ADMIN_TOKEN`。
