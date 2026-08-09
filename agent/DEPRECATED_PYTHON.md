# 旧 Python 外部 Agent（已弃用）

`agent_orangepi.py` 与配套 systemd 模板是旧版外部探针，保留仅用于兼容老的家庭网络安装。新安装一律使用本目录的 Rust Agent。

旧脚本通过遗留端点 `/api/agent/targets` 与 `/api/agent/results` 工作，这两个端点只保留给 Python 兼容路径，不再扩展功能。
