# 0005 — 助手主面板标签页形态迁往浏览器侧边栏(chrome.sidePanel)

日期:2026-10-10
状态:已实施(未提交)
关联:docs/adr/0001-agent-standalone-entry.md(本 ADR 取代其「单入口」结论)、docs/backlog.md T-199、docs/t199-sidepanel-plan.md、docs/agent-sidepanel-demo.html

## 背景

ADR 0001(2026-10-03)决定助手为**独立主面板标签页**(路由 `/workflows/agent`),理由是助手的使用场景大多与「当前正在编辑的工作流」无关(问页面结构、写 selector、聊方案),不该被绑进某个工作流的编辑器里。同时它拒掉了「双入口」,警告「独立页与编辑器页的行为差异会让用户困惑」。

但 ADR 0001 留下了一条**已知欠账**:独立页没有画布编辑能力,而画布工具的宿主(需要 vue-flow 实例句柄)在编辑器侧栏里。2026-10-05 因此**重新加回了编辑器侧栏宿主**(记录见 `docs/backlog-done.md` T-182),双宿主并存至今。ADR 0001 警告的「同名同图标但能力不同」困惑虽经 T-180/T-182 做了视觉缓解,但**能力差异本身没消除**。

本次(T-199)用户提出另一条收敛路径:主面板那个独立页**本身不能操作工作流**,它面向的始终是「浏览器里的网页」(page / tab 组工具),那就该住进浏览器原生侧边栏,而不是挤在主面板标签体系里。

## 决定

1. **Chrome 上撤除独立助手页,助手迁入浏览器侧边栏。**
   新建 `src/sidepanel/`(独立 webpack 入口 + `sidepanel.html`),由 `manifest.chrome.json` / `manifest.chrome.dev.json` 的 `side_panel.default_path` 指向;`permissions` 增加 `sidePanel`。宿主接线与旧 `Agent.vue` 逐字相同,唯一差别是 `layout: 'narrow'`(侧栏宽度约 320–400px,横向常驻历史栏塞不下)。

2. **不采用 `setPanelBehavior({openPanelOnActionClick: true})`。**
   该开关会让点扩展图标直接开侧栏,从而顶掉 popup —— 而 popup 是工作流列表 / 录制 / 元素选择的既有主入口,不能丢。改为**保留 popup,在其中加一个「打开助手」按钮**,由用户点击这个手势触发 `sidePanel.open({windowId})`(`sidePanel.open` 官方要求由用户手势触发)。

3. **Firefox 不动,保留主面板标签页形态。**
   `chrome.sidePanel` 是 Chrome 114+ 专有;Firefox 对应的是另一套 `sidebar_action`(MV2),不是同一个字段。用户明确「不怎么使用 Firefox,用最省事的方法处理」→ 选「Chrome 用侧栏、Firefox 保留现状」。因此 `router.js` 的 `agent` 路由与 `Workflows.vue` 的入口都以 `IS_FIREFOX` 条件保留,**Chrome 构建下不注册**。

4. **拆旧页必须做 localStorage 残留兜底。**
   老用户 `localStorage['tabs']` 里可能有 `path: '/workflows/agent'` 的标签页。Chrome 下该路由已撤除,不过滤则点开即白屏。`Workflows.vue` 的 `onMounted` 在非 Firefox 分支静默剔除该条 tab,并在被删的是当前激活页时清除 `activeTab`。

5. **`goToAgentSettings` 改为可注入**(`deps.onOpenSettings`)。
   它原先硬编码 `router.push`。侧栏不在 newtab 里、没有 settings 路由,必须由宿主决定怎么过去(开一个 `newtab.html#/settings/agent` 标签页)。默认仍走 router,编辑器侧栏宿主零改动。顺带修正旧写法:原 `{path:'/settings', hash:'#agent'}` 并不指向实际路由 `/settings/agent`。

## 被拒备选

- **维持 ADR 0001 的单入口(主面板标签页)不动**:那意味着继续与「看网页时问助手要切走标签页」对抗,而这恰是独立页最本职的场景(它的工具全是 page/tab 组)。
- **双平台都写侧边栏**(Chrome `side_panel` + Firefox `sidebar_action`):形态统一,但要维护两套 manifest 字段与 API 差异,且 `sidebar_action` 无 `openPanelOnActionClick` 等价物;用户明确 Firefox 非重点,不值得为此付出。
- **点图标直接开侧栏**(`openPanelOnActionClick`):顶掉 popup,丢失工作流列表 / 录制 / 元素选择入口。
- **ADR 0001 的原始收敛路径**(做「在助手里打开某工作流」的挂载机制后给独立页放宽 `enabledGroups`):与本条不冲突,但那条路要让无画布宿主具备画布能力,复杂度更高。本条走的是「让两个宿主职责彻底分离」:
  - **编辑器侧栏** = 工作流内、有画布、会话按 workflowId
  - **浏览器侧栏** = 全局、无工作流、面向页面交互

## 已知欠账

- **Firefox 形态未统一**:Firefox 上仍有「主面板标签页助手 + 编辑器侧栏助手」双宿主,ADR 0001 的困惑在 Firefox 上原样保留。若将来 Firefox 生态转向 MV3 且有等价 sidePanel 支持,再评估统一。
- **旧独立页代码保留**:`src/newtab/pages/Agent.vue` 与 `router.js` 的 `agent` 路由为 Firefox 而保留,Chrome 构建虽不注册路由、但静态 `import` 仍会把它打进 bundle(体积成本极小,换取 Firefox 形态零分叉)。
- `localStorage['tabs']` 残留由 `Workflows.vue` 运行期过滤兜底,未做一次性清理迁移。
