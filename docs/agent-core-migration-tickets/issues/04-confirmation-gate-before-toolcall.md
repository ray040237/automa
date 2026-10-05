# 04: 确认门接到 beforeToolCall

**Status:** ✅ 已完成（2026-10-05）—— 全量 **400 tests / 385 pass / 0 fail / 15 skipped**

**What to build:** 写类工具执行前弹出确认卡片；用户拒绝后模型知道是**被拒绝**（而不是工具失败），不会换个参数反复重试同一个写操作。被拒绝的工具在 UI 上明确显示为「已拒绝」，不显示为「失败」。

**Blocked by:** 02 — 工具注册表适配到 AgentTool

## 验收标准

- [ ] `class: read | write` 分级在 `beforeToolCall` 钩子里生效：read 类直接执行，write 类走确认门
- [ ] 未知工具名一律按需确认（ADR 0002：**不存在「默认放行」**）
- [ ] 用户拒绝后，该工具的 `execute` **从未被调用**
- [ ] 拒绝产生的事件在 UI 上是「已拒绝」状态，与「工具失败」可区分
- [ ] 本会话授权记忆（只对测试执行类工具有效）照旧生效；画布写操作永远逐次确认
- [ ] 跨会话 tab 锁检查照旧生效
- [ ] **有一条测试专门钉住「工具执行开始事件早于确认结果」** —— pi 在确认之前就发出工具开始事件，被拒绝的工具同样会先发。所以 UI 必须按「结束事件的 `isError`」判定是否真的执行了，不能按开始事件
- [ ] 确认卡片不可达时自动判为拒绝（切会话、宿主卸载、卡片组件自身卸载三个入口一个都不能少）
- [ ] `TOOL_STATUS.REJECTED` 的编码有独立测试：内部标记不会被模型输出撞车

## 备注

这一票完成的是三条红线里的第 3 条，同时是 ADR 0002 的延续。

**最容易出的错是把拒绝当成失败。** pi 的确认门被拒时产出的是一个错误工具结果，不是「用户拒绝」这种结构化状态。所以需要在钩子返回的拒绝理由里带一个内部标记，映射层识别后映射回「已拒绝」。

这个标记格式要选一个模型输出几乎不可能撞上的，且**不能出现在给模型看的文本里**。若做不到，退路是让拒绝走工具 `execute` 内部而不是钩子 —— 但那样就失去了 pi 的 block 语义，需要单独评估。

---

## 完成记录（2026-10-05）

**实现方式**：`beforeToolCall` 钩子里查 `class`，read 直接放行，write 与未知类走 `requestConfirmation`；拒绝时记进 `rejectedBy` 表，映射层收到对应的 `tool_execution_end` 后把 `isError:true` 的失败结果重映射成 `TOOL_STATUS.REJECTED`。

**会话授权记忆留在 `agentHost.js`** —— `sessionAuth` 状态的失效点（abort/切会话/卸载）都在宿主侧，`requestConfirmation` 本身已经检查 `shouldSkipConfirmation`，loop 不需要感知。

**已钉的测试（5 条）**：
- read 类工具不问（`asked === 0`）
- write 类必问、`confirmation` 带完整 args（不带 args 确认卡就是空框 —— T-27）
- 拒绝后 `execute` **从未被调用**
- 拒绝产生 `REJECTED` 事件，观察值是「未成功执行」而不是裸原因
- **start 早于 end** —— pi 先于 beforeToolCall 发 start，被拦的工具也会先发，所以 UI 必须按 end.isError 判定（已加测试钉住，pi 改了会红）

### 两处要记住的行为差异

1. **未知工具走 pi 内部短路**，`beforeToolCall` 钩子在未知工具上**不触发**（pi 先查表，查不到直接报 error）。所以「未知工具一律按需确认」这条在 pi 下**不可实现** —— 它只产一个 error 观察值。这是 ADR 0002 的一处退化，已记入完成记录。
2. **被拦的工具也发 `tool_execution_start`** —— 这不是 bug，是 pi 的事件顺序。UI 若显示「正在执行」会短暂闪一下，但最终态由 end 决定，已有测试钉住。

### 没动的

- `confirm.js` 的纯函数（`buildConfirmation` / `shouldSkipConfirmation` / `nextSessionAuth` 等）一行没动 —— 它们不感知循环是不是 pi。
- `agentHost.js` 的整个确认卡接线（pendingConfirm / answerConfirm / 三个失效入口）一行没动。