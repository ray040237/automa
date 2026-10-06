# 待办登记（会话捕获）

对话中发现的 **bug**、用户提出的 **改进** 与 **新功能** 一律先落在这里，由用户审核后再动代码。流程见 `AGENTS.md`「发现即登记」。

> 编号分工：**T 编号** = 全仓库范围的会话捕获；**B 编号** = 内置助手功能自身的已知欠账（原 `docs/agent-backlog.md`，2026-10-04 合并进本文件，编号与格式沿用，见文末「B 编号」区）。两区不混写。

> **本文件只放未完成的条目。** 已解决的条目在 **`docs/backlog-done.md`**（2026-10-05 拆出）——
> 那里保留完整的现象、实测证据与结论，用于追溯「当初为什么这么定」。
> 状态流转：待审核 → 已批准（待排期） → 进行中 → **完成时整条移入 `backlog-done.md`**。

## 登记模板

条目落进「待审核」下对应类型的子区块（**bug** / **改进** / **新功能**），**类型由所在区块决定，条目内不再写「类型：」行**。类型只取三个裸值；不改变分类的补充说明（如「潜在缺陷，当前无生产者」）写「注：」行。类型判断变化时整条搬到对应区块，并在条目里留一行说明。

```
## T-NN — 一句话标题

登记日期：YYYY-MM-DD
来源：会话日期 + 用户原话 / 触发它的 `文件名:行号`
现象：具体症状与复现条件
证据：实测输出片段或代码位置（无实测就明写「推断，未实测」）
影响：谁在什么情况下会踩，最坏结果
建议：（选填）可选方案与各自代价
注：（选填）类型边界或补充说明
状态：待审核
```

## 待审核

### bug（先审，多数可快速定夺）

### T-01 — countBlocks 把「块数」算成「属性数之和」，prompt 事实表报 715

登记日期：2026-10-04
来源：会话 2026-10-04 架构评审，触发点 `src/agent/facts.js:18-25`
现象：`buildFacts()` 产出的 `blockCount` 对真实块目录返回 **715** 而非 **61**（它累加的是每个块定义的属性个数），`src/agent/prompt.js:180` 把这个数写进「本版共有 N 个块」喂给模型。与 `prompt.test.js:22` 的 fixture（61）不一致。
证据：**实测** —— `node --import ./utils/test-loader.mjs` 内执行 `Object.values(tasks).reduce((n,t)=>n+Object.keys(t||{}).length,0)`，输出 `blocks= 61 sumKeys= 715`。测试抓不住的原因也已实测核对：`facts.test.js:113-118` 把同一个公式在测试里重打一遍（恒真断言），`facts.test.js:97` 只断言 `> 50`（715 也过）。
影响：每次 `send` 都把错误的块总数写进 prompt，模型据此判断「有哪些块可用」，可能漏推荐或多推荐块；且这条断言形状让该类错误永远测不出来（违反「不静默降级」）。
建议：① `countBlocks` 改为数块本身（`Object.keys(catalog).length`），代价约 10 分钟；② 必须同步改断言 —— `facts.test.js:33`（`{a: null, b: {name:'x'}} → 1`）与 `:63/:81` 的 fixture 期望是按旧公式写的，新语义下应为 2，漏改会直接红。改完把 `:113-118` 换成 `=== 61` 的语义断言。
状态：待审核

### T-03 — handlerAiWorkflow 未 await setVariable，rethrow 还丢掉 error.data/ctxData

登记日期：2026-10-04
来源：会话 2026-10-04 架构评审，触发点 `src/workflowEngine/blocksHandler/handlerAiWorkflow.js:55`、`:71`
现象：① `this.setVariable(variableName, ...)` 没有 `await`，而 `WorkflowWorker.js:112` 的 `setVariable` 是 async（内部 await IndexedDB 写入）；② `throw new Error(error.message)` 把 `error.data` / `error.ctxData` 丢掉，而 worker 的错误路径正要回读这两个字段来写日志。
证据：**实测** —— grep `setVariable(` 在 `blocksHandler/` 下共 19 处调用，17 处带 `await`，未带的是 `handlerAiWorkflow.js:55` 与 `handlerParameterPrompt.js:123`（后者在 promise 链里，是否同因需一并确认）；`error.data/ctxData` 的回读位置 `WorkflowWorker.js:375-379`。**竞态是否实际触发：推断，未实测复现**。
影响：AI 块的结果可能在落盘前就被后续块读走（拿到旧值或空值）；失败时日志丢上下文，排查只能看到 message。
建议：补 `await` + 改为保留原字段的 rethrow（`Object.assign(new Error(error.message), error)` 或直接 rethrow）。代价两行；顺带确认 `handlerParameterPrompt.js:123`。
状态：待审核

### T-50 — `get_variables` 在所有宿主下都是死工具，`workflowContext` 从未传给 prompt

登记日期：2026-10-05
来源：会话 2026-10-05 讨论「侧边栏里pin 住标签页和工作流」时逐层核对 context 组接线，触发点 `src/agent/index.js:384`、`src/composable/agentHost.js:295-307`
现象：`context` 组两个工具里，`get_block_schema` 是活的（默认实现 `lookupBlockSchema` 已按 T-32 接上），但 `get_variables` **在任何宿主下都返回「（空）」** —— `createAgentRuntime` 的默认值是 `getVariables = async () => ({})`（`index.js:384`），而 `useAgentHost` 构造 runtime 时只传了 `getConfig/targetTab/enabledGroups/sessionStore/getWorkflowId/...canvas/onSessionsChanged/requestConfirmation`（`agentHost.js:295-307`），**两个宿主都没传 `getVariables`**（`Agent.vue` 与 `[id].vue` 均无）。同理，`prompt.js:252` 的 `workflowContext` 分支（`<untrusted_workflow_context>` 包装）也**没有任何调用方**——`agentHost.send()` 调 `runtime.send({userText, onEvent})` 时不带该字段。
证据：**实测** —— `.scratch/gv-probe.mjs`（`node --import ./utils/test-loader.mjs`）直接调真模块：`getVariables.execute({}, {getVariables: async () => ({})})` 输出 `"## 变量\n工作流变量:\n  （空）\n全局变量:\n  （空）"`。**接线核对** —— `Select-String 'getVariables|getWorkflowContext|workflowContext' src/composable/agentHost.js src/newtab/pages/Agent.vue 'src/newtab/pages/workflows/[id].vue'` **零命中**；`src/` 内 `getVariables:` 的传入点只存在于 `tools/index.test.js:201/217`（测试桩）与 `index.js:384`（默认值）。技术设计 §7.3 承诺的数据源（`dbStorage.variables.toArray()` + `workflow.table` + `parseJSON(workflow.globalData)`，见 `docs/agent-assist-tech-design.md` §7.3）从未落地。
影响：
- 模型被事实表告知「只读工具可直接执行：get_variables」（`prompt.test.js:43` 钉住这句），调下去永远拿到两个「（空）」——**不报错、不降级提示**，与「助手告诉用户这个工作流没有任何变量」无法区分。模型据此写模板引用必然引用到不存在的变量名。
- 影响面是全部宿主：独立助手页与编辑器侧栏都中招；`untrusted_workflow_context` 是 7 个已登记包装标签之一（`untrusted.js:30`，被测试钉死），却永远不会被生产代码触发。
- 这条是 T-49 的隐藏前置：**「pin 住工作流」要真有价值，助手得能读那个工作流的变量与概况**，而这条链路今天根本不存在。
建议：
- `getVariables` 由宿主注入。`[id].vue` 侧按 tech-design §7.3 组装（`dbStorage.variables.toArray()` 先例见 `[id].vue:954`，`workflow.table`、`parseJSON(workflow.globalData)`）；独立页/侧边栏在没有工作流时**必须显式返回「未绑定工作流」而不是「（空）」** —— 两者对模型是完全不同的结论，这是本条的核心。
- `workflowContext` 同步接线（`[id].vue` 组装 `workflow` computed 只读摘要），或**明确删掉** `prompt.js:252-254` 与 `untrusted.js:30` 里的这个标签 —— 留着一条永不触发的分支比删掉更糟，它会让下一个人以为工作流上下文已经进prompt 了。**两者选一，不要都留。**
- 补一条断言：context 组任一工具在「宿主未注入」时必须返回可辨识的错误/说明，测试断言它**不是**「（空）」。
状态：待审核

### T-59 — `log` 缺工具调用与结果打点，参数摘要无处可查

登记日期：2026-10-05
来源：会话 2026-10-05 票 08（删除 `llm/`），触发点 `src/agent/loop.js:533`、`:545`、`:696`，测试 `src/agent/loop.test.js`
现象：`loop.js` 只打三个点 —— `tool.confirm.ask`、`tool.confirm.answer`、`turn.end`（另有 `turn.error`）。**工具实际执行与产结果没有任何打点**，所以「模型传了什么参数、工具返回了什么」在日志里查不到。只有过确认门的写类工具能间接看到参数（`tool.confirm.ask` 带 args），read 类工具一个点都没有。
证据：**实测（对照迁移前基线）** —— 基线快照 `.scratch/agent-baseline/src/agent/loop.js` 里 `log(...)` 只有两处：`turn.error`（`:348`）与 `turn.end`（`:364`）。**迁移前就没有这两个打点**，所以这不是 pi 迁移引入的回归。`loop-test-classification.md` 的 #37 要求「重构时至少保住工具调用与结果有打点」，这条要求在迁移前就没满足。
影响：排查「模型为什么调了这个工具、为什么回了这个结果」时没有现场，只能复现。`log.js` 头注写它是「排查卡死/异常时的现场」，工具链是助手最高频的卡点，缺的正是这一段。
建议：在 `fromPiEvent` 的 `tool_execution_start` / `tool_execution_end` 映射处各打一点（`tool.call` 带 name + args 摘要、`tool.result` 带 name + isError），或者直接在 adapter 的 `execute` 前后打。代价约 4 行；注意 args 可能很大，打点要截断。
状态：待审核

### T-64 — 系统提示向模型承诺不存在的「read_page 快照压缩」，window.js 的 elide/预算是零调用死接口（迁移回归）

登记日期：2026-10-05
来源：会话 2026-10-05 架构评审，触发点 `src/agent/prompt.js:105-109`
现象：系统提示明文承诺「read_page 的历史快照会被压缩成一行占位（只保留最近一次）」。迁移前这是真的（`894ec164:loop.js:410-411` 每步都跑 elide）；票 08 删 wire 层后，`elideStaleObservations`/`applyTokenBudget`/`estimateTokens` 生产代码零调用，接口形状还是旧 wire 消息（`role:'tool'`、字符串 content），与 pi 的 content-block 现状不匹配。`config.js:66-68` 注释同样声称 contextWindow 决定裁剪节奏。
证据：**实测** —— `grep -rn "elideStaleObservations|applyTokenBudget" src/`（排除测试）仅命中 `window.js:106/143` 定义处；生产调用只剩 `events.js:9` 的 `truncateObservation`。
影响：模型基于假前提行动（被要求「把 selector 复述进方案以防被压缩」——这条行为碰巧有益，但前提是假的）；更重要的是僵尸接口误导维护者：真到 B9 第 1 项翻案那天，这套面向旧 wire 形状的实现也不能直接用。
建议：window.js 收缩为只剩 truncateObservation（可并入 events.js），elide/预算删除；prompt.js:105-109 与 config.js:66-68 改为实况。B9 翻案时另写面向 pi 形状的新实现，不复活这份。
状态：待审核

### T-66 — provider.js 头注声称 config「已过 validateConfig」，运行时路径 loadConfig 并不校验

登记日期：2026-10-05
来源：会话 2026-10-05 架构评审，触发点 `src/agent/provider.js:62`、`src/agent/config.js:158-171`
现象：`loadConfig` 只合并默认值 + 解密，不跑 `validateConfig`（只有 `saveConfig` 校验）。`runtime.send` 只挡 apiKey 为空（`index.js:596-600`）。存量/旧形状/手改的存储配置（缺 baseUrl/model）会一路走进 `buildModel` → pi 请求层。
证据：**静态确认**（三处代码位置）；损坏配置的实际报错文案未实测。
影响：用户看到的是一句指不到真因的 provider 报错，而不是「配置不完整」，与 T-40「错误要能定位」的方向相悖。
建议：loadConfig 读回后跑一次 validateConfig，不合规时降级 DEFAULT_CONFIG 并打点（或抛带字段的错误）。
状态：待审核

### T-67 — agentHost.send 的插话分支缺 `!agent.runtime` 判空，init 未完成时点发送会炸

注：低危
登记日期：2026-10-05
来源：会话 2026-10-05 架构评审，触发点 `src/composable/agentHost.js:219-230`
现象：openAgentSession/newAgentSession/deleteSession 都判 `!agent.runtime`（`:146/:156/:172`），唯独 send 没判：busy 插话分支在 try 之外直接 `agent.runtime.enqueueInstruction`（TypeError 未捕获）；非 busy 分支的 `agent.runtime.send` TypeError 被 catch 包成 error 事件，文案是一句栈话。
证据：**静态确认**（代码位置）；busy 只在 send 内置 true，风险窗口 = init() 未完成（编辑器侧惰性 init / loadConfig 慢）时用户先发消息。未实测复现。
影响：低频但体验差：用户看到「Cannot read properties of null」而非「助手还在初始化」。
建议：send 开头补 `!agent.runtime` 的显式提示，或把发送排队到 init 完成之后。
状态：待审核

### T-68 — AgentTabList 把主窗口写死为 `id === 1`（原 AgentTabPicker，UI 改造后迁移）

注：纯显示
登记日期：2026-10-05
来源：会话 2026-10-05 架构评审，触发点 `src/components/newtab/workflow/agent/AgentTabList.vue:75-77`（窗口分组逻辑随并行会话的面板改造从 AgentTabPicker.vue 迁来，缺陷原样保留）
现象：`windowLabel(id)` 以 `id === 1` 判「主窗口」。Chrome 的窗口 id 不保证为 1（会话恢复、先开后关都可能让主窗口拿到别的 id）。
证据：**静态确认**（grep 实测 `AgentTabList.vue:76`）；未实测触发。
影响：窗口分组标签偶尔标错；纯显示问题。
建议：与 `browser.windows` 的真实主窗口 id 比对，或去掉特判只显示「窗口 N」。
状态：待审核

### T-107 — 架构文档 §12 称 COMPACTION「UI 不渲染」，实际面板有默认收起的折叠卡

注：文档与代码不符
登记日期：2026-10-06
改号说明：原登记号 T-90，与 `docs/backlog-done.md` 里已完成的「T-90 — C5 架构候选落地：宿主 seam 收敛」撞号，2026-10-06 改为 T-107（原 T-89 条目已按 T-105 删除，其正文与决策记录见归档）。
来源：会话 2026-10-06「解释 agent-architecture.html 的压缩章节」，触发点 `docs/agent-architecture.html:1285` 表格 vs `src/components/newtab/workflow/agent/AgentTranscript.vue:68-90 / 183-190`
现象：文档 §12 事件→槽位表写「COMPACTION — 无专属槽位，UI 不渲染（模型侧经投影进 transcript；用户可见的信号是恢复时那条 system-notice）」。代码里折叠层有 `item.type === 'compaction'` 分支：默认收起的折叠卡，按钮显示 `workflow.agent.compacted`（带轮数），展开后渲染摘要全文。
证据：实测——读上述两个位置；文档行 1285 的表格原文与 vue 的 push({type:'compaction', raw, turns, open:false}) 对不上。
影响：按文档改 UI 或写测试的人会以为不存在渲染路径（可能重复造或误删）；文档是理解「用户能不能看到摘要」的入口，错一行会误导行为判断。
建议：改文档那一行，改为「默认收起的折叠卡，展开可见摘要全文」。
状态：待审核

### T-108 — vRemixicon icons 注册表缺 riArrowRightSLine 键，会话收起箭头渲染成空 SVG

登记日期：2026-10-06
来源：会话 2026-10-06 T-81b 开工期间修复 vRemixicon.js 误截断时发现（git diff 对照 HEAD 推断，非本轮引入）
现象：`src/lib/vRemixicon.js` 顶部 import 了 `riArrowRightSLine`，但 `export const icons` 注册表里没有这个键。AgentPanel.vue 的会话 chip 用它做展开/收起箭头（`isExpanded ? 'riArrowDownSLine' : 'riArrowRightSLine'`），收起态会静默渲染成空 SVG。同时 eslint 报 no-unused-vars（import 了没用）。
证据：`grep -n riArrowRightSLine src/lib/vRemixicon.js` 只有 import 行一条；`AgentPanel.vue:46` 在用；panelUi 图标守卫只查 import 清单所以测不出来——守卫对「import 了但没注册进 icons」这类半截接线是盲的。
影响：用户看到的会话展开箭头缺一半（收起态没有图标）；lint 常红会训练人忽略错误。
建议：icons 表补一行 `riArrowRightSLine,`（与 riArrowDownSLine 相邻）；可考虑守卫测试同时断言「import 清单 ⊆ icons 键集」，让两类清单永不漂移。
状态：待审核

### T-113 — `get_variables` 的描述承诺「含值与类型」，实现只打印值，从不输出类型

登记日期：2026-10-06
来源：会话 2026-10-06 开工 T-50 时读 `src/agent/tools/page.js` 的 `getVariables.execute` 发现
现象：工具 description 写「读取当前工作流已定义的变量与全局变量（**含值与类型**）」，但 execute 的拼装只有 `'  - ' + k + ' = ' + JSON.stringify(vars[k])`（`page.js:222-233`）—— 类型从未被输出。模型只能从值的字面量反猜类型（`"alice"` 像字符串、`3` 像数字），`null` / 空串 / 对象值则完全无从判断。
证据：**实测** —— `.scratch/t113-probe.mjs`（真 `getVariables.execute` + 桩 ctx，喂 `{username:'alice', retries:3, token:'sk-live-9f2c1a4e'}`）输出（整块缩进两格，避免第一行的 `## ` 被当成标题）：
  ```
  ## 变量
  工作流变量:
    - username = "alice"
    - retries = 3
    - token = "sk-live-9f2c1a4e"
  全局变量:
    （空）

  当前工作流 id: wf-1
  ```
  三行里没有任何类型标注。
影响：模板引用写错类型时模型没有依据纠偏（Automa 模板里字符串要引号、数字不要，差别就在这）；描述与实现不一致也会让模型去找并不存在的「类型」字段。
建议：要么在每行补 `（string）` 之类的类型标注，要么把描述里的「含值与类型」删掉。**建议补上标注**：模型写模板引用时类型是最容易错的一处，描述承诺过的东西不该悄悄缩水。
状态：待审核

### 改进



### T-09 — 一轮对话缺运行时可见性：步数、模型名、轮次分隔、token 位置

登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentTranscript.vue:189-192`、`AgentPanel.vue:46-54,162`
现象：① `agent:start` / `agent:done` 被显式忽略，多轮对话之间只有用户气泡做分界，长会话回看时分不清哪段是哪一轮；② 不显示这一轮跑到第几步（`MAX_STEPS=12` 用尽即收尾，用户看不出「快到上限」）；③ 面板不显示正在用哪个模型（`config` 只用来判断 apiKey 是否存在）；④ token 用量是 10px 灰字角标，且无上下文窗口水位。
证据：**代码位置，推断，未实测** —— `AgentTranscript.vue:189-192`（start/done/target-tab 一律丢弃）、`src/agent/loop.js:30`（`MAX_STEPS = 12`）、`:282`（步循环）、`:428-435`（done 事件带 `aborted`/`usage`）、`AgentPanel.vue:46-54`（`text-[10px]` usage）、`:162`（config 仅取 apiKey）。
影响：卡在工具循环里的那一轮，用户只看到工具卡不停翻，没有任何「还剩多少余量」的信号；换模型/换 provider 后也无从确认当前答案来自哪个模型。
建议：`agent:start` 渲染成一条轮次分隔线（含时间戳需给事件补字段，或用会话侧时间）；工具卡区域加「第 n/12 步」进度；头部或会话条显示 `config.model`；usage 提到会话条 tooltip 之外，再加一条上下文水位（usage.input / contextWindow）。
状态：待审核

### T-12 — 输入框固定三行、无长度上限，插话入队后输入区无就地反馈

登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentPanel.vue:91-97`、`src/components/ui/UiTextarea.vue:48-64`
现象：输入框 `rows="3"` 固定高度，`UiTextarea` 自带的 `autoresize` 计算被注释掉，写长指令只能在三行小窗里滚；无 `maxlength` 也没有字数提示。busy 时点「插话」后草稿被清空，唯一的入队确认是事件流里的一条 notice —— 输入框本身没有任何变化，用户会怀疑消息丢了。
证据：**代码位置，推断，未实测** —— `AgentPanel.vue:91-97`、`UiTextarea.vue:48-64`（`calcHeight()` 定义在 `:48-52`，`:64` 调用被注释）、`agentHost.js:141-150`（入队后 push notice + 清空 draft）。
影响：长指令的编辑体验差；插话是否送达不直观（尤其队列要等下一步才执行，等待期输入区一片空白）。
建议：开启 autoresize（设 `max-h` 滚动兜底，注意别撑破 320px 侧栏）；busy 态在输入框上方留一条常驻「已入队 N 条插话，下一步执行前送达」，比一次性 notice 更可靠。
状态：待审核

### T-14 — 流式输出时对整段文本逐 delta 重解析，长回答可能卡顿

登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `src/components/newtab/workflow/agent/AgentMarkdown.vue:97`、`AgentTranscript.vue:131-138`

现象：`blocks = computed(() => markdownToBlocks(props.raw))`，而 `raw` 每来一个 `text-delta` 就增长一次 —— 单条助手消息的解析成本随长度平方增长（n 个 delta × 每次解析整段），同一时刻事件流里可能还有多条历史消息的 computed 在依赖链上。
证据：**推断，未实测** —— `AgentMarkdown.vue:97`、`AgentTranscript.vue:131-138`（appendDelta 就地改 `last.raw`，触发对应组件重算）。本项目没有该路径的性能测量数据，先量再改。
影响：长回答 + 长会话时输入与滚动掉帧；具体阈值未知，可能只在 8K 以上的输出才显现。
建议：先做一次实测（造 5K/10K 字符的桩事件流，用 performance 记录 delta 到渲染的耗时），确认瓶颈后再选方案：按块边界增量解析、或流式期间只渲染「最后一个块」而对已完成块做 memo。未实测前不改。
状态：待审核

### T-16 — 只能复制代码块，复制不了整条回答

登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentMarkdown.vue:24-28`、`docs/agent-assist-tech-design.md` §9.1 面板骨架（该节已标注作废，承诺本身仍有效）
现象：复制按钮只挂在代码块上（hover 才出现），助手整段回答没有复制入口；方案 §9.1 明确要求「assistant 文本额外渲染一个复制按钮（P0 交付判定要求“用户能复制”）」。
证据：**代码位置，与方案对照，未实测** —— `AgentMarkdown.vue:24-28`（仅 `block.type === 'code'`）、tech-design `:728`。剪贴板失败路径已有兜底（`:111-122`）。
影响：用户想把助手给出的 selector 列表/步骤说明整段搬走时，只能手动划选；320px 侧栏里划选长段落很痛苦。
建议：每条 assistant 消息 hover 时出「复制」按钮（复用现有 `copy()` 与 1500ms 「已复制」反馈），长回答补一个滚动条以免按钮被顶出可视区。
状态：待审核

### T-53 — 事件流 → 渲染槽位的折叠层是全仓分支最多的 UI 逻辑，却写死在 `.vue` 里测不到

登记日期：2026-10-05
来源：会话 2026-10-05 用户问「UI 有没有更好的实现方式」，触发点 `src/components/newtab/workflow/agent/AgentTranscript.vue:113-206`
现象：面板其余部分都已按项目自己立的规矩抽成了纯模块（`confirm.js` 的展示载荷、`sessions.js` 的 `sessionOptionLabel`，两处头注都写明理由是「SFC 里的分支一条都测不到」），**唯独折叠层没抽**。`AgentTranscript.vue` 的 `applyEvent` / `sync` / `appendDelta` 约 90 行、7 个事件分支、含 tool卡合并与换会话重放，全部在一个 SFC 的 `<script setup>` 里，没有任何测试触及。
证据：**静态** —— `Get-ChildItem -Recurse -Include *.test.js src` 共 **27 个测试文件，全部在 `src/agent/` 下，`.vue` 相关 0 个**。项目自订规则的原文：`confirm.js:4-6`「AgentConfirmCard 是 .vue，本仓没有组件测试基建，写进组件的分支一条都测不到 —— 放成纯函数，`npm test` 才钉得住」、`sessions.js:90-91`「放在这里而不是面板模板里，是因为这段拼装必须能被单测钉住」。旁证：`eventContract.test.js:30-34` 被迫把 `.vue` 也扫进源码集合，靠**读源文本**（`readFileSync` + `includes`）来守接线 —— 有别的办法时不会这么写。未覆盖的具体分支：① `appendDelta` 的「同类型连续 delta 并入同一槽位」；② tool call/result 合并成一张卡的判据（`:168-186`，按 `step` + `name` 比对）；③ `sync` 换会话整表重放（`:196-206`，按数组引用判定）；④ 落盘前`pruneEphemeralEvents` / `cropToTurns` 裁剪过的历史重放回来是什么样。
影响：纯认知与回归成本，无当前运行时危害。T-52 就是这条的直接产物 —— 「事件不带 `args`」本该由一条「工具事件的 args 等于桩工具实参」的断言拦住，而断言写不了就只能靠人读代码发现。同理 T-04/T-07/T-09 三条已登记的 UI 欠账全部落在这同一段无法验证的逻辑上。
建议（**命名红线**：`CONTEXT.md` 明令 `transcript` 一词废弃，新模块不得沿用）：
- 抽 `src/agent/fold.js`，导出**增量式** reducer 而非纯函数 `foldEvents(events)`：纯函数版每来一个 delta 都要重折整段（与 `AgentMarkdown.vue:97` 已登记的 T-14 同型O(n²) 问题），应当保留游标语义 —— 形状是 `createFolder()` 返回 `{ items, apply(ev), reset() }`。这样既保住流式性能，又让 `npm test` 能用真事件数组驱动并断言槽位结果。
- 抽完之后 T-52 的断言可以直接写在 fold 的消费侧或 loop 侧，两者选一，别两处都写。
- 顺序上**排在 T-52 之后**：先修数据（事件补 `args`），再抽模块。反过来做等于把一个已知 bug 一起搬进新模块。
状态：待审核

### T-57 — `untrusted.test.js` 只钉 `length === 8`，与红线「清单被测试钉死」有落差

登记日期：2026-10-05
来源：会话 2026-10-05 pi-agent-core 迁移可行性核查，触发点 `src/agent/untrusted.test.js:137-139`
现象：`AGENTS.md` 红线第 2 条写「`UNTRUSTED_WRAPPER_TAGS`（当前 8 个，**被测试钉死**）」，但测试只断言 `UNTRUSTED_WRAPPER_TAGS.length === 8`。**删掉一个标签再补一个别的，测试仍然全绿** —— 因为长度没变。（数字 2026-10-06 随 T-106 一起更正：原文写的 7 是 T-76 加 `untrusted_compaction_summary` 之前的值。）
证据：**实测** —— `untrusted.test.js:137-139` 断言 `length === 8`；且 `untrusted.test.js:91-94` 明确断言**未登记标签原样通过**（证明删标签不会触发任何现有断言）。实际清单见 `untrusted.js:28-36`（`untrusted_page_content` / `untrusted_tab_metadata` / `untrusted_workflow_context` / `untrusted_user_message` / `untrusted_tool_result` / `untrusted_compacted_steps` / `untrusted_system_notice` / `untrusted_compaction_summary`）。
影响：红线的强度被高估。清单是「模型能识别的边界」的唯一声明处，误删一个标签（如 `untrusted_tool_result`）会让该类内容对模型失去结构化边界，且测试不响。
建议：断言改为钉住 8 个标签名与顺序（`deepEqual` 全数组）。代价约 10 行；会与「新增标签需同步改测试」形成刻意的摩擦，这正是想要的效果。
状态：待审核

### T-60 — pi 不跳过缺 toolCallId 的空转块，与迁移前的净化行为不同

登记日期：2026-10-05
来源：会话 2026-10-05 票 08（删除 `wire.js`），探针实测见本条「证据」
现象：迁移前 `wire.js` 会**跳过**没有 `toolCallId` 的空转块。pi 不跳：实测它把 `id: undefined` 一路传下去 —— `execute` 收到的 `toolCallId` 是 `undefined`，assistant 消息里那个 toolCall 块的 `id` 也是 `undefined`，产出的 toolResult 的 `toolCallId` 同样是 `undefined`。**两边都 undefined 所以仍然配对，工具照常执行、整轮不崩**，但这是「凑巧相等」而不是「有 id」。
证据：**实测（探针，2026-10-05）** —— 用 `@earendil-works/pi-agent-core` 的 `Agent` 直接跑：投一个 `{type:'toolCall', name:'echo', arguments:{}}`（无 id）的 assistant 消息，事件序列完整走完 `tool_execution_start:echo → tool_execution_end:echo`，`toolResult.toolCallId === undefined`，且与 `execute` 收到的 id 相等（都是 undefined）。探针见 `.scratch/probe-id.mjs`（过程材料，已 gitignore）。**未实测**：真实 provider 收到 `tool_calls[].id === undefined` 会不会被拒 —— 夹具层看不到请求。
影响：夹具层无害。真发到 OpenAI 兼容端点时，缺 id 的 tool_call 很可能被拒（400）或导致 tool_call 无法与 tool 消息配对 —— 那时候的表现是「整轮 provider 报错」，而不是「跳过一个空块」。当前 `loop.test.js` 的替代断言只钉了「不崩」，没钉「provider 会不会收」。
建议：两条路。① 在 `fromPiEvent` 的 `tool_execution_start` 映射处检查 toolCallId，缺失时打点并在 DONE 里附一句（不改pi 的行为，只让我们看得见）。② 什么都不做，等真出问题再补。代价：①约 5 行 + 一条测试。
状态：待审核

### T-95 — 活轮次可用真实 usage 校准 token 估算，摆脱对「用户填 contextWindow」的依赖

注：新功能方向，先讨论后定
登记日期：2026-10-06
来源：会话 2026-10-06 用户提问「作为 agent 产品，需要设置 maxTokens 和 contextWindow 参数吗」；触发点 `src/agent/loop.js:514-522` harvestUsage、`src/agent/compaction.js:29`（不用 usage 的理由注释）、`src/agent/loop.js:124-130`（重放消息 usage 全 0）
现象：`harvestUsage` 已经在读 `m.usage.input`——**活轮次内 piAgent.state.messages 里的 assistant 消息带真实 usage**，也就是「当前上下文的真实 token 数」是可得的。现在完全没用它，全靠字符估算。
证据：静态确认（上述三处）。关键约束：跨轮续接时历史由 `historyToPiMessages` 重放、usage 一律记 0（`loop.js:124-130` 注释明写），所以**只有活轮次能用 usage，跨轮首轮仍须退回估算**——这正是当初「不用 usage 记账」注释成立的真正原因（多请求轮 usage 累加值语义不对，且重放消息没有 usage）。
影响：能显著提升阈值判断精度（不再依赖用户填的 contextWindow 与字符估算的双重误差），填错 contextWindow 的后果进一步收敛。代价：需要把「最后一条带真实 usage 的 assistant 消息」映射回事件历史下标才能知道哪些事件已被 usage 覆盖，事件↔消息不是 1:1，映射本身有复杂度与出错面。
建议：~~先做 T-94（预设带默认值，半天）观察效果~~ —— **T-94 已完成**（PROVIDERS 预设已带 contextWindow，见归档），本条作为后续；若做，建议只用于「校准估算系数」（真实/估算 比值滑动平均）而不是直接替换阈值判断，风险更可控。
状态：待审核

### 新功能（要讨论场景，审得慢）
### T-111 — `docs/backlog-done.md` 里有 8 组重复编号，按编号回溯会取到错条目

登记日期：2026-10-06
来源：会话 2026-10-06 归档 T-65（adapter 预折放行）时撞号，触发点 `docs/backlog-done.md:467` 与 `:1356`
现象：档案里同一个 T 编号对应两条以上不同条目 —— T-61×2、T-62×3、T-65×2、T-69×2、T-70×2、T-71×2、T-83×2、T-89×2。成因是历史上多次改号与并档（`agent-backlog.md` 并入、T-90→T-107）没有回头核重。
证据：**实测** —— 对 `docs/backlog-done.md` 全部 98 条 `### T-NN` 标题做编号计数，重复 8 组；本轮归档的 adapter 一条正是撞上历史 T-65（已按既定做法改号为 T-110，条目内写了改号说明）。
影响：按编号回溯会取到错条目（「T-62」对应三件不相干的事）；归档时不先查重就会静默撞号，撞了也不一定有人发现。
建议：二选一 —— ① 一次扫完，给每个重复的后出现者顺延到当前最大号之后并逐条补「改号说明」（干净，但要人肉核对 12 条）；② 档案顶部加一句「编号跨历史不保证唯一，按标题+日期检索」（便宜，立刻可做，但重复仍然留着）。


### T-10 — 空态只有一句话，缺示例问法与「本宿主开放哪些工具」的说明

登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentTranscript.vue:8-13`、`src/newtab/pages/Agent.vue:46`
现象：空态仅渲染 `workflow.agent.empty` 一句文案。没有可点击的示例问法，也不告知这个宿主开了哪些工具组 —— 独立助手页 `enabledGroups: ['page','context','tab']`（无画布），编辑器侧栏才开放 `canvas` 组，两侧文案完全一样，用户无法预期「这里能不能让它加块」。
证据：**代码位置，推断，未实测** —— `AgentTranscript.vue:8-13`、`Agent.vue:46`、`workflows/[id].vue` 侧栏宿主（canvas 组开放）、`CONTEXT.md`「工具组」「宿主」条。
影响：首次进入的用户不知道能问什么，也不知道能力边界；在独立页让助手改画布只会得到工具不存在的失败回执。
建议：空态放 3~4 个可点击示例（点击即填入输入框，不自动发送），下面加一行工具组徽标（读页面 / 变量与块 / 标签页 / 画布）。文案按宿主分别给，`AgentPanel` 增加一个 `capabilities` prop 或由宿主传入。
状态：待审核

### T-49 — 把助手对话界面搬到浏览器原生侧边栏（Chrome `sidePanel` / Firefox `sidebar_action`）

登记日期：2026-10-05
来源：会话 2026-10-05 用户提问「我现在有个想法把agent助手对话界面做在浏览器的侧边栏，你觉得这个方案和现在项目目前的实现哪个更好？」
现象：现有两个宿主都住在 dashboard（`newtab.html`）里 —— ① 独立助手页 `/workflows/agent`（`router.js:59-63`），② 工作流编辑器右侧可拖拽侧栏（`[id].vue:30`、`:629`）。两者都与目标页**不同屏**：问「这个页面的列表怎么写 selector」时，助手在 dashboard 标签/弹窗里，被问的页在另一个窗口。这个错位已经付出可见的复杂度代价（见证据）。用户提出的方案是把对话界面放进浏览器原生侧边栏，与被操作的页面并排。
证据：**代码位置，本轮静态核对，未实测浏览器行为** ——
- `src/agent/tab.js:1-16` 整段头注在解释「为什么不能直接用 `getActiveTab()`」：dashboard 是普通标签页 → activeTab 返回 dashboard 自己（`chrome-extension://…`）→ content script 没注入 → 之后每次工具调用报 `Could not establish connection`。**助手与页面不同屏这件事，本身就是 `tab.js` 存在的原因。**
- `tab.js:77-108` `resolveTargetTab` 因此是四级优先级（pinned → lastAccessed → 当前窗口 → 其他窗口），本质是「猜用户在看哪个页」；`AgentPanel.vue:4-22` 的目标页行至今没有 pin/自动态与失效态（T-08 已登记）。
- `src/background/BackgroundUtils.js:28-42`：不存在 dashboard 标签时开一个 715×715 的 **popup 窗口** —— 助手与目标页必然不同窗。
- 侧边栏拿不到画布：`Agent.vue:41` 独立页 `enabledGroups: ['page','context','tab']`；canvas 组只在 `[id].vue:630-632` 开放，且依赖宿主注入的 vue-flow editor 句柄（`:635-643`）。**所以侧边栏可开放的工具组与独立助手页完全相同，结构上不可能多于它。**
- manifest 现状：`src/manifest.chrome.json` 为 MV3、`minimum_chrome_version: 116`，**无** `side_panel` 键、**无** `sidePanel` 权限；`src/manifest.firefox.json` 为 MV2，只有 `browser_action`、**无** `sidebar_action`。全仓grep `sidePanel|side_panel|sidebar_action` 仅命中 firefox manifest 的 `browser_action` 一行。建项时的 RFC（`docs/agent-assist-rfc.md`，已随过时文档删除，见 git `4a573976`）曾把 pie 的 `sidepanel/**` 列入「建议放弃」，理由是 **React vs Vue3**，不是对这个界面的 UX 判断 —— 即从未在「界面该放哪」这一层被否过。
- **并发不变式是「每页面一份」，不是全局**：`src/agent/index.js:77 const tabLocks = new Map()` 是模块级，跨会话 tab 锁（`index.js:565-585`）只在同一 JS realm 内生效；`sessions.js:143-156` 的写串行化（`writeTail`）同理。
影响：
- 好处是真实的且有代码依据：侧边栏与目标页并排后，「用户正在看的页」从**四级优先级的猜测**变成定义（当前窗口的 active tab），`tab.js` 的启发式与 T-08 的失效态困惑同时缓解；面板跨导航/切标签不消失，正在跑的一轮不会因为动了 dashboard 标签而死（「loop 跑在 newtab 页」这个架构决定当初是相对 pie 的优势，但反过来也是约束 —— 该决定的过程记录见已删除的 multi-session plan，git `4a573976`）。
- **「pin tab + pin 工作流」这个追加诉求拆成两半看**（详见 T-51）：pin tab 成立且是本条的主要收益；pin 工作流在**不接canvas 组**的前提下也成立（= 会话归属 + `context` 组那三样），但**接canvas 组需要跨进程代理**，是独立决策。**别把两半捆在一起评估** —— 捆着看会得出「侧边栏拿不到画布所以没用」的错误结论，拆开看则第一步零风险。前提条件：T-50（`get_variables` 死工具 / `workflowContext` 断链）必须先修，否则 pin 工作流只是个空壳。
- 坏处同样具体：① **替不掉编辑器侧栏** —— canvas 组的唯一来源是 vue-flow 句柄，所以最坏情况是三个宿主而不是两个，最佳情况也只是「用侧边栏替掉独立助手页」；② Firefox **没有** `chrome.sidePanel`（只有 legacy `sidebar_action`，按窗口而非按标签，`sidebarAction.open()` 需 FF 121+，本项目 `strict_min_version: 91.1`）→ 两套注册与打开逻辑，两个 manifest 各加一个键；③ 面板宽约 320px，T-12（固定三行输入）/ T-15（512px 弹窗塞进 320px 侧栏）/ T-16（长回答无法划选复制）三条已登记的宽度痛点会原样继承；④ 多一个常驻页面 ⇒ `tabLocks` 与 session 写链各持一份，B1 的 lost-update 窗口与 tab 锁绕过从「理论」变「日常」。
建议（**先审口径再谈排期**）：
- **推荐口径**：本条不是「换掉现在的实现」，而是「用侧边栏替掉宿主 ①（独立助手页），宿主 ②（编辑器侧栏）必须保留」—— 保留的理由是画布句柄，不是偏好。这样 ADR 0001 的原始动机（问页面结构必须先进入某个工作流的编辑器）与 `tab.js` 的四级优先级一起被消解，且不新增第三个能力重叠的宿主。若要三个都留，等于重开 ADR 0001「被拒备选：双入口」，需按那份理由逐条回应。
- **技术前置（不可顺手带过）**：`tabLocks` 与 session 写链必须先提到 background（SW 里的 Map）或 storage，否则两个常驻页面各持一份锁与写链，本条的安全前提当场破。顺带可修掉一个存量缺口：用户手动开两个 dashboard 标签页时，跨会话 tab 锁今天就已经失效。
- 代价排序：Firefox 双实现（最大）＞ 宽度回归（已有三条欠账可一并处理）＞ 新增 webpack entry 与 html 模板（最小）。
- **低成本先验**：若只想验证「同屏」这一条收益而暂不换宿主，可在独立助手页上补一个显式的「把当前目标页 pin 住」动作（复用现有 TabPicker + pin 体系，`AgentPanel.vue:15-22` 已有入口），成本远低于换宿主，也能顺带把 T-08 一起做掉。
状态：待审核

### T-51 — 画布组锁死在 dashboard 的 `[id].vue` 进程内，跨宿主要「代理」而非「接线」

注：架构决策
登记日期：2026-10-05
来源：会话 2026-10-05 讨论「侧边栏里 pin 住标签页和工作流」，触发点 `src/agent/tools/canvas.js:87/128/176`、`src/composable/agentHost.js:301`
现象：用户设想的「侧边栏 pin 住 tab + 工作流」里，**pin 工作流这一半有明确的技术天花板**：canvas 组的三个工具全部只依赖 `ctx.editor`（vue-flow 实例）与 `ctx.blocks`，而 editor 实例由 `[id].vue:638` 的 `getEditor: () => editor.value` 提供，物理上活在 dashboard 页的 JS realm 里。侧边栏/独立助手页即使**知道** workflowId，也没有画布句柄 —— `add_block` 会在 `canvas.js:87` 直接返回「画布还没准备好」。
证据：**代码位置，静态确认，未实测跨 realm** —— `canvas.js` 三处 `if (!editor) return {status:'error', payload:'画布还没准备好。'}`（`:87`/`:128`/`:176`）；`agentHost.js:301` 的 `...(deps.canvas || {})` 是唯一注入通道，而 `deps.canvas` 只在 `[id].vue:635-643` 被提供。ADR 0001「已知欠账」也记着同一件事：「独立助手页当前没有画布编辑能力。恢复方式：做一个『在助手里打开某工作流』的挂载机制后放宽 `enabledGroups`」。
影响：
- **好消息**：不接线 canvas 组在语义上是自洽的 —— `enabledGroups` 会连prompt 事实表一起裁剪（`index.js:429-432`），模型不会知道有画布工具存在。侧边栏 pin 工作流后能做到的是 `context` 组那三样（读变量、查块 schema、把工作流概况喂进 prompt），代价是**一条消息链**而不是画布代理。
- **坏处**：想做「在侧边栏对着页面直接把块搭到画布上」（这才是助手最像助手的场景），只有一条路 —— 侧边栏 → background → `tabs.sendMessage` → dashboard 页的 editor 实例执行。`BackgroundUtils.sendMessageToDashboard`（`BackgroundUtils.js:50-59`）是先例，但那是「找一个 dashboard 标签发消息」的粗粒度通道，不是「持有某个 workflowId 的 editor 并在它上面做只进内存的画布操作」的细粒度代理。
- 这条路会引出三个必须先答的问题：① dashboard 页没打开时怎么办（拒绝？还是自动开一个？自动开就撞 ADR 0001 被拒的「助手页绑定某个工作流」）；② 两侧同时持有同一 workflowId 的 editor（用户在 dashboard 编辑器里手动拖块的同时侧边栏的 agent 也在改）—— `tech-design` R-5 记的正是这类竞态；③ G5 边界：`onCanvasChanged` 只标脏这条不变式跨进程后是否还成立（用户点保存时保存的是 dashboard 那个实例，agent 的改动只要进了同一个 editor 实例就成立；但如果代理是「读出来改完再写回去」就会踩线）。
建议：**分两步，不要一次做**。
- **第一步（推荐先做）**：只 pin tab + pin 工作流**归属**，canvas 组不注册，把 `context` 组接线做通（即 T-50）。这样侧边栏回答的是「这个页面怎么抓」+「这个工作流现在有哪些变量」，已经覆盖 ADR 0001 撤掉编辑器 tab 的原始动机，且零跨进程风险。
- **第二步（独立决策，另立 ADR）**：真要做画布代理，先答上面三个问题再动手；判据应当是「用户是否真的在侧边栏里搭工作流」，而不是「技术上能不能转发」。
状态：待审核

---
## 已批准（待排期）

### T-81b — skills 两级注入 + read_skill 工具 + zip 导入导出（T-81 拆分第二张）

类型：新功能
登记日期：2026-10-05（2026-10-06 会话评审后拆票定稿）
来源：T-81 原票；2026-10-06 会话逐项拍板设计（见下）。机制借鉴 pi `skills.ts:355-380`（formatSkillsForPrompt 两级注入），代码不搬。
内容：
- **record 形状**：`{id, name, description, body, files: {path: content}, enabled}`，`files` 可缺省；附带文件 text-only（`.md` `.txt` `.js` `.json` `.csv` 等），**二进制/脚本导入时拒收并明确告知，不静默丢**；单技能总量软上限 256K（保存时警告不阻断）。
- **两级注入**：system prompt 只放索引（每技能一行「名称 — 描述」，经 facts 的 `skills` 字段），指示模型任务匹配时用工具读全文；**新增 `read_skill` 工具**（args `{name, path?}`：不带 path 读 SKILL.md 正文，带 path 读附带文件；未命中回 error 观察值并列出可用技能名，模型能自行纠正）。挂 **`context` 组**（2026-10-06 拍板：与 get_variables / get_block_schema 同为「查知识」类，宿主 enabledGroups 零改动；记录级 enabled 已承担启停，不新设组）。class: read，红线兼容。
- **zip 导入导出**：导入吃 `.md` 与 `.zip` 两种；导出单技能 zip（还原 `SKILL.md + files` 目录结构，与 pi / Claude Code 的 skill 文件夹形状互通）+ 全量备份 zip（全部技能 + 模板 + 指令一键导出/导入合并）。**新增依赖 JSZip**（浏览器运行时库；现有 archiver 是 Node 侧构建脚本用不了）。
- **附带文件在本运行时只有「读」没有「执行」**：pi 生态 skill 里的 `.sh`/`.py` 靠 CLI shell 执行面，本 agent 工具链不具备——附带文件定位为参考材料。
- **防撑爆**：索引总量 >4K 保存时警告（不阻断）。~~技能描述 ≤100 字符（保存时校验）~~ —— 2026-10-06 实测修正：生态 skill 描述本就数百字符（是给模型的触发判据），硬闸挡住导入主场景，降级为 UI 编辑时软警告（SKILL_DESCRIPTION_MAX 不再进 validateSkills）。
证据：2026-10-06 会话对 pi 机制的代码核对（skills.ts:355-380）；`utils/build-zip.js:4` 确认 archiver 不能用于浏览器运行时；`Agent.vue:22` / `[id].vue:614` 确认 enabledGroups 现状。
影响：用户可从 pi / Claude Code 生态导入现成 skill 文件夹；助手获得可扩展的任务知识库。
建议：在 T-81a 落地后开工，复用其存储底座与 SettingsAgent section。
状态：进行中（2026-10-06 代码落地，488 测试绿 + build 已重建，待用户实测后归档）

（暂无其他）

---

## B 编号 — 内置助手欠账（原 `docs/agent-backlog.md`，2026-10-04 合并）

每项一条：编号、来源、内容、为什么缓、重开的触发条件。**修完的整条移入 `docs/backlog-done.md`**，并把「缓决原因」换成 `结论：`。新增欠账先登记再排期，不允许「口头知道但不记录」。


### B2 — LLM 历史最后防线：空消息清洗 + 相邻同 role 修复

来源：同上 A1。pie `history-validation.ts` 的机制：发送前 drop 空消息（Kimi 对空 assistant 400）、相邻同 role 之间插哨兵消息（Anthropic 400），system 对不算违规；不可恢复输入抛专用错误；遥测只记长度+哈希。
缓决原因：当前主用模型（ModelScope/OpenAI 兼容）未实测出这两类 400，属纵深防御。
重开条件：接 Anthropic/Kimi 类严格端点，或多轮续接+插话组合后出现不明 400。
状态：待排期（~0.5d）。

### B3 — 设置页 provider 三件套

来源：同上 A2。①「测试连接」按钮走真实 chat 流（16 token + 15s 超时）；②「拉取模型列表」（/v1/models 归一化）；③模型元数据（vision/tools/contextWindow）驱动 token 预算，替代手填 contextWindow。
缓决原因：功能增量，不影响正确性。
重开条件：下一轮设置页改造。
状态：待排期（~1d）。

### B4 — eval 轻量回归集

来源：同上 C1。把 `.agent-test/*.mjs` 三个 live 脚本升级为固定任务集（每任务 JSON：prompt/桩/断言）+ 汇总，支持改 prompt 或换模型后一键回归。
缓决原因：目前 prompt 变更频率低，手测可覆盖。
重开条件：prompt 开始频繁迭代、或接入第二个 provider 需要对比。
状态：待排期（~1d）。

### B6 — agent:run-js 完整执行路径

来源：tech-design §7.4；code-review Spec 轴 (c)2。
内容：现实现为 `new Function` 同步求值（async 已补，10s 超时已补），方案中的 CSP 违规监听、严格 CSP 页面走 chrome.debugger 降级、Firefox 守卫、console 捕获未做。
缓决原因：目标页多为普通站点，executeScript MAIN world 可用；debugger 降级会引入调试横幅等 UI 代价，需要单独设计。
重开条件：用户报告在严格 CSP 页面 test_js 全部失败。
状态：待决策。

### B7 — 中止后的「上一轮被中断」提示

来源：多会话方案的 P3（该方案文档已删除，git `4a573976`）。
内容：newtab/助手页被关 = loop 消失；重开页面时若发现当前会话末尾有未收尾事件（悬空 tool_calls 已被 wire 净化，可安全续接），给一条 system-notice 告知用户。
缓决原因：净化已保证不炸，只是缺提示。
重开条件：与 P3 插话/会话 UI 下一轮迭代一起做。
状态：待排期（小）。

### B8 — 编辑器 activeUiTab 高亮（agent tab 时代遗留）

来源：tech-design 接线表。原指编辑器内 agent tab 的激活态，agent 入口已迁主面板（`docs/adr/0001`），本项**随迁移作废**，除非独立助手页引入编辑器联动。
状态：已作废。

### B9 — 换pi-agent-core 内核的三项已知退化（决策于 2026-10-05）

来源：会话 2026-10-05，用户在知��三项实测代价的前提下选择「换内核 + 换 provider 层 + 不做上下文护栏 + 测试全部重写」。PoC 证据见 `.scratch/pi-poc/`（gitignored，结论已并入本条与 `docs/adr/0004`）。

**这一条是决策记录，不是待办** —— 三项退化都是**明知故犯**，写在这里是为了「三个月后没人记得为什么长对话会炸」。

内容（**四项**，同一次决策的四个侧面。前三项是用户决策，第四项是票 08 落地时才发现的连带后果）：

1. **无 token 预算裁剪、无步数上限**（原 Q7=B）。pi-agent-core 实测**没有任何默认行为**：`transformContext` 只是个回调位置，pi 从不自己调它做任何事；也没有 `MAX_STEPS` 等价物。后果：长对话直接撞 provider context 上限（主用 ModelScope 是 128k，页面正文动辄几万 token）；模型可无限工具循环，只有用户手点停止。**注**：`window.js` 的裁剪与 T-01/B2 的「纵深防御」注释都建立在这个前提上，去掉它等于把纵深防御一起去掉。
2. **`ERROR_KIND` 六种分类降级**（Q1=B 的连带后果）。实测 pi 的 openai-completions 失败路径上 `diagnostics` 恒为 `undefined`（只有 bedrock / pi-messages / codex-responses 三个 adapter 写它），`onResponse` 在 `await retryProviderRequest(...)` **之后**调用因而对 401/429 一次都不触发，`AssistantMessage` 上唯一可靠的只有 `stopReason`（`error`/`aborted` 两值）+ `errorMessage` 字符串。pi 自己做分类靠 `retry.ts:30-102` 约 60 条正则。后果：配置缺失要与 provider 401 区分、429 配额耗尽要与真限流区分，都得靠我们自己对字符串做正则反解 —— 而现状 `classifyHttpError` 直接拿得到 status 与 body全文，信息更全。
3. **丢掉全部 364 条测试的回归保护**（Q11=C）。`docs/backlog-done.md` 里 44 条已解决条目每条背后都有一条测试。重写期间若新代码有 bug，**没有旧测试能回答「这里本来是对的」**。缓解措施：基线快照在 `.scratch/agent-baseline/`（来自 commit `894ec164`，`.scratch/` 已 gitignore），配`.scratch/run-baseline-tests.mjs`。**该快照不在版本库里，换机器就没了** —— 若这批欠账要长期跟踪，重构落地时应把关键断言补成新测试并说明它们替代了哪条旧断言。

4. **未知工具名不再过确认门**（票 08 落地时发现，非用户决策）。pi 在内部短路未知工具（`agent-loop.js` 里直接产 error toolResult），**不经过 `beforeToolCall`** —— 所以用户不会看到「是否允许调用工具 X」的卡片。后果：与 ADR 0002「写类工具必过确认门」在字面上有落差。**判断为可接受**：不存在的工具本来也执行不了，确认它没有意义；而 ADR 0002 要防的是「模型改了不该改的东西」，这条路径上什么都没发生。**但如果将来引入「按名字动态注册工具」（比如用户自定义工具集），这条必须重开。**

缓决原因：用户的目标是「拿到更成熟的上下文管理与鲁棒性」（并行工具执行、truncation 保护、steering 队列、更完善的悬空 tool_calls 净化 —— `transform-messages.ts:158-186` 这几项实测 pi 确实强于现状），且明确接受用体积与上述代价换取。**实测体积（票 08 后）**：内核 153.6 KB min / 40.4 KB gzip + provider 层 309.7 KB min / 77.8 KB gzip = **463.3 KB min / 118.2 KB gzip**，两个都是异步 chunk。比 PoC 预估的 596.6 KB 小，因为只 import 了两个子路径而非 pi-ai 的 index。
重开条件（任一命中即应重开）：
- 用户报告长对话撞 context 上限，或模型陷入工具循环
- `ERROR_KIND` 降级导致错误提示无法区分（联系 T-04：那条已经在抱怨错误渲染太弱）
- 重构后出现「说不清是新引入还是存量」的问题，且基线快照已不在本机
状态：待决策（重构完成后逐条评估是否补回）。

---

## 已清 → `docs/backlog-done.md`

已解决条目全部在 **`docs/backlog-done.md`**（计数以该文件实物为准，并行会话同日多轮追加）：2026-10-05 拆出 44 条（T-02、T-05、T-06、T-17~T-25、T-26~T-34、T-35~T-43、T-44、T-45、T-47、T-48、B1、B5）；之后各轮：T-61、T-62 与面板 UI 系列（并行会话），T-70、T-71（架构评审 C1），T-82（C3），T-83（C2），T-89 及随其修复的 T-69（C4），T-75、T-76（pi 功能面调研轮：步数上限决策与上下文压缩，2026-10-06），T-91（`list_canvas` 静默截断 200 字符，2026-10-06），T-97~T-103（设置页多 provider 改造轮：密钥明文镜像、独立菜单、多连接、配置测试、图标名、新建连接入口、说明段落，2026-10-06），T-104（归档被截断后的恢复，2026-10-06），T-105（`backlog.md` 与归档失同步，2026-10-06；同批把待审核区的「T-90」改号为 T-107），T-04（报错渲染，并行会话完成）、T-46、T-54、T-56（已消解/已修复）与 T-77~T-80（驳回）——最后一批为 2026-10-06 待审核区按类型分区重构时清出的已裁决条目。

要看「某个坑当初是怎么被实测出来的」，去那个文件；要看「现在该做什么」，留在本文件。

