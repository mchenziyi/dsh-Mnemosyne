# dsh-Mnemosyne v0.1.0 · MVP-01 Runtime 与 Project/Session Scope 计划

> 状态：✅ 已实现并通过 CTO Review（2026-08-24）
> 日期：2026-08-24
> DSH 基线：`0.1.1-rc.2`
> 前置任务：MVP-00 已通过，Commit `6c14f74`
> 本阶段完成标志：`runtime_scope_ready`

## 一、目标

建立后续短期记忆和长期记忆共用的最小 Scope Runtime：

```text
公开 DSH Session / ToolRunContext
→ 确定 Session 身份
→ 确定 Project Root 来源
→ 生成稳定 Project/Session Scope ID
→ 绑定、冲突检测、释放
→ dispose 后零残留
```

本阶段只回答“这次记忆操作属于哪个 Project 和 Session”，不创建记忆、目录、Fact、OKF、索引或自动提取。

## 二、已核实的 DSH `0.1.1-rc.2` 公开契约

以安装包根导出与 `.d.ts` 为事实依据：

1. `ToolRunContext` 继承 `ToolExecutionInput`，公开可选 `agent?: Agent`；
2. `Agent` 公开 `id` 与 `session`；
3. `Session` 公开 `id` 与不可变 `header: SessionHeader`；
4. `SessionHeader.cwd?: string` 是 Session 创建时持久化的绝对工作目录；
5. `session/event(session, event)` 公开真实 Session；
6. `session/disposed(session)` 在 Session 离开 Store 时触发；
7. Cordis 注册的 Tool、事件监听器和 `ctx.effect` 随插件 Fiber dispose 撤销。

明确不存在的捷径：

- `ToolRunContext` 没有独立 `cwd` 字段；
- 不允许用 `process.cwd()`、`PWD`、callId、Desktop 当前标签页或私有数据库推断 Project；
- 本阶段不依赖未公开 Workspace Service。

## 三、范围与非目标

### 3.1 必须实现

- Project/Session Scope 数据模型；
- Scope ID 的确定性生成；
- `session.header.cwd` 与显式配置的优先级；
- Tool 调用的 Scope 解析；
- Session 事件的绑定与释放；
- 同 Session 身份漂移检测；
- 多 Project、多 Session 隔离；
- dispose/config update 清理；
- `mnemosyne_status` 的 Scope 可观察结果；
- 稳定、脱敏、结构化错误/状态。

### 3.2 明确不实现

- 文件或数据库写入；
- `.dsh-mnemosyne/` 目录；
- 短期/长期 Memory Fact；
- OKF、Generation、CURRENT；
- 自动采集、模型提取、Prompt 注入；
- search/open 的真实记忆替换；
- 自进化、插件生成或策略修改；
- 全局跨项目 Scope。

现有 synthetic `mnemosyne_search/open` 暂时保留为历史评测能力，本阶段不把它们声明为真实记忆，也不让它们参与 Scope Runtime。它们将在后续真实检索阶段被替换。

## 四、配置协议

在现有配置上只新增一个可选字段：

```ts
interface Config {
  enabled?: boolean
  projectRoot?: string
}
```

规则：

1. `projectRoot` 仅是 Session Header 缺少 cwd 时的回退；
2. 必须是非空绝对路径，拒绝 NUL；
3. 规范化 `.`、重复分隔符和尾部分隔符；
4. 不通过 `resolve(relative)` 把相对路径偷偷变成绝对路径；
5. 配置非法时插件加载 fail closed，错误不得回显原路径；
6. `session.header.cwd` 存在时始终优先，配置不得覆盖它；
7. 本阶段不访问文件系统验证目录是否存在；MVP-02 打开 Store 时再做 realpath、权限、symlink 和逐组件安全检查。

## 五、Scope 模型

内部最小模型：

```ts
type ScopeSource = 'session_header' | 'explicit_config'

interface ResolvedScope {
  schema_version: 1
  session_id: string
  project_root: string       // 仅内部使用，不进入 Tool 输出
  source: ScopeSource
  project_scope_id: string   // sha256_...
  session_scope_id: string   // sha256_...
}
```

确定性计算：

```text
project_scope_id = SHA-256(canonical JSON {
  schema_version: 1,
  kind: "project",
  project_root: <normalized absolute root>
})

session_scope_id = SHA-256(canonical JSON {
  schema_version: 1,
  kind: "session",
  project_scope_id: <project_scope_id>,
  session_id: <DSH Session.id>
})
```

要求：

- 使用项目既有 Canonical/Hash 工具，不另造 Hash 格式；
- 相同输入逐字节稳定；
- 不把绝对路径或 Session ID写入面向模型的输出；
- Project 相同但 Session 不同：Project Scope 相同、Session Scope 不同；
- Session ID 相同但 Project 不同：视为身份冲突，不接受新绑定。

## 六、Scope Runtime

建议最小接口，可按现有风格调整命名，但不得扩展功能：

```ts
interface ScopeRuntime {
  observeSession(session: Session): ScopeResolution
  resolveExecution(exec: ToolRunContext): ScopeResolution
  disposeSession(session: Session): void
  clear(): void
  snapshot(): ScopeRuntimeSnapshot
}

type ScopeResolution =
  | { status: 'ready'; scope: ResolvedScope }
  | { status: 'unavailable'; reason: ScopeReason }
  | { status: 'conflict'; reason: ScopeReason }
```

### 6.1 Tool 解析顺序

1. `exec.agent` 缺失 → `unavailable`，不得创建匿名 Session；
2. `exec.agent.id !== exec.agent.session.id` → `conflict`；
3. Session ID 必须为非空受控字符串；
4. Project Root 优先取 `exec.agent.session.header.cwd`；
5. Header 无 cwd 时才取配置 `projectRoot`；
6. 两者均缺失 → `unavailable`；
7. 创建或复用不可变绑定；
8. 已绑定 Session 再出现不同 Project Root → `conflict`，保留原绑定，不覆盖。

### 6.2 Event 解析

- `session/event`：只读取 Session 身份/Header 以建立或验证绑定；
- 不保存 Event 正文、Tool 参数、Prompt、命令或 ContentBlock；
- `session/disposed`：删除对应 Session 绑定；
- 重复 event 对同一绑定为 NOOP；
- Event Scope 冲突只记录稳定的冲突状态，不抛出包含路径的错误；
- 后续 Tool 对冲突 Session 必须返回 `conflict`，不能继续使用旧 Scope 假装正常。

### 6.3 生命周期

- Runtime 必须是每个插件实例私有状态，禁止模块级可变单例；
- `ctx.effect` 或等价 Cordis 生命周期负责 `clear()`；
- 插件禁用不注册 Tool/监听器/Runtime；
- config update 先 dispose 旧实例，再建立新实例；
- 两个 root Context 完全隔离；
- dispose 后 Map、冲突记录和监听器数量归零。

## 七、错误与隐私

稳定内部原因枚举：

```text
missing_agent
agent_session_identity_mismatch
missing_project_root
invalid_project_root
invalid_session_id
session_scope_conflict
runtime_disposed
```

规则：

- 不回显绝对路径、Session ID、事件正文、Prompt、命令或 Credential；
- 不把攻击者输入插入错误字符串；
- 不抛原始 `TypeError`/Node 路径错误给模型；
- status 只披露状态、来源与 Hash ID，不披露 `project_root`/`session_id`。

## 八、`mnemosyne_status` 协议

MVP-01 将静态状态升级为动态 Scope 状态，协议版本从 1 升为 2：

```json
{
  "plugin": "dsh-Mnemosyne",
  "version": "0.0.0-dev",
  "protocol_version": 2,
  "memory_enabled": false,
  "status": "ready",
  "scope": {
    "status": "ready | unavailable | conflict",
    "source": "session_header | explicit_config | none",
    "project_scope_id": "sha256_... | null",
    "session_scope_id": "sha256_... | null",
    "reason": "<stable enum> | null"
  }
}
```

要求：

- Tool 的 `execute(args, exec)` 必须使用真实 `exec`；
- 无 Agent 的测试/SDK 直接调用返回 `unavailable/missing_agent`，不报错；
- ready 时 reason 为 null，unavailable/conflict 时两个 ID 必须为 null；
- 输出严格 Schema、固定键、确定性 JSON；
- `memory_enabled` 继续为 false，不能提前宣称记忆已可用；
- 旧 `STATUS_OUTPUT` 如保留，只能表示无执行上下文的确定性 unavailable 输出；不得让真实 Tool 永远返回静态 ready Scope。

## 九、TDD 测试矩阵

先写失败测试，至少覆盖：

### 9.1 配置与根路径

1. Header cwd 合法并优先于配置；
2. Header 无 cwd 时使用显式绝对配置；
3. 二者均缺失 → unavailable；
4. 相对配置、空字符串、NUL → 加载失败且脱敏；
5. 规范化重复分隔符、`.` 与尾斜杠；
6. `process.cwd()` 改变不影响显式 Header/配置结果。

### 9.2 身份与隔离

7. 相同 Project/Session 重复解析稳定 NOOP；
8. 相同 Project、不同 Session：Project ID 相同、Session ID 不同；
9. 不同 Project、不同 Session 完全隔离；
10. 相同 Session ID、不同 Project → conflict，原绑定不覆盖；
11. Agent ID 与 Session ID 不同 → conflict；
12. 无 Agent → unavailable，不生成匿名身份。

### 9.3 Event 与生命周期

13. session/event 建立绑定但不保留 payload；
14. 重复事件不增加绑定数；
15. session/disposed 删除绑定；
16. dispose 后 Map/冲突记录归零；
17. config enabled→disabled→enabled 无重复监听；
18. 两个 Cordis root Context 隔离；
19. 事件冲突写入冲突态，后续 status fail closed；
20. disabled 插件零贡献。

### 9.4 Status、安全和回归

21. ready/unavailable/conflict 三种严格输出；
22. 输出不包含绝对路径和 Session ID；
23. 恶意路径/ID不进入错误；
24. Hash 重复计算逐字节一致；
25. 当前 synthetic search/open 与 M0.5/D2 离线测试保持不变；
26. 零文件系统写入；
27. pack 不泄漏 Fixture、Provider Runner 或内部 Scope 明文。

不得用 `{} as never` 伪造“真实 Tool Scope 已通过”。Scope Tool 测试必须构造满足公开 `Agent`/`Session` 最小契约的执行上下文，至少真实包含 `agent.id`、`agent.session.id` 与 `agent.session.header.cwd`。

## 十、允许修改文件

预计允许：

- `src/config.ts`
- `src/index.ts`
- `src/observer.ts`
- `src/status.ts`
- 新增 `src/runtime-scope.ts`（或同等单文件实现）
- 对应 `tests/**`
- 本计划文档状态/交付记录
- 如公开类型需要，仅增加根导入，不增加新依赖

禁止修改：

- `src/m05*/**` 历史评测实现；
- Fixture 与评测结果；
- package/lock DSH 版本；
- README/Architecture 的大范围重写；
- Fact Store、OKF、真实 search/open；
- Tag/Release。

如果实现需要超出上述范围，先停止并在交付摘要中报告，不得自行扩展。

## 十一、自动门禁

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
rg -n 'process\.cwd\(\)|process\.env|session\.meta\.cwd|electron|ipcRenderer|ipcMain|better-sqlite3|sqlite3' src/runtime-scope.ts src/observer.ts src/status.ts src/config.ts
rg -n '@deepseek-ai/dsh-[a-z-]+/' src/runtime-scope.ts src/observer.ts src/status.ts src/config.ts
git status --short
```

允许的导入必须来自 DSH 包根入口；第一条扫描命中必须逐项解释，否则 fail。

## 十二、Gemini 自审与 CTO 交接摘要

Gemini 完成后必须先自行 Code Review 和 Security Review：

1. 按测试矩阵逐条核对；
2. 检查是否错误使用 `process.cwd()` 或 Header 之外的路径来源；
3. 检查 Scope 冲突是否可能被后写覆盖；
4. 检查绝对路径/Session ID 是否泄露；
5. 检查 dispose/config update 是否残留 Map 或监听器；
6. 检查是否越界实现 MVP-02+；
7. 完整重跑门禁；
8. 有 should-fix 必须先修复，不能提交旧结果。

最终只输出一份“CTO 交接摘要”，用户无需复制思考过程。摘要固定包含：

1. 实际修改文件及用途；
2. 执行过的关键操作与命令；
3. 修复前失败证据；
4. Scope 解析优先级与数据流；
5. 冲突、dispose 和隐私行为；
6. 新增/修改测试及数量；
7. 全部门禁结果；
8. Code Review/Security Review 发现与修复；
9. 未完成项、风险与环境问题；
10. Git 状态与是否 commit/push/tag；
11. 当前完成标志；
12. 建议 CTO 重点复查的位置。

## 十三、给 Gemini 3.7 Flash 的完整提示词

```text
你正在 /Users/czy/Desktop/demo/dsh-Mnemosyne 执行 v0.1.0 内部任务 MVP-01：Runtime 与 Project/Session Scope。

唯一实施规范：
/Users/czy/Desktop/demo/dsh-Mnemosyne/docs/DSH_MNEMOSYNE_V010_MVP01_RUNTIME_SCOPE_PLAN.zh-CN.md

开始前完整读取：
1. 上述 MVP-01 计划；
2. docs/DSH_MNEMOSYNE_VERSION_ROADMAP.zh-CN.md；
3. src/index.ts、src/observer.ts、src/config.ts、src/status.ts；
4. tests/lifecycle.spec.ts、tests/event-observer.spec.ts、tests/status-tool.spec.ts、tests/profile-runtime-smoke.mjs；
5. DSH 0.1.1-rc.2 根导出与 .d.ts 中 ToolRunContext、Agent、Session、SessionHeader 和 session events；
6. 官方插件、Tool、事件与生命周期文档。

先陈述假设、最小方案和成功标准。严格 TDD：先写失败测试，记录失败证据，再做最小实现。

核心要求：
- 只使用公开 exec.agent.session、session.id、session.header.cwd、session/event、session/disposed；
- Header cwd 优先，显式绝对 projectRoot 只作缺失回退；
- 禁止 process.cwd/PWD/环境变量/私有 Workspace/Desktop 推断；
- 建立确定性 Project/Session Scope ID；
- 同 Session 身份漂移 fail closed，不覆盖；
- 多项目、多 Session、多插件实例隔离；
- dispose/config update 后零残留；
- mnemosyne_status 升级为 protocol_version 2 的动态 Scope 状态；
- 不向 Tool 输出绝对路径和 Session ID；
- 不保存 session/event 正文；
- 保持 memory_enabled=false；
- 保持 synthetic search/open 和全部历史评测不变；
- 零文件写入，不进入 MVP-02。

硬约束：
- 不修改 src/m05*/**、Fixture、评测语义或 DSH 依赖版本；
- 不使用 deep import、私有 API、Desktop IPC、数据库或猴子补丁；
- 不实现 Fact Store、OKF、真实记忆、自动采集、自进化；
- 不 commit、不 push、不创建 Tag。

测试不得只用空对象 as never 假装真实 Scope；必须构造带公开 agent/session/header 身份的执行上下文。对路径、身份冲突、dispose、隐私、确定性和零写入做真实断言。

完成实现后，自行执行一次 Code Review 和 Security Review；发现 should-fix 必须先修复并重跑全部门禁。

最终门禁：
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
corepack pnpm peers check
git diff --check

额外扫描：
rg -n 'process\.cwd\(\)|process\.env|session\.meta\.cwd|electron|ipcRenderer|ipcMain|better-sqlite3|sqlite3' src/runtime-scope.ts src/observer.ts src/status.ts src/config.ts
rg -n '@deepseek-ai/dsh-[a-z-]+/' src/runtime-scope.ts src/observer.ts src/status.ts src/config.ts
git status --short

最终不要输出过程流水账，只输出计划第十二章规定的“CTO 交接摘要”。明确声明未 commit、未 push、未创建 Tag、未进入 MVP-02。
```
