# DSH 0.1.2-alpha.3 兼容适配计划

状态：🟡 设计完成，待实现与门禁验证

## 目标

将 Mnemosyne 的开发/对等依赖与兼容性基线对齐本机 DSH `0.1.2-alpha.3`，并验证现有 v0.2/v0.3 功能仍使用 DSH 公开 API 正常运行。

## 范围与不变项

- 仅处理 DSH、Cordis、Schemastery 版本升级及由此产生的公开 API/启动行为差异。
- 不改变 OKF、渐进式披露、自动沉淀、Scope 隔离和 v3 子代理业务语义。
- 不新增工具、不调整 npm 发布版本、不迁移旧记忆。
- 不把 `dsh-tools` 额外加入 peerDependencies；由 DSH 运行时提供的服务继续通过公开注入使用。

## 实施顺序

1. 记录 alpha.3 公开包版本与 API 审计结果。
2. 将直接 DSH 依赖、Cordis、Schemastery 与 `src/compatibility.ts` 基线统一到 alpha.3 配套版本，重新生成 lockfile。
3. 运行类型检查与现有协议/运行时测试，按实际编译错误做最小适配。
4. 对 `web` profile 做全新进程/页面启动验证，确认 `client-modules` boot manifest 错误与 Mnemosyne 插件无关；若属于 DSH profile 缓存或 manifest，则只记录证据，不在插件内绕过。
5. 运行全量 test、typecheck、build、pack、pack-check、peers check 与 diff 检查。

## 验收标准

- `package.json`、`pnpm-lock.yaml`、兼容常量无旧 rc.2 残留（历史文档除外）。
- 生产源码只使用 alpha.3 仍公开的根导出与服务接口，无 deep import/private API。
- 现有测试全部通过；若 v3 真实生命周期仍受 alpha.3 行为影响，必须明确记录为阻断，不以放宽测试或静默回退掩盖。
- `dsh --profile web --dump-config` 成功，Web 启动错误有独立复现/归因结论。

## 回滚

适配失败时恢复 package/lock/compatibility 三类基线文件，不触碰已有功能改动；本机旧 DSH 备份位于用户显式创建的备份目录。
