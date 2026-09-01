# dsh-Mnemosyne v0.2 本地观察期监控与评估规范

> 状态：🟡 首轮本地闭环已验证，继续观察中
>
> 日期：2026-08-31
>
> 适用版本：`v0.2.0`

---

## 一、目标

本规范用于插件安装后连续运行 3～7 天的真实项目观察。当前已在 `test` 项目取得自动记忆、Catalog/Generation 发布、跨会话 Recall 及 `Title → Summary → Content` 正文注入的首轮真实证据；跨项目隔离沿用既有 E2E 门禁并继续纳入观察。评估重点不是“生成了多少记忆”，而是：

1. 用户只进行正常对话时，Recall 与 Consolidation 是否自动运行；
2. 每条记忆是否符合 OKF Memory v2，且内容正确、有用、不过度泛化；
3. Recall 是否严格遵循 `Title → Summary → Content`；
4. 换一种说法提出同类问题时，模型能否找到并使用正确记忆；
5. 是否出现错误召回、错误沉淀、跨项目泄漏或状态损坏；
6. 额外模型调用、延迟与磁盘增长是否可接受。

观察期间不要求用户调用任何 `mnemosyne_*` 工具。工具出现在普通会话中本身就是产品边界缺陷。

---

## 二、允许检查的事实源

开始观察前，用户须明确授权精确项目目录。默认只读：

```text
<project>/.dsh-mnemosyne/
  v2/
    memories/
    catalogs/
    generations/
    CURRENT
  debug/
    runtime.jsonl
```

必要时可通过 DSH 公开 Session API 核对持久的 plugin recall 消息，但不得解析 DSH 私有数据库或物理存储。

证据优先级：

```text
v2 Memory / Catalog / Manifest / Generation / CURRENT
  > debug/runtime.jsonl
  > DSH 公开 API 返回的持久 plugin recall 消息
  > 经用户允许的 Memory 内容人工抽样
  > 模型或 Agent 的自然语言自述
```

默认禁止读取：Credential、API Key、未授权 HOME 目录、完整 Session 私有数据、隐藏思考、与本次评估无关的项目文件。

---

## 三、核心指标

### 3.1 自动沉淀

从 `runtime.jsonl` 统计：

| 指标 | 定义 |
|---|---|
| `turns_observed` | 纳入观察的正常完成回合数 |
| `consolidation_started` | 自动沉淀启动次数 |
| `consolidation_created` | 新 OKF Memory 成功发布次数 |
| `consolidation_noop` | 规范内容完全相同而幂等返回的次数 |
| `consolidation_skipped` | 模型判断无可复用新知识的次数 |
| `consolidation_failed` | 模型调用、校验、写入或发布失败次数 |
| `consolidation_error_rate` | `failed / started` |

`created` 比例不是越高越好。普通闲聊或无新增经验的任务应该 `skip`。

人工抽样新记忆并标注：

```text
useful
correct_but_trivial
duplicate
overgeneralized
factually_wrong
sensitive
uncertain
```

重点检查 Title 是否能独立帮助模型初筛、Summary 是否足以判断相关性、Content 是否完整记录问题、踩坑、处理过程与验证方式。

### 3.2 自动 Recall 与渐进式披露

| 指标 | 定义 |
|---|---|
| `recall_started` | 主回合第一步触发 Recall 的次数 |
| `recall_completed` | 成功完成导航并形成持久注入的次数 |
| `recall_no_match` | 模型确认没有相关记忆的次数 |
| `recall_failed` | Catalog、Generation、模型导航或消息注入失败次数 |
| `recall_error_rate` | `failed / started` |
| `expansion_steps` | 单轮导航模型判断/展开次数，最大必须 `<= 8` |
| `summaries_disclosed` | 单层展示的 Memory Summary 数，最大必须 `<= 5` |
| `contents_selected` | 最终进入主模型的完整 Memory 数，最大必须 `<= 3` |
| `disclosure_order_violation` | 跳过 Title 或 Summary 直接披露 Content 的次数，必须为 `0` |
| `paraphrase_recall_success` | 换措辞后仍召回正确记忆的案例数/率 |
| `wrong_recall_count` | 披露与当前任务无关记忆的次数 |

每次成功 Recall 还应核对：

- DSH Session 中存在 `source.kind=plugin, form=recall` 的持久消息；
- 主模型请求实际包含最终确认的 Content；
- 未选择的 Summary、未经 Summary 确认的 Content 没有进入主请求；
- Related Memory 只先披露 Title，如需展开必须重新走同一流程；
- 用户没有主动调用或看到记忆工具。

### 3.3 实际效果

对被召回的重点案例人工标注：

```text
helped
neutral
harmed
unknown
```

“被召回”不等于“有帮助”，模型声称有帮助也不等于结果已验证。重点记录：

- 是否避免了已知踩坑；
- 是否减少重复排查；
- 是否因过时或错误记忆走错方向；
- 本轮发现的新陷阱是否被创建为一条新的关联 Memory，且旧 Memory 字节保持不变。

### 3.4 完整性、隔离与成本

| 指标 | 要求 |
|---|---|
| `current_invalid_count` | 必须为 `0` |
| `hash_mismatch_count` | 必须为 `0` |
| `broken_memory_ref_count` | 必须为 `0` |
| `legacy_v1_in_generation_count` | 必须为 `0` |
| `cross_project_leak_count` | 必须为 `0` |
| `visible_mnemosyne_tool_count` | 必须为 `0` |
| `sensitive_content_count` | 必须为 `0` |
| `orphan_unpublished_memory_count` | 记录并调查 |
| `additional_model_requests` | Recall + Consolidation 的额外请求数 |
| `latency_overhead_ms` | P50/P95；无法取得则标 `unavailable` |
| `token_overhead` | 可取得时记录；否则标 `unavailable` |
| `v2_disk_growth_per_day` | v2 Store、Generation 与日志每日增长量 |

---

## 四、零记忆与漏召回诊断

当会话已运行多轮但状态仍为零时，按顺序查看该项目的 `debug/runtime.jsonl`：

1. 没有 `consolidation_start`：当前 DSH 进程可能未加载 v0.2 插件，或 `turn/end` 没有被观察到；
2. 有 `consolidation_failed` 且 `reason_code=evidence_unavailable`：用户消息/回合证据提取失败；
3. `reason_code=model_route_unavailable`：当前 Agent 的 provider/model 路由不可用；
4. 有 `consolidation_skip`：模型明确认为本轮无可复用新知识，应结合任务内容判断是否合理；
5. 有 `consolidation_created` 但 CURRENT 不含该 Memory：检查 Catalog/Generation 发布与并发更新；
6. 有 Memory 但没有 `recall_start`：检查 `agent/pre-step` 装配或是否为主回合第一步；
7. 有 `recall_no_match`：查看逐层披露与模型选择是否合理；
8. 有 `recall_completed` 但任务未使用记忆：核对持久 plugin recall 消息和实际主模型请求。

日志只能保存 ref、计数、结果和稳定 reason code，不应包含用户全文、完整 Memory Content、隐藏思考、Credential 或绝对敏感路径。

---

## 五、案例记录模板

```yaml
case_id: <脱敏 ID>
task_family: <受控分类>
task_outcome: success|failure|partial|unknown
consolidation:
  result: created|noop|skipped|failed|not_run
  memory_refs: []
  quality: useful|trivial|duplicate|overgeneralized|wrong|sensitive|uncertain
recall:
  result: completed|no_match|failed|not_run
  expansion_steps: <integer>
  title_refs_seen: []
  summary_refs_seen: []
  content_refs_selected: []
  durable_plugin_message: true|false|unknown
  disclosure_order_valid: true|false|unknown
effect: helped|neutral|harmed|unknown
cost:
  model_requests: <integer|unavailable>
  token_overhead: <integer|unavailable>
  latency_ms: <integer|unavailable>
notes: <脱敏短评，不粘贴用户全文或完整记忆>
```

至少保留：成功避免踩坑、换措辞召回、合理 skip、漏召回、错误召回、新关联陷阱、重启后读取和跨项目隔离案例。

---

## 六、初始告警阈值

### P0：立即停用并调查

- Credential、秘密或未授权敏感内容进入 Memory/日志；
- 跨项目记忆泄漏；
- 未经 `Title → Summary` 就把 Content 注入主模型；
- 用户会话出现任何 `mnemosyne_*` 工具；
- CURRENT、Hash 或引用完整性损坏；
- plugin recall/system 消息被错误当成用户任务沉淀。

### P1：当天调查

- `consolidation_error_rate > 5%`；
- `recall_error_rate > 5%`；
- 人工抽样重复率 `> 10%`；
- 任一错误记忆被采用并导致返工；
- 多轮有价值任务持续没有 `consolidation_start/created/skip` 可解释记录；
- Recall P95 延迟或额外调用量明显影响正常使用。

阈值为 v0.2 首轮观察基线，观察结束后可根据真实数据修订，但不得在观察中途为美化结果而调整。

---

## 七、观察结束报告

报告至少包含：

1. 观察日期、版本、项目范围与任务数；
2. Consolidation created/noop/skip/failed 分布；
3. Recall completed/no_match/failed 与分层上限合规；
4. 记忆质量抽样与实际 helped/neutral/harmed；
5. 换措辞召回、漏召回、错误召回案例；
6. 完整性、隔离、敏感信息和可见工具检查；
7. 模型请求、延迟、Token 与磁盘增长；
8. P0/P1 问题、根因与建议；
9. 结论：继续使用、修复后复测或停用。

Codex 后续协助评估时，必须以本规范为唯一口径，并只读取用户明确批准的项目目录。
