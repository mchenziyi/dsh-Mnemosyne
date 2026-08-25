# dsh-Mnemosyne v0.1.0 · MVP-03 OKF Compiler、Manifest、Generation 与 CURRENT 计划

> 状态：✅ 已实现、自审并通过 CTO Review（2026-08-25）
> 日期：2026-08-25
> DSH 基线：`0.1.1-rc.2`
> 前置任务：MVP-02 已通过，Commit `5c243bb`

## 一、目标

MVP-03 建立从不可变 Memory Fact 到可重建 OKF 派生视图的最小闭环：

```text
MVP-02 Fact Store
→ 固定输入快照
→ 永久 Input Manifest
→ 确定性 OKF 编译
→ 不可变 Generation
→ 原子切换 CURRENT
```

完成后，同一项目的短期与长期 Fact 可以被编译为稳定的 Markdown 页面和 JSON 索引；相同输入、相同编译器版本和相同显式评估时间必须得到逐字节相同的输出。

MVP-03 不提供用户可调用的检索或管理能力。`search/open` 渐进式披露属于 MVP-04，自动采集与结构化提取属于 MVP-05。

## 二、显式假设与成功标准

### 2.1 假设

1. 项目只使用 MVP-01 的真实 Project Root 与 `computeProjectScopeId`；禁止 `process.cwd()`。
2. 输入只来自 MVP-02 `MemoryFactStore` 严格读取成功的 Fact；编译器不得直接信任磁盘 JSON。
3. MVP-03 只有 Project Scope，不实现跨项目或 Global Generation。
4. 编译使用调用方显式传入的 `evaluation_at`，不得读取墙钟决定 Fact 是否过期。
5. `memory_id` 在一个 Generation 内全局唯一；短期和长期 Fact 使用相同 ID 时编译失败，不猜测覆盖关系。
6. MVP-02 Fact Schema 不增加 `component` 字段。长期记忆的组件页由保守的派生规则产生。
7. Generation、OKF 页面、Index 和 CURRENT 都是派生数据，不得成为新的知识事实源。
8. 本阶段只使用 Node 标准库与仓库现有公开依赖，不新增 native addon、SQLite、向量数据库或 DSH 私有接口。

### 2.2 成功标准

1. 同一有效输入重复编译返回同一 `generation_id`，文件字节完全一致；
2. 输入 Fact、显式时间或编译器版本任一变化都会形成不同 Generation Identity；
3. 永久 Manifest 精确记录实际输入 Fact Ref 和输出文件 Hash；
4. CURRENT 原子替换前的任何失败都保持旧 CURRENT 不变；替换后的目录 fsync 失败必须 fail loud，并可通过严格重读确认新值；
5. CURRENT 永远只指向已完整验证的 Generation；
6. Generation 可仅依靠永久 Manifest、规范 Fact 和 Manifest 指定的已注册编译器版本重建；
7. 路径、权限、symlink、Hash 漂移、未知文件和损坏 Generation 全部 fail closed；
8. 并发编译不会产生半成品 CURRENT，失败后可安全重试；
9. 不注册 Tool、不监听任务事件、不调用模型、不读取真实用户项目；
10. 全量测试、构建、打包和内部符号扫描通过。

## 三、范围边界

### 3.1 本阶段实现

- 安全枚举短期 Session Scope；
- 构建有效 Fact 输入快照；
- OKF Input Manifest v1；
- OKF Index v1；
- Generation Metadata v1；
- CURRENT Pointer v1；
- 固定 Markdown 渲染器；
- 确定性 Output Hash；
- Generation staging、发布、校验和重放；
- 项目级 Compiler Lock；
- CURRENT 原子替换；
- 内部编译 API 与测试。

### 3.2 明确不实现

- `mnemosyne_search` / `mnemosyne_open` 接入真实 Fact；
- `remember/list/promote/forget`；
- 自动采集、Episode、模型提取；
- Librarian、查询改写、BM25 或向量检索；
- 自动上下文注入；
- Lifecycle、Health、Freeze、Usage、Outcome；
- Doctor 自动修复、Generation 清理或物理归档；
- Global Scope、跨项目共享；
- Web 页面、Desktop IPC、自进化；
- Git Tag 或 Release。

## 四、物理布局

```text
<project-root>/.dsh-mnemosyne/
├── facts/                                  # MVP-02 规范事实
├── manifests/
│   └── <manifest-id>.json                 # 永久、不可变
├── generations/
│   └── <generation-id>/                   # 不可变派生快照
│       ├── wiki/
│       │   ├── ROOT.md
│       │   ├── short-term/<session-id>.md
│       │   ├── components/<component>.md
│       │   └── memories/<memory-id>.md
│       ├── index.json
│       ├── manifest.json                  # 永久 Manifest 的派生副本
│       └── generation.json
├── locks/
│   └── compiler.lock                      # 运行时单写锁
├── tmp/
│   └── compile-<token>/                   # staging；不参与读取
└── CURRENT                                # 唯一生效点，普通 0600 JSON 文件
```

规则：

1. 新目录 `0700`，新文件 `0600`；
2. 逐组件拒绝 symlink、非目录、权限过宽和越界；
3. `manifests/` 永久保留；Generation 将来可清理，但本阶段不实现清理；
4. `tmp/` 和未被 CURRENT 引用的 Generation 不可被读取路径当成当前世界；
5. `CURRENT` 不使用 symlink；
6. Generation 内只允许协议声明的文件集合，额外文件或目录使校验失败。

## 五、编译输入

### 5.1 内部请求

```ts
interface CompileOKFRequest {
  project_root: string
  project_scope_id: string
  evaluation_at: string
  compiler_version: 'dsh-mnemosyne-okf/1'
}
```

约束：

- `project_root` 必须通过 MVP-01/MVP-02 的真实路径校验；
- `project_scope_id` 必须等于 `computeProjectScopeId(realRoot)`；
- `evaluation_at` 必须为毫秒精度 UTC RFC3339；
- `compiler_version` 第一版只接受固定值；
- 不允许调用方传入 Fact、输出路径、Generation ID 或 CURRENT 内容。

### 5.2 Fact 快照

编译器通过 `MemoryFactStore`：

1. 安全枚举全部短期 Session Scope；
2. 对每个 Session 调用 `listShortTerm(session, evaluation_at)`，排除到期 Fact；
3. 调用 `listLongTerm()`；
4. 合并后按 `tier → session_scope_id|null → memory_id → content_sha256` 排序；
5. 拒绝重复引用、重复 `memory_id`、Scope 不一致或读取期间发现的任何损坏；
6. 生成输入 Ref，不把正文复制进 Manifest。

为支持步骤 1，可给内部 `MemoryFactStore` 增加：

```ts
listShortTermSessionScopes(): Promise<string[]>
```

该方法必须安全读取 `facts/short-term/`：目录不存在返回 `[]`；仅接受合法 Scope ID 且权限为 `0700` 的真实目录；未知文件、symlink、非法目录名或权限过宽均 fail closed；按 code point 排序。

### 5.3 组件派生

不修改 MVP-02 Fact Schema。组件只用于长期记忆 Local Index：

```text
tags 中恰好一个 component-<slug> → component=<slug>
没有 component-*                 → component=general
多于一个 component-*             → 编译失败
```

`slug` 必须满足 `^[a-z0-9][a-z0-9_-]{0,23}$`。组件只是派生分组，不进入 Fact Hash，不反向修改 Fact。短期记忆只进入对应 Session 页面，不进入组件页。

## 六、冻结 Schema

所有 JSON 使用现有 Canonical JSON 与 `sha256_<64 lowercase hex>`。严格拒绝未知字段。

### 6.1 Input Fact Ref v1

```ts
interface OKFInputFactRef {
  tier: 'short_term' | 'long_term'
  session_scope_id: string | null
  memory_id: string
  content_sha256: string
}
```

- short-term 的 `session_scope_id` 必须非空且与 Fact 一致；
- long-term 的 `session_scope_id` 必须为 `null`；
- Ref 必须能从 Store 精确读取到同 Hash Fact。

### 6.2 Output File Ref v1

```ts
interface OKFOutputFileRef {
  relative_path: string
  byte_length: number
  content_sha256: string
}
```

`relative_path` 只允许：

```text
wiki/ROOT.md
wiki/short-term/<scope-id>.md
wiki/components/<slug>.md
wiki/memories/<memory-id>.md
index.json
```

禁止绝对路径、`..`、反斜杠、NUL、空段和非协议文件。

### 6.3 OKF Input Manifest v1

```ts
interface OKFInputManifest {
  schema_version: 1
  manifest_id: string
  generation_id: string
  project_scope_id: string
  compiler_version: 'dsh-mnemosyne-okf/1'
  canonicalization_version: 1
  evaluation_at: string
  inputs: OKFInputFactRef[]
  outputs: OKFOutputFileRef[]
  compiled_output_sha256: string
  content_sha256: string
}
```

身份计算分三步，避免循环 Hash：

1. `input_set_sha256 = canonicalHash({project_scope_id, compiler_version, canonicalization_version, evaluation_at, inputs})`；
2. `generation_id = "gen_" + input_set_sha256.slice("sha256_".length)`；
3. 输出完成后，根据排序后的 `outputs` 计算 `compiled_output_sha256`，再计算完整 Manifest 的 `content_sha256`；`manifest_id = "manifest_" + generation_id.slice("gen_".length)`。

相同请求与输入必须得到相同 ID；不得使用 UUID、墙钟或目录遍历顺序。

### 6.4 OKF Index v1

```ts
interface OKFIndexEntry {
  memory_id: string
  tier: 'short_term' | 'long_term'
  session_scope_id: string | null
  component: string | null
  title: string
  summary: string
  tags: string[]
  created_at: string
  expires_at: string | null
  content_sha256: string
  page_ref: string
}

interface OKFIndex {
  schema_version: 1
  generation_id: string
  project_scope_id: string
  compiler_version: 'dsh-mnemosyne-okf/1'
  evaluation_at: string
  entries: OKFIndexEntry[]
  content_sha256: string
}
```

Index 不含 `body`。Entry 按 `memory_id` 排序；`tags` 沿用 Fact 中已规范化顺序。

### 6.5 Generation Metadata v1

```ts
interface OKFGenerationMetadata {
  schema_version: 1
  generation_id: string
  manifest_id: string
  manifest_sha256: string
  project_scope_id: string
  compiler_version: 'dsh-mnemosyne-okf/1'
  evaluation_at: string
  compiled_output_sha256: string
  status: 'complete'
  content_sha256: string
}
```

`generation.json` 是 Generation 完整标记，必须最后生成；缺失或不合法的目录永远不算已发布 Generation。

### 6.6 CURRENT Pointer v1

```ts
interface OKFCurrentPointer {
  schema_version: 1
  generation_id: string
  generation_sha256: string
  manifest_id: string
  manifest_sha256: string
  project_scope_id: string
  content_sha256: string
}
```

CURRENT 不含更新时间或调用者字段。相同 Generation 的 CURRENT 字节固定。

## 七、确定性 Markdown 协议

### 7.1 通用规则

- UTF-8，无 BOM；
- LF 换行，文件末尾恰好一个 LF；
- 标题、列表和字段顺序固定；
- 相对链接使用 `/`；
- 不包含绝对路径、构建时间、UUID、PID、Host、模型输出或隐藏思考；
- 用户文本按固定 Markdown 转义器处理；
- `summary` 与 `body` 每行使用 `> ` 引用，避免被误当成页面控制指令；
- 空文本使用 `> (empty)`；
- 页面文件名只由已验证 ID/slug 派生。

### 7.2 ROOT.md

只包含：Generation ID、评估时间、短期/长期数量、Session Index 列表、Component Index 列表和 Memory Page 数量。不包含正文。

### 7.3 Short-term Session Page

按 `memory_id` 列出有效短期 Fact 的标题、摘要、标签、到期时间和 Memory Page 相对引用；不包含 `body`。

### 7.4 Component Page

按 `memory_id` 列出该组件的长期 Fact 标题、摘要、标签和 Memory Page 相对引用；不包含 `body`。

### 7.5 Memory Page

包含固定元数据、摘要和完整 `body`。这是当前 Generation 的全文派生页，但 MVP-03 不提供 Tool 读取入口。

## 八、编译与发布事务

### 8.1 执行顺序

```text
Validate Request
→ 获取项目 compiler.lock
→ 读取并严格验证旧 CURRENT（可不存在）
→ 通过 FactStore 构建输入快照
→ 计算 Generation Identity
→ 创建唯一 staging 目录
→ 编译全部页面和 index.json
→ 生成 outputs 清单与 compiled_output_sha256
→ 生成并验证 Manifest
→ 严格读回 staging 全部文件
→ no-overwrite 发布永久 Manifest
→ 发布不可变 Generation
→ 严格验证已发布 Generation
→ 原子替换 CURRENT（唯一生效点）
→ fsync CURRENT 父目录
→ 清理 staging
→ 释放 compiler.lock
```

### 8.2 Compiler Lock

- `locks/compiler.lock` 通过 `open(..., 'wx', 0600)` 获取；
- 内容只含固定 Schema、PID 和随机 Token，不进入确定性输出；
- 正常路径和所有捕获异常均 best-effort 删除自己的 Lock；
- Lock 存在且进程仍存活时返回稳定 `memory_compile_busy`；
- Lock PID 已不存在时，必须先 `lstat`/`fstat` 验证同一 inode，再安全删除并重试一次；
- PID 复用或无法确认时宁可返回 busy，不得偷锁；
- 不支持网络文件系统或跨机器锁。

### 8.3 Manifest 发布

- 永久 Manifest 使用 MVP-02 同等级的临时文件、fsync、hard-link no-overwrite；
- 同 ID 同 Hash返回 NOOP；同 ID 不同 Hash返回 `memory_compile_identity_conflict`；
- 已有损坏 Manifest 不覆盖、不删除。

### 8.4 Generation 发布

- staging 位于同一 Store 文件系统；
- 发布前逐文件严格读回；
- final Generation 已存在时必须完整验证：同 Hash返回 NOOP，不同或损坏 fail closed；
- 发布后不得修改任何文件；
- Generation 发布成功但 CURRENT 未切换时，保留为孤儿派生快照，后续相同编译可复用；
- 不删除旧 Generation。

### 8.5 CURRENT 切换

- 只有永久 Manifest 与完整 Generation 均验证通过后才能切换；
- CURRENT 使用同目录 0600 临时文件：写入、文件 fsync、关闭、原子 rename 替换、父目录 fsync；
- CURRENT 替换是本阶段唯一允许覆盖的派生文件；
- 切换失败时旧 CURRENT 必须保持原值，或在 rename 已完成后返回 fail loud 且重试识别当前已生效；
- 当前指针的所有 Ref/Hash 必须与目标 Generation 和 Manifest 精确匹配。

## 九、读取与验证 API

内部 API：

```ts
interface OKFCompiler {
  compile(request: CompileOKFRequest): Promise<CompileOKFResult>
  readCurrent(projectRoot: string, projectScopeId: string): Promise<OKFCurrentPointer | null>
  verifyGeneration(projectRoot: string, generationId: string): Promise<OKFGenerationMetadata>
}

interface CompileOKFResult {
  status: 'created' | 'noop'
  generation_id: string
  manifest_id: string
  current: OKFCurrentPointer
}
```

要求：

- 全部输入严格验证；
- `readCurrent` 不创建目录；
- `verifyGeneration` 重算每个允许输出文件 Hash、输出清单 Hash、Manifest Hash 和 Generation Hash；
- 缺文件、多文件、symlink、权限错误、未知 JSON 字段、非 Canonical JSON 或 Markdown Hash 漂移均拒绝；
- 错误对象使用稳定代码与静态消息，不回显绝对路径、Fact 内容或攻击者输入。

建议新增错误码：

```text
memory_compile_invalid_input
memory_compile_busy
memory_compile_not_found
memory_compile_path_unsafe
memory_compile_symlink_rejected
memory_compile_insecure_permissions
memory_compile_decode_failed
memory_compile_hash_mismatch
memory_compile_noncanonical
memory_compile_identity_conflict
memory_compile_generation_incomplete
memory_compile_current_invalid
memory_compile_io_failed
```

## 十、失败保证

| 失败点 | 永久 Manifest | Generation | CURRENT |
|---|---|---|---|
| 请求/Fact 校验失败 | 无新写入 | 无新写入 | 不变 |
| staging 编译失败 | 无新写入 | 无新写入 | 不变 |
| Manifest 发布失败 | 无有效新 Manifest | 无新 Generation | 不变 |
| Generation 发布失败 | 可有孤儿 Manifest | 无完整新 Generation | 不变 |
| CURRENT 切换前失败 | 可有孤儿 Manifest | 可有孤儿完整 Generation | 不变 |
| rename 前 CURRENT 写入失败 | 已发布 | 已发布 | 旧值不变 |
| rename 后目录 fsync 失败 | 已发布 | 已发布 | 新值可能已生效；返回 fail loud，重试必须 NOOP |

任何失败：

- 不覆盖 Fact；
- 不删除旧 CURRENT 或旧 Generation；
- best-effort 清理本次 staging/temp；
- 不把 staging 或孤儿自动当成 CURRENT；
- 不回滚已完成的不可变发布；
- 错误不泄露正文、路径或敏感字段。

## 十一、测试矩阵

### 11.1 Schema 与确定性

1. 四类 JSON Schema round-trip；
2. 未知字段、缺字段、错误类型和错误枚举拒绝；
3. 非法 Ref、Hash、relative_path、ID、时间拒绝；
4. 输入 Ref 与 Output Ref 排序固定并拒绝重复；
5. 相同输入重复编译全部文件逐字节相同；
6. 目录创建顺序和原始 readdir 顺序不影响输出；
7. Fact 内容变化改变 Generation ID；
8. evaluation_at 变化改变 Generation ID；
9. compiler_version 非注册值拒绝；
10. Generation/CURRENT 不含 UUID、PID、Host、绝对路径或墙钟。

### 11.2 Fact 快照与组件

11. 无 Fact 编译合法空 Generation；
12. 多 Session 短期 Fact 与长期 Fact 全部进入正确页面；
13. 到期短期 Fact不进入输入和 Index；
14. `now == expires_at` 明确排除；
15. Session Scope 枚举稳定排序；
16. Session 目录缺失返回空；
17. Session 枚举遇到 symlink、文件、非法名或 0755 fail closed；
18. `component-x` 进入 x 页面；
19. 无组件标签进入 general；
20. 多组件标签或非法 slug 编译拒绝且零 CURRENT 修改；
21. 短期/长期重复 memory_id 拒绝；
22. 跨 Project Scope Fact/Ref 拒绝。

### 11.3 页面与 Index

23. ROOT 只含目录/计数/引用，不含 body；
24. Session Page 不含 body；
25. Component Page 不含 body；
26. Memory Page 含完整 body；
27. 用户 Markdown 控制字符按固定规则转义/引用；
28. Index 不含 body；
29. 所有相对链接只指向本 Generation 已存在页面；
30. 中文、英文、emoji 和多行文本输出稳定；
31. 所有文件 LF 且末尾恰好一个 LF。

### 11.4 发布、CURRENT 与恢复

32. 首次编译 created 并切换 CURRENT；
33. 相同请求重试 noop；
34. 新 Fact 后产生新 Generation，旧 Generation 保留；
35. 编译失败旧 CURRENT 字节与 mtime 不变；
36. Manifest 发布失败不产生 CURRENT；
37. Generation 发布失败保留旧 CURRENT；
38. CURRENT rename 前失败旧值不变；
39. CURRENT rename 后 fsync 失败返回错误，但严格读取确认新值并使重试 noop；
40. 已有损坏 Manifest/Generation/CURRENT fail closed，不覆盖；
41. 孤儿合法 Generation 不自动生效；
42. 删除 CURRENT 后可对同输入重新切换；
43. 仅删除 Generation 派生目录后，永久 Manifest 与 Fact 足够重建逐字节相同 Generation。

### 11.5 安全、锁与并发

44. 新目录 0700、新文件 0600；
45. manifests/generations/locks/tmp 任一祖先或目标 symlink 拒绝；
46. 深层 symlink 指向外部目录时外部零写入；
47. 权限过宽拒绝且不自动 chmod；
48. 未知文件、未知目录和超大 JSON/Markdown 拒绝；
49. Lock 活跃 owner 返回 busy；
50. 已死亡 PID 的 Lock 经 inode 复核后可回收；
51. 无法确认 Lock owner 时不偷锁；
52. 16 个 Promise 相同输入只形成一个 Generation，其余 noop/busy 后重试 noop；
53. 4 个真实子进程相同输入最终只有一个有效 CURRENT；
54. 异常路径释放自己的 Lock，并清理 staging/temp；
55. 所有错误消息不回显项目路径、Fact body、Session ID 或攻击者输入。

### 11.6 回归与边界

56. MVP-02 403 个测试不回归；
57. 现有 synthetic status/search/open 行为不变；
58. 新 Compiler/Schema/测试 seam 不从 package root、JS bundle 或 DTS 导出；
59. 插件加载、status、普通 Tool 调用不创建 OKF 目录；
60. 无模型调用、网络请求、真实 API Key 或真实用户数据访问。

## 十二、建议文件范围

允许新增：

```text
src/okf-schema.ts
src/okf-render.ts
src/okf-compiler.ts
src/generation-store.ts
tests/okf-schema.spec.ts
tests/okf-render.spec.ts
tests/okf-compiler.spec.ts
tests/generation-store-security.spec.ts
tests/generation-store-concurrency.spec.ts
tests/helpers/generation-worker.mjs
```

允许最小修改：

```text
src/memory-store.ts
src/memory-store-path.ts
src/memory-store-error.ts
tests/memory-store*.spec.ts
tests/pack-check.mjs
docs/DSH_MNEMOSYNE_V010_MVP03_OKF_GENERATION_PLAN.zh-CN.md
```

禁止修改：

```text
package.json
pnpm-lock.yaml
src/index.ts
src/search-tool.ts
src/open-tool.ts
src/m05*/**
fixtures/**
历史 M0/M0.5 评测文档与协议
```

如果实现必须超出范围，先停止并报告，不得自行扩展。

## 十三、门禁

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm exec vitest run \
  tests/memory-fact.spec.ts \
  tests/memory-store.spec.ts \
  tests/memory-store-security.spec.ts \
  tests/memory-store-concurrency.spec.ts \
  tests/okf-schema.spec.ts \
  tests/okf-render.spec.ts \
  tests/okf-compiler.spec.ts \
  tests/generation-store-security.spec.ts \
  tests/generation-store-concurrency.spec.ts
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
corepack pnpm peers check
git diff --check
```

## 十四、Gemini 3.7 Flash 执行提示词

```text
执行 dsh-Mnemosyne v0.1.0 MVP-03：OKF Compiler、Manifest、Generation 与 CURRENT。

仓库：
/Users/czy/Desktop/demo/dsh-Mnemosyne

你是实现执行方。Codex/Sol 是 CTO 与最终 Reviewer。

开始前完整读取：
1. docs/DSH_MNEMOSYNE_V010_MVP03_OKF_GENERATION_PLAN.zh-CN.md
2. docs/DSH_MNEMOSYNE_VERSION_ROADMAP.zh-CN.md 第 4 章
3. docs/DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md 第 3.4、5.3、5.4、6、7、9 章
4. docs/DSH_MNEMOSYNE_V010_MVP02_FACT_STORE_PLAN.zh-CN.md
5. src/memory-fact.ts
6. src/memory-store.ts
7. src/memory-store-path.ts
8. src/memory-store-error.ts
9. src/protocol/canonical.ts
10. tests/memory-*.spec.ts 与 tests/pack-check.mjs

先显式输出：
- 对任务的理解；
- 实现假设；
- 成功标准；
- 计划修改文件；
- 60 项测试矩阵到测试文件的映射。

然后严格执行：

阶段 A：Schema 与失败测试
- 先实现测试中的构造器与预期 Schema；
- 先让 okf-schema/renderer/compiler/generation 测试因产品能力缺失而失败；
- 保存修复前失败证据；
- 再写最小产品代码。

阶段 B：Fact 快照与确定性 Renderer
- 仅通过 MemoryFactStore 严格读取 Fact；
- 安全实现 listShortTermSessionScopes；
- 使用显式 evaluation_at；
- 实现 component-* / general 派生；
- 固定 Markdown 转义、排序与换行；
- Index 不得包含 body。

阶段 C：Manifest 与 Generation
- 按文档三步算法计算 Identity；
- 编译 staging；
- 逐文件读回并计算 Output Ref/Hash；
- 永久 Manifest no-overwrite；
- Generation 完整发布并严格验证；
- 不修改任何 Fact。

阶段 D：Lock 与 CURRENT
- 实现项目 compiler.lock；
- 活 owner busy；死 owner 仅在 inode 复核后回收；
- CURRENT 必须最后原子替换；
- 所有失败矩阵按文档锁定；
- post-rename fsync 失败必须 fail loud，重试识别已生效状态。

阶段 E：并发、安全与回归
- Promise 与真实 child process 测试；
- symlink、权限、路径穿越、外部零写入；
- Manifest/Generation/CURRENT 损坏与非 Canonical 字节拒绝；
- pack-check 禁止内部符号和 seam 泄露；
- 全量旧测试不得回归。

硬约束：
- 不实现 search/open 产品接入；
- 不实现自动采集、Episode、模型提取或 Tool；
- 不修改 package/lock/DSH 版本；
- 不使用 process.cwd、环境变量、deep import、DSH 私有路径、SQLite、向量数据库或 native addon；
- 不读取真实用户项目，不调用网络、Provider 或 API Key；
- 不修改 src/index.ts；
- 不 commit、不 push、不创建 Tag；
- 不把 staging、Generation、Index、Manifest 或 CURRENT 当成规范知识事实源；
- 不声称完全消除同 UID TOCTOU 或网络文件系统竞态。

实现完成后必须自行执行两轮审查：

第一轮 Code Review：
- 逐条核对本计划 60 项测试矩阵；
- 查找非确定性排序、墙钟/UUID进入输出、Hash 循环、CURRENT 提前切换；
- 查找 silent catch、错误覆盖、重试不幂等、孤儿误生效；
- 查找摘要声称了但测试没断言的行为。

第二轮 Security Review：
- 路径穿越、symlink、权限、no-overwrite、目录 fsync；
- lock owner/PID/inode 校验；
- staging/Manifest/Generation/CURRENT 的 TOCTOU；
- Markdown 内容边界与敏感信息；
- 错误脱敏与测试 seam 打包泄露。

发现 blocking 或 should-fix 必须先修复、补回归测试并重跑全部门禁；不得把问题只写进报告。

最终只输出“CTO 交接摘要”，必须包含：
1. 实际修改文件；
2. 修复前失败测试证据；
3. 四个冻结 Schema 与 Identity 算法；
4. Fact 快照、过期和 component 派生规则；
5. Markdown/Index 确定性规则；
6. Manifest、Generation、CURRENT 的事务顺序；
7. 完整失败矩阵与重试行为；
8. Lock、Promise 和多进程结果；
9. 安全边界与外部零写入证据；
10. 全部门禁原始结果与准确测试数量；
11. Code Review/Security Review 发现及实际修复；
12. [ENV] 限制；
13. git status；
14. 明确未 commit、未 push、未 Tag、未进入 MVP-04。

不得把未实际测试的行为写进摘要。
```

## 十五、完成定义

只有同时满足以下条件，MVP-03 才可签收：

1. 60 项测试矩阵均有真实自动化证据；
2. 相同输入逐字节确定性通过；
3. Manifest 永久且引用闭合；
4. CURRENT 只指向严格验证完成的 Generation；
5. 全部失败路径旧 CURRENT 不被静默破坏；
6. Promise/多进程并发测试通过；
7. 全部门禁通过；
8. Code Review 与 Security Review 无 blocking/should-fix；
9. CTO 实际检查工作区并签收；
10. 实现与设计文档同一次小提交推送，但不创建 Tag。
