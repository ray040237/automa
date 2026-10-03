# Automa 领域术语表(Glossary)

本文件只收本项目特有、易混淆的概念与**禁用词**。不含实现细节——实现问题去读对应模块顶部的"为什么"注释。

## Agent 事件流(三层,绝不可混用)

**provider 事件**:
`openai-compat.js` 产出的流内部事件(`text-delta` / `tool-call-delta` / `done` / `error` / `usage`)。只在 `llm/` 与 `loop.js` 之间流动。
_Avoid_: agent 事件(那是下一层)、chunk(口语可指它,但持久命名不用)。

**agent 事件**:
loop 产出的 `{ kind: 'agent:*' }` 事件(`AGENT_EVENTS`)。既是 UI 的唯一消费来源,也是**唯一的事件历史(history)**——UI 与 wire 都从它派生,不重复记账。
_Avoid_: transcript(该词已废弃,见下)、log、message。

**wire 消息**:
`wire.js` 从事件历史**现算**的 OpenAI chat messages(`role`/`content`/`tool_calls`)。只为发给模型,不可持久化、不可直接渲染。
_Avoid_: 把 wire 消息称为 "history"(见下)。

**历史(history)**:
一次会话内累积的 agent 事件数组,由 loop 维护、runtime 在 send 收尾持久化进会话记录。跨轮续接 = 把它作为 `initialHistory` 传回。
_Avoid_: "history" 不指展示消息、不指 wire。

**transcript**:
**已废弃**。曾指给 UI 折展示行的中间层(transcript.js,已删除);展示折叠现在内联在各宿主的渲染层。任何新代码不得再引入 "transcript" 命名。
_Avoid_: 一切使用。
_欠账_: `components/newtab/workflow/agent/AgentTranscript.vue` 仍是这个名字(本次沿用未改),别再往新文件里扩散这个词。

**md 渲染层**:
`src/agent/markdown.js` —— 零依赖的自实现 markdown 渲染器,`markdownToBlocks(raw)` 返回块数组(渲染只为给代码块单独挂复制按钮)。**安全契约:先转义再做行内替换,链接只放行 http/https/mailto**,所以 UI 侧 `v-html` 不再二次清洗。模型输出是不可信输入,改这个函数前先读 `markdown.test.js` 里那几条 XSS 断言。

## 会话

**会话(Session)**:
一条可回看的对话,`agent_session_<id>`(事件历史)+ `agent_session_index` 条目。持有 pins/focusedTabId/usage/title。
_Avoid_: chat(口语可用,持久命名不用)、conversation。

**轮(turn)**:
一次 `runtime.send()` = 一轮对话(一条用户消息到最终回答)。会话 = 多轮。
_Avoid_: 用"会话"指一轮。

**步(step)**:
一轮内的 ReAct 迭代(`MAX_STEPS=12` 封顶)。一步 = 一次模型调用 + 可能的工具执行。
_Avoid_: 用"轮"指一步。

**插话(instruction)**:
busy 期间用户补充的指令,入队后在下一步开工前作为 user 消息注入。属于当时的会话上下文,切会话即丢弃。
_Avoid_: 中断消息、pending message。

## 页面定位

**目标页(targetTab)**:
agent 当前操作指向的标签页快照 `{id, url, title, windowId}`。工具执行读的是"这一刻"的快照。
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

**确认门(requestConfirmation)**:
write 工具执行前的用户裁决,以 pending promise 挂在宿主;切会话/卸载前必须先 `resolve(false)`,否则 loop 永远 await。

**观察值(observation)**:
工具结果经 untrusted 包装 + 8K 截断后喂回模型的形式。工具抛错转成 error 观察值让模型自纠,不终止循环。
_Avoid_: result(与 tool_call_id 配对的 wire tool 消息易混)。

## 安全

**untrusted 包装**:
一切第三方数据(页面正文、工具返回、用户输入回显)进 prompt 前必须包 `<untrusted_*>` 标签并做逃逸清洗(escapeUntrustedWrappers)。新增标签必须登记进 `UNTRUSTED_WRAPPER_TAGS`(当前 7 个,由测试钉死)。

**G5 红线**:
**agent 永远不能保存工作流**。只许改内存画布(且仅限有画布的宿主),由用户看过后自己保存。任何 `saveWorkflow` / `workflowStore.update` 出现在 agent 可达路径上都是违反。
_Avoid_: "代用户保存"的一切委婉说法。
