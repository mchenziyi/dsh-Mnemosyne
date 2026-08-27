# dsh-Mnemosyne v0.1.0 · MVP-07B-I2 业务证据闭环计划

> 状态：🟡 设计完成，待实现
>
> 日期：2026-08-27
>
> 前置提交：`cd4f512 feat: add offline real canary wiring`
>
> DSH Baseline：`0.1.1-rc.2`

---

## 一、定位与唯一目标

MVP-07B-I1 已证明以下执行装配真实生效：

```text
真实 pnpm pack tarball
→ 隔离 DSH Profile
→ 真实 DSH 子进程
→ Audit Sidecar
→ Resume Headless Driver
→ 每 Run LLM Claim
→ 进程组与运行根清理
```

I1 刻意把六项记忆业务检查保持为 `not_run`。MVP-07B-I2 的唯一目标是补齐这一层：

> 使用真实 DSH、真实打包插件和确定性离线 Mock Provider，严格验证六个 Run 产生的 Tool Event、Tool Result 与规范 Fact/Generation 状态，并让六个业务谓词在离线环境中全部通过。

I2 仍然不是 07B-X：

- 真实 Provider 调用数必须为 0；
- Runner 读取 Credential 内容数必须为 0；
- 不使用真实 API Key；
- 不宣称模型在真实 Provider 下必然服从；
- 不执行 npm publish、Tag 或 Release。

### 1.1 本阶段解决的问题

1. 当前 `session-evidence.js` 会把未知非错误文本降级为 `pass`，证据强度不足；
2. 当前 Tool Call/Result 只保存宽松摘要，不能证明一一绑定、参数继承与披露闭包；
3. 当前六个 Predicate 只覆盖部分工具存在性，未完整落实主计划第六章；
4. 当前 Runner 只验证 Wiring，不在每个 Run 后立即冻结业务状态快照；
5. 当前离线 Mock 能驱动真实 DSH，但尚未被约束为“只生成模型输出，不写证据、不写 Fact、不读 Mnemosyne 磁盘”。

### 1.2 不做

- 不改 Memory Fact、Manifest、OKF、Retrieval、Acquisition、Management 产品协议；
- 不增加新的记忆 Tool；
- 不放宽 Session/Project Scope；
- 不读取 DSH 私有数据库、JSONL 或内部目录布局；
- 不保存 Prompt、回复正文、Fact body、Open body 或 Provider 原始错误；
- 不让 Mock Provider 写 Fact、Generation、CURRENT、Receipt、Claim 或 Session Evidence；
- 不执行真实 Provider Canary；
- 不进入 MVP-07C。

---

## 二、显式假设与成功标准

### 2.1 显式假设

1. DSH rc.2 的公开 Session Event 至少提供 `tool/call`、`tool/result`、`turn/end`；
2. Tool Call 与 Result 可通过公开 call identity 一一绑定；
3. Tool Result 的消息内容可由对应的正式产品协议 Validator 严格解码；
4. 现有 `openMemoryFactStore`、`readCurrentPointer`、`verifyAndLoadGenerationWorld` 是规范状态唯一读取入口；
5. Run 2/3 继续由 I1 已签收的 Resume Driver 恢复 Run 1 Session；
6. 离线 Mock Provider 只负责返回确定性模型 Stream，不属于验收事实源。

任一假设不成立时必须输出兼容性阻断；不得通过自由文本猜测、私有文件解析或测试伪造绕过。

### 2.2 成功标准

1. 每个 Tool Call 恰好绑定一个 Result；缺失、重复、孤儿、错序全部 fail closed；
2. 所有 Mnemosyne Tool Result 必须经过正式协议校验，不再使用关键词或任意文本推断 `pass`；
3. Run 1～6 在各自结束后立即读取并冻结规范状态快照，后续 Run 不得反向改变已判定证据；
4. 六个业务 Predicate 完整覆盖主计划 6.1～6.6；
5. 正向离线真实 DSH 流程得到：Wiring `pass` + 六项业务检查全部 `pass`；
6. 任一业务证据被删、改、错绑或跨 Scope 时，准确的当前检查为 `fail`，后续检查为 `not_run`；
7. Mock Provider 直接写入 evidence 或 `.dsh-mnemosyne` 的反证测试必须失败；
8. 全流程保持零真实 Provider、零 Runner Credential 内容读取、零默认 HOME/Workspace 污染；
9. I1 全部回归测试继续通过；
10. 内部 I2 协议与 Fixture 不进入生产 Bundle、根导出或 npm tarball。

---

## 三、证据边界与事实优先级

### 3.1 三层证据

```text
L1 规范状态证据
  Fact / Forget Fact / Manifest / Generation / CURRENT

L2 严格 Tool 证据
  已验证 Tool Call + 与其绑定的已验证 Tool Result

L3 执行证据
  Wiring Receipt / LLM Claim / Run Exit / Session Resume Receipt
```

判定优先级固定为 `L1 > L2 > L3`。模型自然语言不是证据。

### 3.2 临时证据最小化

I2 临时 evidence 允许保存：

- Run ID；
- Session ID Hash；
- Project Scope ID；
- Tool 名称与顺序；
- Call ID Hash；
- 受控状态枚举；
- MemoryRef、GenerationRef、Retrieval ID 与 Disclosure Hash；
- Tool Result Canonical Hash；
- 状态快照 Hash；
- 严格时间戳。

禁止保存：

- Prompt、用户任务正文与模型回复；
- Search query 原文；
- Memory title/summary/body/tag；
- Open body；
- Tool Result 原始 JSON 文本；
- 原始 Session ID；
- 绝对路径与 Credential 内容。

---

## 四、StrictSessionEvidence v2

### 4.1 顶层结构

新增 Canary-only 严格证据协议，建议落在：

```text
src/m07b/business-evidence.js
src/m07b/business-evidence.d.ts
```

结构：

```yaml
schema_version: 2
run_id: run_1|run_2|run_3|run_4|run_5|run_6
project_scope_id: sha256_...
session_id_sha256: sha256_...
completed_turns: <positive integer>
tool_executions:
  - ordinal: 1
    call_id_sha256: sha256_...
    tool_name: <Mnemosyne Tool enum>
    argument_binding: <tool-specific safe projection>
    result_status: <tool-specific enum>
    result_binding: <tool-specific safe projection>
    result_sha256: sha256_...
recorded_at: <strict ISO UTC>
content_sha256: sha256_...
```

要求：

- Plain Object、精确字段、未知字段拒绝；
- `ordinal` 从 1 连续递增；
- `call_id_sha256` 唯一；
- 每个 Call 恰好一个 Result；
- Result 必须出现在对应 Call 之后；
- 孤儿 Result、重复 Result、空 call identity、未知工具全部拒绝；
- Canonical JSON 与 Hash 重算一致；
- no-overwrite `wx` + `0600`；
- 读取时严格验证，不接受 I1 的宽松摘要作为业务证据。

### 4.2 Tool 专用安全投影

只保存机器谓词需要的字段：

| Tool | Argument Binding | Result Binding |
|---|---|---|
| `mnemosyne_status` | 空对象 Hash | availability、generation_id、short/long/total count |
| `mnemosyne_list` | tier/filter 的受控枚举，不保存自由文本 | MemoryRef 数组与结果 Hash |
| `mnemosyne_search` | query Hash、component_hint、top_k | retrieval_id、Search Disclosure Hash、GenerationRef、MemoryRef 数组、`contains_body=false` |
| `mnemosyne_open` | retrieval_id、父 Disclosure Hash、memory_id | Open Disclosure Hash、MemoryRef、body Hash、`body_present=true` |
| `mnemosyne_promote` | source MemoryRef | `promoted|noop`、source ref、long-term ref、GenerationRef |
| `mnemosyne_forget` | target MemoryRef | `forgotten|noop`、target ref、ForgetRef、GenerationRef |
| `mnemosyne_remember` | 不作为六 Run 必选工具 | `created|noop` 与 MemoryRef；仅用于反证/兼容测试 |

禁止通过关键词、任意非空文本或字段存在性判定成功。每类 Result 必须调用其正式 Validator；如当前 Tool 返回层缺少公开 Validator，只允许在 `src/m07b/` 内写严格适配器，并用产品协议 golden tests 锁定，不得修改产品结果语义。

### 4.3 Search/Open 绑定

必须证明：

```text
open.argument.retrieval_id
  == search.result.retrieval_id

open.argument.search_disclosure_sha256
  == search.result.search_disclosure_sha256

open.argument.memory_id
  ∈ search.result.allowed MemoryRefs

open.result.parent_disclosure_sha256
  == search.result.search_disclosure_sha256
```

Search Evidence 不得包含 body；Open Evidence 只保存 body Hash，不保存 body。

---

## 五、逐 Run 规范状态快照

### 5.1 快照时机

Runner 必须在每个 DSH 子进程成功退出并完成 StrictSessionEvidence 校验后、启动下一 Run 前读取状态：

```text
Run exit 0
→ Wiring Receipt / Claim 验证
→ StrictSessionEvidence 验证
→ Fact Store / CURRENT / Generation 验证
→ 生成内存中的 RunStateSnapshot
→ 执行该 Run Predicate
→ 通过后才进入下一 Run
```

不把快照写成新的产品 Fact。临时快照只存在 evidence 目录，并随 runRoot 清理。

### 5.2 RunStateSnapshot

建议包含：

```yaml
run_id: run_1..run_6
project_scope_id: sha256_...
session_id_sha256: sha256_...
short_term_refs: [MemoryRef]
long_term_refs: [MemoryRef]
forget_refs: [ForgetRef]
current_ref: GenerationRef|null
index_memory_refs: [MemoryRef]
snapshot_sha256: sha256_...
```

全部字段由现有 Store/Generation Validator 输出构建；禁止裸 `readFile + JSON.parse` 绕过验证。

### 5.3 跨 Run 身份账本

Runner 内存中维护不可变 `CanaryIdentityLedger`：

- Run 1：唯一新 short-term MemoryRef、A1 Session Hash；
- Run 2：Search/Open 绑定与同一 short-term Ref；
- Run 3：source short-term Ref、promoted long-term Ref；
- Run 4：新 Session Hash、同一 long-term Ref；
- Run 5：搜索 Grant、ForgetRef、被遗忘 long-term Ref；
- Run 6：Project B Scope 与空/独立状态。

Ledger 只由前一 Run 的已验证证据推进，不接受模型输出自由指定 Memory ID。

---

## 六、六个完整业务谓词

### 6.1 Run 1：Automatic Capture

必须同时满足：

1. Run 前后 Fact diff 精确新增 1 条目标 short-term；
2. 不是 `mnemosyne_remember` 直接写入；
3. Fact 的 Project/Session Scope 与 A/A1 一致；
4. Fact 具备合法 acquisition evidence；
5. CURRENT 推进到包含该 Ref 的已验证 Generation；
6. Turn completed 与采集完成均有独立证据。

### 6.2 Run 2：Restart + Progressive Disclosure

必须同时满足：

1. Resume Receipt 证明恢复 A1；
2. 工具顺序严格为 `status → list → search → open`，允许无关非 Mnemosyne Tool，但不得打断四者相对顺序；
3. Search 命中 Run 1 short-term Ref；
4. Search Result 证明 `contains_body=false`；
5. Open 与 Search 严格绑定且只打开该 Ref；
6. Open body Hash 与 Generation 页面 Hash 一致；
7. CURRENT/Generation 仍合法。

### 6.3 Run 3：Promote + NOOP

必须同时满足：

1. Resume Receipt 再次证明 A1；
2. 工具相对顺序为 `list → promote → promote`；
3. 第一次为 `promoted`，第二次为 `noop`；
4. long-term Fact 精确引用 Run 1 short-term；
5. source short-term 物理保留；
6. CURRENT 的正常索引只披露 promoted long-term，不再披露 source short-term；
7. 第二次 promote 后 CURRENT/Generation 不发生无意义变化。

### 6.4 Run 4：Cross-session Long-term Read

必须同时满足：

1. 新 Session Hash 与 A1 不同；
2. `search → open` 相对顺序正确；
3. Search/Open 指向 Run 3 long-term Ref；
4. 不复用 Run 2 的 retrieval/grant identity；
5. Open body Hash 与当前 Generation 页面一致；
6. 任意 short-term 均不因跨 Session 泄漏。

### 6.5 Run 5：Forget + Old Grant Invalidation

同一 DSH 进程/插件实例内必须满足：

1. 第一次 Search 获取 long-term Grant；
2. Forget 返回 `forgotten`；
3. 使用旧 Grant 的 Open 返回受控失败，且 Result 与原 Call 严格绑定；
4. 新 Search 不再包含目标 Ref；
5. 第二次 Forget 返回 `noop`；
6. 原 long-term Fact 物理保留；
7. Forget Fact 与新 Generation 存在；
8. CURRENT 不再披露目标。

### 6.6 Run 6：Project + Session Isolation

必须同时满足：

1. Project B Scope 与 A 不同；
2. Project B status/list/search 均不返回 Project A MemoryRef；
3. B 的证据中不出现 A 的 Memory ID/Hash；
4. B 的 Fact Store 不含 A 的 Fact/Forget；
5. B 的 CURRENT/Generation 不引用 A；
6. A 的 Store/CURRENT 在 Run 6 前后字节身份不变。

---

## 七、Runner 与报告语义

### 7.1 顺序执行

每个 Run 通过其 Predicate 后才启动下一 Run。失败时：

- 当前业务检查记为 `fail`；
- 已通过检查保持 `pass`；
- 后续检查保持 `not_run`；
- 不自动重试；
- 立即进入预算汇总、脱敏报告与 cleanup。

### 7.2 Report 协议演进

I1 已签收的 Wiring-only 报告不得被重新解释。I2 使用 `RedactedCanaryReport v2`：

```yaml
schema_version: 2
evaluation_level: business
...其余身份、预算、checks、cleanup 与 v1 同构
```

兼容规则：

- v1 仅表示 `wiring_only`，六项业务 checks 必须全部 `not_run`；
- v2 `evaluation_level=business`；
- v2 `status=pass` 必须满足 Wiring `pass`、六项业务全部 `pass`、6 Runs、模型请求 1..12、cleanup=true；
- v2 `status=fail` 允许“已通过前缀 + 当前 fail + 后续 not_run”，禁止 fail 后再次出现 pass；
- 未知字段、混合非法状态、自由 reason 一律拒绝；
- 报告仍不得包含任何业务正文、路径或原始 Session ID。

I2 的离线正向报告只证明评估器和产品闭环在确定性 Mock 下成立；只有 07B-X 使用真实 Provider 生成的 v2 报告才能完成 MVP-07B。

---

## 八、离线 Mock Provider 约束

Mock Provider 只能：

- 根据冻结 Run 与模型可见的先前 Tool Result，输出确定性的 assistant/tool-call Stream；
- 为自动提取请求返回严格 Extraction JSON；
- 记录自身被调用次数供测试反证。

Mock Provider 禁止：

- 读取 `.dsh-mnemosyne`、`evidence/`、SessionPersistence 物理文件或 Credential；
- 写入 Fact、Generation、CURRENT、Receipt、Claim、Outcome 或 Session Evidence；
- 从 Runner 注入 Memory ID、Retrieval ID 或 Hash；
- 跳过真实 Tool 调用直接生成成功证据。

必须通过权限/代理反证测试证明上述禁止项。

---

## 九、实施顺序

### I2-A：严格业务证据协议

1. 冻结 StrictSessionEvidence v2；
2. 按 rc.2 真实 Event 形态实现 Call/Result 一一绑定；
3. 为七个 Mnemosyne Tool 实现安全投影；
4. 删除“任意非空文本视为 pass”的业务路径；
5. 增加 Canonical/Hash/no-overwrite/脱敏测试。

### I2-B：状态快照与身份账本

1. 复用 Store/Generation Validator；
2. 实现逐 Run Snapshot；
3. 实现 Fact diff 与 Index 可见性；
4. 实现跨 Run Ledger；
5. 覆盖跨 Scope、Hash 漂移与 symlink fail-closed。

### I2-C：六谓词完整化

1. 按第六章逐项实现；
2. 每个条件提供一个独立反例；
3. 不用模型文本作为输入；
4. 固定 pass/fail reason 枚举。

### I2-D：Runner 与 Report v2

1. 每 Run 后立即评估；
2. 失败停止且状态前缀闭合；
3. v1 Wiring Report golden 保持；
4. v2 Business Report 严格校验；
5. cleanup 前固定脱敏报告，cleanup 后原子写出。

### I2-E：真实 DSH + 离线 Mock 纵向集成

1. 真实 pnpm tarball；
2. 真实隔离 Profile；
3. 真实六 DSH 进程与 Resume；
4. 离线 Mock 只产生模型 Stream；
5. 六项业务 checks 全 pass；
6. 反证断开任一 Tool/Result/Fact/Generation/Scope 后准确失败。

每个子阶段单独 TDD、自审；本轮完成 I2 后再由 CTO 一次提交，不在 Gemini 内 commit。

---

## 十、测试矩阵

### 10.1 Session Evidence

- 空/重复 call identity；
- Result 缺失、重复、先于 Call、孤儿；
- 未知 Tool；
- Tool Result 未知字段、错误 Hash、错误状态；
- 自由文本和任意非空文本不得变成 pass；
- Search 泄漏 body；
- Open 与 Search 的 retrieval/disclosure/memory 任一错配；
- Canonical 重放字节稳定；
- no-overwrite 与敏感信息零落盘。

### 10.2 State Snapshot

- Fact/Manifest/Generation/CURRENT 合法路径；
- 文件损坏、Hash 漂移、跨 Scope、symlink；
- Run 后快照不被下一 Run 覆盖；
- source short-term 保留；
- promoted long-term 与 Forget Fact 精确引用；
- Index 可见集与 Store 物理集分离。

### 10.3 六谓词

每一条业务条件至少一个正例和一个反例。特别要求：

- Run 1 使用 remember 直接写入不能冒充自动采集；
- Run 2 仅 search、未 open 不通过；
- Run 3 只有一次 promote、无 noop 不通过；
- Run 4 复用旧 Grant 不通过；
- Run 5 Forget 后旧 Grant 仍可 open 不通过；
- Run 6 只检查空 B Store、未检查 A 不变不通过。

### 10.4 Mock 与边界

- Mock 尝试读取 Store/evidence/Credential 立即失败；
- Mock 尝试直接写 Fact/Receipt 立即失败；
- Fake Tool Event 无真实 Result 不能通过；
- 模型只说“已完成”不能通过；
- 真实 Provider dispatch 计数严格为 0；
- 默认 HOME/DSH_HOME/Workspace 读写严格为 0。

### 10.5 Report

- v1 golden 不变；
- v2 全 pass 合法；
- pass 中存在 fail/not_run 非法；
- fail 后出现 pass 非法；
- 非法 reason、未知字段、路径/Secret 注入拒绝；
- cleanup=false 不能产生 pass。

---

## 十一、门禁

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm exec vitest run tests/mvp07b-i2-*.spec.ts tests/mvp07b-canary-offline.spec.ts
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
corepack pnpm peers check
git diff --check
```

定向 I2 集成测试连续运行 3 次。不得通过提高单元测试 timeout 掩盖死锁；只有真实六进程纵向测试允许显式 45 秒级 timeout。

---

## 十二、Gemini 3.7 Flash 执行提示词

```text
你正在 /Users/czy/Desktop/demo/dsh-Mnemosyne 执行 MVP-07B-I2：业务证据闭环。

先完整读取：
1. docs/DSH_MNEMOSYNE_V010_MVP07B_I2_BUSINESS_EVIDENCE_PLAN.zh-CN.md
2. docs/DSH_MNEMOSYNE_V010_MVP07B_REAL_CANARY_PLAN.zh-CN.md
3. src/m07b/session-evidence.js
4. src/m07b/state-evidence.js
5. src/m07b/predicates.js
6. src/m07b/runner.js
7. 对应 Fact/Generation/Retrieval/Management 产品协议与测试

开始前必须输出：
- 对任务的解释；
- 显式假设；
- 当前证据缺口；
- 最小修改文件清单；
- 分 I2-A～I2-E 的 TDD 计划与成功标准。

实施纪律：
- 文档是唯一规格，不自由扩大需求；
- 每个子阶段先写失败测试，保留修复前失败证据，再做最小实现；
- 只用 DSH 公开接口与 Mnemosyne 现有 Validator；
- 不通过关键词、任意文本或模型声明推断成功；
- Mock Provider 只能输出模型 Stream，不得读写 Store/evidence/Credential；
- 每个 Run 后立即冻结严格 Session Evidence 与规范状态快照并运行 Predicate；
- 保持 I1 Wiring Receipt、Claim、预算、Resume、清理全部不回归；
- 不调用真实 Provider，不读取 Credential 内容，不执行网络请求；
- 不 commit、push、tag、publish，不进入 07B-X/07C。

必须完成：
1. StrictSessionEvidence v2 与 Tool Call/Result 一一绑定；
2. 七类 Mnemosyne Tool 的严格安全投影；
3. Search/Open/Grant 的完整绑定验证；
4. 每 Run 的规范 RunStateSnapshot；
5. 不可变跨 Run CanaryIdentityLedger；
6. 六个业务 Predicate 的完整正反矩阵；
7. RedactedCanaryReport v2，同时保持 v1 Wiring golden；
8. 真实 DSH + 真实 tarball + 离线 Mock 的六 Run 纵向测试；
9. Mock 零读写与生产包零泄漏证明。

实现完成后先自行 Code Review，再自行 Security Review。Review 发现问题必须修复并重跑门禁，确认无 blocking/should-fix 后再交给 Codex。

最终只输出《CTO 交接摘要》，必须包含：
- 实际修改文件；
- I2-A～I2-E 完成状态；
- 每组失败测试的修复前真实证据；
- StrictSessionEvidence 与 Snapshot Schema；
- 六谓词逐项证据来源；
- Mock Provider 禁止项及反证结果；
- v1/v2 Report 兼容矩阵；
- 全部门禁命令与准确测试数量；
- Code Review / Security Review 结果；
- git status；
- 明确真实 Provider=0、Credential 内容读取=0、未 commit/push/tag、未进入 X/07C。
```

---

## 十三、完成定义

MVP-07B-I2 只有在以下条件全部满足时才能签收：

- [ ] StrictSessionEvidence 不再存在自由文本成功推断；
- [ ] Call/Result 一一绑定且所有 Tool Result 严格验证；
- [ ] 六个 Run 的规范状态快照与身份账本可重放；
- [ ] 六项业务 checks 在真实 DSH + 离线 Mock 下全部 pass；
- [ ] 任一关键证据断开均准确 fail closed；
- [ ] I1 Wiring、预算、Resume、cleanup 全部不回归；
- [ ] v1 Wiring Report golden 保持，v2 Business Report 严格闭合；
- [ ] Mock Provider 无 Store/evidence/Credential 读写；
- [ ] 真实 Provider 调用数为 0；
- [ ] 全部门禁通过；
- [ ] CTO Review 无 blocking/should-fix。

签收 I2 后，下一步才是 MVP-07B-X：用户提供临时 Credential 并显式批准精确 Approval SHA 的一次性真实 Provider Canary。
