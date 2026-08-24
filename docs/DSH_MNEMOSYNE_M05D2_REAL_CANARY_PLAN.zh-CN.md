# dsh-Mnemosyne M0.5D-D2 开发计划：真实 Provider Canary 执行桥与双重授权门禁

> 状态：🟠 D2-A/B1/B2 与 D2-C 已完成；D2-B3 已于 2026-08-24 执行并得到 `real_provider_plumbing_fail/circuit_open`；当前为 `real_canary_diagnostics_ready`，未授权重试，未进入 D3。
> 基线：`main@0a5fa6f`，DSH `0.1.0-rc.8`  
> 架构事实源：`docs/DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md` 第 19.14～19.16 节  
> 前置状态：M0.5E=`canary_preflight_ready`；M0.5F1=`real_canary_ready_for_user_approval`  
> 本文档不是调用授权；完成代码也不等于允许真实 Provider 请求

## 一、目标与成功标准

M0.5D-D2 只验证真实 Provider 链路是否能在严格边界内完成固定的 6-run Canary：

```text
M0.5F1 pending Authorization
→ 用户独立 Approval Receipt
→ 启动时重新验证版本、Plan、Fixture、限额与隔离
→ DSH rc.8 官方 DeepSeek Provider
→ 固定 6 个 Run / 最多 30 次调用
→ 严格 Receipt 与脱敏报告
→ real_provider_plumbing_pass | real_provider_plumbing_fail
```

D2 通过只证明“真实 Provider plumbing 可用”，不证明记忆提高了模型质量，也不输出 `GO|ADJUST|STOP`。三组完整配对评测属于 D3，并且需要用户第二次单独批准。

成功标准：

1. 实现阶段全程使用 Fake Adapter/Transport，真实请求、凭据解析与费用均为 0；
2. 实跑前必须同时持有内容完全绑定的 pending Authorization 与独立 approved Approval Receipt；
3. 真实执行只使用 DSH rc.8 官方公开 API、根导出和 Credential seam；
4. 固定执行 6 个 Run，最多 24 次任务调用与 6 次 acquisition 调用，总上限 30；
5. 自动重试为 0，单次超时 30 秒，批次超时 10 分钟，连续 2 个 Provider/协议错误立即熔断；
6. 所有已完成调用都产生严格、脱敏、可审计的合法 Receipt；失败只保留已验证的合法前缀；
7. evaluation-only 实现不进入生产插件导出、dist 或 npm tarball。

## 二、必须拆开的两个 Gate

### 2.1 D2-A：离线实现与审查

Gemini 只实现：

- Approval Receipt Schema、Canonical Bytes 与 Hash；
- Authorization/Approval/Plan/Audit/Fixture 的绑定验证；
- 官方 Provider Adapter Factory；
- D2 Runner、预算、超时、熔断、Receipt 与 Summary；
- 显式输出路径、安全持久化、清理与脱敏；
- Fake Adapter 下的完整 TDD、普通 Review 与 Security Review。

D2-A 禁止：

- 调用真实 Provider；
- 读取或要求真实 API Key；
- 解析 `process.env`、默认 `DSH_HOME`、用户 Profile、Session、Workspace、`.credentials.yaml` 或 Keychain；
- 创建内容为 `approved` 的真实 Approval Receipt；测试只能使用明显的 synthetic fixture；
- 运行 D2-B、输出 plumbing pass/fail 或形成真实证据。

D2-A 的唯一完成状态为：

```text
real_canary_executor_ready_for_user_approval
```

### 2.2 D2-B：用户授权的真实 Canary

D2-A 经 Sol 签收后暂停。只有用户看到并接受下列完整 preflight 后，才可执行 D2-B：

- Authorization ID 与 Hash；
- Approval ID 与 Hash；
- Provider package、route、model；
- Fixture、M0.5E Plan、M0.5F1 Audit/Plan Hash；
- 6 runs、30-call 总上限、4096 output token 上限；
- 30 秒单次超时、10 分钟批次超时、0 retry、2-error breaker；
- 成本上界，或明确的 `unavailable` 状态与用户对绝对调用/Token 上限的接受；
- 临时 `DSH_HOME`、临时 Workspace 与显式结果输出路径。

用户批准文档设计或 D2-A 代码不构成 D2-B 授权。D2-B 必须由用户单独执行批准动作；程序、Gemini、Sol 和插件均不得替用户批准。

## 三、冻结输入与公开接口

D2 Runner 只接受以下已验证对象，禁止从 CURRENT、默认配置或“最新文件”猜测：

1. `ProviderCompatibilityAudit`；
2. `RealCanaryPlan`；
3. `RealCanaryAuthorizationRequest`；
4. `RealCanaryApprovalReceipt`；
5. M0.5D-v2 Fixture Manifest；
6. M0.5E Canary Plan；
7. 显式 `now`、隔离根目录、输出路径与 Credential Reference。

Provider 必须使用 `@deepseek-ai/dsh-llm-deepseek@0.1.0-rc.8` 根导出的公开 `apply` 路径注册到隔离 Cordis `LlmRuntime`，既有 Agent Loop 通过只委托公开 `ctx.llm.stream` 的 evaluation adapter 使用该 route。`DeepSeekAdapter`/`resolveAdapterOptions` 只允许用于类型与配置审计，不允许由 Mnemosyne 提供接收明文密钥的 `resolveApiKey` 回调。禁止 deep import、复制官方内部实现、猴子补丁私有函数或自行实现第二套 HTTP/SSE Provider。

公开构造路径必须保持 DSH 语义：

- route 固定 `deepseek-official`；
- model 与 M0.5F1 Authorization 精确一致；
- `maxTokens=4096`；
- resolved retry policy 的 `maxRetries=0`；
- API Key 只在每次请求边界由 DSH Credential seam 解析；Mnemosyne 只保存受控 `credential_ref`，永不读取、缓存、记录或返回凭据值；
- 如果公开 API 无法满足这些约束，稳定 `blocked`，不得绕过。

## 四、冻结数据契约

全部对象严格拒绝未知字段、错误类型、非有限数字、未注册枚举、秘密、绝对用户路径和超限字符串。时间必须由调用方显式传入 RFC3339 UTC；禁止 `Date.now()` 默认值。Hash 覆盖除自身 Hash 字段外的完整 Canonical 对象。

### 4.1 `RealCanaryApprovalReceipt`

```yaml
schema_version: 1
approval_id: "approval_<规范输入 hash 派生>"
authorization_id: "auth_..."
authorization_sha256: "sha256_..."
decision: approved|rejected
decided_at: "显式输入"
subject_id: "受控本地操作者标识，不是姓名、邮箱或系统用户名"
accepted_runtime:
  provider_package: "@deepseek-ai/dsh-llm-deepseek"
  provider_package_version: "0.1.0-rc.8"
  provider_route: "deepseek-official"
  model: "deepseek-v4-flash"
accepted_limits:
  runs: 6
  task_calls: 24
  acquisition_calls: 6
  total_calls: 30
  max_output_tokens_per_call: 4096
  call_timeout_ms: 30000
  batch_timeout_ms: 600000
  automatic_retries: 0
  provider_error_circuit_breaker: 2
accepted_cost:
  status: verified|unavailable
  worst_case_upper_bound: "十进制定点字符串"|null
execution_root_sha256: "用户确认的持久证据根规范绝对路径之 SHA-256"
approval_sha256: "sha256_..."
```

规则：

- Approval 是新事实，不得修改 pending Authorization；
- `authorization_id` 与 `authorization_sha256` 必须精确指向实际 Authorization；
- accepted runtime/limits/cost 必须与 Authorization 逐字段一致，不允许扩大或静默缩小；
- `execution_root_sha256` 只绑定规范路径 Hash，不保存绝对路径正文；运行前显示实际路径与 Hash，由用户确认后写入 Approval；
- `decided_at` 必须落在 Authorization 的 `[created_at, expires_at)` 内；执行时 Authorization 也必须仍未过期；
- `rejected` 永远不能执行；`approved` 只授权一次固定 D2 Plan，不授权 D3 或其他模型；
- approval ID 确定性派生，不使用随机数；同输入同字节，同 ID 异内容 fail closed。

### 4.2 `RealCanaryExecutionClaim`

真实调用前必须先在 Approval 绑定的持久证据根中，以 no-overwrite 方式发布一次性 Claim：

```yaml
schema_version: 1
execution_id: "execution_<authorization/approval hash 派生>"
authorization_sha256: "sha256_..."
approval_sha256: "sha256_..."
execution_root_sha256: "sha256_..."
claimed_at: "显式输入，仍在 Authorization 有效期内"
claim_sha256: "sha256_..."
```

Claim 路径固定为 `claims/<execution_id>.json`，目录 0700、文件 0600。Claim 必须在任何 Credential resolve、网络、Receipt 或其他业务副作用之前原子创建；目标已存在即拒绝执行，绝不把旧批准当成断点续跑授权。Claim 一经创建不修改、不删除；即使随后崩溃，此次 Approval 也已消费，重新执行必须创建新 Authorization/Approval。用户拥有本机文件系统时可删除事实，但程序不得把删除后的状态宣称为可审计的一次性保证。

### 4.3 `RealCanaryReceipt`

Receipt 沿用 M0.5E 已验证证据字段，但创建新契约，不修改历史 `CanaryReceipt`：

```yaml
schema_version: 1
run_id: "..."
authorization_sha256: "sha256_..."
approval_sha256: "sha256_..."
plan_hash: "sha256_..."
provider: { provider: "deepseek-official", model: "..." }
evidence_kind: real_provider_canary
task_id: "..."
group: no_memory|tool_only|auto_inject
requested_seed: 101
seed_honored: false
claim_sequence: [1]
tool_calls: []
memory_events: []
recall_source: null|{...}
recall_context: null|{...}
recall_receipt: null|{...}
observed_memory_ids: []
retrieved_memory_ids: []
opened_memory_ids: []
adopted_memory_ids: []
model_call_count: 1..4
model: {严格 ModelReceipt}
usage: {model: {...}, retrieval_estimated_tokens: 0, acquisition_tokens: 0}
acquisition: {...}
duration_ms: "只用于观测，不进入 deterministic prefix"
success: true|false
canonical_hash: "sha256_..."
```

不得把真实证据标成 `adversarial_preflight` 或 `offline_fake_provider`。不得保存完整 Prompt、回复正文、命令、思考、Header、API Key 或原始异常。

### 4.4 `RealCanarySummary`

```yaml
schema_version: 1
status: real_provider_plumbing_pass|real_provider_plumbing_fail|real_provider_canary_aborted
authorization_sha256: "sha256_..."
approval_sha256: "sha256_..."
plan_hash: "sha256_..."
fixture_manifest_sha256: "sha256_..."
receipts: []
deterministic_prefix_bytes: "..."
ledger: {...}
reason_code: null|受控错误码
cleanup_clean: true|false
summary_sha256: "sha256_..."
```

`real_provider_plumbing_pass` 仅要求 6 个计划 Run 全部完成、协议有效、预算未超限、无熔断、隔离清理成功；任务本身成功率不作为 D2 plumbing pass 的充分或必要条件。任何协议损坏、身份漂移、越界、超时、Provider 错误熔断或清理失败输出 fail/aborted，不做自动重试。

## 五、执行顺序与失败语义

固定顺序：

1. 严格读取并验证 Audit、Plan、Authorization、Approval、Fixture；
2. 用显式 `now` 检查创建时间、批准时间与过期时间；
3. 从当前 `package.json`、lockfile 和公开根导出重新确认 rc.8、Provider route/model 和零重试 seam；
4. 验证用户显式提供的持久证据根，其规范路径 Hash 必须等于 Approval 的 `execution_root_sha256`；
5. 在任何 Credential/network 副作用前 no-overwrite 创建一次性 `RealCanaryExecutionClaim`；
6. 创建新的临时运行隔离根，复用 `prepareIsolationRoot`；
7. 通过 DSH Credential seam 装配官方 Provider；装配期不得解析凭据或联网；
8. 初始化 30-call Budget Ledger；每次模型调用还必须先原子 claim 调用预算；
9. 按 M0.5E 固定顺序运行 6 个 Run；不并行，不重试；
10. 每个完成调用先严格验证，再追加 Receipt；非法响应不得进入合法前缀；
11. 连续两个 Provider/协议错误立即熔断；
12. 批次结束后 dispose、清理临时运行隔离目录、验证零残留；
13. 生成 Summary 并安全写入持久证据根；
14. 任何阶段失败都不得自动开始 D3。

一次 D2 执行默认不支持断点续跑。中断后保留已验证的 Receipt 前缀与 abort Summary；再次执行必须创建新的 Authorization/Approval，避免重复消费旧授权。

## 六、隔离、持久化与脱敏

- 临时运行根与持久证据根分离；运行根包含全新的临时 `DSH_HOME`、Workspace，执行结束必须清理；两类根都拒绝目录自身或任一祖先 symlink；
- 不访问用户默认 DSH 状态；运行前后对用户目录和仓库工作区做指纹检查；
- 最终证据只允许写入 Approval 绑定的显式持久证据根；其规范绝对路径只用于本地验证，Approval 只保存 Hash；Claim/Receipt/Summary 目标必须不存在、祖先安全，文件权限 0600；同目录临时文件 + fsync + no-overwrite publish；
- output 只保存严格 Receipt/Summary，不保存 CredentialRef 的解析值；
- 所有错误对外只返回稳定 reason code；禁止回显绝对路径、Endpoint query、Header、Prompt、模型正文、凭据、环境变量值或底层响应体；
- 清理失败必须体现在 Summary，不能把失败伪装成 pass。

## 七、实现文件边界

建议新增：

```text
src/m05d2/approval.ts
src/m05d2/provider-factory.ts
src/m05d2/runner.ts
src/m05d2/persistence.ts
src/m05d2/index.ts
tests/m05d2.spec.ts
scripts/m05d2-real-canary.ts
```

允许最小修改：

- `tests/pack-check.mjs`：增加 D2 evaluation-only 符号禁止泄漏；
- `package.json`：只增加本地 evaluation script，不能改变生产 exports/files/dependencies；
- 本任务文档状态行。

禁止修改：

- `src/index.ts`、`cordis.patch.yml`、生产插件导出；
- M0.5A～F1 Fixture、golden、Canonical Bytes、Receipt；
- DSH 依赖版本和 lockfile；
- Architecture v1 的协议正文（只允许既定状态行更新）；
- README、发布版本与 Tag。

若复用 M0.5E Runner 需要改变历史 `evidence_kind` 或 Canonical Schema，不修改旧代码契约；提取共享的内部纯函数，或在 D2 新模块中做最小组合。禁止复制第二套宽松验证器。

## 八、TDD 失败矩阵

先写失败测试并保存修复前证据，至少覆盖：

1. Authorization 无 Approval、Approval=rejected、Hash/ID 不匹配、过期、未来批准 → 零请求；
2. Approval runtime/limits/cost 与 Authorization 任一漂移 → 零请求；
3. rc.8 package/lock/route/model/Fixture/M0.5E Plan 任一漂移 → stable blocked；
4. Provider 只能从根导出构造，deep import 或私有 seam 不存在于源码；
5. 装配阶段 credential resolve=0、network=0；
6. Fake real-run 计划严格 6 runs，顺序与 seed=101 固定；
7. 每次调用先 claim；任务≤24、acquisition≤6、总调用≤30；
8. 可重试错误也只调用一次；`automatic_retries=0`；
9. 单次 30 秒、批次 10 分钟超时可注入 Fake Clock 测试；
10. 连续 2 错熔断；非连续错误不误熔断；
11. 非法 JSON、未知字段、错误 task/run/provider/model、超大输出、缺 Usage → 不进入合法 Receipt 前缀；
12. Receipt 使用 `real_provider_canary`，不会伪装成离线证据；
13. pass/fail/abort Summary 的严格 Schema、Hash、合法前缀与确定性字节；
14. Prompt、回复、Secret、Authorization Header、绝对路径、原始 Provider 错误不进入 Receipt/Summary；
15. 持久证据根 Hash 不匹配、output symlink、祖先 symlink、已存在文件、权限过宽、写入失败 → 零覆盖、稳定失败；
16. 隔离目录创建/销毁、外部零写入、用户状态指纹不变；
17. ExecutionClaim 在任何 Credential/network 前 no-overwrite 发布；重复执行旧 Approval 被拒绝；中断后不得自动续跑；
18. `src/index.ts`、dist、tarball 五文件无 D2 runner/fixture/provider/approval 符号；
19. 所有实现测试使用 Fake Adapter/Transport，真实 Provider endpoint 调用计数为 0；
20. 未获用户批准时，任何脚本默认行为都是打印 preflight/blocked，不能开始调用。

## 九、自动门禁与人工边界

D2-A 实现后运行：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm exec vitest run tests/m05d-d0.spec.ts tests/m05e.spec.ts tests/m05f.spec.ts tests/m05d2.spec.ts
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check
```

还必须扫描：

```bash
rg -n "process\.env|api[_-]?key|authorization:|bearer |BEGIN .*PRIVATE KEY|/src/" src/m05d2 tests/m05d2.spec.ts scripts/m05d2-real-canary.ts
rg -n "m05d2|real_provider_canary|RealCanaryApprovalReceipt|DeepSeekAdapter" dist dsh-mnemosyne-*.tgz
```

第一条命中只能是明确的禁止项/安全 Fixture，不得含真实值；第二条必须零命中。

D2-A 全绿并经普通 Review + Security Review 后停止。Sol 必须确认：

- 代码测试没有真实请求；
- Approval 不能被程序自行生成；
- Provider 与 Credential 路径只用 rc.8 公开 seam；
- 预算、超时、熔断、隔离、脱敏和 no-overwrite 都由失败测试锁定；
- tarball 仍为五文件。

随后用户单独批准并亲自触发 D2-B。未经该批准，不得请求 API Key，不得指导 Gemini 自动执行真实 Canary。

## 十、Gemini 3.7 Flash 完整执行提示词

```text
你是实现工程师，使用 Gemini 3.7 Flash。工作目录：
/Users/czy/Desktop/demo/dsh-Mnemosyne

执行 M0.5D-D2-A：真实 Provider Canary 的离线执行桥与双重授权门禁。你只实现和离线测试，不执行真实 Provider Canary。

开始前完整读取：
1. docs/DSH_MNEMOSYNE_M05D2_REAL_CANARY_PLAN.zh-CN.md
2. docs/DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md 第 19.14～19.16 节
3. docs/DSH_MNEMOSYNE_M05F1_PLAN.zh-CN.md
4. src/m05e/index.ts、src/m05d/index.ts、src/m05f/**、src/protocol/**
5. tests/m05e.spec.ts、tests/m05f.spec.ts、tests/pack-check.mjs
6. package.json、pnpm-lock.yaml、git status、提交 0a5fa6f
7. 已安装 rc.8 包的公开根导出与 .d.ts；不得读取或依赖包内私有实现

先明确报告假设、文件边界与成功标准。不得覆盖用户已有修改。严格按计划文档第二～九章执行；每个行为先写失败测试、实际运行并展示修复前失败证据，再做最小实现。

最高优先级边界：
- 本任务禁止真实 Provider 请求、真实 API Key、真实 Credential resolve、模型费用和用户状态访问。
- 禁止读取 process.env、默认 DSH_HOME、用户 Profile/Session/Workspace、.credentials.yaml、Keychain。
- 禁止 fetch/http/https/net 访问模型端点；测试必须使用 Fake Adapter/Transport 和 Fake Clock。
- 只使用 DSH 0.1.0-rc.8 官方公开包、根导出和 Credential seam；禁止 /src/*、私有路径、复制官方 Provider、Monkey Patch、Desktop IPC 或 UI 自动化。
- 不创建真实 approved Approval Receipt；测试只能用明显 synthetic fixture。不得替用户批准，不得执行 D2-B。
- 不输出 real_provider_plumbing_pass/fail 作为真实结论，不输出 GO/ADJUST/STOP，不宣称记忆质量提升。
- 不升级依赖，不改 M0.5A～F1 Fixture/golden/Canonical/Receipt，不改 src/index.ts、cordis.patch.yml 或生产包边界。

实现顺序：
1. 实现严格 RealCanaryApprovalReceipt：新事实、精确绑定 Authorization、显式时间、确定性 ID/Hash、approved/rejected、accepted runtime/limits/cost 全等校验。
2. 实现 rc.8 官方 Provider 桥。优先用官方根导出 `apply` 把 Provider 注册到隔离 Cordis `LlmRuntime`，再由一个只委托公开 `ctx.llm.stream` 的 evaluation adapter 接入既有 Agent Loop；不得由 Mnemosyne 实现接收明文密钥的 `DeepSeekAdapter.resolveApiKey` 回调。只有审计证明完全由 DSH Credential seam 持有密钥时才可继续。maxTokens=4096、maxRetries=0；构造/测试阶段 credential resolve 必须为 0。
3. 实现 D2 Runner，复用 M0.5E 固定 6-run Plan、Budget Ledger、严格 Agent Loop 和证据验证；新建 real_provider_canary Receipt/Summary，不篡改历史 adversarial_preflight 协议。
4. 实现 24 task + 6 acquisition + 30 total 的先 claim 上限、0 retry、30 秒 call timeout、10 分钟 batch timeout、连续 2 错熔断和合法前缀语义。
5. 实现 Approval 绑定的持久证据根、调用前一次性 RealCanaryExecutionClaim、0600 no-overwrite 安全持久化、祖先 symlink 拒绝、临时隔离创建/销毁与用户状态零写入证明。
6. 实现 evaluation-only 脚本，但默认只能验证/打印 preflight；没有合法 approved Receipt 时必须零请求退出。不得在测试或本任务中走真实执行分支。
7. 更新 pack-check，证明 src/index.ts、dist 和 tarball 五文件不含 D2 符号。

若官方 rc.8 公开 seam 无法实现 Credential 边界、零重试或 Adapter Factory，立即稳定 blocked；不得通过 deep import、读取环境、自己写 HTTP Provider 或放宽 Schema 绕过。

运行全部门禁：
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm exec vitest run tests/m05d-d0.spec.ts tests/m05e.spec.ts tests/m05f.spec.ts tests/m05d2.spec.ts
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check

实现完成后必须先自行做两轮审查：
第一轮普通 Review：逐项对照任务文档，检查状态机、身份/Hash 绑定、失败语义、并发/幂等、旧契约兼容和包边界；发现问题先补失败测试再修复。
第二轮 Security Review：专查凭据/环境读取、网络逃逸、重试绕过、预算超限、symlink/覆盖、路径与错误泄漏、Approval 伪造、测试误触真实 Provider；发现中高风险必须修完并重跑全部门禁。
只有两轮 Review 均无 blocking/should-fix 后，才向 Sol 提交交付报告。

交付报告必须包含：失败测试先行证据；实际修改文件；公开 Provider/Credential seam；Approval 绑定矩阵；调用预算/timeout/retry/breaker 测试；Receipt/Summary Schema；隔离/持久化/脱敏；Fake 计数（真实 network=0、credential resolve=0）；tarball 五文件；全部门禁；普通 Review 与 Security Review 的发现及修复；仍需用户执行的 D2-B 步骤。

不要 git commit、push 或创建 Tag。最终只能报告 real_canary_executor_ready_for_user_approval 或稳定 blocked，等待 Sol Review；不要执行真实 Canary。
```

## 十一、D2-B 用户实跑记录

2026-08-24 完成一次受用户明确授权的 D2-B3：

| 项目 | 结果 |
|---|---|
| Preflight | `ready`，Persistence Root 在执行前为空 |
| Plan SHA-256 | `sha256_6d1a668ca3175c688052033d04133d90be087d88dcf88227e927f584cd65ac4e` |
| Authorization SHA-256 | `sha256_fb6c35a43c851e3d5b39bfce5696f76bc6f767f903aca14560cdb4cdd338b774` |
| Approval SHA-256 | `sha256_d601fc15e954fbf1e5921c75a3da1b996dff75a05000a551923b09f5f3ac5d20` |
| Summary SHA-256 | `sha256_df637f1f4ee1d451178c3fc42f2981ef27b2919ee20c135b5ced00e86af25a22` |
| 最终状态 | `real_provider_plumbing_fail` |
| 稳定原因 | `circuit_open` |
| Ledger | task claimed=3、acquisition claimed=0、completed=0、failed=3、连续 Provider/协议错误=2 |
| Receipt | 0；不得形成质量证据 |
| 清理 | `cleanup_clean=true`；临时 Credential 已删除 |

本次执行严格保持 0 自动重试，并在连续两次 Provider/协议错误后熔断。持久化摘要按设计只保存稳定原因码，没有保存 Provider 原始异常，因此不能从该 Summary 判断是远端鉴权、模型路由、网络还是协议响应问题。原 Execution Claim 已落盘，禁止复用同一 Approval 重跑；任何诊断性重试必须先补充脱敏错误分类，重新生成 Authorization/Approval，并再次取得用户明确授权。D3 继续保持未授权、未执行。

D2-C 已在后续独立提交中补齐 `failure_diagnostics` 与 CLI 的去重 `failure_categories`，并保持旧 Summary 的原始键和 Hash 不变。诊断只使用 DSH rc.8 的稳定 `LlmFailure.code` 白名单与明确的本地验证阶段，不保存 message、body、status、requestId、Header、Prompt、回复或 Credential。该实现只使下一次获批执行具备可审计的脱敏分类能力，不反向猜测本次 D2-B3 的根因，也不构成新的真实调用授权。
