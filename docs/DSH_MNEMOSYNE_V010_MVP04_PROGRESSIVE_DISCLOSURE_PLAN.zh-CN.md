# dsh-Mnemosyne v0.1.0 · MVP-04 生产检索与渐进式披露计划

> 状态：✅ CTO 最终签收（2026-08-25）
>
> 日期：2026-08-25
>
> 基线：`main`，MVP-03 提交 `a61b1b7`
>
> 执行模式：Codex 负责设计与验收，Gemini 3.7 Flash 负责实现；先测试、后最小实现、自审通过后交付 CTO Review。

---

## 一、目标与成功标准

MVP-04 只完成一条生产读取链：

```text
DSH ToolRunContext
→ 解析 Project / Session Scope
→ 严格验证 CURRENT 所指向的 Generation 世界
→ mnemosyne_search 仅从 Generation index.json 检索
→ 返回 L2 Search Disclosure（不含正文）
→ mnemosyne_open 校验同 Session 的 Search 授权
→ 再验证 Search 固定的历史 Generation
→ 返回一个 Memory 的 L3 Open Disclosure（含正文）
```

成功标准：

1. 生产 `observer` 不再加载或披露 M0.5 合成 Fixture；
2. `mnemosyne_search` 只读取已由 MVP-03 发布并严格验证的 Generation 索引；
3. search 最多返回 5 项，包含标题、摘要、Tier、Tags、确定性分数和引用，绝不返回正文；
4. `mnemosyne_open` 必须同时绑定 Retrieval ID、Search Disclosure Hash、Memory ID、Project Scope、Session Scope 和固定 Generation；
5. Search 后即使 CURRENT 前进，Open 仍读取 Search 当时固定的旧 Generation，不偷换成最新世界；
6. Generation、Manifest、Index、Page、Fact 任一损坏、缺失、Hash 漂移或 Scope 错配均 fail closed；
7. 相同 Generation + 相同请求得到逐字节一致的 Search Disclosure；
8. Tool 输出形成可由 DSH Session/Event 重放的上下文，不要求重新执行 Librarian 得到相同选择；
9. 不自动注入、不自动采集、不自动提取、不晋升、不遗忘、不做自进化；
10. 全量门禁、打包泄漏检查及 CTO Review 全部通过。

---

## 二、范围

### 2.1 本阶段实现

- 生产 OKF Retrieval Runtime；
- verified current/fixed Generation 只读快照；
- 确定性文本检索和排序；
- L0 状态、L2 Search Disclosure、L3 Open Disclosure；
- 实例内 Disclosure Registry；
- `mnemosyne_status`、`mnemosyne_search`、`mnemosyne_open` 生产 Tool 接入；
- Observer 从 Fixture Runtime 切换为生产 Runtime；
- M0.5 Fixture 与生产包隔离；
- Schema、确定性、安全、生命周期、真实 DSH Tool 注册的自动测试。

### 2.2 明确不实现

- 自动注入或未经 Tool 调用的记忆披露；
- Librarian 模型调用、查询扩写模型或向量数据库；
- 自动 Episode 采集、自动提取、`remember`；
- `promote`、`forget`、`list` 管理命令；
- Retrieval/Disclosure 永久审计 Fact；
- 跨进程共享 Disclosure Registry；
- 重启后继续使用旧 Search 授权；
- Lifecycle、Health、质量评分、成败归因、自进化；
- Web UI、Reasonix、OMR 或任何非 DSH 集成。

---

## 三、现状与必须修复的问题

### 3.1 现有生产 Observer 错误使用 Fixture

当前 `src/observer.ts` 创建 `createFixtureRuntime()`，注册的 Tool 描述也明确返回“synthetic evaluation memories”。这是 M0.5 的评测资产，不是生产长期记忆。

MVP-04 必须：

- 保留既有 Fixture Runtime、Fixture 测试和历史评测结论；
- 生产 Observer 改用新的 OKF Runtime；
- 不让 Fixture Catalog、合成正文或 M0.5 Provider Runner 进入生产 Bundle/Tarball；
- 不把 M0.5 Fixture 协议假装成生产协议继续扩写。

### 3.2 MVP-03 只有校验 API，没有原子读取世界 API

`readCurrentPointer()` 会验证整个 Generation，但只返回 CURRENT Pointer。之后再单独读取 `index.json` 会形成新的读取窗口。

MVP-04 应在 Generation 模块内增加最小只读 API，例如：

```ts
interface VerifiedGenerationWorld {
  current: OKFCurrentPointer | null
  generation: OKFGenerationMetadata | null
  manifest: OKFGenerationManifest | null
  index: OKFIndex | null
}

readVerifiedCurrentWorld(projectRoot, expectedProjectScopeId)
readVerifiedGenerationWorld(projectRoot, generationId, expectedProjectScopeId)
```

要求：

- 复用 MVP-03 现有严格验证链；
- 返回深冻结或不可变快照，不暴露可变内部缓存；
- 不削弱现有 `readCurrentPointer` / `verifyPublishedGenerationWorld`；
- `readVerifiedCurrentWorld` 必须同时校验 CURRENT 与其 Generation 身份；
- `readVerifiedGenerationWorld` 不读取 CURRENT，用于 Open 固定历史世界。

---

## 四、披露层级

为统一架构 L0～L3 与路线图中的 search/open 表述，本阶段固定：

| 层级 | 载体 | 内容 |
|---|---|---|
| L0 | `mnemosyne_status` 与 Tool 描述 | 是否可用、当前 Generation、短期/长期/总数量；无正文 |
| L1 | Search Disclosure 的检索元数据 | Retrieval、Generation、结果数量 |
| L2 | Search Disclosure 的候选项 | 标题、摘要、Tier、Tags、Component、引用、分数、排名；无正文 |
| L3 | Open Disclosure | 单条 Memory 的完整正文与精确引用 |

`mnemosyne_search` 返回包含 L0/L1/L2 所需信息的 `level: 2` Envelope；`mnemosyne_open` 返回 `level: 3` Envelope。Search 永远不返回正文。

---

## 五、生产协议

### 5.1 公共规则

- `schema_version` 固定为 `1`；
- 所有对象 `additionalProperties: false`；
- Canonical JSON 固定键序、数组语义明确、SHA-256 由程序计算；
- 所有 ID、Hash、Scope 和引用严格验证；
- 原始 query 不落盘、不出现在输出和错误中，只产生指纹；
- 错误只返回稳定错误码与静态脱敏消息；
- 未知字段、非法枚举、重复引用、Hash 错配一律拒绝。

### 5.2 Generation Ref

```yaml
generation_ref:
  generation_id: generation_...
  generation_sha256: sha256_...
  manifest_id: manifest_...
  manifest_sha256: sha256_...
  index_sha256: sha256_...
```

该引用描述 Search/Open 所处的固定记忆世界。Open 不得用 CURRENT 替代它。

### 5.3 Search 输入

```yaml
query: "compiler cache rebuild"
component_hint: "build"   # 可选
top_k: 5                  # 可选，默认 5，范围 1..5
```

本阶段生产协议不提供 `operation_hint`：MVP-03 的 OKF Index 没有该字段，不能从 M0.5 Fixture 协议伪造生产能力。

输入限制：

- query trim 后非空、最大 500 字符并拒绝控制字符；
- component_hint 若存在必须满足现有 Component Slug 协议；
- 查询允许包含工程路径或命令片段，因为它们可能正是需要检索的工程记忆；系统只保留其 Hash，禁止落盘或输出原文；
- 验证失败不回显原始内容。

### 5.4 Search Disclosure v1

```yaml
schema_version: 1
disclosure_id: disclosure_...
retrieval_id: retrieval_...
project_scope_id: project_...
session_scope_id: session_...
generation_ref: { ... }  # 没有 CURRENT 的合法空结果为 null
query_fingerprint: sha256_...
component_hint: null
top_k: 5
level: 2
result_count: 1
items:
  - memory_ref:
      tier: short_term
      session_scope_id: session_...  # long_term 时为 null
      memory_id: memory_...
      content_sha256: sha256_...
      page_ref: wiki/memories/memory_....md
    title: "..."
    summary: "..."
    component: "build"
    tags: ["cache"]
    score_fixed: 17000
    rank: 1
content_sha256: sha256_...
```

约束：

- items 只能来自已验证 Index；没有 CURRENT 时 `generation_ref: null`、`items: []`、`result_count: 0`；
- `memory_ref` 必须与 Manifest 的输入 Fact 以及 Index Entry 一致；
- rank 从 1 连续递增；score 非递增；同分按 `memory_id` 码点升序；
- `result_count == len(items)`，最大 5；
- 不包含 `body`、完整 Fact、原始 Query、绝对路径、命令或思考过程；
- `retrieval_id`、`disclosure_id`、`content_sha256` 均由规范输入确定性生成。

### 5.5 Open 输入

```yaml
retrieval_id: retrieval_...
search_disclosure_sha256: sha256_...
memory_id: memory_...
```

三字段缺一不可，且必须命中当前插件实例的 Registry。

### 5.6 Open Disclosure v1

```yaml
schema_version: 1
disclosure_id: disclosure_...
retrieval_id: retrieval_...
parent_disclosure_sha256: sha256_...
project_scope_id: project_...
session_scope_id: session_...
generation_ref: { ... }
level: 3
memory_ref: { ... }
title: "..."
summary: "..."
component: "build"
tags: ["cache"]
body: "..."
content_sha256: sha256_...
```

Open 必须按 Registry 中固定的 Generation Ref：

1. 重新严格验证该历史 Generation，而不是读取 CURRENT；
2. 确认 Memory 曾出现在父 Search Disclosure 中；
3. 从 Manifest 的精确 FactRef 读取 Fact；
4. 确认 Fact、Index Entry、Page 和 MemoryRef 相互一致；
5. 返回正文；任何不一致 fail closed。

### 5.7 Status v3

MVP-04 将生产 `mnemosyne_status` 协议升级到 v3：

```yaml
plugin: dsh-Mnemosyne
version: 0.0.0-dev
protocol_version: 3
memory_enabled: true
status: ready
scope: { ...既有字段... }
memory:
  availability: ready | empty | unavailable | invalid
  generation_id: null | generation_...
  short_term_count: 0
  long_term_count: 0
  total_count: 0
  reason: null | stable_reason
```

规则：

- Scope 不可用时 `availability=unavailable`；
- 生产 Tool 中 `memory_enabled=true` 表示记忆读取能力已安装，不表示项目已经存在记忆；
- 没有 CURRENT 时 `availability=empty`；
- 当前世界严格验证通过时 `availability=ready`；
- 当前世界损坏时 `availability=invalid`，不得伪装 empty；
- `total_count = short_term_count + long_term_count`；
- v2 作为历史 M0/M0.5 契约留在测试和文档，不在生产 Tool 中继续返回；协议升级必须补迁移测试。

---

## 六、确定性检索 v1

### 6.1 候选世界

- 唯一候选世界：Search 开始时严格验证通过的 `CURRENT → Generation → index.json`；
- 不扫描 Fact 目录，不扫描 Markdown 页面，不使用 Fixture Catalog；
- 不读取 frozen/archived（v0.1 尚无 Lifecycle 字段，因此当前所有已发布 Fact 都视为可检索；不得提前伪造治理状态）；
- Candidate Universe Hash 使用已验证 `index_sha256`。

### 6.2 规范化与 Token

- Unicode NFKC；
- 小写；
- 连续空白折叠；
- 拉丁/数字按词切分；
- CJK 生成 1/2/3-gram；
- 查询和索引字段使用同一实现；
- 可复用现有 `src/retrieval/normalize.ts`，但不得让生产 Runtime 依赖 Fixture Catalog。

### 6.3 固定整数评分

```text
title exact token     × 4000
component exact token × 4000
summary exact token   × 3000
tag exact token       × 2000
title substring       × 800
summary substring     × 400
component_hint match  + 5000
```

约束：

- 只用整数，不使用浮点；
- 每个 query token 对每个字段只按最强命中计一次，禁止重复堆分；
- `score_fixed <= 0` 的候选不返回；
- 排序：score 降序 → `memory_id` 码点升序；
- top_k 在排序后截断；
- 相同输入字节、Generation 和参数必须得到相同输出字节。

如现有索引字段不足，只能按实际字段评分；不得读取正文补分。

---

## 七、Disclosure Registry 与生命周期

Registry 是插件实例内存状态，不是事实源：

```ts
interface DisclosureGrant {
  retrievalId: string
  searchDisclosureSHA256: string
  projectRoot: string
  projectScopeId: string
  sessionScopeId: string
  generationRef: OKFGenerationRef
  allowedMemoryRefs: readonly ProductionMemoryRef[]
}
```

规则：

- key 至少包含 `retrieval_id + search_disclosure_sha256`；
- Search 成功后才登记；失败时 Registry 零变化；
- Open 的执行 Scope 必须与 Grant 的 Project 和 Session 完全一致；
- 不同 Session 即使拿到相同三参数也不能 Open；
- 同一实例重复 Search 同请求返回同 Disclosure，可 NOOP 登记；
- dispose/卸载必须清空 Registry；
- 插件重启后旧 Disclosure 仍可作为上下文重放，但不再具有 Open 授权；用户需重新 Search；
- 不将原始 Query、正文或凭据写入 Registry。

---

## 八、DSH 接入

### 8.1 只使用公开能力

- `@deepseek-ai/dsh-tools` 根导出的 `defineTool` / `ToolRunContext`；
- Cordis `ctx.effect`、`ctx.tools.register`、公开 Session 事件；
- MVP-01 的 `ScopeRuntime`；
- 不使用 deep import、私有数据库、隐藏事件、猴子补丁或 DSH 源码修改。

### 8.2 Observer 切换

生产 Observer：

```text
ScopeRuntime
ProductionRetrievalRuntime
Status v3 Tool
Production Search Tool
Production Open Tool
```

dispose 顺序必须清理两个 Runtime。M0.5 Fixture Runtime 不再被 `src/index.ts → observer.ts` 的生产依赖图引用。

### 8.3 重放边界

必须保证的是：DSH 重放已经落盘的 Tool Result/Disclosure 时，模型能看到同样的规范内容。

不要求：

- 再次调用 Search 得到同一个模型选择；
- 保存 Librarian 思考链；
- 重启后用旧 Disclosure 继续授权 Open。

本阶段没有 Librarian 模型参与，Search 排序本身是确定函数。

---

## 九、安全与失败矩阵

| 场景 | Search | Open | Registry/外部状态 |
|---|---|---|---|
| Scope 不可用/冲突 | fail closed | fail closed | 零写入 |
| 无 CURRENT | 返回空 Disclosure | 不可授权 | 仅可登记空 Search 或不登记，需固定一种并测试 |
| CURRENT/Generation 损坏 | fail closed | fail closed | 零写入 |
| Query 非法/敏感 | fail closed | 不适用 | 零登记、不回显 |
| Search 无结果 | 合法空 L2 | 任意 Open 拒绝 | 不产生 Memory Grant |
| 错 Retrieval ID | 不适用 | 拒绝 | 不泄露 Registry 是否存在其他项 |
| 错 Search Hash | 不适用 | 拒绝 | 同上 |
| Memory 未出现在 Search | 不适用 | 拒绝 | 同上 |
| 跨 Project/Session | 不适用 | 拒绝 | 同上 |
| CURRENT 在 Search 后前进 | 不影响 | 读取旧 Generation | 不更新 Grant |
| 旧 Generation 被删/损坏 | 不适用 | fail closed | 不回退 CURRENT |
| dispose 后 Open | 不适用 | 拒绝 | Registry 已清空 |

实现时须明确“无 CURRENT”的选择：推荐返回合法空 Search Disclosure，`generation_ref: null`，且空 Search 不创建可 Open 的 Grant；Status 同时报告 `empty`。不得把 empty 当 error，也不得伪造 Generation。

---

## 十、实现切片

### 10.1 MVP-04A：协议与 Verified World Read API

- 先写生产协议严格 Schema/Canonical/Hash 测试；
- 增加 current/fixed Generation 完整快照读取；
- 锁定错误码、空世界语义和 v3 Status Schema；
- 不接 Observer。

### 10.2 MVP-04B：确定性 Search

- 从 verified index 构建候选；
- 实现规范化、固定评分、排序、top_k；
- 生成 L2 Disclosure；
- Search 成功登记 Grant；
- 不读取正文。

### 10.3 MVP-04C：绑定式 Open

- 校验 Grant 与当前 ToolRunContext；
- 重新验证固定历史 Generation；
- 校验精确 Fact/Page/Index 引用；
- 生成 L3 Disclosure；
- CURRENT 前进回归测试。

### 10.4 MVP-04D：生产 Tool/Observer/Package 收口

- Status v3；
- 生产 Search/Open Tool；
- Observer 移除 Fixture Runtime；
- dispose 清理；
- Bundle/Tarball Fixture 泄漏检查；
- 全量门禁和自审。

以上 A～D 是一个 MVP-04 提交，不拆成发布版本；实现中可按测试簇小步工作，但 CTO 验收后统一提交。

---

## 十一、测试矩阵

至少覆盖以下场景，不要求机械追求测试数量：

### 11.1 协议与确定性

1. Search/Open/GenerationRef 严格 round-trip；
2. 未知字段、错误枚举、错误 Hash、重复 Memory、rank 断裂拒绝；
3. 相同输入逐字节一致；
4. 改任一绑定字段改变 Hash；
5. Query 不出现在输出；
6. Search Envelope 无 `body`；
7. Open Envelope 只含一个 Memory；
8. Status v2→v3 迁移明确且严格。

### 11.2 Verified World

9. 无 CURRENT 返回 empty；
10. CURRENT 正常返回完整快照；
11. CURRENT/Generation/Manifest/Index/Page/Fact 身份和 Hash 漂移均拒绝；
12. symlink、路径穿越、权限异常拒绝；
13. fixed Generation API 不读取 CURRENT；
14. 返回值外部修改不污染后续读取。

### 11.3 Search

15. title/component/summary/tag 权重正确；
16. NFKC、大小写、空白、CJK 1/2/3-gram；
17. 同分 memory_id 决胜；
18. top_k 默认 5、范围 1..5；
19. 零分不返回；
20. component_hint 加分但不伪造过滤；
21. 短期与长期结果正确区分；
22. 同 Memory ID 在不同 Tier/Session 的身份不混淆；
23. Search 只读 Index，正文中独有词不能命中；
24. 无结果产生合法空 Disclosure；
25. 失败不登记 Grant。

### 11.4 Open 与授权

26. 正确三参数可 Open；
27. 任一参数错误拒绝；
28. 未被父 Search 返回的 Memory 拒绝；
29. 跨 Project、跨 Session 拒绝；
30. CURRENT 前进后仍打开旧 Generation；
31. 旧 Generation 损坏/缺失不回退最新；
32. Fact/Page/Index 三者任一漂移拒绝；
33. dispose 后授权失效；
34. 两个 Runtime 实例 Registry 隔离；
35. 重复 Search/Open 幂等、字节稳定；
36. 错误不泄露 Query、正文、路径、命令、凭据。

### 11.5 DSH 与打包

37. 真实 Cordis Context 注册三个生产 Tool；
38. ToolRunContext Scope 被逐调用解析；
39. session disposed 不串 Scope；
40. Observer 生产路径零 `createFixtureRuntime`；
41. Fixture 评测测试仍通过；
42. `dist/` 和 tarball 不含 Fixture 标题、正文、Catalog ID、Fake Provider、M0.5 Runner、测试 seam；
43. 仅使用公开根导出；
44. `ctx.effect` dispose 清理 Runtime。

---

## 十二、门禁

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm exec vitest run \
  tests/okf-retrieval-protocol.spec.ts \
  tests/okf-search.spec.ts \
  tests/okf-open.spec.ts \
  tests/okf-retrieval-security.spec.ts \
  tests/plugin.spec.ts
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
corepack pnpm peers check
git diff --check
```

如实际测试文件名略有调整，交付报告必须列出真实文件和测试数量。不得用管道掩盖退出码。

---

## 十三、CTO Review 清单

- [ ] 生产 Observer 完全不再使用 Fixture Runtime；
- [ ] Verified World API 没有“先验证、后未验证重读”的绕过；
- [ ] Search 只读 Index，不读正文；
- [ ] Search/Open 全部绑定 Project + Session + Generation；
- [ ] Open 固定历史 Generation，不偷换 CURRENT；
- [ ] Registry 只作为实例内授权，不成为第二事实源；
- [ ] Status v3 区分 empty/unavailable/invalid；
- [ ] 所有错误固定、脱敏、fail closed；
- [ ] Fixture 仍可用于历史评测，但生产包零泄漏；
- [ ] 未引入自动采集、自进化、向量数据库或私有 DSH API；
- [ ] 全量门禁通过，工作区改动与计划一致。

---

## 十四、给 Gemini 3.7 Flash 的执行提示词

```text
你是 dsh-Mnemosyne 的实现工程师。请在仓库：
/Users/czy/Desktop/demo/dsh-Mnemosyne
执行 MVP-04：生产检索与渐进式披露。

唯一实施规格：
docs/DSH_MNEMOSYNE_V010_MVP04_PROGRESSIVE_DISCLOSURE_PLAN.zh-CN.md

同时必须遵守：
- docs/DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md
- docs/DSH_MNEMOSYNE_VERSION_ROADMAP.zh-CN.md
- AGENTS.md（如存在）
- 当前 main 基线及既有代码风格

工作方式：
1. 先完整读取上述文档、相关源码和测试，显式列出假设、成功标准、计划修改文件。
2. 不要创建 implementation_plan.md 或仓库外临时设计文档；本文件就是唯一实施计划。
3. 严格 TDD：先写失败测试并记录修复前失败证据，再做最小实现。
4. 按 04A 协议/Verified World → 04B Search → 04C Open → 04D Tool/Observer/Package 顺序实施。
5. 只做 MVP-04，禁止自动采集、自动提取、自动注入、管理命令、自进化、向量数据库、Web UI。
6. 必须保留 M0.5 Fixture 与历史测试，但生产 Observer/Bundle/Tarball 不得包含或披露 Fixture。
7. 只用 DSH 0.1.1-rc.2 公开根导出和现有扩展机制，禁止 deep import、私有 API、修改 DSH。
8. Search 只能读取严格验证的 Generation index.json，禁止读取正文评分。
9. Open 必须绑定 retrieval_id + search_disclosure_sha256 + memory_id + Project/Session Scope + 固定历史 Generation；CURRENT 前进不得改变 Open 结果。
10. 所有错误 fail closed、稳定、脱敏；不得输出 Query、正文、绝对路径、命令、凭据或模型思考。
11. 不修改 Architecture v1；如计划与冻结架构/现有 Schema 冲突，立即停下并报告，不自行发明协议。
12. 不执行 git commit、git push、tag 或 release。

实现完成后必须先做两轮自审：

第一轮 Code Review：
- 对照本计划逐项检查协议、确定性、Generation 绑定、CURRENT 前进行为、Fixture 隔离和最小改动；
- 主动寻找 fail-open、TOCTOU、未验证重读、错误 Hash、Registry 绕过、Scope 串线、清理遗漏；
- 发现问题立即补失败测试并修复。

第二轮 Security Review：
- 检查路径穿越、symlink、权限、损坏文件、未知字段、Hash 漂移、敏感信息回显、资源上限、并发/生命周期、跨 Project/Session 授权绕过；
- 检查 dist/tarball 是否泄漏 Fixture、Fake Provider、M0.5 Runner 或测试 seam；
- 发现问题立即补失败测试并修复。

运行全部门禁：
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm exec vitest run tests/okf-retrieval-protocol.spec.ts tests/okf-search.spec.ts tests/okf-open.spec.ts tests/okf-retrieval-security.spec.ts tests/plugin.spec.ts
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
corepack pnpm peers check
git diff --check

若测试文件名不同，使用真实文件名并说明。不得跳过失败，不得把环境失败伪造成通过。

最终只输出《CTO 交接摘要》，必须包含：
1. 实际修改/新增/删除文件；
2. 修复前失败测试原始证据；
3. 最终生产协议与 Canonical/Hash 策略；
4. Verified World、Search、Open、Registry、Status v3 的实际行为；
5. CURRENT 前进、旧 Generation、Scope/Session、dispose 的测试证据；
6. Fixture 与生产 Bundle/Tarball 隔离证据；
7. Code Review 发现的问题及修复；
8. Security Review 发现的问题及修复；
9. 每条门禁的真实结果、测试文件数和测试数；
10. git status；
11. 未决问题、[ENV] 项、残余风险；
12. 明确声明未 commit、未 push、未 tag、未进入 MVP-05。
```

---

## 十五、交付边界

MVP-04 验收后，dsh-Mnemosyne 将首次具备对真实、持久化 OKF 记忆的稳定读取能力；它仍不是完整 v0.1.0：没有自动形成记忆，也没有管理入口。下一阶段 MVP-05 才实现自动采集与结构化提取。
