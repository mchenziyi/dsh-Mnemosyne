# dsh-Mnemosyne v0.2 MVP 收口设计

> 状态：🟢 分类决策协议实现完成，待真实 DSH 运行验证
>
> 日期：2026-08-31
>
> 目标：只收口“自动记、自动组织、自动找、按需读、可靠隔离”五项 MVP 能力

## 一、范围

本轮只解决四个实现问题：

1. Consolidation 从 Root 一级分类扩展为有限深度的多层 OKF 自动组织；
2. Catalog Node ID 改为路径相关的确定性身份；
3. 冻结 Catalog 最大深度，并使 Recall Budget 保证能够走到 Memory Content；
4. 同一 Project 的下一轮 Recall 等待上一轮已经启动的 Consolidation 收敛。

完成实现后只补两项纵向验收：跨 Project 隔离 E2E、真实 DSH 进程重启 E2E。

本轮不实现记忆质量治理、去重/合并、过时淘汰、Revision、Forget、Multi-path Recall、Catalog 自动重构、UI 或 Global Memory。

Mnemosyne 不采用 RAG 路线，不引入 Embedding、Vector DB、BM25、reranker、分块或 Top-K retrieval。核心路线保持：

```text
OKF 组织知识
  → Title 渐进披露
  → 模型逐层判断
  → Summary 渐进披露
  → 模型最终确认
  → 读取 Memory Content
```

## 二、冻结常量与结构边界

### 2.1 Catalog 深度

- Root 深度为 `0`；
- Root 下最多允许 `3` 层 Catalog Node；
- Memory 只能挂在非 Root Node；
- 第 3 层 Node 必须是叶子分类，不能继续创建或选择子分类；
- 本轮只允许沿单一路径组织和 Recall，不做多路径探索。

允许的最深结构为：

```text
ROOT
└── Authentication          # depth 1
    └── JWT                 # depth 2
        └── Refresh Token   # depth 3
            └── Memory
```

### 2.2 Recall Budget

单条主路径冻结为最多 `8` 次模型判断：

```text
1  Root 子节点 Title
2  depth 1 Node Summary
3  depth 1 下一层 Title
4  depth 2 Node Summary
5  depth 2 下一层 Title
6  depth 3 Node Summary
7  depth 3 Memory Title
8  Memory Summary
   最终确认后读取 Content，不再调用导航模型
```

浅层路径按实际深度提前结束。每次仍只允许选择已披露的 ref；Memory Summary 最多披露 5 条，最终 Content 最多读取 3 条。

## 三、四项实现收口

### 3.1 多层 Consolidation

Consolidation 的知识判断仍保持 `skip | create`。只有 `create` 进入 Catalog 导航。

Catalog 导航从 Root 开始，逐层执行：

1. 只向模型披露当前节点的直接子节点 Title；
2. 模型只可选择一个候选子节点，或声明当前 Title 列表中没有合适候选；此阶段不得创建分类；
3. 只披露被选中候选的 Summary，不披露同层其他节点 Summary；
4. 模型根据该 Summary 选择 `attach`、`expand` 或 `reject`；
5. `reject` 返回同一层并排除该候选，再从剩余 Title 中选择；
6. 只有全部候选被拒绝或模型明确声明无候选后，才通过独立阶段创建一个直接子分类；
7. 新分类仍必须具有 Title 与 Summary；其 Summary 只用于判断挂载或继续下钻，不向其他阶段批量披露；
8. 到达深度 3 时不得继续下钻；
9. 最终一次性构造新增节点、Memory 引用和新 Catalog，再发布新 Generation。

该协议严格保持 `Title → 判断 → 单个 Summary → 判断`。Consolidation 不读取关键词、tags、Embedding 或相似度分数，也不允许模型在尚未检查候选范围时直接创建同层新分类。

该流程只增加新路径或在已有路径下追加 Memory，不移动已有节点、不重组 Catalog、不修改旧 Memory。

新 Memory、Catalog 和 Generation 的可见性仍由 `CURRENT` 原子切换决定。发布中途产生但未进入新 `CURRENT` 的对象不可被 Recall 看见。

### 3.2 路径相关 Node ID

Root ID 保持固定。非 Root Node ID 使用以下规范身份确定性生成：

```text
node_id = hash(
  schema_version
  + project_scope_id
  + parent_node_id
  + exact_title
)
```

由于 `parent_node_id` 自身已经绑定上级路径，该算法递归绑定完整 Catalog 路径。

关键语义：

- 同一父节点下同名 Title 得到同一 ID，并复用已有节点；
- 不同父节点下同名 Title 得到不同 ID；
- ID 不依赖创建顺序、时间、随机数或模型输出之外的隐式状态；
- Catalog 校验必须验证所有非 Root Node 的 ID 与父节点、Title、Project Scope 一致；
- 不修改 Memory ID 规则。

### 3.3 深度与 Recall 闭合

Compiler 必须拒绝深度超过 3 的 Catalog，避免发布 Recall 永远无法到达的 Memory。

Recall 保持严格单路径：

```text
Root child Title
  → selected Node Summary
  → selected Node child/Memory Title
  → ...
  → selected Memory Summary
  → confirmed Memory Content
```

每进入一层前检查剩余 Budget。合法 Catalog 中，任意 Memory 都必须在 8 次判断内可到达；若 Catalog 超深或视图与 Catalog 不一致，Generation 编译/读取失败，不把不可达内容注入主模型。

本轮不利用 Related Memory 启动第二条 Recall 路径；相关关系仍可显示 Title，但不会自动展开。

### 3.4 Turn 间一致性

新增 Project Scope 级的 Consolidation 可见性屏障：

```text
Turn N turn/end
  → 先把 Consolidation 注册到该 Project 的 pending 链
  → 异步执行并最终 settled

Turn N+1 pre-step
  → 只等待同一 Project 在本轮开始前已经注册的 pending Consolidation
  → settled 后读取 CURRENT
  → 执行 Recall
```

关键约束：

- 等待范围只按 `project_scope_id` 隔离，不建立全局锁；
- Project A 的 Consolidation 不得阻塞 Project B 的 Recall；
- 只等待 Recall 开始前已经启动的操作，避免等待未来任务或形成自依赖；
- Consolidation 成功、skip、noop 或失败都视为 settled；失败后 Recall 读取最后一个合法 CURRENT，主任务继续；
- 多个同 Project Consolidation 继续按既有串行顺序发布，Recall 不得观察到半成品 Catalog/Generation；
- 插件 dispose 仍等待全部已启动操作收敛。

## 四、影响模块

| 模块 | 收口内容 |
|---|---|
| `src/v2/consolidation-runtime.ts` | 多层分类导航、深度限制、路径 Node ID、分层 Catalog 更新 |
| `src/v2/okf-catalog.ts` | 最大深度校验、路径身份校验、父子闭包 |
| `src/v2/okf-compiler.ts` | 拒绝超深/不可达 Catalog，继续生成分层 Title/Summary/Content 视图 |
| `src/v2/recall-runtime.ts` | 8 次单路径 Budget、深度闭合、Related Memory 不自动开第二路径 |
| `src/observer.ts` | Project Scope 级 pending 注册、Recall 前等待、dispose 收敛 |
| v0.2 对应测试 | 多层组织、同名节点、最深路径 Recall、Turn 可见性与两个 E2E |

不修改 v0.2 Memory Schema，不恢复任何 `mnemosyne_*` Tool，不引入新的用户配置。

## 五、两项 E2E 验收

### 5.1 跨 Project 隔离 E2E

使用两个真实且不同的临时 Project Root：

```text
Project A / Session A
  → 正常完成任务
  → 自动创建 Memory A 并发布 CURRENT A

Project B / Session B
  → 用与 Memory A 语义相近的措辞发起任务
  → 自动 Recall
```

验收必须同时证明：

- Project A 的 v2 Store、Catalog 和 CURRENT 包含 Memory A；
- Project B 的 Recall 消息、主模型请求和 runtime JSONL 均不包含 Memory A 的 ID、Title、Summary 或 Content；
- Project B 不读取 Project A 的 Generation；
- 两个 Project 的 `project_scope_id`、物理 v2 根目录和 CURRENT 相互独立；
- Project B 的正常任务不因 Project A 的 Consolidation 阻塞。

### 5.2 真实 DSH 进程重启 E2E

使用同一个真实临时 Project Root，启动两个彼此独立的 DSH 进程：

```text
DSH Process A / Session A
  → 正常任务结束
  → 自动沉淀 Memory
  → 等待插件 dispose 收敛
  → 进程完全退出

DSH Process B / Session B
  → 使用不同措辞提出同类问题
  → 自动 Title → Summary → Content Recall
```

验收必须同时证明：

- Process A 退出后不存在依赖进程内 Map 的未发布状态；
- Process B 从磁盘 CURRENT 和 Generation 读取 Memory；
- runtime JSONL 记录完整的分层披露顺序；
- Session B 的主模型请求实际包含最终确认的 Content；
- 用户没有调用任何 Mnemosyne Tool；
- 全程使用真实 DSH 进程，但可以使用确定性离线模型适配器，不要求真实外部 Provider。

本轮不新增复杂 Canary 框架；E2E 只服务于上述两个 MVP 结论。

## 六、推荐实施顺序

1. **冻结深度与身份测试**：先写深度 3 Catalog、不同父节点同名 Node、超深 Catalog 拒绝测试；
2. **实现路径 Node ID 与 Catalog 校验**：保证多层对象身份和闭包稳定；
3. **实现多层 Consolidation**：验证自动生成三层路径并正确挂载 Memory；
4. **调整 Recall Budget**：验证最深合法路径严格按 Title → Summary → Content 到达正文；
5. **实现 Project Scope 可见性屏障**：验证下一轮等待同 Project、不同 Project 不互相阻塞；
6. **补跨 Project E2E**；
7. **补真实 DSH 进程重启 E2E**；
8. **运行全量测试、构建和打包门禁**，五项 MVP 全部通过后冻结 v0.2。

每一步独立提交。对应测试未通过，不进入下一步；不在收口过程中加入任何后续治理能力。

## 七、实施结果

四项实现问题已闭合：

- Consolidation 可以自动创建并挂载到 Root 下最多三层的 OKF 路径；
- Node ID 已绑定 Project Scope、父节点与 Title；
- 最深合法 Catalog 可以在 8 次单路径判断内完成 Title → Summary → Content；
- 下一轮 Recall 会等待同 Project 已启动的 Consolidation，不同 Project 不互相阻塞。

两项纵向验收已闭合：

- Project A 自动创建的 Memory 不会进入 Project B 的 Store、Recall 消息、主模型请求或日志；
- 两个独立 DSH 进程完成 Process A 自动沉淀、完全退出、Process B 从磁盘自动召回。

最终门禁：

```text
typecheck        PASS
test             70 files / 755 tests PASS
build            PASS
pack             PASS
pack:check       PASS（6 个发布文件）
peers check      PASS
git diff --check PASS
```

至此，“自动记、自动组织、自动找、按需读、可靠隔离”五项 v0.2 MVP 能力完成收口。本次未加入任何后续治理或 RAG 能力。
