# dsh-Mnemosyne 版本路线图

> 状态：✅ v0.2.0 Completed / MVP Complete
>
> 更新日期：2026-08-31

## 一、版本原则

- 版本按用户可感知的完整能力划分，不按内部模块划分；
- 每个版本必须相对上一版解决一个明确问题；
- 只使用 DSH 已公开插件扩展，不要求修改 DSH；
- 设计文档先于代码，一个可审查行为一个提交；
- 记忆失败不得改变 DSH 主任务结果；
- 自进化、代码生成、自修改和自动发布不属于本路线。

~~~text
v0.1.0  工具式技术预览
  → v0.2.0 零操作 OKF 记忆 MVP（Completed）
  → v0.3.0 MVP 后：管理与规模化
  → v1.0.0 MVP 后：正式稳定版
~~~

## 二、v0.1.0：工具式技术预览（历史）

状态：已发布。

该版本验证了：

- DSH 插件装配和 Project/Session Scope；
- 不可变 Fact Store 与原子 Generation/CURRENT；
- Search/Open 分层读取；
- 自动采集、短期/长期、晋升与遗忘；
- 临时项目 Canary 与 npm 发布流程。

它依赖用户或模型调用记忆工具，并使用关键词式 Search，不是当前产品体验。v0.1 数据保留但不迁移到 v0.2。

旧 M0.5 和 MVP-00～07 执行计划已从当前文档目录删除，需要审计时从 Git 历史中的 v0.1 发布提交读取。

## 三、v0.2.0：零操作 OKF 记忆 MVP

状态：**Completed / MVP Complete**。本地连续观察与发布是发布运营活动，不是 MVP 功能完成 Gate。

相对 v0.1 的提升：

- 用户从手动/显式 Tool 管理变为只需正常对话；
- 每条记忆从普通 Fact/页面变为独立 OKF Memory；
- 检索从关键词打分变为模型阅读 Title 与 Summary 后自主选择；
- 披露严格遵循 Title → Summary → Content；
- 新经验在正常 turn 后自动沉淀为项目级持久记忆；
- 新踩坑创建关联新记忆，旧记忆保持不可变；
- 用户会话和生产包不再暴露记忆工具；
- 通过结构化 JSONL 解释 Recall 和 Consolidation。

完成 Gate：

- [x] v2 Memory Store 与 Catalog；
- [x] Title/Summary/Content Generation；
- [x] 无工具 Recall Runtime；
- [x] 自动 Consolidation Runtime；
- [x] 开发者 JSONL；
- [x] 最多三层的多层 Catalog 自动组织；
- [x] 绑定 Project Scope、父节点与 Title 的路径相关 Node ID；
- [x] Catalog depth=3 与 Recall budget=8 闭合；
- [x] 同项目并发沉淀不丢 Catalog 更新；
- [x] 下一轮 Recall 等待同 Project 已启动的 Consolidation，跨 Project 不互相阻塞；
- [x] 真实 AgentLoop 双 Session 自动沉淀与换措辞 Recall；
- [x] Project A 自动沉淀后 Project B Recall 不可见的跨项目 E2E；
- [x] 独立 DSH 进程退出、重启后从磁盘恢复 Recall 的 E2E；
- [x] 全量测试、构建、打包和发布边界门禁。

MVP 后发布运营事项：

1. 安装候选包并连续本地使用 3～7 天；
2. 按本地观察规范评估质量、漏召回、错误召回、延迟与磁盘增长；
3. 修复观察期发现的 P0/P1 问题后执行正式发布流程。

## 四、v0.3.0：MVP 后的管理与规模化

进入条件：v0.2 本地观察证明零操作记忆闭环有实际价值。

候选目标：

- Web 记忆浏览、检查和显式管理；
- Catalog 重组、重复检测和容量/保留策略；
- Doctor、备份、恢复和派生视图重建；
- 显式、安全的跨项目记忆共享；
- 大型记忆库的延迟、Token 与磁盘控制。

这些目标必须根据 v0.2 真实观察结果重新设计，不提前沿用 v0.1 的 Tool 协议。

## 五、v1.0.0：MVP 后的正式稳定版

进入条件：v0.3 的功能范围完成且经过长期使用验证。

主要工作：

- 冻结公开 Schema、错误码和迁移协议；
- 覆盖 v0.1、v0.2、v0.3 数据兼容或明确迁移；
- macOS/Linux 与受支持 DSH 版本矩阵；
- 性能、并发、磁盘和 Token 上限；
- 安装、升级、卸载、备份、恢复文档；
- 正式 Release 与兼容承诺。

## 六、通用开发门禁

~~~bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm pack
node tests/pack-check.mjs
corepack pnpm peers check
git diff --check
~~~

任何版本未通过自己的纵向验收，不为了版本号发布。
