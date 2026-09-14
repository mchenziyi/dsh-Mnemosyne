# Release Notes

## Governance Foundation（当前开发基线，未作为 npm 版本发布）

- Slice 1–6 已完成：协议与校验、纯 Replay、Ledger 与原子提交、版本化 Generation、Effective Projection、生产链路接入。
- 已覆盖 Recall / Consolidation 集成、CURRENT 事务、隐藏重复 Memory 防护、Project 并发串行、崩溃一致性与进程重启 E2E。
- Manual Smoke Test 已通过；后续 Proposal / Candidate、去重、过时治理与 Catalog Governance 仍未开始。

## v0.2.9（消息分支兼容修复）

- 修复 Mnemosyne 整理状态节点被识别为本轮最后 Chat Node，导致“在新对话中分支”按钮不可用的问题。
- 移除 Web Conversation Node 注册和 Chat Node 插槽注入；整理状态及其远端服务仍保留在插件内部，但暂不显示 Web 状态条。
- 不改变 V3、Recall、Consolidation 或 Session 生命周期，也不修改现有 Session 数据。

## v0.2.7（DSH 0.1.5-rc.1 兼容）

- 子代理创建显式传入 `parentAgent`，保持父 Agent 对 child 的运行时所有权。
- 使用新版 setup 回调传入的 child Agent，不再依赖已移除的 `Context.agent`。
- 测试适配 Session V3 中持久化的 system message，并验证子代理完成、销毁与进程退出。
- DSH 依赖与兼容审计基线统一升级为 `0.1.5-rc.1`。

## v0.2.6（模型用量归因诊断）

- 在项目级安全运行日志中区分父任务、Recall 与 Consolidation 的模型 Token 用量。
- 按 DSH 的互斥计数语义记录未缓存输入、缓存读取、缓存写入、输出与推理 Token。
- 失败和重试调用计入归因；上游未报告缓存字段时保持未知，不按零处理。
- 不记录 Prompt、用户正文、Memory Content、路径、凭据、provider 或模型名称。

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
