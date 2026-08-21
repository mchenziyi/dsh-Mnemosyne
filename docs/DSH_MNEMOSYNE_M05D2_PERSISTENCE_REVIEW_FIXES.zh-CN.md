# M0.5D-D2 Persistence CTO Review 修复契约

状态：🟡 待 Gemini 3.7 Flash 在额度恢复后执行

## 1. 目标

收口 `src/m05d2/persistence.ts` 的跨进程 Claim、no-overwrite 发布、目录身份复核与故障测试。本修复不改变 Receipt、Summary、Preflight、Provider、Credential 或 Timeout 协议。

## 2. 已确认可保留

- 同目录临时文件、文件 `fsync`、`link` no-overwrite、临时文件清理；
- 发布后目标不因后续失败被回滚删除；
- root/子目录 0700、目标 0600、`O_NOFOLLOW` 读回；
- root 与目标父目录发布前后 `dev + ino` 比较；
- 独立 Node 子进程竞争同一 Execution Claim；
- 三个 persist 入口分别执行协议与路径验证。

## 3. 合入前阻断项

1. `PersistenceInternalTestHooks` 与 `__setPersistenceTestHooksForTest` 不得成为根插件或 `src/m05d2/index.ts` 的公开 API。若保留源码级测试 seam，必须显式从生产入口排除，并由 `pack-check` 同时扫描 JS 与 DTS，证明 tarball 零泄漏。
2. 增加真实的发布后目录替换测试：在 publish 后把目标父目录 rename 为备份并创建新 inode 的同名目录，随后必须由后置 `dev + ino` 校验 fail loud；断言已发布目标保留在备份目录，新目录与外部目录零写入。仅在 hook 中抛异常不算覆盖。
3. 增加真实的发布前目录替换断言：旧目录中的 temp 被清理或保留为可诊断临时文件时必须符合固定规则；新目录和外部目录不得出现目标。
4. 故障注入不能由环境变量、公开配置或插件输入触发；不能影响生产默认路径。测试结束必须恢复全局状态，支持并行测试而不串扰。
5. `pack-check` 必须禁止 `PersistenceInternalTestHooks`、`__setPersistenceTestHooksForTest`、`simulateFileFsyncFailure`、`simulateDirFsyncFailure`、`simulateReadbackMismatch` 出现在 `dist/index.mjs` 与 `dist/index.d.mts`。
6. 子进程 Claim 竞态必须核对相同 `execution_id`，恰好一名赢家、其余稳定冲突；目标 canonical bytes 与预期逐字节相同，0600，无 temp。
7. 修复或解释 `Date.now + Math.random` 仅用于临时文件名的边界；优先改用 `crypto.randomUUID()`，不得参与 Fact 身份或 Canonical 内容。
8. 所有错误保持固定、脱敏，不回显路径、Fact 字节或凭据。

## 4. Gemini 执行提示词

```text
继续 /Users/czy/Desktop/demo/dsh-Mnemosyne 的 M0.5D-D2 Persistence 收尾。先阅读：
- docs/DSH_MNEMOSYNE_M05D2_PERSISTENCE_REVIEW_FIXES.zh-CN.md
- docs/DSH_MNEMOSYNE_M05D2_ACQUISITION_CREDENTIAL_AMENDMENT.zh-CN.md
- src/m05d2/persistence.ts
- tests/m05d2-persistence.spec.ts
- tests/fixtures/claim-worker.mjs

只处理修复契约第 3 节 8 项。必须先补失败测试，再做最小实现。

特别要求：
1. 真正执行发布前、发布后父目录 inode 替换，不得用“hook 直接 throw”伪装后置身份检查。
2. 测试 seam 不得进入根插件 JS/DTS/TGZ；pack-check 添加双重扫描。
3. 若源码测试必须直接访问 seam，明确它不是 package export，并证明 src/index.ts、dist/index.mjs、dist/index.d.mts、tgz 均无该符号。
4. 临时文件 nonce 改用 crypto.randomUUID，不进入规范 Fact。
5. 不改 runner、receipt、summary、preflight、provider、credential、timeout。

完成后自行做普通 Review 与 Security Review，至少运行：
corepack pnpm exec vitest run tests/m05d2-persistence.spec.ts tests/m05d2.spec.ts tests/m05d2-preflight.spec.ts
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check

禁止 commit、push、tag。报告修复前失败证据、真实 inode 替换结果、跨进程赢家统计、故障矩阵、包泄漏扫描与剩余风险。
```

## 5. CTO 验收条件

- 专用测试、全仓测试、typecheck、build、pack、pack-check、diff-check 全绿；
- 普通 Review 与安全 Review 无 blocking/should-fix；
- D2 全部代码门禁通过后，才更新主计划状态并提交实现；
- 不创建 Tag，不执行真实 Provider 请求。
