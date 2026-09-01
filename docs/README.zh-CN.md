# dsh-Mnemosyne 文档索引

本目录只保留当前产品设计与后续运行需要的文档。

## 当前有效文档

1. [当前架构](DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md)
   - v0.2 产品边界、运行时、规范对象和安全不变量。
2. [v0.2.0 实施计划](DSH_MNEMOSYNE_V020_ZERO_OPERATION_OKF_MEMORY_PLAN.zh-CN.md)
   - v0.2 冻结 Schema、渐进式披露顺序、测试与提交 Gate。
3. [v0.2 MVP 收口设计](DSH_MNEMOSYNE_V020_MVP_CLOSURE_DESIGN.zh-CN.md)
   - 多层 Catalog、路径 Node ID、Recall Budget、Project Barrier 与两项 E2E 验收结果。
4. [DSH Agent Runbook](DSH_MNEMOSYNE_DSH_AGENT_RUNBOOK.zh-CN.md)
   - 供 DSH Agent 执行安装、更新、卸载、验证和结果报告。
5. [本地观察期监控与评估规范](DSH_MNEMOSYNE_LOCAL_OBSERVATION_EVALUATION.zh-CN.md)
   - 安装候选包后 3～7 天的监控指标、诊断顺序和告警阈值。
6. [版本路线图](DSH_MNEMOSYNE_VERSION_ROADMAP.zh-CN.md)
   - v0.1 历史结论、v0.2 当前状态和后续版本方向。

## 文档优先级

发生冲突时按以下顺序解释：

~~~text
v0.2 MVP 收口设计
  > v0.2.0 实施计划
  > 当前架构
  > DSH Agent Runbook
  > 本地观察规范
  > 版本路线图
  > README
~~~

## 历史文档

v0.1.0、M0.5 和 MVP-00～07 的执行计划已从当前目录删除，避免旧 Tool、关键词检索、短期/长期与 Canary 协议被误认为当前设计。

这些内容没有从版本历史中消失。需要审计时使用 Git 历史中的 v0.1 发布提交，不应将其作为 v0.2 代码修改依据。
