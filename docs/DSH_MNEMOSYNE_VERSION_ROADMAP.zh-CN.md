# dsh-Mnemosyne 版本开发路线图

> 状态：✅ `v0.2.0` 零操作 OKF 记忆闭环实现完成，待本地观察与发布
> 日期：2026-08-28
> 当前已发布版本：`0.1.0`（技术预览）
> 当前开发版本：`0.2.0`
> 当前待迁移 DSH 基线：本机 CLI `0.1.1-rc.2`，公开 SDK `0.1.1-rc.2`
> 唯一产品目标：为 DSH 管理项目级持久 OKF 记忆
> 明确排除：插件自进化、代码生成、自修改和自动发布

## 一、版本规划原则

版本按用户可感知的完整能力划分，不按内部模块划分。

一个版本内部可以拆成多个设计任务、测试阶段和小提交，但只有完整目标验收后才创建一个版本 Tag。

```text
v0.1.0  工具式技术预览
  → v0.2.0 零操作 OKF 记忆 MVP
  → v0.3.0 管理与规模化
  → v1.0.0 正式稳定版
```

每个版本必须：

1. 能独立安装和使用；
2. 相对上一版本解决一个明确的产品限制；
3. 不依赖修改 DeepSeek Harness，只使用公开插件扩展；
4. 不兼容版本必须明确隔离旧数据；`v0.2.0` 保留但不读取 `v0.1.0` 事实；
5. 自动记忆功能失败不得改变原 DSH 任务结果；
6. 不包含任何自进化能力。

### 1.1 DSH 基线规则

Mnemosyne 不再把 `0.1.0-rc.8` 当作后续开发基线。历史 M0.5/D2 文档中的 rc.8 只代表当时的审计事实，不应被批量改写，也不得作为新代码的接口依据。

每个内部开发任务开始前必须：

1. 读取本机 `dsh --version`；
2. 查询本任务直接依赖的 DSH 公开 npm 包可用版本；
3. 选择与本机 CLI 一致、且所有直接依赖均公开存在的最新版本族；
4. 在 `package.json` 与 lockfile 中精确锁定该版本，不使用 `latest`、`^` 或 `~`；
5. 重新核对官方公开文档、根导出与类型声明；
6. 任务执行期间保持基线不变；若期间发布新版本，在下一内部任务开始前再评估升级。

当前第一项工作是把仓库从 `0.1.0-rc.8` 迁移到 `0.1.1-rc.2`，完成兼容性审计后才进入记忆产品实现。

## 二、统一记忆边界

`v0.2.0` 只管理 Project Scope 的持久 OKF Memory。当前 Session 上下文继续由 DSH 管理；短期/长期二分和显式晋升属于 `v0.1.0` 历史技术预览，不进入 `v0.2.0` 产品路径。

DSH 继续管理原始对话、Tool 事件和 Session 日志。Mnemosyne 不复制完整对话、不保存思考过程，也不接管 DSH 上下文窗口。

以下短期/长期二分仅描述 v0.1.0 历史实现：

| 类型 | 用途 | Scope | 存续 |
|---|---|---|---|
| 短期记忆 | 当前 Session/任务中的状态、发现、待验证经验 | Session + Project | 可过期、可沉淀 |
| 长期记忆 | 可跨 Session 复用的工程知识、约束、决策和策略 | Project | 持久保存、显式管理 |

短期记忆沉淀为长期记忆属于记忆管理，不属于自进化。只有修改插件代码、生成插件或自动改变系统策略才属于自进化，本路线图完全不实现。

## 三、版本总览

| 版本 | 完整目标 | 相对上一版的提升 |
|---|---|---|
| `v0.1.0` | 工具式技术预览 | 验证 Fact Store、Generation、Scope 和 DSH 插件接入 |
| `v0.2.0` | 零操作 OKF 记忆 MVP | 从用户调用工具变为模型自主、严格渐进披露的自动闭环 |
| `v0.3.0` | 管理与规模化 | 从零操作单项目记忆提升到可靠运维、可视管理和安全跨项目复用 |
| `v1.0.0` | 正式稳定版 | 从功能完整提升到协议、迁移、性能和兼容性稳定 |

## 四、v0.1.0：工具式技术预览（历史）

### 4.1 版本目标

`v0.1.0` 必须一次交付完整、可真实使用的记忆闭环，而不是把 MVP 再拆成多个发布版本：

```text
DSH 任务/用户输入
→ 自动采集与结构化提取
→ 短期记忆
→ 稳定写入
→ 沉淀长期记忆
→ OKF 编译
→ search 摘要披露
→ open 全文披露
→ 基础管理
```

### 4.2 必须包含的能力

#### A. DSH 原生插件与 Scope

- 使用经当前任务 Baseline Gate 确认的最新 DSH 公开 Tool、Session/Event 和模型接口；
- Project Root 优先来自公开 Session `meta.cwd`；无法取得时使用显式绝对配置；
- 禁止通过 `process.cwd()` 猜测项目；
- 不读取 DSH 私有数据库，不使用 deep import、Desktop IPC 或猴子补丁；
- 插件禁用或 dispose 后撤销全部 Tool、监听器和内存状态。

#### B. 短期记忆与长期记忆

- 短期记忆绑定 Session + Project，支持显式到期时间；
- 长期记忆绑定 Project，跨 Session 与 DSH 重启保留；
- 两类记忆均使用严格 Schema、Canonical Hash 和不可变 Fact；
- 短期记忆到期后退出默认索引；
- 短期记忆可沉淀为长期记忆，并保留来源引用；
- 不保存完整 Prompt、思考过程、完整命令、Credential 或原始 Tool 参数。

#### C. 自动采集与结构化提取

```text
公开任务完成边界
→ 收集允许的结构化证据
→ 确定性重复预筛
→ 使用 DSH 现有模型输出严格 Memory Candidate
→ Schema/敏感信息校验
→ 写入短期记忆
```

- 实现前必须证明 DSH 公开接口存在可靠完成边界；不能判断完成时不得猜测；
- 提取失败不影响原任务结果；
- 重复事件和重复 Candidate 幂等；
- 自动提取默认只进入短期记忆，不直接污染长期记忆；
- 保留人工 `remember` 入口，用于补录和测试。

#### D. 稳定写入与稳定读取

```text
<project-root>/.dsh-mnemosyne/
├── facts/
│   ├── short-term/<session-id>/<memory-id>.json
│   └── long-term/<memory-id>.json
├── generations/<generation-id>/
├── CURRENT
├── locks/
└── tmp/
```

- 事实是唯一事实源；OKF、索引和 CURRENT 都是派生数据；
- 同身份同内容 `NOOP`，同身份不同内容 `CONFLICT`；
- 目录 `0700`、文件 `0600`；
- 路径逐组件拒绝 symlink、穿越和非目录；
- 临时文件、fsync、no-overwrite 原子发布；
- 同一机器同一项目的并发写安全；
- Fact 发布后 OKF 编译失败时 CURRENT 保持旧值，重试可继续；
- 读取严格拒绝未知字段、损坏 JSON、超大文件、权限过宽和 Hash 漂移；
- 错误消息不回显正文、绝对路径或敏感输入。

#### E. OKF 与渐进式披露

最小 OKF：

```text
wiki/ROOT.md
wiki/short-term/<session-id>.md
wiki/components/<component>.md
wiki/memories/<memory-id>.md
index.json
manifest.json
```

- 相同 Fact 集和编译器版本产生逐字节一致的 Generation；
- `CURRENT` 是唯一生效点；
- Root/Local Index 只放目录、标题、摘要和引用；
- Memory Page 才包含完整正文；
- 派生 Generation 可从 Fact 重建。

披露层级：

| 层级 | 内容 |
|---|---|
| L0 | status 与 Tool 描述：记忆是否可用、短期/长期数量 |
| L1 | search：最多 5 条标题、摘要、tier、tags、得分和引用 |
| L2 | open：绑定 Search Disclosure 后披露一条完整 Memory Page |

- search 不返回正文；
- open 必须绑定 retrieval ID、Search Disclosure Hash 和 memory ID；
- 旧 Disclosure 固定读取原 Generation，不随 CURRENT 偷换世界；
- 检索使用确定性文本索引，不使用向量数据库；
- v0.1.0 不自动注入全部记忆。

#### F. 基础记忆管理

v0.1.0 至少提供：

```text
mnemosyne_status
mnemosyne_remember
mnemosyne_list
mnemosyne_search
mnemosyne_open
mnemosyne_promote
mnemosyne_forget
```

- `promote` 将短期记忆沉淀为长期记忆；
- `forget` 在 MVP 中只做逻辑遗忘，不物理销毁事实；
- 所有写操作幂等，失败不得留下半完成 CURRENT；
- 不做复杂自动晋升、质量评分或成败归因。

### 4.3 内部开发阶段

这些是 `v0.1.0` 内部任务，不是独立发布版本：

```text
MVP-00  最新 DSH Baseline Gate 与公开 API 兼容性审计
MVP-01  DSH Runtime、Project/Session Scope
MVP-02  短期/长期 Fact Store 与安全读写
MVP-03  OKF Compiler、Manifest、Generation、CURRENT
MVP-04  search/open 渐进式披露
MVP-05  自动采集与结构化提取
MVP-06  promote/forget/list 基础管理
MVP-07  临时项目真实 DSH 闭环与发布验收
```

每个内部阶段单独设计、单独测试、小步提交，但全部完成后只创建一个 `v0.1.0` Tag。

### 4.4 v0.1.0 验收

1. 真实任务结束后自动产生结构化短期记忆；
2. 人工 remember 也可稳定写入；
3. DSH 重启后短期和长期记忆仍能按 Scope 读取；
4. 短期记忆可沉淀为长期记忆；
5. 换措辞能 search 到正确候选；
6. search 不泄露正文，open 绑定后返回正文；
7. 重复写入 NOOP，冲突零覆盖；
8. 两个项目和两个 Session 不串记忆；
9. symlink、路径穿越、权限、损坏和并发写全部 fail closed；
10. 自动提取失败不改变原任务退出状态；
11. 生产包不包含 M0.5 Provider Runner、Fake Provider 和 Fixture；
12. 全量自动门禁及真实临时项目联调通过。

完成标志：`memory_mvp_ready`。

## 五、v0.2.0：零操作 OKF 记忆 MVP

### 5.1 解决 v0.1.0 的限制

`v0.1.0` 验证了存储、Generation、Scope 和插件接入，但其用户可见工具、关键词检索、短期/晋升模型不符合安装即用的自动记忆体验。

`v0.2.0` 将记忆重构为独立 OKF Memory，由模型沿 Title、Summary、Content 自主渐进回忆，并在 turn 结束后自动沉淀。

### 5.2 新增能力

- 独立、不可变的 `OKFMemoryV2` 与可重组 Catalog；
- Root/Local Title Index、Memory Summary、Memory Content 三层 Generation；
- 模型自主执行严格 `Title → Summary → Content` Recall；
- Recall 作为可重放 plugin 消息自动进入主模型请求；
- turn 正常结束后自动 `skip | create`，新知识直接成为项目持久记忆；
- 新踩坑创建关联新记忆且旧记忆字节不变；
- 用户可见 Tool、根导出和发布包中零 `mnemosyne_*`；
- `.dsh-mnemosyne/debug/runtime.jsonl` 提供开发者诊断。

详细 Schema、运行时顺序和 Gate 见 `DSH_MNEMOSYNE_V020_ZERO_OPERATION_OKF_MEMORY_PLAN.zh-CN.md`。

### 5.3 强制提升 Gate

- 第一阶段只向导航模型提供 Title；
- 未选择 Title 不披露 Summary，未确认 Summary 不读取 Content；
- 每轮最多 5 个 Summary、3 个 Content、6 个展开步骤；
- 新 Session 能以不同措辞通过模型语义选择找到旧经验；
- 主模型收到持久 recall 消息，用户全程只发送自然语言；
- 自动沉淀产生 v2 Memory/Catalog/Generation，skip/noop/失败均有脱敏日志；
- 旧 v0.1.0 事实字节保持不变且不进入 v2 Generation。

完成标志：`zero_operation_okf_memory_ready`。

## 六、v0.3.0：管理与规模化

### 6.1 解决 v0.2.0 的限制

`v0.2.0` 已实现零操作自动闭环，但尚无用户 Web 管理界面，也只支持单项目内复用；长期运行还会遇到损坏、残留锁、空间增长和跨项目复用需求。

`v0.3.0` 集中解决管理体验、可靠运维和规模扩展。

### 6.2 新增能力

#### Doctor 与恢复

- 检查 Fact、Revision、Generation、Manifest、CURRENT、权限、symlink、孤儿 staging 和锁；
- Repair 只重建派生数据，不伪造或覆盖规范事实；
- Snapshot、Backup、Restore 与 Hash 验证；
- 短期记忆 retention 和派生 Generation 清理；
- 存储数量、字节、检索延迟和提取成本统计。

#### 管理体验

- 优先使用 DSH 已公开的 Web/插件 UI 扩展；
- 若 DSH 没有公开 UI 接口，则提供完整 Tool/CLI 管理，不修改 DSH；
- 短期/长期列表、过滤、详情、关系图；
- revise/freeze/restore/forget/promote 的预览与批量操作；
- UI 只调用规范 API，不成为第二事实源。

#### 项目与全局记忆

- Project 与 Global 使用独立 Store、Generation 和 CURRENT；
- 只有显式操作能把 Project 记忆晋升为 Global；
- Global 禁止绝对路径、项目私有标识和敏感内容；
- Project 默认优先，Global 不覆盖 Project；
- 严格 export/import、dry-run、Hash、NOOP 和冲突拒绝；
- 不实现联网同步和中央服务。

### 6.3 强制提升 Gate

相对 v0.2.0 必须证明：

- 故障可以被稳定诊断，允许修复的派生问题可重建；
- 备份和恢复不改变 Fact Hash；
- 用户无需阅读文件即可完成主要管理操作；
- 项目记忆不会未经显式晋升进入其他项目；
- 大型记忆库的磁盘、延迟和内存仍在冻结上限内。

完成标志：`memory_manager_complete`。

## 七、v1.0.0：正式稳定版

### 7.1 解决 v0.3.0 的限制

`v0.3.0` 已具备完整功能，但公开协议、迁移、跨平台表现和长期兼容承诺尚未正式冻结。

`v1.0.0` 不再增加新的记忆概念，只做正式发布收敛。

### 7.2 发布工作

- 冻结 Tool、Fact、Revision、OKF、Manifest、配置和错误码协议；
- 覆盖 `v0.1.0 → v0.2.0 → v0.3.0 → v1.0.0` 迁移；
- macOS/Linux 与 DSH Desktop/CLI 兼容矩阵；
- 大规模记忆库性能、并发、磁盘和 Token 测试；
- 路径、symlink、权限、敏感信息和 Prompt injection 安全审查；
- 安装、升级、卸载、备份、恢复和故障文档；
- production 包移除或隔离全部历史 M0.5 evaluation-only 资产；
- 真实用户验收后才创建 `v1.0.0` Tag/Release。

### 7.3 强制提升 Gate

相对 v0.3.0 必须证明：

- 升级不丢失、不串联、不静默改写记忆；
- 协议只有显式版本化才能变化；
- 所有自动采集失败均不影响原任务；
- Doctor、Backup、Restore 和卸载恢复真实可用；
- 没有自进化代码、插件自动生成或自动发布通道。

完成标志：`stable_memory_manager`。

## 八、版本提升关系

| 从 | 到 | 用户得到的实际提升 |
|---|---|---|
| `0.0.0-dev` | `v0.1.0` | synthetic 只读实验 → 完整短期/长期记忆 MVP |
| `v0.1.0` | `v0.2.0` | 能记住和找回 → 记得更准、找得更准、错误可纠正 |
| `v0.2.0` | `v0.3.0` | 零操作单项目记忆 → 可诊断、可视管理、安全跨项目复用 |
| `v0.3.0` | `v1.0.0` | 功能完整 → 协议、迁移、性能和兼容性稳定 |

若一个版本不能证明上述提升，不为了版本号发布；继续修复、缩小范围或推迟该版本。

## 九、开发与提交方式

每个版本内部继续小步开发：

```text
版本总体设计
→ 内部任务设计文档
→ 文档提交
→ Gemini 3.7 Flash TDD 实现
→ Gemini 自 Review / Security Review
→ Codex CTO Review
→ 单任务代码提交
→ 下一内部任务
→ 整版真实联调
→ 用户确认
→ 创建一个版本 Tag
```

通用门禁：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check
```

设计文档必须先于代码；一个可审查行为一个提交；禁止把两个产品版本混入同一个提交或 Tag。

## 十、现有资产处理

| 现有资产 | 处理方式 |
|---|---|
| DSH rc.8 插件骨架、Tool 注册、dispose | v0.1.0 复用 |
| M0.5B normalize/rank/search/open | v0.1.0 复用算法，替换 synthetic 数据源 |
| M0.5 Fixture、Fake Adapter、三组评测 | 保留为开发测试历史，不作为产品数据 |
| M0.5D/F/D2 Provider Runner | 冻结，不继续扩展，不进入 Memory Kernel |
| Approval、Budget、Receipt、Diagnostic | 只属于历史评测支线，不成为记忆依赖 |
| Acquisition Schema 草案 | v0.1.0 自动提取可参考，但必须按产品边界重新设计 |
| 总体架构中的自进化章节 | 标记为非当前路线，不进入任何版本 |

## 十一、确认后的下一步

用户确认后：

1. 将本文状态改为“✅ 已批准”；
2. 在总体架构顶部增加“记忆管理主线重置”说明；
3. 编写 `v0.1.0` 的内部 `MVP-01～MVP-07` 总体任务清单；
4. 先设计 `MVP-01`，文档提交后再实现；
5. 完成全部内部任务后只创建一个 `v0.1.0` Tag。
