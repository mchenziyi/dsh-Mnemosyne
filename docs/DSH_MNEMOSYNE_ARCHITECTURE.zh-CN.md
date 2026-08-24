# dsh-Mnemosyne 总体设计

> 状态：Draft
>
> 本文档是 dsh-Mnemosyne 的主设计文档。总体架构、协议决议、阶段计划和每一步实现设计均在本文持续维护；实现代码不得先于对应设计落地。

## 1. 项目定位

dsh-Mnemosyne 是 DeepSeek Harness 的原生插件，为 Agent 提供：

- 跨 Session 的长期工程记忆；
- OKF 风格的知识组织与关系索引；
- 渐进式披露与按需读取；
- 记忆来源、健康度、生命周期和冻结治理；
- 可审计、可重放、可修复的记忆使用链路；
- 后续受治理的插件自进化能力。

DeepSeek Harness 继续负责 Agent Loop、Session、工具、权限、审批、模型调用和插件运行时。dsh-Mnemosyne 只负责记忆与基于记忆的治理，不实现第二套 Agent Runtime。

## 2. 目标与非目标

### 2.1 目标

1. Agent 能在后续 Session 中找到并复用过去的工程经验。
2. 模型默认只看到索引和必要摘要，需要时再读取完整记忆。
3. 所有自动注入的模型可见记忆均可从 Harness 现有日志链路重建；无法满足时只提供显式 Tool 读取。
4. 记忆事实不可静默覆盖；派生页面和索引可确定性重建。
5. 错误记忆默认冻结而非删除，并保留人工恢复入口。
6. 项目级和全局级记忆相互隔离，并通过明确规则晋升。
7. 插件卸载或禁用后，Harness 的基础能力保持可用。

### 2.2 非目标

- 不实现向量数据库或 Embedding 基础设施；
- 不保存模型完整思考过程；
- 不把 OKF Wiki 页面作为规范事实源；
- 不让插件直接修改 Harness 安全核心；
- 不在记忆 MVP 中实现插件自进化；
- 不以“自动记录”作为“记忆正确”的证明；
- 不宣称记忆系统必然提高模型能力，收益必须由评测证明。

## 3. 核心原则

### 3.1 Harness 原生插件

插件通过 DeepSeek Harness 已公开的 Plugin、SessionEvent、Agent Event、Tool、Job 和 Context 注入扩展点工作。禁止依赖未声明的内部文件布局或私有运行时状态。

### 3.2 零上游改动依赖

dsh-Mnemosyne 的所有功能必须完全建立在 DeepSeek Harness 已存在、已公开、可由 out-of-tree 插件使用的扩展点之上：

- 不修改、Fork 或维护 DeepSeek Harness 私有补丁；
- 不把向 DeepSeek Harness 提交 PR 或等待上游新增接口作为交付前提；
- 不读取 Harness 私有文件、内存对象或未声明数据库；
- 缺少公开扩展点时，功能必须安全降级、明确报告 unsupported，或推迟实现；
- 每个 Harness 接入点都必须记录已验证版本、API 来源和兼容性测试；
- Harness 升级导致接口变化时，只修改 Harness Adapter，不污染记忆核心协议。

### 3.3 模型可见即必须可重放

任何记忆上下文只能通过 Harness 已公开且保证进入其正常请求/日志链路的接口提供给模型。插件同时记录不可变的披露事实。若现有公开接口无法保证模型可见内容可重放，则 MVP 只提供显式 Tool 读取，不实现自动上下文注入。

本原则要求的是**上下文重放**，不是重新执行 Librarian：

- 上下文重放直接读取已落盘的 Disclosure Fact，使模型再次看到同一份记忆内容；
- 重新执行 Librarian 不要求得到相同选择，模型推理也不作为确定性协议的一部分；
- 不保存 Librarian 的隐藏思考过程；只保存检索请求、候选世界及 Hash、实际读取的索引与页面引用、结构化选择理由、最终 MemoryRef/排序和 Disclosure Fact；
- Replay 不重新调用 Librarian，不使用新的索引或未来状态评价过去的披露。

### 3.4 规范事实与派生视图分离

规范事实：

- Episode；
- Memory Revision；
- Evidence Generation；
- Judgment；
- Governance Event；
- Memory Usage 与 Outcome；
- Generation Input Manifest。

派生视图：

- OKF Wiki 页面；
- Root/Local Index；
- Episode Card；
- Lifecycle、Health 和 Usage Statistics；
- Retrieval Candidate；
- Web 管理视图。

任何派生状态都必须能从规范事实确定性重建，不能成为第二事实源。

### 3.5 不使用向量数据库

检索依赖结构化字段、确定性索引、关系图、文本搜索和 Librarian Agent。模型负责语义理解，系统负责提供高质量索引、候选集合和可审计的读取路径。

该决议接受“自托管简单性、可审计与确定性”相对于“潜在语义召回上限”的权衡，但不是免评测承诺。M0.5 必须使用换措辞、别名和跨组件困难 Fixture 提前验证召回；不达标时优先改进索引、查询扩展和 Librarian，不静默引入 Embedding 或向量数据库。改变本决议必须由新的 ADR 明确批准。

### 3.6 冻结代替删除

记忆达到可验证的负面条件后进入 frozen。冻结记忆：

- 默认不参与检索和模型上下文；
- 不删除、不覆盖；
- 可被人工检查、比较和受约束地恢复；
- 仍可用于审计、修复和生成新 Revision。

## 4. 总体架构

```text
DeepSeek Harness
  │
  ├─ SessionEvent / Agent Event / Tool Event
  │        │
  │        ▼
  │  Harness Adapter
  │        │
  │        ├─ Episode Recorder
  │        ├─ Context Injector
  │        └─ Usage/Outcome Recorder
  │
  └─ dsh-Mnemosyne Plugin
           │
           ├─ Fact Store
           ├─ OKF Compiler
           ├─ Deterministic Index
           ├─ Retrieval Engine
           ├─ Librarian
           ├─ Progressive Disclosure
           ├─ Governance
           ├─ Doctor/Repair
           └─ Web Manager（后续）
```

## 5. 组件职责

### 5.1 Plugin Entry

- 注册和卸载插件；
- 读取插件配置；
- 安装 Harness 事件监听器、工具和服务；
- 保证所有注册均能随插件卸载而撤销；
- 暴露健康状态与版本信息。

### 5.2 Harness Adapter

- 将 Harness 事件转换为内部稳定协议；
- 不把 Harness 私有对象直接写入长期存储；
- 只使用目标版本已经存在的公开插件接口；
- 将记忆披露事实写入插件自己的规范事实存储；
- 仅在 Harness 公开 API 保证正常日志和 replay 语义时启用自动上下文注入；
- 在 Harness API 演进时隔离兼容性变化。

### 5.3 Fact Store

- 保存不可变规范事实；
- 原子写入、Hash 校验、幂等与身份冲突检测；
- 项目级和全局级 Scope 隔离；
- 路径穿越、symlink、权限和损坏文件防护；
- 不自动修复或覆盖损坏事实。

### 5.4 OKF Compiler

- 从指定事实集合生成 OKF 页面和索引；
- 输入集合由不可变 Manifest 固定；
- 相同输入必须生成相同输出；
- 页面、索引和关系断链可被 Doctor 检测；
- 派生目录可以清理，但永久 Manifest 必须保留。

### 5.5 Retrieval Engine

- 根据 Scope、Memory Type、Component、Operation、标签、文本和关系生成候选；
- 默认排除 frozen、archived 和不满足 Context 的 Revision；
- 返回 MemoryRef 和索引摘要，不直接拼接完整正文；
- 记录候选世界、排序依据和最终选择。

### 5.6 Librarian

- 接收当前任务的结构化描述；
- 浏览 Root Index、Local Index、OKF 关系和候选页面；
- 向父 Agent 返回 MemoryRef、建议披露层级和理由；
- 不修改记忆，不直接决定记忆晋升或冻结；
- 记录输入候选世界、实际读取引用、结构化输出和披露引用，不记录隐藏思考过程；
- Librarian 输出可以非确定，但基于已记录输入的最终排序函数必须确定；
- MVP 后期再接入模型，早期使用确定性检索替代。

### 5.7 Progressive Disclosure

披露分为四层：

| 层级 | 内容 | 默认用途 |
|---|---|---|
| L0 | 是否存在相关记忆、候选数量 | 决定是否继续检索 |
| L1 | 标题、类型、Scope、健康度、关系和使用统计 | 候选选择 |
| L2 | 摘要、适用条件、失败边界、关键关系 | 父 Agent 判断是否采用 |
| L3 | 完整 Revision、证据引用和治理记录 | 深入执行或审查 |

默认最多披露到 L2。L3 必须由工具显式读取，并记录对应 SessionEvent。

### 5.8 Governance

- 管理 Lifecycle、Health、Freeze、Unfreeze、Supersede 和 Archive；
- 程序只校验结构、引用和确定性规则，不穷举语义失败枚举；
- 语义判断由模型输出结构化 Judgment；
- 外部环境失败不得直接归因于记忆；
- 同一事实不得通过成功次数抵消已确认的负面证据。

### 5.9 Doctor 与 Repair

- 检查事实 Hash、引用闭合、权限、symlink、Manifest、Generation 和派生视图；
- Repair 只能从规范事实重建派生状态；
- 不猜测缺失事实、不伪造证据、不静默删除；
- 无法确定时给出稳定诊断并停止。

### 5.10 Acquisition Pipeline

Acquisition 负责把已完成工作转为候选记忆，而不是把每个 Session 无条件写成 Active Memory：

1. 只在任务完成、明确检查点或用户显式请求时触发；
2. 先执行确定性资格检查与严格幂等检查；
3. 只有事件幂等键、规范化事实 Hash 或结构化任务指纹能够严格证明重复时才自动跳过；文本相似不得直接跳过；
4. 合格任务由只读提取 Agent 输出严格结构化 Candidate Memory，不保存隐藏思考过程；
5. 输出必须经过 Schema、路径和敏感信息校验后才能落盘；
6. 提取优先通过 Harness 现有 Job 能力异步执行，失败不得改变原任务结果；
7. 自动提取只产生候选事实，不自动激活、晋升或改写既有 Revision；
8. 记录触发/跳过原因、Token、延迟、候选数量和最终治理结果。

无法严格判定重复时，允许生成 `duplicate_candidate`、`overlaps_with`、`extends` 或 `contradicts` 候选关系；这些关系属于派生判断，不得自动合并或覆盖规范事实。

## 6. Scope 与存储

### 6.1 Scope

支持三个读取层级：

- Session：仅用于当前会话的临时上下文，不直接成为长期知识；
- Project：项目级长期工程经验，默认写入位置；
- Global：经过跨项目证据验证后晋升的通用经验。

读取顺序由当前 Workspace 决定，Project 与 Global 合并时保留来源，不把同名 Memory 自动视为同一身份。

### 6.2 逻辑布局

实际物理路径优先通过 Harness 已有公开配置和 Workspace 服务解析。若现有公开接口不提供插件存储目录，则由 dsh-Mnemosyne 自己的显式配置指定，并执行独立安全校验；不能猜测或读取 Harness 私有目录。逻辑布局如下：

```text
mnemosyne/
├── facts/
│   ├── episodes/
│   ├── memory-revisions/
│   ├── evidence-generations/
│   ├── judgments/
│   ├── governance-events/
│   ├── memory-usages/
│   ├── outcomes/
│   └── generation-input-manifests/
├── generations/
│   └── <generation-id>/
│       ├── wiki/
│       ├── indexes/
│       └── generation.json
├── transactions/
├── locks/
├── diagnostics/
└── CURRENT
```

物理布局、权限和跨平台策略在存储阶段设计中冻结。

MVP 不实现规范事实归档搬迁。系统从第一天记录事实数量与磁盘占用；派生 Generation、缓存和临时视图允许安全清理并重建，Frozen/Archived 退出活跃索引。只有真实数据证明存储增长成为问题后，才设计仍保留内容 Hash、Manifest 和可重放能力的归档事务。

## 7. 记忆模型

### 7.1 Episode

Episode 记录一次任务或可归属工作单元的结构化事实，包括任务摘要、Session/Turn 引用、结果、工具证据、错误摘要和时间。禁止保存完整隐藏思考过程。

Episode 由 Acquisition Pipeline 从已确认的 Harness 事件生成。写入前必须脱敏；同一 Session/Task/Event 使用稳定幂等键。提取失败或被跳过都记录稳定原因，但不得伪造 Episode 或影响原任务状态。

### 7.2 Memory Revision

Memory 是稳定身份，Revision 是不可变内容版本。修改记忆必须创建新 Revision；旧 Revision 永久保留，并通过 Supersede 关系退出默认读取集合。

完全相同的稳定身份与内容 Hash 走幂等；语义近似只形成候选关系，不自动认定同一 Memory，也不自动合并 Revision。

第一版 Memory Type：

- strategy；
- procedure；
- decision；
- constraint；
- failure；
- preference；
- pattern。

类型和字段在 Schema 阶段正式冻结。

### 7.3 Evidence 与 Judgment

Evidence 描述事实来源；Judgment 描述对事实的结构化判断。知识关系与事实证据使用不同引用类型，禁止混用。

### 7.4 Usage 与 Outcome

每次记忆被检索、读取、采用、影响或评估，都记录独立 Usage 阶段。Outcome 只在存在可验证归因时计入记忆效果；第三方故障、权限失败、网络失败等保持 external/unknown。

## 8. 记忆生命周期

```text
candidate
  → probation
  → active
  → degraded
  → frozen
  → superseded / archived
```

核心规则：

- 自动采集不等于自动激活；
- 激活需要符合对应 Usage Policy 的有效证据；
- 冻结基于可验证负面证据，不使用单一“任务失败次数”；
- Frozen 默认不进入检索；
- Unfreeze 必须通过新的 Evidence/Judgment/Governance Event；
- 任何历史版本都不可原地修改。

## 9. 检索与排序

### 9.1 候选生成

按以下顺序逐步缩小集合：

1. Scope；
2. Lifecycle 与 Health；
3. Memory Type；
4. Component / Operation；
5. Context Applicability；
6. OKF 关系；
7. 文本匹配；
8. 使用历史。

### 9.2 排序

排序优先考虑：

1. Context 精确匹配；
2. 证据和引用完整度；
3. 成功复用次数；
4. 最近验证时间；
5. 稳定身份排序。

为了支持审计，最终排序函数在已记录输入下必须是确定函数。Librarian 可以提出候选或结构化查询扩展，但候选世界、实际读取引用、查询扩展、排序输入和最终结果必须落盘；上下文重放直接使用当时的 Disclosure Fact，不重新执行 Librarian。若未来需要探索性随机，随机种子与候选世界必须写入审计事实。

M0.5 使用可移植的确定性文本索引：英文词元、中文字符 n-gram、结构化字段与简化 BM25 排序，不引入 SQLite 原生扩展。查询改写分为确定性规范化/别名扩展与可选的 Librarian 结构化扩展；模型输出只作为已记录输入，不直接绕过确定性排序。

## 10. Harness 接入协议

### 10.1 输入事件

计划监听的事件域：

- Session durable events：任务、Turn、Step、消息、工具调用和结果；
- Agent live events：请求前、Turn 停止和状态变化；
- Tool events：执行前后与失败；
- Workspace/Profile 生命周期事件。

确切事件名、payload 和稳定性在 M0 接口审计中锁定。

### 10.2 记忆披露审计

插件内部记录以下不可变审计事实：

```text
mnemosyne/episode-recorded
mnemosyne/retrieval-requested
mnemosyne/retrieval-completed
mnemosyne/context-disclosed
mnemosyne/memory-used
mnemosyne/outcome-recorded
```

这些名称首先属于 dsh-Mnemosyne 自己的事实协议，不预设 Harness 支持外部插件注册自定义 SessionEvent。仅当 M0 证明现有公开 API 支持时，才映射为 Harness SessionEvent；否则保留在插件 Fact Store，并通过现有 Tool 返回。Schema 必须版本化、严格解析、可重放，并避免存储完整 Prompt、命令正文和凭据。

一次可审计披露至少固定：Retrieval Request、候选世界及 Hash、实际读取的索引/页面引用、读取数量统计、查询扩展、MemoryRef、结构化选择理由、最终排序与 Disclosure Fact。读取数量仅用于诊断，不代替引用清单，也不要求保存模型推理轨迹。

### 10.3 模型工具

MVP 计划注册：

```text
mnemosyne.search
mnemosyne.open
mnemosyne.relations
mnemosyne.feedback
```

工具返回结构化引用与摘要。完整内容读取必须显式发生，并计入 Usage。

自动注入默认不是 MVP 成功的前提。若只能通过 `agent.inject(UserMessage)` 注入，必须使用带 disclosure ID 的机器可读外壳，明确声明内容来自长期记忆而非用户指令，并记录该通道的角色语义折衷。M0.5 将 Tool-only 与自动注入作为两个独立实验组；自动注入不满足收益与安全 Gate 时保持禁用。

### 10.4 Harness 兼容性 Gate

每个阶段在实现前维护兼容性矩阵：

| 能力 | 使用的 dsh 公开扩展点 | 已验证版本/Commit | 降级行为 |
|---|---|---|---|
| 插件加载/卸载 | M0 待审计 | 待定 | 无法加载则阶段阻塞 |
| 记忆检索工具 | `ctx.tools` 的现有注册接口 | 待定 | 不注册工具并报告 unsupported |
| 后台 Librarian | `ctx.jobs` 或现有 Agent 能力 | 待定 | 使用同步确定性检索 |
| 自动上下文注入 | 现有公开注入接口 | 待定 | Tool-only |
| Session replay | 现有 Session/Event API | 待定 | 插件事实可重放，不声称 Harness replay 集成 |
| Web 管理界面 | 现有 Chat Node/Renderer 扩展点 | 待定 | command/tool 管理 |
| 插件熔断/回滚 | 现有 Profile/Bundle/Patch/卸载接口 | 待定 | 禁止自动进化 |

未通过兼容性 Gate 的能力不能进入实现；不得用 monkey patch、复制 Harness 内部代码或直接修改其存储来绕过。

## 11. 安全与隐私

- 默认最小权限；
- 不存储 API Key、Token、密码和完整命令正文；
- 写入前执行脱敏和路径安全校验；
- 错误消息不得回显敏感输入；
- 项目记忆不能越过 Workspace 根读取文件；
- 全局晋升不包含项目绝对路径和私有标识；
- 模型输出永远视为不可信输入，必须严格 Schema 校验；
- 插件禁用后停止监听和注入，不破坏 Harness 原始 Session 日志。

## 12. 插件自进化（后续阶段）

插件自进化建立在稳定记忆系统之上：

```text
重复问题
→ Pattern
→ Plugin Proposal
→ 静态检查与沙箱验证
→ Canary
→ 观察期
→ Promote / Freeze / Rollback
```

进化产物必须是独立插件或插件版本，不直接修改 Harness 核心。新插件默认禁用或 Canary；连续异常自动熔断；所有启用、冻结和回滚写入审计事实。

第一版禁止自动进化权限、沙箱、凭据、Session Store 和记忆事实层。

E0+ 是条件愿景，不是记忆 MVP 的交付承诺。只有 M0.5 证明核心记忆链路具备净收益，且后续正式评测持续通过，才进入插件自进化设计与实现。

## 13. 开发阶段与验收

| 阶段 | 目标 | 关键验收 |
|---|---|---|
| M0 | Harness 接口审计与 Hello Plugin | 能加载、卸载、注册最小能力 |
| M0.5 | 核心价值纵向验证 | 最小录制/检索/披露/重放闭环；三组配对评测；GO/ADJUST/STOP |
| M1 | Fact Store 与安全边界 | 原子、幂等、Hash、Scope、损坏诊断 |
| M2 | Episode 与 Revision Schema | 事件可转事实，旧事实不可覆盖 |
| M3 | OKF Compiler 与索引 | 同输入同输出，派生视图可重建 |
| M4 | Retrieval 与渐进式披露 | search/open、L0-L3、冻结隔离 |
| M5 | Harness Session 集成 | 仅用现有公开接口；支持则验证 replay，不支持则保持 Tool-only |
| M6 | Usage、Outcome 与治理 | 生命周期、健康度、冻结和恢复 |
| M7 | Librarian Agent | 返回可审计引用，不直接写事实 |
| M8 | Doctor、Repair 与 Web Manager | 可诊断、可重建、可人工治理 |
| M9 | 正式持续质量评测 | 扩大 Fixture、长期回归、成本与任务效果 |
| E0+ | 条件性插件自进化 | 仅在价值 Gate 通过后设计沙箱、Canary、熔断、回滚 |

每个阶段开始前，都必须在本文追加：范围、非范围、协议、文件计划、失败测试、门禁和真实联调步骤。

M0.5 是 M1～M9 的范围重基线 Gate。Gate 未得出 GO 前，不启动 Doctor 深化、Web Manager、复杂晋升治理或 E0+；ADJUST 必须先修订检索/Acquisition 并重跑固定评测，STOP 则停止建设重型记忆治理。

## 14. MVP 完成定义

记忆 MVP 至少满足：

1. dsh 能安装、加载、卸载插件；
2. 一次 Harness 任务能够形成脱敏 Episode；
3. Episode 能生成或更新 Memory Revision；
4. OKF 页面和索引可由事实确定性生成；
5. `mnemosyne.search` 能返回相关 MemoryRef；
6. `mnemosyne.open` 能按层级读取；
7. 披露事实可重放；Harness 公开 API 支持自动注入时，注入内容在重启和 replay 后一致；
8. Frozen 记忆默认不可见；
9. 插件禁用后 Harness 继续正常运行；
10. 不依赖向量数据库和外部数据库服务。

## 15. 质量评测

必须至少测量：

- Retrieval Recall；
- Context Precision；
- Frozen Leakage；
- Wrong-memory Adoption；
- Progressive Disclosure Token Cost；
- Replay Consistency；
- Memory-assisted Task Success；
- Plugin-disabled Baseline；
- Acquisition Trigger/Skip Rate；
- Acquisition Token/Latency；
- Retrieval P50/P95 Latency；
- Tool-only 与自动注入的独立收益和成本。

任何“能力提升”结论必须来自配对任务或固定 Fixture，不以单次演示代替评测。

最小对照固定为三组：无记忆、Tool-only、自动注入。Fixture、任务族、随机种子、模型版本、执行次数、指标和阈值必须在运行前冻结；修改任何一项都要产生新评测版本，不得覆盖旧结果。

## 16. 当前未决问题

1. 最低兼容版本是否固定为 `0.1.0-rc.5`，还是在 M0 实现后扩大兼容范围；
2. npm 正式发布前采用 GitHub commit 安装还是本地 tarball 作为主要测试路径；
3. M1 是否直接采用 M0 已确认的 `Session.meta.cwd`，以及怎样验证其规范化、信任与 Workspace 切换边界；
4. dsh-Mnemosyne 自定义 SessionEvent 首版应全部标记 ignorable，还是只对纯审计事件标记；
5. 是否由 Harness 子 Agent 承担 Librarian，或使用专用只读 Agent Preset；
6. 项目记忆晋升全局记忆的第一版证据规则；
7. 现有 Chat Node/Renderer 扩展点能否满足 Web Manager；不能满足时只提供已有 command/tool 能力；
8. 现有权限、Sandbox、Profile 和卸载接口能否支持插件自进化熔断；缺一项则不启用自动进化。
9. M0.5A 冻结的 Fixture 规模、执行次数和定量阈值是否足以支持 GO 决策；
10. 自动注入仅有 `UserMessage` 角色时，是否只保留实验能力而不作为默认产品行为。

未决项必须在对应阶段开始前通过接口审计或 ADR 关闭，不允许实现时隐式决定。

## 17. 设计记录与后续阶段模板

### 17.1 Architecture Decision Record

| ADR | 决议 | 状态 |
|---|---|---|
| ADR-001 | dsh-Mnemosyne 以 Harness 原生插件交付 | Accepted |
| ADR-002 | 采用 OKF + 渐进式披露，不引入向量数据库；接受 M0.5 数据检验 | Accepted |
| ADR-003 | 规范事实不可变，派生视图可重建 | Accepted |
| ADR-004 | 错误记忆冻结而非自动删除 | Accepted |
| ADR-005 | 自动注入必须经过 dsh 现有可重放链路；否则仅提供 Tool-only | Accepted |
| ADR-006 | 记忆 MVP 与插件自进化分阶段交付 | Accepted |
| ADR-007 | 所有能力零上游改动依赖，只使用 dsh 现有公开扩展点 | Accepted |
| ADR-008 | 缺少公开注入/事件接口时采用 Tool-only，不维护 dsh 私有补丁 | Accepted |
| ADR-009 | M0.5 使用可移植的确定性文本索引，不引入原生数据库依赖 | Accepted |
| ADR-010 | M0.5 的 GO/ADJUST/STOP 决议控制 M1～M9 范围与 E0+ 是否继续 | Accepted |

### 17.2 阶段设计模板

后续每个阶段在本文末尾追加以下结构：

```text
## Mx：阶段名称

状态：Draft | Approved | Implementing | Verified

### 目标
### 假设与已确认 Harness 接口
### 范围
### 非范围
### Schema / API / Event
### 存储与安全边界
### 文件修改计划
### 失败测试
### 自动门禁
### 真实联调
### 风险与未决项
### 交付记录
```

实现过程中发现协议问题时，先更新设计和 ADR，再修改代码。

## 18. M0：Harness 接口审计与最小插件

状态：Implementing；代码与运行时 Smoke 已完成，pnpm 11 冻结安装门禁等待供应链最小发布时间策略自然放行后终验。

### 18.1 目标

M0 只证明 dsh-Mnemosyne 能作为 out-of-tree DeepSeek Harness 插件被安装、加载、配置、观察和卸载，并锁定后续长期记忆需要使用的公开接口。

M0 完成后必须回答：

1. 插件怎样打包和安装；
2. 插件怎样注册 Tool、事件监听器和配置；
3. 插件卸载或 HMR 后贡献是否完全撤销；
4. 模型上下文怎样通过现有链路进入持久 Session 日志；
5. Session、Project Workspace 和 Harness Home 怎样通过公开 API 识别；
6. 后续 M1～M9 分别依赖哪些公开包与扩展点。

M0 的实现假设与硬边界：

- 包名固定为 `dsh-mnemosyne`，插件名与 patch id 同样使用 `dsh-mnemosyne`；
- 只使用审计基线中可由 out-of-tree npm 包导入的公开 API；
- 以本地预构建 tarball 作为主要安装 Smoke，源码 link 仅作开发验证；
- 不要求 API Key、网络、真实模型、用户正式 Profile 或正式 Workspace；
- 不以 M0 的事件观察能力提前实现 Episode、披露、检索或任何 M0.5 行为；
- 发现 rc.6 与审计 Commit 契约不一致时停止实现并更新兼容性记录，不猜测或调用私有 API。

### 18.2 已锁定审计基线

| 项目 | 固定值 |
|---|---|
| 官方仓库 | `deepseek-ai/deepseek-harness` |
| 分支 | `master` |
| 审计 Commit | `47f943859bef60e4160492346772ded9b24f765a` |
| Commit 时间 | `2026-08-13T19:38:46+08:00` |
| 源码 manifest 版本 | `0.1.0-rc.5` |
| npm 安装验证目标 | `@deepseek-ai/dsh@0.1.0-rc.6` |
| Node.js | `^22.19.0 || >=24.0.0` |
| pnpm | `11.7.0` |

审计只认可该 Commit 上公开文档、包导出和测试锁定的行为。npm 于审计日已经发布 `0.1.0-rc.6`，因此 M0 实现必须分别记录“源码 API 审计基线”和“npm 安装验证基线”，并用 Smoke 证明二者契约一致。以后升级基线必须新增兼容性记录，不覆盖本次结论。

### 18.3 已确认的公开扩展点

| 能力 | 已确认接口 | M0 结论 | 官方证据 |
|---|---|---|---|
| 插件入口 | 导出 `apply(ctx, config)`，可选 `name`/`inject`/`Config` | 可用 | `docs/user/develop/basic/index.zh.md` |
| 配置校验 | Schemastery `Config` Schema | 可用 | `docs/user/develop/basic/config.zh.md` |
| 外部安装 | npm Bundle + `dsh.bundle.patch` | 可用 | `docs/user/develop/basic/publish.zh.md` |
| Profile 管理 | `dsh plugin --profile <name> add/remove` | 可用 | 同上 |
| 本地覆盖 | `dsh --profile <name> --patch <file>` | 可用 | 同上 |
| 工具注册 | `ctx.tools.register(defineTool(...))` | 可用 | `docs/user/develop/basic/tool.zh.md` |
| 事件监听 | `ctx.on()`；支持声明合并 | 可用 | `docs/user/develop/framework/events.zh.md` |
| Session 观察 | `ctx.on('session/event', ...)` | 可用 | `docs/subsystems/session.zh.md` |
| 自定义持久事件 | 扩展 `SessionEventMap` 后 `Session.append()` | 可用 | 同上 |
| 上下文注入 | `agent.inject(UserMessage)` | 可用 | `packages/core/agent/README.zh.md` |
| 注入可重放 | 注入被记录为 `user/message` | 可用 | `packages/core/session/README.zh.md` |
| Harness Home | `resolveDshHome()` / `dshHomePath()` | 可用 | `@deepseek-ai/dsh-home-paths` |
| Workspace | Session 元数据中的已校验 `cwd` | 可用，M1 再冻结存储策略 | `@deepseek-ai/dsh-session` |
| 自动清理 | Cordis Effect 随插件卸载撤销 | 可用 | 第一个插件教程 |
| HMR | 配置变化卸载旧实例并加载新实例 | 可用 | 插件配置教程 |
| 后台任务 | `ctx.jobs` | 可用，M7 使用 | `docs/capability-seams.zh.md` |
| Subagent | `ctx.subagents` Provider + Tool | 可用，M7 使用 | `docs/cookbook/extension-cookbook.zh.md` |
| Web 扩展 | Conversation Node + keyed renderer | 可用，M8 使用 | 同上 |

因此，长期记忆与受治理插件自进化在架构上不需要修改 DeepSeek Harness。后续阶段只需验证具体调用契约和版本兼容性。

### 18.4 M0 范围

M0 实现以下最小能力：

1. 一个可构建的 ESM npm Bundle；
2. 一个 `cordis.patch.yml` 插件层；
3. 一个只包含 `enabled` 的最小配置 Schema，并锁定未知字段的实测行为；
4. 一个只读 `mnemosyne_status` Tool；
5. 一个只观察、不持久化的 `session/event` 监听器；
6. 可验证的加载、HMR、卸载和 Profile 安装流程；
7. 版本/Commit 兼容性报告。

配置协议固定为：

```ts
interface Config {
  enabled?: boolean
}
```

`enabled` 默认 `true`，只接受 boolean。配置解析由导出的 Schemastery `Config` 完成；错误类型必须在插件加载阶段失败。M0 实现时必须用测试确认当前 Schemastery 对未知字段的实际行为，并把结果写入交付记录，不自行添加与 dsh Loader 并行的第二套配置解析器。

`mnemosyne_status` 只返回：

```json
{
  "plugin": "dsh-Mnemosyne",
  "version": "0.0.0-dev",
  "protocol_version": 1,
  "memory_enabled": false,
  "status": "ready"
}
```

它不读取 Session 内容、不访问文件、不调用模型、不执行命令。

Tool 没有输入参数；规范输出必须是 `additionalProperties: false` 的固定对象。`execute` 返回结构化对象，`render` 只渲染该对象的稳定 JSON，不追加环境路径、事件计数、时间戳或调试字段。

### 18.5 M0 非范围

- 不创建 Fact Store；
- 不记录 Episode；
- 不定义 Memory Revision Schema；
- 不注入模型上下文；
- 不追加自定义 SessionEvent；
- 不调用 API Key 或真实模型；
- 不创建 Librarian/Subagent；
- 不实现插件生成、Canary 或回滚；
- 不注册 Web UI；
- 不修改任何 DeepSeek Harness 文件。

### 18.6 包结构

M0 计划创建：

```text
dsh-Mnemosyne/
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.json
├── tsdown.config.ts
├── cordis.patch.yml
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── status.ts
│   └── compatibility.ts
├── tests/
│   ├── config.spec.ts
│   ├── lifecycle.spec.ts
│   ├── status-tool.spec.ts
│   ├── event-observer.spec.ts
│   ├── bundle-manifest.spec.ts
│   └── bundle-smoke.spec.ts
└── docs/
    └── DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md
```

保持单 npm 包，不提前建立 monorepo。只有后续 Web Manager 或独立协议包确实需要发布边界时再拆包。

### 18.7 Bundle 与依赖设计

`package.json` 必须：

- `type: module`；
- `main` 指向构建产物；
- `files` 只包含构建产物和 `cordis.patch.yml`；
- 声明 `dsh.bundle.patch`；
- 使用 `prepare` 支持 GitHub commit 安装；
- 将 Cordis、Schemastery 和 dsh Service Definition 包声明为 `peerDependencies`；宿主通过 `$DSH_HOME/profiles/node_modules` 提供安装依赖闭包，插件不得复制这些运行时契约包；
- 将测试、类型检查和构建依赖放入 `devDependencies`；
- 锁定 Node.js 最低版本；
- 不声明安装时网络下载或额外二进制。

Bundle manifest 使用官方公开结构，不使用自定义顶层字段：

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

脚本最小集合固定为 `typecheck`、`test`、`build`、`prepare` 和 `pack:check`。`prepare` 只调用自包含构建，不执行测试、不访问网络、不读取仓库外文件。

初始公开依赖候选：

```text
@deepseek-ai/cordis
@deepseek-ai/schemastery
@deepseek-ai/dsh-tools
@deepseek-ai/dsh-session
```

M0 实现只允许实际使用的依赖进入 manifest；候选列表不是全部必装。四个实际导入包均作为 peer 由 dsh Profile 的宿主依赖回退目录解析，发布包不含普通运行时 dependency，避免重复 Service 身份和本地 tarball 安装时联网。`dsh-agent`、`dsh-home-paths`、Job、Subagent 和 Web 包都不属于 M0 依赖。

版本策略：

- dsh Service Definition 的开发依赖和兼容性测试显式使用 `0.1.0-rc.6`；
- 不使用裸 `latest` 安装 dsh 子包：审计日 `@deepseek-ai/dsh-tools`、`dsh-session`、`dsh-agent`、`dsh-home-paths` 和 `dsh-base` 的 `next` 为 `0.1.0-rc.6`，部分 `latest` 仍指向旧版；
- Cordis 初始验证版本为 `4.0.1`；Schemastery 初始验证版本为 `3.18.1`；
- TypeScript、Vitest 与 tsdown 初始验证版本分别为 `^6.0.3`、`^4.1.8` 与 `^0.22.2`，实现生成 lockfile 后以 lockfile 精确版本为准；
- M0 阶段不声明宽泛兼容范围，待 rc.6 的构建、Loader 和 Profile Smoke 全部通过后再决定 peer range。

### 18.8 插件生命周期设计

插件使用函数形态：

```text
apply(ctx, config)
  → 校验配置
  → 注册 status tool
  → 注册只读 session/event listener
  → 返回，由 Cordis 管理 Effect 生命周期
```

配置第一版只有：

```yaml
enabled: true
```

Bundle patch 固定为一个 insert 层：

```yaml
- insert:
    - id: dsh-mnemosyne
      name: dsh-mnemosyne
      config:
        enabled: true
```

插件模块导出 `name = 'dsh-mnemosyne'`、`inject = ['tools']`、Schemastery `Config` 和 `apply(ctx, config)`。不得在 patch 与模块中重复声明两套依赖逻辑。

规则：

- `enabled=false` 时不注册 Tool 和监听器；
- `enabled=true` 时注册一次；
- HMR 不能产生重复 Tool 或重复监听器；
- 卸载后所有注册必须消失；
- 不创建全局单例或进程外资源；
- M0 不需要手写清理函数，除非测试证明存在非 Cordis 资源。

### 18.9 事件观察边界

M0 的 `session/event` 监听器只维护插件实例内的测试计数，不记录 payload、不输出 Prompt、不打印工具参数。它只验证：

- 插件能接收到已有 durable event；
- HMR 后旧监听器不再接收事件；
- 卸载后无残留监听器；
- 多 Session 不共享错误的实例状态。

测试计数不得进入 Tool 输出或任何持久存储。生产入口不导出可写全局计数器；测试通过 Cordis 生命周期、事件触发结果与 dispose 后行为观察注册是否生效。

正式 Episode 采集在 M2 设计中定义。

### 18.10 失败测试

实现前先写以下失败测试：

1. 无效 Config 被 Schemastery 拒绝；
2. `enabled=false` 不注册任何贡献；
3. `enabled=true` 只注册一个 `mnemosyne_status`；
4. Tool 输出严格符合固定 Schema；
5. Tool 不读文件、不访问网络、不执行进程；
6. `session/event` 能被观察，但 payload 不进入日志输出；
7. 插件 dispose 后 Tool 和 listener 全部消失；
8. 配置 HMR 不重复注册；
9. `cordis.patch.yml` 能被 loader 解析；
10. Bundle `package.json` manifest 可被 dsh 识别；
11. `dsh --dump-config` 能看到且只看到一个 Mnemosyne 插件行；
12. `dsh plugin remove` 后配置树不再包含该行；
13. tarball 只包含声明的构建产物、类型声明、`cordis.patch.yml`、README 与必要 manifest；许可证在项目正式选型后再纳入发布白名单；
14. tarball 安装不执行网络下载或原生二进制安装；
15. 测试与运行时没有 API Key 时仍能完成全部 M0 行为；
16. rc.6 类型编译与运行时 Smoke 和审计 Commit 的公开契约一致。

测试分四层执行：

1. 纯单元测试：Config、兼容性常量和 status 输出；
2. Cordis 组件测试：Tool/listener 注册、事件触发、dispose、HMR 和多实例隔离；
3. Bundle 测试：构建入口、manifest、patch、pack 文件白名单；
4. dsh Profile Smoke：隔离 `DSH_HOME` 下 add、dump-config、remove 与二次 dump-config。

### 18.11 自动门禁

M0 最终至少运行：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack
pnpm pack:check
git diff --check
```

`pnpm pack` 后必须解包或列出 tarball 内容，与 `files` 白名单逐项比较；仅“成功生成 tgz”不算通过。

另运行无 API Key 的 dsh 协议 Smoke：

```bash
dsh plugin --profile mnemosyne-m0 add <local-package-or-tarball>
dsh --profile mnemosyne-m0 --dump-config
dsh plugin --profile mnemosyne-m0 remove dsh-mnemosyne
dsh --profile mnemosyne-m0 --dump-config
```

Smoke 必须使用由测试创建的隔离临时 `DSH_HOME`，记录并校验其绝对路径不等于用户当前 `DSH_HOME`，完成后只清理该已解析临时目录，不能修改用户正式 Profile。

### 18.12 真实联调

自动门禁通过后进行一次本机 dsh 联调：

1. 使用临时 `DSH_HOME` 创建测试 Profile；
2. 安装本地 tarball；
3. 用 `--dump-config` 验证 Bundle 层与唯一插件行；
4. 通过本地 Cordis/Fake Harness 组合加载插件，不启动真实模型；
5. 使用 Fake/Mock Adapter 调用 `mnemosyne_status`；
6. 发出合成 `session/event`，验证只读观察与无 payload 泄漏；
7. 修改 `enabled` 验证 HMR 卸载和重新加载；
8. 删除插件并确认配置树恢复且最小 Harness 组合仍能启动。

正式用户环境与真实模型验证不属于 M0。

### 18.13 成功标准

M0 只有同时满足以下条件才算完成：

- Bundle 可安装、可加载、可卸载；
- 所有贡献均由 Cordis 生命周期自动撤销；
- status Tool 严格只读且输出稳定；
- 插件运行时无文件、网络、子进程和模型副作用；
- 无 DeepSeek Harness 源码修改或私有 API；
- 临时 Profile 安装/删除前后配置树符合预期；
- 文档记录准确 Commit 和兼容性证据；
- 自动测试、构建、打包和 Smoke 全部通过。

以下任一情况出现时 M0 不得标记完成：

- 需要修改 dsh 源码、读取私有文件或复制内部实现；
- 测试只证明 TypeScript 编译，未证明 Profile 安装与卸载；
- Tool 通过直接调用函数测试，但未经过 `ctx.tools` 注册表；
- listener 通过手工调用回调测试，但未经过 Cordis `session/event`；
- Smoke 使用用户正式 Profile、需要 API Key 或启动真实模型；
- rc.6 契约与审计 Commit 不一致但未记录。

### 18.14 M0 风险与待实现时确认

1. 源码审计 Commit 的 manifest 为 rc.5，而 npm 安装目标为 rc.6；M0 必须用编译和 Smoke 验证公开类型与运行时一致，不能只凭版本号推断。
2. dsh 子包的 `latest`/`next` 标签暂不统一，所有安装命令必须显式写 `0.1.0-rc.6`。
3. GitHub 安装会执行 `prepare`，必须记录 pnpm `allowBuilds` 安全提示；正式发布优先预构建 npm 包或 tarball。
4. dsh 仍处于 RC 阶段，公开包的 semver 范围应在实际安装验证后确定。
5. `dsh plugin remove` 是 Profile 级回滚；运行中 HMR 是实例级回滚，两者都要测试。
6. M0 不验证长期存储目录权限，该协议属于 M1。

### 18.15 M0 交付记录

状态：🟡 实现与运行时 Smoke 已通过；等待依赖最小发布时间策略放行后复核 pnpm 11 冻结安装门禁（2026-08-14）。

实际交付：

- 实际修改文件：`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig.json`、`tsdown.config.ts`、`vitest.config.ts`、`cordis.patch.yml`、`src/index.ts`、`src/config.ts`、`src/status.ts`、`src/compatibility.ts`、`tests/` 下 M0 测试、Profile 运行时 Smoke 与 `pack-check.mjs`；保留本轮既有 `README.md` 和本总体设计文档改动。许可证仍待用户选型，未伪造默认许可证。
- 最终运行时契约均为 peer：`@deepseek-ai/cordis@4.0.1`、`@deepseek-ai/dsh-tools@0.1.0-rc.6`、`@deepseek-ai/dsh-session@0.1.0-rc.6`、`@deepseek-ai/schemastery@3.18.1`。dsh 启动时维护 `$DSH_HOME/profiles/node_modules` 宿主依赖回退目录；隔离 Profile 中已实测从该目录解析并执行插件，发布包不复制 Service Definition 或 Schemastery。测试/构建依赖只在 `devDependencies`，精确解析版本记录在 lockfile。上述均为公开包，无私有 API。
- 兼容性基线：源码审计 Commit `47f943859bef60e4160492346772ded9b24f765a`；npm 验证目标 `0.1.0-rc.6`。公开类型编译、Cordis 组件测试与 Profile Smoke 均通过，未调用私有 API。

实测契约与验证：

- Schemastery 对错误 `enabled` 类型抛出校验错误；对未知字段的实际行为是保留未知字段，本插件不添加第二套配置解析器。
- `mnemosyne_status` 已通过真实 `ctx.tools` 注册表执行，输出固定五字段 JSON；Tool 输出 schema 关闭额外字段，Tool 无文件、网络、进程、模型副作用。
- `session/event` 已通过真实 Cordis 事件总线观察；只增加实例内计数，不保存或输出 payload。Fiber dispose 后工具和监听器均撤销。
- `fiber.update({ enabled: false/true })` 已验证 HMR 风格卸载/重载不重复注册；两个独立 Cordis 根 Context 的实例状态互不共享。
- tarball 实际内容为 `cordis.patch.yml`、`dist/index.mjs`、`dist/index.d.mts`、`README.md`、`package.json`；`prepare` 只运行本地构建，不下载网络或安装原生二进制。
- 隔离 `DSH_HOME=/private/tmp/dsh-mnemosyne-m0-peer.sgJvSF` 完成 `plugin add`、`dump-config`、Profile 安装包真实导入与 `ctx.tools` 执行、Fiber dispose、`plugin remove`、再次 `dump-config`：安装时插件层恰为 1，删除后为 0；未修改正式 Profile、未使用 API Key、未启动真实模型。

门禁结果：

- `pnpm@11.7.0 install --frozen-lockfile` ⏳：当前被本机供应链 `minimumReleaseAge` 策略拒绝；rc.6 与 yuku-codegen 依赖尚未超过活动截止时间。未关闭或绕过策略，待时间窗自然放行后复核。
- 现有锁定依赖环境下直接执行 `tsc --noEmit` ✅
- 现有锁定依赖环境下直接执行 `vitest run` ✅（7 个测试文件、14 个测试）
- 现有锁定依赖环境下直接执行 `tsdown` ✅
- `npm pack --ignore-scripts` / `node tests/pack-check.mjs` ✅（5 个 tarball 文件，白名单通过）
- `git diff --check` ✅

范围声明：

- M0 未创建 Fact Store、Episode、Memory Schema、OKF 索引、检索/披露链、自动注入、自定义持久事件、Librarian、Web UI 或插件自进化。
- **未进入 M0.5，未提交、未推送、未创建 Tag。** 在 pnpm 11 冻结安装门禁复核前，不把 M0 标记为完整 Verified。


### 18.16 M0 实现检查清单

```text
实现独立仓库 dsh-Mnemosyne 的 M0：Harness 接口审计与最小插件。

工作目录：/Users/czy/Desktop/demo/dsh-Mnemosyne
唯一设计依据：docs/DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md
本轮只执行第 18 章 M0；第 19 章 M0.5 仅作后续背景，禁止实现。

开始前：
1. 完整读取总体设计第 1～18 章，特别是 3.2、10.4、17.1 与 18.1～18.16；
2. 检查当前 git status，保留用户已有 README 与文档改动；
3. 核对审计 Commit 47f943859bef60e4160492346772ded9b24f765a 的公开插件、Tool、事件、Bundle 与 Profile 文档；
4. 安装依赖时显式锁定 rc.6，禁止使用裸 latest；
5. 若 rc.6 与审计 Commit 的公开契约不一致，停止并报告，不调用私有 API，不修改 dsh，不自行扩大范围。

按 TDD 实现：
- 先写第 18.10 节的失败测试并证明它们在实现前失败；
- 只创建第 18.6 节列出的最小单包文件；
- 实现严格 enabled 配置、只读 mnemosyne_status Tool、只读 session/event 观察和 Bundle patch；
- Tool 必须经真实 ctx.tools 注册表调用；事件必须经 Cordis session/event 路径验证；
- 覆盖 dispose、HMR、多实例、tarball 白名单和隔离 Profile add/dump/remove Smoke；
- 不创建 Fact Store、Episode、Memory、索引、Librarian、自动注入、自定义持久事件、Web UI 或自进化代码；
- 不需要 API Key；插件运行时不访问网络、不调用真实模型、不修改用户正式 DSH_HOME/Profile。依赖安装使用公开 npm 是构建步骤，不得被误报为插件运行时网络行为。

完成后运行第 18.11 节全部门禁。任何环境失败必须记录原命令、退出码和错误，不得伪造通过。随后进行一次独立 review 和 security review，只修复 M0 范围内的真实问题。

最终报告必须包含：
- 实际修改文件；
- 最终依赖和精确版本；
- Config/Tool/Event/Bundle/Profile 的实测契约；
- 失败测试先行证据；
- 全部门禁和 Smoke 结果；
- tarball 文件清单；
- dispose/HMR/remove 撤销证据；
- 环境限制和未决问题；
- 明确声明未进入 M0.5、未提交、未推送、未创建 Tag。
```

---

## 19. M0.5：核心价值纵向验证

> 状态：M0.5A/B/C、M0.5D-D0/D1、M0.5E/F 与 D2-A/B1/B2 已完成；D2-B3 已于 2026-08-24 执行并以 `real_provider_plumbing_fail/circuit_open` 安全结束，D3 未授权。

### 19.1 目标

在建设完整 Fact Store、治理、Doctor、Web Manager 和自进化之前，用最薄的真实插件链路验证三个核心假设：

1. 不使用向量数据库时，换措辞、别名和跨组件任务仍能召回正确记忆；
2. 被检索和披露的记忆能够提高固定任务族的完成效果，而不是只增加上下文；
3. Acquisition、检索和披露的 Token、延迟与错误采纳成本低于实际收益。

### 19.2 阶段拆分

```text
M0.5A 评测协议与 Acquisition Schema 冻结
  → M0.5B 最小录制/检索/披露/重放纵向链路
  → M0.5C 三组执行骨架与公开上下文链路验证（Fake Adapter）
  → M0.5D-D0/D1 评测协议 v2 与公开 Agent Loop 离线执行器
  → M0.5E D2 Canary 离线安全预检
  → M0.5F 公开 Provider 桥接审计、零调用 Dry-run 与用户授权门禁
  → M0.5D-D2 用户授权的真实 Provider Canary
  → M0.5D-D3 用户再次授权的完整三组配对评测
  → GO / ADJUST / STOP 评审 Gate
```

M0.5A 必须在实现和运行评测前冻结 Fixture、任务族、模型版本、随机种子、重复次数、指标、阈值和报告 Schema。任何修改都创建新评测版本，不能覆盖旧基线。

### 19.3 最小范围

- 只支持固定 Fixture 和隔离临时 Profile/Workspace；
- 从任务完成事件形成脱敏 Episode Candidate；
- 用稳定幂等键和严格重复规则执行 Acquisition；
- 使用结构化字段、英文词元、中文字符 n-gram、别名扩展和简化 BM25 生成候选；
- 提供最小 `mnemosyne.search` / `mnemosyne.open`；
- 记录 Retrieval Request、Candidate Universe、实际读取引用、结构化选择、排序和 Disclosure Fact；
- 验证 Tool-only 重放；公开 API 允许时把自动注入作为独立实验组；
- 产出机器可读配对评测报告和 GO/ADJUST/STOP 建议。

### 19.4 非范围

- 不实现生产级 Fact Store、完整 OKF Compiler 或跨项目 Global Promotion；
- 不实现完整 Lifecycle、Health、Freeze/Unfreeze、Doctor/Repair 或 Web Manager；
- 不实现 Librarian 自主写入、自动合并、规范事实归档或插件自进化；
- 不调用向量数据库、Embedding 服务或 dsh 私有接口；
- 不用单次演示替代固定 Fixture 和配对结果。

### 19.5 Acquisition 协议

```text
durable task completion / explicit checkpoint
  → deterministic eligibility
  → exact idempotency and novelty skip
  → read-only structured extraction
  → redaction and strict schema validation
  → Candidate Memory
  → retrieval fixture / audit record
```

自动跳过只允许依据事件幂等键、规范化事实 Hash 或结构化任务指纹。文本相似只产生重复候选关系，不得阻止提取。提取优先异步运行；失败、超时或非法输出只记录稳定诊断，不改变原任务退出状态，也不生成半成品记忆。

### 19.6 检索与查询改写

确定性层负责字段过滤、文本规范化、路径/错误码/组件别名扩展、n-gram 倒排和 BM25 排序。可选 Librarian 只能输出严格结构化的查询扩展与候选建议；输入、输出和使用的索引引用必须记录，最终排序仍由确定函数完成。

M0.5 不引入 SQLite FTS5 或其他原生数据库依赖。该限制首先用于控制插件跨平台打包风险，不妨碍 M1+ 在公开兼容性测试通过后用新的 ADR 替换内部索引实现；ADR-002 的无向量边界不变。

### 19.7 三组对照

| 组 | 行为 | 目的 |
|---|---|---|
| 无记忆 | 禁用 Mnemosyne 检索和披露 | 插件禁用基线 |
| Tool-only | Agent 显式调用 search/open | 验证低语义污染的记忆收益 |
| 自动注入 | 通过公开可重放通道注入带 disclosure ID 的记忆外壳 | 量化便利性、Token 与角色污染成本 |

自动注入组是实验能力，不因协议可用就默认启用。若结果弱于 Tool-only、出现错误采纳或无法保持重放一致，产品保持 Tool-only。

### 19.8 预注册指标与建议阈值

M0.5A 在首次评测前确认或修订下列数值；确认后冻结为该评测版本的硬 Gate：

| 指标 | 建议阈值 |
|---|---:|
| 困难 Fixture Retrieval Recall@5 | ≥ 0.80 |
| Context Precision@5 | ≥ 0.70 |
| Frozen/Excluded Leakage | 0 |
| Replay Consistency | 1.00 |
| Wrong-memory Adoption | ≤ 0.05 |
| Tool-only 在记忆依赖任务族的成功率提升 | 相对无记忆 ≥ 10 个百分点，且非记忆任务不回归 |
| Acquisition + Retrieval 中位 Token 开销 | ≤ 原任务 Token 的 15% |
| 本地确定性检索 P95 延迟 | ≤ 1 秒 |
| Acquisition 对原任务关键路径阻塞 | 0；默认异步 |

样本不足时报告 `insufficient_evidence`，不得给出 GO。自动注入不设必须优于 Tool-only 的前提；它必须独立通过错误采纳、重放和安全检查才允许进入后续产品设计。

### 19.9 决策 Gate

- **GO**：协议 Gate 全部通过，核心指标达到冻结阈值，允许按证据重基线化 M1～M9；
- **ADJUST**：链路有效但召回、成本或任务效果未过线，只允许修改 Acquisition、索引、查询扩展或披露策略后重跑同版 Fixture；
- **STOP**：记忆净收益不足或安全/重放边界无法满足，停止 Doctor 深化、Web Manager、复杂治理和 E0+。

Gate 决议、原始结果 Hash、环境、模型版本与被批准的后续范围必须写入文档。没有 GO，不得把“设计已完成”解释为继续实现完整系统的授权。

### 19.10 自动门禁与真实联调

自动门禁至少覆盖：同输入候选与排序字节稳定、严格重复跳过、近似文本不被自动跳过、敏感输出拒绝、提取失败不影响任务、三组配置隔离、Disclosure Fact 重放一致、插件禁用零残留。

真实联调只使用临时 `DSH_HOME`、临时 Profile、固定 Fixture 和受控模型配置，不读取用户正式 Session 或项目记忆。M0.5 的具体文件计划、测试命令和安装步骤在 M0 验收后追加，不能在接口证据不足时预设。

### 19.11 M0.5A：评测协议与 Acquisition Schema 冻结

状态：Completed；协议、Fixture、Canonical 编码与结果/报告 Schema 已实现并通过自动门禁，尚未产生模型质量结论。

#### 19.11.1 成功标准

M0.5A 只交付一套可由程序严格读取、确定性编码和完整性校验的评测输入世界：

1. 评测协议版本、三组对照、模型请求参数、重复次数和 Gate 阈值固定；
2. 固定 Memory Catalog、Retrieval Case 与 Paired Task Fixture 可互相闭合引用；
3. Acquisition Candidate 与 Skip Decision Schema 固定，严格重复和近似重复语义分离；
4. 评测运行结果与汇总报告 Schema 固定，但本阶段不产生模型质量结论；
5. 所有规范 JSON 拒绝未知字段、非有限数、路径字段、疑似凭据和未声明自由对象；
6. 相同语义输入产生相同 Canonical Bytes 与 SHA-256；任何 Fixture 改动必须创建新版本和新 Hash。

#### 19.11.2 固定目录与模块边界

```text
src/
├── protocol/
│   ├── canonical.ts
│   ├── validation.ts
│   ├── acquisition.ts
│   └── evaluation.ts
fixtures/
└── m0.5/
    └── v1/
        ├── protocol.json
        ├── memory-catalog.json
        ├── retrieval-cases.json
        ├── paired-tasks.json
        └── fixture-manifest.json
tests/
├── protocol-canonical.spec.ts
├── acquisition-schema.spec.ts
├── evaluation-schema.spec.ts
└── fixture-integrity.spec.ts
```

这些模块是插件内部协议，不从 `dsh-mnemosyne` 包根导出；M0 公开导出保持不变。Fixture 是合成数据，不读取用户 Session、Workspace、环境变量或正式记忆。

#### 19.11.3 Canonical JSON v1

Canonical 编码规则固定为：

- UTF-8、无 BOM、无尾随换行；
- Object key 按 Unicode code point 升序；
- Array 默认保序，只有 Schema 明确声明为集合的字段才先按稳定标识排序并拒绝重复；
- String 保留原始 Unicode，不做语义同义归一；
- Number 必须有限；`-0` 编码为 `0`；禁止 `NaN`、Infinity 和指数形式漂移；
- `undefined`、函数、BigInt、Date 和自定义原型对象拒绝；
- Hash 格式固定为 `sha256_<64 lowercase hex>`，由程序对不含自身 Hash 字段的 Canonical Bytes 计算。

所有 decoder 必须先检查精确键集合，再检查字段类型、枚举、上限、引用与 Hash；不得依赖 Schemastery 的未知字段保留行为完成严格协议校验。

#### 19.11.4 Acquisition Candidate v1

```yaml
schema_version: 1
candidate_id: candidate_<stable-id>
source_event_id: event_<stable-id>
source_kind: task_completed | checkpoint | explicit_request
scope_id: scope_<stable-id>
task_fingerprint: sha256_<hex>
component: controlled-id
operation: controlled-id
title: bounded-redacted-text
summary: bounded-redacted-text
applies_when: [bounded-redacted-text]
failure_boundaries: [bounded-redacted-text]
tags: [controlled-id]
aliases: [bounded-redacted-text]
redaction_status: passed
content_sha256: sha256_<hex>
```

硬约束：

- `content_sha256` 由排除 `candidate_id` 与自身 Hash 字段后的 Candidate 规范 payload 计算；`candidate_id` 再由 `source_event_id + task_fingerprint + content_sha256` 的稳定摘要生成，不使用随机数或墙钟，避免身份与内容 Hash 循环依赖；
- title ≤ 120 字符、summary ≤ 1000 字符；条件、边界和 alias 单项 ≤ 200 字符，集合各 ≤ 16 项；tags ≤ 16；
- `scope_id` 是不透明标识，不得存绝对路径；禁止出现 `cwd`、`path`、Prompt、完整命令、思考过程或环境变量字段；
- 文本经过同一保守脱敏扫描；命中常见凭据赋值、Bearer token、私钥头或绝对用户目录时整体拒绝，不做静默替换；
- `tags` 按稳定 ID 排序；`aliases`、`applies_when`、`failure_boundaries` 先去精确重复再按 Canonical Bytes 排序；输入含重复项直接拒绝，不代替调用方修复；
- M0.5A 只验证已给出的结构化候选，不调用模型提取候选。

Skip Decision v1：

```yaml
schema_version: 1
candidate_id: candidate_<stable-id>
decision: eligible | skip_exact_event | skip_exact_content | duplicate_candidate
basis_ids: [controlled-id]
content_sha256: sha256_<hex>
```

只有 `skip_exact_event` 与 `skip_exact_content` 会阻止后续 Acquisition；`duplicate_candidate` 只记录近似/重叠关系，仍允许候选进入后续验证。`basis_ids` 非空、排序、拒绝重复。
`content_sha256` 必须由程序对排除自身 Hash 后的规范字段重算；调用方提供的 Hash 只要与重算结果不一致就拒绝。

#### 19.11.5 Fixture Set v1

Fixture Set 固定为四个协议/数据文档和一个独立 Manifest：

- `protocol.json`：协议与 Gate；
- `memory-catalog.json`：合成记忆条目；
- `retrieval-cases.json`：只测候选召回和排序；
- `paired-tasks.json`：供 M0.5C 三组运行。
- `fixture-manifest.json`：只记录上述四个文档的相对名与内容 Hash，自身不进入输入列表，解除自引用循环。

Memory Fixture 最小字段：`memory_id`、`title`、`summary`、`component`、`operation`、`tags`、`aliases`、`body`、`lifecycle`、`content_sha256`。`lifecycle` 仅允许 `active|frozen|excluded`；frozen/excluded 用于泄漏 Gate，不代表生产 Lifecycle 已实现。

Retrieval Case 最小字段：

```yaml
case_id: retrieval_<stable-id>
difficulty: exact | rephrase | alias | cross_component | negative_control
query: bounded-text
component_hint: controlled-id | null
operation_hint: controlled-id | null
expected_memory_ids: [memory_<stable-id>]
forbidden_memory_ids: [memory_<stable-id>]
```

v1 固定至少 15 个 Retrieval Case：`rephrase`、`alias`、`cross_component` 各不少于 4 个，另含 exact 与 negative control；每条有效记忆至少被一个 Case 引用，所有 frozen/excluded 条目至少被一个 `forbidden_memory_ids` 引用。困难 Fixture 定义为 rephrase、alias、cross_component 三类。

Paired Task 最小字段：`task_id`、`task_family`、`prompt`、`required_memory_ids`、`forbidden_memory_ids`、`success_assertions`、`max_steps`。`success_assertions` 是严格联合 Schema，不接受自然语言字符串：`{assertion_id, kind: exit_code, expected: 0..255}` 或 `{assertion_id, kind: result_equals, field: controlled-id, expected: JSON scalar}`；`assertion_id` 不得重复，数组按其稳定 ID 排序。v1 固定至少 6 个任务，覆盖不少于 3 个 task family；全部使用合成临时 Workspace，成功断言必须是可由程序执行的退出码或结构化结果字段比较，不允许人工主观打分作为唯一判定。

#### 19.11.6 Evaluation Protocol v1

```yaml
schema_version: 1
evaluation_id: m05_v1
fixture_version: 1
groups: [no_memory, tool_only, auto_inject]
model:
  provider: deepseek-official
  model: deepseek-v4-flash
  temperature: 0
  requested_seeds: [101, 202, 303, 404, 505]
repetitions_per_task: 5
thresholds:
  difficult_recall_at_5_min: 0.80
  context_precision_at_5_min: 0.70
  excluded_leakage_max: 0
  replay_consistency_min: 1
  wrong_memory_adoption_max: 0.05
  tool_only_success_delta_points_min: 10
  non_memory_regression_points_max: 0
  overhead_token_ratio_median_max: 0.15
  retrieval_latency_p95_ms_max: 1000
  acquisition_critical_path_blocking_max: 0
```

`groups` 的集合必须恰好为上述三值；运行顺序由 `(task_id, seed)` 的稳定 Hash 生成平衡排列并写入运行记录，避免固定组序偏差。若 Provider 不支持 seed，运行记录必须标记 `seed_honored=false`，不得伪称确定性；五次重复仍保留。

`fixture-manifest.json` 的 entries 必须恰好覆盖四个文档并按 `relative_name` 排序；每项 Hash 对应文件经严格解码、规范化后的 Canonical Bytes。该 Manifest 自身的 Canonical Hash 才是 Run/Report 使用的 `fixture_manifest_sha256`。任何 Fixture 或阈值修改必须增加 `fixture_version/evaluation_id`，不得原地覆盖 v1。

#### 19.11.7 Result 与 Report Schema

Single Run Result v1 固定记录：`run_id`、`evaluation_id`、`task_id`、`group`、`requested_seed`、`seed_honored`、`model_provider`、`model_id`、`started_at`、`duration_ms`、`success`、`failure_code|null`、`retrieved_memory_ids`、`opened_memory_ids`、`adopted_memory_ids`、`input_tokens`、`output_tokens`、`acquisition_tokens`、`retrieval_tokens`、`retrieval_latency_ms`、`disclosure_sha256|null`、`content_sha256`。

Run Result 校验必须携带并严格验证当前 Fixture Set；不得省略 Fixture 参数。`evaluation_id`、任务 ID、随机种子、Provider/Model ID 及所有 Memory 引用必须来自该 Fixture，缺失、伪造或 Manifest 不完整均拒绝。

Summary Report v1 固定记录：协议/Fixture Hash、环境版本、每组样本数、预注册指标、每项 Gate 的 `pass|fail|insufficient_evidence`、原始 Run Result Hash 列表、最终建议 `go|adjust|stop|insufficient_evidence`。`sample_counts` 的键必须恰好为 `no_memory|tool_only|auto_inject`；`metrics` 与 `gates` 的键必须恰好为 `difficult_recall_at_5`、`context_precision_at_5`、`excluded_leakage`、`replay_consistency`、`wrong_memory_adoption`、`tool_only_success_delta_points`、`non_memory_regression_points`、`overhead_token_ratio_median`、`retrieval_latency_p95_ms`、`acquisition_critical_path_blocking`。程序只能按冻结阈值计算建议；不得输出“模型能力提升”或统计显著性结论。M0.5A 只实现 Schema 与空/合成结果校验，不运行真实模型。

其中 `tool_only_success_delta_points` 是带方向的成功率差值，允许 `-100..100`；负值表示记忆路径相对 tool-only 下降，并按阈值计算为失败，不得因负值无法落盘而掩盖回归。

报告裁决函数固定为：指标缺失时对应 Gate 必须为 `insufficient_evidence`；指标存在时 Gate 必须由协议阈值计算，调用方不得自报状态。任一 Gate 证据不足 → `insufficient_evidence`；全部通过 → `go`；`excluded_leakage`、`replay_consistency`、`wrong_memory_adoption`、`non_memory_regression_points` 或 `acquisition_critical_path_blocking` 任一失败 → `stop`；其余质量/成本 Gate 失败 → `adjust`。`run_result_hashes` 数量必须等于三组 `sample_counts` 总和并拒绝重复。

隐私约束：Result/Report 不保存完整 Prompt、Memory body、模型输出、工具参数、绝对路径、环境变量或隐藏思考；只保存受控 ID、计数、布尔、稳定错误码和 Hash。

#### 19.11.8 失败测试先行矩阵

实现前必须证明以下测试失败：

1. Canonical key 顺序、`-0`、非法数、非 plain object；
2. 所有 Schema 的未知字段、错误联合、超长文本、重复集合项与错误 Hash；
3. Candidate 路径、凭据、私钥、Bearer token 和命令/Prompt 字段拒绝；
4. strict exact skip 与 `duplicate_candidate` 不跳过的语义；
5. Fixture 重复 ID、悬空 expected/forbidden ref、active/frozen 集合冲突；
6. 困难 Case 数量不足、task family/paired task 数量不足；
7. 协议缺组、重复组、阈值漂移、非五次重复；
8. Fixture Manifest Hash 漂移；
9. Run Result 泄漏 Prompt/路径/凭据或引用未知 task/memory；
10. 相同输入重复编码和 Hash 完全一致。

#### 19.11.9 自动门禁与交付边界

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
node tests/pack-check.mjs
git diff --check
```

若 `minimumReleaseAge` 仍阻止安装，必须在隔离副本记录原始错误；允许使用已锁定且此前验证过的本地依赖执行其余代码门禁，但不得把冻结安装标为通过。

M0.5A 完成报告必须给出 Fixture 数量、四个输入文档 Hash、Manifest Hash、Schema 兼容策略、失败测试证据和所有环境限制。不得实现文件存储、生产采集、BM25、search/open Tool、Disclosure、自动注入、模型调用或 GO/ADJUST/STOP 实际裁决。

#### 19.11.10 M0.5A 验收记录

M0.5A 于 2026-08-14 完成实现并由 Sol 独立复核：

- Fixture 包含 7 条合成 Memory（5 active、1 frozen、1 excluded）、15 条 Retrieval Case 与 6 条 Paired Task；困难 Case 覆盖 rephrase、alias、cross-component 各 4 条；
- 四个输入文档的规范 Hash 分别为：`protocol.json = sha256_62fc6353c4ea09979b8e8243d44df374d232c824287f41601aafd0e27a5c6f67`、`memory-catalog.json = sha256_9d335b99ec7a1c9578ad2c7df1c5e15f9588ecf27d92276d722759b9165ab5c8`、`retrieval-cases.json = sha256_561d204a2be27256165adf63d1b190d2f441dc18a2910797b8b5f2ae9b783ce5`、`paired-tasks.json = sha256_9e7f8c27450acb04b760b74092ee068ccb6e5e200d7bac8aa871a71b3aa84ccb`；
- 独立 Manifest 的规范 Hash 为 `sha256_982b502287eceb4f509a1af6cbcd1e48e769cda39455152a3dff38b3579c762c`；Manifest 绑定严格解码并规范化后的四个文档，不绑定 JSON 排版字节；
- Candidate、Skip Decision、Fixture、Run Result 与 Summary Report 均执行精确键、引用闭合、重算 Hash、边界和敏感文本校验；Run Result 必须绑定完整 Fixture Set；
- Paired Task 的成功断言为 `exit_code` / `result_equals` 严格联合，不接受自然语言自由断言；
- 报告 Gate 与 Recommendation 只由冻结阈值确定性派生；负的 Tool-only 成功率差值可被如实记录并判为失败，不会因 Schema 范围错误而丢失；
- 本地锁定依赖下 TypeScript、33 项测试、构建、包白名单与 `git diff --check` 全部通过；`pnpm install --frozen-lockfile` 仍被 pnpm 11 `minimumReleaseAge` 对 41 个新发布依赖的供应链时间窗阻断，未绕过、未伪报通过；
- 本阶段没有实现文件存储、生产采集、检索 Tool、Disclosure、自动注入或模型调用，不构成 M0.5 GO 结论。

### 19.12 M0.5B：固定 Fixture 检索、渐进式披露与 Tool-only 重放

状态：✅ M0.5B 已完成并通过 Sol 独立验收；禁止把本节结果外推为真实模型收益或生产长期记忆已完成。

#### 19.12.1 目标与成功标准

M0.5B 在 M0.5A 的固定 Fixture 世界上交付最薄的真实插件读取链路：

```text
固定 Memory Catalog
  → 确定性本地索引
  → mnemosyne_search（L0/L1/L2）
  → mnemosyne_open（显式 L3）
  → 带 Hash 的 Disclosure Envelope
  → 从已记录 Envelope 重放，不重新执行检索
```

成功标准：

1. 15 条固定 Retrieval Case 全部可由程序运行，困难 Case 的 expected Memory 必须进入 Top 5；
2. frozen/excluded Memory 永不进入 search 结果，且不能被 open；
3. 同一 Catalog、请求与配置产生逐字节一致的 Request、Candidate Universe、排序和 Disclosure；
4. `mnemosyne_search` 只披露标题、摘要、组件、操作、标签、alias 和结构化分数，不披露完整 body；
5. `mnemosyne_open` 只能对 search 返回的 active Memory 执行显式 L3 读取，并产生新的 Disclosure Envelope；
6. 已记录 Disclosure Envelope 可直接严格解码并重放相同内容，不再次调用分词、BM25、Librarian 或模型；
7. Tool 经真实 `ctx.tools` 注册表调用，插件 dispose/HMR 后零残留；
8. 本阶段不声明任务质量提升，也不产生 M0.5 GO/ADJUST/STOP 裁决。

#### 19.12.2 范围与真实边界

本阶段允许：

- 把 M0.5A 的 `memory-catalog.json` 作为只读构建输入嵌入插件；
- 在插件实例内构建确定性内存索引；
- 增加内部检索/披露协议和两个公开 Tool：`mnemosyne_search`、`mnemosyne_open`；
- 增加只用于测试的显式 Acquisition Registry seam，验证 Candidate 的 exact-event / exact-content 幂等与 `duplicate_candidate` 不自动跳过；
- 通过 dsh 标准 Tool result 路径返回 Disclosure Envelope，并在测试中验证离线 replay。

本阶段禁止：

- 监听或伪造不存在的 durable task-completion 事件；M0 审计只证明公开 `session/event`，未证明独立任务完成事件；
- 写入用户 Session、Workspace、Profile 或正式记忆目录；
- 创建生产 Fact Store、SQLite/FTS、向量数据库、Embedding、后台任务或文件锁；
- 调用 Librarian、真实模型、私有 dsh API 或自动注入；
- 把内存 Registry、Tool result 或 Fixture 当作生产长期记忆已完成的证据。

Tool-only 重放边界固定为：标准 Tool result 中携带完整、带 Hash 的 Disclosure Envelope；重放读取已记录 Envelope，不重新执行检索。M0.5B 只验证协议级和真实 Tool 注册表路径；M0.5C 验证公开 `additionalContexts` 消息形态，dsh Desktop/Session 的跨进程持久重放留给 M0.5D 真实联调，未验证前不得宣称完成。

#### 19.12.3 模块与文件计划

```text
src/
├── protocol/
│   └── retrieval.ts
├── retrieval/
│   ├── normalize.ts
│   ├── index.ts
│   ├── rank.ts
│   └── runtime.ts
├── search-tool.ts
└── open-tool.ts
tests/
├── retrieval-protocol.spec.ts
├── retrieval-rank.spec.ts
├── retrieval-fixture.spec.ts
├── disclosure-replay.spec.ts
└── retrieval-tools.spec.ts
```

只创建解决本阶段所需的最小文件；若两个模块不足 50 行且没有独立不变量，应合并，禁止为了目录图机械拆层。

#### 19.12.4 Retrieval Request 与 Candidate Universe

Retrieval Request v1：

```yaml
schema_version: 1
retrieval_id: retrieval_<stable-id>
query_fingerprint: sha256_<hex>
component_hint: controlled-id | null
operation_hint: controlled-id | null
top_k: 1..5
catalog_sha256: sha256_<hex>
content_sha256: sha256_<hex>
```

原始 query 不进入永久 Envelope；`retrieval_id` 由 query 规范表示、hint、top_k 与 Catalog Hash 的稳定摘要生成，不使用随机数或墙钟。查询入口必须拒绝空文本、超长文本、绝对路径、凭据、私钥、完整命令与控制字符。

Candidate Universe v1 对每条 active Memory 固定记录：`memory_id`、结构化字段命中、alias 命中、词项统计、BM25 分数的定点整数表示、最终总分与排序位置。它必须包含本轮全部 active 候选，而不只包含 Top K；frozen/excluded 不进入候选世界。Candidate Universe 只保存受控词项 ID/计数/分数，不保存原始 query、body 或模型解释。

所有分数禁止直接以平台浮点字符串作为规范事实。v1 使用整数定点分：先把各部分分数乘 `1_000_000`，以明确定义的四舍五入规则转为安全整数，再按 `score_fixed desc → memory_id Unicode code point asc` 排序。排序稳定 tie-break 不使用 `localeCompare`。

#### 19.12.5 确定性检索算法 v1

检索管线固定为：

1. query 执行 Unicode NFKC、Unicode lowercase 与空白折叠；规范化只用于检索，不修改 M0.5A Canonical JSON；
2. 英文/数字按 Unicode letter/number 连续片段分词；CJK 连续片段生成单字、2-gram 与 3-gram；长度和总词项数有硬上限；
3. Memory 的 title、summary、component、operation、tags、aliases、body 分字段建立内存倒排；body 只参与检索，不进入 search 披露；
4. alias 完整短语命中、component/operation hint 精确命中给予冻结权重；hint 是 boost，不是 hard filter，避免跨组件召回被截断；
5. 文本相关性使用简化 BM25，v1 冻结 `k1=1.2`、`b=0.75`；字段权重冻结为 title=4、summary=3、component=4、operation=4、tags=2、aliases=5、body=1，完整 alias 短语额外加 6 分，component/operation hint 各额外加 3 分；总分乘 `1_000_000` 后用 `floor(x + 0.5)` 转为安全整数，全部常量由 golden 测试锁定；
6. 不做模型查询改写；v1 查询扩展只允许由 Catalog alias 与受控 component/operation 词表确定性生成；
7. 空候选合法返回，不能为了满足 Fixture 强行补 active Memory。

Fixture 验收按 M0.5A Case 直接执行，不为单个 Case 写特殊分支或 memory_id 白名单。若某 Case 未过，允许调整统一算法/冻结权重并记录差异；禁止在测试中伪造结果。

#### 19.12.6 渐进式披露协议

Search Disclosure v1（L0/L1/L2）固定包含：

- `disclosure_id`、`retrieval_ref`、`candidate_universe_sha256`、`level: 2`、`result_count`；
- 每项的 `memory_id`、`title`、`summary`、`component`、`operation`、`tags`、`aliases`、`score_fixed`、`rank`；
- `content_sha256`。

Open Disclosure v1（L3）固定包含：

- `disclosure_id`、`retrieval_ref`、`parent_disclosure_sha256`、`level: 3`；
- 一个 active Memory 的全部 Fixture 内容与 `memory_content_sha256`；
- `content_sha256`。

`mnemosyne_open` 输入必须同时携带 `memory_id`、Search Disclosure Hash 和 Retrieval ID；Runtime 必须在当前实例的已验证 Disclosure Registry 中确认该 Memory 确实由对应 search 返回。仅知道 active `memory_id` 不能绕过渐进式披露直接 open。Registry 是评测期内存状态，dispose 后清空，不是生产事实源。

Envelope 严格拒绝未知字段、错误 Hash、重复 Memory、rank 断裂、非降序 score、父 Disclosure 错配和 frozen/excluded 内容。`replayDisclosure(bytes)` 只做严格解码、Hash 和引用自洽校验并返回原内容，不访问 Catalog 或索引；同一字节重复 replay 必须一致。

#### 19.12.7 Acquisition Registry seam

为了验证纵向链路中的“录制”语义，但不伪造 dsh 任务完成能力，本阶段只提供内部、测试可见的显式 Registry：

- 输入必须先通过 M0.5A `validateCandidate` 与 `validateSkipDecision`；
- `skip_exact_event` / `skip_exact_content` 返回稳定 `skipped`，Registry 零变化；
- `eligible` 新增 Candidate；同 candidate_id + 同 Hash 返回 `noop`，同 identity + 异 Hash fail closed；
- `duplicate_candidate` 记录 overlap 关系但仍新增 Candidate；
- Registry 只保存在插件实例内，dispose 清空；不会自动转成 active Memory，不进入固定 Catalog 检索，也不写文件；
- Acquisition 失败不得影响已有 search/open Tool，也不得修改固定 Fixture。

该 seam 只证明 Schema、幂等和失败隔离，真正的 Episode/Memory 提取与持久化仍属于 M2/M3。

#### 19.12.8 Tool 契约与生命周期

`mnemosyne_search` 参数固定为：`query`、可选 `component_hint`、可选 `operation_hint`、可选 `top_k`（默认 5）。输出为 Search Disclosure Envelope；描述必须明确“返回合成评测记忆，不是用户长期记忆”。

`mnemosyne_open` 参数固定为：`retrieval_id`、`search_disclosure_sha256`、`memory_id`。输出为 Open Disclosure Envelope。两个 Tool 的 parameter/output schema 都必须关闭未知字段，错误返回稳定、脱敏的插件错误，不回显 query、路径、凭据或 Memory body。

插件 `enabled=false` 时三个 Tool（status/search/open）均不注册；启用时恰好各一份；dispose/HMR 后全部撤销，Disclosure/Acquisition Registry 清空。M0 的公开 Status 契约不得被静默改写；若要表示 M0.5B 能力，新增向后兼容字段需要先修改 M0 Status 协议和测试，本阶段默认不改。

#### 19.12.9 失败测试先行矩阵

实现前必须让下列测试在缺少产品代码时失败，完成后转绿：

1. Query 空值、超长、控制字符、路径、凭据、完整命令与未知字段拒绝；
2. Unicode NFKC/lowercase、英文词元、CJK 1/2/3-gram 与 alias 扩展 golden；
3. 同输入 Request、Candidate Universe、排序和 Disclosure 字节/Hash 一致；
4. 15 条 Retrieval Case，困难 Case expected 进入 Top 5，negative control 不伪造命中；
5. frozen/excluded search leakage 为 0，直接 open/伪造父 Disclosure/未知 Memory 均拒绝；
6. search 只到 L2 且不含 body，open 才含 L3 body；
7. rank 连续、分数非升序、tie-break 稳定，篡改分数/rank/hash 后 replay 拒绝；
8. replay 不调用 tokenizer/ranker/Catalog，原字节得到同一语义输出；
9. exact-event/exact-content skip、eligible/noop/conflict、duplicate-candidate 不跳过；
10. 真实 `ctx.tools` 执行 search→open，Tool output schema 闭合；
11. enabled=false、dispose、HMR、多实例隔离和 Registry 清理；
12. build/tarball/Profile smoke 中 search/open 可执行且移除插件后不存在。

#### 19.12.10 自动门禁与交付边界

M0.5B 必须运行：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check
```

若供应链时间窗仍阻断安装，沿用 19.11.9 的诚实降级规则，不放宽 pnpm 策略。另需在隔离临时 Profile 经真实 Tool registry 执行 `mnemosyne_search → mnemosyne_open`，校验 L2/L3 和 dispose/remove。

完成报告必须给出：实际模块、冻结算法常量、15 Case 结果、泄漏数、Disclosure Hash/replay 证据、真实 Tool smoke、包内容、门禁和环境限制。不得调用真实模型、创建生产持久化、启用自动注入、输出任务质量提升结论或进入 M0.5C。

#### 19.12.11 Luna 实现任务书

```text
在 /Users/czy/Desktop/demo/dsh-Mnemosyne 实现 M0.5B。

唯一设计依据：docs/DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md 第 19.12 节。
先完整读取 19.11 已冻结协议与 19.12；检查 git status，保留已有提交。

按 TDD 执行：先添加 19.12.9 的失败测试并证明失败，再实现最小产品代码。优先合并小模块，不机械照目录图制造抽象。只用 dsh 现有公开 Tool/Context/Bundle 能力，不调用私有 API，不修改 dsh，不监听未审计的任务完成事件。

必须：
- 从固定 Fixture 构建确定性索引；
- 实现统一算法而非按 Case 特判；
- search 只披露 L2，open 必须验证父 search 后才披露 L3；
- frozen/excluded 全链路隔离；
- Disclosure 严格 Hash 与离线 replay；
- Acquisition Registry 只做内存 seam；
- Tool 经真实 ctx.tools 执行并覆盖 dispose/HMR/Profile smoke；
- 不调用模型、不自动注入、不写用户文件。

全部门禁完成后做一次 review 与 security review；修复范围内真实问题。最终只交付报告，不提交、不推送、不创建 Tag，等待 Sol 验收。
```

#### 19.12.12 M0.5B 验收记录

状态：✅ M0.5B 已完成并通过 Sol 独立验收；未进入 M0.5C，未调用模型、未自动注入、未写入用户文件或生产记忆。

- 实际模块：`src/protocol/retrieval.ts`、`src/retrieval/{normalize,index,rank,runtime,fixture}.ts`、`src/search-tool.ts`、`src/open-tool.ts`；`observer.ts` 注册三 Tool 并在 Fiber dispose 时清理实例 Registry。
- 检索常量：BM25 `k1=1.2`、`b=0.75`；字段权重 `title=4`、`summary=3`、`component=4`、`operation=4`、`tags=2`、`aliases=5`、`body=1`；alias 短语 `+6`，hint 各 `+3`；分数按 `floor(score*1_000_000+0.5)`，再按 Unicode code point 的 Memory ID 排序。
- Fixture：15 条 Retrieval Case（含 4 alias、4 cross-component、4 rephrase、1 exact、2 negative control），15/15 通过；5 条 active Memory 全部可召回，frozen/excluded 泄漏为 0。
- Disclosure：Search 为 L2 且不含 body；Open 必须绑定当前实例已登记的 Search Disclosure、Retrieval ID 和 Memory ID；tampered rank/hash、伪造 parent、frozen/excluded 和 malformed JSON 均拒绝。清理 Registry 后，已记录 Envelope 仍可脱离 Catalog/index 严格 replay，Canonical Bytes 保持一致。
- Acquisition Registry seam：exact skip、eligible/create、同 Hash noop、同事件异候选 fail-closed 且零变化、`duplicate_candidate` 仍创建、实例清理均有测试；不连接 durable task 事件、不持久化。
- 测试：17 个测试文件、53 个测试全部通过；覆盖真实 `ctx.tools` search→open、非法参数 fail-closed、enabled=false、多实例隔离和 dispose，以及冻结 Retrieval Case、Unicode 规范化、严格输入、审计 seam 和 Registry 可变对象隔离。
- 构建/包：TypeScript typecheck、tsdown build、`npm pack --ignore-scripts`、`node tests/pack-check.mjs`、`git diff --check` 通过；隔离 Profile 通过真实 Tool registry 执行 status/search/open 并验证 dispose 后无残留。
- 环境限制：`corepack pnpm install --frozen-lockfile` 仍受 pnpm 11 `minimumReleaseAge` 供应链时间窗阻断，未放宽策略；其余验证使用此前锁定的本地依赖执行，不能将冻结安装标记为通过。
- Sol 独立验收：重新运行 TypeScript typecheck、17 文件/53 测试、tsdown build、pack 白名单和 `git diff --check`；另从最新 tarball 创建隔离临时 Profile，经真实 `ctx.tools` 执行 `mnemosyne_status → mnemosyne_search → mnemosyne_open`，并验证 Fiber dispose 后三个 Tool 均撤销。

### 19.13 M0.5C：三组执行骨架与公开上下文链路验证

状态：✅ 已完成并通过 Sol 独立验收；禁止把本阶段结果解释为真实模型质量证据，禁止据此提前形成 M0.5 GO 结论。

#### 19.13.1 阶段目标与拆分决议

M0.5C 只回答两个工程问题：

1. 同一批冻结 Paired Task 能否由一个严格隔离的执行器按 `no_memory`、`tool_only`、`auto_inject` 三组完整跑通；
2. 自动披露内容能否只使用 dsh 已公开的 Tool 上下文通道，作为带明确来源的 `UserMessage` 进入可持久化消息链，而不是伪装成用户原话或调用私有接口。

M0.5C 使用确定性的 `scripted_fixture` Fake Adapter。它用于验证协议、Tool 调度、Disclosure、上下文封装、断言计算和报告聚合，不代表真实模型，也不能形成任务质量结论。真实 provider/model、5 次重复的统计结果、Token/延迟成本和 GO/ADJUST/STOP 裁决全部留给 M0.5D。

因此阶段结论固定分层：

```text
M0.5C PASS
  = 三组执行与公开上下文链路正确
  ≠ 记忆提高真实 Agent 能力
  ≠ M0.5 GO

M0.5D 才允许
  = 生成冻结 RunResult / SummaryReport
  = 对真实模型结果应用预注册 Gate
```

不得为了提前得到 GO，把 Fake Adapter 的结果填入 M0.5A `RunResult`。该 Schema 的 `model_provider` / `model_id` 必须描述真正执行任务的模型，脚本化适配器冒充 `deepseek-official/deepseek-v4-flash` 属于伪造证据。

#### 19.13.2 dsh 公开能力证据与使用边界

本阶段只依赖已安装并在 M0 锁定的公开 rc.6 契约：

- `@deepseek-ai/dsh-tools` 的 `ToolRunContext.deferContext(UserMessage)`：把插件生成的上下文附加到当前 Tool 最终结果，形成 `additionalContexts`，由 Agent Loop 在 `tool/result` 后按 FIFO 处理；
- `@deepseek-ai/dsh-session` 的 `tool/result` 与 `user/message`：二者属于 durable Session Event；`UserMessage.source` 是区分用户输入和合成注入的权威字段；
- `@deepseek-ai/dsh-llm/message` 的 `createUserMessage`：创建带稳定消息身份、深冻结内容和类型化来源的消息值；
- `MessageSource` 内建 `plugin` 来源与 `form: recall`：表达“由 dsh-Mnemosyne 生成的记忆召回材料”，不新增私有来源类型；
- `agent.inject()` 是公开但非唤醒的 next-step 队列能力；M0.5C 不直接使用它，以避免在尚未引入真实 Agent Loop 时伪造持久执行结果。

M0.5C 必须通过真实 `ToolRuntime` 观察 `additionalContexts`，但当前项目未声明 `dsh-agent-loop` 依赖，因此本阶段不宣称完成跨进程 Session reload。M0.5D 在隔离 Profile 中使用完整公开 Agent Loop 后，才验证 `tool/result → user/message → replay` 的 durable 顺序。

#### 19.13.3 三组执行流

```text
固定 FixtureSet + PairedTask + requested_seed
  → 创建隔离 Cordis Context / ToolRuntime
  → 按组安装能力
      no_memory: 不安装 Mnemosyne 插件，不存在 search/open
      tool_only: 安装插件，Fake Adapter 显式调用 search → open
      auto_inject: 安装插件，评测编排器调用 search → open
                   → evaluation-only recall context Tool
                   → exec.deferContext(plugin/recall UserMessage)
  → Scripted Adapter 只读取该组真实可见输入
  → 独立 Assertion Evaluator 计算 success_assertions
  → PlumbingRunReceipt
  → PlumbingSummary
```

隔离规则：

- 每个 run 使用全新 Context、ToolRuntime 和插件实例，不跨 run 复用 Retrieval Registry；
- run 结束必须 dispose，三个生产 Tool 和评测期 Tool 均零残留；
- `no_memory` 不得实例化、导入或间接读取固定 Memory Catalog；
- `tool_only` 的 Fake Adapter 只能经真实 `ctx.tools.execute` 获得 Search/Open Disclosure；
- `auto_inject` 的 Fake Adapter 只能收到 `additionalContexts` 中的 UserMessage，不能同时获得 Runtime、Search/Open 返回值或任务的 expected Memory；
- Assertion Evaluator 可以读取任务的 `success_assertions`，但 Adapter 不得读取 `required_memory_ids`、`forbidden_memory_ids` 或 expected 值。

#### 19.13.4 统一检索与披露策略

两种记忆组使用完全相同的冻结策略，避免通过组间不同检索配置制造结果差异：

- query = Paired Task 的原始 `prompt`；
- `component_hint = null`；
- `operation_hint = null`；
- `top_k = 5`；
- 按 Search Disclosure 排名依次尝试 open，最多打开前 2 条；
- 只接受 `score_fixed > 0` 的 Search Item；
- 任一 search/open 协议错误使该 run 以稳定 `retrieval_protocol_error` 失败，不回退到直接 Catalog 读取；
- frozen/excluded 泄漏立即使整个 M0.5C 失败，不降级为单次普通失败。

若固定任务中所需的两条 Memory 不能同时进入统一策略的前 2 名，只能调整统一策略并在本节记录新常量；禁止按 `task_id`、`required_memory_ids` 或 Memory 白名单分支。

#### 19.13.5 Recall Context Envelope v1

自动披露消息的模型可见文本固定为：

```text
[Mnemosyne Recall v1 — plugin generated; not user authored]
<RecallContextEnvelope 的 Canonical JSON>
```

`RecallContextEnvelope`：

```yaml
schema_version: 1
context_id: context_<stable-id>
source: plugin_memory
not_user_authored: true
retrieval_id: retrieval_<id>
search_disclosure: <完整且已验证的 SearchDisclosure v1>
open_disclosures:
  - <完整且已验证的 OpenDisclosure v1>
memory_ids: [memory_<id>]
content_sha256: sha256_<hex>
```

硬约束：

- `context_id` 由 Identity Payload `{source, not_user_authored, retrieval_id, search_disclosure, open_disclosures, memory_ids}` 的 Canonical Hash 前缀稳定生成；`content_sha256` 再对已含 `context_id`、仅排除 `content_sha256` 的完整对象计算，二者都不使用墙钟或随机数，禁止循环依赖；
- `source` 与 `not_user_authored` 固定值，不提供调用方自定义入口；
- Search Disclosure 必须通过 M0.5B validator；
- 每个 Open Disclosure 必须通过 M0.5B validator，且 `retrieval_ref`、`parent_disclosure_sha256` 和 `memory_id` 精确指向该 Search Disclosure；
- `memory_ids` 必须等于 Open Disclosure 的唯一、稳定排序 ID 集合；
- 只允许 1..2 个 Open Disclosure；不得生成空自动上下文；
- Envelope 严格拒绝未知字段、错误 Hash、重复 Memory、错误父引用、非 active 内容、敏感字段名、控制字符和超限 body；
- `replayRecallContext(bytes)` 只能对已记录字节执行严格解码与引用校验，不调用 Runtime、Catalog、Tokenizer、Ranker 或模型。

对应 `UserMessage` 必须由 `createUserMessage` 创建：

```yaml
role: user
source:
  kind: plugin
  plugin: dsh-mnemosyne
  form: recall
content:
  - type: text
    text: <固定前缀 + Canonical Envelope>
```

禁止使用 `source.kind=user`，禁止把前缀省略，禁止在 source 或正文中声称内容由用户提供。消息 ID 由 dsh 创建，不参与 Envelope 的确定性 Hash；重放权威是 Session 中已落盘的完整 UserMessage，离线协议重放权威是 Envelope Canonical Bytes。

#### 19.13.6 Evaluation-only Recall Tool

新增内部 `createRecallContextTool()`，只供 M0.5C 测试/评测运行器使用，不在插件 `apply()` 中注册、不从包根导出、不加入生产 Config。

输入：

```yaml
search_disclosure_json: string
open_disclosure_jsons: [string] # 1..2
```

执行顺序：

1. 分别调用 `replayDisclosure` 严格验证输入；
2. 构造并验证 Recall Context Envelope；
3. 构造并严格验证不含 Memory body 的 `RecallContextReceipt`；
4. 创建 `plugin + recall` UserMessage；
5. 以最后一个有意副作用调用当前 `ToolRunContext.deferContext(message)`，随后直接返回已验证 Receipt。

Receipt 固定包含：`schema_version`、`context_id`、`retrieval_id`、`memory_ids`、`context_content_sha256`、`content_sha256`。Receipt 只证明某条上下文已附加到该 Tool 结果，不是 Memory Fact，不进入生产 Catalog。

Tool 的参数/output schema 必须关闭未知字段。失败错误固定、脱敏，不回显 Disclosure JSON、Memory body、路径、凭据或消息内容。所有可预见的输入、引用、Envelope 与 Receipt 校验必须发生在 `deferContext` 之前，因此这些失败路径的 `additionalContexts` 必须为空。dsh 的公开契约规定已 defer 的上下文在随后取消或抛错时仍会保留；本阶段不伪造相反语义，而是通过“先完成全部可失败校验、最后 defer、立即返回”把插件自身的后置失败面降为零。

#### 19.13.7 Scripted Fixture Adapter

`ScriptedFixtureAdapter` 只验证信息是否通过正确通道到达：

- 输入仅为 `task.prompt`、requested seed 和该组真实可见的 Tool/Recall 内容；
- 不读取 Paired Task 的 `required_memory_ids`、`forbidden_memory_ids`、`success_assertions.expected`；
- 不直接读取 Fixture Catalog；
- Tool-only 组由 Adapter 通过 ToolInvoker 显式调用 search/open；
- Auto-inject 组只解析已验证的 Recall Context UserMessage；
- No-memory 组没有 ToolInvoker 或 Recall Context；
- 输出为一个有限 JSON Object，字段只能由可见文本中的受控行动语句确定性派生；不调用模型、不执行 shell、不访问网络或文件；
- requested seed 被记录但 `seed_honored=false`，因为脚本适配器没有随机采样。

该 Adapter 可以让含必要结构化记忆的合成任务通过、让缺少材料的任务失败，以验证断言链路；这些成功率不得进入 `tool_only_success_delta_points` 或任何真实模型指标。

#### 19.13.8 Plumbing Run Receipt 与 Summary

M0.5C 新建独立协议，不能复用/伪装 M0.5A `RunResult`。

`PlumbingRunReceipt v1`：

```yaml
schema_version: 1
run_id: plumbing_<stable-id>
evaluation_id: m05_v1
fixture_manifest_sha256: sha256_<hex>
task_id: task_<id>
group: no_memory | tool_only | auto_inject
requested_seed: integer
seed_honored: false
adapter_kind: scripted_fixture
tool_calls: [mnemosyne_search | mnemosyne_open | mnemosyne_eval_recall_context]
context_source: none | plugin_recall
recall_context_sha256: sha256_<hex> | null
recall_replay_verified: boolean
retrieved_memory_ids: [memory_<id>]
opened_memory_ids: [memory_<id>]
visible_memory_ids: [memory_<id>]
assertion_results:
  - assertion_id: assert_<id>
    passed: boolean
success: boolean
failure_code: controlled-id | null
disposal_clean: boolean
content_sha256: sha256_<hex>
```

`run_id` 由 `{evaluation_id, fixture_manifest_sha256, task_id, group, requested_seed, adapter_kind}` 的 Canonical Hash 前缀稳定生成；`content_sha256` 对含 `run_id`、仅排除自身 Hash 的完整 Receipt 计算。同一 run identity 的不同内容必须 fail closed，不能覆盖或任选其一。

`PlumbingSummary v1` 固定记录：`schema_version`、稳定 `summary_id`、Fixture Manifest Hash、三组各 30 个 receipt、90 个唯一 receipt Hash、group isolation、Tool ordering、Recall source、replay consistency、excluded leakage、disposal cleanliness、scripted outcomes 七个布尔不变量、`status: pass|fail` 与 `content_sha256`。Summary ID 与 Hash 使用同样的先 Identity、后完整内容两阶段规则。它不得包含 `recommendation`，不得输出 GO/ADJUST/STOP，也不得生成 M0.5A SummaryReport。

所有集合字段稳定排序并拒绝重复；Tool call 顺序保留执行顺序。相同固定输入、固定 Adapter 与固定执行策略必须产生逐字节一致的 Receipt/Summary。协议中不记录墙钟、真实延迟或 Token；这些只由 M0.5D 的真实运行记录。

#### 19.13.9 失败矩阵

| 场景 | 结果 | 禁止行为 |
|---|---|---|
| no_memory 出现 search/open Tool | 整体 fail | 静默忽略 |
| Tool-only 未经 search 直接 open | run fail | 直接读 Catalog |
| Auto-inject Adapter 收到 Runtime/Tool value | 测试 fail | 双通道喂入 |
| Recall UserMessage source 非 plugin/recall | 整体 fail | 当作用户消息 |
| Recall 前缀缺失或变更 | fail closed | 猜测内容类型 |
| Disclosure/Envelope/Receipt Hash 漂移 | fail closed | 自动修复 |
| frozen/excluded 出现在任一可见集合 | 整体 fail | 只计一次普通错误 |
| Evaluation-only Tool 在 defer 前校验失败 | 无 additionalContexts | 提前 defer 半成品 |
| 同 run identity 异内容 | identity conflict | 覆盖既有 receipt |
| Context/Tool dispose 后残留 | 整体 fail | 继续下一 run |
| Fake Adapter 缺少信息 | assertion fail | 读取 expected 字段补答案 |

#### 19.13.10 TDD 与测试矩阵

实现前必须先写失败测试并确认缺少产品代码时失败：

1. Recall Envelope strict schema、stable ID、Hash、父子 Disclosure、1..2 上限；
2. Recall message 固定前缀、`plugin + recall` source、`not_user_authored=true`；
3. `replayRecallContext` 不访问 Runtime/Catalog 且字节稳定；
4. 真实 ToolRuntime 执行 evaluation-only Tool，成功恰好产生一个 additionalContext，所有 defer 前校验失败产生零个；
5. no_memory 的 registry 中不存在 Mnemosyne Tool；
6. tool_only 必须真实执行 search→open，Auto 组 Adapter 看不到 Tool value；
7. 两个记忆组检索配置与 top/open 策略逐字段相同；
8. 6 Task × 3 Group × 5 Seed = 90 个唯一 Receipt；
9. 同输入重复运行 Receipt/Summary Canonical Bytes 相同；
10. Adapter 访问 expected/required/forbidden 字段的接口在类型和运行时均不存在；
11. 断言 evaluator 覆盖 `exit_code` 与 `result_equals`，未知字段/类型拒绝；
12. frozen/excluded leakage=0，Recall/Tool-only 可见集合闭合；
13. 三组 Context、Registry、Tool、Disclosure 完全隔离，dispose 后零残留；
14. 恶意 Disclosure JSON、路径、凭据、控制字符和超大 payload 返回静态脱敏错误；
15. PlumbingSummary 不含真实模型指标、recommendation 或 GO/ADJUST/STOP。

#### 19.13.11 自动门禁与验收

M0.5C 必须运行：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check
```

冻结安装若仍受 pnpm `minimumReleaseAge` 阻断，必须记录原命令和错误，不能降低供应链策略。其余门禁使用已锁定本地依赖执行。

验收要求：

- 90 个 Plumbing Receipt 与 1 个 Summary 严格通过；
- 七个 Plumbing 不变量全部为 true；
- 真实 ToolRuntime 的 `additionalContexts` 行为经测试证明；
- 生产插件仍只注册 status/search/open，evaluation-only Tool 不进入 tarball 公共行为；
- 包内容仍为白名单 5 文件，生产 Config 和包根导出不扩张；
- 无 API Key、无真实模型、无网络、无用户文件读写；
- 独立 review/security review 无阻塞问题。

完成后只能把 M0.5C 标为“执行骨架和公开上下文链路通过”。M0.5 总体状态仍为 `insufficient_evidence`，下一步才是 M0.5D 的真实模型设计与用户环境联调。

#### 19.13.12 Luna 实现任务书

```text
在 /Users/czy/Desktop/demo/dsh-Mnemosyne 实现 M0.5C。

唯一设计依据：docs/DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md 第 19.13 节。先完整读取 19.11～19.13，检查 git status，保留提交 48b9f96 及之前历史。

严格按 TDD：先写 19.13.10 的失败测试并记录预期失败，再实现最小代码。实现工作由 Luna 完成；不要调用 dsh Agent 执行任务。

关键边界：
- Fake Adapter 只证明执行管线，绝不伪装真实模型；
- 不生成 M0.5A RunResult/SummaryReport，不给 GO/ADJUST/STOP；
- 只用公开 ToolRunContext.deferContext、createUserMessage、plugin/recall source；
- evaluation-only Recall Tool 不注册到生产插件、不从包根导出；
- no_memory/tool_only/auto_inject 每 run 全隔离；
- Adapter 不得读取 required_memory_ids、forbidden_memory_ids 或 success_assertions.expected；
- 不访问网络、API Key、用户 Session/Workspace、文件系统或私有 dsh API；
- 不修改 dsh 上游，不增加 dsh-agent-loop 依赖。

全部门禁完成后做 review 与 security review，只修复本节真实问题。最终报告实际模块、90-run 结果、七项不变量、additionalContexts 证据、包内容、环境限制；不提交、不推送、不创建 Tag，等待 Sol 验收。
```

#### 19.13.13 Luna 实现与 Sol 验收报告

状态：✅ 实现完成并通过 Sol 独立验收；本节只证明 M0.5C 的执行骨架和公开上下文链路，不代表 M0.5 已获得真实模型证据。

- 实际模块：`src/protocol/recall.ts`、`src/recall-tool.ts`、`src/m05c/plumbing.ts`；测试：`tests/m05c-protocol.spec.ts`、`tests/m05c-plumbing.spec.ts`。
- `RecallContextEnvelope`、`RecallContextReceipt` 支持严格字段、父子 Disclosure 引用、稳定 ID、Canonical Bytes、Hash 与 canonical replay；Replay 不访问 Runtime、Catalog、Tokenizer、Ranker 或模型。
- `validateRecallExecution` 要求真实 `ToolExecutionResult` 恰好一条 additional context，并闭合检查 source、前缀、Envelope canonical replay、Receipt identity/hash 和 memory IDs；zero、duplicate、wrong source/prefix/hash 均 fail closed。
- evaluation-only Tool 名为 `mnemosyne_eval_recall_context`，未在生产 `apply()` 注册、未从包根导出；输入先完成所有 JSON/Disclosure/Envelope/Receipt 校验，最后才调用 `deferContext`。消息使用固定前缀和 `plugin + recall` source；真实 `ctx.tools` 观察到成功恰好一个 `additionalContexts`，校验失败为零。
- Scripted Fixture Adapter 只读取对应组真实可见材料，不读取 `required_memory_ids`、`forbidden_memory_ids` 或 `success_assertions.expected`；no-memory 组不加载 Memory Catalog，tool-only 通过真实 `ctx.tools` search→open，auto-inject 只通过 Recall UserMessage。
- Adapter 接收 `{prompt, visible}`，prompt 仅作任务输入/审计，所有断言字段只从 `visible` 派生；注入事实与任务 success 独立，注入后任务失败仍保留完整 plugin/recall/replay 证据，注入前失败只允许合法 Tool 前缀。
- 6 Task × 3 Group × 5 Seed 产生 90 个唯一 `PlumbingRunReceipt`，并聚合为独立 `PlumbingSummary`；Summary 不含 M0.5A `RunResult/SummaryReport`、真实模型指标或 recommendation。
- 七个 Plumbing 不变量均由程序从 Receipt/Fixture 派生：`group_isolation=true`、`tool_ordering=true`、`recall_source=true`、`replay_consistency=true`、`excluded_leakage=true`、`disposal_cleanliness=true`、`scripted_outcomes=true`。
- 本地 Vitest 门禁为 19 个测试文件、67 个测试全通过；其中 Plumbing 运行实际生成 90 个唯一 Receipt，重复 Summary 的 Canonical Bytes 稳定一致。
- 本轮回归覆盖 `validateRecallExecution` 的 zero/duplicate/wrong-source/wrong-prefix/receipt-mismatch、注入后任务失败与注入前失败前缀、prompt-only Adapter 隔离、Envelope parent/retrieval/memory/open-set 篡改、Summary 缺失/替换/重复 identity，以及两次独立 90-run 的字节稳定性。
- `tests/pack-check.mjs` 额外断言 evaluation-only recall Tool 名称不进入生产 tarball/dist。
- 本轮使用已锁定的本地依赖完成 typecheck、Vitest、tsdown、pack 白名单、`git diff --check`；`corepack pnpm install --frozen-lockfile` 仍被 pnpm `minimumReleaseAge` 阻断，未绕过策略、未伪报通过。无真实模型、API Key、网络、用户文件或 dsh-agent-loop 依赖。
- Sol 独立验收重新运行 TypeScript typecheck、19 文件/67 测试、tsdown build、tarball 白名单与 `git diff --check`，并直接扫描生产 `dist/`，未发现 evaluation-only Recall Tool、Plumbing Runner 或 Scripted Adapter；冻结安装仍仅受同一 `minimumReleaseAge` 时间窗阻断。

### 19.14 M0.5D：评测协议 v2 与真实 Agent Loop 执行器

> 状态：D0/D1 与 D2-A/B1/B2 已完成；D2-B3 已执行，3 个 task call claim 均失败、0 Receipt、连续错误触发熔断；实际计费状态未知，D3 未执行。

#### 19.14.1 阶段决议

M0.5D 不直接用 v1 Fixture 启动 90 次真实模型调用。Sol 对 v1 做 readiness audit 后确认两个协议缺口：

1. v1 的 6 个 Paired Task 全部依赖记忆，无法真实计算 `non_memory_regression_points`；
2. v1 只有 Acquisition Registry seam，没有执行最小 Acquisition Pipeline，若把 `acquisition_tokens` 固定为 0 会伪造成本门禁。

因此 v1 保持不可变，作为 M0.5A～C 的历史验证输入。M0.5D 新增 `fixtures/m0.5/v2/`，在不改变 v1 Canonical Bytes、Hash、测试和验收记录的前提下补齐上述证据。禁止原地升级或静默解释 v1。

M0.5D 分为四个顺序 Gate：

```text
D0：v2 Schema / Fixture 冻结
→ D1：公开 Agent Loop 离线执行器（Fake Provider）
→ D2：用户授权的真实 Provider Canary
→ D3：用户再次授权的完整配对评测
```

D0/D1 由 Luna 实现并由 Sol 验收，不使用 DSH Agent 作为编码执行者。D2/D3 会产生真实模型调用，必须在运行前得到用户明确批准；未批准时阶段停在“offline ready”，不能把离线结果写成模型质量证据。

#### 19.14.2 目标与非目标

目标：

- 冻结可完整计算十项 M0.5 指标的 v2 Fixture；
- 只使用 dsh `0.1.0-rc.6` 公开 Agent、Session、Tool、Provider 与 Token Usage 接口；
- 证明 no-memory、tool-only、auto-inject 三组能在真实 Agent Loop 中隔离执行；
- 对真实模型输出做严格结构化解析，并把模型声明与运行时观察分开；
- 使用最小 Acquisition Slice 真实记录 token、延迟、skip/novelty 与 critical-path blocking；
- 真实执行前提供预检、调用上限、超时、熔断和隐私边界。

非目标：

- 不改 dsh 上游，不读取私有实现，不给 dsh 提 PR；
- 不读、不复制用户现有 `~/.dsh/.credentials.yaml`、Session 或 Workspace；
- 不自动寻找、打印或持久化 API Key；
- 不把请求 seed 当作 Provider 已采纳，未确认支持时固定记录 `seed_honored=false`；
- 不保存完整 System Prompt、用户 Prompt、模型思考、Tool value 或模型原始回答；
- 不在 D0/D1 生成 GO/ADJUST/STOP，不运行真实 Provider；
- 不把 v2 evaluation-only Runner、Fake Provider 或 Recall Tool 打入生产插件。

#### 19.14.3 Fixture v2

v2 新目录至少包含：

```text
fixtures/m0.5/v2/
  protocol.json
  memory-catalog.json
  retrieval-cases.json
  paired-tasks.json
  acquisition-cases.json
  fixture-manifest.json
```

v2 复用 v1 的 6 个记忆依赖 Task、Memory Catalog 与 Retrieval Case，并新增 2 个不需要任何记忆即可完成的控制 Task。控制 Task 必须：

- `task_kind = non_memory_control`；记忆依赖 Task 为 `memory_dependent`；
- `required_memory_ids=[]`；
- 三组看到完全相同的业务输入与断言；
- 不通过隐藏 Fixture 字段向 Adapter 或模型泄露答案；
- 覆盖至少两个不同 task family；
- no-memory 基线在 Fake Provider 中可确定完成，真实模型结果只由同一严格 Assertion Evaluator 判定。

v2 的冻结矩阵为：

```text
8 Task × 3 Group × 5 Repetition = 120 RunResult
```

请求 seed 仍为 `101/202/303/404/505`，但仅作为重复运行标识。Provider Adapter 若没有公开 seed 能力，Receipt 必须明确 `seed_honored=false`，不得声称随机性受控。

`EvaluationProtocol v2` 规则：

- `schema_version=1`，联合验证器显式支持 `evaluation_id=m05_v1|m05_v2`；
- `fixture_version=2`；
- model 与阈值继续沿用 v1，防止观察结果后调门槛；
- 新增冻结的 `runner_limits`：`max_model_calls_per_task=4`、`max_acquisition_calls_per_run=1`、单调用与整批超时；
- v2 Manifest 新增 `acquisition-cases.json`，文件集合与 Hash 严格闭合；
- v1 的 validator、fixture count、Manifest 及 golden 全部保持可用。

#### 19.14.4 Minimal Acquisition Slice

`acquisition-cases.json` 固定一组短 Episode 摘要，至少覆盖：

- `novel_candidate`：应生成一个结构化 Acquisition Candidate；
- `duplicate_skip`：确定性预筛命中已知内容，跳过模型提取；
- `external_failure_skip`：第三方失败，不沉淀为策略记忆；
- `sensitive_reject`：含伪造凭据/路径的输入被脱敏或拒绝，原文不得进入结果。

Acquisition 分为两个层次：

1. 确定性 novelty/skip 预筛，输出受控 `decision` 与 `reason_code`；
2. 仅 `novel_candidate` 进入 Provider 的严格结构化提取请求。

每个真实 Run 的 Acquisition 独立执行，但不得阻塞业务 Task 的关键路径：Task 结束并记录结果后才可启动；`acquisition_critical_path_blocking` 由事件顺序计算，不能由调用者直接传值。记录：

- 提取调用的输入/输出 Token Usage；
- 提取持续时间；
- skip/novelty 决议；
- Candidate canonical hash；
- 是否发生在任务完成事件之后。

不保存 Episode 全文或提取原始回答。Fake Provider 必须覆盖全部四类 Acquisition Case，但它只证明协议与计量管线，不证明真实模型的提取质量。

Acquisition Case 与 repetition 的绑定由 Protocol 固定，不由 Runner 选择：seed `101/202/303/404/505` 依次绑定 `novel_candidate/duplicate_skip/external_failure_skip/sensitive_reject/duplicate_skip`。因此完整 v2 评测包含 120 次 Task Agent 调用，其中最多 24 次 Run 会额外发生 Acquisition Provider 调用；其余 96 次必须在确定性预筛阶段结束。Runner 不得通过改变映射减少成本或改善指标。

#### 19.14.5 公开 Agent Loop 边界

D1 Runner 使用已安装并锁定的公开包版本：

- `@deepseek-ai/dsh-agent-loop@0.1.0-rc.6` 的公开 Agent Registry / Agent API；
- `@deepseek-ai/dsh-llm@0.1.0-rc.6` 的流事件与 `TokenUsage`；
- `@deepseek-ai/dsh-session@0.1.0-rc.6` 的持久事件流；
- 现有公开 Tool Registry 与 `ToolRunContext.deferContext`。

每个 Run 创建全新的隔离 Context、Session、Agent、Tool Registry 与临时 Workspace，结束后 dispose。三组执行流：

```text
no_memory:
  仅注册任务 Fixture Tool；不加载 Catalog，不注册 search/open/recall

tool_only:
  注册任务 Fixture Tool + mnemosyne_search + mnemosyne_open；
  Agent 必须通过实际 Tool call 获取记忆

auto_inject:
  Runner 先执行与 tool_only 完全相同的确定性 search/open；
  构建并验证 Recall Context Envelope；
  通过公开 agent.inject(UserMessage) 注入，再用公开 send/followup 唤醒；
  Agent 不得获得 search/open Tool
```

auto-inject 的 durable Session 必须观测到 Recall UserMessage 位于任务执行前，且 source 精确为 `plugin/dsh-mnemosyne/recall`。重放时使用已落盘 Disclosure Fact/Recall Envelope，不再次调用 Librarian。Runner 不保存 Librarian 思考链。

#### 19.14.6 严格模型回执

模型最终回复只能是一个 JSON 对象，禁止 Markdown fence、前后解释和未知字段：

```json
{
  "schema_version": 1,
  "task_id": "task_...",
  "exit_code": 0,
  "result": {"controlled_field": "controlled scalar"},
  "adopted_memory_ids": ["memory_..."],
  "failure_code": null
}
```

约束：

- `result` 只允许当前 Task Assertion 声明的字段和 JSON scalar；
- `adopted_memory_ids` 只是模型声明，必须是运行时已打开或已披露集合的子集；
- no-memory 必须为空；
- success 只能由 Assertion Evaluator 从严格回执计算，模型不能自报 success；
- Tool call、检索、打开、披露集合来自 Session/Tool 事件，不能从模型文本推断；
- JSON 解析失败、字段越界、引用未观察 Memory、输出过大或控制字符均产生稳定脱敏 failure code。

`RunResult` 只记录现有协议字段与 canonical hash；完整模型回答不落盘。必要的调试信息只记录受控错误码和事件 Hash。

#### 19.14.7 Token、延迟与指标归因

模型 Token 只累计公开 LLM stream 的 `usage` 事件。`TokenUsage.inputTokens` 是未缓存输入，缓存读写单列；M0.5 指标中的总输入应按公开语义计算：

```text
billed_input = inputTokens + cacheReadTokens + cacheWriteTokens
```

`outputTokens` 单独记录；`reasoningTokens` 仅作非持久化诊断，不能重复加入 output。若 Provider 没有 usage 事件，该 Run fail closed，不能用字符数伪造真实 Token。

检索 Token 使用公开 Token Meter 对 search/open/Recall message 的可见消息估算；真实 Provider usage 与估算值必须分开命名。检索延迟从发起 Retrieval Request 到 Disclosure 完成的单调时钟差计算。Acquisition Token 只计 Acquisition Provider 调用。

十项 Summary 指标全部由 120 个已验证 RunResult、Acquisition Receipt 与固定 Fixture 派生：

- 非记忆回归只使用两个 `non_memory_control` Task，比较 memory 组与 no-memory；
- Tool-only success delta 只使用 `memory_dependent` Task；
- Acquisition critical-path blocking 使用事件顺序；
- 任一预期样本缺失、重复、损坏或组间模型/任务不一致，相关 Gate 为 `insufficient_evidence`，不能用 0 填充。

#### 19.14.8 D1 离线 Runner 与 Fake Provider

Fake Provider 必须实现公开 LLM Provider/stream 契约并经过真实 Agent Loop，不能绕过 Agent 直接调用 Adapter。它根据模型实际可见消息和 Tool 结果返回结构化回执；不可读取 Fixture 的 required/forbidden/expected 私有字段。

D1 必须证明：

1. 三组 Agent/Session/Registry 完全隔离；
2. tool-only 真实产生 search→open Tool 事件；
3. auto-inject 真实产生 durable Recall UserMessage 且不注册 search/open；
4. no-memory 不加载 Catalog；
5. usage 事件、模型回执、Task Assertion 与 RunResult 的闭合转换；
6. Minimal Acquisition 在任务结束后执行，skip 不调用 Provider；
7. 120 个离线 Run identity 唯一、重复执行 canonical bytes 一致；
8. 离线 Summary 明确标识 `evidence_kind=offline_fake_provider`，禁止输出真实 GO/ADJUST/STOP。

Fake Provider 模块与 Runner 只能由测试或显式 evaluation 子路径导入，不能从生产包根导出或进入 tarball。

#### 19.14.9 真实 Provider 安全门禁

真实联调只能使用隔离临时目录：

```text
DSH_HOME=<temporary directory>
workspace=<temporary synthetic workspace>
profile=<evaluation-only profile>
```

Credential 只能由用户在运行时显式提供 `DEEPSEEK_API_KEY`，或由用户手动写入该临时 `DSH_HOME`。Runner 不读取、不复制、不探测默认 DSH_HOME 的 credential 文件；日志、Receipt、错误和 Summary 禁止出现 Key。

D2 Canary 在用户第一次明确授权后执行 6 个 Task Agent Run：每组各一个 memory-dependent Task 与一个 non-memory control Task。每个 Run 最多 4 次模型调用；若 Canary 使用 `novel_candidate` seed，还会发生最多 6 次 Acquisition Provider 调用，因此 Provider 调用硬上限为 30。还需设置：

- 最大调用次数、单调用超时和整批 wall-clock 上限；
- 连续 2 次 Provider/协议错误即熔断；
- Provider/model 身份与公开 usage 事件预检；
- 任一隔离、Tool 顺序、Recall source、严格回执或脱敏失败立即停止；
- Canary 只给“real-provider plumbing pass/fail”，不产生 M0.5 recommendation。

D3 只有 Canary 通过且用户第二次明确批准后才运行 120 个完整 Task Agent Run。按 `max_model_calls_per_task=4` 与冻结 seed 映射，Provider 调用硬上限为 504（最多 480 次 Task Agent 模型调用 + 24 次 Acquisition）；实际调用次数、预计费用上限和超时必须在命令执行前打印并等待确认。达到上限即停止，保留合法前缀并输出 `insufficient_evidence`，不得自动续费或重试扩大预算。

#### 19.14.10 失败测试矩阵

至少先写以下失败测试：

1. v1 Fixture/Canonical Hash 全部不变；
2. v2 缺少两个 non-memory control、错误 task_kind、控制 Task 带 required memory 时拒绝；
3. v2 Manifest 缺 Acquisition 文件或任一 Hash 错配时拒绝；
4. Acquisition 四类 Case、partial/unknown/secret/path/oversize 输入拒绝；
5. skip Case 零 Provider 调用，novel Case 恰好一次且发生在 Task 完成后；
6. Fake Provider 不能访问断言 expected、required/forbidden memory IDs；
7. 模型回执 prose/fence/unknown field/错 task/非法 result/未观察 adopted memory 拒绝；
8. tool-only 无 search/open 或顺序错误拒绝；auto-inject 缺 Recall durable event、source 错误或同时暴露 Tool 拒绝；
9. no-memory 加载 Catalog 或产生 Memory 事件拒绝；
10. usage 缺失、负数、重复计数或把 reasoning 重复加入 output 时拒绝；
11. 120 Run 缺失/重复/跨组配置漂移时 Summary 为 insufficient 或拒绝；
12. 非记忆回归只由 control Task 派生，不能由 caller 注入；
13. Canary 超调用、超时、连续错误、凭据字符串进入错误时熔断；
14. evaluation-only 代码不进入生产 export、dist 或 tarball。

#### 19.14.11 自动门禁与成功标准

D0/D1 自动门禁：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check
```

冻结安装若仍受 `minimumReleaseAge` 阻断，原样记录，不得降低策略；已锁定依赖的其他门禁仍须通过。

D0/D1 完成标准：

- v1 golden 不变，v2 Fixture 与 Acquisition Schema 完整冻结；
- 120 个 Fake Provider Run 与全部派生不变量通过；
- 公开 Agent Loop、Session、Tool、Recall injection、usage 事件均有进程内证据；
- 生产插件公共命令仍只有 status/search/open，包白名单不变；
- 无网络、API Key、用户 DSH_HOME/Session/Workspace 写入；
- 独立 review 与 security review 无阻塞问题。

完成 D0/D1 后状态只能是 `offline ready, real evidence pending`。D2/D3 的成功标准必须由真实调用产生；未执行时保持 pending。

#### 19.14.12 Luna 实现任务书

```text
在 /Users/czy/Desktop/demo/dsh-Mnemosyne 实现 M0.5D 的 D0/D1。

唯一设计依据：docs/DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md 第 19.14 节。先完整读取 19.11～19.14，检查 git status，保留 v1 与提交 a899f4c 之前的全部历史。

实现者必须使用 Luna；不要调用 dsh Agent 编码。严格按 TDD，先写 19.14.10 的失败测试并记录失败，再实现最小代码。

核心边界：
- 新建 fixtures/m0.5/v2，绝不修改 v1 Canonical Bytes/Hash；
- v2 必须有 6 个 memory-dependent + 2 个 non-memory-control Task 与 Acquisition Case；
- Fake Provider 必须走公开 Agent Loop/Session/LLM stream，不可直接调用 Scripted Adapter；
- 只使用公开 rc.6 包；不得读取私有实现、用户 credential/Session/Workspace；
- 不进行网络或真实 Provider 调用，不要求 API Key；
- strict model receipt、observed memory closure、usage 计量、120-run completeness、acquisition-after-task 必须 fail closed；
- evaluation-only Runner/Fake Provider/Recall Tool 不从生产包根导出，不进入 dist/tarball；
- 不生成真实模型 GO/ADJUST/STOP，只报告 offline_fake_provider。

若公开 Agent Loop 在当前锁定依赖中无法从插件测试安全构造，停止并提供精确公开 API 缺口证据，不得回退私有 API 或伪造 Agent Loop。

完成全部门禁后做 review/security review，只修本节真实问题。最终报告 v1 golden、v2 Fixture、120-run 结果、Agent/Session/Tool/usage 证据、Acquisition 时序、包内容、环境限制；不提交、不推送、不创建 Tag，等待 Sol 验收。
```

#### 19.14.13 D0/D1 Sol 验收记录

状态：**已通过（offline ready, real evidence pending）**。

- v1 Fixture 未修改；v2 中的 Memory Catalog 与 Retrieval Case 是不可变 v1 子 Fixture，继续使用 v1 validator 的规范化 Canonical Identity，v2 Manifest 不重新定义其语义 Hash；
- v2 固定为 6 个记忆依赖 Task、2 个非记忆控制 Task、3 组、5 个 repetition，共 120 个唯一离线 Run；
- Fake Provider 经公开 Agent Loop、Session、LLM stream 与 Tool Registry 执行；tool-only 观测到 `search → open`，auto-inject 观测到 source 为 `plugin/dsh-mnemosyne/recall` 的 Recall UserMessage；
- Acquisition 的确定性预筛覆盖 novel、duplicate、external failure 与 sensitive 四类；只有 novel 调用 Fake Acquisition Provider，120 个 Run 共 24 次调用，其余 96 次为零调用；回执记录受控 reason code 与 Candidate Canonical Hash；
- 模型回执、Usage、observed/retrieved/opened/adopted 集合闭包、Recall Envelope/Receipt、Acquisition 时序和 canonical hash 均由严格验证器复核；
- 冻结安装、类型检查、20 个测试文件中的 86 项测试、构建、打包、包内容检查与 `git diff --check` 全部通过；tarball 仅包含 5 个生产文件，D0/D1 evaluation-only Runner 与 Fake Provider 未进入生产导出或发布包；
- 本阶段未访问网络、API Key、用户 DSH_HOME、Session 或 Workspace，也未生成 GO/ADJUST/STOP 质量结论。

D0/D1 只证明公开链路、协议、隔离、计量与离线可重放性。真实模型效果、真实 Token/延迟分布以及最终 M0.5 裁决仍必须由 D2/D3 产生；在用户明确批准真实 Provider 调用前保持 pending。

### 19.15 M0.5E：D2 Canary 离线预检执行器

> 状态：已完成并通过 Sol 独立验收；提交 `e70b3ba`。当前仅证明 `adversarial_preflight/canary_preflight_ready`，不代表真实 Provider 已接通。

#### 19.15.1 阶段边界

M0.5E 只实现并验证 D2 Canary 的安全编排，不连接真实 Provider，不读取 API Key，也不生成真实模型证据。完成后的唯一状态是：

```text
canary_preflight_ready, user_approval_and_real_provider_pending
```

本阶段继续由 Sol 设计和验收、Luna 实现；不把编码任务交给 DSH Agent。真实 D2 运行必须在用户明确批准后单独执行，批准 M0.5E 代码不等于批准任何模型调用或费用。

#### 19.15.2 固定 Canary Plan

Canary 固定使用 v2 Fixture，不允许调用者改变样本以改善结果：

- 每组各 1 个 `memory_dependent` Task 与 1 个 `non_memory_control` Task，共 6 个 Task Run；
- 三组固定为 `no_memory|tool_only|auto_inject`；
- 固定 requested seed `101`，Receipt 继续记录 Provider 是否实际支持 seed；
- 每个 Task Run 最多 4 次 Task Provider 调用；
- seed 101 对应 `novel_candidate`，每个 Run 最多 1 次 Acquisition Provider 调用；
- Task 调用上限 24，Acquisition 调用上限 6，总 Provider 调用硬上限 30；
- 不自动重试，不以新的 seed 或替代 Task 补齐失败样本。

Canary Plan 自身必须是严格、可 Canonical 编码的对象，包含 v2 Manifest Hash、6 个 run identity、provider/model identity、预算、超时和隔离根引用。执行前与执行后均验证 Plan Hash，防止运行中漂移。

#### 19.15.3 Provider 与凭据边界

项目当前没有锁定官方 DeepSeek Provider Adapter 包，M0.5E 不新增或猜测私有 Provider 实现。执行器只接受基于公开 `@deepseek-ai/dsh-llm` `LlmAdapter` 契约的显式 Adapter Factory：

- Factory 由未来获批的真实运行入口提供；M0.5E 测试只传 adversarial Fake Adapter；
- 核心执行器不读取 `process.env`、默认 DSH 配置、Keychain、用户 Home 或已有 Profile；
- Adapter Factory 只能得到受控 provider/model 配置和单次调用上下文，不得得到 Fixture 的 expected、required/forbidden Memory 或最终 Assertion；
- 凭据不得进入 Plan、Receipt、错误、日志、canonical bytes 或部分结果；
- Provider/model 不匹配、缺 usage、未知 stream event、重复 finish/usage、非法回执均 fail closed；
- Provider 不支持 seed 时只记录 `seed_honored=false`，不得伪造支持。

真实连接方式只有在用户批准 D2 时，依据当时已安装 DSH 的公开 Provider 能力另行冻结；若公开能力不足，停止并报告缺口，不读取私有实现、不回退 shell 驱动 Desktop。

#### 19.15.4 隔离与生命周期

每次 Canary 执行器调用创建新的临时根，并在其下创建：

```text
<temp-root>/dsh-home/
<temp-root>/workspace/
<temp-root>/receipts/
```

约束：

- 路径必须位于本次临时根真实路径内；拒绝 symlink、路径穿越和已有非空目录；
- 不读取或写入用户默认 DSH_HOME、真实 Workspace、Session、Profile 或 credential 文件；
- 每个 Run 仍创建全新的 Context、Session、Agent 与 Tool Registry，并在 finally 中释放；
- Receipt 只允许写入本次临时 `receipts/`，采用 no-overwrite 语义；
- 正常完成后可删除临时运行态，但返回的内存 Summary 必须先通过严格验证；失败时保留的合法前缀也只能存在于本次临时根；
- 清理失败只报告受控诊断，不把原任务/Provider 结果改写为成功。

#### 19.15.5 Budget Ledger、超时与熔断

Provider 调用必须先在进程内 Budget Ledger 原子 claim，再调用 Adapter；未 claim 不得产生副作用。Ledger 固定记录：

```text
task_calls_claimed
acquisition_calls_claimed
total_calls_claimed
completed_calls
failed_calls
consecutive_provider_or_protocol_errors
```

规则：

- 任一 claim 会使 Task>24、Acquisition>6 或 Total>30 时，在调用前返回 `budget_exhausted`；
- 单调用 timeout 30 秒，整批 timeout 10 分钟；timeout 不自动重试；
- 连续 2 次 Provider 或协议错误立即熔断，后续计划项不再 claim；
- Assertion 失败属于合法任务结果，不计为 Provider/协议错误；
- 每个 stream 必须恰好一个 terminal finish 和至少一个合法 usage；
- 部分结果只保存已经完整验证的 Receipt，当前失败 Run 与未开始 Run 不伪造空 Receipt；
- 熔断 Summary 的状态为 `canary_aborted`，包含受控 reason code、合法前缀数量和 Ledger，不包含原始模型文本。

#### 19.15.6 Canary 回执与结论边界

Canary Run Receipt 复用 M0.5D 的严格模型、Tool、Recall、Usage 与 Acquisition 校验，但新增：

- `evidence_kind=real_provider_canary|adversarial_preflight`；
- Plan Hash、provider/model identity；
- claim sequence 与调用类别；
- seed requested/honored；
- 单调时钟派生的调用持续时间；
- 受控失败码与脱敏标志。

M0.5E 只能生成 `adversarial_preflight`。即使 6 个离线 Run 全部通过，也只能证明预算、隔离、熔断、严格验证和清理逻辑可用，不能写成 real-provider plumbing pass，更不能形成 GO/ADJUST/STOP。

未来获批的 D2 真实运行恰好完成 6 个已验证 Receipt 后，只能输出：

```text
real_provider_plumbing_pass
real_provider_plumbing_fail
canary_aborted
```

仍不计算 M0.5 最终质量建议；D3 保持第二次单独批准。

#### 19.15.7 TDD 失败矩阵

Luna 必须先写失败测试，至少覆盖：

1. Plan 少/多 Run、组/Task/seed 漂移、Manifest Hash 错配、重复 identity 拒绝；
2. 调用第 31 次前拒绝，Task 第 25 次与 Acquisition 第 7 次分别拒绝；
3. claim 失败时 Adapter 调用计数不增加；
4. 单调用 timeout、整批 timeout 均停止且不重试；
5. 连续 2 次 Provider/协议错误熔断，合法前缀保留，未开始 Run 无 Receipt；
6. Assertion failure 不误触 Provider 熔断；
7. usage 缺失/重复/负数、未知 stream event、重复 finish、超大/非 JSON/未知字段模型回执拒绝；
8. Key、绝对路径、原始回答和 Fixture 私有字段不会进入错误、Receipt、Summary；
9. symlink、路径穿越、已有非空隔离目录拒绝，用户 DSH_HOME/Workspace 零读写；
10. dispose/清理后 Provider、Tool、Session 注册不残留；
11. 相同 adversarial 输入产生相同 Plan/Receipt canonical bytes；真实 duration 不进入确定性 golden；
12. evaluation-only Canary Runner、Adapter seam 与 Fixture 不进入生产 export、dist 或 tarball。

#### 19.15.8 自动门禁与完成标准

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check
```

完成标准：固定 6-run Plan、30-call Budget Ledger、两错熔断、两级 timeout、临时根隔离、严格回执、脱敏、确定性前缀和包边界全部由 adversarial Fake Adapter 测试证明；无网络、无 API Key、无用户状态访问。完成后停在 `canary_preflight_ready`，等待用户对真实 D2 调用的明确批准。

#### 19.15.9 Luna 实现任务书

```text
在 /Users/czy/Desktop/demo/dsh-Mnemosyne 实现 M0.5E：D2 Canary 离线预检执行器。

唯一设计依据是 docs/DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md 第 19.15 节；先完整读取 19.14～19.15 与提交 c8b942c，检查 git status。实现模型必须使用 Luna，不调用 DSH Agent 编码。

严格按 TDD 先写 19.15.7 的失败测试，再做最小实现。只使用已锁定 rc.6 公开 API；不增加真实 Provider 包，不读取 process.env/API Key/默认 DSH_HOME/用户 Session/Workspace，不联网，不产生费用。

实现 evaluation-only 的固定 Canary Plan、Adapter Factory seam、Budget Ledger、timeout、连续两错熔断、临时根隔离、严格 Receipt/Summary 验证与脱敏。复用 M0.5D 已签收的严格模型/Usage/Recall/Acquisition验证，不复制第二套宽松协议。所有调用必须先 claim；失败只保留完整验证的合法前缀。输出只能标记 adversarial_preflight/canary_preflight_ready，禁止伪造 real-provider 或 GO/ADJUST/STOP。

Runner/Fake/Fixture 不从 src/index.ts 导出，pack-check 必须证明不进入 dist/tarball。运行冻结安装、typecheck、完整 test、build、pack、pack-check、git diff --check。完成后做 review/security review，报告失败测试证据、调用上限、熔断、隔离、包内容与剩余真实 D2 授权边界；不要提交、推送或创建 Tag，等待 Sol 验收。
```

### 19.16 M0.5F：DSH rc.8 基线升级、公共 Provider 桥接审计与授权门禁

> 状态：✅ M0.5F0/F1 与 D2-A/B1/B2 已完成；D2-B3 已经用户单独明确批准并执行，结果为 `real_provider_plumbing_fail/circuit_open`。下一步应先补充稳定、脱敏的 Provider 错误分类，再决定是否申请新的诊断性执行授权；D3 未授权。

#### 19.16.1 目标与阶段边界

M0.5F 连接“已通过离线验证的 M0.5E Canary Runner”与“DSH 官方公开 Provider/凭据接口”。它不执行 D2，而是回答：

1. 先把当前项目从 `0.1.0-rc.6` 原子升级到官方 `next` 基线 `0.1.0-rc.8`，证明既有 M0～M0.5E 契约没有回归；
2. rc.8 是否具备公开 Provider、模型路由、凭据与 Agent Loop 接口；
3. 能否在不读取或复制 API Key 的前提下生成确定、可审计、可批准的真实运行计划；
4. 能否证明重试、额外后台模型调用、默认超大输出与用户环境污染均被关闭；
5. 用户批准的具体 Provider、模型、Fixture、调用上限、输出上限与成本边界是什么。

完成后的唯一允许状态为：

```text
real_canary_ready_for_user_approval
```

或稳定的阻断状态。M0.5F 禁止输出 `real_provider_plumbing_pass|real_provider_plumbing_fail|GO|ADJUST|STOP`，不解析真实回复、不形成质量证据、不写真实 D2 Receipt。批准本阶段代码或文档不等于批准真实调用；D2 仍需单独、明确的执行授权。

#### 19.16.2 M0.5F0：rc.8 基线升级 Gate

DSH 官方仍处于 Developer Preview，并明确可能产生兼容性破坏。2026-08-20 的 npm 元数据中 `@deepseek-ai/dsh` 的 `next` 为 `0.1.0-rc.8`、`latest` 为 `0.1.0-rc.7`；当前项目仍固定在 `0.1.0-rc.6`。因此拆为两个独立变更：

```text
M0.5F0：所有 DSH 官方包原子升级至精确 rc.8 + 既有契约全量回归
  → Sol Review / Security Review / 独立提交
M0.5F1：只基于已签收 rc.8 的公开 Provider/Credential 接口实现零调用 Dry-run
```

M0.5F0 只允许修改 DSH 依赖版本、lockfile、因公开 API 变更所必需的最小兼容代码与测试。它不得新增 Provider 桥接、授权对象、真实凭据逻辑或网络调用。升级必须满足：

- 所有已声明的 `@deepseek-ai/dsh-*` 包使用同一精确 `0.1.0-rc.8`，禁止 rc.6/rc.7/rc.8 混装；
- 先记录 rc.6 基线门禁，再更新版本；任何失败必须区分依赖安装、TypeScript API、运行时契约、Canonical/Hash、打包边界；
- M0～M0.5E 全部既有测试、golden、Fixture Hash、Receipt 与 pack-check 不得静默更新；只有官方公开 API 的机械适配可以修改，协议输出漂移必须停止并交给 Sol 决策；
- 不增加 `@deepseek-ai/dsh-llm-deepseek`，除非它已是完成 rc.8 依赖闭包不可缺少的官方 peer；即使安装，也不得注册或调用；
- 冻结安装、typecheck、全量 test、build、pack、pack-check 全绿后，才能把 rc.8 视为新的项目基线；
- M0.5F0 单独提交，不能与 M0.5F1 混成一个 diff。

##### 19.16.2.1 RC8BaselineAudit

M0.5F0 必须生成并在交付报告中展示确定性的升级审计结果；该对象只用于测试和 Review，不进入生产插件或发布包：

```yaml
schema_version: 1
status: rc8_baseline_ready_for_sol_review|blocked
source_version: "0.1.0-rc.6"
target_version: "0.1.0-rc.8"
npm_next_version: "0.1.0-rc.8"
package_json_sha256: "sha256_..."
lockfile_sha256: "sha256_..."
direct_dsh_packages:
  - name: "@deepseek-ai/dsh-agent-loop"
    declared_version: "0.1.0-rc.8"
    resolved_version: "0.1.0-rc.8"
public_seams:
  cordis_plugin: pass|blocked
  agent_loop: pass|blocked
  llm_adapter: pass|blocked
  session: pass|blocked
  tools: pass|blocked
  additional_contexts: pass|blocked
compatibility:
  canonical_goldens_unchanged: true
  fixture_hashes_unchanged: true
  receipt_contracts_unchanged: true
  production_exports_unchanged: true
  tarball_boundary_unchanged: true
audit_sha256: "sha256_..."
```

数组按包名稳定排序；Hash 覆盖除自身外全部字段。审计时间、机器路径、安装耗时和 npm 临时目录不进入 Canonical Bytes。任何 `blocked` 项都使总体状态为 `blocked`，不得通过修改 golden 或删除回归测试转绿。

##### 19.16.2.2 M0.5F0 TDD 与回归矩阵

至少覆盖：

1. 任一直接 `@deepseek-ai/dsh-*` 依赖仍为 rc.6、rc.7、范围版本或 workspace 占位时拒绝；
2. declared rc.8 但 lockfile/resolved package 不是同一精确 rc.8 时拒绝；
3. 同一包多版本或核心 DSH 依赖图跨 RC 混装时拒绝；
4. npm `next` 不再等于目标 rc.8、目标包缺失或 peer 依赖不可满足时停止，不自动追新版本；
5. M0.5B～E 使用的公开入口无法加载、类型签名变化或 Cordis 注册/销毁失败时阻断；
6. `additionalContexts`、Tool result、Session/Agent Loop 公开链路的既有测试必须原样通过；
7. M0.5A～E 的 Canonical Bytes、Fixture Hash、Receipt Schema 与确定性结果不得变化；
8. `src/index.ts` 生产导出、`cordis.patch.yml` Bundle 和 tarball 五文件白名单不得变化；
9. 测试期间 Provider stream、Credential resolve、用户 DSH_HOME/Workspace/Session 访问次数均为 0；
10. 相同 package.json/lockfile/公开 seam 输入生成逐字节一致的 `RC8BaselineAudit`；
11. 错误输出不得包含 npm token、绝对用户路径、环境变量值或 lockfile 临时路径；
12. rc.8 适配不得删除、跳过或改名既有测试来降低覆盖率。

##### 19.16.2.3 M0.5F0 独立门禁

升级前先在 rc.6 运行一次完整基线，升级后执行：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm exec vitest run tests/dsh-rc8-compat.spec.ts tests/m05d-d0.spec.ts tests/m05e.spec.ts
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check
```

只有全部通过并经 Sol Review / Security Review 后，M0.5F0 才可单独提交。提交后主文档状态更新为“rc.8 baseline accepted”，再开始 M0.5F1；不得在同一次 Gemini 任务中继续写 Provider 桥接。

#### 19.16.3 M0.5F1：版本与公开接口 Gate

> 当前实现任务、TDD 矩阵、文件边界与 Gemini 3.7 Flash 完整提示词见 `docs/DSH_MNEMOSYNE_M05F1_PLAN.zh-CN.md`。本节仍是架构事实源；任务文档不得放宽本节的零调用、零凭据、隔离与授权边界。

M0.5F0 签收后，M0.5F1 必须先生成 `ProviderCompatibilityAudit`：

```yaml
schema_version: 1
audited_at: "由测试显式传入的 RFC3339 时间"
previous_dsh_version: "0.1.0-rc.6"
project_dsh_version: "0.1.0-rc.8"
project_lock_sha256: "sha256_..."
official_reference:
  repository: "deepseek-ai/deepseek-harness"
  branch_or_tag: "..."
  commit: "..."
packages:
  dsh_agent_loop: "..."
  dsh_llm: "..."
  dsh_llm_deepseek: "..."
public_contracts:
  provider_plugin: pass|missing|incompatible
  model_route: pass|missing|incompatible
  credential_reference: pass|missing|incompatible
  isolated_profile: pass|missing|incompatible
  zero_retry_path: pass|missing|incompatible
  max_output_cap: pass|missing|incompatible
decision: compatible|blocked
audit_sha256: "sha256_..."
```

硬规则：

- 只允许 DSH 官方公开包、公开导出和公开 Cordis 服务；禁止深路径导入、复制私有实现、Desktop 内部 IPC 或 Shell 驱动 UI；
- 首选官方 DeepSeek Provider 插件、官方 Provider route 和公开模型目录；具体包名、route 与 model 必须由 rc.8 实际导出和运行时 Smoke 证明；
- rc.8 缺少必要公开能力时必须 `blocked` 并输出精确差异；不得换第三方 Provider 或绕过凭据服务；
- 若确需升级 DSH，另开兼容性升级设计、提交与全量回归，之后重跑 M0.5F；
- Audit 的时间、版本和源码身份均为显式输入，禁止以 `Date.now()` 或联网查询作为确定性输出的隐含输入。

#### 19.16.4 Provider、模型与预算固定

Compatibility Audit 通过后，Dry-run 才能构造 `RealCanaryPlan`。计划必须固定：

- Provider route、模型 ID、DSH 与 Provider 包版本；
- v2 Fixture Manifest Hash 与 M0.5E Canary Plan Hash；
- 6 个固定 Run 与 requested seed `101`；
- Task 调用最多 24、Acquisition 最多 6、总调用最多 30；
- 单次 timeout 30 秒、整批 timeout 10 分钟；
- 单次输出 Token 上限建议固定 `4096`，不得继承 Provider 超大默认值；
- 连续 2 次 Provider/协议错误熔断；
- 禁止自动重试、标题生成、摘要、压缩、后台 Agent 或任何未被 Budget Ledger claim 的模型调用。

模型和限额不是执行时自由参数。任何变更必须产生新 Plan Hash 并重新批准。

#### 19.16.5 零重试与 Claim 对应请求

M0.5F 必须证明：

```text
1 successful Ledger claim == at most 1 outbound Provider request
```

- 隔离 Profile 不加载自动重试插件；
- 若公开配置支持零重试，必须以运行时计数测试证明；
- 若不能关闭 Agent Loop 重试，可使用公开单次 stream 路径，但仍须保持 M0.5D 的协议与回执验证边界；
- 两条路径都无法证明时，Audit 必须 `blocked`；
- 不接受仅凭配置名、注释或文档作出“无重试”判断，必须使用 Counting Fake Transport/Adapter 证明。

#### 19.16.6 凭据安全边界

Mnemosyne 不拥有、读取、缓存或持久化 DeepSeek API Key。凭据只能由 DSH 公开凭据机制在真实请求边界解析。

M0.5F Dry-run：

- 不读取 `process.env`、默认 `$DSH_HOME`、`.credentials.yaml`、Keychain、用户 Profile、Session 或 Workspace；
- 不调用 `credentials.resolve()` 或等价秘密解析接口；
- 不实例化会联网的真实 Transport；
- 只记录 Credential Reference 的受控标识和非秘密可用性状态；
- Config、Audit、Plan、Authorization、错误、日志、快照与 Fixture 均不得包含 API Key、Authorization Header、秘密查询参数或秘密长度特征。

实际 D2 获批后，也只能由隔离 DSH Profile 在调用瞬间解析 Credential Reference；Mnemosyne 只接收脱敏状态与规范化 Usage。

#### 19.16.7 Dry-run 授权对象

Dry-run 输出严格的 `RealCanaryAuthorizationRequest`：

```yaml
schema_version: 1
authorization_id: "auth_..."
status: pending_user_approval
created_at: "显式输入"
expires_at: "显式输入"
compatibility_audit_sha256: "sha256_..."
canary_plan_sha256: "sha256_..."
fixture_manifest_sha256: "sha256_..."
runtime:
  dsh_version: "0.1.0-rc.8"
  provider_package: "..."
  provider_package_version: "..."
  provider_route: "..."
  model: "..."
limits:
  task_calls: 24
  acquisition_calls: 6
  total_calls: 30
  max_output_tokens_per_call: 4096
  call_timeout_ms: 30000
  batch_timeout_ms: 600000
  automatic_retries: 0
cost:
  status: verified|unavailable
  currency: "USD|null"
  source_ref: "非秘密的官方价格来源引用|null"
  source_checked_at: "显式时间|null"
  worst_case_upper_bound: "十进制定点字符串|null"
isolation:
  temporary_dsh_home: true
  temporary_workspace: true
  user_state_access: false
authorization_sha256: "sha256_..."
```

授权规则：

- Hash 覆盖除自身外全部字段；时间必须显式传入，过期授权不可执行；
- Audit、Plan、Fixture、版本、Provider、模型或限额变化会使旧授权失效；
- 用户决定用独立 Approval Receipt 表达，不原地修改 pending 对象；
- Approval Receipt 引用 Authorization Hash，并记录 `approved|rejected`、显式时间和受控主体标识；
- 价格不是已验证公共契约时不得猜测，必须标记 `unavailable`；执行前至少需要用户明确接受绝对调用上限和单次输出上限；
- M0.5F 只生成 pending Authorization Request，不生成 approved Receipt。

#### 19.16.8 隔离 Profile Dry-run

在全新临时 isolation root 内规划最小 DSH Profile，但不启动真实 Provider：

1. 复用 M0.5E `prepareIsolationRoot`，拒绝已有目标、路径穿越与任意祖先 symlink；
2. 仅规划 D2 所需公开 Agent Loop、LLM、官方 Provider、Tool、Session 与 Mnemosyne evaluation-only 组件；
3. 排除 retry、title、summary、compaction、Desktop、Web 和其他隐式模型调用插件；
4. 校验 Provider route 唯一、模型存在、Credential Reference 形状合法、输出上限覆盖默认值；
5. 用 Fake Credential Service 与 Counting Fake Transport 做公开注册、配置校验和单请求语义 Smoke；
6. dispose 后断言服务、route、Tool、Session 与临时资源无残留；
7. 用户默认 DSH_HOME 与 Workspace 前后目录指纹一致。

若官方插件在构造时强制解析真实凭据或联网，本阶段必须停止并报告不兼容，禁止打补丁绕过。

#### 19.16.9 M0.5F1 TDD 失败矩阵

Gemini 3.7 Flash 必须先写失败测试，至少覆盖：

1. rc.8 缺 Provider 包、公开导出、Credential seam、route 或 model 时 Audit=`blocked`；
2. 锁文件版本、实际包版本、Audit commit 或 Plan Hash 不一致时拒绝；
3. 重复 route、未知模型、非官方 Provider 或深路径导入描述被拒绝；
4. retry 插件存在、retry 非零或一次 claim 触发多次 Transport 请求时拒绝；
5. 未显式覆盖超大默认输出、输出上限非法时拒绝；
6. Dry-run 中 `credential.resolve`、真实 Adapter stream、`fetch/http/https/net` 调用计数均为 0；
7. Dry-run 不读取环境变量、默认 DSH_HOME、用户 Workspace、Session 或凭据文件；
8. Authorization 的任一绑定字段被篡改时 Hash 校验失败；
9. 过期、未来创建、未知状态、原地 approved 或缺明确限额的授权拒绝；
10. 价格缺失时不得填 0 或猜测，必须 `unavailable`；
11. Key、Header、绝对用户路径、原始异常、Provider 回执与 Fixture 私有内容不进入输出；
12. isolation root 自身/祖先 symlink、已有目标与非目录组件在外部写入前拒绝；
13. dispose 后无注册残留，用户目录指纹不变；
14. 相同显式输入产生逐字节一致的 Audit、Plan 和 Authorization；
15. M0.5F 代码、Fake、Audit Fixture 与授权样本不进入生产 export、dist 或 tarball。

#### 19.16.10 M0.5F1 文件边界

建议最小范围：

```text
src/m05f/provider-audit.ts
src/m05f/authorization.ts
src/m05f/dry-run.ts
src/m05f/index.ts
tests/m05f.spec.ts
tests/pack-check.mjs
```

- 不从 `src/index.ts` 导出 M0.5F，不修改生产 `cordis.patch.yml`；
- Provider 包不得进入生产 dependencies/peerDependencies；
- 若公开 rc.8 Smoke 必须增加官方 Provider 包，只能加精确 rc.8 evaluation-only devDependency，并在报告中举证；
- M0.5F1 禁止再次升级任一 DSH 包；rc.8 不兼容即停止；
- 不修改 M0.5A～E Fixture、Canonical Bytes、Hash 或已签收回执。

#### 19.16.11 M0.5F1 自动门禁与完成标准

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm exec vitest run tests/m05d-d0.spec.ts tests/m05e.spec.ts tests/m05f.spec.ts
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check
```

完成标准：Audit 给出 rc.8 可复核结论；Dry-run 对 Provider/Profile/Credential/Retry/Output/Isolation 完成零调用验证；pending Authorization 确定、可校验、可过期并绑定全部版本、Hash、限额和成本状态；测试证明 Provider stream、Credential resolve 与网络调用均为 0；发布包无 evaluation-only 实现。最终只能是 `real_canary_ready_for_user_approval` 或稳定 `blocked`，不得提交、推送或创建 Tag。

#### 19.16.12 Gemini 3.7 Flash 实现提示词（M0.5F0 历史归档）

```text
你是实现工程师，使用 Gemini 3.7 Flash。工作目录：
/Users/czy/Desktop/demo/dsh-Mnemosyne

执行 M0.5F0：把 dsh-Mnemosyne 的 DSH 基线从 0.1.0-rc.6 原子升级到官方 next 0.1.0-rc.8，并完成全量兼容性回归。

唯一设计依据是 docs/DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md 第 19.14～19.16 节。先完整读取这些章节、package.json、pnpm-lock.yaml、提交 e70b3ba 及当前 git status。不要调用 DSH Agent 编码；不要修改 oh-my-reasonix。

本任务不是 M0.5F1，也不是执行真实 D2。禁止真实 Provider 调用、禁止读取或解析 API Key、process.env、默认 DSH_HOME、用户 Profile/Session/Workspace、.credentials.yaml 或 Keychain，禁止产生模型费用。网络只允许访问 npm 官方 Registry 和 DSH 官方 GitHub 源码以解析精确 rc.8 依赖与公开 API；禁止访问任何模型 Provider endpoint。不得把升级完成写成 real_canary_ready_for_user_approval、real_provider_plumbing_pass 或 GO/ADJUST/STOP。

先确认 npm 元数据：@deepseek-ai/dsh 的 next 必须精确为 0.1.0-rc.8；若 next 已变化、任一项目依赖没有 rc.8、完整依赖闭包不可解析，立即停止并报告，不猜版本。

执行顺序：
1. 检查 git status；不得覆盖用户已有修改。记录 package.json/pnpm-lock.yaml 中全部 DSH 精确版本。
2. 在 rc.6 基线上运行 frozen install、typecheck、完整 test、build、pack、pack-check、git diff --check，保存基线结果。
3. 先写一个最小兼容性测试，断言 package.json 中全部直接 @deepseek-ai/dsh-* 依赖使用同一精确版本、实际解析版本一致、M0.5B～E 使用的公开 Cordis/Agent Loop/LLM/Session/Tool seam 仍可从公开入口加载。测试应在 rc.6 基线因目标版本不符而失败。
4. 将 package.json 中全部直接 @deepseek-ai/dsh-* peerDependencies/devDependencies 原子升级为精确 0.1.0-rc.8，并重新生成 lockfile。禁止 rc.6/rc.7/rc.8 混装。
5. 仅修复 rc.8 公开 API 变化导致的最小编译或测试问题。禁止 deep import、复制 DSH 私有实现、放宽验证、重录 golden、修改 Fixture/Canonical Bytes/Hash/Receipt 以掩盖回归。
6. 若 Cordis、Schemastery 或非 DSH 包必须因 rc.8 peer constraint 升级，先提供解析证据；仅做最小精确升级并在报告单列。没有硬性 peer 约束则不动。
7. 不新增 Provider 桥接、Authorization、Credential 代码，不创建 src/m05f/**，不注册 @deepseek-ai/dsh-llm-deepseek。若该包只是间接依赖，记录但不调用。

升级成功标准：既有 123+ 测试与新增版本一致性测试全绿；M0.5A～E golden/Fixture/Receipt 不变；生产导出与 tarball 白名单不变；所有直接和解析到的 DSH 核心包不存在跨 RC 混装；无真实 Provider、凭据或用户状态访问。

允许修改：package.json、pnpm-lock.yaml、新增 tests/dsh-rc8-compat.spec.ts，以及公开 API 变更要求的最小现有源码/测试。不要修改 README、主架构文档、生产 cordis.patch.yml，除非 rc.8 的公开插件 manifest 契约使后者无法加载；遇到该情况先停止并报告，不自行扩大范围。

运行：
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm exec vitest run tests/dsh-rc8-compat.spec.ts tests/m05d-d0.spec.ts tests/m05e.spec.ts
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check

完成后做普通 review 和 security review。报告：rc.6 基线结果、npm next 与各包 rc.8 可用性证据、升级前后依赖矩阵、peer 依赖变化、失败测试先行证据、所有机械适配、golden/Fixture/Receipt 未漂移证据、tarball 清单、全部门禁、零 Provider/零凭据/零用户状态访问声明，以及仍留给 M0.5F1 的公开 Provider 桥接工作。

不要 git commit、push 或创建 Tag。完成后只可报告 rc8_baseline_ready_for_sol_review 或稳定 blocked，等待 Sol 验收；不要进入 M0.5F1。
```
