# 代码审查 · 第一批：`src/agent` 核心模块

审查日期：2026-10-10
范围：`src/agent/` 全部非测试源码（约 10,200 行）+ 相关守卫测试
基线：`npm test` 759/758 pass/1 skip/0 fail；`npm run lint` 0 error/10 warning（全部在 `src/agent` 之外）

---

## 一、结论摘要

| 维度 | 结论 |
| --- | --- |
| 四条红线 | **全部成立**，未发现违规 |
| 阻断级问题（blocker） | **0** |
| 严重问题（high） | **0** |
| 中等问题（medium） | **0** |
| 轻微问题（low） | **2**（1 条与既有 backlog 重复，1 条新增已登记） |

第一批属于**健康批次**：`src/agent` 是被重点守卫、测试覆盖厚、注释即契约的核心模块。审查未发现红线级、逻辑级或安全级缺陷。两条发现均为「注释/文档卫生」级别，无运行时影响。

---

## 二、红线合规核查（逐条）

### 红线 1 · `agent 永远不能保存工作流`（G5）

**结论：成立。双重守卫。**

- 静态守卫：`src/agent/tools/canvas.test.js:415` 的 `describe('G5：agent 永远不能保存工作流')` 会遍历 `src/agent` 整棵目录树（排除 `__stubs__` 与 `*.test.js`），用 `stripComments`（`src/agent/stripComments.js`，基于 `@babel/parser`）先剥掉注释再扫 5 个禁符号：`saveWorkflow` / `workflowStore.update` / `workflowStore.save` / `registerWorkflowTrigger` / `dbStorage.workflows`。
  - 剥注释这一步是**必要的**：`loop.js` 里就有一段注释明确写着「不许碰 `saveWorkflow`」，不剥注释会把警告本身误判为违规。`stripComments` 解析失败时**原样返回源码**（宁可少剥、绝不误删代码），失败方向安全。
- 装配层守卫：`src/agent/index.test.js:310` 对 `index.js` 全文做文本扫描（`saveWorkflow` / `workflowStore.update` / `workflowStore.save`），并附一条「守卫不是空转」的反向断言（`index.js:324-328`）。
- 画布句柄收窄：`canvas.test.js:496` 断言宿主传给 agent 的画布句柄**只有 4 个键**（`blocks` / `getEditor` / `newId` / `onCanvasChanged`）；`canvas.test.js:510` 断言 `getEditor` 仍返回 vue-flow 的 `editor` ref、不得改成直接引 store。这两条把「agent 能力边界」钉死在内存画布上。
- 实跑：G5 + 相关红线守卫共 **75 tests 全绿**。

### 红线 2 · 第三方数据一律 `<untrusted_*>` 包裹 + 转义

**结论：成立，且纵深防御完整。**

- 9 个注册标签在 `untrusted.js:28-42`，与 `CONTEXT.md` 一致（含 T-76 的 `compaction_summary`、T-143 的 `skill_index`）。
- 8 类攻击面（ASCII 闭合 / Unicode 混淆括号 / 全角括号 / 数学尖括号 / CJK 尖括号 / 零宽字符注入 / 带属性闭合 / 多斜杠闭合）全部覆盖（`untrusted.js:9-17`）。
- 关键实现细节正确：`escapeUntrustedWrappers` **先剥零宽字符再匹配**（`:80-81`）——否则零宽字符藏在标签名中间即可绕过；替换成 **ASCII HTML 实体**而非形近 Unicode（`:83`），因为实体在任何标记语法里都不可能是标签，而形近字符可能被攻击者预先污染。
- `wrapUntrusted` 对**未知标签直接 throw**（`:108-110`）—— 与「不许静默降级」一致。
- **截断在包装之前**（`adapter.js:80-83`，注释明确说明「先包装后截断会把闭合标签砍掉」）。
- 装配期强制：`prompt.js` 在技能索引存在但 `wrap` 未提供时**直接抛出**，不静默放行。
- 诚实边界：文件头 `:24-25` 明写「这是纵深防御，不是完备防御……真正的兜底是写操作必须由人点确认」——定位准确，未夸大。

### 红线 3 · 工具必须声明 `class` 与 `ctx`

**结论：成立，三重校验 + 失败关闭。**

- `define.js`：`REQUIRED` 六字段（`name`/`class`/`group`/`description`/`parameters`/`execute`），缺一即 throw（`:37-56`）；**故意不给 `class` 兜底值**（ADR 0002 fail-closed）；`write` 类缺 `confirmDetail` 直接 throw（`:88-97`）。
- `tools/index.js`：`validateTools` 在**模块加载期**执行（`:179`），校验 `class` 必填、`class ∈ TOOL_CLASSES`、`ctx` 必须是「非空字符串数组」、`write` 类必须有 `confirmDetail`（`:166-173`）。
- `adapter.js`：`toAgentTools` 再次 `validateTools`（`:143`，因 pi 不会替我们炸）；随后做 **ctx 键绑定校验**（`:148-160`）—— 工具声明的 ctx 键必须在 `toolCtx` 里真实存在，否则点名「`tool ← ctx.key`」报错。
- 失败关闭的兜底：`requiresConfirmation`（`tools/index.js:207-213`）对**未知工具一律返回 `true`**；`findTool` 传非数组直接 throw（`:189-193`）。
- ADR 0002 记录的两处刻意偏差已核实为有意为之：`highlight_selector = write`、`focus_tab = read`。

### 红线 4 · `pi/` 与 `/pie-ai-agent` 只读

**结论：成立。** 第一批范围未触及这两个目录；审查中未在任何被审文件里发现对它们的写操作或反向依赖。

---

## 三、超时嵌套关系核查（T-39）

**结论：正确，且被测试钉死。**

- 单向递增链：页内执行 10s（`agentEvalInPage.js`）< 通道 15s（`browserAdapter.js:TAB_CHANNEL_TIMEOUT_MS`）< background 往返 20s（`browserAdapter.js:BACKGROUND_CHANNEL_TIMEOUT_MS`）。
- 工具级总超时 60s（`adapter.js:137-140`），依据：「页内 10s + background 20s + 回程 ≈ 30s，留 2x 余量」（`:130-132`）。
- **外层必须大于内层**这一不变式由 `index.test.js` 直接断言（含 `TAB < BACKGROUND` 的显式比较，`:296-304`），并附理由「background 那条的兜底在 background 内部，SW 被回收时只有它能救」。
- 所有超时**返回 error 观察值、绝不 reject**（`adapter.js:184-196`、`raceTimeout`）——「拿不到结果 ≠ 通道坏了」，与项目「错误即观察值」原则一致。

---

## 四、问题清单（按严重度）

### 🟠 low-1 · `sessions.js:21` 注释把已删除的 `wire.js` 当现存模块描述

- **位置**：`src/agent/sessions.js:21`
- **现象**：常量 `MAX_SESSION_TURNS = 20` 上方注释为「存储里最多保留多少个用户轮次（**wire 层**另有 token 预算，这里是存储体积上限）」。
- **核实**：`wire.js` 已在 ADR 0004 / 票 08 整份删除；现承担「token 预算」职责的是 `compaction.js` 的上下文压缩（T-76）。
- **判定**：**与既有 backlog `T-189` 重复**，不新增条目。
- **T-189 的范围判断经本轮复核为准确**：全 `src/agent`（排除测试）grep「wire」共 5 处，其中 `loop.js:564`、`provider.js:5`、`provider.js:151` 三处都明写「迁移前 / 票 08 删掉了」，属**合法历史说明**；`sessions.js:57` 是比喻性用法（「wire 配对净化也救不回语义」）；**只有 `sessions.js:21`** 把已删模块当作现状在描述。
- 建议按 T-189 原样处理（一行改动），本轮不重复登记。

### 🟡 low-2 · `log.js` 同一段 JSDoc 写了两遍，其中一份是悬空孤儿

- **位置**：`src/agent/log.js:17-30` 与 `src/agent/log.js:73-83`
- **现象**：标题为「全链路日志实例（模块级单例）/ **为什么放在这里而不是装配层 `index.js`**（T-126 第二步）」的整段块注释出现两次。`:17-30` 那份**悬空**——其下紧跟的是 `createAgentLog` 的 JSDoc（`:32-41`），不修饰任何声明；`:73-83` 那份才正确挂在 `export const agentLog`（`:84`）上。
- **证据**：源码全文核对；两份正文约 **88% 相同**（唯一差异：孤儿那份多出 `:28-29` 关于 `export const` 求值顺序 vs 函数声明提升的说明）。对 `src/agent` 全部非测试 `.js` 做块注释模糊去重（相似度阈值 0.8），**只命中这一对**。
- **影响**：可维护性损耗。读者会先怀疑「是不是漏了一处声明」「哪份才是准的」；孤儿那份多出的求值顺序段落容易被误当成 `agentLog` 的补充说明去对照，而它其实什么也不修饰。无运行时影响。
- **登记**：已作为 **T-190** 写入 `docs/backlog.md` 的 `## 待审核` → `### 改进` 区。

---

## 五、已核查但**不构成**问题的项（记录以便第二批复用）

1. **`ensurePiAgent` 系统提示陈旧假设 → 证伪。** `loop.js:543` 的 `piAgent` 是 `createAgent` 内闭包变量；`index.js:588` 每次 `send()` 都调用 `createAgent({...})`，`finally`（`index.js:722-729`）将 `activeAgent = null`。**无跨轮复用**，早退分支永远不会绕过「已变更的提示」。转写重建（`loop.js:1031-1037` / `:1106-1112`）也正确保留了既有 `role:'system'` 消息。
2. **每轮重读存储是刻意设计。** `index.js:512-527` 注释「每次 send 都从存储现读，不在 runtime 里另存一份副本 —— 两份状态必然漂移」；`enabledGroups` 可为函数、逐 send 求值（`:551-555`）；`instructions` / `skillIndex` 每轮重读（`:569-586`）。行为一致。
3. **`prompt.js` 三段式白名单 + 技能索引包装**、**`read_block` 分页从不静默截断（T-91）**、**`MAX_FIELD_CHARS=7000` 刻意低于观察值上限 8000**、**skills 导入硬上限直接 throw 而非截断（T-146）** —— 均符合「不许静默降级」。
4. **`markdown.js` 白名单 + 转义优先**（`escapeHtml` 先于一切）、`safeHref` 限 `http(s)`/`mailto`、增量 `createMarkdownStream` 带性能缓存（20K 字符 47ms vs 1926ms）。
5. **`tab.js` / `targetState.js` 纯函数化**（后者明确不引入浏览器 API），`targetHealth` 四态、`origin` 才是真实身份（tabId 会复用）。
6. **`config.js` T-66**：`resolveActiveConfig` 只清 `baseUrl`、保留 `baseUrlInvalid`，未静默降级。

---

## 六、下一批建议

第二批（集成缝）在一批结论之上展开，重点：

- `src/composable/agentHost.js` —— 三处确认门卸载入口（`guardAgentSwitch` / `agentHost onBeforeUnmount` / `AgentPanel.vue` unmount）必须 `resolve(false)`，否则循环永久挂起（T-02）。**这是整条链路里唯一会让 agent 卡死的已知风险点**，应作为第二批首位。
- `src/background/index.js`（1,463 行，巨型文件）—— 通道超时兜底的落点，需核对 20s `BACKGROUND_CHANNEL_TIMEOUT_MS` 的实现在此处是否与 `browserAdapter.js` 的常量同源。
- `components/newtab/workflow/agent/*` —— 确认卡 UI（`confirmDetail` 的消费端）。

---

## 附录 · 本轮覆盖文件清单（`src/agent`，非测试）

主干：`loop.js`(1178) · `index.js`(913) · `config.js`(785) · `prompt.js`(338) · `provider.js`(168) · `tools/{index,adapter,define,page,page-write,tabs,canvas,skill,highlight}.js`
周边：`sessions.js`(348) · `compaction.js`(481) · `untrusted.js`(152) · `events.js`(193) · `confirm.js`(285) · `markdown.js`(405) · `skills.js`(699) · `tab.js`(223) · `targetState.js`(117) · `browserAdapter.js`(339) · `agentEvalInPage.js`(193) · `facts.js` · `turnRecord.js` · `log.js` · `usage.js` · `fold.js` · `title.js` · `examples.js` · `sessionGroups.js` · `customizations.js` · `stripComments.js`

守卫测试：`hygiene.test.js` · `facts.guard.test.js` · `eventContract.test.js` · `assembly.test.js` · `index.test.js` · `tools/canvas.test.js`(G5 段)
