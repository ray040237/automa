# 代码审查 · 第三批：上游受影响区（`workflowEngine`）

审查日期：2026-10-10
范围：`src/workflowEngine/` 在本分支相对 `main` 的全部改动；`src/content/blocksHandler/handlerAgentReadPage.js` **按用户指示排除**（该功能已舍弃）
基线：沿用第一、二批

---

## 一、本轮范围修正（重要）

审查开始前，原计划把 `src/workflowEngine/blocksHandler/` 当作「agent 代码的上游受影响区」来审，并特别点名 `handlerAgentReadPage.js`（1,360 行）与 `handlerAiWorkflow.js`。**实际核查后发现该前提基本不成立**，两点更正：

1. **`handlerAgentReadPage.js` 不在 `workflowEngine` 里**，它在 `src/content/blocksHandler/handlerAgentReadPage.js`（41 KB），且**全仓无任何引用**（除自身注释）——是已舍弃功能的遗留文件。用户已确认排除。
2. **`src/workflowEngine/blocksHandler/` 里没有 AI/agent 处理器**。该目录 51 个文件 / 4,483 行，是**上游原样代码**；唯一的 `handlerAiWorkflow.js`（85 行）是**云端 AI Workflow 块**的瘦客户端（`postRunAPWorkflow`），与 `src/agent` 无关。

因此第三批的正确范围 = **本分支在 `workflowEngine` 的实际改动**。用 `git diff --stat main...HEAD -- src/workflowEngine/` 量化为 **5 个文件、478 行**：

| 文件 | 改动 | 性质 |
| --- | --- | --- |
| `blocksHandler.test.js` | **+452** | 新增测试套件（T-116） |
| `blocksHandler/handlerAiWorkflow.js` | ±18 | T-03 修复（await + error 字段） |
| `blocksHandler/handlerGoogleDrive.js` | +4 | offline 门 |
| `blocksHandler/handlerGoogleSheets.js` | +4 | offline 门 |
| `WorkflowManager.js` | +2 | offline 门 |

其余 99% 的 `workflowEngine` 代码本分支未触碰。

---

## 二、结论摘要

| 维度 | 结论 |
| --- | --- |
| 本分支改动的正确性 | **正确**，未发现逻辑缺陷 |
| blocker / high / medium | **0 / 0 / 0** |
| low | **2**（T-192 覆盖率、T-193 判空不一致，均已登记） |

---

## 三、逐项核查

### 3.1 offline 门三处（本分支新增）

全部是「在任何云端调用之前提前返回/抛错」，位置正确、方向一致：

- **`WorkflowManager.js:122`** — `if (IS_OFFLINE) return engine;`
  - **切点正确**：它位于本地历史/事件处理（`:107-120`）**之后**、纯遥测的 `fetchApi('/status')`（`:124`）**之前**。离线只跳过网络 ping，功能无损。
- **`handlerGoogleDrive.js:20`** / **`handlerGoogleSheets.js:126`** — `throw new Error('... is not available in offline mode')`，都在 `sessionToken` 读取之前。

### 3.2 `handlerAiWorkflow.js`（T-03 修复，±18 行）

- `:14-16` offline 门（throw）+ `:21-23` token 缺失门（throw）——两个前置失败都显式抛出，符合「不许静默降级」。
- `:58` `await this.setVariable(...)` —— T-03 的核心修复，注释（`:55-57`）写明「不等它就返回，后面的块会读到旧值；它自己 reject 时更糟——那是一条 unhandled rejection，本块照样报成功」。
- `:79-81` rethrow 时保留 `error.data` / `error.ctxData`（T-03 第二半），与 `handlerWebhook.js:51` 的既有约定一致。
- **附带发现（无缺陷，但值得记录）**：全仓 16 个调用 `this.setVariable` 的 handler 中，**15 个正确 `await`**；唯一非直接 `await` 的 `handlerParameterPrompt.js:121-125` 是 `await Promise.allSettled(...)` 包住 map——**已正确 await**。但其 `allSettled` 会**吞掉**单个 `setVariable` 的 reject（`setVariable` 对 `$$` 变量会 `await dbStorage.variables.update/add`，`WorkflowWorker.js:131-136`，确实可能 reject），即「变量写失败但块报成功」。这是**上游代码**（`git diff main...HEAD` 对该文件为空，历史为上游 PR #1578），且与 `handlerAiWorkflow.js` 的 T-03 修法不同。**未登记**——非本分支引入、影响面窄（仅 `$$` 变量 + IndexedDB 失败），仅在此备注。

### 3.3 新增测试套件 `blocksHandler.test.js`（+452 行，T-116）

设计质量高，边界写得诚实：

- 两类测试分开：**行为测试**（假 worker 当 `this` 直接调处理器，验变量/表格是否真被改）与**契约/可导入性**（覆盖全部 53 个处理器）。
- **钉住实测边界**：文件头（`:20-25`）记录「53 个处理器里只有 13 个能在 node 里加载」，其余 40 个失败于三类原因（顶层读 `chrome.*` / webpack externals `secrets` / `@business/blocks` alias），且**这份清单被测试钉死**（`:391` 「可导入清单被钉住」）——加了新处理器而不更新清单，测试会红。
- 细节用心：`fakeWorker` 的 `columns[index]` 初值刻意非 0（`:57-59` 注释），因为「游标归零那条断言写成 `index === 0` 的话，初值也是 0 时就算处理器不归零它照样过（变异测试实测过这条）」。

**唯一缺口**：`:43` 硬编码 `globalThis.IS_OFFLINE = false` → 见 T-192。

---

## 四、问题清单

### 🟡 low-1 · 27 处 `IS_OFFLINE` 门零测试覆盖（T-192）

- **事实**：全仓 `IS_OFFLINE` 出现 27 处 / 21 个文件；但**所有测试里它恒为 `false`**（`blocksHandler.test.js:43`、`facts.test.js:12`，全仓仅此两处）。
- **后果**：所有 `if (IS_OFFLINE)` 分支在测试中永不执行——**包括本分支新增的三处门**。门写反、漏加、返回形状错，都不会有测试变红。
- **说明**：置 `false` 是**必需的**（否则处理器在 node 里 import 就全走 offline 分支，测不到真实逻辑）。所以问题不是「写错」，是「只测了一条路」。
- **影响**：offline 门是「云端能力正确降级」的唯一闸门，且正对离线版目标用户。
- **登记**：**T-192**（待审核 → 改进）

### 🟡 low-2 · `SettingsBackup` 对 `getUserWorkflows()` 不判空，与 `App.vue` 同款调用不一致（T-193）

- **事实**：`getUserWorkflows()` offline 下返回 `{}`（`api.js:117`）。`App.vue:141-144` **判空**（`hosted || {}` + `if (backup && backup.length > 0)`）；`SettingsBackup.vue:308-309` **不判空**（直接 `backup.map(...)`）。
- **可达性**：**当前不可达**——`SettingsBackup.vue:3` 整张卡包在 `v-if="!isOffline"` 里，offline 下同步按钮不渲染。缺口被 `:307` 的 `try` 兜住（弹通用 `message.somethingWrong`）。
- **性质**：与 T-191 同类——同一份数据，一个调用方判了空、另一个没判。是 T-192（offline 无测试）的直接下游后果。
- **登记**：**T-193**（待审核 → 改进）

---

## 五、给后续批次的说明

- **第三批实际体量远小于原计划**：真正的改动只有 478 行（其中 452 行是新测试）。原计划里「离线构建会剥掉云端 handler 函数体，须对着 `build:full` 产物审」这条**不适用于本批**——`workflowEngine` 的云端 handler 用的是运行期 `IS_OFFLINE` 门（不是构建期剥体），二者机制不同。该提醒仍然适用于 `src/content/blocksHandler/handlerAgentReadPage.js`（已排除）。
- **第四批（存量低风险）可考虑收缩**：`workflowEngine` 已确认是上游原样代码，除上述 5 文件外无需逐读。剩余有价值的存量面主要是 `src/utils/shared.js`(1,813) 与 `src/newtab/pages/workflows/[id].vue`(1,945) 的非 agent 部分。

---

## 附录 · 本轮核查命令与依据

- `git diff --stat main...HEAD -- src/workflowEngine/` → 5 files, 478 insertions
- `git diff --name-status main...HEAD -- 'src/**/blocksHandler/**'` → A `content/handlerAgentReadPage.js`、M 三个 workflowEngine 文件
- `git diff main...HEAD -- .../handlerParameterPrompt.js` → **空**（该文件本分支未改动，属上游）
- `grep -rn "IS_OFFLINE" src --include=*.test.js` → 仅 2 处，均为 `false`
- 全仓 `IS_OFFLINE` 计数 → 27 处 / 21 文件
- `find src -name handlerAgentReadPage.js` → 仅 `src/content/blocksHandler/`，全仓无引用
