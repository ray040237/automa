# 02: 工具注册表适配到 AgentTool

**Status:** ✅ 已完成（2026-10-05）—— 全量 **389 tests / 370 pass / 0 fail / 19 skipped**

**What to build:** 模型可以调用我们的 13 个工具，工具返回值能正确回到对话里，失败时模型能看见错误观察值并自我纠正。这一票解决的是工具的**形状适配**，不含确认门（04）。

**Blocked by:** 01 — pi 运行时骨架

## 验收标准

- [ ] 13 个工具全部符合 pi 的工具定义：补齐 `label`，`parameters` 可用普通 JSON Schema 对象（pi 走非 typebox 回退；**回退是否真能过必须实测，不许假设**）
- [ ] **每个工具的返回值都显式给出 `content` 与 `isError`**，不再出现裸字符串返回
  - [ ] 四个当前返回裸字符串的位置（`get_variables` 与 `get_block_schema` 的四处）已显式包装
  - [ ] **有一条测试专门钉住这条**：若某工具返回值缺 `content`，该测试必须失败。（pi 会把缺 `content` 的结果兜成空数组，再发出 `"(no tool output)"` —— 正文与 untrusted 标记一起消失，不报错、不降级）
- [ ] 工具抛错时结果是 `isError`，且循环继续进入下一轮；助手状态**不进入错误态**
- [ ] 沿用现有的错误文案：工具失败时模型看到的是中文错误观察值，不是裸栈
- [ ] `class: read | write` 的声明与校验**完整保留**，`validateTools` 仍在模块加载期抛错
- [ ] 模型给出不存在的工具名时，产生一条错误观察值告知模型工具不存在，且循环继续
- [ ] 并行工具执行可用：一条 assistant 消息里多个互不依赖的只读工具被并发执行
- [ ] 模型撞输出 token 上限时，被截断的工具调用**不执行**，产生一条告知模型「参数可能不完整，请重新发起」的观察值

## 备注

**这一票的核心风险是静默失败**：四类静默失败里这一票占一类。形状不对不会报错，只会让模型「看不到东西」，而模型会自己编一个答案 —— 用户完全无感。

工具组（`group`）在 pi 里没有对应字段，而观察值用哪个 untrusted 标签取决于 `group === 'page'`。这个判定要搬进 runtime，但**观察值的包装本身留给 03**，这一票只需保证判定信息没丢。

---

## 完成记录（2026-10-05）

**做法：13 个工具本体一行没动**，新增 `tools/adapter.js` 做形状转换。理由是工具本体有自己的一批测试（`canvas.test.js` / `index.test.js` / `page-write.test.js` / `tabs.test.js`），改签名会让那批跟着改，而它们测的是「工具做什么」不是「工具怎么描述给模型」。形状转换收在一个模块里，一个入口。

`adapter.test.js` 17 条新增测试，其中 4 条专门钉红线第 3 条（返回值必须显式给 `content` 与 `isError`）。

### 实测发现的四件事

1. **给模型的工具声明在 system 消息的 `toolsAdded` 上**，不在 `context.tools` —— `StreamFn` 契约里明写了这点（`types.ts:14-16`）。
2. **`class` / `group` 不会进 `toolsAdded`**（pi 只取 name/description/parameters），但**保留在 `agent.state.tools` 上**。票 04 的确认门要读后者，`loop.js` 加了 `getState()` 出口。
3. **未知工具走 pi 内部短路**：消息是 `"Tool X not found"`，`beforeToolCall` / `afterToolCall` **都碰不到**，所以补不回我们旧实现里「列出可用工具名」的那段。**这是一处真实的行为退化** —— 旧实现列可用工具是为了让模型自我纠正。已记在下方。
4. **并发工具执行默认开启** —— pi 默认 `toolExecution: 'parallel'`，已加测试钉住「slow 结束前 fast 已完成」。

### 一处行为退化（需要有人知道）

**未知工具的错误消息不再列出可用工具名。** 旧实现（`loop.js` 的未知工具分支）会列出 `echo` 等名字帮模型改用正确的；pi 的短路分支产不出这个信息，且两个钩子都拦不到。契约部分（失败是错误观察值 + 循环继续）保持不变。

重开条件：模型实测出现「反复调同一个不存在的工具名」。

### 顺带修的

`toAgentTools(null)` 原先抛的是 `TypeError: Cannot read properties of null`，改成明确信息 —— 与 `findTool` / `requiresConfirmation` 的 T-45 规矩一致（tools 必须显式传，默认回落全量会泄露画布工具给无画布的宿主）。

### 没做

- **观察值的不可信包装留给票 03**。适配层只保证 `content` 非空且 `isError` 明确，不做包装 —— 包装点拆成两处就多一个能拆错的地方。
- **输出截断保护**（模型撞 max_tokens 时截断的工具调用不执行）没有单独测试。它由 pi 的 `failToolCallsFromTruncatedMessage` 负责，我们要验的是「它确实没执行」—— 等票 03 有真实观察值流之后更好验（能看出工具到底跑没跑）。