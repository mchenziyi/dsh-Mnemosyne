# dsh-Mnemosyne

> 面向 DeepSeek Harness 的零操作 OKF 长期记忆插件。

`dsh-Mnemosyne` 会在普通对话中自动回忆和沉淀项目经验。安装后，用户只需正常使用 DSH，不需要学习或调用任何记忆工具。

## v0.2.0 的工作方式

```text
用户正常提出问题
  → 当前 Agent 使用自己的模型阅读 OKF 分类 Title
  → 按需展开分类 Summary
  → 按需展开 Memory Title
  → 最多查看 5 条 Summary
  → 最多确认 3 条完整 Content
  → 已确认记忆作为可重放的 plugin recall 消息进入主模型请求
  → 主模型完成任务
  → turn 正常结束后自动判断是否形成新经验
  → create / skip / noop
  → 新经验写入项目级 OKF Memory，并发布新 Catalog 与 Generation
```

渐进式披露严格遵循 `Title → Summary → Content`。模型负责语义理解与选择，插件不通过关键词、tags、别名或向量分数替模型判断相关性。

## 安装

要求：

- Node.js `>=22.19.0`
- DeepSeek Harness / DSH 公开 SDK 基线 `0.1.1-rc.2`

```bash
dsh plugin add @cziyi/dsh-mnemosyne
```

插件默认启用。安装或升级后，请新建 DSH 会话，或重启承载现有会话的 DSH Web 进程，使新的插件装配进入 Agent 生命周期。

可选配置只有：

```yaml
enabled: true
# projectRoot: /absolute/project/path  # Session 没有 cwd 时的可选回退
```

## 日常使用

不需要任何特殊命令：

1. 在项目中正常向 DSH 提出任务；
2. 有相关历史经验时，插件会在主模型执行前自动逐层回忆；
3. 没有相关记忆时，主任务直接继续；
4. 任务正常完成后，插件自动判断是否值得沉淀；
5. 没有新知识时不会创建记忆。

v0.2.0 不注册 `mnemosyne_status`、`mnemosyne_search`、`mnemosyne_open`、`mnemosyne_remember` 等会话工具。未来的用户记忆管理入口将由 Web 管理器提供。

## OKF Memory

每条新记忆都是独立、不可变的 OKF Memory，包含：

- `title`：第一层快速判断；
- `summary`：第二层简洁总结；
- `content`：完整的结构化 Markdown 经验；
- `related_memory_refs`：相关记忆引用。

新踩坑会创建一条关联的新记忆，不会改写旧记忆。所有 v0.2 记忆直接属于 Project Scope，可供同一项目的新会话使用。

项目数据位于：

```text
<project>/.dsh-mnemosyne/
├── v2/
│   ├── memories/
│   ├── catalogs/
│   ├── generations/
│   └── CURRENT
└── debug/
    └── runtime.jsonl
```

v0.1.0 的旧 Fact 数据会保留在磁盘，但 v0.2.0 不读取、不迁移，也不会编译进新版 Generation。

## 开发者诊断

`.dsh-mnemosyne/debug/runtime.jsonl` 记录脱敏结构化事件，可用于判断：

- Recall 是否启动以及每层披露/选择数量；
- 为什么没有召回；
- Consolidation 是 `created`、`skip`、`noop` 还是失败；
- Catalog 与 Generation 是否成功发布。

日志不会进入模型上下文或 OKF，不保存用户全文、完整 Memory Content、Prompt、模型原始输出、隐藏思考、凭据或绝对路径。

## 当前边界

v0.2.0 聚焦项目级长期记忆闭环，不包含：

- Session 短期记忆、手动晋升或遗忘；
- Evidence、Revision、健康度、治理和成功计数；
- Web 管理、自进化、向量数据库；
- v0.1.0 数据迁移。

设计与实现细节见：

- [v0.2.0 零操作 OKF 记忆闭环实施计划](docs/DSH_MNEMOSYNE_V020_ZERO_OPERATION_OKF_MEMORY_PLAN.zh-CN.md)
- [dsh-Mnemosyne 总体设计](docs/DSH_MNEMOSYNE_ARCHITECTURE.zh-CN.md)
- [版本路线图](docs/DSH_MNEMOSYNE_VERSION_ROADMAP.zh-CN.md)

## 许可证

本项目采用 [MIT License](./LICENSE)。
