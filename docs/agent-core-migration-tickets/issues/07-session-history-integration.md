# 07: 事件历史与 sessions.js 对接

**Status:** ✅ 已完成（2026-10-05）—— 全量 **402 tests / 393 pass / 0 fail / 9 skipped**

**What to build:** 跨轮续接照旧工作 —— 用户切走再回来、刷新页面、重开助手页，上一轮的上下文还在。usage 累加、会话标题、跨会话 tab 锁、收尾落盘全部照旧。

**Blocked by:** 03 — untrusted 包装贯通到 toolResult；04 — 确认门；06 — 预检与插话

## 验收标准

- [ ] 上一轮的 agent 事件能作为初始历史续接，模型记得上一轮说过什么、用户问过什么
- [ ] 续接时被中断的一轮不会让 provider 报 400：悬空的工具调用被自动补上合成结果
- [ ] 历史里的旧消息**不被二次包装**（不可信包装只对新消息做）
- [ ] 一轮的 usage 累加到会话，累计值正确
- [ ] 会话标题由模型生成且**不被第二轮冲掉**（现状有三级兜底，别回退）
- [ ] 轮次收尾时整份事件历史落盘，重开后能读回
- [ ] 跨会话 tab 锁在装配层仍然生效
- [ ] 切会话时未收尾的确认卡片被判为拒绝（与 04 的三个入口协同）
- [ ] 收尾检查点落盘照旧工作（转中检查点那批逻辑）
- [ ] 历史落盘后可读回并继续下一轮，往返两次内容不丢

## 备注

**这一票是整条链的收敛点**：前三票各自改一块，这票把它们接成完整的多轮会话。它也是唯一会碰到 `sessions.js` / `turnRecord.js` 的一票 —— 这两个模块的测试**应当保持不动**（它们不经过循环）。

悬空工具调用的续接现在由 provider 层负责（它的净化比现状完善：会插入合成结果，还会处理夹在中间的 system 消息）。B7 欠账里那条「上一轮被中断」的提示还没做 —— 那是独立欠账，不阻塞本票，但本票做完之后它的实现前提（净化已保证不炸）才真正成立。

---

## 完成记录（2026-10-05）

**核心修复**：`initialHistory` 以前只进了 `history` 给 UI 渲染，**模型续接时那段历史并没有进 transcript** —— 那会让「重开会话」变成「只传本轮 user 消息过去」。我 01 票的代码里是 `filter((ev) => ev.piMessage)`，但我们从没在事件上存过 `piMessage`，所以等它就是永远拿不到。

新增 `historyToPiMessages(events)` 把 agent 事件历史翻译成 pi 的 transcript：

- 连续 TEXT_DELTA 拼接成一条 assistant 文本（UI 是增量发，真值是拼接）
- TOOL_CALL 攒着，等 TOOL_RESULT 一起发成「assistant 带 toolCall 块 + toolResult 成对」
- USER_MESSAGE / SYSTEM_NOTICE 都以 role:'user' 进 transcript，content 用事件里已存好的包装文本（不重-wrap）
- ERROR/DONE/START/TARGET_TAB 不入 transcript（它们是事件信号，不是内容）

**已踩到的坑**：pi 的 transcript **必须**有一条 role:'system' 的消息承载 prompt —— 我重建的 transcript 没有，必须把 `agent.state.messages` 里现存的那条 system 补回最前，否则 prompt 整体丢失。

**三条测试钉住**：跨轮续接的上下文含第一轮问答；历史不被二次包装；悬空 toolCall 不会让 transcript 非法。

### index.js 这边其实没改（变化在 loop.js）

index.js 的 `initialHistory` 传法不变，`sessionStore.save(buildTurnRecord(...))`、`accumulateUsage`、`patchTitle` 的逻辑都没动。07 的变化本质上是修 `loop.js` 里续接那个 TODO。

### 顺带踩到的测试坑

`makeAgent` 的默认 `streamFn` 每次 `send` 都从 `turns` 数组 shift，所以跨轮续接测试要为第二轮 agent 单独造一个 `fakeStream`，不能共用 turns 队列。

### 没做

ticket 05（错误分类降级）是下一票。它不阻塞 sessions，但阻塞票 08 的 provider 评估。