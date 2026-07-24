# 15 主题工程与开发标准

本文规定 NIE-SLA 第三方主题从源码仓库到可上传 ZIP 的工程标准。平台包格式与公共 API 先阅读 [14 主题、插件与开发者 API](14-extensions-developer-guide.md)。

## 1. 仓库与目录

主题应作为独立仓库维护，推荐结构：

```text
nstatus-theme-example/
  src/
    theme.css
    index.html            # canvas 模式使用
    theme.js              # canvas 模式使用
    assets/
  manifest.json
  package.json
  README.md
  LICENSE
  CHANGELOG.md
  tests/
  dist/                 # build 生成，ZIP 根目录来源
```

源码只放在 `src/`，可上传文件只放在 `dist/`。`dist/manifest.json` 必须位于 ZIP 根目录，禁止把源码、Token、`.env`、缓存、截图源文件或 `node_modules` 打包进去。

## 2. Manifest 与兼容性

通用必填字段为 `schema`、`id`、`name`、`version`、`type`；`type` 固定为 `theme`。CSS 模式需要 `styles`，交互画布模式需要 `entry` 与 `permissions`。

```json
{
  "schema": "nstatus-extension-v1",
  "id": "example-theme",
  "name": "Example Theme",
  "version": "1.0.0",
  "type": "theme",
  "mode": "css",
  "author": "Developer",
  "description": "A restrained NIE-SLA theme.",
  "base_theme": "classic",
  "styles": ["theme.css"]
}
```

- `id` 发布后永久稳定；分叉项目必须使用新 ID。
- `mode` 可为 `css` 或 `canvas`；省略时按 `css` 处理。
- CSS 模式的 `base_theme` 可为 `classic` 或 `cards`，后者是主题专用布局基座。
- `styles` 按顺序加载，限 1 到 4 个包内 CSS 文件。
- canvas 模式必须提供包内 HTML `entry`，权限仅允许 `status:read`，高度限制为 400 到 12000。
- canvas 脚本只能在无同源权限的 sandbox iframe 中执行；所有资源必须在包内，不能主动联网。
- 兼容版本内只能新增可选样式；依赖新的 DOM 或变量时提升主题次版本并写入变更记录。

## 3. 编码与设计标准

- 优先覆盖文档列出的稳定 CSS 变量，不依赖深层 `nth-child` 或临时 class。
- 必须使用 `body[data-extension-theme="example-theme"]` 限定主题专属规则。
- 正文、状态、错误、焦点和交互控件不可隐藏；颜色不能成为唯一状态信号。
- 正文与背景对比度至少 4.5:1，大号文字至少 3:1；保留清晰的 `:focus-visible`。
- 在 320、375、768、1280 和 1440 像素宽度验证，无横向溢出、遮挡或文本截断。
- 尊重 `prefers-reduced-motion`；动画不能影响状态读取。
- 字体必须提供系统回退，不允许为装饰引入大体积字体。
- canvas 模式必须使用 `textContent` 或安全 DOM API 渲染 API 字符串，并忽略未知字段。
- canvas 模式必须实现 `nstatus:ready`、`nstatus:status` 和动态高度 `nstatus:resize`；历史数据只能使用规定的 `nstatus:request` 白名单。

## 4. 标准命令

仓库可以选择任意构建工具，但必须提供这些等价命令：

```bash
npm run dev
npm run build
npm run typecheck
npm test
npm run package
```

`build` 必须清空并重建 `dist/`；`package` 只能从 `dist/` 生成 `release/<id>-<version>.zip`。纯 CSS 项目的 `typecheck` 可以执行 Manifest schema、CSS 语法和路径检查，但不能是无操作脚本。

## 5. 测试与发布验收

- ZIP 安装、默认停用、启用、停用、删除和同 ID 升级均通过。
- CSS 模式在声明的基础结构检查；canvas 模式独立检查桌面/移动端、浅色/深色系统偏好。
- 状态正常、离线、延迟、待检查以及长商家名/标签均不破版。
- 包内没有绝对 URL、凭据、私有基础设施或未授权素材。
- `version` 使用 SemVer：修复为 PATCH，兼容新增为 MINOR，破坏性变化为 MAJOR。
- 发布必须带 `LICENSE`、`README`、`CHANGELOG` 和 ZIP SHA-256；第三方素材需列明许可证。

只有源码提交、测试结果、Manifest 版本、ZIP 文件名和校验值一致时才可发布。
