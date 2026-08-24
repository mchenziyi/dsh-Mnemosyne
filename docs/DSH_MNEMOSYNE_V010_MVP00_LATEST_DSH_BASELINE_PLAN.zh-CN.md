# dsh-Mnemosyne v0.1.0 · MVP-00 最新 DSH Baseline Gate 计划

> 状态：🟡 待 Gemini 实现与 CTO Review
> 日期：2026-08-24
> 任务性质：兼容性迁移，不实现记忆产品功能
> 目标基线：DSH CLI 与公开 SDK `0.1.1-rc.2`

## 一、目标与成功标准

仓库当前依赖仍锁定 `0.1.0-rc.8`，而本机 DSH CLI 已是 `0.1.1-rc.2`。本任务只完成一次干净、可证明的基线迁移：

```text
确认公开版本存在
→ 精确升级直接 DSH 依赖
→ 重新安装 lockfile
→ 审计公开根导出与类型声明
→ 修复兼容性回归
→ 验证插件打包与官方加载形态
```

成功标准：仓库不再依赖 rc.8 运行时假设；全部自动门禁通过；生产代码只使用 `0.1.1-rc.2` 的公开根导出；没有开始 Fact Store、OKF、自动提取或其他 MVP-01+ 功能。

## 二、基线判定

执行开始时记录：

```bash
dsh --version
npm view @deepseek-ai/dsh-tools@0.1.1-rc.2 version
npm view @deepseek-ai/dsh-session@0.1.1-rc.2 version
npm view @deepseek-ai/dsh-agent@0.1.1-rc.2 version
```

当前已确认：本机 CLI 为 `0.1.1-rc.2`，仓库所用的 16 个 `@deepseek-ai/dsh-*` 直接依赖均公开存在 `0.1.1-rc.2`。

注意：npm 默认 dist-tag 可能仍返回旧 RC，不能用裸 `npm view <pkg> version` 代替显式版本存在性检查，也不能把依赖写成 `latest`。

## 三、允许修改范围

允许：

- `package.json`
- `pnpm-lock.yaml`
- 因公开 API 兼容性变化必须修改的 `src/**`
- 对应回归测试 `tests/**`
- 本计划文档的状态与交付记录
- 如打包检查确有版本相关变化，可手术式修改 `tests/pack-check.mjs`

禁止：

- 实现短期/长期 Fact Store、OKF、检索、自动采集、提取或管理功能；
- 修改冻结 Fixture 语义来掩盖回归；
- deep import DSH 包内部文件；
- 复制 DSH 私有实现；
- 猴子补丁、Desktop IPC、未公开数据库或未公开服务；
- 批量改写历史 rc.8 审计文档；
- 创建 Tag、Release 或自行 push。

## 四、依赖迁移规则

1. `package.json` 中所有直接 `@deepseek-ai/dsh-*` peer/dev dependency 精确改为 `0.1.1-rc.2`。
2. 保持 Cordis、Schemastery、Node、TypeScript 与构建工具版本不变，除非新 DSH peer 约束导致安装硬失败；如发生，暂停并报告，不自行扩散升级。
3. 使用 pnpm 更新 lockfile，禁止手工编辑 lockfile。
4. 安装后确认解析出的直接 DSH 包均为 `0.1.1-rc.2`，不得混入 rc.8。
5. 若传递依赖因官方 peer 关系出现其他版本，完整列出，不用 overrides 强压。

## 五、公开 API 审计

以 `0.1.1-rc.2` 安装产物的 `package.json` exports、根导出与 `.d.ts` 为事实依据，并对照官方开发文档：

- 插件入口与 Cordis 生命周期；
- Tool 注册、ToolDefinition 与 ToolRunContext；
- Session 对象、`session/event`、`Session.meta.cwd` 或等价公开字段；
- 配置 Schema；
- dispose/effect 撤销语义；
- 现有 M0.5 Provider 审计代码依赖的公开接口。

必须输出一个兼容性表：

| 能力 | rc.8 用法 | rc.2 当前公开用法 | 状态 | 必要改动 |
|---|---|---|---|---|
| 插件入口 |  |  | compatible/changed/removed |  |
| Tool 注册 |  |  |  |  |
| Tool 执行上下文 |  |  |  |  |
| Session/Event |  |  |  |  |
| Project/Workspace Scope |  |  |  |  |
| 配置 |  |  |  |  |
| dispose |  |  |  |  |
| Provider audit seam |  |  |  |  |

任何不存在的能力必须标记 `unavailable`，不得猜测替代接口。

## 六、测试策略

先运行升级前门禁并保存结果，再改依赖。升级后至少覆盖：

1. 插件可按官方形态加载与 dispose；
2. 现有 Tool 可注册、调用和撤销；
3. Session/Event 监听器不重复、不泄漏；
4. pack 后仅包含允许文件；
5. 现有 M0.5/D2 离线测试不因版本迁移失真；
6. 无真实 Provider、API Key、网络任务或用户数据；
7. `rg '0\.1\.0-rc\.8' package.json pnpm-lock.yaml` 零命中。

历史文档中的 rc.8 命中是允许的，因为它们是历史事实。

## 七、自动门禁

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check
```

另执行：

```bash
dsh --version
corepack pnpm list --depth 0
rg -n '0\.1\.0-rc\.8' package.json pnpm-lock.yaml
```

## 八、自审要求

Gemini 完成实现后必须先自行 Review，再提交给 CTO：

1. 对照本计划逐条检查范围与验收矩阵；
2. 检查是否存在 deep import、私有 API、版本混装或无关升级；
3. 检查测试是否真正覆盖 rc.2 行为，而非只修改期望值；
4. 执行全门禁；
5. `git diff` 逐文件复核；
6. 有 should-fix 就先修复并重跑，不得把“上一版已通过”当作本轮证据；
7. 最终报告必须列出修复前失败证据、实际版本、兼容性表、修改文件、测试数量、门禁结果和剩余风险。

## 九、交付边界

交付后应满足：

```text
baseline_status = dsh_0.1.1-rc.2_compatible
memory_product_changes = 0
tag_created = false
push_performed = false
```

MVP-00 经 CTO 签收并提交后，才编写并执行 MVP-01 Runtime/Project/Session Scope 实现计划。

## 十、给 Gemini 3.7 Flash 的完整提示词

```text
你正在 /Users/czy/Desktop/demo/dsh-Mnemosyne 仓库执行 dsh-Mnemosyne v0.1.0 的 MVP-00：最新 DSH Baseline Gate。

唯一规范文档：
/Users/czy/Desktop/demo/dsh-Mnemosyne/docs/DSH_MNEMOSYNE_V010_MVP00_LATEST_DSH_BASELINE_PLAN.zh-CN.md

开始前完整读取：
1. 上述 MVP-00 计划；
2. /Users/czy/Desktop/demo/dsh-Mnemosyne/docs/DSH_MNEMOSYNE_VERSION_ROADMAP.zh-CN.md；
3. 仓库 package.json、pnpm-lock.yaml、src/**、tests/**；
4. 官方 DSH 开发文档 https://deepseek-harness.github.io/deepseek-harness/develop/basic/；
5. 安装后的 0.1.1-rc.2 包 exports、根导出与 .d.ts。

先显式陈述假设和成功标准，再执行。严格遵循：先基线测试，后最小修改，再回归测试。

任务要求：
- 确认本机 dsh --version；
- 显式确认仓库 16 个直接 @deepseek-ai/dsh-* 包均存在 0.1.1-rc.2；
- 将 package.json 中直接 DSH peer/dev dependencies 精确升级到 0.1.1-rc.2；
- 用 pnpm 正常更新 lockfile，禁止手改；
- 审计并仅在必要时修复公开 API 兼容性；
- 输出 rc.8→0.1.1-rc.2 兼容性表；
- 保持现有离线功能、测试、打包边界不回归。

硬约束：
- 不实现任何记忆产品功能；
- 不使用 deep import、私有数据库、Desktop IPC、猴子补丁或复制 DSH 私有实现；
- 不批量改历史 rc.8 文档；
- 不升级无关依赖；
- 不调用真实 Provider，不读取 API Key，不访问用户项目数据；
- 不 commit、不 push、不创建 Tag。

测试必须先证明升级前基线，再证明升级后结果。完成后自行进行一轮 code review 和 security review；发现 should-fix 必须先修复并重跑全部门禁，不能直接提交旧结果。

最终执行：
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
git diff --check
dsh --version
corepack pnpm list --depth 0
rg -n '0\\.1\\.0-rc\\.8' package.json pnpm-lock.yaml

最终报告必须包含：
1. 升级前基线结果；
2. 实际 CLI 与所有直接 DSH 依赖版本；
3. 公开 API 兼容性表；
4. 修改文件清单和每项必要性；
5. 修复前失败证据（若有兼容性变化）；
6. 测试数量和全部门禁原始结论；
7. deep import/私有 API/版本混装扫描结果；
8. 自审发现与修复；
9. 剩余风险；
10. 明确声明未 commit、未 push、未创建 Tag、未进入 MVP-01。
```
