# ADR-001：Map-first 与 Subagent 记忆执行

## 状态

已接受，待实现。

## 背景

dsh-Mnemosyne v0.2 已经生成 OKF Catalog、Root Index、Node Index、Memory Summary View 和 Memory Content View。现有 Recall Runtime 在主任务开始前独立调用模型逐层导航，正常情况下固定增加多次模型请求，且父 Agent 看不到地图和导航过程。

这与目标体验不一致：父 Agent 应该先知道项目记忆地图，只有判断需要时才进入记忆读取；记忆导航和沉淀过程应与父 Agent 的任务上下文隔离。

## 决策

采用 **Map-first + Recall/Consolidation Subagent + Legacy Recall Fallback**：

1. `pre-step` 只读取并校验当前 Generation，固定本轮 Generation，并提供有界的 Title 地图；不在默认路径调用独立导航模型。
2. 父 Agent 判断需要记忆后，启动 Recall Subagent。Subagent 在独立上下文中按 `Title → Summary → Content` 完成读取，并只向父 Agent 返回最终确认的 Content、Memory ref 和 receipt。
3. `turn/end` 后由 Consolidation Subagent 判断是否沉淀新经验，并负责 Memory、Catalog 和 Generation 的发布。
4. 用户不需要手动调用记忆工具，但可以看到 Map、Subagent 和阶段性运行状态。
5. 现有逐层 Recall 保留为 Legacy Recall，仅在 Map 或 Subagent 发生明确技术故障且旧视图仍可验证时最多兜底一次。

## 用户操作与可见性的定义

“用户零操作”只表示用户不需要输入记忆管理命令、不需要选择分类、不需要确认读取。它不表示运行过程必须隐藏。Session Event 和界面可以显示：

- 正在读取项目记忆；
- Recall Subagent 正在运行；
- 当前披露阶段；
- 找到记忆、无匹配或发生技术故障；
- 本轮是否完成 Consolidation。

## 不变量

- 地图、Summary 和 Content 均来自同一个已固定的不可变 Generation；
- 未披露的 ref 不能被选择；
- 未经过 Summary 判断不能读取 Content；
- 每轮最多披露 5 条 Summary、读取 3 条 Content；
- Scope 由当前 Agent Session 推导，不接受模型传入的 Project 或 Session 路径；
- Recall 失败不能阻止父 Agent 完成主任务；
- 正常 no-match 不触发 Legacy Recall；
- 安全、Scope、Hash 和 Generation 校验失败不允许通过兜底绕过；
- 不记录隐藏思考、Prompt 原文、完整用户消息或未选择的 Memory Content。

## 兜底判定

以下情况可以触发 Legacy Recall，最多一次：

- Map View 缺失或版本不兼容；
- Map 派生视图校验失败，但 Legacy 视图仍可独立验证；
- Recall Subagent 启动失败；
- Subagent 交互通道发生明确技术错误。

以下情况不触发兜底：

- 空记忆库；
- 地图正常但没有相关记忆；
- 父 Agent 判断不需要记忆；
- Subagent 正常运行但没有确认 Content；
- Scope、Hash、Generation 或权限校验失败。

## 被拒绝的方案

### 每轮默认调用四次独立导航模型

拒绝。它导致固定延迟，并让插件替父 Agent 完成语义判断。

### 预先注入所有 Summary 或 Content

拒绝。会破坏 `Title → Summary → Content` 的渐进式披露和上下文控制。

### 删除 Legacy Recall

拒绝。保留它作为地图或 Subagent 技术故障时的可用性兜底，但不得用于正常 no-match。

### 使用 RAG、Embedding 或向量检索

拒绝。本 ADR 继续采用 OKF 地图和模型语义导航，不引入 RAG 路线。

## 影响范围

- `src/v2/recall-runtime.ts`：冻结 Legacy 行为，新增 Map Offer、Subagent 入口和 receipt 校验；
- `src/v2/okf-compiler.ts`：复用现有 Generation 视图，必要时增加纯派生 Map View；
- `src/observer.ts`：接入 Map Offer、Subagent 生命周期、turn 状态和兜底；
- `src/v2/runtime-log.ts`：增加 map/subagent/fallback 路线和阶段耗时；
- DSH 公开 Subagent、Tool 和 Session Event 能力；不使用私有接口。

## 验收方向

1. 无相关记忆时不产生隐藏导航调用，也不触发 Legacy Recall；
2. 有相关记忆时，Subagent 完成 Title → Summary → Content，父 Agent 只收到最终 Content；
3. 地图损坏时最多触发一次 Legacy Recall；正常 no-match 不兜底；
4. 跨 Project、Session、Turn 和 Generation 的 receipt 全部拒绝；
5. Consolidation Subagent 能在 turn/end 后创建 Memory 或返回 skip；
6. 用户无需任何 Mnemosyne 手动操作，同时可以从界面和 JSONL 看到运行状态。

## 后续

本 ADR 只冻结架构选择，不包含实现代码。后续按 Map Offer、Recall Subagent、Consolidation Subagent、Fallback 和全量验收的顺序分步实施，每步独立测试和提交。
