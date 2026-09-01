# dsh-Mnemosyne v0.3 子代理生命周期与父 Agent 等待设计

状态：设计冻结，待实现

## 1. 目标

确保 Recall 与 Consolidation 子代理由父 Agent 统一管理。父 Agent 不得在子代理、记忆写入或 Generation 发布仍未完成时结束本轮。

本设计只解决子代理生命周期与等待一致性，不新增治理、检索、去重、Revision 或 UI 能力。

## 2. 子代理职责

子代理数量不设固定上限。当前只有两类职责：

- **Recall 子代理**：在父 Agent 判断地图可能相关并调用 Recall 后，执行 Title → Summary → Content 导航。
- **Consolidation 子代理**：在回合正常结束后，判断是否产生可复用经验，并完成分类、Memory 写入和 Generation 发布。

同一父 Agent 可以按需拥有多个子代理实例。数量由并发任务决定，不以“两个”作为硬编码限制。

## 3. 父 Agent 任务集合

每个父 Agent 维护一个仅属于自身的子代理任务集合（Task Set）：

- 创建中的子代理；
- 正在执行的 Recall/Consolidation 任务；
- 已完成但尚未确认结果的任务；
- 等待 Project 写入协调器完成的任务。

任务进入集合时登记，完成、失败、取消或超时后移除。集合为空不代表可以立即退出，还必须确认本轮写入屏障已收敛。

## 4. 生命周期

```text
agent/created
  → 建立父 Agent 生命周期上下文
  → 子代理按需创建并登记

每轮任务
  → Recall 子代理（可选）
  → 主模型完成任务
  → Consolidation 子代理（可选）
  → Memory / Catalog / Generation 发布完成

父 Agent 结束或 session/disposed
  → 停止接收新任务
  → 等待 Task Set 清空
  → 等待 Project 写入屏障清空
  → 取消残留任务并释放子代理
```

## 5. 等待与并发约束

1. Recall 任务可以并行，但同一回合只允许一次有效 Recall 注入。
2. 不同 Project 的 Consolidation 可以并行，互不等待。
3. 同一 Project 的写入必须经过现有 Mutation Coordinator 串行化。
4. 父 Agent 的退出屏障必须等待所有子代理 Promise、写入操作和 Generation 发布 Promise。
5. 子代理失败不得伪装为成功；失败必须向父 Agent 返回稳定结果并写入调试日志。
6. 父 Agent 取消时，必须向所有在途子代理传播 AbortSignal，并等待其最终释放。

## 6. DSH 公开 API 边界

实现只能使用 DSH 已公开的 Agent 创建、取消、等待和 dispose 能力。不得读取私有 Session 存储，不得通过隐藏文件或临时文件传递任务结果。

如果 DSH 在 `turn/end` 阶段不允许创建子代理，创建动作必须提前到父 Agent 仍处于有效生命周期的公开事件中；`turn/end` 只提交任务，不负责首次创建。

## 7. 验收标准

- 真实 DSH 进程中，Recall 子代理可按需创建并完成，父 Agent 能收到结果；
- 真实 DSH 进程中，Consolidation 子代理能完成判断、写入和 Generation 发布；
- 父 Agent 退出前不存在未完成子代理或未收敛写入；
- 同一 Project 连续两轮中，后一轮 Recall 能看到前一轮已发布的 Memory；
- 不同 Project 的子代理和写入屏障互不阻塞；
- 子代理创建失败、取消、超时均有稳定日志，且不会产生半成品 Memory；
- 真实双进程重启 E2E 通过后，才允许将 v3 设为生产默认。

## 8. 推荐实施顺序

1. 先增加真实 DSH 子代理创建时机的失败测试；
2. 实现父 Agent Task Set 与退出屏障；
3. 将 Consolidation 从 `turn/end` 临时创建改为生命周期内创建/复用；
4. 接入取消、超时和 dispose 的统一清理；
5. 验证同 Project 等待、跨 Project 并行；
6. 运行真实双进程重启验收；
7. 通过全部门禁后，再切换生产默认并单独提交。
