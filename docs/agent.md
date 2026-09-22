# Agent 安装与维护

完整指南：

- 中文：[Agent](zh-CN/04-agent.md)
- English: [Agent](en/04-agent.md)

## 替换第三方探针（--replace-agent）

安装时可用 `--replace-agent <auto|nezha|komari|nodeget>`（或环境变量 `NIE_SLA_REPLACE_AGENT`）先停止并禁用 NeZha / Komari / NodeGet 旧探针服务，只禁用不自启、不删除任何文件；默认不处理。详见 [中文 Agent 文档](zh-CN/04-agent.md)。
