# dsh-Mnemosyne v0.1.0 · MVP-07B 真实临时项目 Canary 计划

> 状态：🟠 MVP-07B-I1 装配证明已签收；MVP-07B-I2 业务证据闭环待实现
>
> 日期：2026-08-26
>
> 前置提交：`8ccd82d feat: add v0.1.0 release validation gates`
>
> DSH Baseline：`0.1.1-rc.2`

---

## 一、目标、解释与成功标准

### 1.1 唯一目标

MVP-07B 不增加任何记忆产品能力。它只回答一个发布前问题：

> 由真实 `pnpm pack` 产出的 dsh-Mnemosyne，安装到完全隔离的 DSH Profile 后，能否在真实 DSH headless Agent 与真实 Provider 下完成 v0.1.0 的完整记忆闭环？

闭环固定为：

```text
自动采集 short-term
→ 重启后渐进式检索 search/open
→ promote 为 long-term
→ 再次重启后跨 Session/进程读取
→ forget 并使旧 Grant 失效
→ 第二项目与第二 Session Scope 隔离
```

### 1.2 两段式交付

MVP-07B 必须拆成两个互不隐式授权的阶段：

```text
MVP-07B-I：离线实现
  - 写 Runner、授权协议、证据检查器、脱敏报告和离线测试
  - Provider 调用数必须为 0
  - 不读取任何 Credential

MVP-07B-X：真实执行
  - 只有 07B-I 经 CTO 签收后才准备临时运行根
  - 用户静默写入临时 Credential
  - Preflight 生成精确 Approval Request Hash
  - 用户显式批准该 Hash 后才能执行一次
```

实现完成不等于真实 Canary 已通过。只有 07B-X 的六步报告为 `pass`，MVP-07B 才完成。

### 1.3 显式假设

1. 本地 `dsh --version` 与依赖共同基线为 `0.1.1-rc.2`；
2. Gate B 已证明真实 `pnpm pack` tarball 可在隔离 Profile 中 add/dump/load/remove；
3. DSH 官方 `headless` Profile 可通过 `dsh --profile headless "<task>"` 执行一次新建并持久化的 Session；当前 rc.2 headless 每次固定生成随机新 Session，不提供 resume CLI；
4. DSH `SessionPersistence` 的公开 `listSnapshots()` 与 `inspect(id)` 足以读取已验证、深冻结的 Session Event 视图；
5. Mnemosyne 的规范状态位于临时项目 `<workspace>/.dsh-mnemosyne`，现有 Store/Generation 读取器是唯一验证入口；
6. 真实 Provider 可能失败或模型可能不服从；二者不得伪装为产品通过，也不得自动重试；
7. 用户不会在聊天中粘贴 Key，只会把临时 Key 静默写入指定临时文件。

如果第 3、4 项在当前公开 DSH 基线上无法成立，07B-I 必须以兼容性阻断结束，不得改读私有存储布局或 deep import。

### 1.4 成功标准

1. 离线实现路径零 Provider、零 Credential 读取；
2. 真实执行必须经过不可重放的一次性 Approval；
3. 最多 6 次 headless 任务、12 次模型请求、零自动重试；
4. 每一步均由 Session Event、规范 Fact、Manifest、Generation、CURRENT 与严格 Tool 输出共同证明；
5. 不读取用户默认 DSH_HOME、默认 Credential 或正式 Workspace；
6. 报告不包含 Prompt、回复正文、Fact body、命令、绝对路径、Key 或 Provider 错误正文；
7. 无论 pass/fail/aborted，临时运行根均被边界验证后删除；
8. 全部离线测试、构建、打包、安全与依赖门禁通过。

### 1.5 不做

- 不修改 Fact、OKF、Retrieval、Acquisition 或 Management 产品协议；
- 不修改 README、package version 或 lockfile 依赖版本；
- 不自动重试、切换模型、扩大预算或修改任务文本；
- 不从自然语言推断 Tool 是否执行成功；
- 不读取 DSH 私有数据库/JSONL 路径或使用 deep import；
- 不保存完整 Session、Prompt、Response 或 Fact body；
- 不 commit/push/tag/npm publish/GitHub Release（由 CTO 签收后另行执行）；
- 不进入 MVP-07C。

---

## 二、当前公开接口与事实源

### 2.1 DSH 执行入口

普通新 Session 的真实执行只允许参数数组形式：

```text
dsh --profile headless <task>
```

Run 2/3 必须验证 Run 1 short-term 在**同一 Session identity 重启后**可见。由于 rc.2 官方 headless CLI 没有 `--resume`，07B-I 允许实现一个 Canary-only Resume Headless Driver：

```text
dsh --profile headless --patch <canary-resume-patch> <task>
```

该 Driver 只能使用公开 `ctx.agents.resume({ resumeSessionId })`、公开 Session/Agent/LLM API 与官方插件 patch 机制；它必须替换而非并行运行默认 headless runner，行为只限“恢复指定 Session → followup 固定任务 → whenIdle → flush → exit”。禁止 deep import、私有存储解析或修改 Mnemosyne。

普通 headless 与 Resume Driver 子进程都必须：

- 使用绝对 `dsh` 路径；
- `shell: false`；
- `cwd` 精确绑定当前临时 Workspace；
- 环境变量从最小白名单构造；
- 不继承 `DEEPSEEK_API_KEY`、默认 HOME、项目 `.env` 或用户自定义 Provider 变量；
- 设置隔离 `DSH_HOME`、隔离 `HOME`、隔离 `TMPDIR`；
- 使用官方 `headless` Profile；Canary patch 只允许增加被动 Audit Sidecar、禁用 `llm-retry`，或在 Run 2/3 以公开 API 的 Resume Driver 替换默认 runner。

### 2.2 Session Event 事实源

Tool 行为只由当前基线公开服务核验：

```text
@deepseek-ai/dsh-session-persistence
  listSnapshots()
  inspect(session_id)
```

允许读取并结构化汇总：

- SessionHeader 的 `id`、`cwd` 与来源限定 revision；
- `tool/call` 的 Tool 名称、call identity 和参数 Schema；
- 与之精确绑定的 `tool/result` 的严格协议输出；
- `request/header` 等公开事件中可证明的模型请求数量；
- `turn/end` 的完成/失败分类。

永久报告只保留计数、受控状态、Hash 与必要 ID Hash，不保留事件正文。不得使用 `readRaw()`，不得定位或解析后端物理文件。

外部 Runner 不能脱离 Cordis Context 直接取得 `ctx.sessionPersistence`。因此 07B-I 必须实现一个 **Canary-only 被动审计 Sidecar**，通过 DSH 官方插件/patch 扩展机制与被测 tarball 一起加载：

- Sidecar 只注入公开 `sessionPersistence` 与 `llm` 服务；
- 记录本批次产生的 Session ID，在进程完全停稳前调用 `inspect(id)`；
- 只输出 Tool 名称、call/result 绑定、受控状态、计数与 Hash；
- 不保存 Tool 参数中的自由文本、Tool Result body 或 Session 消息；
- Sidecar 不进入 dsh-Mnemosyne tarball、根导出或正式 Profile；
- 禁止通过 Sidecar 修改 Session、Tool、Provider、Prompt 或 Mnemosyne 状态。

若 Sidecar 无法仅用公开 DSH 插件与 Service API 实现，本阶段兼容性阻断。不得回退到读取 `sessions/` 物理文件。

### 2.2.1 全部模型请求的计数

仅统计 Session `request/header` 会漏掉自动提取等手工 `ctx.llm.stream()` 调用。Sidecar 必须通过公开的全局 `llm/stream` waterfall 被动包裹每一次调用：

```text
收到 llm/stream
→ 在调用 next() 前原子预扣 1 次 request budget
→ 不读取 options.messages/content
→ 透明转发 next() 的 Stream
→ 只记录 completed|provider_error|protocol_error|aborted
```

该计数覆盖 Agent 主请求、Session Title、自动提取及其他真实 LLM 调用。达到 12 次后，Sidecar 必须在 Provider dispatch 前以受控 `budget_exhausted` 阻断。

六个 headless 进程必须共享同一份运行根预算账本，不能各自维护进程内计数。Sidecar 在第一次迭代 `next()` 前通过跨进程锁原子发布：

```text
evidence/llm-claims/<sequence>.json
evidence/llm-outcomes/<sequence>.json
```

- Claim 只含 schema/version、1..12 序号、run id 与 Canonical Hash；
- Outcome 只含同一序号与 `completed|provider_error|protocol_error|aborted`；
- 不含 provider/model、purpose、messages、headers、响应或错误正文；
- 第 13 个 Claim 必须在调用 `next()` 前失败；
- Claim 已存在但无 Outcome 视为已消耗预算并按 `aborted` 处理；
- 所有内部 evidence 在生成最终脱敏报告后随运行根删除。

Canary patch 必须禁用官方 `llm-retry` 执行器，确保 Provider 失败不会在一次逻辑调用内隐式重试。Sidecar 仍按实际进入 `llm/stream` 的次数计数，不相信配置声明。

### 2.3 Mnemosyne 规范事实源

Canary 证据检查器必须复用现有验证路径读取：

```text
<workspace>/.dsh-mnemosyne/
  facts/
  manifests/
  generations/
  CURRENT
```

必须调用现有 Store/Generation/Protocol Validator；禁止用 `readFile + JSON.parse` 绕过 Hash、Canonical、Scope、权限和 symlink 检查。

OKF 页面与 Index 是派生视图。Fact、Manifest 与不可变 Generation 是规范验证输入；CURRENT 是当前可见世界的唯一切换点。

### 2.4 证据优先级

```text
规范 Fact / Manifest / Generation / CURRENT
  > 严格验证后的 Tool Result
  > Session Event 中的 Tool Call 顺序
  > headless 进程退出状态
  > 模型自然语言（不作为验收证据）
```

任一高优先级事实与模型声明冲突时，以事实为准。

---

## 三、隔离运行根与 Credential 边界

### 3.1 运行根布局

07B-I 只实现布局协议；07B-X 才创建真实实例：

```text
<owned-run-root>/                 0700
  home/                           0700
  dsh-home/                       0700
    .credentials.yaml             0600（仅用户写入）
  tmp/                            0700
  project-a/                      0700
  project-b/                      0700
  evidence/                       0700（仅执行期间）
```

最终脱敏报告写入调用方明确指定、位于运行根之外的受控目录。报告成功持久后，整个 `<owned-run-root>` 必须删除并验证不存在。

### 3.2 路径安全

所有路径必须：

1. 为绝对规范路径；
2. 从最近可信存在祖先起逐组件 `lstat`；
3. 拒绝任意 symlink、非目录组件、group/other 权限；
4. 用单层 `mkdir` 逐级创建并立即复核；
5. 验证运行根不等于或包含仓库根、用户默认 DSH_HOME、用户 HOME；
6. 只删除本次创建且 owner receipt 匹配的精确运行根；
7. 任一拒绝发生在外部写入之前。

### 3.3 Credential 不可见性

Credential 固定逻辑引用：

```text
temporary_dsh_home_credentials
```

Runner 和 Preflight 只允许对 `<dsh-home>/.credentials.yaml` 执行：

- `lstat/stat`；
- 检查是普通文件、不是 symlink；
- 检查 mode 精确为 `0600`；
- 检查位于已验证的隔离 DSH_HOME；
- 检查非空且大小不超过固定上限。

禁止 `readFile`、流式读取、Hash 文件内容、复制、打印或把原路径写入报告。Approval 只绑定逻辑引用与文件 metadata fingerprint，不绑定内容 Hash。

真实子进程可以由 DSH 官方 Credential Provider 在隔离 DSH_HOME 中读取该文件；Mnemosyne Runner 自身不得读取。

---

## 四、Plan、Approval、Claim 与 Report 协议

### 4.1 RealCanaryPlan v1

Plan 必须为严格 Canonical JSON，未知字段拒绝：

```yaml
schema_version: 1
plan_id: canary_plan_<64hex>
plan_sha256: sha256_...
dsh_version: 0.1.1-rc.2
package_version: 0.0.0-dev
package_sha256: sha256_...
profile: headless
run_root_identity: sha256_...
credential_ref: temporary_dsh_home_credentials
budgets:
  max_headless_runs: 6
  max_model_requests: 12
  retry_count: 0
  per_run_timeout_ms: 120000
  total_timeout_ms: 720000
  consecutive_provider_or_protocol_errors: 2
runs: [run_1, run_2, run_3, run_4, run_5, run_6]
created_at: <显式传入>
expires_at: <显式传入，短时有效>
nonce: <受控随机 ID>
```

Plan 必须绑定 Gate B 验证的同一真实 tarball Hash，不能接受目录、重新打包或同版本不同字节产物。

### 4.2 ApprovalReceipt v1

用户只批准精确 Plan：

```yaml
schema_version: 1
approval_id: canary_approval_<64hex>
plan_id: canary_plan_...
plan_sha256: sha256_...
approved: true
approved_at: <显式值>
expires_at: <不晚于 Plan>
approval_sha256: sha256_...
```

执行入口必须同时要求：

```text
--execute
--approval-sha256 sha256_...
```

Plan/Approval/package/DSH version/运行根/budget 任一不匹配、过期或未知字段均在调用 Provider 前拒绝。

### 4.3 一次性 Claim

Approval 使用 no-overwrite 原子 Claim：

- 第一次合法执行创建 Claim；
- 同一 Approval 重放、并发执行或中断后重复执行均拒绝；
- Claim 在第一次可能触发模型的子进程之前落盘；
- Claim 不含 Credential、Prompt、绝对路径或 Session 内容；
- 并发最多一个执行者进入真实执行。

### 4.4 RedactedCanaryReport v1

```yaml
schema_version: 1
status: pass|fail|aborted
dsh_version: 0.1.1-rc.2
package_version: 0.0.0-dev
package_sha256: sha256_...
plan_sha256: sha256_...
approval_sha256: sha256_...
run_count: 0..6
model_request_count: 0..12
checks:
  automatic_capture: pass|fail|not_run
  restart_persistence: pass|fail|not_run
  progressive_disclosure: pass|fail|not_run
  promotion: pass|fail|not_run
  forget_and_grant: pass|fail|not_run
  scope_isolation: pass|fail|not_run
reason_code: null|受控错误码
cleanup_clean: true|false
report_sha256: sha256_...
```

禁止字段和内容：Prompt、Response、Command、绝对路径、Session/Fact body、API Key、Header、底层 Provider 文本、模型思考、stdout/stderr 原文。

Report 使用 no-overwrite 原子写入。任何未知 reason 统一映射为稳定兜底码，不回显原始异常。

---

## 五、Runner 状态机与预算

### 5.1 固定状态机

```text
prepared
→ preflight_passed
→ awaiting_user_credential
→ approval_verified
→ claimed
→ running_1..running_6
→ evidence_verified
→ cleanup
→ pass|fail|aborted
```

禁止跳跃、回退、重用 Approval 或在失败后自动继续。

### 5.2 子进程安全

- 使用 `execFile/spawn` 参数数组，禁止 shell；
- stdout/stderr 使用固定字节上限，超限立即终止；
- stdout/stderr 只在内存中用于退出分类，随后丢弃；
- 单 Run 超时必须终止整个进程组，并等待退出；
- 总超时到达后不启动新 Run；
- 每次启动前预扣 headless run budget；
- 每个真实 `llm/stream` 在 Sidecar 中、Provider dispatch 前原子预扣模型请求 budget；
- 请求计数达到 12 后立即停止；
- 连续两次 Provider/协议错误停止；
- 自动重试固定为 0。

### 5.3 错误分类

```text
product_invariant_failed
dsh_compatibility_failed
model_noncompliance
provider_failed
credential_unavailable
authorization_invalid
budget_exhausted
subprocess_timeout
environment_failed
security_boundary_failed
cleanup_failed
```

模型未按要求调用 Tool 一律 `model_noncompliance`，不得算产品 Bug，不得重试。

---

## 六、六个固定 Run 与机器验收谓词

测试知识必须是无秘密、无路径、无命令的唯一字符串事实。任务文本固定在代码中，不接受执行时自由输入。

### 6.1 Run 1：自动采集

新进程、Project A、Session A1：

1. Agent 完成普通任务；
2. `turn/end completed` 后自动采集；
3. 精确出现 1 条目标 short-term Fact；
4. Fact project/session Scope 与 A/A1 匹配；
5. CURRENT 从空或旧值推进到包含目标的验证 Generation；
6. 原任务完成与采集结果分离。

### 6.2 Run 2：重启读取与渐进披露

新 DSH 进程、Project A、恢复 Session A1：

1. Tool 顺序包含 `status → list → search → open`；
2. Search 查询为固定换措辞版本；
3. Search Disclosure 不含 body；
4. Open 使用同一 `retrieval_id + search_disclosure_sha256 + memory_id`；
5. Open 只返回一条 L3 body；
6. A1 short-term 对任何新 Session 默认不可见；本 Run 必须通过 Canary Resume Driver 使用公开 `agents.resume` 恢复 A1，不得放宽 Session Scope。

### 6.3 Run 3：Promote 与 NOOP

再次恢复 A1：

1. `list → promote`；
2. long-term Fact 精确引用 source short-term Fact；
3. source short-term 文件保留；
4. 新默认 Generation 只披露 long-term 版本；
5. 第二次 promote 返回 `noop`；
6. CURRENT 与 Generation 保持合法。

### 6.4 Run 4：跨 Session/进程长期读取

新进程、Project A、新 Session A3：

1. 换措辞 `search → open`；
2. long-term 在 A3 可见；
3. Disclosure 绑定仍严格；
4. 不依赖 Run 3 的内存 Grant。

### 6.5 Run 5：Forget 与旧 Grant 失效

同一插件实例内：

1. Search 获取目标 Grant；
2. Forget long-term；
3. 使用旧 Grant Open 必须失败；
4. 新 Search 不再返回目标；
5. 第二次 Forget 返回 `noop`；
6. long-term Fact 未被物理删除，Forget Fact 与新 Generation 存在。

### 6.6 Run 6：Project 与 Session 隔离

Project B 与独立 Session：

1. Project A long-term 不可见；
2. Project A 任意 short-term 不可见；
3. Project B 的 status/list/search 不泄露 A 的 title、summary、tag 或 body；
4. 两项目 `.dsh-mnemosyne` Scope/Generation/CURRENT 完全独立。

---

## 七、07B-I 离线实现任务

### 7.1 最小文件建议

```text
scripts/mvp07b-real-canary.mjs
src/m07b/canary-protocol.js
src/m07b/authorization.js
src/m07b/isolation.js
src/m07b/audit-sidecar.js
src/m07b/resume-headless-driver.js
src/m07b/session-evidence.js
src/m07b/state-evidence.js
src/m07b/runner.js
src/m07b/report.js
tests/mvp07b-*.spec.ts
```

允许根据现有 JS/TS 风格减少文件，但不得把 07B 内部 API 加入插件根导出或生产 bundle。

### 7.2 实现顺序

1. 协议与 Canonical/Hash；
2. 运行根与 Credential metadata preflight；
3. Approval/Claim；
4. 子进程预算和终止；
5. Canary-only audit Sidecar（公开 llm/stream + SessionPersistence）；
6. Canary-only Resume Headless Driver（仅公开 agents.resume）；
7. Mnemosyne 规范状态证据检查器；
8. 六 Run 机器谓词；
9. 脱敏 Report 与 cleanup；
10. CLI `--dry-run`、`--prepare`、`--execute` 三模式；
11. 打包泄漏 Gate。

`--prepare` 只创建隔离根和 Plan，输出 Credential 的本地写入位置给当前用户终端，但不得把该绝对路径写入持久报告。它不得运行 Provider。

### 7.3 必须先写的失败测试

- Plan/Approval unknown field、Hash、expiry、budget、package mismatch；
- Approval replay、并发 Claim 单赢；
- Credential 缺失/symlink/0644/目录/越界；
- 监控证明 Runner 从未读取 Credential 内容；
- 默认 HOME/DSH_HOME/env Key 不继承；
- argv 注入、shell 字符、路径穿越、symlink 祖先；
- 单 Run/总超时、进程树清理、stdout/stderr 上限；
- 6/12 预算边界、零重试、两次错误熔断；
- 六个独立进程共享预算账本，并发 Claim 单赢，崩溃 Claim 不返还预算；
- Sidecar 在第 13 次 llm/stream 的 Provider dispatch 前阻断，且从不读取 messages/content；
- rc.2 默认 headless 的随机 Session 行为锁定；Resume Driver 只恢复已批准的 Run 1 Session，错 ID/跨 cwd/缺失 Session fail closed；
- SessionPersistence 缺失或公开 API 不满足时兼容性阻断；
- Tool Call/Result 缺失、错序、错 Hash、模型只说不调用；
- 六个机器谓词逐项正反例；
- Report unknown field、非法 reason、敏感文本、绝对路径；
- 任意失败后的运行根 cleanup；
- `dist`/tarball 零 `m07b` 内部符号、Fake DSH、Fixture、Prompt 和测试 seam。

离线测试使用 Fake DSH/Fake SessionPersistence/合成规范 Store，禁止网络与真实 Provider。至少保留一条真实 tarball/Profile smoke，由 MVP-07A Gate B 提供，不在 07B 测试中重复高成本 pack。

---

## 八、07B-X 真实执行操作规程

07B-I 代码签收并提交后，由 CTO 执行：

1. 对工作区跑全门禁并确认干净；
2. 使用 Gate B 同一方式生成并验证唯一 tarball；
3. 运行 `--prepare` 创建临时根与 Plan；
4. 只把 Credential 文件绝对路径显示给用户，不在聊天中索取 Key；
5. 用户静默写入临时 `.credentials.yaml` 并设为 `0600`；
6. Preflight 只检查 metadata，生成 Approval Request 与 Hash；
7. 用户在聊天中明确批准该 Approval SHA；
8. CTO 使用 `--execute --approval-sha256 <exact>` 执行一次；
9. 输出脱敏 Report；
10. 删除临时根并验证不存在；
11. 用户销毁临时 Key；
12. Canary pass 后才进入 MVP-07C。

任何失败都停止。修复产品 Bug 后必须创建新的 Plan、Approval 和临时 Key 环境；旧 Approval 不得重放。

---

## 九、门禁

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm exec vitest run tests/mvp07b-*.spec.ts
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
corepack pnpm peers check
git diff --check
```

07B-I 的测试必须证明：

```text
real_provider_calls = 0
credential_content_reads = 0
default_dsh_home_reads = 0
default_workspace_writes = 0
```

---

## 十、Gemini 3.7 Flash 执行提示词（仅 MVP-07B-I）

```text
你正在 /Users/czy/Desktop/demo/dsh-Mnemosyne 执行 dsh-Mnemosyne v0.1.0 内部任务 MVP-07B-I：真实临时项目 Canary 的离线实现。

先完整读取：
- AGENTS.md
- docs/DSH_MNEMOSYNE_VERSION_ROADMAP.zh-CN.md
- docs/DSH_MNEMOSYNE_V010_MVP07_REAL_LOOP_RELEASE_PLAN.zh-CN.md
- docs/DSH_MNEMOSYNE_V010_MVP07B_REAL_CANARY_PLAN.zh-CN.md
- scripts/mvp07-profile-smoke.mjs
- scripts/mvp07-canary-preflight.mjs
- src/m07/**
- src/runtime-scope.ts
- src/memory-store.ts
- src/generation-store.ts
- src/observer.ts
- tests/pack-check.mjs
- 当前安装的 @deepseek-ai/dsh-session-persistence README 与根导出类型

先显式输出：
1. 假设；
2. 成功标准；
3. 计划修改文件；
4. 当前 dsh --version；
5. 如何证明真实 Provider 调用数与 Credential 内容读取数均为 0；
6. 如何通过公开 SessionPersistence API 核验 Tool Event，而不解析私有文件。

本轮严格只做 MVP-07B-I。不要执行真实 Canary，不要读取 Key，不要调用网络或 Provider。若公开 SessionPersistence 无法满足设计，立即停止并输出兼容性阻断，不得 deep import 或猜私有存储布局。

先 TDD：每项必须先写失败测试并记录真实失败证据，然后实施最小代码。匹配现有风格，避免新增通用框架。

必须实现：
- RealCanaryPlan / ApprovalReceipt / Claim / RedactedCanaryReport v1 严格 Schema、Canonical 与 Hash；
- --dry-run / --prepare / --execute 三模式；测试中只允许前两者和 Fake Execute；
- 安全隔离根、Credential metadata-only preflight；
- 一次性原子 Claim；
- 参数数组子进程、最小环境、进程组 timeout、bounded output；
- 6 run / 12 request / 0 retry / 2-error circuit breaker；
- 公开 SessionPersistence listSnapshots/inspect 的证据适配器；
- Canary-only Sidecar 通过公开 llm/stream 统计所有模型调用，禁止读取 options.messages/content，并通过 patch 禁用 llm-retry；
- Canary-only Resume Headless Driver，仅在 Run 2/3 通过公开 ctx.agents.resume 恢复 Run 1 Session，并替换默认 headless runner；
- 复用现有 Store/Generation Validator 的规范状态检查器；
- 六步机器验收谓词；
- 脱敏 no-overwrite Report 与边界验证 cleanup；
- pack-check 禁止全部 m07b 内部符号、Fake DSH、Fixture、Prompt、Approval 测试 seam 进入生产包。

不可协商：
- 不读取或 Hash Credential 内容；
- 不继承 process.env.DEEPSEEK_API_KEY；
- 不读取默认 ~/.dsh、默认 Credential、项目/用户 .env；
- 不调用真实 Provider；
- 不把自然语言当验收证据；
- 不解析 DSH 私有 Session 文件；
- 不修改任何记忆产品协议与根导出；
- 不修改 README/package version/依赖版本；
- 不 commit/push/tag/npm publish；
- 不进入 MVP-07B-X 或 MVP-07C。

离线测试必须至少覆盖文档 7.3 全矩阵，并注入反证：断开 Credential no-read guard、Approval binding、共享 budget、Session Event evidence 或 Store validator 时，测试必须真实失败。

实现完成后自行执行两轮独立审查：

Code Review：逐项检查状态机、预算、一次性 Claim、Session/Event 证据、六步谓词、错误分类、cleanup 与最小改动。

Security Review：逐项检查 Credential 零读取、默认状态零访问、symlink/路径穿越、argv/env 注入、进程树终止、bounded output、报告脱敏、测试 seam/产物泄漏。

发现问题必须先补失败测试、修复并重跑全部门禁。最后只输出《CTO 交接摘要》，不要贴冗长逐步日志。摘要必须包含：
- 实际修改文件；
- 每项修复前失败证据；
- Plan/Approval/Claim/Report 协议；
- Credential metadata-only 与默认状态零访问证明；
- SessionPersistence 公开 API 证据链；
- 六步机器谓词实现；
- 预算/timeout/circuit breaker/cleanup 状态机；
- Code Review 与 Security Review 发现及修复；
- 精确测试数和全部门禁原始结果；
- git status；
- 明确 real_provider_calls=0、credential_content_reads=0；
- 未 commit/push/tag、未执行真实 Canary、未进入 MVP-07C。
```

---

## 十一、签收条件

### 11.1 MVP-07B-I

- [ ] 所有协议与安全边界完成；
- [ ] 公开 SessionPersistence 证据链成立；
- [ ] 六步机器谓词均有正反测试；
- [ ] Provider/Credential/default state 零访问证明；
- [ ] 全部门禁通过；
- [ ] CTO Review 与 Security Review 无阻断项。

### 11.2 MVP-07B-X

- [ ] 用户批准精确 Approval SHA；
- [ ] 六个真实 Run 不超过冻结预算；
- [ ] 所有检查均由机器证据通过；
- [ ] `status=pass`；
- [ ] `cleanup_clean=true`；
- [ ] 用户销毁临时 Key。

只有 11.1 与 11.2 同时满足，才能把主计划 Gate C 标记为通过并开始 MVP-07C。
