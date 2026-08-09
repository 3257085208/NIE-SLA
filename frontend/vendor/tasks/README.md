# 固定动作的源码快照

本目录保存 NIE-SLA 固定动作（NodeQuality 与 IP 解锁检测）使用的上游脚本快照，随站点分发，与 NIE-SLA 应用本体分开授权（GNU Affero General Public License v3.0）。

`manifest.json` 记录每个快照对应的上游 commit 与 SHA-256。Agent 只下载这些同源资产，执行前用硬编码摘要校验。运行时，Agent 会注入其公开 Rust 源码中实现的 NodeQuality 结果采集钩子。

两点边界需要明确：

- 上游脚本可能下载额外工具与数据集，这些次级下载不在入口摘要的覆盖范围内。
- 两个固定诊断需要 raw socket、路由探测与系统工具，由 NIE-SLA 的 root-only Manager 执行；普通遥测仍由低权限 `nstatus` 服务运行。Manager 只接受这两个固定动作，并强制私有目录、拒绝符号链接、固定环境、超时与输出上限。

上游项目与 NIE-SLA 无关，也不为 NIE-SLA 背书。对应许可证文本见 `AGPL-3.0.txt`。
