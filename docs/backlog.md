# 待办登记（会话捕获）

对话中发现的 **bug**、用户提出的 **改进** 与 **新功能** 一律先落在这里，由用户审核后再动代码。流程见 `AGENTS.md`「发现即登记」。

> 编号分工：**T 编号** = 全仓库范围的会话捕获；**B 编号** = 内置助手功能自身的已知欠账（原 `docs/agent-backlog.md`，2026-10-04 合并进本文件，编号与格式沿用，见文末「B 编号」区）。两区不混写。

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
状态：待审核

### T-07 — 工具卡把 `<untrusted_*>` 包装标签原样摊给用户看

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `src/components/newtab/workflow/agent/AgentToolStep.vue:25-27`
现象：展开工具卡时，`step.observation` 是 `wrapObservation()` 的产物 —— 用户会看到 `<untrusted_page_content>`、`</untrusted_page_content>` 和 `[note: 观察值超预算已截断…]` 这类字样夹在页面正文里。这些标签是给模型看的提示注入防护，不是给人看的。
证据：**代码位置，推断，未实测** —— `AgentToolStep.vue:25-27`（直接渲染 observation）、`src/agent/loop.js:81-97`（resultEvent 一律走 `wrapObservation`）、`src/agent/events.js:55-88`（标签与截断注记在此处拼上）。
影响：首次展开工具结果的用户会以为是乱码或漏洞；「页面正文」与「工具自述」在视觉上没有分界，读长观察值很费劲。
建议：**只在展示层剥离**外层 `untrusted_*` 标签再渲染（按 `UNTRUSTED_WRAPPER_TAGS` 白名单匹配，保留截断注记并改成人话），`events.js` 的包装逻辑一行不动 —— 模型侧必须继续看到标签。
状态：待审核

### T-08 — 目标页条缺 favicon、pin/自动态与失效态

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `src/components/newtab/workflow/agent/AgentPanel.vue:4-22`、`docs/agent-assist-tech-design.md:127-132`
现象：目标页一行只有一个地球图标 + 标题 + 右侧「选择目标页」。没有 favicon、不显示这一页是「用户手选固定」还是「自动解析」、也不显示目标页是否还活着：tab 被关闭或发生跳转后，头部依旧显示旧标题旧 URL，唯一的告知是事件流里一条写给模型看的系统提示（「目标页已经关闭…」），用户很容易以为助手还在看原页面。方案 §3.2 承诺的 favicon + 切换下拉 + `tabs.onRemoved` 失效处理均未落地。
证据：**代码位置，推断，未实测** —— `AgentPanel.vue:4-22`（无 favicon/无状态位）、`src/agent/index.js:250-286`（preStepNotice 只产出模型侧 notice，不回 UI）、`:231-239`（只有 `focus_tab` 会发 `agent:target-tab`）；`grep onRemoved src/` 仅命中 `workflowEngine` 与 `service/browser-api`，agent 侧无监听。
影响：这是面板上最关键的一行信息（用户必须知道模型在看哪个页），失效不提示会让整轮结论基于错误前提，且用户无从发现。
建议：① 加 favicon（`chrome://favicon` / 扩展内等价取法）与「固定 / 自动」小徽标；② 每步预检发现 tab 已关或 origin 漂移时，同步把状态写进头部（红/琥珀态 + 「重新选择」按钮），事件流里那条 notice 保留给模型；③ 变更处发一个宿主级回调而非新增事件种类，避免污染事件历史。
状态：待审核

### T-09 — 一轮对话缺运行时可见性：步数、模型名、轮次分隔、token 位置

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentTranscript.vue:189-192`、`AgentPanel.vue:46-54,162`
现象：① `agent:start` / `agent:done` 被显式忽略，多轮对话之间只有用户气泡做分界，长会话回看时分不清哪段是哪一轮；② 不显示这一轮跑到第几步（`MAX_STEPS=12` 用尽即收尾，用户看不出「快到上限」）；③ 面板不显示正在用哪个模型（`config` 只用来判断 apiKey 是否存在）；④ token 用量是 10px 灰字角标，且无上下文窗口水位。
证据：**代码位置，推断，未实测** —— `AgentTranscript.vue:189-192`（start/done/target-tab 一律丢弃）、`src/agent/loop.js:30`（`MAX_STEPS = 12`）、`:282`（步循环）、`:428-435`（done 事件带 `aborted`/`usage`）、`AgentPanel.vue:46-54`（`text-[10px]` usage）、`:162`（config 仅取 apiKey）。
影响：卡在工具循环里的那一轮，用户只看到工具卡不停翻，没有任何「还剩多少余量」的信号；换模型/换 provider 后也无从确认当前答案来自哪个模型。
建议：`agent:start` 渲染成一条轮次分隔线（含时间戳需给事件补字段，或用会话侧时间）；工具卡区域加「第 n/12 步」进度；头部或会话条显示 `config.model`；usage 提到会话条 tooltip 之外，再加一条上下文水位（usage.input / contextWindow）。
状态：待审核

### T-10 — 空态只有一句话，缺示例问法与「本宿主开放哪些工具」的说明

类型：新功能
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentTranscript.vue:8-13`、`src/newtab/pages/Agent.vue:46`
现象：空态仅渲染 `workflow.agent.empty` 一句文案。没有可点击的示例问法，也不告知这个宿主开了哪些工具组 —— 独立助手页 `enabledGroups: ['page','context','tab']`（无画布），编辑器侧栏才开放 `canvas` 组，两侧文案完全一样，用户无法预期「这里能不能让它加块」。
证据：**代码位置，推断，未实测** —— `AgentTranscript.vue:8-13`、`Agent.vue:46`、`workflows/[id].vue` 侧栏宿主（canvas 组开放）、`CONTEXT.md`「工具组」「宿主」条。
影响：首次进入的用户不知道能问什么，也不知道能力边界；在独立页让助手改画布只会得到工具不存在的失败回执。
建议：空态放 3~4 个可点击示例（点击即填入输入框，不自动发送），下面加一行工具组徽标（读页面 / 变量与块 / 标签页 / 画布）。文案按宿主分别给，`AgentPanel` 增加一个 `capabilities` prop 或由宿主传入。
状态：待审核

### T-11 — busy 期间按钮静默禁用；中止后没有任何回执

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentPanel.vue:33,58,67`、`src/composable/agentHost.js:156-172`
现象：① busy 时「选择会话 / 新建 / 删除」三个按钮直接 `disabled`，不带 tooltip 也不给理由，用户点了没反应只会觉得卡；② 点停止后 `busy` 翻回 false、按钮复原，但屏幕上没有「已停止生成」的回执 —— loop 收尾事件里的 `aborted: true` 被宿主丢弃。
证据：**代码位置，推断，未实测** —— `AgentPanel.vue:33,58,67`（disabled 无 title）、`agentHost.js:156-172`（result 只读 `sessionId`/`usage`）、`src/agent/loop.js:428-435`（doneEv 携带 `aborted`）、`AgentTranscript.vue:189-192`（done 不渲染）。
影响：中止是高频动作，缺少回执时用户无法区分「已停住」与「还在收尾」，容易连点；会话切换被拦时也没有任何解释。
建议：给禁用态补 `title`/tooltip（「生成中不可切换会话」）；`send()` 收尾时若 `result.aborted`，往事件里插一条 system-notice（与 B7 的「上一轮被中断」提示同一条通道，届时合并做）。
状态：待审核

### T-12 — 输入框固定三行、无长度上限，插话入队后输入区无就地反馈

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentPanel.vue:91-97`、`src/components/ui/UiTextarea.vue:48-64`
现象：输入框 `rows="3"` 固定高度，`UiTextarea` 自带的 `autoresize` 计算被注释掉，写长指令只能在三行小窗里滚；无 `maxlength` 也没有字数提示。busy 时点「插话」后草稿被清空，唯一的入队确认是事件流里的一条 notice —— 输入框本身没有任何变化，用户会怀疑消息丢了。
证据：**代码位置，推断，未实测** —— `AgentPanel.vue:91-97`、`UiTextarea.vue:48-64`（`calcHeight()` 定义在 `:48-52`，`:64` 调用被注释）、`agentHost.js:141-150`（入队后 push notice + 清空 draft）。
影响：长指令的编辑体验差；插话是否送达不直观（尤其队列要等下一步才执行，等待期输入区一片空白）。
建议：开启 autoresize（设 `max-h` 滚动兜底，注意别撑破 320px 侧栏）；busy 态在输入框上方留一条常驻「已入队 N 条插话，下一步执行前送达」，比一次性 notice 更可靠。
状态：待审核

### T-13 — 事件流缺 aria-live/role，状态只靠颜色区分

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentTranscript.vue:2-7`、`AgentToolStep.vue:14,26`
现象：滚动容器没有 `role="log"` / `aria-live`，屏幕阅读器读不到新到的回答与工具结果；折叠按钮无 `aria-expanded`；工具状态与确认卡的红/绿/琥珀是唯一的区分手段（色觉障碍用户看不出「失败」与「已拒绝」的差别）。
证据：**代码位置（grep `aria-|role=` 在 agent 组件目录仅命中 `AgentMarkdown.vue:9-10` 的 heading），推断，未实测**。
影响：可访问性欠账；状态色单一通道也影响普通用户在暗色模式下的辨识。
建议：容器加 `role="log" aria-live="polite" aria-relevant="additions"`，折叠按钮补 `aria-expanded`，状态徽标加图标（已有 `riCheckLine`/`riCloseLine` 可复用）。纯属性改动，零逻辑风险。
状态：待审核

### T-14 — 流式输出时对整段文本逐 delta 重解析，长回答可能卡顿

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `src/components/newtab/workflow/agent/AgentMarkdown.vue:97`、`AgentTranscript.vue:131-138`
现象：`blocks = computed(() => markdownToBlocks(props.raw))`，而 `raw` 每来一个 `text-delta` 就增长一次 —— 单条助手消息的解析成本随长度平方增长（n 个 delta × 每次解析整段），同一时刻事件流里可能还有多条历史消息的 computed 在依赖链上。
证据：**推断，未实测** —— `AgentMarkdown.vue:97`、`AgentTranscript.vue:131-138`（appendDelta 就地改 `last.raw`，触发对应组件重算）。本项目没有该路径的性能测量数据，先量再改。
影响：长回答 + 长会话时输入与滚动掉帧；具体阈值未知，可能只在 8K 以上的输出才显现。
建议：先做一次实测（造 5K/10K 字符的桩事件流，用 performance 记录 delta 到渲染的耗时），确认瓶颈后再选方案：按块边界增量解析、或流式期间只渲染「最后一个块」而对已完成块做 memo。未实测前不改。
状态：待审核

### T-15 — 会话选择器与标签页弹窗的信息密度问题

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentPanel.vue:27-73`、`AgentTabPicker.vue:3,95-99`
现象：① 会话切换是一行原生 `ui-select`，占掉事件流与输入框之间整整一行，选项只显示 `title || id`（标题未生成时是一串哈希），没有时间、没有当前会话标记；② 标签页选择弹窗 `content-class="w-[32rem]"`（512px，比 320px 侧栏还宽），没有搜索/过滤，窗口分组标题直接显示内部 `windowId`（「窗口 2」「窗口 3」对用户没有意义）。
证据：**代码位置，推断，未实测** —— `AgentPanel.vue:27-73`、`AgentTabPicker.vue:3`（`w-[32rem]`）、`:95-99`（`id === 1 ? 主窗口 : 窗口 {n}`）、`agentHost.js:78-80`（`listIndex` 未带时间展示字段的消费）。
影响：会话多了以后找历史对话只能靠猜；标签页一多（几十个）没有搜索只能滚动翻；窗口编号是实现细节泄漏。
建议：会话改 popover 列表（标题 + 相对时间 + 当前项勾选），行高让给事件流；弹窗宽度改 `min(32rem, 90vw)`，顶部加搜索框按 title/url 过滤，窗口分组改用「窗口 N · 主窗口 / n 个标签页」这类可读文案。
状态：待审核

### T-16 — 只能复制代码块，复制不了整条回答

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentMarkdown.vue:24-28`、`docs/agent-assist-tech-design.md:728`
现象：复制按钮只挂在代码块上（hover 才出现），助手整段回答没有复制入口；方案 §9.1 明确要求「assistant 文本额外渲染一个复制按钮（P0 交付判定要求“用户能复制”）」。
证据：**代码位置，与方案对照，未实测** —— `AgentMarkdown.vue:24-28`（仅 `block.type === 'code'`）、tech-design `:728`。剪贴板失败路径已有兜底（`:111-122`）。
影响：用户想把助手给出的 selector 列表/步骤说明整段搬走时，只能手动划选；320px 侧栏里划选长段落很痛苦。
建议：每条 assistant 消息 hover 时出「复制」按钮（复用现有 `copy()` 与 1500ms 「已复制」反馈），长回答补一个滚动条以免按钮被顶出可视区。
状态：待审核

### T-31 — `npm run lint` 因存量 `src/lib/dayjs.js` 恒红，提交前检查形同虚设

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 修完 T-27/T-06/B5 跑 `npm run lint` 收尾，触发点 `src/lib/dayjs.js:11:25`
现象：`npm run lint` 固定报 `11:25 error Insert ';' prettier/prettier`，进程以非 0 退出，全仓 lint **永远是红的**。于是「提交前跑 lint」这条流程无法通过，真冒出来的新 error 会被淹没在「反正本来就有 error」里 —— 这次本批 7 个文件的干净状态只能靠逐个 `npx eslint <file>` 才确认得下来。
证据：**实测** —— `npm run lint` 输出 `1 problem (1 error, 10 warnings)`；`npx eslint src/lib/dayjs.js` 单跑同样报该条；`git diff --stat src/lib/dayjs.js` **为空**（文件与 HEAD 一致，非本次改动引入，也不是谁的在途改动）。这条存量在 T-26 的结论里被记过一次（当时是 2 error / 10 warning），但一直没登记成条目。
影响：`npm run lint` 永远 exit 1，人和 CI 都没法拿它当门禁；lint-staged 只对 staged 文件跑 `eslint --fix`，所以日常提交暂不被卡 —— 一旦有人把门禁改成全量检查，会立刻被这条存量卡住。
建议：`npx eslint --fix src/lib/dayjs.js`，约 1 行改动、1 分钟即可转绿。**另 10 个 warning（`no-console` 等，散布在 `[id].vue`、`App.vue` 等处）建议单独处理**，别和这条混在一起，否则改动面失控。
状态：待审核

### T-34 — 会话只在收尾落盘，转中卡死/刷新即整轮丢失，卡住的轮次无法事后诊断

类型：bug
登记日期：2026-10-04
来源：同上 dump 分析，触发点 `src/agent/index.js:546-559`（save 仅在 send 收尾）、`sessionStore.save` 全仓仅两处调用（`:549`/`:567`）
现象：`sessionStore.save` 只在 `send` 正常返回后执行（含 abort 收尾）。转中（步骤之间）没有任何检查点——用户在转中刷新页面、或转中永久挂起后被迫刷新，**该轮所有事件（含工具参数与观察值）全部丢失**。dump 实证：三个会话只有 turn-start 的 3 个事件（start/user-message/target-tab）后再无下文；用户报「同意后卡住」的那一轮在 dump 里完全缺席——不是没发生，是没落盘。这也让「卡住」类问题事后无法诊断：现象发生了，数据没了。
证据：**实测（dump 分析）** —— `agent_session_1d1c9a1e` 与 `agent_session_null`（12:50）各只有 3 个事件；`594b95db`（12:07）在 test_js 报错 + read_page 后戛然而止；对照 `94cd04e9`（12:52）428 个事件完整（两轮都走完了收尾 save）。save 调用点 grep 全仓仅 `index.js:549/567` 两处，均在 send 返回后。
影响：① 用户损失：卡死/误刷新即丢整轮对话与工具结果；② 诊断损失：所有「卡住」类问题都拿不到现场，只能靠用户肉眼转述。
建议：`record()`（loop 的入史口）改为节流落盘——每步结束（tool-result 入史后）调一次 `saveSession`，或至少 debounce 1s；转中 save 失败不影响轮（catch 吞掉但 console.warn）。注意与 B1（标题回写覆盖事件）一起修：B1 的「整记录覆盖」风险在增加落盘频率后会更容易触发，两处应同批处理（patch 单字段或带事件数校验）。约 1-2 小时。
状态：待审核

### T-47 — agent-architecture.html 的代码快照与行号仍停在 T-29/T-30 之前，与页脚「行号均为实测引用」的承诺不符

类型：bug（文档与代码不一致）
登记日期：2026-10-05
来源：会话 2026-10-05 更新该文档（T-02/T-39 的结论要写进去）时逐块核对源码发现，触发点 `docs/agent-architecture.html` §13「写类工具的 MAIN world 执行」的两个代码块。
现象：§13 里 `runInPage` 标着 `// src/background/index.js:579-592` 且是裸 `try/catch`；`agentEvalInPage` 标着 `// src/background/index.js:538-555 —— test_js 的核心`，代码是 `new Function('return (' + src + ')')` + `fn()()` —— 正是 T-29 判死的那个必炸形状。
证据：**实测** —— `grep -n "function runInPage|function agentEvalInPage|raceTimeout" src/background/index.js` 输出：`12: import { agentEvalInPage, raceTimeout } from '@/agent/agentEvalInPage'`、`528: const AGENT_PAGE_TIMEOUT_MS = 15000`、`544: async function runInPage(...)`、`556: return raceTimeout(exec, AGENT_PAGE_TIMEOUT_MS, {`。即 `runInPage` 行号与实现都已变（T-30 套了超时），`agentEvalInPage` **根本不在这个文件里**（T-29 抽成了 `src/agent/agentEvalInPage.js`，且 T-38 改成双形式求值）。另有行号未复核：§13 通道表的处理端（`background/index.js:603/656/721`）、§06 流程分解（`loop.js:158-211` 等）。**文档页脚自称「代码行号与函数签名均为实测引用」，现状与这句不符。**
影响：这份 117KB 的 html 是本仓的架构入口（AGENTS.md 与 CONTEXT.md 都指向它）。照着它读代码的人（或 agent）会去找一个不存在的函数位置，或把已修掉的 `fn()()` 当成现状 —— 与「把有实测依据的偏离纠正回旧方案」同类的风险，方向相反。
建议：**只复核不重写** —— 按 §13 → §06 → §08 顺序逐个代码块对源码核行号与函数体，更新后在页脚加一行「最后核对于 YYYY-MM-DD」。整篇重写风险大于收益（文档 117KB，且大部分段落仍准确）。本条已在同一轮更新过 §07（确认门快照、四条路径表、T-02/T-27 状态）与 §13（超时分层说明），**剩下的代码快照未动，等审核**。代价约 1 小时。
状态：待审核

### T-43 — runtime 闭包三块状态机没有 seam、零断言覆盖

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 架构评审（`architecture-review-20261005-0141.html` 候选 1），触发点 `src/agent/index.js:359`（`createAgentRuntime`）
现象：`src/agent` 的规矩是「只有 `index.js` 能碰浏览器 API，其余纯函数好让 `node --test` 直接覆盖」，但所有跨进程接线都倒进了这一个文件。`createAgentRuntime`（`:359` 至文件末 `:762`，约 404 行）持有 11 个可变状态，内部缠着三件事：目标页身份状态机（pin 写入 / `focus_tab` 切换 / origin 漂移判定 / 指纹比对，`:370-533`）、会话收尾（usage 累加 / 剪 THINKING / 两份 save 对象 / 标题 fire-and-forget，`:574` 起）、`toolCtx` 字面量拼装（`:391-463`）。
证据：**实测** —— 状态声明逐个核对落在 `:370 targetTab`、`:376 pins`、`:377 focusedTabId`、`:379 lastNoticeKey`、`:382 lastRead`、`:384 fpNoticeKey`、`:386 fpCheckPending`、`:388 currentOnEvent`、`:536 activeAgent`、`:540 currentSessionId`、`:545 instructionQueue`，恰好 11 个。零覆盖同样实测：`Select-String src/agent/*.test.js 'preStepNotice'` 命中 4 处全在 `loop.test.js:729-765`，且 `:733` 自带注释「makeAgent 不支持 preStepNotice，这里直接手动建」—— 测的是传入的 fake，不是 runtime 里那份实现。`tabs.js:78` 写 `typeof ctx.pins === 'function' ? ctx.pins() : ctx.pins` 同时兼容两种形态，说明这个 interface 两边都没人拥有。
**来源文档的数字偏大，须按实测取值**：该评审称 `index.js` 861 行 / `createAgentRuntime` 474 行 / `assembly.test.js` 631 行 / 全目录 43 文件 10,080 行（含 2,700 测试行）；实测为 **762 / 约 404 / 613 / 54 文件 9,234 行（含 4,783 测试行）**。它的行号引用逐条核对**全部准确**（`:370-389` `:391` `:471` `:552` `:574` `:119` `tabs.js:78` `window.js:114,125` `loop.js:153` `events.js:61` `tools/index.js:152,166` 均对上），膨胀的只是汇总统计——结论成立，规模比它说的小。
影响：T-33 / T-39 / B1 / T-34 / T-35 这一串真机 bug 的老家都在这一层，再改动概率与改动难度同时最高，却零断言守护。
建议：分三步，**建议顺序 ② → ① → ③**。② `turnRecord.js`（usage 累加 / 剪 THINKING / 单一 save 对象）—— T-34、T-35、B1 三条已登记 bug 全落在同一段 save 代码上，先抽出记录构造可让它们共用一个入口（注意 T-35 与 B1 已要求「闭包捕获 sessionId + 只 patch title」，抽出来正好一次做对）；① `targetState.js`（pin / focusedTabId，三条 advisory 文案变纯函数返回值）；③ `createToolContext()` 固定形状，`tabs.js:78` 随之简化。三步均为「搬出去 + 补断言」，不改落盘格式、不碰任何 ADR。
状态：待审核

### T-44 — 「这条观察值是不是页面快照」有三处互不知情的判定，靠字符串对齐

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 架构评审候选 2，触发点 `src/agent/window.js:114`（文本前缀嗅探）
现象：同一个判断有三份独立实现，彼此靠**字符串**而非数据对齐：`loop.js:153` 用 `tool.group === 'page'`（工具对象只在执行那一刻存在）；`events.js:61` 用 `outcome.wrap === 'untrusted_page_content'`（上一层塞进来的字符串）；`window.js:114/125` 用 `m.content.trimStart().startsWith('<untrusted_page_content')`（已混进 content 的文本前缀）。第三处的存在是被持久化逼出来的 —— `TOOL_RESULT` 落盘再读回时事件里只剩 `name`，工具对象连同它的 group 一起没了。
证据：**静态** —— `grep -rn "group === 'page'" src` 仅 `loop.js:153` 一处；`untrusted_page_content` 在实现里的命中点为 `untrusted.js:28`、`events.js:61-62`、`loop.js:153-154`、`window.js:114,125`。持久化代价：**实测** `sessions.js:6` 记录会话以整条 `{events}` 落 IndexedDB，`cropToTurns` / `titleFromEvents` 直接吃这个数组，所以改字段形状必然要一条旧记录 fallback。测试侧 `window.test.js:21` 手工拼 `'<untrusted_page_content>\n' + t` 构造输入，是在复述实现细节。
影响：新增一类「也该被陈旧压缩」的观察值要同时改 4~5 处（group→wrap 映射、wrap 白名单、`window.js` 前缀嗅探、`untrusted.js` 标签登记、`prompt.js` 措辞），漏改任何一处不报错、只静默失效。**排期注意：本条与 T-34 / T-35 / B1 争同一批文件**（都要改会话记录的写入路径），评审未注意这层耦合，排在它们之后做更省事。
建议：把「观察值形态」提升成跟着事件走的一等字段（工具定义上声明一次，或在 `tools/index.js` 做一处 `group → observationKind` 映射作为唯一真源），`loop` 挂到 `TOOL_RESULT` 上、`wire` 写进消息 meta 而不混进 content、`elideStaleObservations` 按 meta 判定。`untrusted_*` 标签仍是安全边界，继续按 `untrusted.js` 登记 —— 两件事职责不同，不要合并。必须同批定下旧会话记录的 fallback 规则（按 `name` 判定或一律当 value），不能「跑不出来再说」。
状态：待审核

### T-45 — `findTool` / `requiresConfirmation` / `collectPromptFacts` 的工具表参数默认回落到全量 TOOLS

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 架构评审候选 5，触发点 `src/agent/tools/index.js:152`
现象：三个函数的工具表参数都写成默认参数，回落到模块级全量 `TOOLS`。而生产路径永远传的是按 `enabledGroups` 过滤后的子集 —— ADR-0001 明确要求独立助手页绝不能让模型知道画布工具存在。于是「忘了传参」的失败模式是：系统提示里悄悄多出 `add_block / update_block / list_canvas`，模型在独立助手页调用后拿回一句「没有这个工具」，不抛错、不报警。
证据：**实测** —— 默认参数确认存在于 `tools/index.js:152 findTool(name, tools = TOOLS)`、`:166 requiresConfirmation(name, tools = TOOLS)`、`index.js:119 collectPromptFacts(tools = TOOLS)`。**今天生产链路无人踩坑**：`index.js:622` 构造 `activeTools`，`:645`、`:646` 与 `loop.js:199` 都显式传入。属留给未来第二个消费者的坑，不是现行 bug。
影响：一旦新增第二个消费者漏传参数，独立助手页会静默暴露画布工具、违反 ADR-0001，症状是模型「莫名调用不存在的工具」，排查成本高。另注：**`index.test.js:83-85/102-103/308/319` 六处测试依赖这个默认值**（故意不传参），改必填时这 6 处要一并改成显式传全量表，否则直接红。
建议：把默认参数改成必填（缺参即 throw），或在 `createAgentRuntime` 里一次性绑定。代价约 10 行，**搭 T-43 的车一起做最划算**，不建议单独立项。
状态：待审核

### T-46 — `buildWireMessages → elide → budget` 的顺序知识留在调用方

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 架构评审候选 4，触发点 `src/agent/loop.js:408-411`
现象：每步 loop 都要手写三层嵌套 `applyTokenBudget(elideStaleObservations(buildWireMessages(history, {system})), {contextWindow})`，且顺序不能反（`:406-407` 的注释记着这是 T-24 的教训）。接口是一串函数组合，「怎么组合」是只有实现才知道的知识却写在调用方，下一个调用点会重新踩一遍。
证据：**静态** —— `loop.js:406-411` 的注释与嵌套调用确认；三个诊断数字（`estimated` / `threshold` / `dropped`）目前只进 `log('budget')`，测试断言不到。**性能理由已被实测否掉**（该实测为评审文档所载，本轮未复跑）：合成 12 步 × 8K 快照跑完整管线 20 次取平均，单次 0.10–0.13 ms，`estimateTokens` 单次 0.036 ms，且 elide 先出手把估算压到 8.9K、远低于 25.6K 阈值，压根进不了 while 循环。
影响：真实危害小，纯接口洁癖。
建议：若将来要动，只动接口 —— 一个 `buildModelView({history, system, contextWindow})` 返回 `{messages, diagnostics}`，顺序收进实现、诊断数字变成可断言的返回值。**本轮不建议排期**，登记备查。
状态：待审核

## 已批准（待排期）

（暂无）

---

## B 编号 — 内置助手欠账（原 `docs/agent-backlog.md`，2026-10-04 合并）

每项一条：编号、来源、内容、为什么缓、重开的触发条件。修掉的项目移到本区文末「已清」。新增欠账先登记再排期，不允许「口头知道但不记录」。


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

来源：`docs/agent-multi-session-plan.md` P3。
内容：newtab/助手页被关 = loop 消失；重开页面时若发现当前会话末尾有未收尾事件（悬空 tool_calls 已被 wire 净化，可安全续接），给一条 system-notice 告知用户。
缓决原因：净化已保证不炸，只是缺提示。
重开条件：与 P3 插话/会话 UI 下一轮迭代一起做。
状态：待排期（小）。

### B8 — 编辑器 activeUiTab 高亮（agent tab 时代遗留）

来源：tech-design 接线表。原指编辑器内 agent tab 的激活态，agent 入口已迁主面板（`docs/adr/0001`），本项**随迁移作废**，除非独立助手页引入编辑器联动。
状态：已作废。

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

### T-06 — 确认卡浮层压住输入区，内容低于 tech-design §8.2 的承诺

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `src/newtab/pages/Agent.vue:21-26`、`docs/agent-assist-tech-design.md:640`
现象：① 确认卡以 `absolute inset-x-3 bottom-3` 浮在面板底部，正好盖住输入框与发送按钮 —— 等确认期间用户无法补一句上下文，也看不到自己刚发了什么；卡片不阻断滚动，往回翻历史时它一直悬着。② 卡内只有标题 + 一句通用 hint + 裸 `<pre>code</pre>`，而 §8.2 承诺的是：标题含目标页 title、正文给代码行数、明示「严格 CSP 页面走 chrome.debugger 降级，浏览器会显示调试横幅」、按钮为 `[取消] [执行]`。
证据：**代码位置，与方案对照，未实测** —— `Agent.vue:21-26` / `workflows/[id].vue:48-53`（浮层定位）、`AgentConfirmCard.vue:1-40`（无目标页/行数/CSP 文案）、tech-design §8.2 表格 `:640`。会话授权复选框属 **B5**，本条不重复登记。
影响：用户在信息不足的情况下裁决「是否在别人页面上执行代码」，正是 T2「知情执行」要防的场景；浮层遮挡则让确认期间的对话上下文不可见。
建议：卡片改为插入事件流内（工具卡下方，§9.1 骨架图就是这么画的）+ 顶部吸附条保底，正文补目标页 title、代码行数、CSP/debugger 提示；`[取消] [执行]` 对齐方案用词。与 T-02（切走侧栏后确认卡消失、loop 永久挂起）同区域，动手前一并处理。
结论：卡片从 `absolute` 浮层移进 `AgentPanel` 的**文档流**，位置在输入 form 上方（新增 prop `pending-confirm` + 事件 `confirm-answer`；两个宿主只传 prop，`Agent.vue` 与 `workflows/[id].vue` 各自的 `<agent-confirm-card>` 渲染和 import 已删除）。① 的两个症状一起消失 —— 文档流里的卡片既不遮挡输入框与发送按钮，也不会浮在翻动的历史之上。② 按 kind 补齐内容：标题分五种（`在 {target} 上执行 JS` / `在 {target} 上标出元素` / `打开一个新标签页` / `往画布添加一个块` / `修改画布上的节点 {nodeId}`），target 取 `agent.targetTab.title`、缺省退「当前目标页」；正文给 `{n} 行`；按钮 `[取消] [执行]`。
**与原建议的两处偏离**：(a) 未做「插入事件流内 + 顶部吸附条保底」—— `pendingConfirm` 是宿主状态而非事件历史里的条目，塞进 `AgentTranscript` 要新增插槽与 sticky 兜底两套结构；放输入框上方同样保证输入区永远可达，代价小得多，吸附条也就不再需要。(b) §8.2 那句 CSP 提示**刻意不照抄**：方案承诺「严格 CSP 页面走 chrome.debugger 降级、浏览器会显示调试横幅」，而 B6（debugger 降级）未实现，现状是 MAIN world + `new Function`、严格 CSP 页面直接失败且无任何降级 —— 照抄等于向用户承诺一个不存在的能力，文案改写为诚实描述（「严格 CSP 的页面可能拒绝执行，本版没有降级方案」），B6 落地后再按方案回填。附带修正：`workflow.agent.confirm.hint` 原文写死「会在你选中的页面上执行代码」，对 `open_url`/`add_block` 不成立，改为通用表述；按钮文案 `允许执行`/`不允许` → `执行`/`取消`；`<pre>` 加 `v-if`，detail 为空不再渲染空框。
实测：`npm test` 296 pass / 0 fail（原 282）、`npm run check:i18n` 通过、`npm run lint` 1 error / 10 warning（唯一 error 在 `src/lib/dayjs.js:11`，`git diff` 为空、改动前即如此，本批文件 0 贡献）、`npm run build` exit=0。**渲染效果未在真机点开验证**（需装扩展 + 配 key，本机未跑）—— 位置与文案目前只有 vue-eslint-parser 的模板解析与 webpack 编译通过作证，属推断而非实测。
状态：已清（2026-10-04 完成）

### T-27 — 确认卡的 `<pre>` 永远是空的：requestConfirmation 载荷里没有 `code`

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 架构文档梳理，触发点 `src/agent/loop.js:186-188`、`src/composable/agentHost.js:69-75`
现象：write 类工具弹出的确认卡上那块「看一眼内容」的代码框恒为空。`AgentConfirmCard.vue` 只接收一个 `code` prop，而 runtime 存进 `pendingConfirm` 的 `code` 取自 `req.code`——`loop.js` 的 `requestConfirmation({ ...call })` 里 `call` 只有 `{step, name, toolCallId, args}`，**没有 `code` 字段**，于是 `(req && req.code) || ''` 永远落到 `''`。四个 write 工具（`test_js` / `highlight_selector` / `open_url` / `add_block` + `update_block`）全部受影响：用户看到的是一张「需要你确认 / 这一步会在你选中的页面上执行代码。放行前请先看一眼。」+ 一个空白框的卡片，既看不到要跑什么 JS，也看不到要往画布上放什么块。
证据：**代码位置，推断，未实测复现** —— `loop.js:186-188`（`requestConfirmation({ ...call })`，`call` 由 `:441-445` 构造，字段仅 step/name/toolCallId，args 在 `:465` 才补）、`agentHost.js:70`（`code: (req && req.code) || ''`）、`Agent.vue:24` 与 `workflows/[id].vue:51`（只透传 `pendingConfirm.code`）、`AgentConfirmCard.vue:12-15`（`<pre>{{ code }}</pre>` 无 v-if，空串仍渲染出空框）。卡片文案 `workflow.agent.confirm.hint`（`src/locales/zh/newtab.json:704`）写死为「执行代码」，而 `open_url`/`add_block` 并不执行代码，文案与实际动作也对不上。
影响：确认门是本设计唯一的写操作安全闸门（`docs/adr/0002` 的立论正是「确认卡上直接显示选择器，用户点允许恰好回答了『你说的是这个吗』」）。闸门形同虚设：用户只能盲点「允许执行」，或保守地一律拒绝——后者会让 `add_block` 这类主功能不可用。这条直接击穿 ADR 0002 声称的收益。
建议：`loop.js` 改为 `requestConfirmation({ ...call, args: call.args })` 之外的显式载荷——按工具名组装人话摘要（`test_js` 给 code 全文、`highlight_selector`/`query` 类给 selector、`open_url` 给 url、`add_block`/`update_block` 给 blockId/nodeId + 变更字段）；`AgentConfirmCard` 改为接收结构化载荷而非裸 `code`，并按工具名切换标题与 hint 文案。与 T-06（确认卡内容低于 tech-design §8.2 承诺）是同一张卡，建议一并做。
结论：新建纯函数模块 `src/agent/confirm.js` 承载载荷整形 —— `buildConfirmation(req, {targetTitle})` 按 `name` 分五类（`test_js`→code 全文 + `countLines` 行数、`highlight_selector`→selector、`open_url`→url、`add_block`/`update_block`→blockId/nodeId + 变更字段的 JSON 摘要、未知写工具→参数原样摊开），只读 `args`、顶层字段一律忽略；未知/缺 `args`/循环引用都有兜底，不抛。`src/agent/confirm.test.js` 14 条用例钉住（含三条关键回归：**顶层旧 `code` 不许覆盖 `args.code`**、`args` 缺失给空串而非 `undefined`、`data` 带循环引用不炸）。`agentHost.js` 删除 `req.code` 分支改调 `buildConfirmation`；`AgentConfirmCard.vue` 改收结构化 `confirm`，按 `kind` 切标题与 hint，`<pre>` 绑 `confirm.detail` 并加 `v-if`；`workflow.agent.confirm` 下新增 12 个 key（en + zh 同步）。
**原建议中「改 `loop.js` 传显式载荷」未采纳** —— 重新读过 `loop.js:441-465`，`call.args` 在 `executeCall` 之前已赋值，`requestConfirmation({ ...call })` 展开时 `args` 已在载荷里，缺的只是宿主侧的读取；改 loop 反而多一处无关改动。改由 `loop.test.js` 的「写类工具必须经过确认」补一条 `assert.deepEqual(asked[0].args, …)`，把载荷形状钉死在最靠近产出处。
实测：`npm test` 296 pass / 0 fail（原 282，新增 14 条全在 `confirm.test.js`）、`npm run check:i18n` 通过（zh-TW 对新增 12 key 缺译，advisory，与该区其余 agent key 同状态）、`npm run lint` 存量 1 error / 10 warning、`npm run build` exit=0。**未在真机复现原 bug**（需装扩展 + 起模型）—— 修复正确性由新增回归测试与代码路径证明，原「空框」现象本身仍是推断。
状态：已清（2026-10-04 完成）

### T-28 — agent 发给 background 的三条消息带 `type`，路由按 `name` 查表，`test_js`/`query_elements`/`highlight_selector` 一律打不通

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 浏览器侧管道梳理，触发点 `src/agent/index.js:229`、`src/utils/message.js:52-56`、`src/background/index.js:603/656/721`
现象：agent 侧 `toolCtx.sendMessage = (msg) => browser.runtime.sendMessage(msg)`（`src/agent/index.js:229`），工具发出去的载荷是 `{type:'agent:run-js'|'agent:query'|'agent:highlight', tabId, ...}`（`src/agent/tools/page-write.js:30/77`、`src/agent/tools/highlight.js:32`）。但background 侧是 `new MessageListener('background')` + `message.on('agent:run-js', ...)`（`src/background/index.js:61/603/656/721`），而 `MessageListener.listener` 只按 `message.name` 查表（`src/utils/message.js:52`），agent 的载荷根本没有 `name` 字段 —— 于是 `:56` 的 `message.name.split('--')` 抛 TypeError，被 `:74` 的 catch 包成 `Unhandled Background Error` reject。三个工具全部落进各自的 catch 分支，向模型返回「执行失败：Unhandled Background Error…」。
证据：**实测（复刻 listener 逻辑）** —— 按 `src/utils/message.js:48-79` 逐行复刻 listener，用 `{type:'agent:run-js',tabId:1,code:'1+1'}`（listener 表已含 `background--agent:run-js`）喂进去，输出 `REJECTED: Unhandled Background Error: TypeError: Cannot read properties of undefined (reading 'split')`。代码位置：产出侧 `src/agent/index.js:229`，消费侧 `src/utils/message.js:52,56,74`。**真实浏览器端复现：未实测**（需装扩展 + 起模型）。方案文档 `docs/agent-assist-tech-design.md:580` 原本写的是 `MessageListener.sendMessage('agent:run-js', payload, 'background')`，实现时换成了裸 `browser.runtime.sendMessage`，两者不是同一个协议。`read_page` 不受影响 —— 它走 `browser.tabs.sendMessage` + `switch (data.type)`（`src/agent/index.js:129-136` → `src/content/index.js:323`），是另一条通道。
影响：三个走 background 的页面工具（`test_js` 写类、`query_elements` 读类、`highlight_selector` 写类）在真实浏览器里全部不可用，模型每次只拿到一条 TypeError 文本，且错误文案完全指不到真因。`src/agent/tools/page-write.test.js` 用注入的假 `sendMessage` 只断言了载荷形状（`:93`/`:41`），这条断链不会被现有测试发现 —— 与 `openai-compat.js:96-104` 记的「测试夹具照消费方写」是同一类陷阱。
建议：① 最小改动 —— `toolCtx.sendMessage` 改用 `MessageListener('background').sendMessage(name, payload)`（`src/utils/message.js:88-90`），工具侧改成 `sendMessage('agent:run-js', {...})` 传两个参数；代价约 10 行，且天然避开 Firefox 需 `JSON.stringify` 的分支。② 或在 background 侧 listener 前加一层把 `{type}` 映射成 `name` 的兜底；代价一处全局改动，影响面比 ① 大。③ 两者都要补一条覆盖真实路由的断言（现在只测了载荷形状）。
结论：采纳 ① 的变体 —— 翻译收敛在装配层一个导出函数 `toBackground({type, ...payload})`（`src/agent/index.js`），内部走 `utils/message` 的 `sendMessage(type, payload, 'background')`（连 Firefox 的 stringify 分支一并覆盖）；三个工具的调用点不动，仍发 `{type, ...}`。补契约测试：`assembly.test.js` 新增 2 条，用 polyfill 桩把 `runtime.sendMessage` 接到**真实** `MessageListener('background')` 上，断言三条载荷原样路由到 handler、返回值原路带回。红证已实测：把 `toBackground` 换回裸 `runtime.sendMessage`，新路径按预期炸出与用户报错一字不差的 `Unhandled Background Error: …(reading 'split')` 且 handler 不被调用。`npm test` 282 pass / 0 fail（原 280），eslint 通过，`npm run build` 成功。工具侧仍发 `{type}` 是刻意的：工具层保持纯函数、不认识 wire 协议，翻译点唯一化在装配层。
状态：已清（2026-10-04 完成）

### T-29 — `agentEvalInPage` 丢掉了文档承诺的求值包装，`test_js` 任何返回值的代码必炸

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 用户报「确认权限后卡死」，触发点 `src/background/index.js:538-550`（构建产物 `build/background.bundle.js` 里的 `le`）
现象：`agentEvalInPage` 写的是 `const fn = new Function('return (' + src + ')')` 然后 `fn()()` —— `new Function('return (1+1)')` 得到的 fn，调用一次就**直接返回值 2**，`fn()()` 是把 2 当函数再调一次，必抛 TypeError。工具文档（`page-write.js:144`）承诺「会被包成 `(function(){ return (…) })() 执行`」，实现把这个包装弄丢了。后果：任何返回普通值的代码都炸（只有返回函数/IIFE 的代码侥幸能跑），模型收到报错后重试 `test_js`，每次重试 write 类都再过一次确认门、再弹一次确认卡，`MAX_STEPS=12` 内反复弹 —— 用户看到的就是「点确认后卡死/无限弹确认」。
证据：**实测（真 Chromium 加载 build/ 扩展，探针 `.agent-test/iso-probe.mjs`）** —— 走完整 wire（扩展页发 `background--agent:run-js` → background → `executeScript` MAIN world）发 `1+1`，返回 `{"error":"代码执行出错：n(...) is not a function","ok":false}`；把压缩产物里的 `le` 原样提取到干净页面单跑、以及手工未压缩同构函数注入，均复现同一错误 —— 与压缩无关，是逻辑本身错了。wire 链路本身正常（错误能 settle、能返回），所以这是 T-28 修好通道后暴露的下一层 bug。
影响：`test_js` 对模型完全不可用（凡有返回值的调用必失败），且失败形态诱发确认卡反复弹，体验为「卡死」。`query_elements` / `highlight_selector` 不走这个函数，不受影响。
建议：补上包装 —— `new Function('return (function(){ return (' + src + ') })')`，保持 `fn()()` 调用形状不变（`fn()` 返回包装函数，`fn()()` 才是求值），一行改动，Promise/超时语义不动。同时把这个函数从 `background/index.js` 抽成纯模块（`npm test` 的 glob 只覆盖 `src/agent/**`）补单测：表达式值、Promise、undefined、SyntaxError 四条。代价约 30 分钟。
结论：按建议落地 —— 抽成纯模块 `src/agent/agentEvalInPage.js`（导出 `agentEvalInPage` + `raceTimeout`，头注写死「必须自包含」的序列化约束），`background/index.js` 改为导入，本地定义删除；包装按建议补回，`fn()()` 形状不变。单测 10 条钉住：表达式值、对象 JSON、Promise 求值、IIFE、undefined、函数退回 String()、对象方法属性被 stringify 丢掉（已知行为钉住）、裸语句 SyntaxError、运行期异常归一。真机验收（探针 6 条全过）：`1+1` → `ok:true "2"`（328ms）、`document.title`、对象字面量 JSON、坏 tabId 立即报错。`npm test` 308 pass / 0 fail，eslint 干净，`npm run build` 成功且产物里包装形态正确。用户贴的错误 `代码执行出错：n(...) is not a function` 与登记的现象一字不差，即本轮修的对象。
状态：已清（2026-10-04 完成）

### T-30 — 工具执行 await 无超时无中止路径，页面同步阻塞代码把 agent 永久卡死

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 同上排查，触发点 `src/background/index.js:579-592`（`runInPage` 无超时）、`src/agent/loop.js:467`（`await executeCall` 无守卫）
现象：`test_js` 允许模型跑任意代码；表达式形式的同步死循环（如 `(()=>{for(;;);})()`）把目标页主线程永久占死，`executeScript` 的 promise 永不 settle，background 通道随之永不响应。`loop.js:467` 的 `await executeCall(...)` 没有超时或中止守卫 —— `abort()` 只 abort LLM 的 fetch signal，对卡在工具执行上的循环无效，整轮 send 永远回不来，agent.busy 永真，唯一出路是重开页面。`agentEvalInPage` 里的 10s `Promise.race` 救不了这种场景：那个 setTimeout 也运行在已被占死的页面主线程上，根本没机会触发。
证据：**实测（真 Chromium 加载 build/ 扩展，探针 `.agent-test/iso-probe.mjs`）** —— 发 `(()=>{for(;;);})()`，15s 硬超时后仍是 `{"__hung":true}`；对照组「不存在的 tabId」立即返回错误。通道与错误路径都正常，唯独页面同步阻塞 = 永久挂起。
影响：模型只要生成一段同步阻塞代码且被 `test_js` 执行，agent 整轮永久卡死，停止按钮救不回。概率低但一旦发生必现、必死。
建议：background 侧 `runInPage` 包一层硬超时（如 15s `Promise.race`，超时返回 `{ok:false,error:'页面执行超时…'}`）让 loop 能继续收尾；loop 侧 `executeCall` 是否也要兜底可再议（有 background 超时后必要性下降）。代价约 15 分钟 + 1 条单测。
结论：按建议落地 —— `runInPage` 的 `executeScript` 套 `raceTimeout`（新抽的纯 helper，`agentEvalInPage.js` 导出），硬超时 `AGENT_PAGE_TIMEOUT_MS = 15s`，超时返回 error 形状（附「别再在这页上执行代码」的指引，模型可据此收手）而不是 reject；迟到 reject 由 helper 内部吞掉（有单测钉住不炸 unhandledrejection）。`agent:query` / `agent:highlight` 同走 `runInPage`，一并获得兜底。真机验收：`(()=>{for(;;);})()` 从「15s 仍挂死」变为「15.0s 返回『页面执行超时（15s）』error」，页内 10s 超时（页面还活着时）不受影响，坏 tabId 立即报错。loop 侧未加守卫：background 超时已兜住永不 settle 的来源，`executeCall` 自身逻辑（纯 JS）没有已知的挂起点，不加多余一层。
状态：已清（2026-10-04 完成）

### T-32 — `get_block_schema` 是从未接线的空壳，永远返回「可用块（一个都没有）」，模型陷入 read_page ↔ get_block_schema 循环

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 用户报「agent 不跑 test_js 且陷入循环」并贴出对话，触发点 `src/agent/index.js:192`、`src/agent/tools/page.js:268-281`、`src/composable/agentHost.js:240-252`
现象：工具 `get_block_schema` 的执行走 `ctx.getBlockSchema(name)`，而 `createAgentRuntime` 的默认实现是 `async () => null`（`index.js:192`），且**全仓没有任何宿主传入真实现**（`agentHost.js` 的 createAgentRuntime 调用只传了 getConfig/targetTab/enabledGroups/sessionStore/getWorkflowId/canvas/onSessionsChanged/requestConfirmation）。于是任何查询都命中「块不存在」分支，兜底的 `getBlockSchema('*')` 也返回 null → 可用块列表渲染成「（一个都没有）」。与 prompt 事实表同时 saying「本版共有 61 个块」（`prompt.js:192`，countBlocks 走真实目录）直接矛盾。用户贴的对话里模型查 `javascript-code`（真实目录里存在、`data.code` 字段齐全），得到「没有名为 javascript-code 的块。可用块：（一个都没有）」，随后在 read_page ↔ get_block_schema 之间震荡直到 MAX_STEPS 烧完；它始终没调 test_js，因为它的计划走的是工作流块路线（画布上已有 trigger/javascript-code/active-tab），而那条路被空 schema 工具堵死。
证据：**实测（代码 + 用户贴的对话双证）** —— ① `grep -rn getBlockSchema src` 仅命中 `index.js`（默认 null 桩 + 透传）和 `page.js`（工具），无任何宿主接线；② 真目录实测：`tasks` 共 61 块、`javascript-code` 存在，条目含 `name/description/category/data{code,...}` —— 工具需要的数据全都有，只是没接；③ 用户贴的 `get_block_schema` 返回原文「可用块（add_block 用第一个）：（一个都没有）」与桩行为逐字吻合。对照：同为块目录消费方的 `add_block` 用的是宿主传入的 `ctx.blocks`（`canvas.js:50`），有真数据 —— 说明目录通道本来就有，唯独 schema 工具漏接。
影响：所有块相关计划（add_block 前查字段、查可用块名）全部死路；模型在矛盾信息下反复重试直至 12 步烧完，用户看到「陷入循环、什么都没干成」。`test_js`/`read_page` 等非块工具不受影响，但模型的注意力被吸进死胡同后也不会去用。
建议：在装配层给 `getBlockSchema` 一个真默认实现（`index.js` 已导入 `tasks` 目录，无需宿主配合）：`'*'` 返回 `[{id, name}]` 全量列表；按 id 或 name 查找返回 `{id, name, description, category, data: Object.keys 风格的字段清单, refDataKeys}`，形状与 `page.js:286-299` 的渲染约定对齐。约 40 行 + `assembly.test.js` 补两条断言（查 `javascript-code` 能拿到 data 字段；`'*'` 返回 61 条）。另建议给「目录为空」加一条防御性断言：若 `getBlockSchema('*')` 返回空数组而 countBlocks>0，说明接线又断了，直接在观察值里说人话。代价约 30 分钟。
结论：按建议落地 —— 装配层新增导出 `lookupBlockSchema(name)`（`src/agent/index.js`，用已导入的 `tasks` 目录：`'*'` 全量 `[{id,name}]`、按 id/块名双认、返回 `{id,name,description,category,data}`），`createAgentRuntime` 的默认从 `async()=>null` 换成它，两个宿主零改动即接线。防御断言落在工具层（`page.js`）：① 形状守卫 —— schema 必须是非数组对象且带 id，否则按查不到处理（写测试时实测踩到：桩回空数组时 `[]` 是 truthy，会走「查到了」分支渲染出 `## undefined`）；② 目录为空 ≠ 没有匹配块 —— 观察值直说「get_block_schema 没接上线，停止重试本工具」。测试 7 条：按 id / 按块名 / `'*'` 镜像目录（条数 === `Object.keys(tasks).length`）/ 查不到 null / 空数组防御 / null 桩走旧分支 / 真实现端到端（`## JavaScript code` + 字段含 code）。`npm test` 314 pass / 0 fail，eslint 干净，`npm run build` 成功。
状态：已清（2026-10-04 完成）

### T-33 — `readPageFromTab` / 指纹 probe 的 `tabs.sendMessage` 无超时，页面被注入代码占死后 agent 永久挂起

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 用户报「同意运行代码后卡住」+ 会话 dump（`Downloads/agent-sessions.json`）分析，触发点 `src/agent/index.js:185`（readPageFromTab）、`:380`（probe）
现象：`test_js` 在目标页注入代码后，若该代码把页面主线程占死（死循环、alert 等），executeScript 通道有 T-30 的 15s 硬超时兜底，但**同一渲染进程的 content script 也会被占死**——之后任何 `browser.tabs.sendMessage`（read_page 工具、每步指纹 probe）的 promise 永不 settle：消息发给了一个无法响应的 renderer，没有浏览器级超时。`readPageFromTab` 的 try/catch 接不住「挂起」只接得住「抛错」，probe 同理。整轮 send 挂死在 step 开头或工具执行处，abort 也救不了（abort 只作用于 fetch signal）。
证据：**实测（真 Chromium + build/ 扩展，探针 `.agent-test/t33-probe.mjs`，2026-10-04 复现全链路）** —— ① 健康页发 `agent:read-page` 消息：立即返回（138 字节）；② 走 background `agent:run-js` 注入 `(()=>{for(;;);})()`：15.0s 后返回「页面执行超时（15s）」（T-30 兜底生效）；③ **同一被占死的页面再发 `agent:read-page`：15s 硬超时后仍是 `{"__hung":true}`** —— tabs.sendMessage 永不 settle，与用户「同意执行注入代码后整个助手页面所有交互失效、控制台无报错」的复现逐环吻合（无限 await 不抛错，控制台自然干净）。用户盲批的注入代码（UI 构建脚本）无需逐字核对：任何把页面主线程占死的形态（死循环/alert/同步重排）都进入这条链。
影响：模型注入一段带死循环/alert 的代码后，agent 当轮永久卡死、停止按钮无效、刷新丢整轮——用户已两次撞上「同意后卡住」。
建议：复用 `raceTimeout`（`agentEvalInPage.js` 已导出）：`readPageFromTab` 的 `tabs.sendMessage` 与 probe 各包 10-15s 超时，超时返回「页面无响应（可能被之前注入的代码占死），请换页或让用户刷新该页」的人话观察值。约 15 行 + 1 条单测。
结论：按建议落地 —— `readPageFromTab` 的 `tabs.sendMessage` 套 `raceTimeout`（`TAB_CHANNEL_TIMEOUT_MS = 15s`，params 可传 `timeoutMs` 覆盖供测试），超时返回「页面无响应（N s 无应答）……请停止对本页的读页和执行操作，让用户手动刷新或关闭该页，或用 focus_tab 换一个标签页」；指纹 probe 走同一函数自动获得兜底，超时返回字符串时 probe 拿不到 fingerprint → 不产生假通知（已核对 `index.js` probe 分支）。单测 2 条（桩永不 settle → 人话；健康通道照常）。`npm test` 328 pass / 0 fail，eslint 干净，`npm run build` 成功且产物含超时文案。局限如实记：单测覆盖的是装配层函数，真机端到端由 t33-probe 的第 3 步场景对应（raw 通道仍会挂，修复在调用点包裹），用户真机复验才算最终闭环。
状态：已清（2026-10-04 完成）

### T-36 — write 工具参数校验失败只回「××不能为空」，不回显实际收到的键，模型连错 6 次无法自纠

类型：改进
登记日期：2026-10-04
来源：同上 dump 分析（`94cd04e9` 第二轮：`update_block` 连续 6 次「nodeId 不能为空」错误，中间夹一次 list_canvas 也没能纠对），触发点 `src/agent/tools/canvas.js:44-49` 及 update_block 同形分支
现象：`add_block`/`update_block` 对缺失参数只返回「blockId 不能为空。」/「nodeId 不能为空。」。模型混淆两个工具的参数名（add 用 `blockId`、update 用 `nodeId`）时，错误信息不含「你实际发了什么」，模型只能瞎猜着重试——dump 里一轮连错 5 次 + 上轮 1 次，每次都烧一步配额与一次（update_block 的）确认弹窗。
证据：**实测（dump）** —— `94cd04e9` 工具错误事件 7 条：add_block 1 次 + update_block 6 次，错误文案逐条相同；工具参数本身不在持久化事件里（见 T-34），「发了错键名」是据错误形态与模型思考上下文的高置信推断。
影响：写路径的可用性被模型的小错放大成多轮失败，且每次失败都可能再弹一次确认卡打扰用户。
建议：参数校验失败时回显收到的顶层键名与值摘要（如「nodeId 不能为空。收到参数: {blockId: "pg8rzgv", data: {...}} —— update_block 用 nodeId，add_block 才用 blockId」）。`canvas.js` 两处分支 + 单测。约 20 分钟。
结论：按建议落地 —— `canvas.js` 新增 `missingParamError(missing, params, hint)`：回显收到参数的 JSON（**长字符串值截断到 60 字符**，整段错误不会被大 data 撑爆），并按工具点名破 blockId/nodeId 分工（add_block：「update_block 才用 nodeId」；update_block：「add_block 才用 blockId」）。新增 `canvas.test.js` 4 条（双向回显 + 长值截断 + 空参数占位）。`npm test` 338 pass / 0 fail，eslint 干净，`npm run build` 成功且产物含「收到参数」。效果：模型混用参数名时一次自纠，不再连错烧步数与确认弹窗。
状态：已清（2026-10-04 完成）

### T-37 — `elideStaleObservations` 保留条件过宽：页面快照只要后面跟了任何别的工具就被压缩，模型被迫反复 read_page

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 用户报「对话反复调用 read_page」并贴出对话，触发点 `src/agent/window.js:101-120`
现象：`elideStaleObservations` 的保留条件是「属于**最后一组工具消息**」（从尾部往前数连续的 role:'tool'），而不是「是**最后一次页面快照**」。只要模型在 read_page 之后调了任何非页面工具（get_variables、list_canvas、query_elements…），先前的页面快照就被换成 `STALE_MARKER`（「此前的页面快照已被压缩…」）——哪怕页面根本没变、这是当前唯一一份页面知识。模型的思考内容不进 wire（`wire.test.js`「思考内容不进 wire」），所以被压缩后它**真的**失去页面结构：用户贴的对话里，step 1 的思考还复述着「书本列表在 ol.row…」（当时快照还在 wire 里），step 2 的思考就变成「我需要先看看当前页面的结构」→ 重读；重读之后再调任何工具，新快照又被压缩 → 再读。10-03 dump 里 `47de996f` 会话「read → query → read → query → read×3」五连同页读取、今天多轮会话的 2-4 连读，都是这台机器压出来的。
证据：**代码逐行核对 + 用户对话逐步对账** —— ① `window.js:102-110`：`lastToolGroupStart` 从尾部收集**连续** tool 消息，`:114` 只豁免 `i >= lastToolGroupStart`；② 用户贴的对话时序：read_page(obs A) → get_variables/list_canvas → 此时 obs A 不在最后一组 → 被压缩 → 下一步模型思考原话「我需要先看看当前页面的结构」（它自己的上下文里已经没有页面了）；③ `window.test.js:70-89` 只覆盖了「旧快照后面还有**新页面快照**」的正确剔除场景，「快照后面跟非页面工具」这一致病场景没有任何用例；④ 第二次 read_page 观察值（detail="addresses"，默认档）与第一次参数相同——重读不是换档位，是上下文里真的没了。
影响：凡模型在 read_page 后调任何一个别的工具，页面知识就从上下文里蒸发，触发反复 read_page——烧步数、烧 token、弹无关的确认门，且观察值越大（content/full 档）压缩损失越重。
建议：`elideStaleObservations` 改为保留**最后一条页面快照**（从尾往前找第一条 `<untrusted_page_content` 开头的 tool 消息），只压缩比它更旧的页面快照；非页面工具不再参与「新旧」判定。约 10 行；`window.test.js` 现有两条（新快照替换旧快照、非页面工具不剔）语义不变，**新增**一条「快照后面跟 get_variables/list_canvas → 快照必须保留」。代价约 30 分钟。
结论：按建议落地 —— `window.js` 的判定从「最后一组工具消息」改为「最后一条页面快照」（从尾往前找第一条页面 content 的 tool 消息，`i === lastPageSnapshot` 豁免），头注写明判定依据（有没有更新的页面快照 ≠ 后面有没有别的工具）。测试 3 条：致病场景（快照后跟非页面工具 → 必须保留且不带 elided）、多条快照只留最后一条、原有两条（新快照替换旧快照 / 非页面工具不剔）语义不变仍绿。loop.test.js 的接线用例（两次 read_page，有更新快照）不受影响仍绿。`npm test` 330 pass / 0 fail（原 328），eslint 干净，`npm run build` 成功。模型侧收益：read_page 之后调别的工具不再失忆，反复 read_page 的结构性根因消除；同页重读只剩模型自身冗余一种来源（可用 [agent] 日志的 tool.call 参数摘要区分）。
状态：已清（2026-10-04 完成）

### T-38 — `test_js` 只接受表达式形式，模型写语句形式必吃 SyntaxError，「时好时坏」

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 用户报「部分工具运行不稳定，有时候好有时候不好」并贴出对话（test_js 先报 `Unexpected token 'const'`、重试即成功），触发点 `src/agent/agentEvalInPage.js:31`
现象：`agentEvalInPage` 把代码包成 `(function(){ return (src) })` 求值——**只接受表达式**。模型抓数据时最自然的写法是语句形式（`const items = ...; const list = []; items.forEach(...); list`），以 `const` 开头的代码在表达式包装下必吃 `SyntaxError: Unexpected token 'const'`。重试时模型碰巧包成了 IIFE 才成功——所以「有时候好有时候不好」：不是随机，是**取决于模型这一次有没有记得写 IIFE**，而错误信息 `代码执行出错：Unexpected token 'const'` 完全没提示「该包成 IIFE」，模型要靠运气猜对。update_block 的「nodeId 不能为空」反复失败是同一类病（错误不指路），已在 T-36 登记。
证据：**代码逐行核对 + 用户对话对账** —— ① `agentEvalInPage.js:31` 包装形态如上；② 用户对话：第一次 test_js 报 `Unexpected token 'const'`（语句形式），第二次成功（返回书本数组，IIFE 形式）；③ `agentEvalInPage.test.js` 现有用例「裸语句是 SyntaxError」把该行为钉成了预期。
影响：抓数据的常见写法（语句形式）首试必败，浪费一步 + 一张失败卡片；错误文案不可行动，自纠靠运气。
建议：双形式求值——① 先按现行表达式包装编译；② 若抛 **SyntaxError**（编译期错误，代码尚未执行，回退无双跑副作用风险），改用语句形式 `new Function('return (async function(){\n' + src + '\n})')` 重编译执行（async 包装顺带支持顶层 await；值取 `return` 所得）；③ 语句形式跑完返回 undefined 时，在返回值里附一句指引（「代码已执行完毕但没有返回值——要拿数据请在末尾加 return，或包成 IIFE」）；④ 两种形式都 SyntaxError 才报错，文案说明已尝试两种形式。**严禁**在运行期错误（非 SyntaxError）时回退——那会双跑副作用。同步改 `agentEvalInPage.test.js`：「裸语句 SyntaxError」用例的输入换成两种形式都非法的（如 `const const`），新增语句形式成功 / 顶层 await / undefined 指引三条。代价约 40 分钟。
结论：按建议落地 —— `agentEvalInPage.js` 编译链改为「表达式优先，SyntaxError 才回退语句形式（async 包装，支持顶层 await）」，双形式都炸才报「表达式与语句两种形式都无法解析」；语句形式跑完无返回值时返回值附「加 return 或包 IIFE」指引（表达式形式的 undefined 保持干净字面量）；运行期错误不回退的红线写进了头注与实现（编译 catch 与执行 catch 分离）。测试：`agentEvalInPage.test.js` 原「裸语句 SyntaxError」用例换成双形式都非法的输入（`const const const`——原输入 `while(true){}` 在语句形式下能编译会真跑出 10s 超时），新增语句成功 / 顶层 await / undefined 指引 / 表达式 undefined 不带指引，共 16 条全绿。`npm test` 338 pass / 0 fail，eslint 干净，`npm run build` 成功且产物含双形式编译链。效果：语句形式首试即成，`Unexpected token 'const'` 一类失败消失。
状态：已清（2026-10-04 完成）

### T-02 — 确认门在面板被切走后不 resolve，那一轮 loop 永久挂起

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 架构评审，触发点 `src/newtab/pages/workflows/[id].vue:1166-1185`、卡片位置 `[id].vue:26-53`
现象：write 工具等待用户确认时，`agent-confirm-card` 挂在 `v-else-if="state.sidebarPanel === 'agent'"` 分支内；`toggleAgentPanel()` 把 `sidebarPanel` 切到 `details`（无 busy 守卫，也不调 `pendingConfirm.resolve`），或点某个块弹出 `workflow-edit-block`（`v-if="editState.editing"` 优先级更高）时，确认卡被隐藏，但 promise 仍挂着 —— loop 侧永远 await。
证据：**代码位置，推断，未实测复现** —— `agentHost.js:65-75`（promise 只存 `pendingConfirm`）、`:86-92`（仅切会话时拒绝）、`:231-235`（仅 `onBeforeUnmount` 拒绝，而宿主页没有卸载）。`CONTEXT.md:80` 的不变量只写了「切会话/卸载前先 resolve」，没覆盖「面板被藏起来」。
影响：用户在等待确认时切走侧栏或去改别的块 → agent 保持 busy、那一轮不收尾、会话不落盘；用户切回后卡片还在，点一次才恢复。最坏表现像「助手卡死了」。
建议：① `toggleAgentPanel` 与打开块编辑时走 `guardAgentSwitch()` 同款拒绝，代价极小；② 或把确认卡提到宿主根节点（不随 `sidebarPanel` 卸载），代价是卡片要自己处理遮挡；③ 或 busy + 挂确认时禁止切走（体验差，不推荐）。
结论：采纳①的思路，但拒绝点挂在**卡片自己所在的组件**上，而不是散在三个调用点 —— `AgentPanel.vue` 新增 `onBeforeUnmount(() => { if (props.pendingConfirm) emit('confirm-answer', false) })`，走宿主已有的 `answerConfirm`（内部判空，`normalizeAnswer` 认布尔，重复发也安全）。一处钩子覆盖三处卸载路径：切走助手面板、打开块的编辑卡、收起整个侧栏 —— 三者在 `[id].vue` 里都是 `v-if`/`v-else-if` 真卸载（已逐处核对模板，无 `v-show` 隐藏分支），在 `toggleAgentPanel`/`initEditBlock` 各补一句的写法以后新增一处隐藏路径就漏一处。②（卡片搬家到宿主根节点）与③（busy 时禁止切走）都未采纳。loop 拿到「用户拒绝」的 error 观察值照常收尾，busy 与会话状态不受影响。
测试：本仓无组件测试基建（见 T-26），退而在 `confirm.test.js` 加一条**源码接线守卫**：断言 `AgentPanel.vue` 里存在 `onBeforeUnmount(() => {`、钩子内判 `props.pendingConfirm`、发 `emit('confirm-answer', false)`。红证已实测：把 emit 改成 `true` 后该条 `fail 1`，还原后全绿。`npm test` 343 pass / 0 fail（原 338），eslint 通过，`npm run check:i18n` 通过，`npm run build` 成功且产物含 `confirm-answer` 接线。
**局限如实记**：「三处 `v-if` 会真卸载」依据 Vue 语义与模板结构逐处核对，**未在真机点开验证**（需装扩展 + 配 key）—— 即「面板被藏起来后那一轮恢复收尾」这个现象本身仍是推断。
状态：已清（2026-10-05 完成）

### T-39 — runtime 通道发送侧无兜底：background 响应丢失时 agent 轮次永久挂起（真机复现）

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 用户贴出 `[agent]` 日志复现「test_js 同意后卡住」，触发点 `src/agent/index.js` 的 `toBackground`
现象：用户日志显示 `tool.call test_js → confirm.ask → confirm.answer(approved) → channel.send(agent:run-js)` 之后**既无 channel.reply 也无 channel.fail**——`browser.runtime.sendMessage` 的 promise 永不 settle。关键矛盾：该次注入的代码无死循环（query 20 本书 + JSON.stringify，毫秒级），background 侧 T-30 的 15s 兜底理应在 15s 给出响应；响应未到达说明 **background SW → 发送方的回程在用户真实 Chrome 里丢了**（SW 被回收 / 消息通道层面的浏览器行为），T-30 的兜底在 background 内部，救不了回程。
证据：**实测（探针 `.agent-test/t40-probe.mjs`，真 Chromium + 当前 build）** —— 用用户原始代码三层全部通过：热状态 140ms、连发 24ms、SW 空闲 35s 后冷启动 11ms，返回正确书本 JSON。即代码与本机传输路径均健康；差异只剩用户真实 Chrome（版本/环境）与被截断的代码（`+57` 字符未见，若含 alert() 会占死页面，但即便如此 15s 响应也应送达——t33-probe 已实测占死页时 15s 超时正常返回）。用户侧 `channel.send` 无 reply 无 fail 与「SW/传输丢响应」唯一吻合。
影响：与 T-33 同型的永久卡死，但发生在 runtime 通道——T-30/T-33 的兜底都盖不到回程丢失这一层。用户已再次撞上。
建议：发送侧兜底——`toBackground` 整个 round trip 套 `raceTimeout`（20s，大于 background 侧 15s，超时返回 `{ok:false, error:'background 通道无响应…'}` 人话观察值）；`channel.reply/fail` 日志附耗时 ms 便于定位。无论 SW/传输发生什么，agent 轮次都不会再挂死。约 15 行 + 1 条单测。
结论：按建议落地 —— `toBackground` 整个 round trip 套 `raceTimeout`（`BACKGROUND_CHANNEL_TIMEOUT_MS = 20s` > background 侧 15s，`options.timeoutMs` 供测试缩短），超时不 reject 而是回 `{ok:false, error}` 观察值形状；文案如实写「这一步是否已执行无法确认」并让模型先 `read_page` 看现状再决定，不许原地重复同一调用（T-33 的教训）。内部标记 `__timeout` 返回前剥掉，不进观察值。send **真**失败仍照旧 reject 走 `channel.fail` —— 超时兜底不吞真错误，有断言钉住。打点：`channel.reply`/`channel.fail` 都附耗时 `ms`，超时单独打 `channel.timeout`（带 `ms` + `timeoutMs`）。
**连带修掉一个实测到的泄漏**：`raceTimeout` 原来不清 `setTimeout` —— `Promise.race` 不会取消它，实测 `node -e` 一个 20s 定时器让进程多活 **20009ms**；T-39 之后每次工具调用都会走它，不修就是每次漏一个。改成谁先 settle 谁 `clearTimeout`（`.finally`），先完成的一侧由单测钉住（只盯自己注册的那个 60s 定时器，避免误伤别的来源的 timer）。
测试：`assembly.test.js` 新增 3 条（background 永不回应 → 人话 error 且 `__timeout` 不泄漏；超时与正常回程两条日志都带 `ms` 且健康回程不误判超时；send 真失败仍 reject）+ `agentEvalInPage.test.js` 新增 1 条（timer 必须被清）。`npm test` 343 pass / 0 fail（原 338），**耗时 10.2s 与改动前 10.4s 持平**（泄漏已修的旁证，否则会多吊 20s），eslint 通过，`npm run check:i18n` 通过，`npm run build` 成功且产物含超时文案与 `channel.timeout` 打点。
**局限如实记**：回程丢失的**根因**（SW 回收 / 浏览器行为）未复现也未消除 —— 本条修的是「无论回程发生什么都不再挂死」，`t40-probe.mjs` 在本机依旧全通（复现不了用户真机环境），最终闭环仍需用户真机复验。
状态：已清（2026-10-05 完成）

### T-40 — `agent:error` 事件有两种互不兼容的形状，promptFacts 降级的详情在 UI 上被吞掉

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 `src/agent` 架构评审，触发点 `src/agent/loop.js:318-322`（手动 emit）与 `src/agent/loop.js:81-88`（`toAgentEvent` 产出）的形状不一致；唯一消费点 `src/components/newtab/workflow/agent/AgentTranscript.vue:157`
现象：`toAgentEvent` 产出的 error 事件字段是 `{ status, message, errorKind, httpStatus }`；但「提示词事实表构建失败」那条降级路径手工 emit 的是 `{ kind, error: '...' }`，**字段名是 `error` 不是 `message`**。UI 侧只有一处读 `ev.message || t('workflow.agent.error')`，于是这条路径的用户可见内容被静默换成兜底文案——用户看到的是「错误」两个字，看不到「事实表构建失败，本次按空表继续」这个唯一能说明为什么本轮能力退化的信息。
证据：**静态代码确认（两个产出点字段名不同 + UI 只有一个读取点），未跑 UI 实测** —— `loop.js:321` 写 `error:`、`loop.js:84` 写 `message:`；`grep -rn "agent:error|\.errorKind|ev.message" src/components src/composable/agentHost.js` 命中仅 `AgentTranscript.vue:157`（读 message）与 `agentHost.js:254`（写 message）。
影响：① 用户侧：模型权限/领域知识表退化的原因不可见，症状表现为「助手突然变笨」且无任何提示；② 维护侧：`AGENT_EVENTS` 是 loop 与 UI 之间唯一的 seam（`CONTEXT.md` 明文），但它的形状没有任何一方守卫——两个产出方可以各写一套字段名，编译期与测试期都不拦。与 T-04（错误渲染样式）相邻但不同：T-04 是样式，本条是载荷丢失。
建议：① 抽一处 `emitError()` 工厂，所有 error 事件只能从它出，形状只有一份（约 30 分钟）；② 补一条「事件契约测试」——遍历 `AGENT_EVENTS` 全部 key，断言每个 key 至少有一个产出点，防止再出现僵尸常量；③ 顺手把 `agentHost.js:254` 裸写的 `'agent:error'` 换回 `AGENT_EVENTS.ERROR`。建议接 T-04 一起做。
结论：按建议落地 —— `events.js` 新增唯一构造函数 `errorEvent()`（新增 `ERROR_KIND.INTERNAL` 档承接装配类错误），loop 的 streamError / promptFacts 降级、index.js、agentHost.js 的全部产出点统一改走它，`agentHost.js` 裸写 `'agent:error'` 已撤掉；loop.test.js 里仍断言旧 `{ error }` 形状的那条用例同步改为断 `message` + `errorKind === internal`（事实表降级详情现在能在 UI 上显示）。`eventContract.test.js` 静态钉住「错误事件只从 errorEvent() 出」。`npm test` 350 pass / 0 fail。
状态：已清（2026-10-05 完成）

### T-41 — `AGENT_EVENTS` 里 CONFIRM / PROPOSAL 是零产出零消费的残留常量

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 `src/agent` 架构评审，触发点 `src/agent/events.js:19-20`；`START` 亦只有一个产出方且 UI 不消费（`src/agent/loop.js:337`，测试断言在 `loop.test.js:150`）
现象：`AGENT_EVENTS.CONFIRM` 与 `AGENT_EVENTS.PROPOSAL` 在**全仓没有任何产出方，也没有任何消费方**——它们是已废弃的 transcript 时代的展示角色残留（`CONTEXT.md` 已把 transcript 一词废弃，这类残留最应该跟着清干净）。事件常量表是 loop↔UI 契约的唯一声明，读者看到这两个 key 会以为存在一个尚未接线的 seam，实际确认流程是走 `deps.requestConfirmation` 直接回调宿主、不经过事件流。
证据：**静态确认** —— `grep -rn "AGENT_EVENTS.CONFIRM|AGENT_EVENTS.PROPOSAL|AGENT_EVENTS.START|'agent:start'" src` 命中项仅 `events.js:13`（定义）、`loop.js:337`（唯一产出）、`loop.test.js:150`（唯一断言），CONFIRM/PROPOSAL 零命中。
影响：纯认知成本——每次读事件表要多扫两个不存在的概念；将来有人真的想加 CONFIRM 事件时，会发现这个名字已经被占但语义不清。无运行时危害。
建议：删掉 CONFIRM/PROPOSAL（含 `AgentTranscript.vue:190` 注释里对它们的提及），保留 START（有产出方、被测试钉住）。配合 T-40 建议② 的「事件契约测试」一起做，能永久防止这类残留再回流。代价约 10 分钟。
结论：按建议落地 —— CONFIRM / PROPOSAL 已从 `AGENT_EVENTS` 与 `AgentTranscript.vue:190` 注释中删除，START 保留（有产出方、`loop.test.js:150` 钉住）。新增 `src/agent/eventContract.test.js` 三条守卫：每个 key 必须有真实代码引用点（僵尸常量直接红）、错误事件只经 errorEvent()、errorEvent 形状固定。`npm test` 350 pass / 0 fail。
状态：已清（2026-10-05 完成）

### T-42 — `docs/backlog.md` 里 T-40 编号重复，两条不同内容共用一个号

类型：bug（登记表自身）
登记日期：2026-10-05
来源：会话 2026-10-05 读 `architecture-review-20261005-0141.html` 后核对 backlog，触发点 `docs/backlog.md:200` 与 `docs/backlog.md:222`
现象：待审核区有两条都编号 T-40 的条目：`:200` 是「`agent:error` 事件有两种互不兼容的形状」，`:222` 是「agent-architecture.html 的代码快照与行号仍停在 T-29/T-30 之前」。而 `:219`（T-41 的建议）明确写着「配合 T-40 建议②」，指代对象因此二义。
证据：**实测** —— `grep -n "^### T-" docs/backlog.md` 得 39 条条目，其中 `200:### T-40 — agent:error…` 与 `222:### T-40 — agent-architecture.html…` 两行编号相同；全表 T 编号最大值为 T-41（`:211`），T-42 起为空号，说明 `:222` 那条是后补时漏了顺延。
影响：违反本文件顶部自定的「编号顺延」规则；此后任何「按 T-40 修」的口头或文档指代都指向两条不同工作，审核与排期阶段直接踩坑。
建议：把 `:222` 那条重编为 T-42（它编号靠后、是后补进来的那条），本轮新增条目从 T-43 起算已按此预留；另补一句「引用旧编号时同时注明行号」的约定。代价 2 行。
结论：已按建议处理 —— 原 `:222` 的 agent-architecture.html 条目重编为 T-47，待审核区不再有重号；T-41 文案里「配合 T-40」恢复唯一指代。自 T-43 起编号连续（grep 复核无重复）。
状态：已清（2026-10-05 完成）

### T-35 — 标题异步回写读到悬挂的 `currentSessionId`，落出 `agent_session_null` 幽灵会话进索引

类型：bug
登记日期：2026-10-04
来源：同上 dump 分析，触发点 `src/agent/index.js:563-582`（title then 里读 `currentSessionId`）、B1 的姊妹症状
现象：首轮 send 结束后 `generateTitleAsync` fire-and-forget，其 `.then` 里 `sessionStore.save({ id: currentSessionId, ... })` 读的是**resolve 时刻**的 `currentSessionId`。若用户在标题生成期间点了「新建会话」（`newSession()` 把 `currentSessionId` 置 null）或切走，晚到的标题保存就以 null id 落盘。dump 实证：存在键面值 `agent_session_null` 的完整会话记录（createdAt 与 `1d1c9a1e` 同为 12:50，title 是 LLM 生成的「注入JS获取书本列表并批量打开」），且索引里有 `id: "null"` 的条目——用户会看到一个切进去是空的幽灵会话。
证据：**实测（dump）** —— `agent_session_null` 记录存在、`agent_session_index` 含 `{"id":"null"}` 条目；该记录 title 为生成文案而 events 仅为首轮快照，与「title then 回写」路径吻合（save 载荷字段与 `:567-578` 逐一对应）。
影响：会话列表出现幽灵条目，点进去为空/错乱；与 B1 同根——回写用的是「当时的会话身份 + 当时的快照」而不是「请求时的」。
建议：与 B1 合并修：title 回写改为「闭包捕获发起时的 sessionId + 只 patch title 字段（读改写仅 title 键）」，回写前校验 `currentSessionId === 捕获的 id`，不等则放弃。约 20 行。
结论：按建议落地 —— `index.js` 首轮标题回写改为 `sessionStore.patchTitle(titleSessionId, title)`：发起时闭包捕获 sessionId，resolve 后 ID 失效（会话被删/切走）时 `patchTitle` 返回 null 直接放弃并记 `title.skip` 日志，不再可能落出 `agent_session_null`；`patchTitle` 只读改写 title 键、不动 events/pins/usage/lastAccessedAt。`sessions.js` 的 save/remove/patchTitle 统一走串行队列（writeTail），堵住 B1 的整记录覆盖竞态：晚到的 patch 只能改 title，不会回退第二轮已落盘的 events。测试：sessions.test.js 新增 3 条（patchTitle 只改 title、null/空 title/缺会话不落盘、索引同步只改 title）+ assembly.test.js 新增源码接线守卫（捕获 id、patchTitle、then 块内不出现 `id: currentSessionId` 与整记录 save）。`npm test` 350 pass / 0 fail，目标文件 eslint 0 error。
状态：已清（2026-10-05 完成）

### B 区已清

- **B5 — 技术方案 Q4：确认卡会话级授权**（2026-10-04 完成）
  - 来源：`docs/agent-assist-tech-design.md` §8.2 / `docs/adr/0002` 已知欠账。内容：test_js 确认卡加「本会话允许试跑代码」复选框（面板卸载/中止即失效）；确认卡按 §8.2 展示目标页标题、代码行数、CSP 提示。方案语义：仅 test_js 可用会话授权，workflow 写操作永不允许。
  - 结论：会话授权落在 `agentHost.js` 的单个 `let sessionAuth`（内存态，不落盘），出口在新增的 `answerConfirm`（先判空 `pendingConfirm`，避免切会话/卸载路径清掉后再点按钮抛 TypeError）。闸在新建的 `src/agent/confirm.js`：`canRememberSession(name)` 只对 `test_js` 为 true，`shouldSkipConfirmation(name, sessionAuth) = sessionAuth && canRememberSession(name)`，因此 workflow 写操作在授权在手时**仍逐次确认** —— 这条语义由 `confirm.test.js` 5 条用例钉住（含「授权在手也不能免掉画布写操作的确认」）。卡片侧只有 `kind === 'code'` 才出现复选框，勾选状态只活在卡片内、卡一关即消失；答案走 `{approved, remember}`，由 `normalizeAnswer` 归一化（严格 `=== true`，失败即拒）后再 resolve 给 loop。三个失效点齐了：`abort()`、`guardAgentSwitch()`（新建/切换/删除会话；置在 `resolve(false)` **之后**，否则会被 resolve 内部那次 `nextSessionAuth` 回写覆盖）、面板卸载（随闭包消失）。
  - 与 §8.2 的偏离：CSP 提示不写「严格 CSP 页面走 chrome.debugger 降级」，理由同 T-06 —— B6 未实现，不能向用户承诺一个不存在的能力。
  - **留给用户判断**：授权只绑会话、不绑目标页 —— 勾了之后换目标页（`onPickTab`）不会重新确认，而 §8.2 列的失效点里本来也没有它。要更保守就在 `onPickTab` 里一并清一次，本次未擅自加。
  - 实测：`npm test` 296 pass / 0 fail（原 282）、`npm run check:i18n` 通过、`npm run lint` 存量 1 error / 10 warning、`npm run build` exit=0。**复选框的实际交互未在真机点过**（需装扩展 + 配 key）。
- （2026-10-03 code-review 的 14 项修复不在本登记范围，见 git 历史与 `docs/adr/0001~0003`）

### B1 — 标题异步回写可能覆盖并发写入的会话事件 🚨 bug

来源：`docs/pie-agent-borrowing-practices.md` A3（2026-10-03 对 pie 调研发现）。
内容：`src/agent/index.js` 的 `generateTitleAsync().then` 用**整记录 save()** 回写，`events` 是首轮捕获的快照。若用户在标题生成期间发出第二轮，晚到的标题保存会用首轮事件覆盖第二轮已落盘的事件（最终一致性受损；标题本身正确）。
缓决原因：窗口小（标题请求只发一次、通常秒回），需要用户在亚秒级内发第二轮才触发。
重开条件：立即修——改为只 patch title 字段，或回写前校验会话 `lastAccessedAt`/事件数未增长。
结论：按「重开条件」落地 —— 标题回写不再用整记录 `save()`，改为 `sessionStore.patchTitle(id, title)` 只 patch title 键；同时 `sessions.js` 把 save / remove / patchTitle 串进同一条串行队列，晚到的标题写入被排到第二轮收尾 save 之后执行，天然只覆盖 title、覆盖不了 events。并修掉同一处闭包读到悬挂 currentSessionId 的幽灵会话（T-35）。局限：串行队列只保证单运行时实例内有序，跨实例（多标签页同时开同一工作流）仍靠 lastAccessedAt 的最后写入获胜，本轮未引入锁。`npm test` 350 pass / 0 fail。
状态：**已清（2026-10-05）**。

