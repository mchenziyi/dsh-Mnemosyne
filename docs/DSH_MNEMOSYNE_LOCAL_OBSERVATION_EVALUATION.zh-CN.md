# dsh-Mnemosyne 本地观察期监控与评估规范

> 状态：✅ 评估口径已冻结，待 v0.1.0 MVP 完成后执行
>
> 日期：2026-08-27
>
> 适用版本：`v0.1.0` 首次本地连续运行观察

---

## 一、目标与原则

本规范用于 dsh-Mnemosyne MVP 完成后的本地观察期。建议连续运行 3～7 天，再基于真实任务判断：

1. 自动采集是否形成了有价值的记忆；
2. OKF 与渐进式披露是否能正确召回并控制上下文成本；
3. 记忆是否真正帮助任务，而不是只生成了看起来合理的文档；
4. 是否存在错误采纳、跨 Scope 泄漏、敏感信息沉淀或不可变状态损坏；
5. 收益是否值得额外的模型调用、延迟与磁盘成本。

### 1.1 评估原则

- 端到端评估，不只查看 OKF 页面；
- 规范 Fact/Manifest/Generation/CURRENT 优先于派生页面；
- Tool 记录优先于模型自然语言声明；
- 安全问题实行零容忍；
- 运行前冻结指标口径，观察期间不因结果好坏改变标准；
- 默认只采集脱敏统计、协议状态、Hash 和用户明确允许的内容；
- 不采集 Credential、完整 Prompt、完整模型回复或模型思考过程。

---

## 二、观察范围与事实源

### 2.1 允许读取的事实源

实际开始观察前，用户必须明确批准精确本地目录。建议只读以下内容：

```text
<project>/.dsh-mnemosyne/
  facts/
  manifests/
  generations/
  CURRENT
```

以及 DSH/Mnemosyne 已提供的脱敏状态、Tool 结果、错误码和运行统计。

### 2.2 默认禁止读取

- `.credentials.yaml` 或任何 API Key；
- 用户默认 HOME 中未授权的目录；
- 完整 Session 数据库、私有 JSONL 或 DSH 私有物理布局；
- 完整 Prompt、模型回复、Tool 自由文本正文；
- 与本次观察无关的项目文件。

### 2.3 评估证据优先级

```text
规范 Fact / Manifest / Generation / CURRENT
  > 严格 Tool Result
  > 脱敏运行统计与错误码
  > OKF 页面人工抽样
  > Agent 自述
```

---

## 三、核心指标

### 3.1 自动采集

| 指标 | 定义 |
|---|---|
| `tasks_observed` | 观察期内纳入评估的真实任务数 |
| `acquisition_attempted` | 触发自动提取的次数 |
| `acquisition_created` | 成功创建新 short-term Fact 的次数 |
| `acquisition_noop` | 因确定性幂等/重复而未新增 Fact 的次数 |
| `acquisition_skipped` | 因无新颖性、证据不足或规则过滤而跳过的次数 |
| `acquisition_error` | 提取、校验、写入或编译失败次数 |
| `capture_success_rate` | `created / attempted` |
| `acquisition_error_rate` | `error / attempted` |
| `acquisition_model_requests` | 自动采集产生的额外模型请求数 |
| `acquisition_latency_ms` | 自动采集附加延迟的分位数，至少记录 P50/P95 |

`capture_success_rate` 不是越高越好。大量普通任务都被创建记忆，可能意味着过度采集。

### 3.2 记忆质量

| 指标 | 定义 |
|---|---|
| `new_short_term_count` | 新增 short-term Fact 数 |
| `new_long_term_count` | 新增 long-term Fact 数 |
| `suspected_duplicate_count` | 人工或规则判断为同义/高度重复的记忆数 |
| `duplicate_rate` | `suspected_duplicate_count / new_memory_count` |
| `factually_wrong_count` | 与原任务事实冲突的记忆数 |
| `overgeneralized_count` | 把一次性现象错误泛化为通用经验的记忆数 |
| `too_trivial_count` | 内容正确但不值得长期保存的记忆数 |
| `sensitive_content_count` | 包含凭据、秘密、未授权路径或敏感正文的记忆数 |
| `actionable_memory_count` | 对后续同类任务具有明确可执行价值的记忆数 |

建议人工抽样标签：

```text
useful
correct_but_trivial
duplicate
overgeneralized
factually_wrong
sensitive
uncertain
```

### 3.3 检索与渐进式披露

| 指标 | 定义 |
|---|---|
| `search_count` | `mnemosyne_search` 调用次数 |
| `search_hit_count` | 至少返回一条候选的 Search 次数 |
| `search_empty_count` | 返回空候选的 Search 次数 |
| `search_hit_rate` | `search_hit_count / search_count` |
| `relevant_top1_count` | Top-1 候选经人工判断相关的次数 |
| `relevant_topk_count` | Top-K 至少一条相关的次数 |
| `precision_at_k` | Top-K 中相关候选数 / 返回候选数 |
| `open_count` | `mnemosyne_open` 调用次数 |
| `open_conversion_rate` | `open_count / search_hit_count` |
| `wrong_memory_open_count` | 打开了与当前任务不相关或错误的记忆次数 |
| `body_leak_in_search_count` | Search L2 意外包含正文的次数，必须为 0 |
| `stale_grant_accepted_count` | 旧/失效 Grant 仍能 Open 的次数，必须为 0 |
| `search_latency_ms` | Search P50/P95 延迟 |
| `open_latency_ms` | Open P50/P95 延迟 |

换措辞召回需要单独标记。任务使用与记忆不同的表述但仍成功召回，才算真实语义/结构化检索收益。

### 3.4 实际任务效果

每次记忆被打开或采用后，标注：

```text
helped
neutral
harmed
unknown
```

核心指标：

| 指标 | 定义 |
|---|---|
| `memory_adopted_count` | Agent 实际使用了记忆建议的次数 |
| `helped_count` | 经结果验证，记忆确实帮助任务的次数 |
| `neutral_count` | 使用或披露后没有可见影响的次数 |
| `harmed_count` | 记忆导致错误操作、错误方向或额外返工的次数 |
| `unknown_outcome_count` | 无法可靠判断效果的次数 |
| `help_rate` | `helped / evaluated_adoptions` |
| `wrong_adoption_rate` | `harmed / evaluated_adoptions` |
| `task_success_with_memory` | 使用记忆的任务成功数/率 |
| `estimated_time_saved` | 用户估计减少的排查或重复工作时间 |

不能把“被 Search 返回”算作帮助，也不能把 Agent 口头说“有帮助”当作结果验证。

### 3.5 生命周期与管理

| 指标 | 定义 |
|---|---|
| `promote_created` | 成功晋升为 long-term 的次数 |
| `promote_noop` | 重复晋升返回 NOOP 的次数 |
| `forget_created` | 新增 Forget Fact 的次数 |
| `forget_noop` | 重复 Forget 返回 NOOP 的次数 |
| `forgotten_recalled_count` | 已遗忘记忆仍出现在新 Search 的次数，必须为 0 |
| `source_short_term_deleted_count` | Promote 后 source short-term 被物理删除的次数，必须为 0 |
| `restart_persistence_failure` | 重启后应存在的记忆不可读次数 |
| `cross_session_short_term_leak` | short-term 泄漏到其他 Session 的次数，必须为 0 |
| `cross_project_leak` | 记忆泄漏到其他 Project 的次数，必须为 0 |

### 3.6 稳定性、完整性与成本

| 指标 | 定义 |
|---|---|
| `store_error_count_by_code` | Fact Store 各稳定错误码次数 |
| `compile_error_count_by_code` | Compiler/Generation 各错误码次数 |
| `current_invalid_count` | CURRENT 缺失、损坏或引用不完整 Generation 的次数 |
| `hash_mismatch_count` | Fact/Manifest/Generation/页面 Hash 漂移次数 |
| `orphan_temp_file_count` | 遗留临时文件数 |
| `orphan_generation_count` | 未被 CURRENT 引用且无法解释的 Generation 数 |
| `additional_model_requests` | Mnemosyne 增加的模型请求总数 |
| `additional_tokens` | Mnemosyne 增加的输入/输出 Token；无法取得时标记 unavailable |
| `task_latency_overhead_ms` | 相比不启用记忆的额外任务延迟 |
| `fact_bytes_growth` | Fact 存储增长量 |
| `generation_bytes_growth` | Manifest/Generation/OKF 增长量 |
| `total_disk_growth_per_day` | 每日 `.dsh-mnemosyne` 总增长量 |

---

## 四、端到端案例记录

每个重点案例使用同一模板：

```yaml
case_id: <脱敏 ID>
task_family: <受控分类>
task_outcome: success|failure|partial|unknown
acquisition:
  attempted: true|false
  result: created|noop|skipped|error|not_run
  memory_refs: [<允许记录时才记录>]
okf:
  generation_changed: true|false
  page_quality: useful|trivial|duplicate|wrong|uncertain
retrieval:
  searched: true|false
  hit: true|false
  relevant_top1: true|false|unknown
  opened: true|false
  correct_binding: true|false|not_applicable
adoption:
  adopted: true|false|unknown
  effect: helped|neutral|harmed|unknown
management:
  promoted: true|false
  forgotten: true|false
cost:
  model_requests: <integer|unavailable>
  token_overhead: <integer|unavailable>
  latency_ms: <integer|unavailable>
notes: <人工脱敏短评，不粘贴正文>
```

至少保留以下案例：

- 成功帮助案例；
- Search 空结果/漏召回案例；
- 错误召回或错误采纳案例；
- 重复采集案例；
- Promote 与 Forget 案例；
- 重启持久化案例；
- 跨 Session/Project 隔离案例。

---

## 五、初始告警阈值

这些是首轮观察的审查阈值，不是长期 SLA。观察期结束后可依据真实基线调整。

### 5.1 P0：立即停止并检查

任一发生即触发：

- `sensitive_content_count > 0`；
- `cross_project_leak > 0`；
- `cross_session_short_term_leak > 0`；
- `body_leak_in_search_count > 0`；
- `forgotten_recalled_count > 0`；
- `stale_grant_accepted_count > 0`；
- `current_invalid_count > 0`；
- 不可变 Fact 被覆盖或同身份内容漂移；
- Credential、完整 Prompt 或完整模型回复进入持久记忆。

### 5.2 P1：当天检查

- `harmed_count > 0`；
- `acquisition_error_rate > 5%`；
- Store/Compiler/Search/Open 错误率任一超过 5%；
- `duplicate_rate > 20%`；
- 同类任务连续 3 次 Search 空结果；
- P95 Search 或 Open 延迟明显影响正常交互；
- 单日磁盘增长相对任务量异常。

### 5.3 P2：观察期结束后优化

- 大量记忆长期无人检索；
- `correct_but_trivial` 比例过高；
- Promote 比例异常高或异常低；
- Open 转化率长期过低；
- Token/延迟成本超过实际帮助收益；
- OKF 页面结构可读但实际召回效果不足。

---

## 六、每日评估流程

每天固定执行一次：

1. 记录观察时间窗、版本、DSH 版本与项目 Scope；
2. 读取脱敏运行统计和稳定错误码；
3. 严格验证 Fact/Manifest/Generation/CURRENT；
4. 统计新增 short-term/long-term/Forget 与磁盘增长；
5. 统计 Search/Open/Promote/Forget；
6. 随机抽样新增记忆和被 Open 的记忆；
7. 填写端到端案例；
8. 检查 P0/P1 告警；
9. 输出当日报告；
10. 不自动修改、删除、Promote 或 Forget 任何记忆。

### 6.1 建议抽样量

- 新增记忆不超过 20 条：全部检查；
- 超过 20 条：至少检查 20 条，并优先覆盖全部被 Open/Promote/Forget 的记忆；
- 所有 harmed、错误采纳、Scope 异常与 Hash 错误：全部检查；
- 每天至少检查 3 个完整端到端案例；不足 3 个则全部检查。

---

## 七、每日观察报告模板

```markdown
# dsh-Mnemosyne 本地观察日报

日期：
版本 / Commit：
DSH 版本：
观察任务数：

## 1. 总结
- 今日总体状态：healthy | warning | stop_and_review
- P0：
- P1：
- 关键结论：

## 2. 采集
- attempted / created / noop / skipped / error：
- 新增 short-term / long-term：
- duplicate / wrong / trivial / sensitive：

## 3. 检索与披露
- search / hit / empty / open：
- relevant Top-1 / Top-K：
- wrong open：
- Search body leak / stale grant：

## 4. 实际效果
- adopted / helped / neutral / harmed / unknown：
- 今日最有价值案例：
- 今日最需要修复案例：

## 5. 管理与隔离
- promote / promote noop：
- forget / forget noop：
- restart failure：
- Session / Project leak：

## 6. 稳定性与成本
- Store / Compiler / CURRENT 错误：
- model requests / tokens / latency：
- disk growth：
- orphan temp / generation：

## 7. 建议
- 立即处理：
- 继续观察：
- 暂不处理：
```

---

## 八、观察期总结与版本决策

观察期结束后输出一次总报告，至少包括：

1. 总任务数与覆盖的任务族；
2. 采集、质量、检索、效果、管理、稳定性和成本汇总；
3. 所有 P0/P1 事件；
4. helped/harmed 典型案例；
5. 未解决的漏召回、重复和成本问题；
6. 是否满足继续日常使用的最低安全条件；
7. `v0.1.1` 修复清单，按 P0/P1/P2 排序；
8. 哪些指标因数据源不可用而无法计算。

### 8.1 继续使用的最低条件

- 所有 P0 指标为 0；
- 没有未解释的 Fact/Hash/CURRENT 损坏；
- 没有确认的有害记忆仍处于可检索状态；
- 采集和检索错误率处于可接受范围；
- 至少出现可复核的 helped 案例；
- 额外成本没有明显超过真实收益。

若样本量不足，不得下“记忆有效”或“记忆无效”的强结论，只能延长观察期。

---

## 九、未来监控执行约束

当用户要求 Codex 开始监控时，必须先确认：

1. 精确允许读取的项目目录；
2. 观察开始/结束时间；
3. 是否允许查看 OKF 页面正文；
4. 是否仅生成统计，还是允许人工质量抽样；
5. 报告保存位置；
6. 检查频率与通知策略。

监控默认只读，不自动修复、不删除、不 Promote、不 Forget、不修改配置。任何写操作必须再次获得用户明确授权。
