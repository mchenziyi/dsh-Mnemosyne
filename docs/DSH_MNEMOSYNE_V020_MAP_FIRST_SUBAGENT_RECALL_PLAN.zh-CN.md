# dsh-Mnemosyne v0.2 Recall Map-first 与 Subagent 开发设计

> 状态：实现中（Map Offer、Recall Subagent 与 Disclosure Receipt 已完成；生产装配与 Consolidation Subagent 待完成）
>
> 范围：仅解决“主模型使用 OKF 地图”和“Mnemosyne 记忆操作由 Subagent 执行”两项问题。现有 Legacy Recall 保留为技术兜底。

## 一、目标

当前 Mnemosyne 已经生成 Catalog、Root Index、Node Index、Summary View 和 Content View，但 Recall Runtime 会在主任务开始前独立调用模型多次完成导航，导致固定延迟，并使主 Agent 看不到地图。

本设计的目标是：

1. 主 Agent 能看到有限的 OKF Title 地图，并自行决定是否需要记忆；
2. Recall 与 Consolidation 在独立 Subagent 中执行，避免导航过程污染父 Agent 上下文；
3. 用户不需要手动调用任何记忆操作，但可以看到插件和 Subagent 的运行过程；
4. 现有 Legacy Recall 在新路径发生明确技术故障时仍可兜底。

## 二、总体流程

```text
用户提出任务
  ↓
父 Agent 看到 Title 地图
  ↓
父 Agent 判断是否需要记忆
  ↓
需要 → 启动 Recall Subagent
  ↓
Subagent 按 Title → Summary → Content 渐进读取
  ↓
返回最终确认的 Memory Content
  ↓
父 Agent 继续完成任务

地图或 Subagent 技术故障
  ↓
Legacy Recall 最多兜底一次
```

任务结束后：

```text
正常 turn/end
  ↓
Consolidation Subagent
  ↓
判断是否产生可复用经验
  ↓
生成 Memory、更新 Catalog、发布 Generation
```

## 三、需求一：提供 OKF 地图能力

### 3.1 Map Offer

`pre-step` 只做确定性工作：读取并验证当前 Generation，固定本轮 `generation_id`，生成 Map Offer，并将其作为插件上下文提供给父 Agent。

Map Offer 只包含：

- 分类路径；
- 分类 Title；
- Memory Title；
- 稳定 ref；
- 有界分页信息。

Map Offer 不包含：

- Summary；
- Content；
- Prompt；
- 隐藏思考；
- 关键词分数或向量结果。

### 3.2 地图边界

- 地图来自现有 Generation，不新增第二事实源；
- 使用固定的字节上限和确定性分页；
- 超出上限时折叠为路径节点并提供 cursor，不静默截断；
- 当前 Generation 在本轮固定，不能因后台发布新 Generation 而漂移；
- `related_memory_refs` 不进入初始地图，只在最终 Content 中显示相关 Memory Title。

## 四、需求二：Subagent 执行 Mnemosyne 操作

### 4.1 Recall Subagent

父 Agent 需要记忆时启动 Recall Subagent，并传入最小 Task Packet：

- 当前任务摘要；
- Project / Session Scope；
- 已固定的 Generation；
- Map Offer。

Subagent 在独立上下文中执行：

```text
选择 Title
→ 请求并阅读对应 Summary
→ 判断是否继续
→ 请求并读取最终 Content
→ 返回最多 3 条确认 Memory
```

父 Agent 只接收最终 Content、Memory ref 和 receipt，不接收候选筛选过程。

### 4.2 Consolidation Subagent

`turn/end` 后启动 Consolidation Subagent，负责：

- 判断本轮是否有新经验；
- 生成 Title、Summary、Content；
- 选择已有 Catalog 节点或创建新节点；
- 写入 v2 Memory Store；
- 更新 Catalog 并发布 Generation。

父 Agent 只接收 `created`、`skip`、`noop` 或 `failed` 结果。

### 4.3 用户可见性

用户不需要发送记忆命令，但可以看到：

- 正在读取项目记忆；
- Recall Subagent 正在运行；
- 已读取 Summary 或最终 Memory；
- 本轮是否沉淀了新经验。

详细过程通过 Session Event 和 `debug/runtime.jsonl` 记录。

## 五、渐进式披露与安全约束

必须保持：

```text
Title → 判断 → Summary → 判断 → Content
```

- 未披露的 ref 不可选择；
- 未经过 Summary 确认不可读取 Content；
- 最多披露 5 条 Summary；
- 最多读取 3 条 Content；
- 关联 Memory 不自动打开；
- 所有读取绑定 Project、Session、Turn 和 Generation；
- 父 Agent 只接收最终确认的 Content；
- Recall 失败不改变主任务结果。

## 六、Legacy Recall 兜底

现有 `createRecallRuntimeV2()` 保留并冻结为 Legacy Recall。仅在以下情况触发，且最多一次：

- Map View 缺失或版本不兼容；
- Map 校验失败但旧视图仍可验证；
- Recall Subagent 启动失败；
- Subagent 工具通信发生明确技术错误。

以下情况不触发兜底：

- 空记忆库；
- 地图正常但无相关记忆；
- 父 Agent 判断不需要记忆；
- Subagent 正常运行但没有确认 Content；
- Scope、Hash、Generation 等安全校验失败。

## 七、树、图与地图维护

Catalog 继续保持：

- 分类使用树：一个节点只有一个父节点；
- Memory 使用主要分类归属；
- `related_memory_refs` 表达 Memory 之间的图关系。

新增 Memory 时只更新受影响的分类路径和关联引用。查询时不重建整张地图。B-tree、SQLite 等物理索引不属于本阶段。

## 八、日志

日志至少记录：

- `route: map | legacy_fallback`；
- `attempt_id`、Generation、Catalog 和 Scope；
- Subagent 启动与完成；
- 披露阶段、数量和耗时；
- fallback 触发原因；
- 最终 Memory refs；
- 稳定 reason code。

不得记录 Prompt 原文、隐藏思考、完整用户消息、未选中的正文或敏感路径。

## 九、实施顺序

1. 写 ADR，冻结“用户零操作、过程可见、Subagent 执行记忆操作”；
2. 为 Legacy Recall 增加 characterization tests 并冻结其行为；
3. 实现只含 Title 的 Map Offer、Generation pin 和分页；
4. 实现 Recall Subagent Task Packet；
5. 实现 Summary / Content receipt 与越级读取拒绝；
6. 接入 DSH Subagent 和结构化结果回传；
7. 将 Consolidation 接入独立 Subagent；
8. 接入 Legacy Fallback；
9. 补齐日志、跨 Project、重启和失败矩阵；
10. 运行全量测试和真实双 Session 验收。

每一步通过对应测试后独立提交，未完成前不发布新版本。

## 十、验收标准

### Map-first

- 无相关记忆时不产生隐藏导航模型调用；
- 父 Agent 能看到有限 Title 地图；
- 地图超限时确定性分页，不丢失入口；
- Map 正常但 no-match 不触发 Legacy Recall。

### Recall Subagent

- 用户无需手动调用记忆工具；
- Subagent 能完成 Title → Summary → Content；
- 未确认 Summary 的 Content 永不进入父 Agent；
- 父 Agent 不收到中间导航内容；
- 跨 Project、Session、Turn、Generation 的 receipt 全部拒绝。

### Consolidation Subagent

- 正常 turn/end 后自动执行；
- 新经验写入项目级 v2 Memory；
- Catalog 和 Generation 原子发布；
- 无新知识时 `skip`，不写 Memory。

### Fallback

- 明确技术故障最多触发一次；
- 正常 no-match 不触发；
- 安全校验失败不绕过；
- 主任务始终可以继续执行。

## 十一、非目标

本阶段不实现：

- RAG、Embedding、Vector DB、BM25、reranker；
- Memory 去重、合并、淘汰和质量治理；
- Revision、Forget、Global Memory；
- Multi-path Recall；
- Catalog 自动重构；
- 用户手动记忆管理 UI。
