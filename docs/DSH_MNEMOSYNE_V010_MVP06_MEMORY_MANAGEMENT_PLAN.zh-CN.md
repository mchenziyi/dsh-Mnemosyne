# dsh-Mnemosyne v0.1.0 · MVP-06 基础记忆管理计划

> 状态：🟡 设计完成（待 Gemini 3.7 Flash 实现）
>
> 日期：2026-08-25
>
> 前置提交：`c6bfb79 feat: add automatic memory acquisition`
>
> DSH Baseline：`0.1.1-rc.2`

---

## 一、目标与边界

MVP-06 只增加三个基础管理入口：

```text
mnemosyne_list
mnemosyne_promote
mnemosyne_forget
```

闭环为：

```text
查看当前 Scope 记忆
→ 把当前 Session 的一条短期记忆沉淀为长期记忆
→ 对不再使用的记忆执行逻辑遗忘
→ 重建 OKF Generation
→ 后续 status/search/open 读取新的有效世界
```

### 1.1 显式假设

1. MVP-02 的短期/长期 Fact Schema v1 不可变；
2. MVP-03 的 Generation、Manifest、CURRENT 继续是唯一派生读取世界；
3. MVP-04 的 search/open 只读取验证后的 Generation；
4. MVP-05 Candidate Schema 和自动采集路径不变；
5. `forget` 是逻辑遗忘，不是隐私擦除或物理删除；
6. Tool 身份来自当前 `ToolRunContext` 中唯一匹配的 durable `tool/call`；
7. 所有时间判断使用匹配的 `tool/call.time`，禁止隐式墙钟；
8. v0.1.0 尚未发布，允许新增独立 Forget Fact v1，但不得改既有 Memory Fact Canonical Schema。

### 1.2 成功标准

1. list 仅显示当前 Project long-term 与当前 Project + Session short-term，绝不返回正文；
2. 同一来源 promote 第一次 `created`，重放或并发为 `noop`；
3. Promotion 保留 exact `source_short_term_refs`，不修改或删除来源；
4. 新 Generation 只索引长期版本，不重复披露已沉淀的短期版本；
5. forget 写不可变 tombstone，不删除或覆盖目标 Fact；
6. forget 成功后，新 Generation、status、search 不再暴露目标；
7. Fact 已发布但编译失败时旧 CURRENT 保持，重试可收敛；
8. Project、Session、过期、晋升、遗忘状态严格隔离；
9. dispose 后撤销 Tool、Grant 和内存状态；
10. 全量测试、构建、打包、安全与依赖门禁通过。

### 1.3 不做

- 自动 promote、质量评分、成功失败归因；
- edit、merge、unforget、restore；
- 多条短期记忆合并或模型改写；
- 物理删除 Fact、Forget Fact、Generation 或页面；
- 管理其他 Session 的短期记忆；
- Web UI、CLI、向量数据库、自动注入；
- 插件自修改、自生成插件或任何自进化；
- v0.2.0 去重治理；
- v0.1.0 Tag/Release 和真实项目联调（属于 MVP-07）。

---

## 二、事实与派生状态

```text
ShortTermMemoryFact    规范事实、不可变
LongTermMemoryFact     规范事实、不可变
MemoryForgetFact       规范事实、不可变
          ↓
active/promoted/expired/forgotten
OKF / Status / List
          ↓
派生状态，可重建，不是第二事实源
```

Promotion 不新增事件 Fact。长期 Fact 的 `source_short_term_refs` 是规范 Promotion 关系。

管理状态按固定优先级派生：

```text
forgotten > promoted > expired > active
```

- `forgotten`：存在精确指向该 Fact 的有效 Forget Fact；
- `promoted`：短期 Fact 被任一有效长期 Fact 的 source ref 精确引用；
- `expired`：短期 Fact 且 `evaluation_at >= expires_at`；
- `active`：未命中以上状态。

长期 Fact 只可能是 active 或 forgotten。被遗忘的长期 Fact仍然使其来源短期 Fact保持 promoted，禁止旧短期版本复活。

---

## 三、MemoryForgetFact v1

### 3.1 Schema

```json
{
  "schema_version": 1,
  "fact_type": "memory_forget",
  "forget_id": "forget_<64 lowercase hex>",
  "project_scope_id": "sha256_...",
  "target": {
    "tier": "short_term",
    "session_scope_id": "sha256_...",
    "memory_id": "mem_...",
    "content_sha256": "sha256_..."
  },
  "content_sha256": "sha256_..."
}
```

长期目标的 `session_scope_id` 必须为 `null`。

### 3.2 硬约束

1. 顶层与 target 都拒绝未知字段；
2. schema/version/type 固定；
3. `forget_id` 固定为 `forget_ + 64hex(canonicalHash({schema_version:1, project_scope_id, target}))`；
4. short-term 必须携带合法 session Scope，long-term 必须为 null；
5. target 必须精确指向已存在并通过完整 Store 校验的 Fact；
6. content Hash 对去掉自身后的 Canonical JSON 重算；
7. 不允许 reason、用户文本、绝对路径、原始 Session ID、call ID、Prompt、命令或 Credential；
8. 不记录墙钟。它表达集合成员关系“该精确 Fact 被逻辑遗忘”，而不是时间事件；
9. 同一目标永远得到同一 Forget Fact，并发或重放必须一个 created、其余 noop。

### 3.3 布局与安全

```text
<project-root>/.dsh-mnemosyne/facts/forget/<forget-id>.json
```

复用 MVP-02：0700/0600、逐组件 symlink/穿越/类型/权限防护、64 KiB、严格 UTF-8/JSON/Canonical、temp+fsync+link no-overwrite+read-back、稳定脱敏错误。

Forget Fact 是独立管理事实，不加入既有 `MemoryFact` 联合，不改变 short/long golden bytes。

---

## 四、Promotion

### 4.1 Tool 输入

```json
{"memory_id":"mem_..."}
```

只能解析当前 Project + Session 的短期 Fact。禁止指定 Scope、路径、Hash，禁止晋升 long-term，禁止覆盖内容。单个过期短期 Fact仍可晋升。

### 4.2 确定性映射

长期 ID：

```text
mem_promoted_ + first32hex(canonicalHash({schema_version:1, source_short_term_ref}))
```

字段固定：

```text
title       = source.title
summary     = source.summary
body        = source.body
tags        = source.tags
created_at  = source.created_at
source_short_term_refs = [exact source ref]
```

exact source ref 包含 project_scope_id、session_scope_id、memory_id、content_sha256。禁止用调用时间作为长期 created_at，否则同源重放会冲突。

### 4.3 效果与失败

```text
验证 short Fact
→ 构造确定性 long Fact
→ putLongTerm
→ compile
→ 返回 created/noop + refs + generation_id
```

- 来源短期 Fact 永久保留；
- 新 Generation 排除被任一有效 long source ref 引用的 short，加入 long；
- source ref 不存在、跨 Scope、Hash 不匹配时 Compiler fail closed；
- 同源重放仍执行 compile，以修复“Fact 已写入、CURRENT 未更新”；
- Fact 写失败时 CURRENT 不变；
- compile 失败时 long Fact 保留、CURRENT 保持旧值、Tool 返回稳定错误；
- 重试为 long NOOP + compile 收敛。

---

## 五、Forget

### 5.1 Tool 输入

```json
{"tier":"short_term|long_term","memory_id":"mem_..."}
```

short 只在当前 Project + Session 解析；long 只在当前 Project 解析。Runtime 先读取目标，再由程序生成 exact target ref。

### 5.2 流程与输出

```text
验证目标
→ 构造确定性 Forget Fact
→ putForget
→ compile
→ compile 成功后 clear Retrieval Grants
→ 返回结果
```

输出固定包含 status、forget_id、target exact ref、generation_id，不含正文和 reason。

### 5.3 逻辑遗忘边界

1. 不删除目标 Fact、Forget Fact和历史 Generation；
2. 新 Generation 不生成目标页面/索引；
3. 新 status/search 不再看到目标；
4. compile 成功后清空当前插件实例全部 Search→Open Grants；
5. 历史 Generation 只保留文件审计价值，正常 Tool 不提供任意历史打开入口；
6. 不宣称磁盘字节被安全擦除。

### 5.4 失败矩阵

| 失败点 | Forget Fact | CURRENT | Grants | 结果 |
|---|---|---|---|---|
| 目标验证失败 | 无 | 不变 | 不变 | error |
| Forget 写失败 | 无 | 不变 | 不变 | error |
| Forget 已写、compile 失败 | 保留 | 旧值 | 不变 | error，可重试 |
| compile 成功 | 保留 | 新值 | 清空 | created/noop |

compile 失败时不得谎称遗忘完整生效；旧 CURRENT 暂时仍是可见世界。

---

## 六、List 管理视图

### 6.1 参数

```json
{"tier":"all|short_term|long_term","include_inactive":false,"limit":50}
```

默认 all/false/50；limit 范围 1..100；拒绝未知字段。

### 6.2 读取与输出

- short：当前 Session，读取时包含过期 Fact以派生状态；
- long/forget：当前 Project；
- 不读其他 Session short；
- 不以 CURRENT 代替规范事实；
- evaluation_at 使用匹配 list tool/call.time，禁止墙钟；
- 输出包含 Scope、evaluation_at、参数、total_count、truncated、items、content_sha256；
- item 只含 tier、session_scope_id、memory_id、title、summary、tags、created_at、expires_at、state、content_sha256；
- 永不返回 body、路径、Forget JSON 或 Tool 身份；
- include_inactive=false 只返回 active；true 允许 promoted/expired/forgotten；
- 排序：created_at 降序，再 tier code point，再 memory_id code point；
- total_count 是 tier/state 过滤后、limit 前数量；
- 输出 Hash 对去掉自身后的 Canonical JSON 计算；
- 相同事实集、evaluation_at 和参数产生逐字节相同输出。

---

## 七、Tool 绑定与装配

三个 Tool 都必须：

1. `scopeRuntime.resolveExecution(exec)`；
2. 在完整 Session events 中查找 callId 与 Tool name 都精确匹配的唯一 `tool/call`；
3. 拒绝缺失、重复、同 callId 异名、非法 seq/time；
4. 使用事件 time 作为 list/compile evaluation_at。

允许提取一个最小 `resolveBoundToolCall(exec, expectedToolName)` helper。不得建立框架或可配置绑定策略。remember 若迁移到 helper，必须用回归测试锁定行为不变。

observer 创建一个 Management Runtime，注册三个 Tool；forget 成功回调现有 retrieval runtime `clear()`；dispose 清空所有管理内存状态。

---

## 八、Store 与 Compiler

### 8.1 Store 最小扩展

```text
putForget
getForget
listForget
```

不得重写 Store。新路径必须复用现有原子写入和安全读取内核。

### 8.2 Compiler 选择算法

读取所有有效 Memory Fact、所有 Forget Fact，并为验证 Promotion 来源读取包含过期项的 short Fact：

```text
验证 Forget target
→ 验证 long source refs
→ 标记 forgotten
→ 标记 promoted short
→ 排除 forgotten/promoted/expired
→ 对剩余 Memory Fact运行既有唯一 ID、Manifest、渲染和 CURRENT 流程
```

Forget 和被排除 Fact 是选择控制事实，不加入既有 `OKFInputFactRef`；Manifest 继续记录实际参与渲染的 Memory Fact。这与 expired Fact 的既有选择语义一致，避免修改 Manifest Schema 和 Compiler Version。

禁止忽略损坏、孤儿、跨 Scope 或 Hash 错配的 Forget/source ref；禁止为 Forget 生成页面；禁止在索引披露 forget_id。

---

## 九、并发与幂等

必须覆盖：

1. 同一 short 两个 promote：一个 long，created+noop；
2. 同一目标两个 forget：一个 tombstone，created+noop；
3. promote + 自动采集：Fact 不丢，新 CURRENT 收敛；
4. forget + search/open：forget 成功后旧 Grant失效；
5. forget + promote 同一 short：任一顺序最终由完整事实集确定性收敛；
6. 两个 Project/Session 不串数据；
7. 进程重启后同请求仍 NOOP，不依赖缓存；
8. 异常不得删除任何已发布事实。

不要求 v0.1.0 优化不同 Project 的并行性能，只要求正确和隔离。

---

## 十、安全要求

- Tool 参数 `additionalProperties:false`；
- ID/Hash/Scope/tier/time 严格校验；
- 错误不回显 ID、路径、正文、callId 或输入；
- list 无 body，promote/forget 输出无正文；
- 跨 Project/Session fail closed；
- symlink、权限、损坏、未知字段、Hash 漂移 fail closed；
- Bundle 不导出 Store、Manager、test hooks、Fixture；
- 不联网、不调用模型、不读取 Key；
- 不接收自由 forget reason；
- 产品描述使用“从活跃视图排除”，不使用“安全擦除”。

---

## 十一、TDD 矩阵

### 11.1 Forget Schema/Store

- short/long round-trip；exact keys；tier/session 矩阵；
- forget_id/hash 重算；target ID/Hash/Scope；
- 敏感自由字段拒绝；created/noop/conflict；重启；
- symlink/权限/穿越/超大/损坏/非规范；
- 多进程同目标并发；错误脱敏；
- 既有 short/long golden bytes 零变化。

### 11.2 List

- 空 Store；当前 Session short + Project long；
- 其他 Session/Project 零泄漏；
- active/promoted/expired/forgotten 优先级；
- include_inactive、tier、limit、unknown fields；
- 无 body；排序、total_count、truncated、Hash；
- 显式 tool/call.time；重复 bytes 一致；损坏 fail closed。

### 11.3 Promote

- active/expired short；同源重放；并发；
- exact source ref、确定性 ID/字段；
- 其他 Session/Project/long/missing/corrupt 拒绝；
- 不可 override；来源磁盘字节不变；
- 新 Generation 仅 long；status 正确；
- compile 失败旧 CURRENT、Fact 保留、重试收敛。

### 11.4 Forget

- short/long；重放；并发；Scope/missing/corrupt；
- 目标磁盘字节不变且 Store 仍可 get；
- list inactive 可见；新 Generation/search/status 排除；
- 成功撤销旧 Grant；失败保持旧 CURRENT/Grant；
- 被忘 long 的 source short 不复活；历史 Generation 不删除。

### 11.5 生命周期与打包

- promote+acquisition、forget+search、forget+promote；
- 插件禁用不注册；dispose 撤销；注册次数；
- 内部 seam/类型不进入 JS/DTS/Tarball。

---

## 十二、门禁

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm exec vitest run tests/memory-management-protocol.spec.ts tests/memory-management-runtime.spec.ts tests/memory-management-security.spec.ts tests/memory-management-concurrency.spec.ts tests/plugin.spec.ts tests/lifecycle.spec.ts
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
corepack pnpm peers check
git diff --check
```

提交前必须先暂存预期文件并额外运行：

```bash
git diff --cached --check
```

普通 `git diff --check` 不检查未跟踪文件，本项用于防止新文件 EOF 空行漏检。

---

## 十三、实施顺序

```text
06A Forget Fact + Store
→ 06B Management Runtime + list
→ 06C promote + Compiler
→ 06D forget + Compiler/Grant
→ 06E Tool 装配、并发、安全、打包
```

五项属于一个 MVP-06，只生成一个实现提交，不创建 Tag。

---

## 十四、给 Gemini 3.7 Flash 的提示词

```text
你正在 /Users/czy/Desktop/demo/dsh-Mnemosyne 执行 v0.1.0 内部任务 MVP-06：promote/forget/list 基础记忆管理。

必须完整阅读：
- docs/DSH_MNEMOSYNE_V010_MVP06_MEMORY_MANAGEMENT_PLAN.zh-CN.md
- docs/DSH_MNEMOSYNE_VERSION_ROADMAP.zh-CN.md 的 v0.1.0 章节
- MVP-02、MVP-03、MVP-04、MVP-05 计划文档
- AGENTS.md

先输出假设、成功标准和修改文件计划，再按 06A→06E TDD 实现。每项先写失败测试并保留真实失败证据，再做最小代码。只改 MVP-06 必需文件，不重构邻近模块，不造框架。

不可协商：
1. list 无 body；
2. promote 只能当前 Session short，逐字段复制，created_at 使用来源时间；
3. promoted ID 由 exact source ref 确定；
4. Promotion 不删来源，新 Generation 排除 promoted short；
5. forget 写不可变 MemoryForgetFact，不物理删除；
6. Forget Fact 无 reason/墙钟，同 target 同 forget_id；
7. forget 成功编译后 clear Retrieval Grants；
8. 被忘 long 的 source short 不复活；
9. tool/call 唯一精确绑定，时间只来自事件；
10. Fact 后 compile 失败保持旧 CURRENT，重试收敛；
11. 不改 short/long Canonical、Manifest Schema、Compiler Version；
12. 不调用模型、不联网、不做自动晋升/自进化。

完成代码后必须自行进行一轮 Code Review 和一轮 Security Review；发现问题先修复，再重新运行文档第十二章全部门禁。不要提交、推送、打 Tag 或进入 MVP-07。

最终只输出《CTO 交接摘要》，必须包含：
- 修改文件与 06A～06E 状态；
- Forget Schema/Canonical/路径；
- 状态优先级；
- promote ID/映射/幂等；
- forget 边界/Grant/失败矩阵；
- list Scope/无正文/排序/Hash；
- 并发真实执行证明；
- 修复前失败证据；
- Code/Security Review 发现与修复；
- 精确测试数和每项门禁原始结果；
- package 零泄漏；
- git status；
- 未 commit/push/tag、未进入 MVP-07。
```

---

## 十五、CTO 签收清单

- [ ] 只增加 list/promote/forget；
- [ ] Forget Fact 不可变；short/long golden 不变；
- [ ] list 无 body、无跨 Scope；
- [ ] promote 同源确定性，保留 exact source ref；
- [ ] promoted short 不与 long 重复进入 Generation；
- [ ] forget 不物理删除，目标不进入新 Generation；
- [ ] 被忘 long 的来源 short 不复活；
- [ ] compile 失败旧 CURRENT 不变且可重试；
- [ ] forget 成功清空 Grant；
- [ ] durable call 绑定严格，无墙钟/模型/网络；
- [ ] 并发测试不是单入口假阳性；
- [ ] staged diff、全量门禁和生产包检查通过。

MVP-06 签收后只进入 MVP-07 临时项目真实闭环与 v0.1.0 发布验收，不再增加产品功能。
