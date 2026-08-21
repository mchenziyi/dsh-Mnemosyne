# M0.5D-D2-A CTO Review 修复计划

> 状态：🟡 待 Gemini 3.7 Flash 执行  
> 基线：`main@5faa271`  
> 上位设计：`docs/DSH_MNEMOSYNE_M05D2_REAL_CANARY_PLAN.zh-CN.md`  
> 边界：只修 D2-A 离线执行桥；禁止真实 Provider、凭据、网络、费用与 D2-B

## 一、Review 结论

首版代码的旧功能门禁通过，但不能签收。现有实现允许 Fake Adapter 产生 `real_provider_canary`，真实 Provider bridge 未接入 Runner；跨对象绑定、一次性 Claim 与严格 Receipt/Summary 验证也不成立。修复前不得提交实现，不得把状态写成 `real_canary_executor_ready_for_user_approval`。

## 二、必须修复的 P0

### P0-1：Fake 不得形成真实证据

- 生产 `runRealCanaryD2` 删除公开 `adapterFactory` 注入；未传 factory 时也不得回退 M0.5D Fake。
- 生产入口必须自行创建、使用并销毁官方 Provider bridge。
- Fake harness 必须与生产入口隔离，不能从 `src/m05d2/index.ts` 导出，且只能输出 `adversarial_preflight`/测试专用状态，绝不能产生 `real_provider_canary`、`real_provider_plumbing_pass|fail` 或持久化真实 Receipt。
- 测试必须证明任意 Fake 无法调用真实证据构造/持久化路径。

### P0-2：官方 Provider 与 Credential seam 必须真实接通

- 只用 rc.8 根导出 `apply` 注册 `@deepseek-ai/dsh-llm-deepseek` 到隔离 Cordis `LlmRuntime`。
- Agent Loop 通过只委托公开 `ctx.llm.stream` 的 evaluation adapter 使用已注册 route。
- `apiKeyEnv` 必须来自已绑定 `RealCanaryPlan.runtime.credential_ref`，不得忽略、默认或接受调用者另传漂移值。
- Mnemosyne 不得实现接收明文密钥的 `resolveApiKey` 回调。
- 必须挂载 DSH 公开 Credential seam；若 rc.8 不能在隔离环境禁止 `process.env`/默认用户状态回退，稳定 `blocked`，不得自行读取环境或实现第二套凭据服务。
- bridge 的创建、调用和 dispose 必须进入生产 Runner 生命周期；dispose 错误不能吞掉，必须变成 `cleanup_failed`。

### P0-3：一次性 Claim 身份必须稳定

- `execution_id` 只能由 `authorization_sha256 + approval_sha256 + execution_root_sha256` 派生。
- `claimed_at` 进入 Claim 内容与 `claim_sha256`，但不得进入 `execution_id`。
- 同一 Approval 在不同 `now`、不同进程中都必须命中同一目标。
- Claim 必须在 Credential resolve、Provider stream、Receipt 和其他业务副作用之前完成。

### P0-4：Claim 必须原子 no-overwrite

- 禁止 `lstat(target) → rename(temp,target)`；rename 会覆盖竞态目标。
- 使用同目录临时文件（0600）完整写入、fsync，再以 `link(temp,target)` 或等价原子 no-overwrite 机制发布；`EEXIST` 稳定拒绝；最后删除临时文件并 fsync 目录。
- 逐组件验证持久根与子目录：拒绝 symlink、非目录、group/other 权限；新目录 0700。
- 所有写路径都必须复用同一安全实现，禁止 recursive mkdir 静默穿透。

### P0-5：执行世界必须完整绑定

新增一个统一的 `validateExecutionWorld`，在 Claim 前验证：

```text
audit.decision == compatible
plan.status == dry_run_validated
plan.compatibility_audit_sha256 == audit.audit_sha256
plan.fixture_manifest_sha256 == 实际加载 Fixture Manifest Hash
plan.m05e_canary_plan_sha256 == 实际重建的 M0.5E Plan Hash
authorization.compatibility_audit_sha256 == audit.audit_sha256
authorization.canary_plan_sha256 == plan.plan_sha256
authorization.fixture_manifest_sha256 == plan.fixture_manifest_sha256
authorization.runtime == plan.runtime 去除 credential_ref 后的对应字段
authorization.limits == plan.limits 对应字段
approval == authorization/plan 的 runtime、limits、cost 与 root 绑定
当前 package.json/lockfile/公开 route/model 仍与 rc.8 Audit 一致
```

任一对象为 blocked、Hash 漂移、Fixture 漂移、模型漂移或版本漂移时，必须在 Claim/credential/network 前零副作用失败。

## 三、必须修复的 P1

### P1-1：生产限额不可覆盖

- 生产 Runner 不接受任意 `timeouts`；固定使用已批准的 30000/600000。
- 测试使用 Fake Clock/调度器推进冻结时间，不得通过缩小或扩大生产限额测试。
- 调用预算固定 24 task + 6 acquisition = 30 total，0 retry，连续 2 错熔断。

### P1-2：Receipt 必须深度严格验证

必须验证而不只是重算 Hash：

- run/task/group/provider/model/authorization/approval/plan 身份；
- claim_sequence 非空、递增、无重复，且与 model/acquisition call 数一致；
- tool_calls、memory_events、四类 memory ID 数组的类型、上限、去重与允许关系；
- Recall source/context/receipt 闭包；
- `validateModelReceipt`、`validateUsage`；
- acquisition 固定字段、provider_calls 与 candidate hash；
- duration/success 与任务断言；
- 禁止秘密、绝对路径、Prompt、原始回复和 Header。

### P1-3：Summary 必须锁定状态矩阵

- 深度验证 Ledger 所有字段、非负整数与算术关系；
- 每个 Receipt 必须绑定 Summary 的 Authorization/Approval/Plan/Fixture 世界；
- `deterministic_prefix_bytes` 必须等于剔除 duration/hash 后合法 Receipt 前缀的 Canonical Bytes；
- pass 当且仅当 6 个计划 Run 身份完整、reason=null、cleanup=true、Ledger 无 pending/越界；
- fail/aborted 必须携带匹配失败点的受控 reason；禁止零 Receipt + pass；
- Summary Hash 覆盖完整严格对象。

### P1-4：持久化入口必须自行验证

- `persistReceipt`/`persistSummary` 写前调用严格验证器；
- 文件名只接受生成并验证过的受控 ID；拒绝 `/`、`..`、绝对路径与未知字符；
- 写入失败不得让内存 Receipt 被当作已持久化合法前缀；
- Summary 写入失败必须 fail loud，并保留 Claim，不自动重试旧 Approval。

### P1-5：Preflight 不能是硬编码打印器

- 脚本必须读取并严格验证实际 Audit/Plan/Authorization 与持久证据根；
- 输出精确 ID/Hash、provider/model、6/24/6/30、4096、30s/10m、0 retry、breaker=2、成本状态与 root hash；
- 默认只做 preflight，零 Credential resolve、零网络；
- Approval 创建必须是独立、显式用户动作。Runner 不得自行调用 Approval 构造器。

## 四、TDD 修复矩阵

每项必须先失败后转绿：

1. Fake Adapter 无法形成或持久化真实 evidence/status；
2. 生产 Runner 确实创建并调用 official bridge；bridge 未接入时 blocked；
3. credential_ref 被精确使用；环境/default state 回退 trap 触发即 blocked；
4. 同 Approval 不同 `claimed_at` 生成相同 execution_id；
5. 两 goroutine 与两个子进程并发 Claim 恰好一个成功，既有字节零覆盖；
6. 中间/祖先/目标 symlink、0755 目录、外部目录均零写入；
7. Audit/Plan/Auth/Approval/Fixture/M0.5E Plan 每个 Hash 或状态单独漂移均在 Claim 前失败；
8. blocked Audit/Plan 永不执行；
9. timeout 不可由生产调用者修改；Fake Clock 覆盖 30s/10m；
10. 可重试错误只有一次请求；预算上限与 breaker 精确；
11. Receipt 每个嵌套字段逐项篡改并重算 Hash仍被拒绝；
12. Summary 的零 Receipt pass、错误 Ledger、错误前缀、跨 Receipt 身份、状态/reason 矛盾均拒绝；
13. persistReceipt/Summary 路径注入与无效对象零写入；
14. dispose 失败进入 cleanup_failed；临时隔离与用户状态指纹正确；
15. Preflight 读取真实事实但 network/credential 计数仍为 0；
16. `src/index.ts`、dist、tarball 五文件无 D2 符号。

## 五、门禁与交付

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

实现完成后先自行进行普通 Review 与 Security Review；发现问题必须补失败测试后修复并重跑全部门禁。不要提交、推送或创建 Tag。最终只能报告 `real_canary_executor_ready_for_user_approval` 或稳定 `blocked`，等待 Sol Review。
