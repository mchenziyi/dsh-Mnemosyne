# dsh-Mnemosyne M0.5D-D2-C 开发计划：真实 Provider 脱敏失败诊断

> 状态：✅ 已实现并通过 CTO Review（2026-08-24）；`real_canary_diagnostics_ready`
> 前置结果：D2-B3=`real_provider_plumbing_fail/circuit_open`
> DSH 基线：全部公开包固定 `0.1.0-rc.8`
> 本阶段禁止真实 Provider 请求、禁止读取真实 Key、禁止创建 Approval、禁止自动重试 D2-B3

## 一、问题与目标

2026-08-24 的首个真实 D2-B3 在 3 个 task call claim、0 completed、0 Receipt 后触发熔断。现有 Summary 只保留：

```text
real_provider_plumbing_fail / circuit_open
```

它可以证明 fail closed、生效预算和清理正确，却不能区分远端鉴权、限流、网络、Provider 流协议、请求拒绝或本地模型输出 Schema 错误。

D2-C 的目标是新增一层**稳定、严格、脱敏、可持久化**的失败分类，使下一次获批执行能够回答“失败发生在哪个安全类别”，同时不扩大模型可见面、不保存任何 Provider 原始内容。

D2-C 不诊断已发生的 D2-B3，不猜测根因，不重新请求 API，不进入 D3。

## 二、设计假设与最小方案

### 2.1 可依赖事实

DSH rc.8 的 `LlmError` 提供稳定 `failure.code`，并可能携带 `status`、`providerRetryAfterMs`、`requestId`。D2-C 只允许读取 `failure.code`；禁止持久化或输出：

- `Error.message` / `failure.message`；
- HTTP body、SSE payload、Header；
- 精确 HTTP status；
- `requestId`、`providerRetryAfterMs`；
- Cause 链及其文本；
- Prompt、回复正文、Tool 参数、CredentialRef 的值或 Key。

精确 HTTP status 即使本身通常不敏感，也不是本阶段判断所必需，故不进入规范事实。

### 2.2 规范对象

在 `src/m05d2/diagnostics.ts` 新增纯函数与严格对象：

```text
SanitizedFailureDiagnostic
  schema_version: 1
  sequence: 1..30
  call_kind: task | acquisition
  stage:
    provider_stream
    task_output_validation
    acquisition_output_validation
    runner_protocol
  category:
    authentication_rejected
    rate_limited
    provider_timeout
    network_failure
    provider_protocol_error
    request_rejected
    provider_server_error
    model_output_schema_error
    runner_protocol_error
    unknown_provider_error
  provider_code: 允许的稳定 code | null
  content_sha256: sha256_...
```

对象必须经严格枚举、整数边界、未知字段拒绝与程序重算 Hash 校验。Canonical Bytes 对相同输入必须稳定。

`provider_code` 不是自由字符串。只允许以下已审核 code，未知 code 必须映射为 `provider_code=null + unknown_provider_error`，不得原样持久化：

```text
AUTH
INVALID_CREDENTIAL
MISSING_CREDENTIAL
RATE_LIMIT
QUOTA
TIMEOUT
TRANSPORT
MALFORMED_RESPONSE
STREAM_CLOSED
EMPTY_RESPONSE
INVALID_REQUEST
CONTEXT_WINDOW_EXCEEDED
UNSUPPORTED_CONTENT
UNSUPPORTED_REASONING_EFFORT
SERVER
ABORTED
```

不得根据 Provider message 做字符串匹配，不得增加穷举 Provider 文案。

### 2.3 分类映射

| DSH code / 本地阶段 | category |
|---|---|
| `AUTH|INVALID_CREDENTIAL|MISSING_CREDENTIAL` | `authentication_rejected` |
| `RATE_LIMIT|QUOTA` | `rate_limited` |
| `TIMEOUT` | `provider_timeout` |
| `TRANSPORT` | `network_failure` |
| `MALFORMED_RESPONSE|STREAM_CLOSED|EMPTY_RESPONSE` | `provider_protocol_error` |
| `INVALID_REQUEST|CONTEXT_WINDOW_EXCEEDED|UNSUPPORTED_CONTENT|UNSUPPORTED_REASONING_EFFORT|ABORTED` | `request_rejected` |
| `SERVER` | `provider_server_error` |
| task/acquisition 的模型正文严格验证失败 | `model_output_schema_error` |
| Runner 自身不变量失败 | `runner_protocol_error` |
| 其他 `LlmError.code` 或普通异常 | `unknown_provider_error` |

不能仅凭 `INVALID_REQUEST` 或未知 HTTP code 宣称 `model_unavailable`。官方 rc.8 没有提供足够的稳定机器事实时，必须保持更宽但真实的类别。

## 三、Runner 接入

### 3.1 记录时机

每次 `BudgetLedger.failedCall(sequence, error)` 的同一失败结算点创建一个 Diagnostic，且满足：

1. Diagnostic 数量不得超过 failed claim 数；
2. 同一 sequence 最多一个；
3. sequence/call_kind 必须与 Ledger claim 精确对应；
4. 熔断产生的未发起调用不得创建伪 Diagnostic；
5. `settleAllPendingAsFailed()` 产生的结算若没有对应底层错误，只能记 `runner_protocol_error`，不得复制上一错误；
6. Receipt 仍只在完整验证和持久化成功后进入前缀，Diagnostic 不得被当成 Receipt 或质量证据。

为避免把所有 `ProtocolValidationError` 都误标为模型输出错误，必须在两个明确边界包装稳定内部错误：

- `validateModelReceipt` 及相关最终 assistant 输出验证；
- `validateAcquisitionCandidate` 及对应 usage/文本闭合验证。

其他协议失败归为 `runner_protocol_error`。

### 3.2 Summary 扩展与兼容

`RealCanarySummary` 新增：

```text
failure_diagnostics: SanitizedFailureDiagnostic[]
```

新 Runner 必须始终输出显式数组。为读取 D2-C 前的历史 Summary，Validator 允许字段缺失并在类型层视为可选（调用方使用 `?? []`），保持 Legacy 原始对象键与 Hash 原样不变；新编码路径不得省略。旧 Summary 的既有 Canonical Bytes/Hash 不得被静默重写。

规则：

- success：数组必须为空；
- fail/aborted：数组可为空（例如 pre-provider blocked）或包含已失败 call 的诊断；
- 每个 Diagnostic 的 sequence 唯一、升序；
- Diagnostic sequence 必须对应 Ledger 的已失败 claim；
- `failure_diagnostics.length <= ledger.failed_calls`；
- Summary Hash 覆盖完整 Diagnostic 数组。

执行 CLI 的 JSON 输出只增加：

```text
failure_categories: string[]
```

该数组去重排序，不输出 provider code、stage、sequence 或任何原始异常。完整 Diagnostic 仅存在于 0600 Summary。

## 四、安全与包边界

1. 分类器必须是纯函数，不读取环境、文件、网络或墙钟；
2. 错误输入不得通过 `%q`、模板字符串或 `String(error)` 回显；
3. 测试使用包含假 Key、绝对路径、Prompt、命令、Header、Provider body 的恶意 message/cause，所有输出与 Canonical Bytes 必须零命中；
4. `diagnostics.ts`、D2 Runner、CLI 和测试继续是 evaluation-only；不得从 `src/index.ts` 导出；
5. `dist/index.mjs`、`dist/index.d.mts`、npm tgz 必须零命中 Diagnostic 类型名、分类枚举和执行 CLI 符号；
6. 不修改 DSH 依赖版本、Fixture/golden、生产插件配置或用户数据；
7. 不读取本次已删除的 Credential，不访问真实 Provider endpoint。

## 五、TDD 验收矩阵

必须先写失败测试，至少覆盖：

1. 上述 code→category 全矩阵；
2. 未知 code、普通 Error → `unknown_provider_error` 且 provider_code=null；
3. task/acquisition 输出 Schema 错误分别落在正确 stage；
4. Runner 协议错误不误标模型输出；
5. message/cause/requestId/路径/Key/Prompt/命令永不进入对象、CLI 输出或 Canonical Bytes；
6. Diagnostic strict decode：未知字段、未知枚举、错误 sequence/hash 拒绝；
7. 同 sequence 重复、非升序、超 Ledger、success 非空拒绝；
8. 三个失败 claim 可产生最多三个 Diagnostic，breaker 仍严格在连续两错后打开；
9. pre-provider blocked 保持零 Diagnostic、零 claim、零网络；
10. 旧 Summary 缺字段可读且保持原对象/Hash 不变（调用方使用 `?? []`），旧字节/Hash golden 不变；
11. 新 Summary 的 diagnostics 参与 Hash，篡改必拒绝；
12. Fake AUTH/TRANSPORT/MALFORMED_RESPONSE/模型输出错误端到端摘要与 CLI 类别正确；
13. pack-check 同时扫描 JS/DTS/tgz，证明 evaluation-only 代码零泄漏；
14. 全部既有测试不回归；最终全仓 325 项测试通过。

## 六、门禁与提交边界

实现完成后必须依次运行：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm exec vitest run tests/m05d2-diagnostics.spec.ts tests/m05d2-runner.spec.ts tests/m05d2-execute-cli.spec.ts
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check
```

若既有 5 秒用例偶发超时，必须报告首次失败并单独复跑；不得增加全局 timeout，不得把后续命令成功伪装为全门禁通过。

Gemini 不得 commit、push、tag。Codex Review 关闭全部 blocking/should-fix 后，由 Codex 单独提交。D2-C 完成后状态只能是：

```text
real_canary_diagnostics_ready
```

不得自动生成新 Authorization/Approval，不得真实重试 D2-B3，不得进入 D3。

## 七、Gemini 3.7 Flash 执行提示词

```text
你是实现工程师 Gemini 3.7 Flash。工作目录：
/Users/czy/Desktop/demo/dsh-Mnemosyne

完整阅读：
- docs/DSH_MNEMOSYNE_M05D2_C_DIAGNOSTICS_PLAN.zh-CN.md
- docs/DSH_MNEMOSYNE_M05D2_REAL_CANARY_PLAN.zh-CN.md
- docs/DSH_MNEMOSYNE_M05D2_B_EXECUTION_PLAN.zh-CN.md
- src/m05d2/runner.ts
- src/m05d2/persistence.ts
- scripts/m05d2-execute-real-canary.ts
- src/m05e/index.ts 中 BudgetLedger
- @deepseek-ai/dsh-llm rc.8 的公开 LlmError 类型声明

严格只实现 D2-C。先写失败测试并保留修复前失败证据，再做最小实现。不得根据 Error.message、Provider body 或自由文本分类；只允许使用计划冻结的 LlmError code 白名单和明确的本地验证 stage。

硬边界：
1. 禁止真实 Provider 请求、禁止读取任何真实 Key、process.env、默认 DSH_HOME、Profile、Session、Keychain 或已持久化的真实 D2-B3 工件。
2. 不修改 Architecture v1、DSH 版本、Fixture/golden、生产插件导出或根 src/index.ts。
3. 旧 Summary 必须向后兼容；新 Runner 必须显式生成 failure_diagnostics，Summary Hash 必须覆盖它。
4. 不保存/输出 Error.message、failure.message、HTTP body/status、Header、requestId、retryAfter、cause、Prompt、回复、Tool 参数或 Credential 值。
5. 熔断、Claim-before-network、Receipt 前缀、零重试和清理语义保持不变。
6. evaluation-only 符号不得进入 dist/tgz；增强 pack-check 锁定。
7. 不用全局 timeout 掩盖慢测；所有门禁必须按退出码逐项确认。

完成实现和门禁后，先自行做一次普通 Review，再做一次 Security Review：逐项检查分类绕过、错误文本泄漏、unknown code、重复 sequence、Summary Hash、Legacy 兼容、包泄漏与无真实网络。发现问题先补失败测试再修复，直到无 blocking/should-fix。

禁止 commit、push、tag。最终报告必须包含：修改文件、失败测试先行证据、分类矩阵、Summary 兼容策略、泄漏攻击测试、Fake 端到端结果、pack 扫描、全部门禁、自审修复项和残余风险。最终状态只能是 real_canary_diagnostics_ready 或稳定 blocked。
```
