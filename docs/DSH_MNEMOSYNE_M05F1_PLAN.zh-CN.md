# dsh-Mnemosyne M0.5F1 开发计划：公开 Provider 兼容性审计、零调用 Dry-run 与授权门禁

> 状态：🟡 设计完成，待 Gemini 3.7 Flash 实现与 Sol Review  
> 基线：`main@670cfe7`，DSH `0.1.0-rc.8`  
> 架构事实源：`docs/DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md` 第 19.16 节  
> 本阶段唯一允许终态：`real_canary_ready_for_user_approval` 或稳定 `blocked`

## 一、目标与非目标

M0.5F1 只证明以下链路可以在 DSH rc.8 的公开扩展面上安全规划：

```text
公开包/导出审计
→ 隔离 Profile 零调用装配
→ Fake Credential + Counting Fake Transport 验证
→ 固定 RealCanaryPlan
→ pending RealCanaryAuthorizationRequest
```

完成本阶段不代表真实模型联调已经通过，也不授权任何真实调用。

本阶段必须做到：

1. 仅使用 DSH rc.8 公开包、根导出和 Cordis 服务；
2. 对 Provider route、模型、凭据引用、重试策略、输出上限和隔离能力给出可复核审计；
3. Dry-run 中真实 Provider 请求数、凭据解析数、网络调用数均为 `0`；
4. 使用 Counting Fake 证明一次成功 claim 最多对应一次请求；
5. 生成不可变、确定、可过期的 pending 授权请求；
6. evaluation-only 代码和 Provider 包不进入生产导出与 tarball。

本阶段明确不做：

- 不调用 DeepSeek 或任何其他模型 Provider；
- 不读取 `process.env`、API Key、Authorization Header、默认 `DSH_HOME`、用户 Profile、Session、Workspace、`.credentials.yaml` 或 Keychain；
- 不生成 approved Receipt，不执行 D2，不解析模型回复；
- 不产生 `GO|ADJUST|STOP`、质量结论或真实 Canary Receipt；
- 不升级任何现有 DSH 包，不改 M0.5A～E Fixture、golden、Canonical Bytes 或 Receipt；
- 不从 `src/index.ts` 导出本阶段模块，不修改生产 `cordis.patch.yml`。

## 二、已确认的 rc.8 公共事实与必须复核的假设

Sol 在设计阶段从 npm 官方 Registry 与 rc.8 包公开类型确认：

- `@deepseek-ai/dsh-llm-deepseek@0.1.0-rc.8` 存在，根导出包含 `Config`、`resolveAdapterOptions`、`DeepSeekAdapter`、`apply`；
- 官方 route 文档为 `deepseek-official`；
- `Config` 公开 `apiKeyEnv`、`models`、`maxTokens`、`retryPolicy` 等字段；
- Provider 默认 `maxTokens=256000`，默认 retry policy 为 normal + 5 次重试，均不满足本阶段边界，必须显式覆盖；
- `@deepseek-ai/dsh-llm` 根导出公开 `LlmRuntime`、`LlmAdapter`、`registerAdapter`、`prepareCall`/stream 相关契约及 retry policy 类型；
- Provider 的 Credential seam 是 `@deepseek-ai/dsh-credentials`，但 Mnemosyne 不拥有凭据值。

这些只是设计输入，不是代码中的硬编码真相。实现开始时必须从实际安装的 rc.8 根导出、package.json、类型和运行时 Smoke 重新验证。若任何事实不成立，输出稳定 `blocked`，不得 deep import、复制私有源码或升级版本绕过。

## 三、冻结数据契约

所有对象使用严格对象校验：拒绝未知字段、错误类型、非有限数字、未注册枚举、绝对路径、秘密字段和超限字符串。Canonical JSON 沿用项目现有实现；数组按规定稳定排序；Hash 覆盖除自身 Hash 字段外的完整对象。所有时间均由调用方显式传入 RFC3339 UTC 字符串，禁止 `Date.now()`。

### 3.1 `ProviderCompatibilityAudit`

```yaml
schema_version: 1
audited_at: "2026-08-21T00:00:00Z"
project_dsh_version: "0.1.0-rc.8"
project_lock_sha256: "sha256_..."
official_reference:
  repository: "deepseek-ai/deepseek-harness"
  package: "@deepseek-ai/dsh-llm-deepseek"
  package_version: "0.1.0-rc.8"
  source_ref: "npm:@deepseek-ai/dsh-llm-deepseek@0.1.0-rc.8"
public_contracts:
  provider_plugin: pass|missing|incompatible
  provider_route: pass|missing|incompatible
  model_catalog: pass|missing|incompatible
  credential_reference: pass|missing|incompatible
  isolated_profile: pass|missing|incompatible
  zero_retry_path: pass|missing|incompatible
  max_output_cap: pass|missing|incompatible
decision: compatible|blocked
reasons:
  - stable_reason_code
audit_sha256: "sha256_..."
```

规则：

- `decision=compatible` 当且仅当全部 `public_contracts=pass` 且 `reasons=[]`；
- `blocked` 原因只能使用受控错误码，不保存原始异常；
- Audit 构造器必须从实际 `package.json`、lockfile 与公开 Smoke 结果派生版本，禁止接受调用方注入“已解析包列表”绕过真实解析；
- `audited_at` 只参与事实记录，不参与任何联网判断。

### 3.2 `RealCanaryPlan`

```yaml
schema_version: 1
status: dry_run_validated|blocked
compatibility_audit_sha256: "sha256_..."
fixture_manifest_sha256: "sha256_..."
m05e_canary_plan_sha256: "sha256_..."
runtime:
  dsh_version: "0.1.0-rc.8"
  provider_package: "@deepseek-ai/dsh-llm-deepseek"
  provider_package_version: "0.1.0-rc.8"
  provider_route: "deepseek-official"
  model: "显式传入并经公开模型目录验证的模型 ID"
  credential_ref: "受控标识，不是凭据值"
limits:
  task_calls: 24
  acquisition_calls: 6
  total_calls: 30
  max_output_tokens_per_call: 4096
  call_timeout_ms: 30000
  batch_timeout_ms: 600000
  automatic_retries: 0
  provider_error_circuit_breaker: 2
runs:
  count: 6
  requested_seed: 101
plan_sha256: "sha256_..."
```

固定关系必须由校验器验证：

- `task_calls + acquisition_calls == total_calls`；
- `runs.count == 6`；
- 所有限额必须与上述冻结值完全一致，不允许“更大也算合法”；
- Audit 不是 `compatible` 时不得生成 `dry_run_validated` Plan；
- Provider、模型、Fixture、M0.5E Plan 或任一限额变化必须改变 `plan_sha256`。

### 3.3 `RealCanaryAuthorizationRequest`

```yaml
schema_version: 1
authorization_id: "auth_<由规范输入 hash 派生>"
status: pending_user_approval
created_at: "显式输入"
expires_at: "显式输入，严格晚于 created_at"
compatibility_audit_sha256: "sha256_..."
canary_plan_sha256: "sha256_..."
fixture_manifest_sha256: "sha256_..."
runtime:
  dsh_version: "0.1.0-rc.8"
  provider_package: "@deepseek-ai/dsh-llm-deepseek"
  provider_package_version: "0.1.0-rc.8"
  provider_route: "deepseek-official"
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
  currency: "USD"|null
  source_ref: "受控非秘密引用"|null
  source_checked_at: "显式时间"|null
  worst_case_upper_bound: "十进制定点字符串"|null
isolation:
  temporary_dsh_home: true
  temporary_workspace: true
  user_state_access: false
authorization_sha256: "sha256_..."
```

规则：

- 本阶段只允许 `pending_user_approval`；输入出现 `approved` 或 Approval Receipt 直接拒绝；
- `created_at`、`expires_at` 均显式传入，禁止默认时间；过期判断也必须接收显式 `now`；
- 成本未通过公开、固定来源验证时必须使用 `unavailable + null`，不得填 `0` 或猜测；
- authorization ID 由完整绑定输入 Hash 的稳定前缀派生，不使用随机数；
- Audit、Plan、Fixture、runtime 或 limits 任一不一致均 fail closed。

## 四、实现拆分与验证点

### F1-01：公开接口与依赖审计

先写失败测试，再实现最小审计器：

1. 解析当前 `package.json` 与 `pnpm-lock.yaml`，确认核心 DSH 仍全为 rc.8；
2. 通过包根导出加载 Provider，不允许 `@deepseek-ai/.../src/*`；
3. 核对 Provider package version、公开 route/config、模型目录、CredentialRef、retry 和 maxTokens seam；
4. 若运行时 Smoke 必须安装 Provider，只能将官方 Provider 及其必要官方 peer 以精确 rc.8 加入 `devDependencies`；不得进入 dependencies/peerDependencies；
5. 输出确定 `ProviderCompatibilityAudit`。

验证点：删包、版本漂移、缺导出、重复 route、未知模型、默认 5 retry、默认 256000 maxTokens 均使 Audit blocked。

### F1-02：零调用隔离 Profile

复用 `src/m05e/index.ts` 的 `prepareIsolationRoot`，不得另写弱化版路径创建器。只在新临时 root 中：

1. 装配最小 Cordis Context、LLM runtime 与 Provider 公开插件；
2. 使用 Fake Settings、Fake Credential seam 和 Counting Fake Transport/Adapter；
3. 配置 `maxTokens=4096`、retry policy 的 `maxRetries=0`；
4. 验证 route/model/配置解析和注册生命周期；
5. 不调用真实 `stream()`，不调用 credential resolve，不访问网络；
6. dispose 后所有 route/service/临时状态归零。

若官方 Provider `apply()` 在装载阶段强制读取环境、解析真实凭据或联网，则 Audit=`blocked`。禁止 monkey patch 私有函数绕过。

### F1-03：Claim 与零重试证明

用完全本地 Counting Fake 证明：

```text
successful_claims = 1
outbound_requests <= 1
automatic_retries = 0
```

这里的 outbound request 是 Fake adapter/transport 计数，不是网络请求。测试必须覆盖单次成功、单次失败、Provider 标记可重试错误三类；即使错误可重试，计数仍只能为 1。若公开路径无法关闭 retry，则 F1 阻断，不自行实现第二套 Agent Loop。

### F1-04：Plan 与 Authorization

严格实现 3.2/3.3 的构造、校验、Canonical 编码和 Hash。未通过 Audit 或 Dry-run 不得生成 pending Authorization。禁止任何落盘 approved 状态。

### F1-05：泄漏与副作用防线

测试期间对下列入口设置计数/陷阱，任一触发即失败：

- `fetch`、`http.request`、`https.request`、`net.connect`；
- Fake Credential Service 的 resolve；
- 真实 Provider adapter stream；
- `process.env` 值作为输入或输出；
- 默认用户 DSH_HOME、Workspace、Session、凭据文件读取；
- isolation root 外写入。

错误只输出稳定错误码和固定摘要，不拼接原始异常、包路径、CredentialRef 原值或用户路径。

### F1-06：打包边界

- `src/m05f/**` 不从 `src/index.ts` 导出；
- Provider 和 evaluation-only 模块不得进入 `dist/index.mjs`、类型声明或 tarball；
- 更新 `tests/pack-check.mjs` 与 `tests/bundle-manifest.spec.ts` 的禁止符号列表，而不是扩大 tarball 白名单；
- tarball 必须仍只有 `cordis.patch.yml`、两个 dist 文件、`package.json`、`README.md`。

## 五、建议文件边界

允许的最小范围：

```text
src/m05f/provider-audit.ts
src/m05f/authorization.ts
src/m05f/dry-run.ts
src/m05f/index.ts
tests/m05f.spec.ts
tests/pack-check.mjs
tests/bundle-manifest.spec.ts
package.json                 # 仅必要的精确 rc.8 evaluation-only devDependency
pnpm-lock.yaml              # 仅随上项变化
docs/DSH_MNEMOSYNE_M05F1_PLAN.zh-CN.md  # 仅状态行
```

禁止修改：

- `src/index.ts`、`cordis.patch.yml`；
- M0.5A～E 的 Fixture、golden、Canonical、Receipt 与测试预期；
- `docs/DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md`（实现期间只读）；
- 任一现有 DSH 依赖版本。

实现需要超出允许范围时停止并说明，不自行扩展。

## 六、TDD 失败矩阵

实现前至少写出并观察失败：

1. Provider package 缺失、非 rc.8 或 lockfile 不一致；
2. 根导出缺 Provider plugin/config/adapter；
3. Audit 状态与 contracts 不一致；
4. 重复 route、未知 route、未知模型、深路径导入描述；
5. retry 缺省为 5 或非零；
6. maxTokens 未显式固定为 4096；
7. 一次 claim 触发两次 Fake outbound request；
8. Dry-run 触发 Credential resolve、Provider stream 或任一网络入口；
9. 读取默认用户目录或 isolation root 外写入；
10. isolation root 已存在、祖先 symlink、非目录组件；
11. Plan 固定限额任一变化或关系不成立；
12. Authorization 未绑定 Audit/Plan/Fixture，或绑定 Hash 漂移；
13. 零值/隐式时间、过期、未来创建、非 pending 状态；
14. cost unavailable 时填 `0`、USD 或伪价格；
15. 输入包含秘密、Header、绝对路径、原始异常时输出不得泄漏；
16. 相同显式输入生成不同 Canonical Bytes/Hash；
17. dispose 后 route/service/临时资源残留；
18. evaluation-only 标识进入生产 export、dist 或 tarball。

必须同时保留所有既有测试，不允许用更新 golden、降低断言或删除用例来转绿。

## 七、自动门禁

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm exec vitest run tests/dsh-rc8-compat.spec.ts tests/m05d-d0.spec.ts tests/m05e.spec.ts tests/m05f.spec.ts
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check
```

还必须扫描：

```bash
rg -n "0\\.1\\.0-rc\\.[67]|minimumReleaseAgeExclude" package.json pnpm-lock.yaml pnpm-workspace.yaml
rg -n "api[_-]?key|authorization:|bearer |BEGIN .*PRIVATE KEY" src/m05f tests/m05f.spec.ts
```

第一条应零命中；第二条命中只能出现在明确的拒绝/脱敏测试 Fixture，不得出现在产物或报告值中。

## 八、完成与阻断标准

满足以下全部条件才报告 `real_canary_ready_for_user_approval`：

- Audit=`compatible`；
- 隔离 Profile Dry-run 通过；
- Credential resolve、真实 stream、网络调用均为 0；
- Counting Fake 证明零重试和 claim/request 上界；
- Plan 与 pending Authorization 严格、确定、可校验、可过期；
- 全部门禁通过；
- 普通 Review 与 Security Review 无 blocking/should-fix。

任一公开 seam 缺失、无法关闭重试、Provider 装载必须读真实凭据/联网、包版本发生漂移或文件边界无法维持时，报告稳定 `blocked`。不得用私有 API 或补丁绕过。

## 九、Gemini 3.7 Flash 完整执行提示词

```text
你是实现工程师，使用 Gemini 3.7 Flash。工作目录：
/Users/czy/Desktop/demo/dsh-Mnemosyne

执行 M0.5F1：DSH rc.8 公开 Provider 兼容性审计、零调用 Dry-run 与 pending 授权门禁。

开始前完整读取：
1. docs/DSH_MNEMOSYNE_M05F1_PLAN.zh-CN.md
2. docs/DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md 第 19.14～19.16 节
3. src/m05e/index.ts、src/protocol/canonical.ts、src/protocol/validation.ts
4. tests/m05e.spec.ts、tests/dsh-rc8-compat.spec.ts、tests/pack-check.mjs、tests/bundle-manifest.spec.ts
5. package.json、pnpm-lock.yaml、当前 git status 与提交 670cfe7

先显式报告假设和成功标准。不得覆盖用户已有修改。严格按任务文档 F1-01～F1-06 执行，每一项先写失败测试并展示失败证据，再做最小实现。

最高优先级边界：
- 全阶段禁止真实 Provider 请求、真实 API Key、真实 Credential resolve、模型费用和用户状态访问。
- 禁止读取 process.env、默认 DSH_HOME、用户 Profile/Session/Workspace、.credentials.yaml、Keychain。
- 禁止 fetch/http/https/net 访问任何模型端点。
- 仅允许 DSH rc.8 官方公开包和根导出；禁止 /src/*、私有路径、复制官方私有实现、Desktop IPC 或 Shell UI 自动化。
- 不执行 D2，不生成 approved Receipt，不输出 GO/ADJUST/STOP，不宣称模型质量提升。
- 不升级现有 DSH 包，不修改 Architecture v1、M0.5A～E Fixture/golden/Receipt、src/index.ts 或 cordis.patch.yml。

实施顺序：
1. 从实际 package.json、lockfile、rc.8 根导出与运行时 Smoke 构造 ProviderCompatibilityAudit。不得接受调用方注入虚假已解析依赖绕过真实解析。
2. 若公开 Smoke 必须安装 @deepseek-ai/dsh-llm-deepseek，只能以精确 0.1.0-rc.8 evaluation-only devDependency 加入；必要官方 peer 同样必须精确 rc.8。不得进入 dependencies/peerDependencies。
3. 复用 prepareIsolationRoot，装配隔离 Profile。使用 Fake Settings、Fake Credential 和 Counting Fake Transport/Adapter；不得调用真实 stream 或 credential resolve。
4. 显式固定 maxTokens=4096、automatic retries=0。用 Counting Fake 证明一次 successful claim 最多一次 outbound request；可重试错误也不得产生第二次请求。
5. 实现严格 RealCanaryPlan 与 RealCanaryAuthorizationRequest。所有时间显式输入，Hash 覆盖全部绑定字段；本阶段只允许 pending_user_approval；成本不确定时必须 unavailable/null。
6. 加网络/凭据/用户目录/外部写入陷阱与 dispose 后零残留断言。
7. 保持 evaluation-only：不从 src/index.ts 导出；更新 pack-check 与 bundle manifest 的禁止符号检查，tarball 仍为五文件。

遇到以下任一情况立即 blocked，不自行绕过：公开 Provider/Credential seam 缺失；Provider 装载阶段强制读真实凭据或联网；无法把 retry 证明为 0；需要 deep import；需要升级 rc.8；需要修改生产导出或既有 Fixture/golden。

运行全部门禁：
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm exec vitest run tests/dsh-rc8-compat.spec.ts tests/m05d-d0.spec.ts tests/m05e.spec.ts tests/m05f.spec.ts
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check

完成后做普通 Review 和 Security Review。报告必须包含：失败测试先行证据；实际使用的公开包/根导出/route/model/credential seam；Audit 决策；Dry-run 计数（真实 stream=0、credential resolve=0、network=0）；Counting Fake claim/request 结果；retry/maxTokens 覆盖证据；Plan/Authorization Canonical 与篡改/过期测试；隔离前后指纹；tarball 五文件；全部门禁；未读取凭据和用户状态声明。

不要 git commit、push 或创建 Tag。最终只能报告 real_canary_ready_for_user_approval 或稳定 blocked，等待 Sol Review。
```
