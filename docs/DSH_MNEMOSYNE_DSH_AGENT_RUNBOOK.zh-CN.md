# dsh-Mnemosyne v0.2 DSH Agent Runbook

> 状态：当前有效
>
> 适用版本：`@cziyi/dsh-mnemosyne@0.2.x`
>
> 读者：受用户委托执行安装、更新、卸载和验证的 DSH Agent

## 一、目标与边界

当用户说“帮我安装 Mnemosyne”“帮我更新 Mnemosyne”或“卸载 Mnemosyne”时，Agent 应自行完成环境检查、目标 Profile 确认、操作、验证和结果报告。用户不需要理解 pnpm、Profile 目录、插件配置或任何 `mnemosyne_*` 工具。

本 Runbook 不是普通用户的手动安装教程。Agent 必须遵守：

- 只使用 DSH 公开的 `plugin`、Profile 和配置检查入口；
- 先确认实际承载用户会话的 Profile，不默认修改全部 Profile；
- 不读取、复制或输出 Credential 内容；
- 不删除项目中的 `.dsh-mnemosyne/` 数据；
- 不用 `mnemosyne_status` 等 v0.1 工具验证 v0.2；v0.2 不注册这些工具；
- 运行中的旧 Agent 不会被追溯重装。安装或更新后，应让目标 DSH 服务创建新的 Agent 生命周期；对 DSH Web，通常需要重启对应 Web 进程并新建会话。

## 二、安装前检查

### 2.1 确认环境

依次检查并记录：

```bash
node --version
dsh --version
npm view @cziyi/dsh-mnemosyne version
```

要求：

- Node.js 满足包声明的 `>=22.19.0`；
- 当前 v0.2 发布基线为 DSH `0.1.1-rc.2`；若用户环境不同，不宣称兼容，先报告差异；
- registry 可访问并能解析目标包版本。

### 2.2 确认目标 Profile

从用户实际启动方式、当前 DSH 进程参数或已有 Profile 配置确认目标：

- `dsh web` 对应 `web` Profile；
- `dsh --profile <name>` 对应显式 `<name>`；
- 只有用户明确要求多个 Profile 时才逐个操作。

使用以下命令检查组合配置：

```bash
dsh --profile <profile> --dump-config
```

不要使用无效形式 `dsh plugin --profile <profile> dump-config`。

### 2.3 记录可回滚状态

操作前记录目标 Profile 中 Mnemosyne 是否已安装及其精确版本。需要修改时，备份目标 Profile 的 `package.json` 与 lockfile；备份不得包含或展示 Credential 内容。

## 三、安装

对已经确认的单个 Profile 执行：

```bash
dsh plugin --profile <profile> add @cziyi/dsh-mnemosyne@0.2.0
```

若用户要求当前 `0.2.x` 最新版，可先解析 registry 版本，再将命令中的版本替换为已确认的精确版本；最终报告不得只写 `latest`。

安装后执行第六章的统一验证。不要为了“全局可用”盲目写入 `default`、`demo`、`headless` 和 `web` 全部 Profile；DSH 的插件依赖按 Profile 管理。

## 四、更新

1. 读取目标 Profile 当前安装的精确版本；
2. 解析用户要求的目标版本；
3. 记录升级前版本和回滚点；
4. 使用同一公开入口安装精确目标版本：

```bash
dsh plugin --profile <profile> add @cziyi/dsh-mnemosyne@<target-version>
```

5. 执行第六章的统一验证；
6. 重启承载该 Profile 的 DSH 服务并新建会话。

从 v0.1 更新到 v0.2 时必须报告：v0.1 Fact 数据保留在磁盘，但 v0.2 不读取、不迁移，也不编译到 v2 Generation。Agent 不得自行删除或改写旧数据。

## 五、卸载

对已经确认的 Profile 执行：

```bash
dsh plugin --profile <profile> remove @cziyi/dsh-mnemosyne
```

然后验证组合配置和 Profile 依赖中均不再包含该包。运行中的旧 Agent 可能继续持有已加载实例，必须结束旧 Agent 生命周期或重启对应 DSH 服务。

卸载默认只移除插件，不删除任何项目的 `.dsh-mnemosyne/`。只有用户明确授权数据删除且给出精确项目路径时，才另行处理数据；数据删除不属于本 Runbook 的默认动作。

## 六、统一验证

### 6.1 配置与安装验证

至少验证：

1. `dsh --profile <profile> --dump-config` 中 `dsh-mnemosyne` 恰好启用一次；
2. 目标 Profile 的依赖解析到请求的精确包版本；
3. DSH 启动无插件装配错误；
4. v0.2 会话工具列表中不存在 `mnemosyne_*`，这是预期产品行为，不是安装失败。

### 6.2 零操作功能 Smoke

在受控测试项目和目标 Profile 的新会话中：

1. 用自然语言完成一个会产生可复用项目经验的普通任务，不调用记忆工具；
2. 等待 turn 结束后的 Consolidation 收敛；
3. 检查项目内 `.dsh-mnemosyne/v2/CURRENT` 是否存在且可读取；
4. 检查 `.dsh-mnemosyne/debug/runtime.jsonl` 是否出现 Consolidation 的 `created` 或可解释的 `skip/noop`；
5. 新建 Session，用不同措辞提出同类问题；
6. 从 JSONL 确认 Recall 按 `Title → Summary → Content` 展开，并确认主任务正常完成。

Smoke 不得把日志或 Memory Content 原文复制到公开报告；只报告结果、计数、稳定 reason code 和必要的相对路径。

## 七、失败与回滚

- 环境或版本不兼容：停止修改并报告实际版本；
- 安装/更新失败：恢复备份，或通过公开 `plugin add` 重装升级前的精确版本；
- 配置重复、插件无法加载：不要手改 DSH 私有状态，优先移除后按精确版本重新安装；
- 功能 Smoke 失败：保留项目数据，读取 `.dsh-mnemosyne/debug/runtime.jsonl` 的稳定 reason code 诊断；
- 任何失败都不得读取 Credential 内容、删除 Memory 数据或改动其他 Profile。

## 八、向用户报告

操作完成后用简短结构化结果报告：

```text
操作：install | update | uninstall
Profile：<name>
DSH 版本：<version>
Mnemosyne：<before-version> → <after-version>
配置验证：pass | fail
新 Agent 生命周期：已重启/已新建 | 仍需用户重启
零操作 Smoke：pass | fail | 未执行（原因）
项目记忆数据：保留
警告：无 | <稳定、脱敏的说明>
```

不得把“命令退出码为 0”单独当作成功。安装/更新至少需要配置装配验证；执行了功能 Smoke 时，还需要 JSONL 与 v2 CURRENT 证据闭合。
