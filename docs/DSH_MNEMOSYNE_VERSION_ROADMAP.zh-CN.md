# dsh-Mnemosyne 版本路线图

> 状态：✅ v0.2.0 Completed / MVP Complete
>
> 更新日期：2026-09-10

## 一、版本原则

当前发布版默认架构：**V3（Map-first + Recall/Consolidation Subagent）**。版本号 `v0.2.x` 表示产品版本，V3 是该版本内的生产运行架构；V2 仅作为内部 fallback。

- 版本按用户可感知的完整能力划分，不按内部模块划分；
- 每个版本必须相对上一版解决一个明确问题；
- 只使用 DSH 已公开插件扩展，不要求修改 DSH；
- 设计文档先于代码，一个可审查行为一个提交；
- 记忆失败不得改变 DSH 主任务结果；
- 自进化、代码生成、自修改和自动发布不属于本路线。

~~~text
v0.1.0  工具式技术预览
  → v0.2.0 零操作 OKF 记忆 MVP（Completed）
  → v0.3.0 Memory Governance
  → v0.4.0 Pattern Layer
  → v0.5.0+ Plugin Evolution
  → v1.0.0 MVP 后：正式稳定版
~~~

## 二、v0.1.0：工具式技术预览（历史）

状态：已发布。

该版本验证了：

- DSH 插件装配和 Project/Session Scope；
- 不可变 Fact Store 与原子 Generation/CURRENT；
- Search/Open 分层读取；
- 自动采集、短期/长期、晋升与遗忘；
- 临时项目 Canary 与 npm 发布流程。

它依赖用户或模型调用记忆工具，并使用关键词式 Search，不是当前产品体验。v0.1 数据保留但不迁移到 v0.2。

旧 M0.5 和 MVP-00～07 执行计划已从当前文档目录删除，需要审计时从 Git 历史中的 v0.1 发布提交读取。

## 三、v0.2.0：零操作 OKF 记忆 MVP

状态：**Completed / MVP Complete**。本地连续观察与发布是发布运营活动，不是 MVP 功能完成 Gate。

相对 v0.1 的提升：

- 用户从手动/显式 Tool 管理变为只需正常对话；
- 每条记忆从普通 Fact/页面变为独立 OKF Memory；
- 检索从关键词打分变为模型阅读 Title 与 Summary 后自主选择；
- 披露严格遵循 Title → Summary → Content；
- 新经验在正常 turn 后自动沉淀为项目级持久记忆；
- 新踩坑创建关联新记忆，旧记忆保持不可变；
- 用户会话和生产包不再暴露记忆工具；
- 通过结构化 JSONL 解释 Recall 和 Consolidation。

完成 Gate：

- [x] v2 Memory Store 与 Catalog；
- [x] Title/Summary/Content Generation；
- [x] 无工具 Recall Runtime；
- [x] 自动 Consolidation Runtime；
- [x] 开发者 JSONL；
- [x] 最多三层的多层 Catalog 自动组织；
- [x] 绑定 Project Scope、父节点与 Title 的路径相关 Node ID；
- [x] Catalog depth=3 与 Recall budget=8 闭合；
- [x] 同项目并发沉淀不丢 Catalog 更新；
- [x] 下一轮 Recall 等待同 Project 已启动的 Consolidation，跨 Project 不互相阻塞；
- [x] 真实 AgentLoop 双 Session 自动沉淀与换措辞 Recall；
- [x] Project A 自动沉淀后 Project B Recall 不可见的跨项目 E2E；
- [x] 独立 DSH 进程退出、重启后从磁盘恢复 Recall 的 E2E；
- [x] 全量测试、构建、打包和发布边界门禁。

MVP 后发布运营事项：

1. 安装候选包并连续本地使用 3～7 天；
2. 按本地观察规范评估质量、漏召回、错误召回、延迟与磁盘增长；
3. 修复观察期发现的 P0/P1 问题后执行正式发布流程。

## 四、v0.3.0：Memory Governance

进入条件：v0.2 本地观察证明零操作记忆闭环有实际价值。

目标不是一次性开放全部治理操作，而是先建立可验证的 Governance 基础模型，再逐步开放治理能力。

实施顺序：

1. 治理基础模型；
2. Recall 可用性治理；
3. 去重 / 合并；
4. Revision / Supersede / Conflict；
5. 过时治理；
6. Catalog 治理。

治理不变量：

- 不物理删除 Memory；
- 不确定的冲突不自动选边；
- 模型建议与状态变更分离；
- 所有治理操作可审计、可回滚；
- Catalog 调整不改变 Memory 身份；
- 治理按增量执行，不要求全库重算。

具体能力包括：

- 建立治理状态、关系、建议、决策与审计记录的基础模型；
- 控制 Memory 是否进入正常 Recall，同时保留不可变历史；
- 识别并处理完全重复、高度相似和可互补合并的 Memory；
- 表达补充、替代、冲突和暂时无法判断的 Memory 关系；
- 管理已被替代、明确失效或长期无价值的 Memory；
- 治理分类重复、节点过宽、粒度失衡、错放和层级退化。

这些能力必须根据 v0.2 真实观察结果设计，不提前沿用 v0.1 的 Tool 协议，也不在基础模型稳定前同时开发多个治理阶段。

## 五、v0.4.0：Pattern Layer

进入条件：v0.3 能持续产出治理后的可信 Memory。

主要方向：

- 从多条真实、受治理的 Memory 中识别跨任务稳定规律；
- 保留 Pattern 的支持证据、适用范围、边界和演进关系；
- 防止一次性经验或未解决冲突被错误提升为 Pattern；
- 在后续经验中持续验证、修订或降级 Pattern。

Pattern 不是 Memory 的简单摘要，其输入必须是治理后的可信 Memory。

## 六、v0.5.0+：Plugin Evolution

进入条件：v0.4 已形成由治理后可信 Memory 支撑、经过持续验证的成熟 Pattern。

主要方向：

- 判断 Pattern 是否稳定、高频、可程序化且值得能力化；
- 生成 Candidate Plugin，并经过静态检查、权限审查、自动测试和 Sandbox E2E；
- 在安装前验证收益，安装后持续观察，并支持拒绝与回滚；
- 仅把确实优于 Recall Pattern 的成熟规律转化为 DSH Runtime 能力。

Plugin Evolution 依赖治理后的可信 Memory 及其形成的成熟 Pattern，不直接从未经治理的原始 Memory 生成能力。

## 七、v1.0.0：MVP 后的正式稳定版

进入条件：Memory Governance、Pattern Layer 与 Plugin Evolution 的目标范围经过长期使用验证。

主要工作：

- 冻结公开 Schema、错误码和迁移协议；
- 覆盖 v0.1、v0.2、v0.3 数据兼容或明确迁移；
- macOS/Linux 与受支持 DSH 版本矩阵；
- 性能、并发、磁盘和 Token 上限；
- 安装、升级、卸载、备份、恢复文档；
- 正式 Release 与兼容承诺。

## 八、通用开发门禁

~~~bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
corepack pnpm peers check
git diff --check
~~~

任何版本未通过自己的纵向验收，不为了版本号发布。
