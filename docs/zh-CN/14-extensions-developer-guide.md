# 14 主题、插件与开发者 API

NStatus 扩展系统允许管理员在后台上传 ZIP 包，并在不替换生产前端代码的情况下启用第三方主题或插件。v1 的设计目标是可移植、可回退和最小权限。

## 能力与边界

| 类型 | 能力 | 安全边界 |
| --- | --- | --- |
| 原版主题 | 后台选择 `classic` 或 `cards` | 内置代码 |
| 第三方主题 | 覆盖公开前端 CSS | 不能包含可执行主题脚本 |
| 第三方插件 | 增加独立面板并读取公开状态快照 | 在无 `allow-same-origin` 的 sandbox iframe 内运行 |
| 开发者 API | 构建替代前端、机器人、面板和只读集成 | `/api/v1` 只读，无管理写权限 |

第三方主题只允许 CSS。第三方插件不能直接访问主页面 DOM、`sessionStorage`、后台 Token 或管理接口，且插件页面 CSP 禁止主动联网。插件通过 `postMessage` 接收主页面已经获得的脱敏公开状态。

## 安装与回退

1. 后台进入“扩展”。
2. 点击“上传 ZIP”，选择不超过 2 MB 的扩展包。
3. Worker 校验清单、路径、文件类型、文件数和解压体积，然后将文件写入 R2。
4. 新上传的扩展默认停用，管理员确认名称、作者和版本后手动启用。
5. 插件可以同时启用多个；第三方主题最多启用一个。
6. 停用第三方主题后，前端立即回到“设置”页选择的原版 `classic` 或 `cards` 主题。

相同 `id` 的新 ZIP 会替换旧版本并保留其启用状态。删除扩展会删除注册记录和该版本的 R2 文件。

## ZIP 通用规范

ZIP 根目录必须直接包含 `manifest.json`，不能再套一层目录：

```text
manifest.json
theme.css
assets/logo.webp
```

通用限制：

- ZIP 最大 2 MB，解压后最大 5 MB。
- 最多 100 个文件，单文件最大 1 MB。
- 禁止绝对路径、空路径、`..`、反斜杠路径和目录穿越。
- 允许扩展名：`.css`、`.html`、`.js`、`.json`、`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.svg`、`.woff`、`.woff2`。
- `id` 必须匹配 `[a-z][a-z0-9-]{2,48}`，发布后应保持不变。
- `version` 必须使用 SemVer，例如 `1.2.0`。
- `schema` 固定为 `nstatus-extension-v1`。

在示例目录内创建包：

```bash
cd examples/extensions/theme-minimal
zip -r ../minimal-green-theme.zip .
```

不要压缩外层 `theme-minimal/` 目录本身，否则 `manifest.json` 不在 ZIP 根目录。

## 主题开发规范

最小 `manifest.json`：

```json
{
  "schema": "nstatus-extension-v1",
  "id": "my-status-theme",
  "name": "My Status Theme",
  "version": "1.0.0",
  "type": "theme",
  "author": "Developer Name",
  "description": "Short description",
  "base_theme": "classic",
  "styles": ["theme.css"]
}
```

字段规则：

- `base_theme` 只能是 `classic` 或 `cards`，表示 CSS 覆盖之前使用哪个内置结构。
- `styles` 必须包含 1 到 4 个 ZIP 内存在的 CSS 文件，按数组顺序加载。
- v1 主题没有 `entry`，也不允许 JavaScript 生命周期。
- 主题应优先覆盖稳定 CSS 变量，而不是依赖深层 DOM：`--bg`、`--paper`、`--text`、`--soft`、`--muted`、`--line`、`--line-strong`、`--green`、`--green-dark`、`--green-soft`、`--red`、`--yellow`、`--blue`、`--radius`、`--shadow`、`--shadow-hover`、`--font`。
- 需要按扩展定向样式时使用 `body[data-extension-theme="EXTENSION_ID"]`。
- 必须同时检查桌面和移动端，不能隐藏状态、错误、Token 警告或可访问性焦点。

完整最小示例位于 `examples/extensions/theme-minimal/`。

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
- 主题在 `classic`/`cards` 基础结构和移动端均验证。
- 插件只消费收到的 `payload`，不假设所有字段存在。
- 所有文本通过 `textContent` 写入；不要把 API 字段直接拼接到 `innerHTML`。
- 停用、删除、同 ID 升级和回退到原版均已测试。
- 第三方包应提供源码、许可证、校验值和变更记录，管理员安装前应审阅。

扩展包不是 Cloudflare Worker 插件，也不能执行管理操作。需要写入目标、触发探测或读取私密配置的集成，必须等待未来的 scoped API Key 权限模型，不能复用 `ADMIN_TOKEN`。
