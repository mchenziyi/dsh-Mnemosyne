# dsh-Mnemosyne v0.2.0 零操作 OKF 记忆闭环实施计划

> 状态：✅ 实现完成（2026-08-31）
>
> 日期：2026-08-28
>
> 前置版本：`@cziyi/dsh-mnemosyne@0.1.0`

## 一、目标

`v0.2.0` 将技术预览版的“普通笔记 + 用户可见工具”重构为安装即用的项目级记忆系统：

```text
用户自然语言提出任务
  → 模型通过 OKF 标题导航判断是否需要旧经验
  → Title → Summary → Content 逐层披露
  → 已确认的记忆作为可重放 plugin recall 消息进入主请求
  → 主模型正常完成任务
  → turn 正常结束后由模型判断是否产生可复用的新经验
  → 新经验写入项目级 OKF Memory，并原子发布新 Catalog/Generation
```

用户不调用、不看到任何 `mnemosyne_*` 工具。插件负责组织、呈现、校验和持久化；语义判断始终由当前 Agent 使用的模型完成。

## 二、冻结边界

### 2.1 本阶段必须实现

- 每条记忆都是独立、不可变的 OKF Memory；
- 独立 Catalog 只保存分类导航及 Memory 引用；
- 严格 `Title → Summary → Content` 渐进式披露；
- 每个用户回合至多执行一次 Recall；
- 每个正常结束的 turn 自动执行一次 Consolidation；
- 新记忆直接成为 Project Scope 的持久记忆；
- 新踩坑创建关联的新记忆，不修改旧记忆；
- 项目内结构化 JSONL 诊断日志；
- 移除全部用户可见的记忆工具和根导出。

### 2.2 明确不实现

- Session 短期记忆、晋升、遗忘 Tool；
- Memory Revision、Evidence、健康度、治理和成功次数；
- tags、aliases、关键词索引、Embedding 或向量检索；
- 关系类型、Web 管理、自进化；
- v0.1.0 Fact 的迁移或改写。

v0.1.0 数据保留在磁盘，但 v0.2.0 的 Store、Compiler、Catalog 和 Recall 完全忽略它们。

## 三、规范对象

### 3.1 OKF Memory v2

```ts
interface OKFMemoryV2 {
  schema_version: 2
  memory_id: string
  project_scope_id: string
  title: string
  summary: string
  content: string
  related_memory_refs: string[]
  created_at: string
  content_sha256: string
}
```

- `title` 是第一层披露信息，让模型判断是否值得继续查看；
- `summary` 是第二层披露信息，是完整记忆的简洁总结；
- `content` 是结构化 Markdown，可记录问题、踩坑、处理过程、结论和验证方式；
- `related_memory_refs` MVP 只表达一般相关；
- 规范 Hash 覆盖除 `content_sha256` 外的全部字段；
- 同一规范内容重复写入返回 `noop`，不同内容不覆盖已有 Memory。

### 3.2 OKF Catalog

```ts
interface OKFCatalogNodeV1 {
  node_id: string
  title: string
  summary: string
  parent_node_id: string | null
  child_node_refs: string[]
  memory_refs: string[]
}

interface OKFCatalogV1 {
  schema_version: 1
  project_scope_id: string
  root_node_id: string
  nodes: OKFCatalogNodeV1[]
  updated_at: string
  content_sha256: string
}
```

Catalog 是独立规范对象。分类重组只产生新 Catalog，不修改 Memory。节点、父子边和 Memory 引用必须闭合，不得有环、重复引用或断链。

新记忆沉淀时，模型先阅读已有分类 Title，必要时阅读分类 Summary，然后选择已有分类；均不匹配时创建新分类。

## 四、存储与原子发布

```text
<project-root>/.dsh-mnemosyne/
├── v2/
│   ├── memories/<memory-id>.json
│   ├── catalogs/<catalog-id>.json
│   ├── generations/<generation-id>/
│   └── CURRENT
├── debug/runtime.jsonl
└── <v0.1.0 legacy data remains untouched>
```

- v2 使用独立路径和 CURRENT，避免把旧事实误编译进新世界；
- Memory 与 Catalog 先 no-overwrite 原子发布，再构建 Generation；
- CURRENT 只在 Generation 完整校验后原子切换；
- 引用断链、Hash 漂移或输出不完整均 fail closed；
- Consolidation 失败不得影响已经完成的主任务。

## 五、Generation 分层视图

每个 Generation 只由显式固定的 v2 Memory 集合和一个 Catalog 编译：

1. `indexes/root.json`：仅 Root 下一层分类的 `node_id + title`；
2. `indexes/nodes/<node-id>.json`：所选节点的 Summary，以及下一层分类/Memory 的 Title 与 ref；
3. `summaries/<memory-id>.json`：单条 Memory 的 Title 与 Summary；
4. `contents/<memory-id>.md`：完整 Content 与相关记忆的 Title/ref；
5. `manifest.json`：输入与输出 Hash、字节数和编译器版本。

相关记忆底层只保存 ID；编译时解析为 Title。任一引用不存在即拒绝编译。

## 六、Recall Runtime

### 6.1 触发位置

Recall 监听公开 `agent/pre-step`。仅当当前用户 turn 尚未执行 Recall 时运行一次，并使用当前 Agent 的 provider/model 调用公开 LLM Runtime。

### 6.2 严格披露顺序

1. 第一次导航请求只包含 Root 子分类 Title；
2. 模型选择分类后，下一次请求只披露所选分类 Summary；
3. 模型确认展开后，只披露该节点的下一层分类或 Memory Title；
4. 每层最多选择 5 个 Memory Title，之后才分别披露其 Summary；
5. 模型根据 Summary 最多确认 3 条 Memory；
6. 插件读取被确认 Memory 的完整 Content；
7. 最终内容以 `source.kind=plugin, form=recall` 的持久消息进入主请求；
8. Related Memory 只披露 Title，需要读取时重新走 Title → Summary → Content；
9. 整个导航最多 6 个展开步骤，超限时只使用已确认内容。

模型输出严格结构化 ref 选择。程序只校验 ref 来自本轮已披露集合，不进行关键词、tags、文本相似度或权重打分，不保存隐藏思考。

### 6.3 失败策略

- 空库或模型选择无关：不注入记忆，主任务继续；
- 模型调用、Catalog 或 Generation 读取失败：记录稳定 reason code，主任务继续；
- 未经过 Title 和 Summary 的 Content 不得进入主请求；
- 同一主 turn 的后续普通 Agent step 不重复 Recall。

## 七、Consolidation Runtime

在正常 `turn/end` 后异步串行执行：

1. 从允许的 Session 事件构造有限任务结果证据；
2. 使用当前 Agent 的 provider/model 判断 `skip | create`；
3. `create` 必须返回 Title、Summary、结构化 Markdown Content；
4. 使用旧记忆后发现新踩坑时，新 Memory 关联旧 Memory；
5. 模型选择已有 Catalog 分类，或给出新分类；
6. 严格校验后写入 Memory 与新 Catalog，并编译/发布新 Generation；
7. 规范内容完全相同返回 `noop`。

正常成功但无新知识、任务尚未完成或证据不足均 `skip`。不修订旧 Memory，不记录成功计数，不自动晋升。

## 八、开发者日志

默认追加写入 `.dsh-mnemosyne/debug/runtime.jsonl`。每行是闭合 JSON 对象，记录：

- `schema_version`、`timestamp`、`event`；
- Project/Session/Turn 的不可逆 Hash；
- Generation、Catalog、Memory/Index ref（存在时）；
- `result`、稳定 `reason_code`、披露/选择数量；
- Recall start/layer/selection/no-match/completed/failed；
- Consolidation start/skip/created/noop/failed；
- Catalog 更新和 Generation 发布结果。

日志不得保存用户全文、完整 Memory Content、Prompt、模型原始输出、隐藏思考、凭据或绝对路径；不得进入模型上下文、OKF、Memory 或 Generation，也不得注册为 Tool。

## 九、产品装配

- 配置仅保留 `enabled` 与可选 `projectRoot`；
- 删除 Tool Registry 中全部 `mnemosyne_*` Tool；
- 根导出和发布 DTS/JS 不得包含 Status/Search/Open/Remember/List/Promote/Forget/Acquisition Status；
- 旧底层模块可暂时保留以维持回归，但不进入 v0.2 产品路径；
- dispose 必须撤销监听并停止新的 Recall/Consolidation 调度。

## 十、测试与验收

- Schema：Memory/Catalog 严格解码、Hash、引用闭合、旧 v1 忽略；
- 编译：Title/Summary/Content 三层输出、相关标题解析、断链失败；
- 披露：阶段输入不越级，最多 5 Summary/3 Content/6 展开；
- 自动闭环：空库、create、skip、noop、跨 Session 语义改写召回、新踩坑关联且旧字节不变；
- 产品边界：Tool Registry、根导出和发布包零 `mnemosyne_*`；
- 日志：可解释未召回、未沉淀和失败，且无敏感正文。

真实验收使用两个 Session：A 完成一个无历史经验任务并自动沉淀；B 用不同措辞提出同类问题。日志必须证明 Title → Summary → Content 展开，DSH Session 必须证明主模型收到持久 recall 消息，全程用户不调用工具。

## 十一、实施与提交 Gate

| 顺序 | 阶段 | 进入下一阶段的 Gate |
|---|---|---|
| 1 | 本设计、总体架构、路线图 | 文档提交完成 |
| 2 | v2 Memory Store + Catalog | Schema/原子写入/旧 v1 忽略通过 |
| 3 | v2 Compiler | 三层视图与断链测试通过 |
| 4 | Recall Runtime | 严格披露与可重放注入通过 |
| 5 | Consolidation Runtime | create/skip/noop/关联新记忆通过 |
| 6 | 零工具装配 + JSONL 日志 | Tool/导出/日志边界通过 |
| 7 | 全量、真实验收、README | 全门禁与双 Session 验收通过 |

每个阶段单独提交。任何阶段未达到纵向 Gate，不进入下一阶段，不发布 npm。
