# dsh-Mnemosyne 当前架构

> 状态：✅ v0.2.0 当前有效架构
>
> 更新日期：2026-08-31

## 一、产品目标

dsh-Mnemosyne 是 DeepSeek Harness 的零操作项目记忆插件。用户安装后只需正常对话：

~~~text
任务开始
  → 模型按 Title → Summary → Content 自主回忆
  → 已确认记忆进入主模型上下文
  → 主模型完成任务
  → 模型判断是否形成可复用的新经验
  → 新经验成为项目级 OKF Memory
~~~

插件不替模型做语义相关性判断。程序只负责分层呈现、引用校验、持久化、编译和诊断。

### 1.1 当前非目标

v0.2.0 不实现：

- 用户可见的记忆 Tool；
- Session 短期记忆、手动晋升或遗忘；
- Memory Revision、Evidence、质量评分或治理；
- tags、aliases、关键词打分、Embedding 或向量检索；
- Web 管理、跨项目共享、自进化和自动发布；
- v0.1.0 数据迁移。

## 二、核心原则

### 2.1 每条记忆都是独立 OKF

每条 Memory 自身都有：

- **title**：最低成本的第一层判断；
- **summary**：确认标题相关后才披露的总结；
- **content**：确认 Summary 后才读取的完整经验；
- **related_memory_refs**：相关记忆索引。

所有 Memory 再由 Catalog 组织为项目记忆世界。

### 2.2 模型负责理解，插件负责边界

- 模型阅读 Title、Summary 并选择稳定 ref；
- 插件只接受本轮已披露集合中的 ref；
- 插件不把关键词命中、文本权重或规则分数当作相关性；
- 不保存模型隐藏思考，只保存结构化选择结果。

### 2.3 严格渐进式披露

~~~text
分类 Title
  → 所选分类 Summary
  → 下一层分类或 Memory Title
  → 所选 Memory Summary
  → 最终确认 Memory Content
~~~

信息只能逐层增加。未选择的 Title 不得披露 Summary；未经 Summary 确认的 Content 不得进入主模型。

### 2.4 规范对象与派生视图分离

- Memory 与 Catalog 是规范对象；
- Generation、Index、Summary View、Content View 和 CURRENT 是可验证派生状态；
- 分类重组只创建新 Catalog，不改写 Memory；
- 新踩坑创建关联的新 Memory，不修改旧 Memory；
- 派生状态损坏时不得反向篡改规范对象。

## 三、DSH 生命周期装配

插件只使用 DSH 公开扩展：

- **agent/pre-step**：每个主回合第一步运行一次 Recall；
- **session/event** 的正常 **turn/end**：运行 Consolidation；
- 当前 Agent 的 provider/model：执行语义导航和沉淀判断；
- 持久消息 **source.kind=plugin, form=recall**：把最终记忆交给主模型并支持 Session 重放；
- Cordis effect/dispose：停止新任务、取消在途模型流并等待资源收敛。

根插件只导出 DSH 装配所需的 name、inject、Config、apply 与基线常量。生产 Tool Registry、JS 和 DTS 中均不存在 mnemosyne 工具。

配置只有：

~~~yaml
enabled: true
# projectRoot: /absolute/project/path
~~~

Project Root 优先来自 Session cwd。无法从公开 Session 信息取得时，才使用显式 projectRoot；不得用进程当前目录猜测项目。

## 四、规范对象

### 4.1 OKF Memory v2

~~~ts
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
~~~

Memory 不可变。Canonical Hash 覆盖除 content_sha256 外的全部字段；相同规范内容幂等，不同内容不得覆盖同一身份。

### 4.2 OKF Catalog v1

~~~ts
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
~~~

Catalog 必须满足：

- 单一 Root，Root 无父节点且不直接包含 Memory；
- 父子边双向闭合；
- 节点无环、全部从 Root 可达；
- Memory 只属于一个 Catalog 节点；
- 引用排序、去重并受数量上限约束。

## 五、存储与 Generation

~~~text
<project>/.dsh-mnemosyne/
├── v2/
│   ├── memories/<memory-id>.json
│   ├── catalogs/<catalog-id>.json
│   ├── generations/<generation-id>/
│   │   ├── indexes/root.json
│   │   ├── indexes/nodes/<node-id>.json
│   │   ├── summaries/<memory-id>.json
│   │   ├── contents/<memory-id>.md
│   │   └── manifest.json
│   └── CURRENT
└── debug/runtime.jsonl
~~~

发布顺序：

1. 校验 Memory 与 Catalog；
2. no-overwrite 原子写入规范对象；
3. 从固定 Catalog 与显式 Memory 集编译 Generation；
4. 校验每个输出 Hash 与字节数；
5. Generation 完整后原子切换 CURRENT。

同一项目的 Consolidation 由项目级协调器串行执行，避免并发回合基于同一旧 Catalog 发布而丢失 Memory。不同项目互不阻塞。

v0.1.0 的旧目录保留在磁盘，但 v0.2 Store、Compiler、Recall 和 CURRENT 完全忽略它们。

## 六、Recall Runtime

### 6.1 上限

- 同一主 turn 只运行一次；
- 整个导航最多 6 个展开步骤；
- 每层最多选择 5 条 Memory 查看 Summary；
- 最多确认 3 条完整 Content。

### 6.2 执行

1. 从已验证 CURRENT Generation 读取 Root Title Index；
2. 模型只能从已披露 ref 中选择下一层；
3. 选择分类后披露该分类 Summary；
4. 确认分类后披露子分类或 Memory Title；
5. 选择 Memory Title 后披露对应 Summary；
6. 确认 Summary 后读取 Content；
7. 将最终 Content 写成持久 plugin recall 消息；
8. 主模型在同一请求中看到该消息并继续任务。

Related Memory 在 Content 中只显示 Title/ref，不允许顺着关系直接绕过 Summary 层。

### 6.3 失败降级

空库、无匹配、模型导航失败或 Generation 读取失败都不得阻断主任务。失败只产生稳定 reason code 和脱敏日志，不注入未经确认的内容。

## 七、Consolidation Runtime

正常完成的 turn 结束后：

1. 只从本 turn 的真实用户消息和模型结果提取有限证据；
2. plugin/system/recall 消息不得伪装成用户任务；
3. 当前 Agent 模型返回严格的 skip 或 create；
4. create 必须给出 Title、Summary、结构化 Markdown Content 和合法关联 ref；
5. 模型只看分类 Title，选择现有分类或创建新分类；
6. 写入 Memory、Catalog 并发布 Generation；
7. 完全相同的规范内容返回 noop。

Consolidation 是主任务完成后的附加路径。任何失败只记录日志，不改变已完成任务的结果。

## 八、开发者日志

.dsh-mnemosyne/debug/runtime.jsonl 是开发者诊断源，记录：

- Recall start/layer/no-match/completed/failed；
- Consolidation start/skip/created/noop/failed；
- Catalog 更新与 Generation 发布；
- Scope、turn、ref、计数、结果和稳定 reason code。

日志不得包含用户全文、完整 Memory Content、模型原始输出、隐藏思考、Credential 或绝对敏感路径；不得进入 Memory、Generation 或模型上下文。

## 九、安全与正确性边界

- Project Scope 由规范项目路径确定，跨项目引用拒绝；
- 路径穿越、symlink、非规范 JSON、未知字段和 Hash 漂移 fail closed；
- Memory/Catalog/Generation 使用不可变、no-overwrite 和原子发布；
- 编译时解析全部 Memory 关系，断链拒绝；
- 用户不可通过会话工具绕过渐进式披露；
- Recall/Consolidation 的失败均不能改变 DSH 主任务结果。

Node 文件系统 API 无法对同 UID 恶意进程提供内核级目录能力隔离；实现通过逐组件检查、no-follow、文件身份复核与发布后校验缩小竞态窗口，但不宣称消除操作系统级同 UID 攻击。

## 十、版本与文档事实源

- v0.1.0：已发布的工具式技术预览，只作为历史；
- v0.2.0：当前零操作 OKF 产品架构，与 v0.1 数据不兼容；
- 当前具体 Schema、限制和验收以 DSH_MNEMOSYNE_V020_ZERO_OPERATION_OKF_MEMORY_PLAN.zh-CN.md 为准；
- 本地使用评估以 DSH_MNEMOSYNE_LOCAL_OBSERVATION_EVALUATION.zh-CN.md 为准；
- 被删除的 v0.1/M0.5 执行计划仍可从 Git 历史中的 v0.1 发布提交读取，但不再作为当前设计输入。

## 十一、后续方向

只有 v0.2 经本地连续观察证明基本闭环有效后，才讨论：

1. Web 记忆管理；
2. Catalog 重组、重复治理与容量管理；
3. 跨项目显式共享；
4. Revision/Evidence/关系类型；
5. 稳定迁移与 v1.0 兼容承诺。

自进化不属于当前记忆管理路线。
