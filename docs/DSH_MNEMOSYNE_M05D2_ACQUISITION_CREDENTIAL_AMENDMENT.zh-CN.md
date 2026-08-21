# M0.5D-D2-A 设计修订：真实 Acquisition、凭据隔离与执行世界重建

> 状态：✅ 设计已冻结，待实现与 CTO 验收  
> 上位设计：`DSH_MNEMOSYNE_M05D2_REAL_CANARY_PLAN.zh-CN.md`  
> Review 基线：`main@31c26d3` 加当前未提交 D2-A 实现  
> 适用范围：仅 M0.5D-D2-A 离线实现；不是 D2-B 真实调用授权

## 一、修订原因

第二轮 D2-A 实现已改善一次性 Claim、no-overwrite 和部分对象校验，但仍存在三个结构性问题：

1. 生产 Runner 的任务调用使用官方 Provider，acquisition 调用却使用 `FakeAcquisition`，随后仍生成 `real_provider_canary` 证据；
2. Provider bridge 未挂载隔离的官方 Credential seam，也未绑定临时 `DSH_HOME`，官方 Provider 仍可能回退到 `process.env` 或默认用户状态；
3. Claim 前只比较调用方传入的 Hash，没有从当前磁盘事实重建 Fixture、M0.5E Plan 与 rc.8 Provider Audit。

这些问题会让“真实 Provider Canary”混入伪造证据，或在离线测试中误触真实凭据/网络，因此必须先修订协议再继续实现。

## 二、冻结决议

### 2.1 真实 Acquisition 必须使用同一官方 Provider bridge

- D2 的每个 Run 最多包含 4 次 task 调用和恰好 1 次 acquisition 调用；两类调用都必须通过同一个、已验证身份的 DSH rc.8 官方 Provider bridge。
- 生产代码不得存在 `FakeAcquisition`、离线候选硬编码或“acquisition 使用 Fake、task 使用 real”的路由。
- Fake 只能存在于测试专用 harness，且不得进入生产 `runRealCanaryD2`、不得持久化 `real_provider_canary` Receipt、不得产生真实 plumbing 状态。
- D2-A 自动测试不得调用生产真实执行入口来制造所谓“真实失败证据”。测试只验证纯函数、严格 Schema、受控 fake harness 和被 trap 的装配路径。

### 2.2 D2 Acquisition 不复用离线 fixture 字节相等断言

M0.5D 离线切片继续保持原协议：Fake acquisition 输出可与固定 fixture 做精确比较。D2 不修改该历史协议。

D2 新建专用真实 acquisition 路径：

1. task 完成后先 claim acquisition 预算；
2. 通过同一官方 bridge 发起一次结构化 acquisition 请求；
3. 只接受一个严格 JSON 对象，固定字段为：

```yaml
schema_version: 1
title: "受限字符串"
summary: "已脱敏受限字符串"
redaction_status: passed
```

4. 拒绝 Markdown fence、前后杂文、未知字段、错误类型、超限内容、秘密、绝对路径和危险命令正文；
5. 只持久化规范化候选内容 Hash、usage、provider call 数与验证结果，不保存模型原文；
6. 不要求真实输出与离线 fixture 的 title/summary 字节相等；
7. acquisition 通过只证明 Provider 返回了符合协议且通过脱敏验证的候选，不证明候选正确、有价值或应写入长期记忆。

`RealCanaryReceipt.acquisition` 保留现有受控字段，并增加或明确 `candidate_schema_valid=true`；只有真实 Provider 调用完成且严格验证通过后，`provider_calls` 才能为 1。

### 2.3 Credential seam 必须隔离；不能证明即稳定 blocked

- Runner 创建临时隔离根后，Provider bridge 必须显式接收并使用该根的 `dsh_home` 与 `workspace`。
- 只允许使用 DSH rc.8 根导出的公开 Credential 服务或公开配置入口；Mnemosyne 不读取、复制、缓存或返回密钥值。
- `credential_ref` 只是受控引用，必须与批准的 Plan/Authorization 精确一致。
- D2-A 测试环境必须安装 credential/network trap：任何 `process.env` 凭据读取、默认用户状态访问、DNS/HTTP/fetch/net 请求都使测试立即失败。
- 若 rc.8 公开接口无法挂载隔离 Credential seam，或无法禁用环境变量/默认状态回退，则 Provider bridge 返回稳定 `real_canary_blocked_credential_isolation_unavailable`；不得 deep import、猴子补丁、自己实现 HTTP Provider或静默接受回退。
- D2-B 的凭据注入方式只能在公开 seam 被审计确认后另写用户步骤。本设计文档和 D2-A 测试均不创建、读取或要求真实 Key。

### 2.4 Claim 前必须从真实输入重建执行世界

禁止由调用方直接提供 `fixture_manifest_sha256`、`m05e_canary_plan_sha256` 或硬编码的兼容性结论作为事实源。Claim 前固定执行：

1. 从显式路径严格读取 M0.5D-v2 Fixture Manifest，验证内容并计算 Canonical Hash；
2. 调用正式 `createCanaryPlan()`（或其公开验证入口）重建 M0.5E Plan，验证并计算 Hash；
3. 从当前 `package.json` 与 lockfile，使用已冻结的 `audited_at` 重建 `ProviderCompatibilityAudit`；
4. 严格读取外部提供的 Audit、RealCanaryPlan、Authorization、Approval；
5. 比较重建事实与四个授权对象的 ID、状态、版本、route、model、limits、cost 和所有 Hash；
6. 验证持久证据根的规范路径 Hash；
7. 全部通过后才发布 Claim。

任一步失败必须在 Credential resolve、Provider 初始化、网络、隔离运行写入和 Receipt 之前零副作用结束。`package_json_content` 等未使用的调用参数必须删除；脚本和 Runner 使用同一执行世界构造器，禁止双实现。

### 2.5 Preflight 只能读取事实，不能铸造事实

`scripts/m05d2-real-canary.ts` 必须：

- 通过显式参数接收 Audit、Plan、Authorization、Approval、Fixture 根、持久证据根和显式 `now`；
- 严格读取并调用与 Runner 相同的执行世界验证器；
- 打印真实 ID/Hash、provider/model、6/24/6/30、4096、30s/10m、0 retry、breaker=2、成本状态和 root hash；
- 默认只做 preflight，零 Credential resolve、零 Provider bridge、零网络、零 Claim；
- 不调用 `Date.now()`，不硬编码 Hash/成本，不创建 Audit、Authorization 或 Approval。

创建 Approval 必须是后续独立、显式用户动作；preflight 绝不代替批准。

### 2.6 Receipt、Summary 与 Ledger 的真实完成条件

- Receipt 必须在成功持久化后才加入内存合法前缀。
- `retrieved ⊆ observed`、`opened ⊆ retrieved`、`adopted ⊆ opened`；所有数组受限、去重并绑定固定 Run 身份。
- 每个 Receipt 的 claim 数必须等于 `model_call_count + acquisition.provider_calls`，且 acquisition 必须来自官方 bridge。
- pass 必须恰好包含固定的 6 个不同 Run 身份，每个恰好一次；不能用 6 份重复 Receipt 通过。
- `ledger.total_calls_claimed = task_calls_claimed + acquisition_calls_claimed`。
- pass 时 `completed_calls = total_calls_claimed`、`failed_calls = 0`、无 pending、未越界、未熔断、`reason_code=null`、`cleanup_clean=true`。
- plumbing pass 不要求任务断言全部成功；`success` 只记录任务事实，必须由严格任务断言重新计算。
- fail/aborted 的 reason/status 必须使用冻结矩阵，Summary 持久化失败必须 fail loud，Claim 保留且不得复用旧 Approval。

### 2.7 持久化安全边界

- 持久根及所有已存在子目录必须严格为 0700，不接受 0755；文件为 0600。
- `persistReceipt`/`persistSummary` 每次调用都重新验证根路径 Hash、逐组件类型/权限/symlink 与受控文件名，不能依赖调用者先前检查。
- no-overwrite 发布前后重新验证父目录链；竞态导致路径身份变化时 fail loud。Node 公开 API 无法完全实现 `openat` 锚定时，必须记录残余同 UID TOCTOU 风险，但不得省略发布前后校验。
- 目录 fsync 失败不得静默成功；临时文件尽力清理，既有目标绝不覆盖或删除。
- bridge dispose 对外只返回稳定脱敏错误；底层异常正文不得拼接进入错误、Receipt 或 Summary。

## 三、实现边界调整

允许在 `src/m05d2/**` 内重构并抽取 D2 专用的 task/acquisition orchestration。不得为了复用而修改 M0.5D 离线 fixture/golden/Receipt 语义。

生产 D2 入口必须满足：

```text
真实输入重建与校验
→ Claim
→ 临时隔离根
→ 隔离 Credential seam / 官方 Provider bridge
→ task + real acquisition
→ Receipt 先持久化后纳入合法前缀
→ dispose / cleanup
→ 严格 Summary
```

如果 Credential seam 在 rc.8 下不可证明安全，D2-A 的正确交付是稳定 `blocked`，而不是用 Fake 填补真实链路。

## 四、必须新增的失败测试

1. 环境中存在看似真实的 API Key 时，D2-A 测试仍不得读取或发网；trap 必须证明计数为 0；
2. Provider bridge 未获得隔离 Credential seam 时稳定 blocked；临时 DSH home/workspace 被精确传入；
3. Fake task/acquisition 均无法产生或持久化真实 Receipt/Summary；
4. D2 acquisition 的真实桥调用为 1，严格 JSON 合法时通过，Markdown/未知字段/秘密/路径/超限时失败；
5. acquisition 不再要求与离线 fixture 字节相等，M0.5D 历史 golden 不变；
6. 实际 Fixture、实际 `createCanaryPlan()`、当前 package/lock/audit 任一漂移均在 Claim 前失败；
7. preflight 对所有事实只读；禁止 `Date.now()`、硬编码 Hash/成本和事实构造；
8. pass Summary 使用 6 个唯一 Run，completed 等于实际 task+acquisition 总调用且 failed/pending 为 0；重复 Run 或 completed=6 但总调用>6 必须拒绝；
9. 0755 根、持久化入口直调、发布前后 symlink/父目录替换、目录 fsync 失败均 fail closed；
10. Receipt 持久化失败时不进入合法前缀；dispose 原始错误不泄漏；
11. 两进程 Claim 竞态恰好一个成功；目标字节零覆盖；
12. production runner 的源码与运行路径中不存在 `FakeAcquisition`。

## 五、验收与提交边界

完成后运行上位设计第九章全部门禁，并增加：

```bash
rg -n "FakeAcquisition|process\.env|Date\.now\(\)|fixture_manifest_sha256\s*=|m05e_canary_plan_sha256\s*=" src/m05d2 scripts/m05d2-real-canary.ts
```

生产路径命中 `FakeAcquisition` 必须为零；`process.env` 和 `Date.now()` 只能出现在明确拒绝/测试 trap，不得位于执行实现。

Gemini 完成后必须先自行进行普通 Review 和 Security Review，再由 Sol 独立复核。未通过前不提交实现；通过后单独小步提交 D2-A，不与 D2-B 实跑、下一阶段文档或其他重构混合。

## 六、给 Gemini 3.7 Flash 的执行提示词

```text
你是实现工程师 Gemini 3.7 Flash。工作目录：
/Users/czy/Desktop/demo/dsh-Mnemosyne

继续修复 M0.5D-D2-A。开始前完整读取：
1. docs/DSH_MNEMOSYNE_M05D2_REAL_CANARY_PLAN.zh-CN.md
2. docs/DSH_MNEMOSYNE_M05D2_CTO_REVIEW_FIX_PLAN.zh-CN.md
3. docs/DSH_MNEMOSYNE_M05D2_ACQUISITION_CREDENTIAL_AMENDMENT.zh-CN.md
4. 当前未提交的 src/m05d2/**、tests/m05d2.spec.ts、scripts/m05d2-real-canary.ts
5. src/m05d/**、src/m05e/**、src/m05f/** 与对应测试
6. DSH rc.8 官方根导出、类型声明和公开文档

第三份修订文档在冲突时优先。先报告假设、文件边界和成功标准。严格 TDD：每个缺陷先新增会失败的测试并运行确认，再做最小实现。

必须完成：
- 删除生产 FakeAcquisition；task 与 acquisition 均只走同一个官方 Provider bridge；
- 新建 D2 专用真实 acquisition 验证，不要求真实输出与离线 fixture 字节相等；不得修改 M0.5D 历史契约；
- 审计并挂载 rc.8 公开隔离 Credential seam，把临时 dsh_home/workspace 传入 bridge；若无法阻断 process.env/默认状态回退，稳定 blocked，严禁绕过；
- 测试安装 credential/network trap，任何真实 Key 读取或网络调用立即失败；测试不得用生产 Runner 持久化真实 evidence；
- Claim 前从实际 Fixture、createCanaryPlan、当前 package/lock 重建执行世界；删除未使用和调用方自证 Hash 参数；
- preflight 只读取显式事实和显式 now，不铸造 Audit/Auth/Approval，不硬编码 Hash/成本，不调用 Date.now；
- 修复 Summary/Ledger：6 个唯一 Run，completed=total task+acquisition，failed/pending=0 才能 pass；
- 收紧 Receipt 嵌套关系、任务 success 重算、状态/reason 矩阵和脱敏；
- 持久根严格 0700；每个 persist 入口自行复核 root hash、路径、权限和 symlink；Receipt 成功持久化后才加入前缀；dispose 使用稳定脱敏错误。

禁止真实 Provider 请求、真实 Key、process.env/default DSH state、deep import、自写 HTTP Provider、修改生产导出、修改 M0.5D 历史 fixture/golden、git commit/push/tag。

若官方 rc.8 公共 Credential seam 无法满足隔离边界，不要伪造通过：删除不安全真实执行路径并返回稳定 blocked，同时保留可验证 preflight/Claim 前零副作用保证。

运行文档全部门禁和新增扫描。然后先自行做两轮 Review：
1. 普通 Review：逐条核对三份设计、身份/Hash、状态机、预算、真实/离线隔离、兼容性；
2. Security Review：凭据/环境/网络逃逸、路径/权限/TOCTOU、no-overwrite、秘密泄漏、测试误触真实服务。

任何 blocking/should-fix 必须补失败测试并修完，再重跑全部门禁。最终只报告当前真实状态与证据，不提交代码，不执行 D2-B。
```
