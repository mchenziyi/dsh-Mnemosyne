# Release Notes

## v0.2.5（整理状态节点位置修复）

- 将状态节点放在 turn-tail 之后的独立排序位置，避免同一 `turn/end` 锚点被内置节点覆盖。

## v0.2.4（整理状态客户端装配修复）

- Web 客户端插件改为启动时立即加载，避免自定义整理状态节点因延迟装配而缺失。

## v0.2.3（整理状态可见性修复）

- 客户端状态节点挂载后立即显示“正在整理项目记忆…”，避免快速任务因远程状态尚未返回而出现空白。

## v0.2.2（DSH 0.1.3-alpha.2 适配）

- 生产入口默认启用 V3：Map-first Recall 与 Recall/Consolidation Subagent。
- V2 不再作为默认 Runtime，仅保留内部兼容 fallback。
- 适配 DSH alpha.2 移除的 `seedDescriptorTurn` API，按官方 SubagentRuntime 的公开生命周期在未发布的子会话 setup 窗口写入 `subagent/descriptor`。
- 安装后无需测试参数或隐藏配置；E2E 从最终包入口验证默认架构。
