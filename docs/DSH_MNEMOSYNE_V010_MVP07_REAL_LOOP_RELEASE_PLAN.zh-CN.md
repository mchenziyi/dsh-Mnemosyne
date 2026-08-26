# dsh-Mnemosyne v0.1.0 · MVP-07 真实闭环与发布验收计划

> 状态：🟡 设计完成（待 Gemini 3.7 Flash 实现离线 Gate）
>
> 日期：2026-08-26
>
> 前置提交：`6e82e17 feat: add basic memory management`
>
> 当前 DSH Baseline：本机 CLI `0.1.1-rc.2`，仓库直接 DSH 依赖统一锁定 `0.1.1-rc.2`

---

## 一、目标与成功标准

MVP-07 不增加记忆产品功能，只证明 MVP-00～06 已交付的能力能以**真实打包插件**在**隔离的临时 DSH Profile 与临时项目**中形成闭环，并完成 `v0.1.0` 发布前收口。

```text
源码门禁
→ pnpm pack 生成真实 tarball
→ 临时 DSH_HOME/Profile 安装
→ dump-config 验证插件层
→ 临时项目真实 DSH 任务
→ 自动形成短期记忆
→ 重启 DSH 后 list/search/open
→ promote 为长期记忆
→ 再次重启后仍可检索
→ forget 后退出新 Generation
→ 卸载插件并验证层消失
→ 用户签收
→ 版本号 0.1.0 / README / Tag
```

成功标准：

1. 验收使用 `pnpm pack` 的 tarball，不从仓库源码路径直接加载插件；
2. 所有运行状态只写入新建临时 `DSH_HOME` 与临时 Workspace；
3. 用户默认 DSH_HOME、正式 Profile、Session、Workspace 和凭据文件零写入；
4. 真实任务结束后自动产生一条合法短期记忆；
5. 新 DSH 进程可 list/search/open 该记忆；
6. promote 后生成长期记忆并保留精确短期来源引用；
7. 再次重启后长期记忆仍可检索与打开；
8. forget 后新 Search 不再返回目标，旧 Search Grant 不能继续 Open；
9. 两个 Session 与两个 Project 不串短期记忆或长期记忆；
10. 重复 remember/promote/forget 收敛为 NOOP，不覆盖既有 Fact；
11. 安装、启动、dispose、卸载过程无资源泄漏，卸载后 Profile 中插件层为 0；
12. 全量自动门禁、隔离安装 Smoke 与真实临时项目 Canary 全部通过；
13. 完成标志为 `memory_mvp_ready`；任何失败均不得创建 `v0.1.0` Tag。

---

## 二、冻结范围

### 2.1 本阶段允许

- 新增 MVP-07 验收脚本、测试和本文档；
- 修复真实联调暴露的 MVP-00～06 产品 Bug，但必须先补失败测试且只做最小修复；
- 更新 README，使其准确描述 `v0.1.0` 已实现能力、安装方法、配置、Tool 与限制；
- 真实 Canary 通过并经用户确认后，将 `package.json` 版本改为 `0.1.0` 并更新 lockfile；
- 最终门禁通过后提交发布收口，用户明确批准后创建并推送唯一 `v0.1.0` Tag。

### 2.2 本阶段禁止

- 新增 revise/freeze/restore/history/doctor/Web UI/Global Memory；
- 新增向量数据库、语义模型、自动注入全部记忆或复杂排序；
- 新增质量评分、成败归因、自动晋升或任何自进化能力；
- 修改 DSH、使用 deep import、私有数据库、Desktop IPC 或 monkey patch；
- 读取或复制用户默认 `~/.dsh`、正式 Session、正式 Workspace、Keychain 或 `.env`；
- 把 API Key 写入仓库、日志、测试快照、Receipt、命令历史或聊天；
- 在真实 Canary 通过前修改版本号、创建 Tag、GitHub Release 或 npm publish；
- 未经单独授权执行真实 Provider 请求；
- 自动执行 `npm publish` 或创建 GitHub Release。本阶段默认只创建 Git Tag。

---

## 三、MVP-07 Gate

### 3.1 Gate A：Baseline 与发布内容冻结

每次开始 MVP-07 前必须重新记录：

```bash
dsh --version
npm view @deepseek-ai/dsh-agent versions --json
npm view @deepseek-ai/dsh-agent-loop versions --json
npm view @deepseek-ai/dsh-session versions --json
npm view @deepseek-ai/dsh-tools versions --json
corepack pnpm list --depth 0
```

规则：

1. 本机 CLI 当前为 `0.1.1-rc.2`；
2. 仓库已经在 MVP-00 锁定同版本族并通过兼容性 Gate；
3. npm 默认 dist-tag 指向旧版本不构成降级依据，必须检查完整版本列表；
4. 若本机 CLI 或直接依赖出现新的共同版本族，停止本阶段，先做新的 Baseline Gate；
5. 本任务执行期间版本保持不变。

发布包只能包含：

```text
package.json
README.md
cordis.patch.yml
dist/index.mjs
dist/index.d.mts
```

禁止包含 Fixture、Fake Provider、M0.5 Runner、测试 Hook、真实 Canary 脚本、临时路径、Credential 引用值或用户数据。

### 3.2 Gate B：隔离 Profile 安装 Smoke（无需 API Key）

新增一个 release smoke 执行器，建议位置：

```text
scripts/mvp07-profile-smoke.mjs
tests/mvp07-release-smoke.spec.ts
```

固定流程：

1. 创建全新的临时根，先 `realpath(tmpdir())`，拒绝 symlink 祖先；
2. 在其下创建独立 `DSH_HOME`，确认规范路径不等于用户默认 DSH_HOME；
3. 创建临时 Profile 名称与临时 Workspace；
4. 使用 `pnpm pack` 生成的 tarball 安装：

   ```bash
   DSH_HOME=<temp> dsh plugin --profile <temp-profile> add <absolute-tarball-path>
   ```

5. `dsh --profile <temp-profile> --dump-config` 必须恰好出现一个 `dsh-mnemosyne` 层；
6. 校验 Profile 依赖指向 tarball 安装结果，不是仓库 `link:` 或源码绝对路径；
7. 校验 bundle 配置 `enabled: true`，插件公开入口可以由宿主依赖闭包加载；
8. 执行 package/export/Tool 注册与 Fiber dispose Smoke；
9. 卸载：

   ```bash
   DSH_HOME=<temp> dsh plugin --profile <temp-profile> remove dsh-mnemosyne
   ```

10. 二次 dump-config 中插件层必须为 0；
11. 只删除由脚本创建且已验证的临时根；用户默认 DSH_HOME 与仓库工作区指纹不变。

该执行器必须：

- 默认完全离线于模型 Provider；
- 不读取 `DEEPSEEK_API_KEY` 或任何 Credential；
- 使用参数数组调用子进程，不拼接 shell 字符串；
- 有固定超时、退出码和静态脱敏错误码；
- 即使失败也执行受边界验证的清理；
- 不把绝对路径写进持久报告；
- 不进入生产 bundle 或根导出。

### 3.3 Gate C：真实临时项目 Canary（需要用户单独授权）

Gate B 经 CTO 签收后才能准备 Gate C。实现代码和设计通过不代表允许真实调用。

#### 3.3.1 隔离与凭据

- 新建临时 DSH_HOME、临时 Profile、临时 Workspace；
- 继续使用 Gate B 已验证的 tarball；
- Credential 只能由用户静默写入该临时 DSH_HOME 的 `.credentials.yaml`，权限 `0600`；
- 文件格式使用 DSH 官方 Credential Provider 的单层映射：`DEEPSEEK_API_KEY: <value>`；
- Mnemosyne、Gemini、脚本和报告均不得读取、解析、打印或复制 Key；
- 禁止使用用户默认 `~/.dsh/.credentials.yaml`；
- Canary 完成后删除整个临时运行根，用户负责销毁临时 Key。

#### 3.3.2 调用预算

冻结上限：

```text
最多 6 次 headless 任务
最多 12 次模型请求（含自动提取）
自动重试 0
单任务超时 120 秒
批次总超时 12 分钟
连续 2 次 Provider/协议错误立即停止
```

脚本不得在预算不足时继续，不得自动扩大预算或切换 Provider/模型。

#### 3.3.3 固定闭环

临时项目写入不含秘密、路径或命令的唯一安全知识，例如：

```text
项目中的 Aurora 组件使用琥珀色封装格式，校验标识为 aurora-envelope-v1。
```

固定执行：

1. **Run 1 / 自动采集**：让 Agent 阅读该安全知识并完成一个正常任务；验证原任务成功，随后出现一条合法 short-term Fact 与新 CURRENT；
2. **Run 2 / 重启读取**：新 DSH 进程显式调用 status/list/search/open；查询使用换措辞表达，不复制原标题；验证 search 无 body、open 只打开一条且绑定 Search Disclosure；
3. **Run 3 / Promote**：显式 list 后 promote 目标短期记忆；验证 long-term Fact 来源引用精确，原 short Fact 保留但退出默认 Generation；重复 promote 返回 NOOP；
4. **Run 4 / 再次重启**：新 DSH 进程换措辞 search/open，验证长期记忆跨 Session 与进程保留；
5. **Run 5 / Forget 与 Grant**：先 search 获得 Grant，再 forget 长期记忆；旧 Grant 再 open 必须失败，新 search 不再返回目标；重复 forget 返回 NOOP；
6. **Run 6 / Scope 隔离**：在第二临时项目和第二 Session 中验证第一项目长期记忆不可见、其他 Session 短期记忆不可见。

验收不得只相信模型自然语言声明。必须从临时 Session Event、Fact、Manifest、Generation、CURRENT 与 Tool 输出中核对：

- 实际发生的 Tool 名称与调用顺序；
- Tool 输出严格 Schema 与 Hash；
- Fact 数量、Scope、tier、来源引用和 NOOP；
- Generation 输入与页面集合；
- Search/Open Disclosure 绑定；
- Forget 后旧 Grant 失效；
- Session/Project 隔离。

如果模型没有按要求调用 Tool，该 Run 记为 `model_noncompliance`，不得伪造成产品 Bug，也不得自动重试；由 CTO 决定是否用新的独立授权重跑。

#### 3.3.4 真实 Canary 报告

只保存脱敏统计事实：

```yaml
schema_version: 1
status: pass|fail|aborted
dsh_version: 0.1.1-rc.2
package_version: 0.0.0-dev
package_sha256: sha256_...
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

报告禁止包含 Prompt、回复正文、完整命令、绝对路径、Session 内容、Fact body、API Key、Header、底层 Provider 错误正文或模型思考。

### 3.4 Gate D：发布收口

只有 Gate A/B/C 全部通过且用户明确确认，才执行：

1. 更新 README：
   - 当前状态改为 `v0.1.0` 完整记忆 MVP；
   - 准确列出 7 个 Tool；
   - 给出 tarball/Profile 安装、配置、卸载示例；
   - 说明短期/长期 Scope、自动采集、渐进披露、逻辑 forget；
   - 明确 v0.1.0 限制和不包含自进化；
2. `package.json` 版本由 `0.0.0-dev` 改为 `0.1.0`；
3. 仅用 `pnpm install --lockfile-only` 或项目既有方式同步 lockfile，不升级任何依赖；
4. `pnpm pack` 产物名必须为 `dsh-mnemosyne-0.1.0.tgz`；
5. 对最终 0.1.0 tarball 重跑 Gate B 和全部自动门禁；
6. 提交发布收口；
7. 用户确认提交 SHA 后创建 annotated tag：

   ```bash
   git tag -a v0.1.0 -m "dsh-Mnemosyne v0.1.0"
   git push origin main
   git push origin v0.1.0
   ```

8. 不自动 npm publish，不自动创建 GitHub Release。

---

## 四、真实 Bug 与环境/模型失败的分类

| 分类 | 示例 | 处理 |
|---|---|---|
| 产品 Bug | Fact/Hash/Scope/CURRENT/Grant 行为违反冻结协议 | 先写失败测试，最小修复，重新跑全部 Gate |
| DSH 兼容问题 | tarball 无法加载、公开 API 漂移 | 停止发布，回到 Baseline Gate |
| 模型不服从 | 未调用指定 Tool、输出自然语言代替 Tool | `model_noncompliance`，不自动归因产品 |
| Provider/凭据 | Key 无效、限流、网络错误 | 稳定失败并停止，不记录响应正文 |
| 环境问题 | 临时目录清理、权限、磁盘不足 | 标为 ENV，不伪造通过 |
| 安全问题 | 默认 DSH_HOME 被访问、路径/秘密泄漏 | 立即停止，发布阻断 |

所有失败都必须保留已验证的最小脱敏证据；不得为了让验收通过而放宽 Schema、安全边界、Scope 或 Hash 校验。

---

## 五、自动化测试矩阵

至少覆盖：

1. tarball 文件集合精确；
2. 临时 Profile add/dump/remove/dump；
3. 插件层安装后恰好 1、卸载后恰好 0；
4. 非默认 DSH_HOME 与 Workspace；
5. symlink 祖先、相对路径、已有非空根拒绝且外部零写入；
6. 子进程超时、非零退出、信号终止均清理；
7. 不读取 Credential/env/default DSH_HOME；
8. 报告严格 Schema、Canonical Hash、未知字段拒绝；
9. 报告脱敏；
10. package/export/Test Hook 零泄漏；
11. README 中安装命令与当前官方 DSH bundle 机制一致；
12. package version 与 lockfile 一致；
13. Tag 前工作区干净、提交已位于 origin/main；
14. 禁止在 Canary 通过前把版本改成 0.1.0；
15. 默认执行路径真实 Provider 调用次数为 0。

---

## 六、阶段执行顺序

### MVP-07A：离线实现

Gemini 只完成：

- release smoke 脚本；
- 安装/卸载、隔离、脱敏、清理测试；
- 真实 Canary 的严格计划/报告结构与 `--dry-run`；
- Canary preflight，输出调用预算、隔离根 Hash、tarball Hash 和待用户授权状态；
- 文档状态更新为 `🟠 离线 Gate 完成，待真实 Canary 授权`。

07A 禁止读取 Key、调用 Provider、改版本号、Tag、npm publish。

### MVP-07B：用户授权的真实 Canary

由 CTO 复核 07A 后准备全新的临时根。用户在本机静默写入临时 Credential，并单独确认执行。执行最多 6 个 Run/12 次模型请求，结束后删除临时运行根并输出脱敏报告。

07B 失败时停止，不进入发布收口。

### MVP-07C：发布收口

07B 通过且用户确认后才更新 README、版本和 lockfile，重跑最终 tarball Smoke 与全量门禁。发布提交签收后，再由用户授权创建 `v0.1.0` Tag。

---

## 七、门禁

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
corepack pnpm peers check
git diff --check
git diff --cached --check
```

07A 额外运行 release smoke 的 focused tests 与 `--dry-run`。07C 对最终 `0.1.0` tarball 重新执行一次隔离 Profile add/dump/remove/dump。

---

## 八、Gemini 3.7 Flash 执行提示词（仅 MVP-07A）

```text
你正在 /Users/czy/Desktop/demo/dsh-Mnemosyne 执行 v0.1.0 内部任务 MVP-07A：真实闭环发布验收的离线 Gate。

先完整读取：
- AGENTS.md
- docs/DSH_MNEMOSYNE_VERSION_ROADMAP.zh-CN.md
- docs/DSH_MNEMOSYNE_V010_MVP07_REAL_LOOP_RELEASE_PLAN.zh-CN.md
- package.json
- cordis.patch.yml
- tests/pack-check.mjs
- 当前 DSH 官方“打包与安装插件”文档

先显式输出：
1. 假设；
2. 成功标准；
3. 计划修改文件；
4. 当前 dsh --version 与完整 npm versions 中共同可用的基线；
5. 真实调用计数必须为 0 的证明方式。

严格范围：只实现文档第六章 MVP-07A。先 TDD：每项先写失败测试、记录真实失败证据，再做最小实现。不得修改记忆产品协议或添加 MVP-07B/C 功能。

必须交付：
- tarball 隔离 Profile add/dump/remove/dump 的 release smoke；
- 安全临时根、子进程参数数组、超时、清理、用户默认状态零写入；
- 真实 Canary 的严格 Plan/Report Schema、Canonical Hash 与 dry-run；
- preflight 只输出脱敏预算、Hash 与 awaiting_user_approval；
- 测试证明 dry-run/默认路径不会读取 Key、Credential、默认 DSH_HOME 或调用 Provider；
- pack-check 阻止脚本、测试 seam、Fixture 和临时数据进入生产包；
- 文档状态更新为“🟠 离线 Gate 完成，待真实 Canary 授权”。

不可协商：
- 不读取 process.env 中的 Key；
- 不调用真实 Provider；
- 不复制默认 ~/.dsh；
- 不使用 shell 字符串拼接；
- 不改 package version；
- 不改 README 发布状态；
- 不 commit/push/tag/npm publish/GitHub Release；
- 不进入 MVP-07B/C；
- 不新增任何记忆产品能力。

实现完成后自行执行两轮审查：

Code Review：检查安装对象确为 tarball、Profile 层计数、清理边界、错误分类、Canonical/Hash、零产品改动。

Security Review：检查 symlink/路径穿越、默认 DSH_HOME/Workspace/Credential 零访问、子进程注入、超时、日志脱敏、测试 seam 与产物泄漏。

发现问题必须先修复并重跑全部门禁。最后不要贴逐步操作日志，只输出《CTO 交接摘要》，包括：
- 修改文件；
- 修复前失败证据；
- release smoke 的真实 add/dump/remove/dump 证据；
- 临时根与默认用户状态隔离证明；
- dry-run/Provider/Credential 零调用证明；
- Plan/Report Schema 与状态机；
- Code/Security Review 发现及修复；
- 精确测试数与全部门禁原始结果；
- git status；
- 未 commit/push/tag、未进入 MVP-07B/C。
```

---

## 九、最终签收

MVP-07 只有在以下条件同时成立时完成：

- [ ] Gate A Baseline/发布内容冻结；
- [ ] Gate B tarball 隔离安装 Smoke；
- [ ] Gate C 六步真实临时项目闭环；
- [ ] 自动采集失败不覆盖原任务结果；
- [ ] restart/promotion/search/open/forget/scope 全部真实验证；
- [ ] 默认用户状态零读写；
- [ ] 真实 Key 与模型内容零泄漏；
- [ ] README、package version、lockfile 收口；
- [ ] 最终 0.1.0 tarball 全门禁；
- [ ] 用户签收发布提交；
- [ ] `v0.1.0` annotated Tag 指向已推送提交。

完成后输出唯一状态：

```text
memory_mvp_ready
```
