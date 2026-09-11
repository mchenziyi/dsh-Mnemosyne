# dsh-Mnemosyne v0.3 Governance Foundation 协议冻结稿

> 基线：v0.2.6
>
> 状态：最终冻结协议
>
> 范围：Governance Foundation；不包含治理算法、自动治理或后续 Pattern / Plugin Evolution

## 一、范围与核心架构

Governance Foundation 在现有不可变 OKF Memory 之上追加治理事实，不修改 Raw Memory 或 Raw Catalog：

```text
Raw Memory
+
Raw Catalog
+
Committed Governance Ledger
        ↓
Governance Compiler
        ↓
Effective Memory View
        ↓
Effective Catalog / Generation
        ↓
Recall
```

唯一原子生效边界保持为：

```text
单一 .dsh-mnemosyne/v2/CURRENT
+
CURRENT 所指 manifest 中的 governance_head
```

Foundation 不新增第二个可变 head，不允许 `LEDGER_HEAD`、`GOVERNANCE_CURRENT` 或 `EFFECTIVE_CURRENT` 与 `CURRENT` 并存。

以下 v0.2.6 稳定能力保持不变：自动记、自动组织、自动找、按需读、可靠隔离。

## 二、事实层与派生层

### 2.1 事实层

只有以下对象是持久事实：

- Raw Memory；
- Raw Catalog；
- 从当前 committed `governance_head` 可达的 Governance Event 单链。

Raw Memory 和 Raw Catalog 沿用 v0.2.6 的不可变、内容寻址和 Project Scope 约束。

### 2.2 派生层

以下对象均由事实层确定性生成，不是新的治理事实：

- Effective Memory View；
- Effective Catalog；
- Generation outputs；
- Replay checkpoint。

派生对象损坏或缺失时可以从事实层重建。派生对象不得反向修改 Raw Memory、Raw Catalog 或 committed Ledger。

## 三、Governance Event 单链协议

### 3.1 Event envelope

```ts
interface GovernanceEventV1 {
  schema_version: 1
  event_id: string
  event_sha256: string
  project_scope_id: string
  sequence: number
  prev_event_hash: string | null
  payload: GovernanceEventPayloadV1
  evidence_refs: GovernanceEvidenceRefV1[]
  reason_code: string
  created_at: string
}
```

规范要求：

1. `sequence` 是 Project 内 committed Governance 单链的连续序号，从 `1` 开始。
2. genesis Event 必须同时满足 `sequence = 1` 与 `prev_event_hash = null`。
3. 非 genesis Event 必须满足：

   ```text
   sequence = CURRENT.manifest.governance_head.sequence + 1
   prev_event_hash = CURRENT.manifest.governance_head.event_sha256
   ```

4. `project_scope_id` 必须与 CURRENT manifest、所有 payload refs 和 Evidence refs 属于同一 Project。
5. `created_at` 仅用于审计，不参与 Replay 顺序判断；Replay 顺序只由单链与 `sequence` 决定。
6. 对象使用 exact-key 校验和现有 canonical JSON 规则。
7. `event_sha256` 是移除 `event_id`、`event_sha256` 后 canonical Event body 的 SHA-256。
8. `event_id` 确定为 `gov_${event_sha256.slice('sha256_'.length)}`；因此 `prev_event_hash` 可以唯一推导 parent 的 `event_id`，不依赖目录遍历或时间排序。
9. `sequence` 必须是 `1..Number.MAX_SAFE_INTEGER` 范围内的 JSON safe integer；溢出时拒绝提交。

### 3.2 governance_head

Governance head 使用完整身份；读取层允许 legacy 的逻辑空值：

```ts
interface GovernanceHeadV1 {
  sequence: number
  event_id: string
  event_sha256: string
}

type LogicalGovernanceHeadV1 = GovernanceHeadV1 | null
```

三者必须与 head Event 完全一致。Replay 从该 Event 开始，沿 `prev_event_hash` 反向遍历至 genesis，并校验：

- hash 与文件内容一致；
- `event_id` 与 hash 一致；
- sequence 严格逐一递减；
- 最终恰好到达 `sequence = 1, prev_event_hash = null`；
- 全链 Project Scope 一致。

### 3.3 单 Event commit 与 orphan

创建新 Governance Event 时，parent 只能是提交开始时 CURRENT manifest 已 committed 的 `governance_head`：

```text
prev_event_hash 必须严格等于
当前 CURRENT manifest 中已 committed 的 governance_head.event_sha256。
```

若当前 head 为空，新 Event 只能是 genesis Event。

一次 Governance commit 只改变 Governance 事实及其派生输出，不同时创建 Raw Memory 或修改 Raw Catalog。其顺序固定为：

1. 读取并锁定当前 CURRENT；
2. 依据该 manifest 构造一个新 Event；
3. 以 exclusive create 写入该 Event；
4. Replay `旧 committed chain + 该 Event`；
5. 生成新的 Effective View 和 governed Generation；
6. 在切换前再次确认 CURRENT 仍是步骤 1 的值；
7. 原子切换唯一 CURRENT。

Event exclusive create 成功后、CURRENT 切换前，它只是当前活跃提交操作私有的 uncommitted candidate。Foundation 不提供该 candidate 的跨进程恢复或重新绑定：CURRENT 切换成功后它成为 committed Event；步骤 6 不满足、操作失败、中止或进程终止且 CURRENT 未切换时，它成为 orphan。

一次 CURRENT 切换最多使一个新 Governance Event 生效。

Orphan Event 的语义永久冻结为：

- 永远不能作为后续 Event 的 parent；
- 永远不能重新进入 committed chain；
- 不参与 Replay，不影响 Effective View；
- 可以保留用于诊断或后续 GC；
- 不得通过让新 CURRENT 直接或间接指向它来“补提交”。

Event commit 必须在同一次活跃操作中成功执行 exclusive create 与 CURRENT 切换。磁盘上已存在但不在当前 committed chain 的 Event 文件不得作为本次 commit candidate 复用；不存在“恢复 prepared Event”路径。重试必须基于重读后的 CURRENT 构造具有新 `created_at` 和新 Event identity 的 Event，并重新执行 exclusive create。这样禁止以下隐式多 Event commit：

```text
Event 11 写入但未 commit
→ Event 12 以 Event 11 为 prev
→ CURRENT 指向 Event 12
→ 一次 CURRENT 切换隐式提交 Event 11 与 Event 12
```

Committed 的定义只来自 CURRENT 所指 manifest 的 `governance_head` 可达性；目录遍历顺序、文件存在时间和 `created_at` 均不能使 Event 生效。诊断工具可以把“不可达且没有活跃提交操作持有”的 Event 报告为 orphan，但不得自动选择最高 sequence 或最新时间作为 head。

CURRENT 的合法 head 转换只有四种：

```text
legacy 普通 Consolidation: null → null，目标仍为 legacy
第一次 Governance commit: null → genesis Event
governed 普通 Consolidation: H → H
后续 Governance commit: H → H 的唯一直接 child
```

任何跳过 Event、指向 ancestor、指向 sibling 或从非 null 退回 null 的转换都必须拒绝。

## 四、强类型 Event payload

基础引用：

```ts
interface GovernanceMemoryRefV1 {
  memory_id: string
  content_sha256: string
}

interface GovernanceEventRefV1 {
  event_id: string
  event_sha256: string
}
```

所有引用必须能在同 Project 的 Raw World 或 committed Event chain 中解析，并且完整 identity 必须匹配。

### 4.1 supersede

```ts
type SupersedePayloadV1 = {
  action: 'supersede'
  replacement: GovernanceMemoryRefV1
  replaced: GovernanceMemoryRefV1
}
```

- 两个 Memory 必须不同且在提交前均可参与治理；
- `replacement` 成为有效后继，`replaced` 变为 `superseded`；
- replacement 关系必须无环；
- 一个 Memory 同时只能有一个直接生效的 `superseded_by`；
- unresolved conflict 的任一方不得直接 supersede，必须先 resolve conflict。

### 4.2 add_conflict

```ts
type AddConflictPayloadV1 = {
  action: 'add_conflict'
  first: GovernanceMemoryRefV1
  second: GovernanceMemoryRefV1
}
```

- 两个 Memory 必须不同、均为 active，并按 8.2 的 comparator 规范化为 `first < second`；
- 同一 canonical pair 同时只能存在一个 unresolved conflict；
- add conflict 不改变生命周期；
- unresolved 时两方都保留在普通 Recall 可见集合中，但必须披露冲突；
- unresolved 时不得单独 supersede 或 deactivate 任一方。

### 4.3 resolve_conflict

```ts
type ResolveConflictPayloadV1 = {
  action: 'resolve_conflict'
  conflict_event: GovernanceEventRefV1
  resolution:
    | { kind: 'dismiss' }
    | {
        kind: 'supersede'
        replacement: GovernanceMemoryRefV1
        replaced: GovernanceMemoryRefV1
      }
    | { kind: 'deactivate'; memory: GovernanceMemoryRefV1 }
}
```

- `conflict_event` 必须指向当前仍 unresolved 的 `add_conflict` Event；
- resolution 中出现的 Memory 必须来自该 conflict 的 canonical pair；
- 一个 `resolve_conflict` Event 原子完成“关闭 conflict + 应用 resolution”，不得拆成未持久化 batch；
- `dismiss` 只关闭 conflict，不改变两方生命周期；
- `supersede` 关闭 conflict，并确定性应用与 4.1 相同的方向和状态；
- `deactivate` 关闭 conflict，并使指定一方 inactive；
- Foundation 不支持“按上下文分别成立”的自动 resolution；无法确定时保持 unresolved，不自动选边。

### 4.4 deactivate

```ts
type DeactivatePayloadV1 = {
  action: 'deactivate'
  memory: GovernanceMemoryRefV1
}
```

- 目标可为 active 或 superseded，但不得处于 unresolved conflict；
- 目标已 inactive 时拒绝重复 deactivate；
- Effective 展示优先级为 `inactive > superseded > active`；
- 既有 replacement/conflict 历史关系不删除。

### 4.5 reactivate

```ts
type ReactivatePayloadV1 = {
  action: 'reactivate'
  memory: GovernanceMemoryRefV1
  deactivate_event: GovernanceEventRefV1
}
```

- 只可指向当前生效的、独立 `deactivate` Event；
- Memory identity 必须与目标 deactivate 一致；
- 同一 deactivate Event 同时只能有一个生效的 reactivate；
- reactivate 仅撤销该次 deactivate 的 inactive 效果；重新 Replay 后 Memory 可能是 active，也可能因其他有效关系仍为 superseded；
- 若 inactive 效果来自 `resolve_conflict`，必须 revert 该 resolve Event，不能 reactivate 其中的局部效果。

### 4.6 revert

```ts
type RevertPayloadV1 = {
  action: 'revert'
  target_event: GovernanceEventRefV1
}
```

- 目标必须是同 Project、早于当前 Event、当前仍生效的非 revert Event；
- Foundation 不允许 revert-of-revert；
- 同一 Event 同时只能被一个生效 revert 屏蔽；
- 若后续 Event 依赖目标 Event，必须先按逆依赖顺序 revert 后续 Event；
- Replay 屏蔽目标后，必须重新校验全部后续 Event；任何后续 Event 失效时，本次 revert 拒绝提交；
- 错误 revert 通过追加新的等价业务 Event 修正，不删除历史，也不反向修改 revert Event。

## 五、Evidence 协议

Foundation 只接受可解析引用：

```ts
type GovernanceEvidenceRefV1 =
  | ({ kind: 'memory' } & GovernanceMemoryRefV1)
  | ({ kind: 'governance_event' } & GovernanceEventRefV1)
```

要求：

- 每个 Event 至少一个 Evidence ref；
- 所有 Evidence 与 Event 同 Project；
- Memory ref 必须解析到 Raw World 的完整身份；
- Event ref 必须解析到当前 committed chain 中严格早于新 Event 的对象；
- 禁止 self ref、future ref 和 orphan ref；
- 被 revert 的历史 Event 仍是可解析历史证据；
- payload 中出现的引用不自动计入 Evidence；
- 不持久化 Prompt、用户正文、模型思维、Memory Content、路径、凭据或任意自由文本；
- `reason_code` 只允许稳定机器码，不替代 Evidence。

Foundation 不引入独立 Evidence Store。

## 六、Raw World 与 Effective View

### 6.1 Effective Memory

```ts
interface EffectiveMemoryV1 {
  memory_ref: GovernanceMemoryRefV1
  lifecycle_status: 'active' | 'superseded' | 'inactive'
  superseded_by: GovernanceMemoryRefV1 | null
  inactive_by: GovernanceEventRefV1 | null
  unresolved_conflict_refs: GovernanceEventRefV1[]
  governance_event_refs: GovernanceEventRefV1[]
}
```

Effective Memory 只由 Raw Memory 与 committed Ledger Replay 得出，不写回 Raw Memory。

### 6.2 Effective Catalog

Effective Catalog 从 Raw Catalog 确定性投影：

1. 移除 inactive 和 superseded Memory；
2. 保留 active Memory；
3. unresolved conflict 两方均为 active，均保留并携带冲突元数据；
4. 自底向上递归裁剪不含可见 Memory、也不含未裁剪子节点的空节点；
5. root 永远保留；
6. 保留未被裁剪节点的原始 `node_id`、title、summary 与父子关系，不借治理重构 Catalog；
7. 节点、子节点和 Memory 引用继续使用 code-point ascending。

### 6.3 普通 Recall 可见性

普通 Recall 只能使用 Effective View：

- inactive / superseded Memory 不进入 Map、Title、Summary 或 Content 输出；
- unresolved conflict 两方均可见，并在逐级披露中稳定携带 conflict 标记；
- conflict 披露至少包含 conflict Event ref、对方 Memory ref/title 与 unresolved 状态；
- 运行时不能依赖模型自行记住披露冲突。

审计读取可以查看 Raw World 与历史关系，但不得混入普通 Recall。

## 七、Generation manifest 与双集合协议

### 7.1 Legacy manifest

v0.2.6 manifest 保持原 schema 和 exact-key 语义。只有同时通过 `schema_version: 1`、`compiler_version: dsh-mnemosyne-okf-v2/1` 及 legacy exact-key 校验的 manifest 才被正向识别为 legacy。它没有 `governance_head` 与 `visible_memory_refs`。新版读取器将该已确认 legacy manifest 的“字段缺失”解释为：

```text
governance_head = null
visible_memory_refs = memory_refs
```

这是读取时的兼容解释，不修改旧 manifest，不在磁盘上补字段。

不匹配已知 legacy 或 governed schema/compiler 组合的 manifest 必须 fail closed；不得把损坏或缺字段的 governed manifest 降级解释为 legacy。

### 7.2 Governed manifest

Governed Generation 使用 `schema_version: 2` 与 `compiler_version: dsh-mnemosyne-okf-governance-v1/1` 正向识别；不得仅靠字段缺失或解析失败降级为 legacy。它在原有身份字段上至少增加：

```ts
interface GovernedGenerationManifestV1 {
  schema_version: 2
  // 原有 generation identity / project / compiler / raw catalog / output / created_at 字段
  memory_refs: GovernanceMemoryRefV1[]
  visible_memory_refs: GovernanceMemoryRefV1[]
  governance_head: GovernanceHeadV1
  effective_catalog_id: string
  effective_catalog_sha256: string
  effective_state_sha256: string
}
```

字段语义冻结为：

```text
catalog_id + catalog_sha256
↔ Raw Catalog

memory_refs
↔ Raw Catalog / Raw World 中完整 Memory 集合

visible_memory_refs
↔ Governance Effective View 中当前普通 Recall 可以使用的 Memory 集合

Effective Catalog
↔ effective_catalog_id + effective_catalog_sha256
↔ visible_memory_refs
↔ Generation outputs
```

强制不变量：

- `memory_refs` 名称为兼容保留，但在 legacy 与 governed manifest 中始终表达 Raw World；
- `memory_refs` 必须与 Raw Catalog 中全部且仅有的 Memory 一一对应；
- `visible_memory_refs` 必须是 `memory_refs` 的无重复子集；
- `governance_head`、`memory_refs` 与 `visible_memory_refs` 在 governed manifest 中都是必填字段；集合为空时必须写 `[]`，不得省略或写成 `null`；
- governed manifest 的 `governance_head` 必须是非 null 对象；逻辑上的 null head 只来自被正向识别的 legacy manifest；
- active Memory（含 unresolved conflict 两方）必须出现在 `visible_memory_refs`；
- inactive / superseded Memory 不得出现在 `visible_memory_refs`；
- `effective_catalog_sha256` 必须与 Effective Catalog canonical bytes 一致，`effective_catalog_id` 确定为 `ecatalog_${effective_catalog_sha256.slice('sha256_'.length)}`；它们不得复用 Raw `catalog_id/catalog_sha256` 的身份语义；
- Effective Catalog 中全部且仅有的 Memory 必须与 `visible_memory_refs` 一一对应；即使可见集合为空，Effective Catalog 仍必须包含 root；
- Generation 的 Map、Title、Summary、Content 等普通 Recall outputs 必须全部且仅由 Effective Catalog 与 `visible_memory_refs` 生成；
- 每个 visible ref 必须恰有一份绑定该 Raw source ref 的 Effective Memory output，hidden ref 不得有普通 Recall Memory output；Effective output 使用自己的 output hash，不得在过滤 relation 后冒充原始 OKFMemoryV2 的 `content_sha256`；
- `effective_state_sha256` 绑定 raw catalog identity、完整 raw refs、visible refs、governance head 与确定性 Effective 状态；
- governed Generation 的 `generation_id` 必须绑定完整 manifest identity 和 outputs，不能只绑定 Raw World。

### 7.3 related_memory_refs

Raw 与 Effective 的校验边界冻结为：

1. Raw Memory 的 `related_memory_refs` 保持 v0.2.6 数据模型，不修改原对象；
2. Raw World 校验要求每个 related ref 都解析到 `memory_refs` 中存在的 Raw Memory；
3. Effective 编译时，对每个可见 Memory 的 related refs 取与 `visible_memory_refs` 的交集；
4. 指向 inactive / superseded Memory 的 related ref 在普通 Recall outputs 中隐藏；
5. Effective outputs 不得含悬空 related ref，也不得通过 relation 文本泄漏隐藏 Memory；
6. Raw 审计读取仍可看到完整原始 related refs；
7. conflict 是 Governance 元数据，不通过篡改 Raw `related_memory_refs` 表达。

因此，legacy `validateWorld` 的“Catalog refs = 编译 Memory set”和“related refs 必须存在”继续适用于 Raw World；governance-aware compiler 另行验证 Effective Catalog、visible set 与过滤后 relations 的一致性，不能把旧校验器直接套到过滤后的单一集合并改变 Raw 语义。

## 八、Canonical ordering

### 8.1 通用规则

- canonical JSON 对象 key 使用现有 Unicode code-point ascending；
- JSON array 不因 canonical JSON 自动排序；所有协议定义为 unordered collection 的 array 必须先按本节 comparator 排序，再计算 canonical body 或 hash；
- comparator 逐字段比较，第一个不同字段决定顺序；字段字符串均使用现有 code-point ascending；
- unordered collection 禁止完整 identity 重复；
- 同一 `memory_id` 搭配不同 `content_sha256`，或同一 `event_id` 搭配不同 `event_sha256`，均属于 identity 冲突并拒绝，不能作为两个可排序元素共存；
- 有业务方向的字段不是 unordered collection，不得通过排序改变语义，例如 `replacement/replaced`。
- 字符串不执行 Unicode normalization、locale collation 或 case folding；按输入 Unicode code points 原样比较。

### 8.2 GovernanceMemoryRefV1

按以下 tuple 排序：

```text
(memory_id, content_sha256)
code-point ascending
```

### 8.3 GovernanceEventRefV1

按以下 tuple 排序：

```text
(event_id, event_sha256)
code-point ascending
```

### 8.4 GovernanceEvidenceRefV1

先按 `kind` code-point ascending，再按对应完整 identity：

```text
governance_event:
(event_id, event_sha256)

memory:
(memory_id, content_sha256)
```

当前两个 kind 中，`governance_event` 排在 `memory` 之前。这里的 identity 必须使用上述逐字段 tuple，不得先拼接成实现自定义字符串再比较。

### 8.5 必须规范化的集合

至少包括：

- `add_conflict` 的无方向 pair：按 GovernanceMemoryRefV1 comparator 排成 `first < second`；
- `evidence_refs`：按 GovernanceEvidenceRefV1 comparator；
- manifest `memory_refs` 与 `visible_memory_refs`：按 GovernanceMemoryRefV1 comparator；
- Effective Memory 的 `unresolved_conflict_refs` 与 `governance_event_refs`：按 GovernanceEventRefV1 comparator；
- 未来新增的任何语义上 unordered ref collection：必须在对应 schema 中冻结 comparator 后才能进入 canonical hash。

Payload 中具有方向或角色的引用使用具名字段保持语义，不作为集合重排。相同逻辑 Event 在任何运行环境、遍历顺序或实现语言中必须生成相同 canonical body 与 `event_sha256`。

## 九、Legacy → Governed 升级边界

### 9.1 没有治理时保持 legacy

如果 CURRENT 仍指向 v0.2.6 legacy Generation，读取时的兼容状态为：

```text
governance_head = null
尚无 committed Governance Event
```

此时：

- 插件升级不得改写该 Generation；
- 普通 Recall 继续读取 legacy Generation；
- 普通 Consolidation 新建 Memory / Raw Catalog 时继续使用 v0.2.6 legacy compiler 和 legacy manifest；
- 不得仅因插件升级、读取、启动、普通 Consolidation 或重建 outputs 而发布 governed Generation。

“旧 manifest = empty governance”只是一条读取兼容规则，不是自动格式迁移触发器。

### 9.2 第一次治理提交

只有第一次真实 Governance Event commit 才是格式升级边界：

```text
legacy Generation
→ 构造 sequence = 1, prev_event_hash = null 的 genesis Event
→ Governance Compiler 生成 governed Generation
→ 单次原子切换 CURRENT
```

CURRENT 切换成功时，genesis Event 与 governed Generation 同时生效；失败时旧 legacy Generation 继续有效，新 Event 成为永久 orphan。

### 9.3 已进入 governed 后

CURRENT 一旦指向 governed Generation：

- 后续 Governance commit 按第三章追加一个 Event；
- 后续普通 Consolidation 不新增 Governance Event，而是继承当前 `governance_head`；
- Consolidation 更新 Raw Memory / Raw Catalog 后，使用 governance-aware compiler 对“新 Raw World + 当前 committed Ledger”重新 Replay 并发布 governed Generation；
- 不允许退回 legacy manifest；
- CURRENT 不得切回祖先 head、切到 sibling head 或跳过 Event；恢复旧治理效果只能追加新的 `revert` Event，不能倒退 CURRENT；
- 不允许先发布 Raw Generation 再异步补 Effective View；
- Recall 与同 Project 下一轮仍通过既有 mutation lane / barrier 观察单一 CURRENT 的一致状态。

新版必须读取 legacy 与 governed 两种格式；v0.2.6 读取 governed Generation 不作兼容保证。旧 Generation 永不原地修改，也不要求 eager migration。

## 十、Replay、增量与 checkpoint

Foundation 的 correctness oracle 是从 genesis 到 `governance_head` 的全量 Replay。第一阶段允许每次全量 Replay。

“治理增量执行”第一阶段约束未来候选发现范围，不要求立即增量 Replay。候选发现只能基于有界输入，例如：

- 新增 Memory；
- 本轮实际 Recall 的 Memory；
- 同 Catalog node 的有界邻居；
- Raw direct relations。

不得每个 Turn 扫描整个 Memory Store。

Replay 预留非权威 checkpoint：

```ts
interface GovernanceReplayCheckpointV1 {
  through_sequence: number
  governance_head_hash: string
  compiler_version: string
  effective_state_sha256: string
  derived_state: unknown
}
```

checkpoint 必须与 committed chain、compiler version 和 state hash 一致；缺失、损坏或不一致时直接丢弃并全量 Replay。checkpoint 不得成为第二个 head，也不能提交 Event。

## 十一、失败与隔离语义

- Governance proposal、Event 校验、写入、Replay、编译或 CURRENT 切换失败时，Raw Memory / Raw Catalog 不变；
- CURRENT 未切换即没有新的治理状态生效；
- 继续服务最后一个有效 Generation；
- 失败不得阻断主任务或产生半提交 Effective View；
- Event、Evidence、Ledger、Generation 与 checkpoint 均严格 Project Scope 隔离；
- 普通 Consolidation 与 Governance commit 共享现有 Project mutation serialization，避免 CURRENT lost update。

## 十二、Foundation 非目标

首批明确不做：

- 自动 Governance Subagent；
- 自动 Proposal 或自动状态变更；
- merge；
- 语义去重算法；
- stale / 过时判断；
- Catalog 重构；
- Pattern Layer；
- Plugin Evolution；
- 跨 Project Governance；
- 修改 Raw Memory / Raw Catalog；
- 新的用户记忆工具。

## 十三、建议实施切片

### Slice 1：协议类型与纯校验

只实现 Event envelope、强类型 payload、完整 refs、canonical comparator、hash 与 exact-key 校验；不接生产生命周期。

### Slice 2：纯 Replay

实现单链校验、事件状态机、revert 依赖校验和 Effective Memory projection；以全量 Replay 作为 correctness oracle。

### Slice 3：Ledger 存储与原子 commit

实现 immutable Event store、exclusive create、orphan 规则、CURRENT compare-before-switch 和“一次最多一个 Event”提交协议。

### Slice 4：版本化 Generation

实现 legacy / governed manifest 读取、首次 Governance 格式升级边界、Raw `memory_refs` 与 `visible_memory_refs` 双集合。

### Slice 5：Effective Catalog 与 outputs

实现可见集合、空节点裁剪、related refs 过滤、conflict disclosure 和一致性 hash。

### Slice 6：生产链路接入

Recall 读取 Effective outputs；Consolidation 在 legacy 无治理时保持 legacy，在 governed 状态继承 head 并与 Governance commit 共用 Project mutation lane / barrier。

每个 Slice 必须保持前一 Slice 的协议 golden、旧 Generation 读取和 v0.2.6 五项稳定能力回归通过后，才能进入下一 Slice。

## 十四、冻结结论

本协议冻结以下最终边界：

- committed chain 只能从单一 CURRENT manifest 的 `governance_head` 定义；
- orphan 永久不可重新进入 committed chain；
- 一次 Governance commit 最多新增一个生效 Event；
- legacy 项目只在第一次真实 Governance Event commit 时升级格式；
- `memory_refs` 永远表示 Raw World，`visible_memory_refs` 表示普通 Recall 可见世界；
- Raw relations 完整保留，Effective relations 确定性过滤；
- 所有 unordered Governance refs 在 hash 前使用已冻结的完整 identity comparator；
- Raw、Effective、Ledger、Generation 与 Recall 的职责边界不混用。

在不新增本文范围外能力的前提下，本协议状态为：

```text
READY FOR SLICE 1
```
