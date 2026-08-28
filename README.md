# dsh-Mnemosyne

> 面向 DeepSeek Harness 的长期记忆与渐进式披露插件。

`dsh-Mnemosyne` 是一个 DeepSeek Harness 原生插件，用于将 Agent 的工程经验
组织为 OKF 风格的知识图谱，并只向当前任务披露必要的上下文。

## 项目目标

- 将长期工程经验保存为结构化、可审查的记忆；
- 通过 OKF Wiki 页面和确定性索引组织记忆关系；
- 通过渐进式披露避免把整个记忆库注入单轮上下文；
- 保留来源、生命周期、健康度和冻结语义；
- 通过 DeepSeek Harness 的插件与 Session/Event 扩展点完成集成。

## v0.1.0 能力

当前 MVP 已实现完整记忆管理闭环：

```text
Harness Session/Event
  -> 自动采集或 mnemosyne_remember
  -> 不可变 Fact Store
  -> 确定性 OKF Generation
  -> mnemosyne_search（L2，无正文）
  -> mnemosyne_open（L3，绑定 Search Grant）
  -> list / promote / forget
```

短期记忆按 Session + Project 隔离；长期记忆可在同一 Project 的后续 Session 中检索。
`forget` 只更新逻辑可见性并保留不可变审计事实；所有写入和 Generation 发布均采用
fail-closed 路径校验与原子提交。

## 安装

要求 Node.js `>=22.19.0`，DSH CLI 与公开 SDK 基线为 `0.1.1-rc.2`。

```bash
dsh plugin add @cziyi/dsh-mnemosyne
```

插件默认启用自动采集。可在 DSH 插件配置中使用：

```yaml
enabled: true
autoCapture: true
# projectRoot: /absolute/project/path  # Session 缺少 cwd 时的可选回退
```

## Tools

- `mnemosyne_status`：查看 Scope、当前 Generation 与记忆数量；
- `mnemosyne_remember`：显式记录记忆；
- `mnemosyne_search`：只返回摘要与引用，不返回正文；
- `mnemosyne_open`：在同 Session 的 Search Grant 内打开一条记忆正文；
- `mnemosyne_list`：列出短期或长期记忆；
- `mnemosyne_promote`：将短期记忆晋升为长期记忆；
- `mnemosyne_forget`：使目标记忆不可检索并使旧 Grant 失效。

## 当前状态与限制

`v0.1.0` 为记忆管理 MVP，已覆盖自动采集、稳定读写、OKF 编译、渐进式披露、
晋升、遗忘、重启持久化与 Project/Session 隔离。它不包含插件自进化、自动改代码、
自动发布、Web 管理器或向量数据库。

真实 Provider 的行为与成本取决于模型；发布包的确定性验收使用真实 DSH 子进程、
真实打包插件和受控离线 Provider 完成六轮业务 Canary。

总体架构、阶段计划与后续实施设计见：

- [dsh-Mnemosyne 总体设计](docs/DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md)
- M0 开发契约与实现检查清单位于总体设计第 18 章。

## 许可证

本项目采用 [MIT License](./LICENSE)。
