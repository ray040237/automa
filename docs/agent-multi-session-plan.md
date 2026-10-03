# Agent 多会话 + 标签页定位方案

参考 pie-ai-agent 实现(`src/lib/sessions/*`、`src/lib/agent/tools/tabs.ts`、`src/background/index.ts` chat-start 段),结合 Automa 的宿主形态(newtab 页内运行 loop)裁剪。

## 0. 现状与问题

| 问题 | 现状 | 根因 |
|---|---|---|
| 无跨轮记忆 | 模型看不到上一轮,但 UI 是连续 transcript | `createAgentRuntime.send` 每次 `createAgent` 新建,`loop.js` 的 `history` 每次 `send()` 清空 |
| 标签页定位脆弱 | 靠面板手选一次,`targetTab` 是快照 | tab 导航/关闭后 agent 仍在用旧快照;无 origin 校验;模型不能自主开/切页 |
| 无多页操作 | 一次只能盯一个 tab | 工具上下文只有单个 `targetTab` |

## 1. pie 的设计要点(阅读结论)

### 1.1 会话数据模型(types.ts)——三份存储、两类状态

- `SessionMeta`(panel 写):展示用消息历史 `messages`、标题、pin、会话状态机。
- `SessionAgentState`(SW 写):**在途任务**的 LLM IR(`agentMessages`)。关键:**不是跨任务累积**——每个任务从 `[system, user]` 重新开始,任务结束写墓碑。
- `SessionIndexEntry`:轻量索引(id/标题/lastAccessedAt/pinnedTabIds),列表渲染一次读,不扫全量。
- 会话状态机 `active/paused/failed/archived`,**任务完成不改会话状态**(done 只是消息历史里的一条)。
- 拆两份的动机:两个写者(panel 持久化消息 vs SW 写步骤快照)read-modify-write 同一个 key 会互相覆盖(他们真踩过,AD1 fix)。

### 1.2 跨任务记忆 = 两条通道

1. **display history 重建**(`transcript/history.ts` `displayToChatHistory`):每次 chat-start 把完整展示历史投影成 wire 历史,**只保留 user/assistant 行,工具结果全部丢弃**。
2. **lastTaskSynth**(SW-only):任务成功/失败收尾时,SW 把"上一个任务做了什么"合成一段 assistant turn(包 `<untrusted_prior_task_summary>`),存在 agent state;下一次 chat-start **一次性消费**注入(插在最后一条 user 之前),然后清掉。abort 不生成 synth(与 abort 续接的 raw 历史互斥)。

### 1.3 标签页定位(pin 体系)

- **三态 pinMode**(`pin-state.ts`):
  - `auto`:不持久化,默认。UI 实时预览 active tab,注册表跳过。
  - `task`:chat-start 时捕获 active tab 冻结成 pin(`capture-active-pinned.ts`:解析 origin、chrome:// 等受限页记 `origin:""` 的合法 pin、`tab.id < 0` 拒绝),任务结束自动回 auto。
  - `user`:用户在下拉里手选,跨任务存续,drift 检查跳过(用户意图就是固定的)。
- **多 pin 数组** `pinnedTabs: [{tabId, origin}]`:`open_url` 开的新页自动 append;`focus_tab` 工具只改会话内部的焦点指针(`currentFocusTabId`),下一轮迭代按它取快照——与 `activate_tab`(只给用户看,不改操作目标)刻意区分。
- **漂移检查是 advisory**(`loop.ts` `interpretPinnedTabUrl`):每轮迭代检查焦点 tab 的真实 URL,origin 不匹配/受限页/tab 已关 → 产出一条 `<system_notice>` 观察值喂给模型,**由模型决定继续/恢复/失败,绝不硬停任务**。硬停版本被"良性重定向链(子站→主站→跳回)"误杀过。瞬态 URL(`about:blank`)先等 settle 再判。
- **跨会话锁**(M3-U4):写类工具执行前查"其他会话 pin 住的 tab"集合(从 session_index 一次读出),拒绝动别人正在用的页;锁范围用 `runningSessionIds` 收窄——**空闲会话不挡人**,只有真正在跑的会话才算 owner。
- Tab 工具组:`list_tabs / focus_tab / open_url / close_tabs / activate_tab / group_tabs…`(tools/tabs.ts),工具描述里花大篇幅教模型 focus vs activate 的区别与何时用哪个。

## 2. Automa 移植方案

### 2.1 与 pie 的结构性差异(决定裁剪)

| pie | Automa | 影响 |
|---|---|---|
| loop 跑在 MV3 SW,随时被杀 | loop 跑在 newtab 页,页面在 loop 就在 | **整套 paused/断点续跑/冷启动扫描先不做**;在途 IR 不需要持久化 |
| IndexedDB | 已有 `browser.storage.local` | 键布局照抄,存储引擎不换 |
| wire 历史每次从 display history 重建,**丢工具结果** | 已有 `buildWireMessages` 从事件历史现算,**保留工具结果** | 这是我们的优势,续接历史直接复用,别学 pie 丢结果 |
| 单一 sidepanel 宿主 | 面板在每个工作流编辑器里 | 会话按 workflow 维度组织 |

### 2.2 P1:多会话与跨轮记忆

**存储键布局**(browser.storage.local,复用 `configIO` 风格的 IO 注入以便单测):

```
agent_session_index                 // [{id, workflowId, title, lastAccessedAt, messageCount, status}]
agent_session_<id>                  // { id, workflowId, title, createdAt, lastAccessedAt,
                                    //   status: 'active'|'archived', events: AgentEvent[] }
```

- `events` 直接存 agent 事件历史(`AGENT_EVENTS` 系列)——UI 渲染和 wire 现算用的是同一份,单源不重复记账(保持 loop.js 顶部注释的既有不变式)。
- 用户消息进历史:`AGENT_EVENTS` 新增 `USER_MESSAGE`(`agent:user-message`),由 runtime push;`wire.js` 折成 `role:'user'`,`transcript.js` 折成 user 气泡。宿主里现在手动 push 的 `userMessage:true` 假事件取消。
- 裁剪:events 超过 ~300 条时从最旧一整轮起丢(保持 wire 配对不变式);单条 observation 已有 8K 截断。

**runtime 改动**(index.js,核心就这一处):

```js
// createAgentRuntime 内
let history = loadSessionEvents();   // 会话续接:上一轮的 agent 事件全量带入
send() {
  const agent = createAgent({ ..., initialHistory: history });
  const doneEv = await agent.send(...);
  history = agent.getHistory();      // 收尾后写回 storage
}
```

`loop.js` 的 `send` 接受 `initialHistory`(默认 `[]`),替换现在的 `const history = []`。system prompt 与每轮 seed(buildUserMessage 含当时的 tab 元数据/workflow 上下文)保持每轮新生成——和 pie 的"任务总是最后一行"一致。

**必须补的一个净化**:上一轮若被 abort/中断,history 末尾可能出现"带 tool_calls 的 assistant 却没有对应 tool 消息"——`buildWireMessages` 发出去会 400。在 wire.js 或 send 入口加一步:丢弃末尾未配对的 tool_calls 事件(或合成一条 `rejected` tool 观察),与现有 OpenAI 配对约束同一处收口。

**UI**(AgentPanel + [id].vue):

- 面板顶部加会话切换器:新建 / 历史列表(标题+时间,读 index)/ 删除(软删→archived)。
- 会话按当前 workflowId 过滤;新建会话默认无标题,取首条用户消息前 20 字做标题(pie 的 `deriveTitleFromMessages` 同思路,不调 LLM)。
- busy 时禁止切会话;切走前若有 `pendingConfirm`,先 `resolve(false)`。
- runtime 从"页面局部"变成"按会话实例化":`[id].vue` 持 `runtimeBySession`,或切换时重建 runtime 并 `setTargetTab`(tab 快照跟随会话存)。

**token 预算**:历史变长后 `applyTokenBudget`(默认 32k 窗口)+ `elideStaleObservations` 自然生效;同时把设计文档里承诺的 `contextWindow` 配置项落地(config.js 加字段、SettingsAgent 加输入、loop 传给 applyTokenBudget),否则多轮很快在默认窗口里互相挤压。

### 2.3 P2:标签页定位(pin 体系裁剪为两态)

**pinMode 砍成 `auto` / `user`**:pie 的 `task` 态解决的是"SW 存续期间 pin 生命周期",Automa 的 loop 生命周期就是页面生命周期,与 auto 合并无损失。

- **发送时捕获**(auto 态):复用现有 `resolveTargetTab` 的四级优先级,但补上 pie `captureActivePinnedTab` 的两个教训:① `tab.id < 0`/非整数直接放弃(chrome 会话恢复会产生 -1);② 受限页(chrome:// 等)是**合法 pin**,记 `origin:''`,不然 pin 栏没东西可显示、后续检查没基准。捕获结果 `{tabId, origin}` 存进会话 meta。
- **user 态**:现有 TabPicker 保留,选中即进入 user 态(跨轮存续,直到用户手动取消),与 pie `togglePinTabUserMode` 语义一致。
- **每步 origin 校验(advisory)**:`executeCall` 前(或每步循环开头)对 `toolCtx.targetTab` 重新 `tabs.get`,校验:
  - tab 没了 → 注入 notice:「目标页已关闭,请用 open_url 或让用户重选」;
  - origin 与 pin 不一致 → 注入 notice:告知新 origin,模型自决(很可能就是用户自己导航走了)。
  - notice 的落地方式:新的 agent 事件 `agent:system-notice`,`wire.js` 折成 `role:'user'`(或 `role:'system'`?→ 用 user,兼容端点对多 system 支持参差)并包 untrusted 标签;transcript 折成 notice 行。
- **新工具**(走 background 通道,均 class:'write' 过确认门,与现有 `agent:run-js` 同通道模式):
  - `focus_tab(tabId)`:只改 `toolCtx.targetTab`(经 `setTargetTab`),限 `pinnedTabs` 内;系统提示里写清"下一个工具调用才生效"。
  - `open_url(url)`:background `browser.tabs.create`,成功后自动 append 进会话 `pinnedTabs` 并 focus(pie 的 open_url 同语义)。
  - `list_tabs` 已有(`listTargetableTabs`),包一层工具即可。
- **tabId 复用风险**:Chrome 会复用已关闭 tab 的 id。因此 pin 必须存 `{tabId, origin}` 且**每次执行前校验 origin**,不能裸信 tabId——这条 pie 用 origin 对比解决,直接照搬。
- **跨会话锁**:单扩展只有一个面板宿主,多会话并跑的形态是"同一个编辑器里两个会话轮流跑"。P2 先做轻量版:runtime 记录本会话 pinnedTabIds,`test_js/highlight` 等写类工具执行时如果目标 tab 在**另一个 runtime 实例的在途集合**里,返回 error 观察值。完整的 registry + runningSessionIds 收窄留到真有多面板场景再说。

### 2.4 P3(可选,暂不排期)

- busy 中插话队列(pie `pendingInstructions`:每步循环顶 drain,合进下一轮 user 消息)——对长任务体验很好,但依赖 P1 稳定。
- LLM 生成会话标题(pie `title-generator.ts`)。
- 上下文用量统计环(pie `contextUsage`)。
- 中断恢复提示:newtab 页被关 = loop 消失,重开面板时若发现会话 status 仍 active 且有未收尾历史,给一条「上一轮被中断」的 notice(P1 的 wire 净化已保证这种历史能安全续接)。

### 2.5 实施顺序与工作量预估

| 期 | 内容 | 涉及文件 | 预估 |
|---|---|---|---|
| P1 | 事件历史持久化 + initialHistory + user-message 事件 + wire 配对净化 + 会话切换器 UI + contextWindow 配置 | loop.js / index.js / wire.js / transcript.js / events.js / AgentPanel.vue / [id].vue / config.js / SettingsAgent.vue | 2-3 天 |
| P2 | pin 捕获 + origin 校验 notice + focus_tab/open_url/list_tabs + 轻量跨会话锁 | index.js / tab.js / tools/* / background/index.js / prompt.js | 2-3 天 |
| P3 | 插话队列、LLM 标题、用量环 | — | 按需 |

### 2.6 测试策略

- 全部纯逻辑(pin 状态机、wire 净化、会话裁剪、origin 比对)进 `node --test` 现有套件,保持"纯函数 + IO 注入"的分层纪律。
- 中断续接的 wire 配对要有专门回归(assistant.tool_calls 悬空 → 净化后 400 不发生)。
- 真实 API 验证复用 `.agent-test/agent-live.mjs`:加两条——多轮记忆(第二问引用第一问内容)、分片 args 下的多页 focus 闭环。

## 3. 风险清单

1. **token 膨胀**:多轮 + 页面观察值,默认 32k 窗口最多撑几轮。对策:contextWindow 配置 + P1 的历史条数裁剪 + 已有 elide。
2. **确认门与切会话竞态**:pendingConfirm 的 resolve 闭包挂在 runtime 上,切会话必须先 resolve(false),否则旧会话的 loop 永远挂起(本次修的确认卡 bug 的变种)。
3. **user 消息进 history 后 prompt 变形**:buildUserMessage 的 untrusted 包装每轮都在做,历史续接时不能再包一层——包装只发生在"新 seed"上,历史里的 user 行原样进 wire。
4. **origin 校验的误报**:SPA 内路由不改 origin,没问题;但登录跳转、SSO 回跳会触发 notice。advisory 语义下模型会自己消化,但要观察实际体验再调 notice 文案。
