# 代码审查 · 第二批：agent 集成缝

审查日期：2026-10-10
范围：`src/composable/agentHost.js`、`src/components/newtab/workflow/agent/*`（11 个组件）、`src/newtab/pages/Agent.vue`、`src/newtab/pages/workflows/[id].vue` 的宿主接线、`src/newtab/pages/settings/SettingsAgent*.vue`、`src/background/index.js` 的 agent 段、`src/components/newtab/workflow/edit/TriggerEvent/*`
基线：沿用第一批（`npm test` 759/758/1skip/0fail；`npm run lint` 0 error/10 warning，全在 `src/agent` 之外）

---

## 一、结论摘要

| 维度 | 结论 |
| --- | --- |
| 四条红线（缝侧） | **全部成立**，未发现违规 |
| blocker / high / medium | **0 / 0 / 0** |
| low | **1**（新增，已登记 T-191） |
| 覆盖面缺口 | **1**（`src/composable/` 不在 test glob 内 → `agentHost.js` 无测试） |

第二批整体健康。重点核查的 **T-02（确认门三个卸载入口）实际是完整正确的**——三个入口全部 `resolve(false)` 或经过判空。真正的发现比 T-02 更窄：切会话路径上有一处**借用状态机字段代替判空**的写法，当前被 `busy` 门挡着不可达，但是个明确的隐患（详见 T-191）。

---

## 二、T-02 核查（第二批首要目标）：确认门三个卸载/切换入口

这是整条链路里唯一已知会「让 agent 永久挂起」的风险点（`CONTEXT.md`「确认门」条）。三个入口逐个核对：

| # | 位置 | 触发场景 | 写法 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | `agentHost.js:540-550` `onBeforeUnmount` | 整个宿主页面卸载 | `if (agent.pendingConfirm) agent.pendingConfirm.resolve(false)` | ✅ 判空 |
| 2 | `AgentPanel.vue:604-606` `onBeforeUnmount` | 面板被藏起来（侧栏三处 `v-if`） | `if (props.host.pendingConfirm) props.host.answerConfirm(false)` | ✅ 判空 |
| 3 | `agentHost.js:231-238` `guardAgentSwitch` | 切会话 / 新建 / 删除 | `if (plan.rejectPending) agent.pendingConfirm.resolve(false)` | ⚠️ **不判空**（见 T-191） |

入口 2 的设计理由正确且必要：`AgentPanel.vue:591-599` 的注释明确指出「宿主 `onBeforeUnmount` 只在整个页面卸载时才触发，兜不住『面板被藏起来』」——编辑器侧栏的 `sidebarPanel` 切换、块编辑卡打开、收起侧栏三处 `v-if` 都会卸载面板而**不**触发宿主卸载。这是对 T-02 的正确理解。

入口 3 的问题在于：它用 `plan.rejectPending`（状态机内部 `pending`，`confirm.js:280`）代替了对 `agent.pendingConfirm`（reactive 字段）的判空。两者目前同生同灭但**代码没有保证**。详细可达性分析与影响已写入 **T-191**。

---

## 三、红线合规核查（缝侧，逐条）

### 红线 1 · agent 永不保存工作流（G5）

**结论：成立，且在真实注入点上被验证。**

- **落盘符号扫描（本轮新增覆盖）**：对第二批全部文件 grep `saveWorkflow` / `workflowStore.update` / `workflowStore.save` / `registerWorkflowTrigger` / `dbStorage.workflows`，**零命中**。`canvas.test.js` 的 G5 守卫只走 `src/agent`，所以这条缝侧检查是**新增的独立覆盖**，结论通过。
- **画布句柄仍是 4 键**：`[id].vue:752-760` 的真实注入点——`{ blocks, getEditor: () => editor.value, newId: nanoid, onCanvasChanged }`，正好 4 键，与 `canvas.test.js:496` 的断言一致；`getEditor` 仍是 vue-flow 的 ref（匹配 `canvas.test.js:510`）。
- **`onCanvasChanged` 只标脏**：`[id].vue:757-759` 的实现是 `state.dataChanged = true`——**绝不落盘**。这是 G5 在真实宿主上的落地。
- **触发器完全隔离**：`TriggerEvent/` 目录 grep `agent` **零命中**——agent 与工作流触发器毫无接触，这是结构性满足，不只是「没写错」。
- **设置页不碰运行时**：`SettingsAgent.vue`(841 行) 的 import 面只有 `configIO` + `@/agent/config`（纯配置模块），无 `createAgentRuntime` / `useAgentHost` / 落盘入口。

### 红线 2 · third-party 数据 untrusted 包裹 + 转义

**结论：成立，展示侧处理正确。**

- `AgentToolStep.vue:96/200` 用 `stripUntrustedForDisplay` 把**给模型看的** observation 标签剥成**给人看的**文本（T-07）——方向正确：模型侧仍看标签（`:193` 注释明说）。
- **`v-html` 全部收口**：全仓 `v-html` 只出现在 `AgentMarkdown.vue`（4 处）与 `AgentTable.vue`（2 处），且都显式 `eslint-disable vue/no-v-html` 并注明「HTML 由 `@/agent/markdown` 逐 token 产出，白名单外一律转义」。
- **表格单元格也走转义**：`markdown.js:276/278` 的 table head/rows 走 `emitTokens`，未知 token 落到 `escapeHtml`（`:114`/`:119`）。所以 `AgentTable.vue` 的 `v-html="cell"` 没有绕过 escape-first 不变式。
- **确认卡无 XSS 面**：`AgentConfirmCard.vue:22-26` 的 `<pre>{{ body }}</pre>` 用 Vue mustache（自动转义），`body` 来自工具 `confirmDetail`（代码全文 / 选择器 / 画布字段值）。

### 红线 3 · 工具 class / ctx 契约（缝侧消费端）

**结论：成立。** 确认卡按 `kind` 取文案（`AgentConfirmCard.vue:78-116`），事实（`detail`）由工具自带 `confirmDetail` 提供——与 `src/agent/confirm.js` 的载荷契约一致。`canRemember` 只对 `kind` 命中 `REMEMBERABLE_TOOLS=['test_js']` 的情况为真（`confirm.js`），画布写操作逐次确认，`AgentConfirmCard.vue:27` 的 checkbox 因此对画布不出现。

### 红线 4 · `pi/` 只读

**结论：成立。** 本批未触及。

---

## 四、超时嵌套关系（缝侧实测）

**结论：正确，且跨文件守卫确实存在（曾误判为缺口，已证伪）。**

- 常量分布在两个文件：`AGENT_PAGE_TIMEOUT_MS = 15000`（`background/index.js:533`）与 `TAB_CHANNEL_TIMEOUT_MS = 15000` / `BACKGROUND_CHANNEL_TIMEOUT_MS = 20000`（`browserAdapter.js:120/38`）。
- `runInPage`（`background/index.js:565-603`）用 `AGENT_PAGE_TIMEOUT_MS`（15s）包住页内执行（`agentEvalInPage` 内部 10s）。
- **曾担心**：常量在两个文件各写一份，`src/agent` 侧的守卫测试看不到 background 的副本 → 跨文件不一致无人守。
- **已证伪**：`index.test.js:270-304` 的守卫测试**显式读取 `src/background/index.js` 源码**（`:272` `read('src/background/index.js')`，`:280` 正则抽 `AGENT_PAGE_TIMEOUT_MS`），把跨文件那一环也断言了。测试注释（`:266-269`）甚至专门写明了「这组常量分属两个文件……没有任何一处代码保证它们的相对大小」，说明这是**刻意为覆盖该缺口而写**的测试。结论：不是缺口。

---

## 五、问题清单

### 🟡 low-1 · `guardAgentSwitch` 的 `resolve(false)` 不判空，靠 `busy` 门挡着（T-191）

- **位置**：`src/composable/agentHost.js:235`
- **问题**：`if (plan.rejectPending) agent.pendingConfirm.resolve(false);` —— 用状态机的 `plan.rejectPending`（`confirm.js:280`，判的是内部 `pending`）代替了对 reactive `agent.pendingConfirm` 的判空。同文件 `:544` 和 `AgentPanel.vue:605` 都正确判空了，只有这里没有。
- **可达性**：**当前不可达**。切会话路径要求 `!agent.busy`（`:233` 的 `!plan.allow` 提前返回），而确认卡显示期间 `agent.busy === true`（确认门 `await` 发生在 `runtime.send()` 内部）。`planSwitch({busy:true})` 恒返回 `allow:false`，且该不变式被 `confirm.test.js:346` 钉死。
- **风险**：① 写法看着「判过了」，实际判的是另一个字段——一旦未来放开 `busy` 门（「等确认时也能切会话」是常见诉求），立即抛 `TypeError`。② `src/composable/agentHost.js` **无测试**，且 `package.json` 的 test glob (`src/agent/**` + `src/workflowEngine/**`) **不含 `src/composable/`**，所以没有任何测试能发现这处不一致。
- **登记**：已作为 **T-191** 写入 `docs/backlog.md` 的 `## 待审核` → `### 改进` 区。

---

## 六、覆盖面缺口（非缺陷，是结构问题）

**`src/composable/` 整体不在测试范围内。**

- `package.json:26` 的 test 命令 glob 为 `"src/agent/**/*.test.js" "src/workflowEngine/**/*.test.js"`。
- 因此 `src/composable/agentHost.js`（568 行，agent 与 UI 的唯一接缝，含 T-02 全部逻辑）**没有任何测试**。
- 后果：缝侧的核心不变量（三个卸载入口放行、画布句柄 4 键、T-90 会话授权失效点）全靠**读代码**保证。`src/agent` 侧被守卫测试钉得很密（第一批已确认 75 个守卫测试全绿），但缝侧是「测试的边界之外」。
- 这不是本轮 review 引入的，是既有结构。建议单独立项讨论（是扩 glob 还是给 agentHost 抽出可测的纯函数），不在本报告内定论。

---

## 七、下一批（第三批：上游受影响区）建议

- `src/workflowEngine/blocksHandler/`（尤其 `handlerAiWorkflow.js`、`handlerAgentReadPage.js`，后者 1,360 行）——**必须对着 `npm run build:full` 的产物审**：offline 构建会剥掉云端 handler 的函数体，直接读源码会看到大片空实现而误判。
- 重点核对：agent 的 `read_page` 与 `handlerAgentReadPage` 是否共享同一套 detail 口径（`addresses` / `probe` / `text`），以及 `mergeFrameReads` 的 fingerprint 约定（frameId 0）在上游 handler 里是否被遵守。
- `src/content/index.js:323` 的 `agent:read-page` 分支——与 `browserAdapter.js` 的 `readOneFrame` 消息形状配对的另一端，需一起看。

---

## 附录 · 本轮覆盖清单

- `src/composable/agentHost.js`(568) — 全文 + 调用链追踪
- `src/components/newtab/workflow/agent/`：`AgentPanel.vue`(733，卸载路径+确认卡渲染)、`AgentConfirmCard.vue`(124，全文)、`AgentToolStep.vue`、`AgentMarkdown.vue`、`AgentTable.vue`、`AgentTranscript.vue`、`AgentDropdown.vue`、`AgentSessionList.vue`、`AgentTabList.vue`、`AgentTabPicker.vue`、`AgentContextRing.vue`
- `src/newtab/pages/Agent.vue`(45，全文) · `src/newtab/pages/workflows/[id].vue:685-765`(宿主接线)
- `src/newtab/pages/settings/SettingsAgent.vue`(841，import 面 + 落盘符号扫描)
- `src/background/index.js:533-710`（`AGENT_PAGE_TIMEOUT_MS` / `runInPage` / `agent:query` / `agent:highlight` / CSP debugger 降级）
- `src/components/newtab/workflow/edit/TriggerEvent/*`（agent 引用扫描）
- 守卫测试：`src/agent/index.test.js:265-329`（超时嵌套 + G5 装配层）、`src/agent/confirm.test.js:341-360`（planSwitch）
