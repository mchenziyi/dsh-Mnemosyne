# dsh-Mnemosyne v0.1.0 · MVP-02 短期/长期 Fact Store 与安全读写计划

> 状态：🟡 待 Gemini 实现、自审与 CTO Review  
> 日期：2026-08-24  
> DSH 基线：`0.1.1-rc.2`  
> 前置任务：MVP-01 已通过，Commit `0cc7448`

## 一、目标

MVP-02 只建立真实记忆的规范事实层：

```text
已解析的 Project/Session Scope
→ 构造严格短期/长期 Memory Fact
→ Canonical Hash
→ 安全、原子、不可覆盖地写入项目 Store
→ 按固定身份严格读取
→ 按 Scope 与显式时间确定性列出
```

本阶段完成后，只能声明：

```text
fact_store_ready = true
memory_product_ready = false
```

不得声明 OKF、检索、自动采集、人工 remember、晋升、遗忘或完整记忆产品已经可用。

## 二、范围与非目标

### 2.1 本阶段必须实现

1. 短期记忆与长期记忆两个严格、不可变 Fact Schema；
2. Canonical JSON 与 `content_sha256`；
3. Project/Session Scope 绑定与隔离；
4. 项目内安全 Store Root；
5. 原子 no-overwrite 写入；
6. 同身份同内容 `NOOP`、同身份异内容 `CONFLICT`；
7. 严格读取、确定性列表和显式过期筛选；
8. 权限、路径、symlink、损坏、超大文件与并发写 fail closed；
9. DSH 重启等价的 Store 重开持久性验证；
10. 稳定、脱敏的错误码。

### 2.2 明确不做

- 不实现 OKF、Manifest、Generation 或 `CURRENT`；
- 不实现真实 `mnemosyne_search/open`，既有 synthetic 工具保持不变；
- 不实现 `remember/list/promote/forget` Tool；
- 不监听任务完成事件，不自动采集或调用模型；
- 不实现生命周期、质量评分、去重合并或自进化；
- 不实现 Global Scope；
- 不写入 DSH 私有目录、Session Store 或数据库；
- 不使用 SQLite、向量数据库、deep import、Desktop IPC 或猴子补丁；
- 不在插件加载、status 调用或普通 Session Event 上创建 Store；
- 不把 Store 内部 API 导出到包根。

## 三、关键假设与成功标准

### 3.1 假设

1. MVP-01 已通过公开 `Session.header.cwd` 或显式 `projectRoot` 得到规范化绝对 Project Root；
2. MVP-02 在首次真实 Store 操作时才验证文件系统，不改变 MVP-01 的零写入行为；
3. Store Root 固定为 `<project-root>/.dsh-mnemosyne`，不读取 DSH 私有路径；
4. 短期记忆只在当前 Project + Session Scope 内可见；
5. 长期记忆只在当前 Project Scope 内可见；
6. 当前 Fact 均为单文件不可变对象，不需要多文件事务；并发发布可由文件系统的 no-overwrite 原子操作解决，不提前引入 Store 锁；
7. 所有时间判断由调用者显式传入，不使用 `Date.now()` 参与派生结果。

### 3.2 成功标准

1. 相同 Fact 重复写入只产生一个文件并返回 `noop`；
2. 相同身份不同内容永不覆盖原文件，返回稳定冲突；
3. 两个进程并发写相同内容只有一个 `created`，其余 `noop`；
4. 两个进程并发写不同内容只有一个 `created`，其余 `conflict`；
5. Project、Session、short/long 三个维度互不串读；
6. Store 重开后逐字节读取相同事实；
7. 短期过期筛选完全由显式 `now` 决定；
8. 路径穿越、symlink、权限过宽、损坏 JSON、未知字段、Hash 漂移和超大文件全部 fail closed；
9. 所有拒绝路径对 Store 外部目录零写入；
10. 插件公共导出、现有 Tool 和历史评测无回归。

## 四、规范事实 Schema

### 4.1 公共约束

- `schema_version` 固定为 `1`；
- `memory_id` 必须匹配 `^mem_[a-z0-9][a-z0-9._-]{0,63}$`；
- Scope ID 必须匹配 `^sha256_[0-9a-f]{64}$`；
- 时间必须严格匹配 `YYYY-MM-DDTHH:mm:ss.sssZ`，并能按 UTC 时间语义 round-trip；
- `title`：1～160 字符；
- `summary`：1～500 字符；
- `body`：1～8000 字符；
- `tags`：最多 16 个，每个为小写受控标识，拒绝重复，Canonical 时按 code point 排序；
- 禁止 NUL、Credential、私钥、Bearer Token、明显个人绝对路径和完整隐藏思考；
- 未知字段、错误类型、稀疏数组、重复标签、非法时间一律拒绝；
- `content_sha256` 由程序对去掉自身后的 Canonical JSON 重算，调用者提供的错误 Hash 必须拒绝；
- Canonical 编码不得补墙钟、随机数、默认 ID 或隐式 Scope。

### 4.2 短期记忆 Fact

```json
{
  "schema_version": 1,
  "tier": "short_term",
  "memory_id": "mem_build_cache_01",
  "project_scope_id": "sha256_...",
  "session_scope_id": "sha256_...",
  "title": "Build cache invalidation finding",
  "summary": "Cache key must include the compiler version.",
  "body": "The observed cache miss was resolved by including the compiler version in the key.",
  "tags": ["build", "cache"],
  "created_at": "2026-08-24T12:00:00.000Z",
  "expires_at": "2026-08-31T12:00:00.000Z",
  "content_sha256": "sha256_..."
}
```

附加规则：

- `expires_at` 必须严格晚于 `created_at`；
- 不保存原始 Session ID，只保存 `session_scope_id`；
- 读取单个已过期 Fact 仍允许，便于审计；
- 默认短期列表在显式 `now >= expires_at` 时排除该 Fact；
- 本阶段不自动删除过期 Fact。

### 4.3 长期记忆 Fact

```json
{
  "schema_version": 1,
  "tier": "long_term",
  "memory_id": "mem_build_cache_01",
  "project_scope_id": "sha256_...",
  "title": "Build cache key constraint",
  "summary": "Compiler version is part of the cache identity.",
  "body": "Treat compiler-version changes as cache-key changes.",
  "tags": ["build", "cache"],
  "created_at": "2026-08-24T12:00:00.000Z",
  "source_short_term_refs": [],
  "content_sha256": "sha256_..."
}
```

`source_short_term_refs` 从第一版进入 Schema，供 MVP-06 Promotion 保留来源。每项固定为：

```json
{
  "project_scope_id": "sha256_...",
  "session_scope_id": "sha256_...",
  "memory_id": "mem_build_cache_01",
  "content_sha256": "sha256_..."
}
```

规则：最多 16 项、拒绝重复；Canonical 时依次按 `project_scope_id`、`session_scope_id`、`memory_id`、`content_sha256` 做 code point 排序；本阶段允许空数组，不实现 Promotion，也不要求被引用短期 Fact 当前仍未过期。

### 4.4 兼容策略

MVP-02 是两个 Fact Schema 的 v1 起点，没有 Legacy 文档。任何字段变化必须显式升级协议或在 v0.1.0 发布前由 CTO 重新冻结；不得静默接受部分对象或猜默认值。

## 五、物理布局与 Scope 路由

固定布局：

```text
<project-root>/.dsh-mnemosyne/
├── facts/
│   ├── short-term/
│   │   └── <session-scope-id>/
│   │       └── <memory-id>.json
│   └── long-term/
│       └── <memory-id>.json
└── tmp/
```

要求：

1. 不使用原始 Session ID 作为路径组件；
2. `memory_id` 和 Scope ID 在参与路径前再次严格校验；
3. Fact 内 `project_scope_id` 必须与 Store 绑定的 Project Scope 一致；
4. short-term Fact 的 `session_scope_id` 必须与调用的 Session Scope 一致；
5. long-term Fact 不得带 Session Scope；
6. 不创建 `generations/`、`CURRENT`、`locks/` 或索引目录；
7. Store 的任何路径都必须保持在经验证的 `.dsh-mnemosyne` 根内。

## 六、安全路径与权限协议

### 6.1 打开 Project Store

输入必须包含：

```ts
interface ProjectStoreScope {
  project_root: string
  project_scope_id: string
}
```

打开规则：

1. `project_root` 必须为已规范化绝对路径；
2. `realpath(project_root)` 必须成功；项目根不存在或不是目录即拒绝；
3. 若传入路径与真实规范路径不一致，拒绝通过任意 symlink 访问项目；用户可改用真实路径重试；
4. 从真实 Project Root 向下逐组件 `lstat`；已有组件为 symlink 或非目录立即拒绝；
5. Store 构造与只读 `get/list` 不得创建目录；Store 不存在时 `get` 返回 not-found，`list` 返回空数组；
6. 只有 `put` 可以创建 `.dsh-mnemosyne` 及所需内部目录，并且必须逐级单层创建，禁止对不可信尾部使用递归创建；并发 `mkdir` 的 `EEXIST` 必须重新 `lstat` 和检查权限；
7. 新目录权限 `0700`，新文件权限 `0600`；
8. 已有 Store 目录出现 group/other 权限位时拒绝，不自动 chmod；
9. 已有 Fact 文件出现 symlink、非普通文件或 group/other 权限位时拒绝；
10. 检查失败不回显绝对路径。

MVP-02 接受一个明确限制：Node 公共文件 API 没有跨平台 `openat` 目录句柄事务；因此逐组件检查后仍存在同 UID 恶意进程替换祖先目录的 TOCTOU 理论窗口。实现必须在提交前后重复路径链检查并 fail loud，但不得声称完全抵御同 UID 主动攻击者。不得为此引入 native addon。

### 6.2 路径输入

- 禁止 `..`、`.`、斜杠、反斜杠、空字符串和 NUL 作为 ID 路径输入；
- 不接受调用者提供任意相对文件路径；
- Store API 只接受 Fact 或经过验证的结构化身份；
- 错误对象不得包含原路径、Fact 正文、Session ID、Credential 或攻击者输入。

## 七、原子写入与不可变语义

### 7.1 写入顺序

```text
Validate Fact
→ Encode Canonical Bytes
→ 重算并验证 content_sha256
→ 验证 Scope 与目标路径
→ 若目标已存在：严格读取并比较
→ 在 Store/tmp 创建 0600 独占临时文件
→ 写完整字节
→ fsync 临时文件
→ link(temp, target) 原子 no-overwrite 发布
→ fsync 目标父目录（平台允许时）
→ unlink 临时文件
→ 重新验证路径链与目标内容
```

禁止使用会覆盖已有目标的 `rename(temp, target)` 作为发布操作。

### 7.2 结果

```ts
type WriteStatus = 'created' | 'noop'

interface WriteResult {
  status: WriteStatus
  tier: 'short_term' | 'long_term'
  memory_id: string
  content_sha256: string
}
```

- 目标不存在且发布成功：`created`；
- 目标存在且严格验证后内容 Hash 相同：`noop`，零覆盖；
- 目标存在且身份相同、Hash 不同：`memory_store_identity_conflict`，零覆盖；
- 目标存在但损坏：fail closed，不覆盖、不删除；
- 并发 `EEXIST` 必须进入同一既有目标验证分支；
- 任意失败尽力清理本次临时文件；残留临时文件不得被当成 Fact。

## 八、严格读取与列表

### 8.1 单条读取

读取顺序：

1. 验证 tier、Scope ID 和 memory ID；
2. 逐组件检查路径、类型和权限；
3. `lstat` 最终目标，拒绝 symlink；
4. 以 no-follow 能力打开普通文件；平台不支持时必须在打开前后复核 inode/类型，不得静默声称 no-follow；
5. 读取前检查文件大小，默认上限 64 KiB；
6. UTF-8 严格 JSON 解析；
7. 严格键集合与类型校验；
8. 重算 Hash；
9. 重新 Canonical 编码并与落盘字节逐字节比较；
10. 校验 Fact Scope 与请求 Scope；
11. 返回冻结或深拷贝对象，不暴露内部可变缓存。

### 8.2 列表

建议最小内部接口：

```ts
interface MemoryFactStore {
  putShortTerm(fact: ShortTermMemoryFact): Promise<WriteResult>
  getShortTerm(sessionScopeId: string, memoryId: string): Promise<ShortTermMemoryFact>
  listShortTerm(sessionScopeId: string, now: string, options?: { includeExpired?: boolean }): Promise<ShortTermMemoryFact[]>
  putLongTerm(fact: LongTermMemoryFact): Promise<WriteResult>
  getLongTerm(memoryId: string): Promise<LongTermMemoryFact>
  listLongTerm(): Promise<LongTermMemoryFact[]>
}
```

列表规则：

- 不存在的 tier/session 目录返回空数组；
- 只接受严格 `<memory-id>.json`，遇到未知文件、目录、symlink 或损坏 Fact 必须 fail closed，不跳过；
- 返回按 `memory_id` code point 稳定排序；
- `listShortTerm` 的 `now` 必填且严格解析；零值、非法值不得回退墙钟；
- 默认排除 `now >= expires_at` 的 Fact；`includeExpired=true` 只影响列表，不修改事实；
- 列表不得扫描别的 Project 或 Session Scope。

## 九、错误协议

内部稳定错误码至少包含：

```text
memory_store_invalid_input
memory_store_scope_mismatch
memory_store_path_unsafe
memory_store_symlink_rejected
memory_store_insecure_permissions
memory_store_not_found
memory_store_file_too_large
memory_store_decode_failed
memory_store_hash_mismatch
memory_store_noncanonical
memory_store_identity_conflict
memory_store_io_failed
```

统一错误类型只暴露稳定 `code` 和静态消息；底层 Node Error 作为内部 cause 可保留，但不得进入 Tool/模型文本。测试必须放入伪 Credential、绝对路径、命令和恶意 ID，确认错误字符串不回显。

## 十、并发模型

MVP-02 不引入跨进程锁，因为每个 Fact 只有一个不可变目标文件：

- 临时文件以随机、独占 `wx` 创建；
- `link(temp, target)` 在同文件系统内提供 no-overwrite 原子赢家；
- 相同内容失败方读取赢家并返回 `noop`；
- 不同内容失败方读取赢家并返回 `identity_conflict`；
- 多进程测试必须使用真实 Node 子进程，不能只用 Promise 并发；
- MVP-03 的 Manifest/Generation/CURRENT 多文件事务再单独设计 Scope 写锁。

## 十一、TDD 测试矩阵

必须先写失败测试并保存代表性失败证据。

### 11.1 Schema 与 Canonical

1. short-term 合法对象 round-trip；
2. long-term 合法对象 round-trip；
3. 重复编码字节与 Hash 一致；
4. tags/source refs 乱序输入产生稳定 Canonical 顺序；
5. 未知字段、错误 tier、缺字段、部分对象拒绝；
6. 错误 Hash 拒绝；
7. 非法/重复 ID、Scope、tags、source refs 拒绝；
8. short-term expires_at 不晚于 created_at 拒绝；
9. Credential、私钥、个人绝对路径与超长正文拒绝且脱敏；
10. Canonical JSON 末尾换行、不同键序或非规范时间落盘后读取拒绝。

### 11.2 Store 与 Scope

11. short/long Put/Get/List；
12. 同 Fact 二次 Put → noop，文件 mtime/bytes 不变；
13. 同身份异内容 → conflict，原文件 bytes 不变；
14. Project Scope 不匹配拒绝；
15. Session Scope 不匹配拒绝；
16. 两个 Project Store 隔离；
17. 同 Project 两个 Session 隔离；
18. short 与 long 同 memory_id 不冲突；
19. Store 重开后读取逐字节一致；
20. 返回对象被调用者修改不影响后续读取。
20a. Store 不存在时 get/list 零文件系统写入，get 为 not-found、list 为空；

### 11.3 过期与确定性

21. now < expires_at 时出现在默认列表；
22. now == expires_at 与 now > expires_at 时默认排除；
23. includeExpired=true 返回过期事实；
24. 非法/缺失 now 拒绝；
25. 改变系统墙钟不影响相同显式 now 的结果；
26. 列表按 memory_id 稳定排序。

### 11.4 文件安全

27. 新目录 0700、新 Fact 0600；
28. 已有 Store/tier/session 目录权限过宽拒绝且不自动 chmod；
29. 已有 Fact 权限过宽拒绝；
30. Project Root 本身或 Store 任一祖先/目标 symlink 拒绝；
31. 深层 symlink 指向外部目录时外部零写入；
32. 非目录组件拒绝；
33. memory_id/path traversal/NUL/分隔符拒绝；
34. 损坏 JSON、截断、未知字段、Hash 漂移拒绝且不覆盖；
35. 超过 64 KiB 拒绝；
36. 未知目录项或 symlink 混入列表时 fail closed；
37. 发布失败不留下可见 Fact；
38. 临时文件不进入列表。

### 11.5 并发与回归

39. 16 个 Promise 同内容并发：1 created + 15 noop；
40. 16 个 Promise 异内容并发：1 created + 15 conflict；
41. 多进程同内容并发：恰好 1 created，其余 noop；
42. 多进程异内容并发：恰好 1 created，其余 conflict；
43. 现有 `mnemosyne_status/search/open` 行为不回归；
44. 插件加载、Session Event 和 status 仍零 Store 写入；
45. build/pack 不导出 Store 内部 API、不打包测试 Fact；
46. 全部 M0/M0.5/MVP-00/MVP-01 测试保持通过。

## 十二、建议文件边界

允许新增/修改：

```text
src/memory-fact.ts
src/memory-store.ts
src/memory-store-path.ts
src/memory-store-error.ts
tests/memory-fact.spec.ts
tests/memory-store.spec.ts
tests/memory-store-security.spec.ts
tests/memory-store-concurrency.spec.ts
tests/pack-check.mjs
docs/DSH_MNEMOSYNE_V010_MVP02_FACT_STORE_PLAN.zh-CN.md
```

如确需子进程 helper，放在 `tests/helpers/`，不得进入发布包。

原则上不得修改 `src/index.ts`、`src/observer.ts`、`src/status.ts`、`src/runtime-scope.ts`；若测试证明内部 Store 与 Scope 连接必须做最小类型适配，先在交付报告中单列原因，不得注册新 Tool 或产生加载时写入。

禁止修改：

- `src/m05*/**`；
- Fixture 与历史评测结果；
- `package.json`、`pnpm-lock.yaml`、DSH 版本；
- Architecture/Roadmap 的既有决议；
- README、Tag、Release。

## 十三、实现顺序

```text
MVP-02A  Schema + Canonical + Error
→ MVP-02B  安全路径 + 权限
→ MVP-02C  原子 Put/Get/List
→ MVP-02D  并发/重启/回归与安全审查
```

这是一个 MVP-02 提交，不拆成多个发布版本。Gemini 可在同一工作区按以上顺序实现，但每段必须先写失败测试。

## 十四、自动门禁

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
corepack pnpm peers check
git diff --check
```

额外扫描：

```bash
rg -n 'process\.cwd\(\)|process\.env|electron|ipcRenderer|ipcMain|better-sqlite3|sqlite3' src/memory-*.ts
rg -n '@deepseek-ai/dsh-[a-z-]+/' src/memory-*.ts
rg -n 'Date\.now\(\)|new Date\(\)' src/memory-*.ts
rg -n 'memoryStore|MemoryFactStore|putShortTerm|putLongTerm' dist/index.d.mts
git status --short
```

任何 `Date.now()`/零参数 `new Date()` 命中必须解释；派生过期判断路径零容忍。发布 DTS 中 Store 内部 API 必须零命中。

## 十五、Gemini 自审与 CTO 交接

实现完成后，Gemini 必须先自行执行 Code Review 和 Security Review：

1. 对照 47 项测试矩阵逐条核对；
2. 检查是否存在覆盖已有 Fact 的路径；
3. 检查 symlink/权限/路径链与外部零写入；
4. 检查 Canonical、Hash 和 Scope 是否存在第二事实源；
5. 检查列表是否跳过损坏文件而 fail open；
6. 检查错误是否泄露正文、绝对路径、Session ID 或 Credential；
7. 检查是否误用墙钟；
8. 检查是否提前实现 MVP-03+；
9. 检查包根与 tarball 是否泄漏 Store 内部 API或测试数据；
10. 有 should-fix 必须先修复并重跑全部门禁。

最终只输出“CTO 交接摘要”，固定包含：

1. 实际修改文件；
2. 执行过的关键操作；
3. 修复前失败证据；
4. 两个 Fact Schema 与 Canonical Hash；
5. Store 路由、权限和 no-overwrite 提交顺序；
6. NOOP/CONFLICT/损坏行为；
7. Scope、过期与重启行为；
8. symlink/路径/权限与外部零写入证据；
9. Promise/多进程并发结果；
10. 测试数量和全门禁；
11. Code Review/Security Review 发现与修复；
12. 未完成项、TOCTOU/平台限制与环境问题；
13. Git 状态与是否 commit/push/tag；
14. 当前完成标志；
15. 建议 CTO 重点复查位置。

## 十六、给 Gemini 3.7 Flash 的完整提示词

```text
你正在 /Users/czy/Desktop/demo/dsh-Mnemosyne 执行 v0.1.0 内部任务 MVP-02：短期/长期 Fact Store 与安全读写。

唯一实施规范：
/Users/czy/Desktop/demo/dsh-Mnemosyne/docs/DSH_MNEMOSYNE_V010_MVP02_FACT_STORE_PLAN.zh-CN.md

开始前完整读取：
1. 上述 MVP-02 计划；
2. docs/DSH_MNEMOSYNE_VERSION_ROADMAP.zh-CN.md；
3. docs/DSH_MNEMOSYNE_V010_MVP01_RUNTIME_SCOPE_PLAN.zh-CN.md；
4. src/protocol/canonical.ts、src/runtime-scope.ts、src/index.ts、src/observer.ts、src/status.ts；
5. tests/pack-check.mjs 与现有生命周期/Scope 测试；
6. Node 22 fs/promises 对 open、lstat、realpath、link、fsync 和文件 flags 的官方契约。

先显式陈述假设、最小实现方案与成功标准。严格 TDD：每个子阶段先写失败测试并保存代表性失败证据，再写最小产品代码。

核心要求：
- 实现严格 short-term/long-term 不可变 Fact Schema；
- Canonical JSON 与 content_sha256 是唯一内容完整性协议；
- short-term 绑定 Project + Session Scope，long-term 绑定 Project Scope；
- 物理根固定为真实 Project Root 下的 .dsh-mnemosyne；
- 路径逐组件安全检查，目录 0700、文件 0600；
- 临时文件 + fsync + link no-overwrite 原子发布；
- 同身份同内容 NOOP，同身份异内容 CONFLICT，损坏目标零覆盖；
- 严格 Get/List，未知文件与损坏 Fact fail closed；
- 短期过期使用调用者显式 now，禁止墙钟回退；
- Promise 和真实多进程并发均测试；
- Store 重开后持久读取；
- 所有错误静态、稳定、脱敏；
- Store 内部 API 不从包根或发布 DTS 导出。

硬约束：
- 不注册 remember/list/promote/forget Tool；
- 不实现 OKF、Manifest、Generation、CURRENT、真实检索或自动采集；
- 不修改 synthetic search/open 行为；
- 不在插件加载、status 或普通 Event 上创建目录；
- 不使用 process.cwd、环境变量、DSH 私有路径、deep import、SQLite、向量数据库、Desktop IPC、native addon 或猴子补丁；
- 不修改 package/lock/DSH 版本、src/m05*/**、Fixture 或历史评测语义；
- 不 commit、不 push、不创建 Tag。

实现顺序：
MVP-02A Schema/Canonical/Error
→ MVP-02B 安全路径/权限
→ MVP-02C 原子 Put/Get/List
→ MVP-02D 并发/重启/回归/安全审查。

完整覆盖计划第十一章 47 项测试矩阵。测试必须真实验证文件 bytes、mtime、权限、外部零写入和多进程赢家数量，不能用注释或 mock 代替关键安全行为。

完成后自行执行 Code Review 和 Security Review；发现 should-fix 必须修复并重跑全部门禁。

门禁：
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
corepack pnpm peers check
git diff --check

额外扫描：
rg -n 'process\.cwd\(\)|process\.env|electron|ipcRenderer|ipcMain|better-sqlite3|sqlite3' src/memory-*.ts
rg -n '@deepseek-ai/dsh-[a-z-]+/' src/memory-*.ts
rg -n 'Date\.now\(\)|new Date\(\)' src/memory-*.ts
rg -n 'memoryStore|MemoryFactStore|putShortTerm|putLongTerm' dist/index.d.mts
git status --short

最终不要输出过程流水账，只输出计划第十五章规定的“CTO 交接摘要”。明确声明未 commit、未 push、未创建 Tag、未进入 MVP-03。
```

## 十七、完成标志

CTO Review 通过后：

```text
fact_store_ready
```
