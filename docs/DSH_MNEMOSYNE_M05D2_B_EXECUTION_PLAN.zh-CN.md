# dsh-Mnemosyne M0.5D-D2-B 开发计划：真实 Canary 用户执行入口

> 状态：🟠 首轮实现已完成，等待 CTO Review 修复
> 前置提交：`77e4190`（D2-A 离线执行器已通过 CTO 独立验收）
> DSH 基线：全部公开包固定 `0.1.0-rc.8`
> 本文档不是模型调用授权；D2-B0/B1 全程必须保持零真实请求

## 一、阶段拆分

```text
D2-B0：公开 Credential 与执行入口设计（本文）
→ D2-B1：实现执行 CLI + Fake 端到端回归（零真实请求）
→ D2-B2：用户本地写入临时 Key + 生成 Approval + Preflight（零真实请求）
→ D2-B3：用户明确批准后运行固定 6-run 真实 Canary
```
D2-B1 完成后只能输出：

```text
real_canary_cli_ready_for_local_credential
```

不得输出 `real_provider_plumbing_pass|real_provider_plumbing_fail|GO|ADJUST|STOP`。

## 二、已确认的 rc.8 公开接口

### 2.1 Credential Service

- `@deepseek-ai/dsh-credentials@0.1.0-rc.8` 公开 `ctx.credentials`；配置只保存 `CredentialRef`，真实值由 Provider 持有；
- `resolve(ref)` 每个 Provider 操作重新调用，不跨请求缓存；
- `describe(ref)` 只返回 configured/source/writable，不返回值；
- `@deepseek-ai/dsh-credentials-local@0.1.0-rc.8` 是官方文件型 Provider，公开根入口；
- 该 Provider 支持显式 `path`、`watch:false`，以 0700 目录和 0600 文件读取受管 YAML；
- 严格文档格式为单层映射：`DEEPSEEK_API_KEY: <value>`；
- 官方 Provider 的同 UID 文件边界不是对模型的硬沙箱，因此本阶段只把文件放在独立临时目录，不向 Workspace、Prompt、Tool、Receipt 或日志披露路径。

### 2.2 DeepSeek Provider

- `@deepseek-ai/dsh-llm-deepseek@0.1.0-rc.8` 公开插件入口；
- 固定 route=`deepseek-official`、model=`deepseek-v4-flash`；
- `apiKeyEnv` 只是 CredentialRef；真实值由 `ctx.credentials` 每请求解析；
- 固定 `maxTokens=4096`、`retryPolicy.maxRetries=0`；
- Mnemosyne 不接收明文 Key，不自建 Provider、不直接 `fetch`。

## 三、D2-B1 范围

### 3.1 新增依赖

只新增精确 devDependency：

```json
"@deepseek-ai/dsh-credentials-local": "0.1.0-rc.8"
```

它只服务 evaluation-only 脚本，不得进入根插件导出、`dist` 或 npm tarball。

### 3.2 Approval CLI

新增：

```text
scripts/m05d2-create-approval.ts
```

输入必须全部显式：

```text
--authorization <absolute-json>
--persistence-root <absolute-existing-0700-dir>
--decision approved|rejected
--subject-id <controlled-id>
--now <RFC3339 UTC>
--output <absolute-new-json>
--json
```

规则：

1. 默认不批准；缺少 `--decision` 直接失败；
2. 使用 `createRealCanaryApprovalReceipt()`，不得复制宽松 Schema；
3. `execution_root_sha256 = sha256(normalize(resolve(persistence-root)))`；
4. 输出采用 canonical bytes、0600、同目录临时文件 + fsync + no-overwrite 发布；
5. `approved` 只创建 Approval Fact，不调用 Provider、不解析 Credential；
6. 输出只包含 ID、Hash、runtime/limits/cost 和路径无关状态，不输出 Key、完整路径或用户输入原文。

### 3.3 Execution CLI

保留现有 `scripts/m05d2-real-canary.ts` 为纯 Preflight；新增：

```text
scripts/m05d2-execute-real-canary.ts
```

执行 CLI 必须要求：

```text
--audit <absolute-json>
--plan <absolute-json>
--authorization <absolute-json>
--approval <absolute-json>
--persistence-root <absolute-existing-0700-dir>
--workspace-root <absolute-existing-dir>
--isolation-root <absolute-nonexistent-dir>
--credential-store <absolute-existing-0600-file>
--now <RFC3339 UTC>
--execute
--confirm-approval-sha256 <sha256_...>
--json
```

没有 `--execute` 时不得退化成隐式执行，必须稳定返回 `execution_not_confirmed`，网络、Credential resolve、Claim 均为 0。Preflight 继续由原脚本承担。

`--confirm-approval-sha256` 必须与已验证 Approval 完全一致；仅输入 `yes`、布尔开关或 Authorization ID 不足以执行。

### 3.4 Credential Provider 组合

执行 CLI 只能用官方 `@deepseek-ai/dsh-credentials-local` 创建显式 Provider plugin：

```text
path  = --credential-store
watch = false
```

硬约束：

1. Credential 文件必须位于独立临时目录，文件名固定 `.credentials.yaml`；
2. 祖先链拒绝任意 symlink；父目录必须 0700，文件必须 regular+0600；
3. Credential 目录不得等于或位于 Workspace 内；不得位于仓库内；
4. Mnemosyne 代码不得 `readFile` Credential 文件，不得解析 YAML，不得接收 Key 字符串；
5. 仅官方 LocalCredentialProvider 读取文件，并通过 `ctx.credentials` 向官方 DeepSeek Provider 提供值；
6. CLI 不读取 `process.env`、默认 `DSH_HOME`、用户 `.env`、Profile、Session、Keychain；
7. 测试只使用 synthetic Key 和 Fake transport，绝不访问 Provider endpoint。

### 3.5 执行顺序

固定顺序：

```text
严格读取并校验 4 个 JSON Fact
→ 校验 workspace/persistence/isolation/credential 路径
→ validateExecutionWorld（零 Credential/网络）
→ 校验 confirm hash
→ runRealCanaryD2
→ Execution Claim no-overwrite 落盘
→ 创建临时 isolation root
→ 安装 LlmRuntime
→ 安装官方 LocalCredentialProvider
→ 校验 ctx.credentials 完整性
→ 安装官方 DeepSeek Provider
→ 固定 6-run
→ Receipt 前缀逐个验证后持久化
→ Summary 持久化
→ dispose + isolation cleanup
```

Claim 必须继续发生在首次 Credential resolve 和首次网络请求之前。同 Approval/Execution 重跑必须因 Claim EEXIST fail closed。

### 3.6 输出边界

成功或失败输出只能包含：

- `status`；
- `authorization_sha256`、`approval_sha256`、`summary_sha256`；
- 完成 Receipt 数；
- Ledger 计数；
- `reason_code`；
- `cleanup_clean`。

禁止输出：Prompt、模型正文、推理、Tool 参数、命令、Header、Key、Credential source value、绝对路径、原始异常。

## 四、D2-B1 TDD 矩阵

必须先写失败测试，至少覆盖：

1. 缺 `--execute` → Claim=0、Credential resolve=0、network=0；
2. confirm hash 错误 → 三项均为 0；
3. Approval rejected/expired/漂移 → 三项均为 0；
4. Audit/Plan/Authorization/Fixture/Workspace 任一漂移 → 三项均为 0；
5. Credential 文件缺失、非 0600、目录非 0700、symlink、位于 Workspace/仓库 → Claim=0；
6. LocalCredentialProvider 缺失或服务不完整 → stable blocked；
7. synthetic Credential 只由官方 Provider seam 解析，Mnemosyne 不读取值；
8. Claim 在首个 resolve/network 前已持久化；
9. 相同 Approval 并发/重复执行恰好一个 Claim 胜者；
10. Fake 成功路径固定 6 Receipt、Ledger 不超 30、0 retry；
11. 2 个连续 Provider/协议错误熔断；
12. 单次 30s、批次 600s 超时不扩张预算；
13. 中途失败只保留合法 Receipt 前缀；
14. Summary/CLI 输出敏感信息扫描全绿；
15. dispose/cleanup 失败 fail loud，已发布证据不删除；
16. root `src/index.ts`、`dist/index.mjs`、`dist/index.d.mts`、tgz 不含 D2-B/credential-local 执行符号；
17. Approval CLI no-overwrite、0600、canonical bytes、非法 JSON/未知字段/绝对路径泄露拒绝；
18. 真实网络计数在全部自动测试中必须为 0。

## 五、自动门禁

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm exec vitest run \
  tests/m05d2-approval-cli.spec.ts \
  tests/m05d2-execute-cli.spec.ts \
  tests/m05d2-persistence.spec.ts \
  tests/m05d2-preflight.spec.ts \
  tests/m05d2.spec.ts
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check
```

Gemini 完成实现后必须自行执行普通 Review 与 Security Review；Codex 再做独立 Review。任何 blocking/should-fix 未关闭时不得提交。

## 六、D2-B2/B3 用户协作边界

D2-B1 验收后，Codex 创建全新的临时目录，并给用户一条只在本机终端执行的静默输入命令。用户不在聊天中粘贴 Key。Key 只写入临时 `.credentials.yaml`，随后由官方 Credential Provider 读取。

D2-B2 由 Codex 完成：生成 Authorization/Approval、运行零调用 Preflight、展示完整 Hash、固定 6-run/30-call/4096-token/timeout/retry/cost 边界。

D2-B3 只有在用户看到该次 Preflight 并明确回复批准后才执行。完成后：

1. 验证 Summary 与 Receipt；
2. 确认临时 isolation root 已清理；
3. 删除本次临时 Credential 文件和目录；
4. 提醒用户在 DeepSeek 控制台吊销临时 Key；
5. 不自动进入 D3。

## 七、Gemini 3.7 Flash 执行提示词

```text
在 /Users/czy/Desktop/demo/dsh-Mnemosyne 执行 M0.5D-D2-B1。先完整阅读：
- docs/DSH_MNEMOSYNE_M05D2_B_EXECUTION_PLAN.zh-CN.md
- docs/DSH_MNEMOSYNE_M05D2_REAL_CANARY_PLAN.zh-CN.md
- docs/DSH_MNEMOSYNE_M05D2_PERSISTENCE_REVIEW_FIXES.zh-CN.md
- scripts/m05d2-real-canary.ts
- src/m05d2/approval.ts
- src/m05d2/provider-factory.ts
- src/m05d2/runner.ts
- src/m05d2/persistence.ts

严格只实现 D2-B1：Approval CLI、真实执行 CLI、官方 LocalCredentialProvider 组合和 Fake 端到端回归。先写失败测试并记录修复前证据，再做最小实现。

硬边界：
1. 全程禁止真实 Provider 请求、禁止读取真实 Key、禁止访问用户默认 DSH_HOME/Profile/Session/Workspace/.env/Keychain。
2. 只新增精确 @deepseek-ai/dsh-credentials-local@0.1.0-rc.8 devDependency；不得自写 Credential Provider，不得让 Mnemosyne 读取或解析 Credential 文件。
3. 现有 preflight 脚本保持纯 Preflight；执行使用新脚本并同时要求 --execute 与精确 approval hash。
4. Claim 必须早于 Credential resolve/network；重复执行 no-overwrite fail closed。
5. 执行 CLI/测试/依赖不得进入根插件 export、dist 或 tgz；pack-check 同时扫描 JS/DTS。
6. 不修改 Fixture/golden/历史 Receipt，不升级其他 DSH 包，不执行 D2-B2/B3，不生成 GO/ADJUST/STOP。
7. 错误与输出固定脱敏，不回显绝对路径、Key、Prompt、模型正文、命令或原始异常。

实现后先自行做普通 Review，再做 Security Review；发现问题立即补失败测试并修复，直到无 blocking/should-fix。运行本文第五章全部门禁。禁止 commit、push、tag。

最终报告必须包含：修改文件、失败测试先行证据、官方 Credential 组合方式、执行顺序、Claim-before-resolve/network 证据、Fake 调用统计、重复执行/故障矩阵、敏感信息扫描、包泄漏检查、全部门禁、Review/Security Review 结果与残余风险。最终状态只能是 real_canary_cli_ready_for_local_credential 或稳定 blocked。
```

## 八、CTO Review 修复契约

首轮实现不得签收，必须先关闭以下问题：

### 8.1 Credential 来源必须锁定为受管文件

官方 LocalCredentialProvider 的公开优先级是：继承环境 `env` 高于受管 `file`。仅配置显式 `path` 不能证明实际请求使用临时文件中的 Key。

真实执行路径必须在安装 DeepSeek Provider 前通过 `ctx.credentials.describe(credential_ref)` 验证：

```text
configured == true
source == "file"
```

不满足时返回稳定 blocked，禁止安装 DeepSeek Provider、禁止网络请求，且不得调用 `resolve()` 获取或比较明文值。该约束只用于 D2-B 真实 CLI；既有通用 Fake seam 不得被强制改成 `source=file`。可以为 `createRealProviderBridge` 增加显式 `requiredCredentialSource` 选项，由执行 CLI 固定传入 `file`。

新增回归测试：设置 synthetic 同名环境变量使官方 Provider 报告 `source=env`，必须 stable blocked、network=0，输出不含环境变量值；删除 synthetic 环境后，受管文件路径继续通过。测试必须在 `finally` 恢复环境。

### 8.2 Approval 输出路径必须达到持久化同等级安全

首轮 `writeApprovalFileNoOverwrite` 只检查直接父目录，祖先 symlink 可把 Approval 写到预期树外；检查与 link 间目录替换也未检测。

必须：

1. 逐组件 `lstat` 拒绝任意非系统祖先 symlink/非目录；
2. 发布前后记录并复核输出父目录 `dev+ino`；
3. `link` no-overwrite、0600、文件 fsync、目录 fsync、O_NOFOLLOW readback 保持；
4. 发布前目录替换 → 外部/新目录零目标；发布后替换 → fail loud 且已发布目标保留，不删除；
5. 错误保持固定脱敏。

必须先补真实 symlink 祖先与真实 rename/recreate inode 测试，不得用 hook 直接抛错伪装身份校验。

### 8.3 不修改全仓测试超时

删除 `vitest.config.ts` 的全局 `testTimeout: 30000`。现有子进程 helper 已有显式 timeout；若单个新增测试确实超过默认值，只能在该测试上设置局部 timeout，并给出实测依据。不得用全局放宽掩盖挂起。

### 8.4 修复阶段提示词

```text
继续 /Users/czy/Desktop/demo/dsh-Mnemosyne 的 D2-B1 CTO Review 修复。完整阅读 docs/DSH_MNEMOSYNE_M05D2_B_EXECUTION_PLAN.zh-CN.md 第八章和当前 diff。

只修复 8.1、8.2、8.3。先补能在当前实现上失败的回归测试，再做最小修复：
- D2-B 真实 CLI 必须验证官方 Credential describe 的实际 source=file；环境层 shadow 必须 stable blocked 且 network=0，绝不 resolve/比较/输出 Key。
- Approval 输出逐组件拒绝祖先 symlink，并用真实 rename/recreate 测试锁定发布前后 dev+ino 复核；发布后失败保留已发布目标。
- 撤销 vitest 全局 testTimeout，只允许必要的局部 timeout。

不得执行真实 Provider、不得读取真实 Key、不得改 Fixture/golden/历史协议、不得 commit/push/tag。完成后自行 Review/Security Review并运行第五章全部门禁。报告修复前失败证据、Credential source 矩阵、目录替换结果和全部门禁。
```
