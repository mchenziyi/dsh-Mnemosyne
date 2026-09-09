# DSH 0.1.2-alpha.4 兼容适配计划

> 历史基线记录。当前开发依赖与版本断言已迁移到 DSH `0.1.3-alpha.2`，生产入口默认使用 V3；新的真实 Web 验收不由下述 alpha.4 历史结果替代。

状态：alpha.4 本地适配与回归完成；v0.2.9 真实 Web 召回、沉淀及会话收尾样本通过。Web 宿主存在 alpha.4 CLI / alpha.5 LLM、Session 依赖差异，不视为纯 alpha.4 或完整 alpha.5 兼容认证。

## 目标

将 Mnemosyne 的开发/对等依赖与兼容性基线对齐本机 DSH `0.1.2-alpha.4`，并验证现有 v0.2/v0.3 功能仍使用 DSH 公开 API 正常运行。

## 范围与不变项

- 仅处理 DSH、Cordis、Schemastery 版本升级及由此产生的公开 API/启动行为差异。
- 不改变 OKF、渐进式披露、自动沉淀、Scope 隔离和 v3 子代理业务语义。
- 不新增工具、不调整 npm 发布版本、不迁移旧记忆。
- 不把 `dsh-tools` 额外加入 peerDependencies；由 DSH 运行时提供的服务继续通过公开注入使用。

## 实施顺序

1. 记录 alpha.4 公开包版本与 API 审计结果。
2. 将直接 DSH 依赖、Cordis、Schemastery 与 `src/compatibility.ts` 基线统一到 alpha.4 配套版本，重新生成 lockfile。
3. 运行类型检查与现有协议/运行时测试，按实际编译错误做最小适配。
4. 对 `web` profile 做全新进程/页面启动验证，确认 `client-modules` boot manifest 错误与 Mnemosyne 插件无关；若属于 DSH profile 缓存或 manifest，则只记录证据，不在插件内绕过。
5. 运行全量 test、typecheck、build、pack、pack-check、peers check 与 diff 检查。

## 验收标准

- `package.json`、`pnpm-lock.yaml`、兼容常量无旧 rc.2 残留（历史文档除外）。
- 生产源码只使用 alpha.4 公开的根导出与服务接口，无 deep import/private API。
- alpha.4 适配相关测试、构建、打包与依赖门禁通过；真实 Web 子代理生命周期仍需在本机验收。
- `dsh --profile web --dump-config` 成功，Web 启动错误有独立复现/归因结论。

当前门禁：`typecheck`、全量 `83` 个测试文件 `829` 项测试、`build`、`pack`、`pack-check`、`peers check` 与 `git diff --check` 全部通过。2026-09-04 真实 Web 样本及环境边界见 [Runbook 验收记录](DSH_MNEMOSYNE_DSH_AGENT_RUNBOOK.zh-CN.md#八v029-本地验收记录2026-09-04)。

## 回滚

适配失败时恢复 package/lock/compatibility 三类基线文件，不触碰已有功能改动；本机旧 DSH 备份位于用户显式创建的备份目录。
