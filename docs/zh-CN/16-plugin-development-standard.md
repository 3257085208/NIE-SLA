# 16 插件工程与开发标准

本文规定 NIE-SLA 只读前台插件的工程、安全和发布标准。插件不是 Worker 插件，也不是后台管理扩展。

## 1. 仓库与目录

插件应作为独立仓库维护，推荐结构：

```text
nstatus-plugin-example/
  src/
    index.html
    plugin.js
    plugin.css
  manifest.json
  package.json
  README.md
  LICENSE
  CHANGELOG.md
  tests/
  dist/                 # 唯一打包输入
```

`dist/` 只能包含 Manifest 声明的运行文件。构建应固定文件名或同步更新 HTML 引用；不能依赖服务器路由、CDN、动态 import URL 或包外资源。

## 2. Manifest 与权限

```json
{
  "schema": "nstatus-extension-v1",
  "id": "example-plugin",
  "name": "Example Plugin",
  "version": "1.0.0",
  "type": "plugin",
  "author": "Developer",
  "description": "A read-only status panel.",
  "entry": "index.html",
  "permissions": ["status:read"],
  "height": 360
}
```

- `type` 固定为 `plugin`，`entry` 必须是包内 HTML。
- v1 唯一权限是 `status:read`，高度范围为 200 到 1200。
- iframe 只有 `sandbox="allow-scripts"`，没有同源、弹窗、表单或顶层导航权限。
- CSP 禁止联网、内联脚本和表单；JavaScript、CSS、图片与字体必须随包提供。
- 插件永远不能获取管理员密码、Session、Agent Token、管理接口、主页面 DOM 或浏览器存储。

## 3. 编码标准

- 只接受来自 `parent` 且 `type === "nstatus:status"` 的消息，忽略未知消息和字段。
- 所有 API 文本使用 `textContent` 或等价安全 DOM API，禁止直接拼入 `innerHTML`。
- 不假设字段必填；处理 `null`、空数组、网络延迟和重复状态消息。
- 事件监听器可重复初始化且不泄漏；渲染函数应对同一 payload 幂等。
- 使用语义化 HTML，所有交互可键盘访问，焦点可见，对比度满足 WCAG AA。
- 不进行指纹识别、遥测、广告、加密挖矿或用户数据持久化。

## 4. 消息协议与错误处理

加载完成发送 `{ type: "nstatus:ready" }`；收到状态后按 `api_version` 选择兼容解析。需要高度变化时发送 `{ type: "nstatus:resize", height }`，但仍按 200 到 1200 的宿主限制设计。

错误应在插件面板内部显示简洁的可恢复状态，不抛出未处理异常，不请求管理权限。宿主可能随时停用或销毁 iframe，插件不得依赖卸载回调完成关键写入。

## 5. 标准命令与测试

必须提供等价命令：

```bash
npm run dev
npm run build
npm run typecheck
npm test
npm run package
```

`build` 清空并生成 `dist/`；`package` 只压缩 `dist/`。测试至少覆盖：Manifest 校验、消息来源过滤、空/缺失字段、XSS 输入、重复消息、resize 上下限、窄屏、键盘访问和 CSP 下无网络运行。

## 6. 版本、许可证与发布验收

- 使用 SemVer；消息/UI 的兼容修复提升 PATCH，新功能提升 MINOR，移除字段兼容或改变用户数据解释提升 MAJOR。
- 提供 `LICENSE`、`README`、`CHANGELOG`、源码 tag、ZIP SHA-256 和可复现构建步骤。
- 发布前测试上传入口拒绝主题包，插件默认停用，启停/删除/升级正常。
- 用恶意 HTML 字符串、超长名称、大量目标和 `null` 指标做安全与布局测试。
- 禁止打包 sourcemap 中的路径、Token、生产数据、`.env`、测试快照和构建缓存。
