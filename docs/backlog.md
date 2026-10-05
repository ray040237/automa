# 待办登记（会话捕获）

对话中发现的 **bug**、用户提出的 **改进** 与 **新功能** 一律先落在这里，由用户审核后再动代码。流程见 `AGENTS.md`「发现即登记」。

> 编号分工：**T 编号** = 全仓库范围的会话捕获；**B 编号** = 内置助手功能自身的已知欠账（原 `docs/agent-backlog.md`，2026-10-04 合并进本文件，编号与格式沿用，见文末「B 编号」区）。两区不混写。

> **本文件只放未完成的条目。** 已解决的条目在 **`docs/backlog-done.md`**（2026-10-05 拆出）——
> 那里保留完整的现象、实测证据与结论，用于追溯「当初为什么这么定」。
> 状态流转：待审核 → 已批准（待排期） → 进行中 → **完成时整条移入 `backlog-done.md`**。

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
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `src/components/newtab/workflow/agent/AgentPanel.vue:4-22`、`docs/agent-assist-tech-design.md` §3.2「配套 UI」
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
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `AgentMarkdown.vue:24-28`、`docs/agent-assist-tech-design.md` §9.1 面板骨架（该节已标注作废，承诺本身仍有效）
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

### T-46 — `buildWireMessages → elide → budget` 的顺序知识留在调用方

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 架构评审候选 4，触发点 `src/agent/loop.js:408-411`
现象：每步 loop 都要手写三层嵌套 `applyTokenBudget(elideStaleObservations(buildWireMessages(history, {system})), {contextWindow})`，且顺序不能反（`:406-407` 的注释记着这是 T-24 的教训）。接口是一串函数组合，「怎么组合」是只有实现才知道的知识却写在调用方，下一个调用点会重新踩一遍。
证据：**静态** —— `loop.js:406-411` 的注释与嵌套调用确认；三个诊断数字（`estimated` / `threshold` / `dropped`）目前只进 `log('budget')`，测试断言不到。**性能理由已被实测否掉**（该实测为评审文档所载，本轮未复跑）：合成 12 步 × 8K 快照跑完整管线 20 次取平均，单次 0.10–0.13 ms，`estimateTokens` 单次 0.036 ms，且 elide 先出手把估算压到 8.9K、远低于 25.6K 阈值，压根进不了 while 循环。
影响：真实危害小，纯接口洁癖。
建议：若将来要动，只动接口 —— 一个 `buildModelView({history, system, contextWindow})` 返回 `{messages, diagnostics}`，顺序收进实现、诊断数字变成可断言的返回值。**本轮不建议排期**，登记备查。
状态：待审核

### T-52 — 工具卡永远不显示调用参数：`TOOL_CALL`/`TOOL_RESULT` 事件都不带 `args`

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 用户问「UI 当前的实现方法怎么样」时逐层核对工具卡数据链，触发点 `src/agent/loop.js:191-197`（`runningEv`）、`:137-157`（`resultEvent`）、`AgentToolStep.vue:44-52`
现象：展开任何工具卡，`<pre>` 参数区**永远是空的**，只有观察值。用户看不到模型到底传了什么参数 —— `query_elements` 的 selector、`read_page` 的 detail 档、`test_js` 的代码全部不可见（`test_js` 因为过确认门，参数在确认卡上能看到，纯 read 工具则完全没有）。
证据：**实测** —— `.scratch/args-probe.mjs` 用真 `createAgent` 跑一轮（真 `loop.js`、真 `wrapUntrusted`、桩 provider 发一个 `query_elements({selector:'li.book'})`），逐条打印工具事件：
```
agent:tool-call    | status=running | args=undefined | 有 args 键=false
agent:tool-result| status=ok      | args=undefined | 有 args 键=false
TOOL_CALL 事件里带 args 的数量: 0 / 1
```
**代码链路核对（三处都对不上）**：① `loop.js:191-197` 的 `runningEv` 是手写字面量，字段只有 `kind/step/name/toolCallId/status`；② `loop.js:137-157` 的 `resultEvent` 返回 `{...meta, kind, step, name, toolCallId, status, observation}`，同样没有 `args`；③ `failEvent`（`:161-170`）亦然。**唯一带 `args` 的产出点是 `toAgentEvent` 的 `tool-call-delta` 分支（`loop.js:70-77`），而它在生产路径上永远到不了** —— `loop.js:442-445` 先把 `tool-call-delta` chunk 收进 `pendingToolCalls` 然后 `continue`，从不调 `toAgentEvent`；只有 `loop.test.js:103` 直接调它才走得到。消费端因此恒空：`AgentTranscript.vue:163` 取 `ev.args`（undefined）→ `AgentToolStep.vue:45` 的 `!a` 命中 → `prettyArgs` 返回 `''` → `:22` 的 `<pre v-if="prettyArgs">` 永不渲染。
影响：用户批准与判断的依据缺一块。`test_js` 尚可从确认卡补回，纯 read 工具（`query_elements` / `read_page` / `find_text`）的参数只能从观察值里反推，而观察值是 8K 截断过的页面正文 —— 参数与结果的对应关系断了。这也让 T-52 与 T-07（观察值里的 `untrusted_*` 标签原样摊给用户）叠加后更糟：用户既看到包装标签，又看不到自己传了什么。
建议：
- `runningEv` 与 `resultEvent`/`failEvent` 三处都补上 `args: call.args`。`call.args` 在 `executeCall` 之前已由 `loop.js:521` 赋值，所以值一定拿得到，**只是没人把它放进事件**。
- 补一条 loop 级断言（这是本条该有的防线）：`tool-result` 事件的 `args` 必须与桩工具收到的实参 `deepEqual` —— 现有 `loop.test.js` 没有一条断言事件的 `args`，所以这个洞一直没被测出来。
- 顺手考虑：`TOOL_RESULT` 事件现在既不带 `args` 也不带耗时，`AgentToolStep` 想显示「这次调用花了多久 / 返回多少字符」也无从取值（`loop.js:227-233` 的 `obsChars` 只进了 `log`）。要不要一起补由用户定。
状态：待审核

### T-53 — 事件流 → 渲染槽位的折叠层是全仓分支最多的 UI 逻辑，却写死在 `.vue` 里测不到

类型：改进
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

### T-50 — `get_variables` 在所有宿主下都是死工具，`workflowContext` 从未传给 prompt

类型：bug
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

### T-51 — 画布组锁死在 dashboard 的 `[id].vue` 进程内，跨宿主要「代理」而非「接线」

类型：新功能（架构决策）
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

### T-49 — 把助手对话界面搬到浏览器原生侧边栏（Chrome `sidePanel` / Firefox `sidebar_action`）

类型：新功能
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

### T-54 — 第三方参考仓库 `pi/` 未 gitignore，把 `npm run lint` 打成 6 个 parsing error

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 文档整理后跑 `npm run lint` 发现，触发点仓库根目录 `pi/`
现象：`npm run lint` 报 1 error + 10 warnings，其中 **6 个 error 全部来自 `pi/`** —— 一个第三方 monorepo（`pi-monorepo`，22MB，自带 `.git`，创建于 2026-10-05 04:41）。它是未跟踪状态（`git status` 显示 `?? pi/`），既没进 `.gitignore` 也没进 `.eslintignore`，eslint 于是照常扫它。这些文件不用本项目的 babel 配置，于是每个都报 `Parsing error: No Babel config file detected`。
证据：**实测（`npm run lint` 输出）** —— 6 条 parsing error 分布在 `pi/packages/ai/bedrock-provider.js`、`pi/packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.js`、`pi/packages/coding-agent/src/core/export-html/template.js`、`.../vendor/highlight.min.js`、`.../vendor/marked.min.js`、`pi/scripts/sync-versions.js`；`git ls-files pi` 返回 0 条（完全未跟踪）。第 7 个 error 是存量的 `src/lib/dayjs.js:11`（prettier 缺分号，即 T-31）。
影响：① 提交前检查（`AGENTS.md` 要求 lint-staged 前跑 lint）恒红，且**红的理由与本项目代码无关** —— 这正是 T-31 说的「形同虚设」，本条让它恶化一倍；② 22MB 未跟踪目录有被 `git add .` 误提交进版本库的风险（`pie-ai-agent` 当初正是靠 `.gitignore` 才没出事）；③ 沿用「lint 只有 1 个 error」的既有印象会严重低估 —— 实际是 7 个。
建议：把 `pi/` 当作与 `/pie-ai-agent` 同类的只读参考仓库，在 `.gitignore` 加 `/pi`；若要留痕则在 `AGENTS.md` 的只读第三方仓库红线下与 `/pie-ai-agent` 并列写一句。**不建议**只加 `.eslintignore` —— 那只挡 lint，挡不住误提交。
状态：**已修复** —— `.gitignore:52-57` 已加 `/pi`（并注明运行时依赖走 npm 装 `@earendil-works/pi-*`，本地 clone 仅供查阅与跑 PoC）。

### T-55 — `loop.js` 默认 `wrapUntrusted` 兜底不做 escape，漏注入即静默失去注入防护

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 pi-agent-core 迁移可行性核查，触发点 `src/agent/loop.js:268`
现象：`createAgent(deps)` 的默认参数里 `wrapUntrusted = (tag, body) => '<'+tag+'>'+body+'</'+tag+'>'`，**不做任何逃逸清洗**。真版由 `src/agent/index.js:26` 注入的 `wrapUntrusted`（`untrusted.js:87-100`，内含 `escapeUntrustedWrappers`）兜住。现状安全，但只要有人调 `createAgent` 时漏注入这个依赖，就得到一个「看起来在工作、实际零防护」的版本 —— 页面正文里的 `</untrusted_page_content>` 能直接闭合标签。
证据：**代码位置 + 实测确认现状** —— `loop.js:268`（无 escape 的默认兜底）、`index.js:26`（真版注入）、`untrusted.js:99`（真版内部 `escapeUntrustedWrappers`）。`untrusted.test.js` 8 类攻击面全绿，说明注入路径本身有效；本条说的是**注入缺失时没有任何机制会响**。
影响：命中即违反 `AGENTS.md` 红线第2 条（第三方内容一律 untrusted 包裹）。最坏结果是提示注入静默生效，且没有任何测试变红 —— 因为测的是注入后的路径。重构（换pi 内核）时这个默认兜底极易被漏掉。
建议：删掉 `loop.js:268` 的默认兜底，改为缺注入直接 throw。代价约 3 行；`createAgent` 少一个可选参数。
状态：待审核

### T-56 — `wire.js` 的 `ev.wire || ev.text` 是无守卫的裸文本回落通道

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 pi-agent-core 迁移可行性核查，触发点 `src/agent/wire.js:109`、`:116`
现象：`buildWireMessages` 转换 `agent:user-message` 与 `agent:system-notice` 事件时用 `content: ev.wire || ev.text || ''`。**任何不带 `wire` 字段的事件会把裸 `text` 未包装地发给模型** —— 绕过 `wrapUntrusted('untrusted_user_message', ...)`。
证据：**代码位置，未实测触发** —— `wire.js:109`（user-message）、`:116`（system-notice）。当前无触发者：两个生产者 `loop.js:343-350` 与 `:394-401` 都带 `wire`，且 `sessions.js:193` 整份 events 落盘/读回时 `wire` 字段会跟着活下来。属**潜在**缺陷，非现存 bug。
影响：一旦有人新增事件生产者而忘了填 `wire`，用户输入或系统事实就裸奔进 prompt，违反红线第 2 条，且无测试报警（现有 `wire.test.js:30-52` 只测带 `wire` 的路径）。
建议：缺 `wire` 时 throw 而非回落 `text`；或把 `|| ev.text` 直接删掉，让缺字段立刻暴露。代价约 2 行。
状态：待审核

### T-57 — `untrusted.test.js` 只钉 `length === 7`，与红线「清单被测试钉死」有落差

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 pi-agent-core 迁移可行性核查，触发点 `src/agent/untrusted.test.js:137-139`
现象：`AGENTS.md` 红线第 2 条写「`UNTRUSTED_WRAPPER_TAGS`（当前 7 个，**被测试钉死**）」，但测试只断言 `UNTRUSTED_WRAPPER_TAGS.length === 7`。**删掉一个标签再补一个别的，测试仍然全绿** —— 因为长度没变。
证据：**实测** —— `untrusted.test.js:137-139` 断言 `length === 7`；且 `untrusted.test.js:91-94` 明确断言**未登记标签原样通过**（证明删标签不会触发任何现有断言）。实际清单见 `untrusted.js:28-34`（`untrusted_page_content` / `untrusted_tab_metadata` / `untrusted_workflow_context` / `untrusted_user_message` / `untrusted_tool_result` / `untrusted_compacted_steps` / `untrusted_system_notice`）。
影响：红线的强度被高估。清单是「模型能识别的边界」的唯一声明处，误删一个标签（如 `untrusted_tool_result`）会让该类内容对模型失去结构化边界，且测试不响。
建议：断言改为钉住 7 个标签名与顺序（`deepEqual` 全数组）。代价约 10 行；会与「新增标签需同步改测试」形成刻意的摩擦，这正是想要的效果。
状态：待审核

### T-58 — `untrusted.js:6` 头注释写「6 个标签」，代码里是 7 个

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 pi-agent-core 迁移可行性核查，触发点 `src/agent/untrusted.js:6`
现象：文件头注释写「20 个标签 -> 本项目实际使用的 6 个」，而 `UNTRUSTED_WRAPPER_TAGS`（`:27-35`）实际有 7 个。`untrusted_system_notice`（`:34`）是后加的，注释没跟上。
证据：**实测** —— `untrusted.js:6`（注释写 6）vs `untrusted.js:27-35`（数组 7 项），`untrusted.test.js:137` 也断言 7。纯注释失同步，不影响运行时行为。
影响：读注释的人会对「清单里有什么」判断错误；这类失同步会误导后续维护者以为某个标签不存在。
建议：把注释里的「6 个」改成 7 个。代价 1 个词。
状态：待审核

## 已批准（待排期）

（暂无）

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

内容（三项，同一次决策的三个侧面）：

1. **无 token 预算裁剪、无步数上限**（原 Q7=B）。pi-agent-core 实测**没有任何默认行为**：`transformContext` 只是个回调位置，pi 从不自己调它做任何事；也没有 `MAX_STEPS` 等价物。后果：长对话直接撞 provider context 上限（主用 ModelScope 是 128k，页面正文动辄几万 token）；模型可无限工具循环，只有用户手点停止。**注**：`window.js` 的裁剪与 T-01/B2 的「纵深防御」注释都建立在这个前提上，去掉它等于把纵深防御一起去掉。
2. **`ERROR_KIND` 六种分类降级**（Q1=B 的连带后果）。实测 pi 的 openai-completions 失败路径上 `diagnostics` 恒为 `undefined`（只有 bedrock / pi-messages / codex-responses 三个 adapter 写它），`onResponse` 在 `await retryProviderRequest(...)` **之后**调用因而对 401/429 一次都不触发，`AssistantMessage` 上唯一可靠的只有 `stopReason`（`error`/`aborted` 两值）+ `errorMessage` 字符串。pi 自己做分类靠 `retry.ts:30-102` 约 60 条正则。后果：配置缺失要与 provider 401 区分、429 配额耗尽要与真限流区分，都得靠我们自己对字符串做正则反解 —— 而现状 `classifyHttpError` 直接拿得到 status 与 body全文，信息更全。
3. **丢掉全部 364 条测试的回归保护**（Q11=C）。`docs/backlog-done.md` 里 44 条已解决条目每条背后都有一条测试。重写期间若新代码有 bug，**没有旧测试能回答「这里本来是对的」**。缓解措施：基线快照在 `.scratch/agent-baseline/`（来自 commit `894ec164`，`.scratch/` 已 gitignore），配`.scratch/run-baseline-tests.mjs`。**该快照不在版本库里，换机器就没了** —— 若这批欠账要长期跟踪，重构落地时应把关键断言补成新测试并说明它们替代了哪条旧断言。

缓决原因：用户的目标是「拿到更成熟的上下文管理与鲁棒性」（并行工具执行、truncation 保护、steering 队列、更完善的悬空 tool_calls 净化 —— `transform-messages.ts:158-186` 这几项实测 pi 确实强于现状），且明确接受用体积（+414 KB min）与上述代价换取。
重开条件（任一命中即应重开）：
- 用户报告长对话撞 context 上限，或模型陷入工具循环
- `ERROR_KIND` 降级导致错误提示无法区分（联系 T-04：那条已经在抱怨错误渲染太弱）
- 重构后出现「说不清是新引入还是存量」的问题，且基线快照已不在本机
状态：待决策（重构完成后逐条评估是否补回）。

---

## 已清 → `docs/backlog-done.md`

44 条已解决条目（T-02、T-05、T-06、T-17~T-25、T-26~T-34、T-35~T-43、T-44、T-45、T-47、T-48，以及 B1、B5）已移入 **`docs/backlog-done.md`**（2026-10-05）。

要看「某个坑当初是怎么被实测出来的」，去那个文件；要看「现在该做什么」，留在本文件。

