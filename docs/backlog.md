# 待办登记（会话捕获）

对话中发现的 **bug**、用户提出的 **改进** 与 **新功能** 一律先落在这里，由用户审核后再动代码。流程见 `AGENTS.md`「发现即登记」。

> 与 `docs/agent-backlog.md` 的分工：本文件是全仓库范围的会话捕获（T 编号）；`agent-backlog.md` 是内置助手功能自身的欠账（B 编号）。两处不混写。

## 登记模板

```
## T-NN — 一句话标题

类型：bug ｜ 改进 ｜ 新功能
登记日期：YYYY-MM-DD
来源：会话日期 + 用户原话 / 触发它的 `文件名:行号`
现象：具体症状与复现条件
证据：实测输出片段或代码位置（无实测就明写「推断，未实测」）
影响：谁在什么情况下会踩，最坏结果
建议：（选填）可选方案与各自代价
状态：待审核
```

## 待审核

### T-01 — countBlocks 把「块数」算成「属性数之和」，prompt 事实表报 715

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 架构评审，触发点 `src/agent/facts.js:18-25`
现象：`buildFacts()` 产出的 `blockCount` 对真实块目录返回 **715** 而非 **61**（它累加的是每个块定义的属性个数），`src/agent/prompt.js:180` 把这个数写进「本版共有 N 个块」喂给模型。与 `prompt.test.js:22` 的 fixture（61）不一致。
证据：**实测** —— `node --import ./utils/test-loader.mjs` 内执行 `Object.values(tasks).reduce((n,t)=>n+Object.keys(t||{}).length,0)`，输出 `blocks= 61 sumKeys= 715`。测试抓不住的原因也已实测核对：`facts.test.js:113-118` 把同一个公式在测试里重打一遍（恒真断言），`facts.test.js:97` 只断言 `> 50`（715 也过）。
影响：每次 `send` 都把错误的块总数写进 prompt，模型据此判断「有哪些块可用」，可能漏推荐或多推荐块；且这条断言形状让该类错误永远测不出来（违反「不静默降级」）。
建议：① `countBlocks` 改为数块本身（`Object.keys(catalog).length`），代价约 10 分钟；② 必须同步改断言 —— `facts.test.js:33`（`{a: null, b: {name:'x'}} → 1`）与 `:63/:81` 的 fixture 期望是按旧公式写的，新语义下应为 2，漏改会直接红。改完把 `:113-118` 换成 `=== 61` 的语义断言。
状态：待审核

### T-02 — 确认门在面板被切走后不 resolve，那一轮 loop 永久挂起

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 架构评审，触发点 `src/newtab/pages/workflows/[id].vue:1166-1185`、卡片位置 `[id].vue:26-53`
现象：write 工具等待用户确认时，`agent-confirm-card` 挂在 `v-else-if="state.sidebarPanel === 'agent'"` 分支内；`toggleAgentPanel()` 把 `sidebarPanel` 切到 `details`（无 busy 守卫，也不调 `pendingConfirm.resolve`），或点某个块弹出 `workflow-edit-block`（`v-if="editState.editing"` 优先级更高）时，确认卡被隐藏，但 promise 仍挂着 —— loop 侧永远 await。
证据：**代码位置，推断，未实测复现** —— `agentHost.js:65-75`（promise 只存 `pendingConfirm`）、`:86-92`（仅切会话时拒绝）、`:231-235`（仅 `onBeforeUnmount` 拒绝，而宿主页没有卸载）。`CONTEXT.md:80` 的不变量只写了「切会话/卸载前先 resolve」，没覆盖「面板被藏起来」。
影响：用户在等待确认时切走侧栏或去改别的块 → agent 保持 busy、那一轮不收尾、会话不落盘；用户切回后卡片还在，点一次才恢复。最坏表现像「助手卡死了」。
建议：① `toggleAgentPanel` 与打开块编辑时走 `guardAgentSwitch()` 同款拒绝，代价极小；② 或把确认卡提到宿主根节点（不随 `sidebarPanel` 卸载），代价是卡片要自己处理遮挡；③ 或 busy + 挂确认时禁止切走（体验差，不推荐）。
状态：待审核

### T-03 — handlerAiWorkflow 未 await setVariable，rethrow 还丢掉 error.data/ctxData

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 架构评审，触发点 `src/workflowEngine/blocksHandler/handlerAiWorkflow.js:55`、`:71`
现象：① `this.setVariable(variableName, ...)` 没有 `await`，而 `WorkflowWorker.js:112` 的 `setVariable` 是 async（内部 await IndexedDB 写入）；② `throw new Error(error.message)` 把 `error.data` / `error.ctxData` 丢掉，而 worker 的错误路径正要回读这两个字段来写日志。
证据：**实测** —— grep `setVariable(` 在 `blocksHandler/` 下共 19 处调用，17 处带 `await`，未带的是 `handlerAiWorkflow.js:55` 与 `handlerParameterPrompt.js:123`（后者在 promise 链里，是否同因需一并确认）；`error.data/ctxData` 的回读位置 `WorkflowWorker.js:375-379`。**竞态是否实际触发：推断，未实测复现**。
影响：AI 块的结果可能在落盘前就被后续块读走（拿到旧值或空值）；失败时日志丢上下文，排查只能看到 message。
建议：补 `await` + 改为保留原字段的 rethrow（`Object.assign(new Error(error.message), error)` 或直接 rethrow）。代价两行；顺带确认 `handlerParameterPrompt.js:123`。
状态：待审核

### T-04 — 助手报错渲染成琥珀色「提示」，与系统提示同色且无重试入口

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `src/components/newtab/workflow/agent/AgentTranscript.vue:156-157`
现象：`agent:error` 走的是 `push({type:'notice'})` 通道，与预检/插话等 `agent:system-notice` 共用琥珀色样式块；模型答一半断流、provider 401/超时、config 缺失，全都以同一条淡黄提示呈现，视觉权重低于旁边的工具卡状态徽标。错误条上也没有「重试 / 查看详情」入口，用户只能重新打一遍问题。
证据：**代码位置，推断，未实测渲染效果** —— `AgentTranscript.vue:156-157`（ERROR → notice）、`:61-66`（notice 唯一样式 `bg-amber-500/10`）、`:153-155`（system-notice 同通道）；`AgentToolStep.vue:55-59` 反而有红/绿/琥珀三态徽标。
影响：所有失败路径（网络、鉴权、限流、config）在视觉上等同于「一句善意提醒」，用户可能反复重发而不察觉 key 失效；错误与警告混色也让「预检提示」这类 advisory 信息被当成故障。
建议：错误单独一类（红底 + `riErrorWarningLine` 图标 + `errorKind` 文案），notice 保持琥珀；错误条尾部加「重试」（复用同一 draft 或直接重发上一条用户消息）与「复制错误详情」。纯展示层改动，不动 `events.js`。

### T-06 — 确认卡浮层压住输入区，内容低于 tech-design §8.2 的承诺

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `src/newtab/pages/Agent.vue:21-26`、`docs/agent-assist-tech-design.md:640`
现象：① 确认卡以 `absolute inset-x-3 bottom-3` 浮在面板底部，正好盖住输入框与发送按钮 —— 等确认期间用户无法补一句上下文，也看不到自己刚发了什么；卡片不阻断滚动，往回翻历史时它一直悬着。② 卡内只有标题 + 一句通用 hint + 裸 `<pre>code</pre>`，而 §8.2 承诺的是：标题含目标页 title、正文给代码行数、明示「严格 CSP 页面走 chrome.debugger 降级，浏览器会显示调试横幅」、按钮为 `[取消] [执行]`。
证据：**代码位置，与方案对照，未实测** —— `Agent.vue:21-26` / `workflows/[id].vue:48-53`（浮层定位）、`AgentConfirmCard.vue:1-40`（无目标页/行数/CSP 文案）、tech-design §8.2 表格 `:640`。会话授权复选框属 **B5**，本条不重复登记。
影响：用户在信息不足的情况下裁决「是否在别人页面上执行代码」，正是 T2「知情执行」要防的场景；浮层遮挡则让确认期间的对话上下文不可见。
建议：卡片改为插入事件流内（工具卡下方，§9.1 骨架图就是这么画的）+ 顶部吸附条保底，正文补目标页 title、代码行数、CSP/debugger 提示；`[取消] [执行]` 对齐方案用词。与 T-02（切走侧栏后确认卡消失、loop 永久挂起）同区域，动手前一并处理。

### T-07 — 工具卡把 `<untrusted_*>` 包装标签原样摊给用户看

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `src/components/newtab/workflow/agent/AgentToolStep.vue:25-27`
现象：展开工具卡时，`step.observation` 是 `wrapObservation()` 的产物 —— 用户会看到 `<untrusted_page_content>`、`</untrusted_page_content>` 和 `[note: 观察值超预算已截断…]` 这类字样夹在页面正文里。这些标签是给模型看的提示注入防护，不是给人看的。
证据：**代码位置，推断，未实测** —— `AgentToolStep.vue:25-27`（直接渲染 observation）、`src/agent/loop.js:81-97`（resultEvent 一律走 `wrapObservation`）、`src/agent/events.js:55-88`（标签与截断注记在此处拼上）。
影响：首次展开工具结果的用户会以为是乱码或漏洞；「页面正文」与「工具自述」在视觉上没有分界，读长观察值很费劲。
建议：**只在展示层剥离**外层 `untrusted_*` 标签再渲染（按 `UNTRUSTED_WRAPPER_TAGS` 白名单匹配，保留截断注记并改成人话），`events.js` 的包装逻辑一行不动 —— 模型侧必须继续看到标签。

### T-08 — 目标页条缺 favicon、pin/自动态与失效态

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `src/components/newtab/workflow/agent/AgentPanel.vue:4-22`、`docs/agent-assist-tech-design.md:127-132`
现象：目标页一行只有一个地球图标 + 标题 + 右侧「选择目标页」。没有 favicon、不显示这一页是「用户手选固定」还是「自动解析」、也不显示目标页是否还活着：tab 被关闭或发生跳转后，头部依旧显示旧标题旧 URL，唯一的告知是事件流里一条写给模型看的系统提示（「目标页已经关闭…」），用户很容易以为助手还在看原页面。方案 §3.2 承诺的 favicon + 切换下拉 + `tabs.onRemoved` 失效处理均未落地。
证据：**代码位置，推断，未实测** —— `AgentPanel.vue:4-22`（无 favicon/无状态位）、`src/agent/index.js:250-286`（preStepNotice 只产出模型侧 notice，不回 UI）、`:231-239`（只有 `focus_tab` 会发 `agent:target-tab`）；`grep onRemoved src/` 仅命中 `workflowEngine` 与 `service/browser-api`，agent 侧无监听。
影响：这是面板上最关键的一行信息（用户必须知道模型在看哪个页），失效不提示会让整轮结论基于错误前提，且用户无从发现。
建议：① 加 favicon（`chrome://favicon` / 扩展内等价取法）与「固定 / 自动」小徽标；② 每步预检发现 tab 已关或 origin 漂移时，同步把状态写进头部（红/琥珀态 + 「重新选择」按钮），事件流里那条 notice 保留给模型；③ 变更处发一个宿主级回调而非新增事件种类，避免污染事件历史。

### T-09 — 一轮对话缺运行时可见性：步数、模型名、轮次分隔、token 位置

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentTranscript.vue:189-192`、`AgentPanel.vue:46-54,162`
现象：① `agent:start` / `agent:done` 被显式忽略，多轮对话之间只有用户气泡做分界，长会话回看时分不清哪段是哪一轮；② 不显示这一轮跑到第几步（`MAX_STEPS=12` 用尽即收尾，用户看不出「快到上限」）；③ 面板不显示正在用哪个模型（`config` 只用来判断 apiKey 是否存在）；④ token 用量是 10px 灰字角标，且无上下文窗口水位。
证据：**代码位置，推断，未实测** —— `AgentTranscript.vue:189-192`（start/done/target-tab 一律丢弃）、`src/agent/loop.js:30`（`MAX_STEPS = 12`）、`:282`（步循环）、`:428-435`（done 事件带 `aborted`/`usage`）、`AgentPanel.vue:46-54`（`text-[10px]` usage）、`:162`（config 仅取 apiKey）。
影响：卡在工具循环里的那一轮，用户只看到工具卡不停翻，没有任何「还剩多少余量」的信号；换模型/换 provider 后也无从确认当前答案来自哪个模型。
建议：`agent:start` 渲染成一条轮次分隔线（含时间戳需给事件补字段，或用会话侧时间）；工具卡区域加「第 n/12 步」进度；头部或会话条显示 `config.model`；usage 提到会话条 tooltip 之外，再加一条上下文水位（usage.input / contextWindow）。

### T-10 — 空态只有一句话，缺示例问法与「本宿主开放哪些工具」的说明

类型：新功能
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentTranscript.vue:8-13`、`src/newtab/pages/Agent.vue:46`
现象：空态仅渲染 `workflow.agent.empty` 一句文案。没有可点击的示例问法，也不告知这个宿主开了哪些工具组 —— 独立助手页 `enabledGroups: ['page','context','tab']`（无画布），编辑器侧栏才开放 `canvas` 组，两侧文案完全一样，用户无法预期「这里能不能让它加块」。
证据：**代码位置，推断，未实测** —— `AgentTranscript.vue:8-13`、`Agent.vue:46`、`workflows/[id].vue` 侧栏宿主（canvas 组开放）、`CONTEXT.md`「工具组」「宿主」条。
影响：首次进入的用户不知道能问什么，也不知道能力边界；在独立页让助手改画布只会得到工具不存在的失败回执。
建议：空态放 3~4 个可点击示例（点击即填入输入框，不自动发送），下面加一行工具组徽标（读页面 / 变量与块 / 标签页 / 画布）。文案按宿主分别给，`AgentPanel` 增加一个 `capabilities` prop 或由宿主传入。

### T-11 — busy 期间按钮静默禁用；中止后没有任何回执

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentPanel.vue:33,58,67`、`src/composable/agentHost.js:156-172`
现象：① busy 时「选择会话 / 新建 / 删除」三个按钮直接 `disabled`，不带 tooltip 也不给理由，用户点了没反应只会觉得卡；② 点停止后 `busy` 翻回 false、按钮复原，但屏幕上没有「已停止生成」的回执 —— loop 收尾事件里的 `aborted: true` 被宿主丢弃。
证据：**代码位置，推断，未实测** —— `AgentPanel.vue:33,58,67`（disabled 无 title）、`agentHost.js:156-172`（result 只读 `sessionId`/`usage`）、`src/agent/loop.js:428-435`（doneEv 携带 `aborted`）、`AgentTranscript.vue:189-192`（done 不渲染）。
影响：中止是高频动作，缺少回执时用户无法区分「已停住」与「还在收尾」，容易连点；会话切换被拦时也没有任何解释。
建议：给禁用态补 `title`/tooltip（「生成中不可切换会话」）；`send()` 收尾时若 `result.aborted`，往事件里插一条 system-notice（与 B7 的「上一轮被中断」提示同一条通道，届时合并做）。

### T-12 — 输入框固定三行、无长度上限，插话入队后输入区无就地反馈

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentPanel.vue:91-97`、`src/components/ui/UiTextarea.vue:48-64`
现象：输入框 `rows="3"` 固定高度，`UiTextarea` 自带的 `autoresize` 计算被注释掉，写长指令只能在三行小窗里滚；无 `maxlength` 也没有字数提示。busy 时点「插话」后草稿被清空，唯一的入队确认是事件流里的一条 notice —— 输入框本身没有任何变化，用户会怀疑消息丢了。
证据：**代码位置，推断，未实测** —— `AgentPanel.vue:91-97`、`UiTextarea.vue:48-64`（`calcHeight()` 定义在 `:48-52`，`:64` 调用被注释）、`agentHost.js:141-150`（入队后 push notice + 清空 draft）。
影响：长指令的编辑体验差；插话是否送达不直观（尤其队列要等下一步才执行，等待期输入区一片空白）。
建议：开启 autoresize（设 `max-h` 滚动兜底，注意别撑破 320px 侧栏）；busy 态在输入框上方留一条常驻「已入队 N 条插话，下一步执行前送达」，比一次性 notice 更可靠。

### T-13 — 事件流缺 aria-live/role，状态只靠颜色区分

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentTranscript.vue:2-7`、`AgentToolStep.vue:14,26`
现象：滚动容器没有 `role="log"` / `aria-live`，屏幕阅读器读不到新到的回答与工具结果；折叠按钮无 `aria-expanded`；工具状态与确认卡的红/绿/琥珀是唯一的区分手段（色觉障碍用户看不出「失败」与「已拒绝」的差别）。
证据：**代码位置（grep `aria-|role=` 在 agent 组件目录仅命中 `AgentMarkdown.vue:9-10` 的 heading），推断，未实测**。
影响：可访问性欠账；状态色单一通道也影响普通用户在暗色模式下的辨识。
建议：容器加 `role="log" aria-live="polite" aria-relevant="additions"`，折叠按钮补 `aria-expanded`，状态徽标加图标（已有 `riCheckLine`/`riCloseLine` 可复用）。纯属性改动，零逻辑风险。

### T-14 — 流式输出时对整段文本逐 delta 重解析，长回答可能卡顿

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `src/components/newtab/workflow/agent/AgentMarkdown.vue:97`、`AgentTranscript.vue:131-138`
现象：`blocks = computed(() => markdownToBlocks(props.raw))`，而 `raw` 每来一个 `text-delta` 就增长一次 —— 单条助手消息的解析成本随长度平方增长（n 个 delta × 每次解析整段），同一时刻事件流里可能还有多条历史消息的 computed 在依赖链上。
证据：**推断，未实测** —— `AgentMarkdown.vue:97`、`AgentTranscript.vue:131-138`（appendDelta 就地改 `last.raw`，触发对应组件重算）。本项目没有该路径的性能测量数据，先量再改。
影响：长回答 + 长会话时输入与滚动掉帧；具体阈值未知，可能只在 8K 以上的输出才显现。
建议：先做一次实测（造 5K/10K 字符的桩事件流，用 performance 记录 delta 到渲染的耗时），确认瓶颈后再选方案：按块边界增量解析、或流式期间只渲染「最后一个块」而对已完成块做 memo。未实测前不改。

### T-15 — 会话选择器与标签页弹窗的信息密度问题

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentPanel.vue:27-73`、`AgentTabPicker.vue:3,95-99`
现象：① 会话切换是一行原生 `ui-select`，占掉事件流与输入框之间整整一行，选项只显示 `title || id`（标题未生成时是一串哈希），没有时间、没有当前会话标记；② 标签页选择弹窗 `content-class="w-[32rem]"`（512px，比 320px 侧栏还宽），没有搜索/过滤，窗口分组标题直接显示内部 `windowId`（「窗口 2」「窗口 3」对用户没有意义）。
证据：**代码位置，推断，未实测** —— `AgentPanel.vue:27-73`、`AgentTabPicker.vue:3`（`w-[32rem]`）、`:95-99`（`id === 1 ? 主窗口 : 窗口 {n}`）、`agentHost.js:78-80`（`listIndex` 未带时间展示字段的消费）。
影响：会话多了以后找历史对话只能靠猜；标签页一多（几十个）没有搜索只能滚动翻；窗口编号是实现细节泄漏。
建议：会话改 popover 列表（标题 + 相对时间 + 当前项勾选），行高让给事件流；弹窗宽度改 `min(32rem, 90vw)`，顶部加搜索框按 title/url 过滤，窗口分组改用「窗口 N · 主窗口 / n 个标签页」这类可读文案。

### T-16 — 只能复制代码块，复制不了整条回答

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentMarkdown.vue:24-28`、`docs/agent-assist-tech-design.md:728`
现象：复制按钮只挂在代码块上（hover 才出现），助手整段回答没有复制入口；方案 §9.1 明确要求「assistant 文本额外渲染一个复制按钮（P0 交付判定要求“用户能复制”）」。
证据：**代码位置，与方案对照，未实测** —— `AgentMarkdown.vue:24-28`（仅 `block.type === 'code'`）、tech-design `:728`。剪贴板失败路径已有兜底（`:111-122`）。
影响：用户想把助手给出的 selector 列表/步骤说明整段搬走时，只能手动划选；320px 侧栏里划选长段落很痛苦。
建议：每条 assistant 消息 hover 时出「复制」按钮（复用现有 `copy()` 与 1500ms 「已复制」反馈），长回答补一个滚动条以免按钮被顶出可视区。

## 已批准（待排期）

（暂无）

---

## 已清

### T-17 — `detail='full'` 跳过重复项检测，有列表的页面也会被告知「未发现列表」

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04「read_page 工具设计研究」，触发点 `src/content/blocksHandler/handlerAgentReadPage.js:437`
现象：`detectRepeated` 的调用条件是 `detail==='auto'||'interactive'||'summary'`，不含 `'full'`；于是 `repeated` 恒为 `[]`，随后 `:464-469` 的 else 分支无条件输出「未发现 3 个以上结构相同的兄弟元素。这页可能不是列表页，或是虚拟列表。」——`detail='full'` 是信息量最高的档，却在**任何**页面上都断言「这页没有列表」，包括明确有 4 项卡片列表的页面。
证据：**实测** — `node .agent-test/full-detail-probe.mjs`（真 Chromium）：`detail=full → ## 重复项检测 | 未发现 3 个以上结构相同的兄弟元素…`；同一页面 `detail=summary` 正确输出 `容器 div.grid / 单项 div.card:nth-of-type(1) × 4 / 字段 title / a / price / 样例 title="鼠标"…`。
影响：模型主动要最详细信息时得到的是**假阴性断言**而非「缺这一段」—— 它可能据此放弃列表路线、改去解析 HTML 或凭空编 selector；与 `docs/agent-readpage-trace.md` §5.1 R1「列表模式是 read_page 最有价值的一段」直接冲突。
建议：把 `'full'` 纳入检测条件（一行），并把 else 分支措辞改成中性（「本档未做重复项检测」而不是「未发现」）。补 `dom.test.mjs` 回归：full 档在列表页必须给出列表段。
结论：四档白名单落地后 `full` 与其余档一样走 `detectRepeated`，DOM 断言 F1 钉住「full 档在列表页必须给出列表段」；`npm run test:dom` 26 pass。
状态：已清（2026-10-04 完成）

### T-18 — 未知 `detail` 值静默降级成「只给正文」，且同样谎报「未发现列表」

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04「read_page 工具设计研究」，触发点 `handlerAgentReadPage.js:388`（`opts.detail || 'auto'`，无白名单）
现象：content 侧不校验 `detail` 取值。传入枚举外的值（例如模型幻觉出的 `detail:'overview'`），`repeated`/`interactive`/`tables` 的条件全不成立，只剩 `:419` 的 `detail !== 'interactive'` 输出正文 —— 结果是 145 字符的观察值：一段正文 + 一句「未发现 3 个以上结构相同的兄弟元素」（页面其实有列表），没有任何「参数不被识别」的提示。
证据：**实测** — `node .agent-test/full-detail-probe.mjs`：`detail=bogus 字符=145，重复项段: ## 重复项检测 | 未发现 3 个以上结构相同的兄弟元素，交互索引:无，正文:有`。
影响：模型拿到一份「看起来成功、其实几乎什么都没有、且含错误断言」的观察值 → 大概率重试同一参数或基于空信息编造 selector。JSON schema 的 enum 挡不住模型实参（LLM 不保证遵守枚举），`loop` 与 `tools/page.js` 也都不做参数校验，content 侧是最后一道。违反 AGENTS.md「不静默降级」。
建议：content 侧白名单，未知值回一句明确错误（「detail 取值 X 不被识别，可用值：…」）让模型自纠；`tools/page.js execute` 同步做一次纯函数校验（可单测）。
结论：未知 `detail` 现在两处都明确报错（`tools/page.js normalizeReadPageArgs` 纯函数白名单 + handler 白名单），旧值只在前者映射，单测覆盖「未知值报错」。
状态：已清（2026-10-04 完成）

### T-19 — `detail='full'` 结构上装不进 8000 字符观察值上限，被砍的正是它承诺的 HTML 段

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04「read_page 工具设计研究」，触发点 `handlerAgentReadPage.js:420-428`（正文 3000）+ `:561-564`（HTML 6000）+ `src/agent/events.js:79`（8000 硬截）
现象：full 档固定输出可见正文 3000 字 + 完整 HTML 6000 字 = 9000 字，还没算页头/重复项/索引/表格，就已超过 `MAX_OBSERVATION_CHARS=8000`；`truncateObservation` 从头保留砍尾部，而 HTML 段恰好排在最后。段顺序还把「可再生的正文」放在最安全的头部、「不可再生的地址」排在后面。
证据：**实测** — `node --import ./utils/test-loader.mjs .agent-test/budget-probe.mjs`：handler 输出 9430 字符 → 截断后 8028，`truncated=true`，`## 完整 HTML` 段只剩 4621/6000 字（砍在半截）。
影响：用户显式要求 full 却拿不到承诺的 HTML；观察值尾部带 `[truncated…]` 注记，模型对「半截 HTML」的解读不确定，可能以为页面就长那样；任何档位超预算时优先丢的都是地址。
建议：见 `docs/agent-readpage-design.md` §3/§4 —— 分段预算（handler 自身 ≤6000）+ 段顺序改为「不可再生的地址在前、可再生的正文/HTML 在后」+ 超预算处显式标注省略。
结论：分段预算落地（handler 默认 6000、地址在前正文/HTML 在后），真页面 `full` 4311 字符且 `## 完整 HTML（截断）` 真的出现（`books-trace.mjs` 实测），不再从尾部被硬截。
状态：已清（2026-10-04 完成）

### T-20 — auto 档超预算砍掉交互索引、正文一字不砍（trace P5 复现）

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04「read_page 工具设计研究」复现；原始记录 `docs/agent-readpage-trace.md` §3 P5，触发点 `handlerAgentReadPage.js:489-493`
现象：`detail==='auto' && idx > maxChars` 时整块删除交互元素索引、只留一行降级提示，占大头的可见正文一个字不削。退化后的输出除重复项检测外没有任何可用 selector —— 而索引正是唯一能直接产出 selector 的那段。
证据：**实测（本轮复现）** — `node --import ./utils/test-loader.mjs .agent-test/budget-probe.mjs`：`maxChars=8000/4000 → 3505 字符，索引段有`；`maxChars=3000/2000 → 3274 字符，索引段无、降级提示有、正文仍完整（只少 231 字）`。
影响：预算一紧，模型拿到「报成功但给不出 selector」的观察值，只能重读或猜。同一问题也是 trace §5.1 R6 要修的点。
建议：按 `docs/agent-readpage-design.md` §4 砍序改（正文/明细先砍、列表模式与单条样例永不砍、砍处显式标注）；同时打通 `maxChars`（T-23），否则阈值永远是默认 8000。
结论：§4 六档砍序实现：正文/HTML → 交互索引明细 → 表格样例/接口清单，列表段与单条样例永不砍，每处砍都带 `[note: …]`；`maxChars=1200` 时列表样例仍在（DOM 断言）。
状态：已清（2026-10-04 完成）

### T-21 — 工具返回的 `{status,payload}` 信封被整体 JSON 化进观察值，内层 error 走不到错误渲染

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04「read_page 工具设计研究」（评估结构化返回契约时发现），触发点 `src/agent/loop.js:81-97` + `src/agent/events.js:71-77`
现象：`query_elements` / `test_js` / `highlight_selector` / `list_tabs` / `open_url` / canvas 系工具一律返回 `{status, payload}` 对象，而 `resultEvent` 把整个对象当作 payload 交给 `wrapObservation`，于是模型收到 `{"status":"ok","payload":"命中 3 个…"}` 的 JSON 包裹；当工具内层返回 `status:'error'` 时 loop 侧状态仍是 OK，`events.js:69` 的错误渲染分支不触发，失败信息以 JSON 形式混在「成功」观察值里，UI 工具卡也照 loop 状态渲染成绿色成功。
证据：**实测** — `node --import ./utils/test-loader.mjs .agent-test/observation-shape-probe.mjs`：字符串返回 63 字符，对象返回 100 字符（+59%，含 2 空格缩进）；内层 error 打印为 `{"status": "error", "payload": "选择器不合法：bad ["}`。
影响：① 每次工具结果多付 JSON 结构与转义的 token（长 payload 更明显）；② 模型要解析 JSON 才能发现失败，与「错误即观察值」的设计意图不符；③ 用户看到绿色成功徽标、实际工具报错；④ 任何依赖结构化返回的新能力（read_page 指纹字段，`docs/agent-readpage-design.md` §6.3）都会踩同一个坑。
建议：`loop.js resultEvent` 统一解包：`{status,payload}` → payload 作观察值正文、status 上提为事件状态（error 走 failEvent 同款渲染）。现有测试只断言 `includes`，测不出包裹，需补一条反向断言。
结论：`loop.js normalizeToolOutcome` 解 `{payload,status,...meta}`：payload 当正文、内层 `status:"error"` 升级为事件 error、meta 上提不进文本；`loop.test.js` 三段断言，`npm test` 273 pass。
状态：已清（2026-10-04 完成）

### T-22 — `detail` 各档不是单调阶梯，`interactive` 比 `summary` 少了正文，与工具注释口径矛盾

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04「read_page 工具设计研究」，触发点 `handlerAgentReadPage.js:419` vs `src/agent/tools/page.js:20-23`
现象：注释写 `summary = 正文 + 重复项检测`、`interactive = 再加交互元素索引与接口列表`、`full = 再加表格与完整 HTML`，即应当逐档累加；实现却是 `if (detail !== 'interactive')` —— interactive 档不输出正文，`auto` 又比 `interactive` 多一段正文。档位之间既不单调也和文档对不上。
证据：**实测** — `node .agent-test/full-detail-probe.mjs`：`detail=summary 正文:有`、`detail=interactive 正文:无`、`detail=auto 正文:有`（同一页面）。`dom.test.mjs` 没有覆盖这一取舍。
影响：模型按「档位越高信息越多」选 interactive，发现正文消失，可能误判页面没有正文而重读一次（多花一份完整快照，正是讨论文档 Q1 的第三个成因）；也让 prompt 里讲不清「默认档该选哪个」。
建议：并入 detail 口径改造（`docs/agent-readpage-design.md` §2 的 `probe|addresses|content|full` 单调阶梯 + 白名单），或最小化把 `:419` 改成恒输出正文并接受成本上升。二选一，别停在现状。
结论：detail 改为单调四档 `probe/addresses/content/full`（旧值映射只存在于 `normalizeReadPageArgs` 一处），工具注释与实现同一口径，`dom.test.mjs` 档位断言全部改齐。
状态：已清（2026-10-04 完成）

### T-23 — `maxChars`/`budgetNodes` 在读页链路上不可达，runtime 无法按余量压预算

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04「read_page 工具设计研究」，触发点 `src/agent/index.js:184`（`readPage: (detail) => …`）、`:121-128`（消息体只有 `{type, detail}`）、`src/content/index.js:323-325`（只取 `data.detail`）
现象：handler 接受 `detail/maxChars/budgetNodes` 三个入参（`handlerAgentReadPage.js:386-390`），但整条链路只透传 `detail`，另两个永远取默认值；handler 里按预算降级的分支在生产中只能按固定 8000 字触发。
证据：**代码位置（三处签名逐一核对，静态确认）**；反向实测：直接调 `window.__agentReadPage({detail:'auto', maxChars:3000})` 能触发降级（`budget-probe.mjs`）—— handler 认参数，是链路不给。
影响：`docs/agent-readpage-design.md` §4 的分段预算落不了地；降级阈值无法按页面大小或上下文余量调整；也解释了为什么 T-20 的复现必须绕过生产链路直接调 handler。
建议：`readPageFromTab(tab, {detail, maxChars})` + content 分发透传 + `toolCtx.readPage` 收对象（三处，约 10 行），同步 `tools/index.test.js:101-115` 的透传断言。
结论：`maxChars`/`budgetNodes` 全链路透传（`readPageFromTab` → content 分发 → handler），schema 校验 400–8000、默认 6000；`tools/index.test.js` 透传断言同步。
状态：已清（2026-10-04 完成）

### T-24 — `elideStaleObservations` 写了测了没接线，12 步单轮照样堆 12 份快照

类型：bug
登记日期：2026-10-04
来源：转入 `docs/agent-context-discussion-2026-10-04.md` §1「根因三」与汇总表 P0a（2026-10-04 讨论会话产出，当时只写进讨论文档、未进本登记表）
现象：`window.js:101` 的陈旧页面快照剔除，全仓只有定义和 `window.test.js:81/104` 两个测试，生产链路 `loop.js:321` 的 `applyTokenBudget(buildWireMessages(...))` 与 `wire.js` 都没调用它 —— 技术方案 §4.2 写的是「在 buildWire 时做」，实现漏了。
证据：沿用前次**实测**（讨论文档，未在本轮复跑）：接上后 12 步单轮 124,769 → 12,145 token（省 90%）；本轮 `grep elideStaleObservations src/agent` 复核调用点：仅 `window.js:101` 定义 + `window.test.js` 两处，无生产调用。
影响：单轮超过 3 步即越过 25,600 阈值（讨论文档 Q1 表格），`applyTokenBudget` 又因 T-25 的缺口一条不丢，超标请求直接发给 provider → 400。当前上下文爆炸的头号成因。
建议：`loop.js:321` 改成 `applyTokenBudget(elideStaleObservations(buildWireMessages(history, {system})), {contextWindow})`（一行）+ 补一条 loop 级断言：历史里旧的 `<untrusted_page_content>` 观察值必须被换成 `STALE_MARKER`、只保留最后一组。
结论：`loop.js` 在 `buildWireMessages` 后接 `elideStaleObservations`，接线测试断言旧 `<untrusted_page_content>` 观察值被换成占位、只留最后一组；`npm test` 273 pass。
状态：已清（2026-10-04 完成）

### T-25 — `dropOldestTurn` 在单轮多步里结构性失效，`window.test.js:156` 的断言恰好掩盖了它

类型：bug
登记日期：2026-10-04
来源：转入 `docs/agent-context-discussion-2026-10-04.md` §1「根因四」（P0b），触发点 `src/agent/window.js:161-184`、`src/agent/window.test.js:156-161`
现象：`applyTokenBudget` 的丢弃单元是 `(user, assistant, 其后连续的 tool*)` 整组，且硬保最后一个 user。单轮 send 的 wire 全轮只有 index=1 一个 user，循环第一个候选 `i >= lastUserIdx` 直接 break → 返回 null → `dropped=0`。一轮 12 步攒的 12 份页面快照在同一个「轮」里，**没有任何可丢的单元**。`window.test.js:156` 的用例（`[sys, user(500k), asst]` → `assert.equal(r.dropped, 0)`）把 `dropped===0` 写成预期 —— 对它自己的 fixture 是对的，但没有任何用例覆盖「单轮内多个 tool 观察值超预算」，缺口因此测不出来。
证据：**代码位置（逐行核对）**；fixture 自洽性本轮确认：`[sys, user, asst]` 的 `lastUserIdx=1`，`i=1` 即 `i >= lastUserIdx` → break。12 步 124,769 token 的实测见讨论文档 Q1（沿用，未复跑）。
影响：与 T-24 叠加时两层防线全破 —— 陈旧快照不剔、整轮又丢不掉，超额 4.8 倍的请求直接打到 provider 报 400；用户看到的是「助手报错」，实际是预算层无路可走。
建议：给 `dropOldestTurn` 补单轮内降级路径（不越过最后一个 user 的前提下，从最旧的 assistant+tool* 组开始丢，或对 tool 观察值做占位替换）；**新增**一条单轮多 tool 的用例 —— 别改 `:156` 那条，它自己的语义是对的，要在它旁边补覆盖不到的那半。
结论：`window.js` 补单轮内两级丢弃（`lastUserIndex` / `dropOldestStepInLastTurn`）+ 2 条新用例，`dropped===0` 的旧断言不再掩盖单轮多步缺口。
状态：已清（2026-10-04 完成）

### T-05 — 删除会话一键即删，没有二次确认

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `src/components/newtab/workflow/agent/AgentPanel.vue:64-72`
现象：面板上的垃圾桶按钮直接 `emit('delete-session')`，宿主立即 `runtime.deleteSession(id)` → `sessionStore.remove(id)`，整段事件历史被删除且不可撤销。按钮与「新建会话」相邻、图标相似，误触成本极高；busy 之外没有任何拦截，也没有删除对象的标题回显。
证据：**代码位置，推断，未实测** —— `AgentPanel.vue:64-72`（无确认直接 emit）、`agentHost.js:113-121`、`src/agent/index.js:565-569`（`sessionStore.remove` 无前置确认）；全仓未见该路径上的 `UiDialog` 调用。
影响：任何一次误点都永久丢失该会话的全部对话与工具执行记录（会话是唯一的历史载体，CONTEXT.md「会话」条），最坏是用户辛苦跑出来的 selector 结论再也找不回来。
建议：复用项目既有 `UiDialog` 二次确认（标题回显会话 title + 「不可撤销」），并把删除按钮从「新建」旁边移进会话下拉/更多菜单，降低误触概率。
结论：删除前过 `UiDialog` 二次确认（`agentHost.js deleteAgentSession`）：标题「删除这个会话？」、正文回显会话 title + 「删除后无法恢复」、`okVariant: 'danger'`、`async: true`；确认回调里**再核一次** `agent.busy` 与 id 是否仍是当前会话（弹窗期间可能又开跑一轮，删在途会话会被那轮 save 回写成幽灵会话），不满足则返回 false 让弹窗留着。文案 `workflow.agent.session.deleteConfirm*` 已补 en/zh，`npm run check:i18n` 通过。原建议中「把删除按钮移进下拉/更多菜单」**未采纳**：与「新建」并排放着可发现性更好，确认门已把误触代价降下来，等实际用过再评估。
状态：已清（2026-10-04 完成）

### T-26 — 会话切换下拉取 `$event.target.value` 抛 TypeError，选了毫无反应

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04「完善会话切换与删除入口」，触发点 `src/components/newtab/workflow/agent/AgentPanel.vue:35`
现象：会话下拉的 change 处理写的是 `emit('select-session', $event.target.value)`，而 `UiSelect` 的 `change` emit 出去的是**字符串 value**（`UiSelect.vue:76-84`），不是原生 DOM 事件 —— `$event.target` 为 `undefined`，再读 `.value` 直接抛 TypeError，选了历史会话毫无反应。全仓 92 处 `<ui-select>` 用法里只有这一处这么写，其余全走 `v-model`。用户侧的表现就是「只有新建，没有切换」：建了第二个会话就再也回不去第一个。
证据：**实测（源码 + 构建产物，未在真机页面手工复现 —— 本仓没有组件测试基建）** —— `UiSelect.vue:76-84`（`emit('change', value)`）与 `AgentPanel.vue:35` 对不上；修复后重新 `npm run build`，`build/newtab.bundle.js` 里 `$event.target` **0 命中**，编译产物为 `function u(e){e&&o("select-session",e)}`（直接收 value、空值忽略）。
影响：多会话的核心入口之一失效。两个宿主（独立助手页、编辑器侧栏）同样中招；配合 T-05（当时删除还没有确认），用户的实际处境是只能新建、切不回去、删又不敢删。
建议：（已修）改 `@change="onSelectSession"`，处理器直接收字符串 value 并忽略空串占位项。
结论：修复落地，并把入口一并补齐 —— 选项文案从 `title || id`（标题未生成时是一串 UUID）改为「标题 · MM-DD HH:mm」+ 当前项标「（当前）」，拼装逻辑抽成 `sessions.js:sessionOptionLabel` 由 `sessions.test.js` 两条用例钉住（缺时间不出半截分隔符、非法时间戳当没时间）；切换侧新增 `assembly.test.js` 5 条 runtime 契约用例（切会话读回各自历史、切不存在的会话不炸、删当前/删非当前的边界、`newSession` 后还能切回）。`npm test` 280 pass / 0 fail（原 273），`npm run check:i18n` 通过，`npm run lint` 仍为存量 2 error / 10 warning，`npm run build` 成功。
状态：已清（2026-10-04 完成）

