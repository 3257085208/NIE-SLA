# 第三方主题开发

后台“主题”页面上传符合 `nie-sla-theme-v1` 的 ZIP。上传或覆盖更新后默认停用，管理员手动启用；一次最多启用一个主题，停用后立即恢复原版界面。

## 主题类型

CSS 主题沿用原版 HTML、数据与交互，只覆盖公开状态页样式，包内不能执行 JavaScript。建议用主题 ID 限定选择器：

```css
body[data-extension-theme="example-clean"] .system-banner {
  border-radius: 0;
}
```

CSS 能读取公开页已经展示的数据与元素结构，仍应只安装可信来源。主题不会应用到管理后台。

Canvas 主题可以完全重写公开状态页布局。入口 HTML 运行在 `sandbox="allow-scripts"` 且没有 `allow-same-origin` 的 iframe 中，并受独立 CSP 约束：不能读取主页面 DOM、Cookie、Local Storage 或管理 Session；不能提交表单、打开子窗口、加载对象或主动访问网络；只能通过消息协议读取脱敏公开数据；只能声明 `status:read` 权限。所有 HTML、CSS、JavaScript、字体与图片都要打进 ZIP。

## ZIP 结构与限制

`manifest.json` 必须位于 ZIP 根目录：

```text
my-theme.zip
|-- manifest.json
|-- theme.css
|-- index.html
|-- theme.js
`-- assets/logo.webp
```

Worker 同时检查：

- ZIP 最大 8 MB，解压后最大 16 MB。
- 最多 300 个文件，单文件最大 4 MB。
- `manifest.json` 最大 64 KiB。
- 路径必须是 NFC Unicode、最多 8 层，禁止绝对路径、反斜杠、空目录段、`.`、`..`、控制字符与重复路径。
- 允许 `.css`、`.html`、`.js`、`.json`、常用网页图片与 WOFF/WOFF2 字体。
- 浏览器计算 SHA-256，Worker 重新计算并强制比对。

## Manifest

CSS 主题示例：

```json
{
  "schema": "nie-sla-theme-v1",
  "id": "example-clean",
  "name": "Example Clean",
  "version": "1.0.0",
  "type": "theme",
  "mode": "css",
  "styles": ["theme.css"],
  "author": "Example Author",
  "description": "A minimal CSS theme.",
  "license": "MIT",
  "files": ["manifest.json", "theme.css"]
}
```

Canvas 主题把 `mode` 改为 `canvas`，并声明 `entry`、`permissions` 与 `height`：

```json
{
  "entry": "index.html",
  "permissions": ["status:read"],
  "height": 1000
}
```

字段要求：

| 字段 | 要求 |
| --- | --- |
| `schema` | 固定 `nie-sla-theme-v1` |
| `id` | 3-49 位小写字母、数字或连字符，以字母开头；发布后保持稳定 |
| `name` | 1-64 个字符 |
| `version` | SemVer，如 `1.2.0` 或 `1.2.0-beta.1` |
| `type` | 固定 `theme` |
| `mode` | `css` 或 `canvas` |
| `styles` | CSS 模式必填，1-4 个包内 CSS 文件 |
| `entry` | Canvas 模式必填，指向包内 HTML |
| `permissions` | Canvas 模式必须且只能是 `["status:read"]` |
| `height` | Canvas 初始高度，400–12000 px，运行时可更新 |
| `files` | 推荐填写，必须与 ZIP 内文件完全一致（含 `manifest.json`） |
| `preview` | 可选，指向包内图片 |
| `repository` / `homepage` | 可选，只接受无凭据的 HTTPS URL |
| `license` | 可选，SPDX 风格标识 |

## Canvas 消息协议

主题加载后先通知父页面：

```js
parent.postMessage({ type: "nie-sla:ready" }, "*");
```

父页面推送最新公开状态：

```js
{
  type: "nie-sla:status",
  api_version: "v1",
  payload: { /* /api/status 的脱敏内容 */ }
}
```

需要其他只读数据时发送请求：

```js
parent.postMessage({
  type: "nie-sla:request",
  request_id: "metrics-1",
  resource: "metrics",
  query: { agent_id: "target-id", hours: 24 }
}, "*");
```

允许的 `resource` 只有 `status`、`checks`、`metrics`、`pings`、`latency`。响应：

```js
{
  type: "nie-sla:response",
  api_version: "v1",
  request_id: "metrics-1",
  ok: true,
  payload: {}
}
```

失败时 `ok` 为 `false` 并提供短错误信息。内容变化后可以请求高度：

```js
parent.postMessage({ type: "nie-sla:resize", height: document.documentElement.scrollHeight }, "*");
```

所有消息接收器都应检查 `event.data`、消息类型与字段类型，不要把公开数据直接拼进 `innerHTML`。

## 发布标准

1. 在 390 px 手机、平板与桌面宽度测试，无横向溢出。
2. 保留清晰的在线、故障、未知与丢包状态，不只依赖颜色。
3. 支持键盘操作、可见焦点、语义标题与 `prefers-reduced-motion`。
4. 不伪装成官方主题，明确作者、版本、许可证与源码地址。
5. 从干净目录生成 ZIP，并单独发布 SHA-256：`shasum -a 256 theme.zip`。
6. 更新时保持 `id` 不变并提高 SemVer；覆盖上传后由管理员重新启用。

可运行示例位于 `examples/themes/minimal-css/` 与 `examples/themes/minimal-canvas/`。

## 备份与迁移

主题注册信息在 D1，ZIP 解压文件在 R2。便携 JSON 备份不包含 R2 文件；迁移部署时复用或单独复制原 R2，无法迁移 R2 时在新环境重新上传主题 ZIP。
