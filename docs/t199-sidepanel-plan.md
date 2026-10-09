# 实施计划 · T-199 助手迁移到浏览器侧边栏（chrome.sidePanel）

日期：2026-10-10
状态：待用户确认（批准后开工）
关联：`docs/backlog.md` T-199、`docs/adr/0001-agent-standalone-entry.md`、`docs/agent-sidepanel-demo.html`

---

## 0. 用户诉求拆成两条

1. **形态实施**：取消宽形态独立页，把助手作为浏览器原生侧边栏（`chrome.sidePanel`），全局会话、无 canvas、面向页面交互。
2. **UI 优化（新增诉求）**：用户观察「demo 出来的效果比项目里实现的效果要好」，要求实施完成后**针对助手 UI 界面仔细优化**。

第 2 条是本计划里需要被认真对待的部分——见 §5。先说结论：**这个"demo 更好看"不是错觉，有具体成因**，且成因与本次迁移可以一并处理。

---

## 1. 接线地图（已实测，非推断）

| 项 | 现状 | 迁移后 |
|---|---|---|
| 入口 | 主面板标签页 `/workflows/agent`（`router.js:61`，`WorkflowContainer` 子路由） | `sidepanel.html`，由 `manifest.side_panel.default_path` 指定 |
| 页面 | `src/newtab/pages/Agent.vue`（`layout:'wide'`） | 新建 `src/sidepanel/` 入口 + 页面，`layout:'narrow'` |
| 宿主接线 | `useAgentHost({layout:'wide', enabledGroups:['page','context','tab'], getWorkflowId:()=>null, getVariables:async()=>({bound:false}), getWorkflowContext:()=>null})` | **逐字照搬，仅 layout 改 `'narrow'`** |
| 数据 | `browser.storage.local`（扩展级，跨页可读） | **零改动** |
| 面板 | `AgentPanel.vue`，`wide` 只在 4 处（`:12` 根 class、`:18` 左栏 v-if、`:62`、`:87`），`layout` 仅此一处消费（`agentHost.js:119`） | 传 `narrow` 即走现有窄分支，**组件不重写** |
| 拆旧 | `router.js:61-64` agent 路由、`Agent.vue`、`Workflows.vue:58` 入口 + `:121-123` `openAgentTab()`、`:199-202` 旧数据迁移 | 全部移除；`localStorage['tabs']` 里残留的 agent tab 需兜底（否则用户打开主面板会看到一个指向已删路由的标签页 → 白屏） |
| 构建 | webpack `entry` 10 个 + `HtmlWebpackPlugin` 6 个 | 新增 `sidepanel` 入口 + `sidepanel.html` |
| manifest | chrome MV3（无 sidePanel）、firefox MV2 | chrome 加 `sidePanel` 权限 + `side_panel` 键 + `setPanelBehavior`；firefox 见 §4 |

**关键有利事实（已实测）**：
- 数据层 `browser.storage.local` 是扩展级 → 侧边栏独立打开即可读全部会话/配置，**无需主面板先打开**。
- `layout` 传播链干净（`agentHost.js:119` 归一 → `AgentPanel.vue:541` 消费），无第三处读它。
- `src/agent/` 核心零改动。

---

## 2. 实施步骤（分 6 步，每步可独立验证）

### 步骤 1 — 新建 sidepanel 入口骨架（不碰旧页）
- `src/sidepanel/index.html`（参照 `newtab/index.html`，去掉 sandbox iframe；侧栏不需要执行沙箱）
- `src/sidepanel/index.js`（参照 `newtab/index.js` 的 use 链；**不带 router**，侧栏是单页；保留 i18n / pinia / compsUi / vRemixicon / tailwind）
- `src/sidepanel/App.vue`（仅 `<agent-panel :host="agent" />` + `onMounted` init，照搬 `Agent.vue` 结构）
- webpack：加 `sidepanel` entry + `HtmlWebpackPlugin`
- **验证**：`npm run build` 产出 `build/sidepanel.html` + `build/sidepanel.bundle.js`

### 步骤 2 — manifest 接线（Chrome）
- `src/manifest.chrome.json` + `manifest.chrome.dev.json`：`permissions` 加 `"sidePanel"`，新增 `"side_panel": {"default_path": "sidepanel.html"}`
- `background` 侧加 `browser.sidePanel.setPanelBehavior({openPanelOnActionClick: true})`（点扩展图标即开侧栏）；background 现在有 popup（`action.default_popup`），**需确认二选一还是共存**——若保留 popup，则不用 openPanelOnActionClick，改为 popup 里加"打开助手侧栏"按钮（`sidePanel.open({windowId})` 需用户手势）
- **验证**：`npm run build`，装进 Chrome 手动点图标能开出侧栏

### 步骤 3 — 侧栏页面接线跑通
- 侧栏页面用 `useAgentHost({layout:'narrow', ...})`，确认能初始化、能发消息、能读到既有会话
- **验证**：真实侧栏里发一轮消息、切历史会话、看到全部历史（证 `browser.storage.local` 跨页可读）

### 步骤 4 — UI 优化（§5 详述）
- 针对窄形态在侧栏真实宽度下的观感逐项优化
- **验证**：截图对比优化前后

### 步骤 5 — 拆旧独立页
- 删 `src/newtab/pages/Agent.vue`、`router.js:61-64`
- `Workflows.vue`：删 `openAgentTab()`（`:121-123`）、`+` 弹层里的助手项（`:55-62`）、`:199-202` 旧数据迁移
- **`localStorage['tabs']` 残留兜底**：`onMounted` 读 tabs 时过滤掉 `path === '/workflows/agent'` 的条目（否则白屏）
- **验证**：`npm test`（预期有守卫变红，见 §3）、主面板不再有助手入口、老用户 tab 残留不白屏

### 步骤 6 — 收尾
- 更新受影响的测试守卫（§3）
- 更新 `docs/adr/`：新增 ADR 0005（或补记 ADR 0001），说明形态最终定型
- 更新 `CONTEXT.md`（若有"两个宿主"的表述）
- `npm test` + `npm run lint` + `npm run build`（按 AGENTS.md 收尾重建产物）
- backlog T-199 移入 `backlog-done.md`

---

## 3. 测试影响（已知会变红的守卫）

| 文件 | 断言 | 处置 |
|---|---|---|
| `panelUi.test.js:1791` | 顶栏不许出现 `workflow.agent.tab` | 复查是否仍成立（侧栏 entry 改动可能不涉及） |
| `assembly.test.js:1112-1117` | `Agent.vue` 的 `enabledGroups` 必须是 getter | **该文件被删 → 守卫要改指 sidepanel 页面** |
| `assembly.test.js:1196` / `confirm.test.js:281` | 读 `AgentPanel.vue` | 若面板不改结构则不受影响 |
| `agentHost.js` 不在 test glob | 无测试（既有缺口 T-191 记录过） | 本次可顺带把 `src/composable/**` 纳入 glob？**属范围外，不顺手做**（AGENTS.md 红线） |

**原则**：不为了让测试变绿而放宽断言；守卫该改指向就改指向，该删（对应产物消失）就在条目里写清理由。

---

## 4. Firefox 决策（需要你拍板）

`chrome.sidePanel` 是 Chrome 114+ 专有。Firefox 对应的是 MV2 的 `sidebar_action`，**不是同一个字段**。

三个选项：

| 方案 | 说明 | 代价 |
|---|---|---|
| **A. Chrome 用 sidePanel，Firefox 保留主面板标签页** | 改动最小，各平台用各自最优形态 | 平台形态不一致；Firefox 上仍有两入口问题 |
| **B. 双平台都写侧边栏**（Chrome `side_panel` + Firefox `sidebar_action`） | 形态统一 | 要维护两套 manifest 字段 + 处理 API 名差异（`sidebar_action` 的 `default_panel`）；`sidebar_action` 无 `openPanelOnActionClick` 等价物，交互入口要另设计 |
| **C. 只做 Chrome，Firefox 暂不动也不拆旧页** | 最保守 | Firefox 用户保持现状（有宽形态），代码里两套并存 |

**我的建议：A**。理由：本项目的 `manifest.firefox.json` 是 MV2，Firefox 生态本身在向 MV3 迁移，现在为它单独做一套 `sidebar_action` 收益低、维护成本高；而"拆旧页"如果 Firefox 不做侧栏就没法拆（否则 Firefox 用户失去助手入口）。**但 A 意味着「取消宽形态」只在 Chrome 成立**——这点必须你确认接受。

> 若你选 A，我会把「Firefox 形态待统一」登记成新的 backlog 条目，不在本次强做。

---

## 5. UI 优化：为什么 demo 看起来更好（这是本次要认真解决的）

你观察到的差距是真实的，我分析出**四个成因**，按影响排序：

### 成因 1：demo 用了"理想内容"，项目里是"真实内容"
Demo 里我写的是排版好的短句、干净的 3 行会话列表、完美的 favicon 色块。真实运行时：消息长度不可控、工具步骤的 JSON 可能很长、会话标题是首条用户消息截 24 字符（`title.js`）、favicon 可能 404 变灰地球。
**→ 优化方向**：为"难看但真实"的内容做样式兜底（长 URL 断行、长代码块横滑、长标题截断的一致性、favicon 缺失态的视觉处理）。**这是最容易被忽略但影响最大的一条。**

### 成因 2：demo 是静态的，没有交互态与状态机
Demo 没有 hover / focus / disabled / loading / busy / streaming 光标的真实样式，也没有"上下文水位环"在 80% 时的变色、确认卡的 amber 态、错误卡的 red 态。
**→ 优化方向**：逐态核对（空闲/忙碌/流式中/错误/未配置 Key/确认待答），把每个态的视觉补全并统一。

### 成因 3：demo 的间距是我按"好看"排的，项目里是"每省 1px"的产物
看 `AgentPanel.vue` 的注释就能发现，面板历史上经历了大量"省 16px / 省 22px / 省 30px"的微调（T-158/T-163/T-166/T-171b/T-183/T-187），这些优化是**为 320px 极限宽度服务的**，在真实渲染下偏"紧"。而 demo 里我给了呼吸感。
**→ 优化方向**：在侧边栏真实宽度下重新校准间距节奏（`px-4` 的统一性、`py-1` 是否过紧、卡片内边距），**原则是"在 320px 仍不挤的前提下，把过度压缩的还回去"**。

### 成因 4：demo 是单页演示，项目里有多层容器叠加
真实侧栏宿主会有：侧栏容器 padding（T-183 那 40px）+ 面板内部 `p-3`/`p-2` + 卡片自身 padding，**三层叠加**。demo 里只有一层。
**→ 优化方向**：迁移到 sidePanel 后，宿主容器是浏览器给的，**我们要确保面板不再叠自己的外壳 padding**（T-183 的教训在新宿主上要重新验一遍）。

### UI 优化的执行方式
1. 先跑起来截图（真实侧栏，320/400 两档）
2. 逐条对照上面 4 个成因，列出具体可改项（**登记进 backlog，不直接改**，除非是明确的样式回退）
3. 用**真实数据**（长消息、长 URL、无 favicon、满会话列表）复跑一遍验证
4. 如果你要更硬的判据，可以再做一版 `docs/agent-sidepanel-ui-refined.html` 作为优化目标的视觉基准

> 注意：UI 优化里有一部分会触碰 `panelUi.test.js` 的既有守卫（间距守卫、`px-4` 一致性守卫等）。**改动前先读守卫**，避免为了好看破坏已钉死的像素决策——若确有冲突，登记后交你裁决。

---

## 6. 风险与回滚

| 风险 | 缓解 |
|---|---|
| `localStorage['tabs']` 残留 agent tab → 白屏 | 步骤 5 显式兜底过滤 |
| sidePanel 在 dev 构建（`manifest.chrome.dev.json`）下的行为差异 | 两个 chrome manifest 都改，分别验 |
| offline 构建（默认 `npm run build`）与 `build:full` 差异 | 本次不碰云端块处理器，用默认 build 即可；但**构建会清空 `build/`**，注意 AGENTS.md 的守卫坑 |
| UI 优化与既有像素守卫冲突 | 冲突项登记后裁决，不强改 |
| Firefox 用户失入口（若选 A 却误拆旧页） | 步骤 5 与 §4 决策绑定：选 A 则**不拆 Firefox 的旧页**（需条件保留） |

**回滚点**：每步一次 commit（或至少一次可 `git checkout` 的边界），步骤 1-3 是纯新增，回滚零成本；步骤 5（拆旧页）是唯一有破坏性的步骤，放在最后。

---

## 7. 待你确认的三件事

1. **Firefox 方案选 A / B / C？**（我建议 A，需你确认接受"取消宽形态只在 Chrome 成立"）
2. **扩展图标点击行为**：现在点图标是开 popup。改成"点图标直接开侧栏"（`openPanelOnActionClick`），还是保留 popup、在 popup 里加入口？
3. **UI 优化按 §5 的流程走（先截图列清单→登记→再改），还是你希望我直接改？**

确认这三项后我立即开工。
