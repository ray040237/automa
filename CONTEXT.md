# Automa 领域术语表(Glossary)

本文件只收本项目特有、易混淆的概念与**禁用词**。不含实现细节——实现问题去读对应模块顶部的"为什么"注释。

## 文档地图

改代码前按这个顺序找依据，**不要按文件名猜**：

| 想找什么 | 去哪 | 状态 |
| --- | --- | --- |
| 术语、禁用词、事件层的区别 | 本文件 + `AGENTS.md` | **现行** |
| 有意的架构决策与被拒备选 | `docs/adr/0001~0004` | **现行** |
| 工程流水线的配置（issue tracker / triage 标签 / 领域文档） | `docs/agents/` | **现行** |
| 模块怎么协作、事件在哪产生 | `docs/agent-architecture.html` | **现行**（页脚标最后核对日期） |
| 现在该做什么 / 已知欠账 | `docs/backlog.md` | **现行**（只放未完成） |
| 某个坑当初怎么被实测出来的 | `docs/backlog-done.md` | 档案，非待办 |
| 领域知识事实表（prompt 的依据） | `docs/agent-assist-tech-design.md` §6.2 | 现行（该文其余章节已过时，顶部有状态头） |
| `read_page` 的输出契约与分段预算 | `docs/agent-readpage-design.md` | 现行 |
| 选择器引擎重构提案 | `docs/selector-engine-redesign.md` | 待审核，与助手无关 |

已删除且不再保留的文档（git 可取回）：`agent-assist-rfc.md`（`4a573976`）、
`agent-multi-session-plan.md`（`4a573976`）、`agent-readpage-trace.md` 与
`agent-context-discussion-2026-10-04.md`（`a27f93de`）—— 均为实施前计划，已被 ADR 与实测取代。

## Agent 事件流(迁移后剩两层)

**provider 事件**:
pi-ai 产出的流内部事件(`text_delta` / `tool_execution_start` / `done` / `error`)。只在 `streamFn` 与 `loop.js` 之间流动,由 `fromPiEvent` 翻译成 agent 事件。
_Avoid_: agent 事件(那是下一层)、chunk。

**agent 事件**:
loop 产出的 `{ kind: 'agent:*' }` 事件(`AGENT_EVENTS`)。既是 UI 的唯一消费来源,也是**唯一的事件历史(history)**,不重复记账。
_Avoid_: transcript(该词已废弃,见下)、log、message。

**历史(history)**:
一次会话内累积的 agent 事件数组,由 loop 维护、runtime 在 send 收尾持久化进会话记录。跨轮续接 = 把它作为 `initialHistory` 传回,`loop.js` 的 `historyToPiMessages()` 负责翻译成 pi 的 transcript。
_Avoid_: "history" 不指展示消息。

> **2026-10-05 变更（ADR 0004 落地）**：第三层「wire 消息」**已删除**。`wire.js`、
> `llm/sse.js`、`llm/providers/openai-compat.js` 随票 08 从仓库消失。provider 参数
> （messages / tools / temperature / 重试）现在由 pi 从它自己的 transcript 生成,
> 我们不再现算。`AGENT.md` 里的「三层事件」表述同步改为两层。

**transcript**:
**已废弃**。曾指给 UI 折展示行的中间层(transcript.js,已删除);展示折叠现在内联在各宿主的渲染层。任何新代码不得再引入 "transcript" 命名。
_Avoid_: 一切使用。
_欠账_: `components/newtab/workflow/agent/AgentTranscript.vue` 仍是这个名字(本次沿用未改),别再往新文件里扩散这个词。

**md 渲染层**:
`src/agent/markdown.js` —— 零依赖的自实现 markdown 渲染器,`markdownToBlocks(raw)` 返回块数组(渲染只为给代码块单独挂复制按钮)。**安全契约:先转义再做行内替换,链接只放行 http/https/mailto**,所以 UI 侧 `v-html` 不再二次清洗。模型输出是不可信输入,改这个函数前先读 `markdown.test.js` 里那几条 XSS 断言。

## 会话

**自定义指令(instructions)**:
用户在设置页配置的一段持久文本(T-81a),每轮 send 现读后作为独立 section 拼进 system prompt(「# 输出约定」之后、「# 安全声明」之前)。它是**用户显式写入配置的内容,不属于「回显」**,因此不包 untrusted——这是 system prompt 三类白名单(常量/工具元数据/用户显式配置)修订后的第③类。安全声明保持全文末段,用户指令不能覆盖安全边界由结构保证。体积只有软限(8K 字符 UI 警告),永不硬截断。
_Avoid_: 把它叫「用户消息」(那是每轮的 untrusted_user_message);与「插话(instruction)」混用——插话是 busy 期间的补充消息,入队走 drainInstructions,切会话即丢。

**模板(command)**:
用户配置的 `/` 触发消息片段(T-81a),存 `automaAgentCommands`。选中后**整框替换**输入框草稿,发送前可改;一期不做 `$1`/`$@` 参数替换。纯 UI 机制,不进 system prompt、不碰 agent 核心。
_Avoid_: 把它叫 prompt/命令——「块命令」另有所指;与「自定义指令」混用(指令常驻,模板按需触发)。

**技能(skill)**:
用户导入的知识单元(T-81b),存 `automaAgentSkills`,形状 `{name, description, body, files, enabled}`。**两级注入**:system prompt 只放一行摘要(`# 可用技能` 索引区),正文由 `read_skill` 工具(class: read,group: context)按需取——正文经 `untrusted_tool_result` 包装,因为导入的技能可能是第三方产物,红线不豁免;「按技能办事」由索引区的说明交代,与安全声明冲突时以安全声明为准。`read_skill` 的观察值预算放宽到 32K(envelope 的 `maxChars` 覆盖,超限截断模型可见,不静默)。附带文件只收文本,二进制导入时拒收并上报。zip 往返与 pi / Claude Code 的 skill 文件夹形状互通。
_Avoid_: 把技能正文当可信指令(它走 untrusted 通道);把技能与模板混用(模板是输入片段,技能是按需知识)。

**会话(Session)**:
一条可回看的对话,`agent_session_<id>`(事件历史)+ `agent_session_index` 条目。持有 pins/focusedTabId/usage/title。
_Avoid_: chat(口语可用,持久命名不用)、conversation。

**轮(turn)**:
一次 `runtime.send()` = 一轮对话(一条用户消息到最终回答)。会话 = 多轮。
_Avoid_: 用"会话"指一轮。

**步(step)**:
一轮内的 ReAct 迭代。一步 = 一次模型调用 + 可能的工具执行。
不设步数上限:B9 第 1 项决策(2026-10-05 用户拍板),何时停止由用户决定。曾出现的 `MAX_STEPS = 12` 是从未接线的死代码,已随 T-75 删除——别再引入「看起来有保护、实际没生效」的护栏。
_Avoid_: 用"轮"指一步。

**插话(instruction)**:
busy 期间用户补充的指令,入队后在下一步开工前作为 user 消息注入。属于当时的会话上下文,切会话即丢弃。
_Avoid_: 中断消息、pending message。

**压缩摘要(compaction)**:
`agent:compaction` 事件(T-76,机制见 `docs/agent-compaction-spec.md`)。上下文估算越过阈值(`config.contextWindow` 驱动)时,把保留窗之外的老轮次压成一份结构化摘要事件,**插在切点处**入史——上面的老事件归摘要管,下面的保留窗原样进 transcript。`historyToPiMessages` 投影只认最后一条:它之前的全部事件不进 transcript;`cropToTurns` 把它当锚点,永不被 20 轮存储修剪裁掉。摘要内容是页面/工具/用户输入的派生物,投影进 transcript 时包 `untrusted_compaction_summary`(红线 2);provider 真报 context-overflow 时走「压缩一次 + `continue()` 续跑一轮」的恢复路径(只试一次)。
_Avoid_: 把压缩当「删除历史」——原始事件永不删除,只是不再进 transcript;把它叫 token 预算裁剪(那是旧 wire 层 window.js 的机制,已随 T-64 删除)。

## 页面定位

**目标页(targetTab)**:
agent 当前操作指向的标签页快照 `{id, url, title, windowId, favIconUrl?}`。工具执行读的是"这一刻"的快照。
`favIconUrl` 只给面板显示用（T-08），**任何判断都不得依赖它** —— 浏览器可能不给、加载也可能失败。
_Avoid_: activeTab(那是浏览器 UI 的概念)。

**pin**:
`{tabId, origin, title}`,会话级的目标页身份记录。**origin 是真身份,tabId 会被 Chrome 复用**——任何基于 tabId 的操作前必须校验 origin。
_Avoid_: 把 tabId 单独当 pin 用。

**预检(preStepNotice)**:
每步开工前的 advisory 检查(tab 存活、origin 漂移),产出 `system-notice` 由模型自决,**绝不硬停任务**(良性重定向链会误杀)。
_Avoid_: 把它叫"闸门/校验失败"。

## 工具

**工具组(group)**:
`page` / `context` / `tab` / `canvas`。canvas 组只在有画布的宿主注册。

**宿主(host)**:
agent 的挂载点,共两个,共用 `src/composable/agentHost.js` 的接线与 `AgentPanel.vue`:
① **独立助手页**(主面板标签页 `/workflows/agent`)——无画布,canvas 组不注册,
会话归属全局(`getWorkflowId: () => null`);② **编辑器侧栏**(`workflows/[id].vue`
右侧可拖拽 sidebar)——握着画布句柄,canvas 组开放,会话按 `workflowId` 过滤。
两者差别只在 `enabledGroups` 与有没有 `canvas` 那四个句柄。

**工具 class**:
`read`(免确认)/ `write`(过确认门)。缺失或未知一律按需确认处理;模块加载期 `validateTools` 强制显式声明。
_Avoid_: 第三档分类(曾提议 soft-write,被拒,见 docs/adr/0002)。

**工具的 ctx 声明**:
每个工具定义必须带 `ctx: ['键', …]`,列出 execute 需要的 toolCtx 键 —— 这是工具与装配层的 interface 契约。两级校验:声明形状(缺/非字符串数组)由 `validateTools` 在模块加载期拦;键绑定(声明的键在 toolCtx 里不存在)由 `toAgentTools` 在装配期拦,点名工具与键 —— canvas 句柄漏传在这里炸,而不是执行期静默退化。
_Avoid_: 「用到什么自己知道,不用声明」;缺省静默兜底。

**活值(ctx 里的动态值)**:
toolCtx 里「工具要读到这一刻的值」(targetTab / pins / editor)一律用 **JS getter** 提供。adapter 每次 execute `{...toolCtx}` spread 会**求值 getter**,工具拿到的就是本步执行时刻的快照 —— 这是唯一的活值习语。
_Avoid_: 函数式取新(`ctx.pins()`)。T-70 的根因:「getter」一词在两侧各说各话(tabs.js 要函数、index.js 给 JS getter),focus_tab 生产全挂而夹具按函数传所以全绿 —— 同一个词出现两种理解时,必须有一条跨 seam 的回归测试钉住真实链路。

**确认门(requestConfirmation)**:
write 工具执行前的用户裁决,以 pending promise 挂在宿主。闸的判定收在 `requiresConfirmation`(tools/index.js,ADR 0002 点名的执行者);展示载荷由 confirm.js 组装,各写类工具用 `confirmDetail(args)` 自带「用户在放行什么」的事实(kind/detail,`validateTools` 强制 write ⇒ confirmDetail),name/targetTitle/canRemember 由 confirm.js 钉死不许工具覆盖。**只要卡片变得不可达就必须先 `resolve(false)`** —— 三个入口:切会话(`guardAgentSwitch`)、宿主卸载(`agentHost` 的 `onBeforeUnmount`)、**卡片所在的 `AgentPanel.vue` 自身被卸载**(切走助手面板/打开块编辑卡/收起侧栏都是 `v-if` 真卸载)。缺任何一个,loop 都会永远 await,那一轮不收尾也不落盘,表现与「助手卡死」无异(T-02)。
_Avoid_: 「卡片被藏起来了,先挂着等用户切回来再批」——切回来之前 loop 已经永久挂起;在工具外另建「哪个参数危险」的映射表(知识归工具自身)。

**观察值(observation)**:
工具结果经 untrusted 包装 + 8K 截断后喂回模型的形式。工具抛错转成 error 观察值让模型自纠,不终止循环。
_Avoid_: result(与 tool_call_id 配对的 wire tool 消息易混)。

**通道超时兜底(channel timeout)**:
每条跨进程通道的**发送侧**都有硬超时,且**外层必须大于内层**:页内求值 10s → background `executeScript` 15s(`AGENT_PAGE_TIMEOUT_MS`)与 `tabs.sendMessage` 15s(`TAB_CHANNEL_TIMEOUT_MS`)→ 发送侧 `toBackground` round trip 20s(`BACKGROUND_CHANNEL_TIMEOUT_MS`)。超时一律回 `{ok:false, error}` 的**人话观察值**而不是 reject —— 模型拿到「这一步是否已执行无法确认」才知道先读页再决定,抛栈只会让它原地重调。根因(如 SW 回程丢失)不会因此消失,但任何一层失灵都不能再把整轮 agent 挂死(T-39)。

## 安全

**untrusted 包装**:
一切第三方数据(页面正文、工具返回、用户输入回显)进 prompt 前必须包 `<untrusted_*>` 标签并做逃逸清洗(escapeUntrustedWrappers)。新增标签必须登记进 `UNTRUSTED_WRAPPER_TAGS`(当前 8 个,由测试钉死;`untrusted_compaction_summary` 是 T-76 的压缩摘要投影用)。

**G5 红线**:
**agent 永远不能保存工作流**。只许改内存画布(且仅限有画布的宿主),由用户看过后自己保存。任何 `saveWorkflow` / `workflowStore.update` 出现在 agent 可达路径上都是违反。
_Avoid_: "代用户保存"的一切委婉说法。
