# 待办登记（会话捕获）

对话中发现的 **bug**、用户提出的 **改进** 与 **新功能** 一律先落在这里，由用户审核后再动代码。流程见 `AGENTS.md`「发现即登记」。

> 编号分工：**T 编号** = 全仓库范围的会话捕获；**B 编号** = 内置助手功能自身的已知欠账（原 `docs/agent-backlog.md`，2026-10-04 合并进本文件，编号与格式沿用，见文末「B 编号」区）。两区不混写。

> **本文件只放未完成的条目。** 已解决的条目在 **`docs/backlog-done.md`**（2026-10-05 拆出）——
> 那里保留完整的现象、实测证据与结论，用于追溯「当初为什么这么定」。
> 状态流转：待审核 → 已批准（待排期） → 进行中 → **完成时整条移入 `backlog-done.md`**。

## 登记模板

条目落进「待审核」下对应类型的子区块（**bug** / **改进** / **新功能**），**类型由所在区块决定，条目内不再写「类型：」行**。类型只取三个裸值；不改变分类的补充说明（如「潜在缺陷，当前无生产者」）写「注：」行。类型判断变化时整条搬到对应区块，并在条目里留一行说明。

```
## T-NN — 一句话标题

登记日期：YYYY-MM-DD
来源：会话日期 + 用户原话 / 触发它的 `文件名:行号`
现象：具体症状与复现条件
证据：实测输出片段或代码位置（无实测就明写「推断，未实测」）
影响：谁在什么情况下会踩，最坏结果
建议：（选填）可选方案与各自代价
注：（选填）类型边界或补充说明
状态：待审核
```

## 待审核

### bug（先审，多数可快速定夺）

#### T-252 — 顶层 SVG 主文档里 elementSelector 起不来：Vue patchStyle 对 style 为 undefined 的元素做 `"top" in` 探测

登记日期：2026-10-13
来源：2026-10-13 会话（T-251 端到端验证时顺带抓到的另一个崩点）；崩点在 `elementSelector.bundle.js:22:41721`（minified，对应 Vue runtime 的 patchStyle vendor-prefix 探测）
现象：**直接打开一个 `.svg` 文件**（或任何以 `image/svg+xml` 为主文档的页面），唤起元素选择器：面板完全不出现，控制台一条 `TypeError: Cannot use 'in' operator to search for 'top' in undefined at .../elementSelector.bundle.js:22:41721`，被 `elementSelector/index.js` 的外层 try/catch 吞掉。`#app-container`、shadowRoot、`#app` 全都没建出来。与 T-251 是两个不同崩点：T-251 修的是 **iframe（非主 frame）路径**（SVG frame 里 `document.body` 为 null），本条是**主 frame 落在 SVG 主文档上**时 Vue 应用启动失败。
证据：**实测**（`.scratch/verify-t251-topsvg.mjs`：playwright 加载真实 `build/`，`goto http://example.com:8085/doc.svg`，确认 `document.body === null` / `document.head === null` / `documentElement.tagName === 'svg'`，再经 `chrome.scripting.executeScript` 注入 `elementSelector.bundle.js`）：注入后 +500/+1500/+3000ms 三次采样，`appContainer:false`、`shadowExists:false`、`appDiv:false`、`styleTexts:[]` 恒定不变；console 里只有那一条 TypeError。产物侧定位：`build/elementSelector.bundle.js:22` 第 41721 列落在 Vue runtime 的 `patchStyle` 里，具体是 CSS 属性 vendor 前缀探测 `…if("filter"!==r&&r in e)…`（`e` 即 `el.style`），报错字符串里的 `"top"` 就是被探测的属性名 —— 也就是说 **Vue 对一个 `el.style` 未定义的元素做了 style patch**。
影响：直接打开 SVG 文件（设计资源、图标、SVG 导出的图）时选择器整体不可用；录制工作流面板（`recordWorkflow/main.js` 同样 `createElement('div')` + Vue + shadow DOM）大概率同病，**推断，未实测**。发生率低（要主文档恰是 SVG），但一旦命中就是「选择器在这个文件上完全打不开」且控制台信息毫无指向性。
建议：留空，待判断。可能的切法：① 在 `elementSelector/index.js` 与 `recordWorkflow` 入口按 `document.contentType` / `documentElement.tagName` 直接 return（与 `commandPalette` 的 json/xml/svg 排除一致，最省事但放弃该场景）；② 查清 Vue 为何拿到 style 未定义的元素后修根因（可能是 SVG 主文档里 `createElement('div')` 的宿主行为差异）；先 ① 止损、② 另开票。
注：机理**只定位到崩点，未完全定性**（production 堆栈已压缩、无 sourcemap），条目里关于「哪个元素的 style 未定义」是推断，勿当结论。T-251 的 domMount helper 覆盖不到本条 —— 那时 Vue 应用已经启动失败，还没走到挂载。
状态：待审核

#### T-249 — 存包时 `asBlock` 写在顶层，拖入画布却读 `settings.asBlock`，「设为模块」开关失效

登记日期：2026-10-13
来源：2026-10-13 会话（用户问「包在工作流里怎么用」，读这条链路时发现）；`src/newtab/pages/workflows/[id].vue:1041` 写 vs `:1503` 读
现象：从画布选中若干块 → 「保存到包」弹窗里把「把包设为模块」打开 → 存下来的是顶层 `asBlock: true`，而 `settings.asBlock` 仍是默认 `false`。之后把这个包从包抽屉拖进任意工作流，落地的不是单个包块，而是把包内部的全部节点/连线**平铺展开**贴进画布 —— 开关等于没生效。
证据：读码确认，**推断，未实测**（未起扩展复现）。① `packageStore.insert` 是 `{...defaultPackage, ...data}`（`src/stores/package.js:44`），`defaultPackage.settings = { asBlock: false }`（:15-17）只会被同名的 `settings` 覆盖，`data.asBlock` 这个顶层字段覆盖不到它；② 写入侧 `[id].vue:1041` 传的是顶层 `asBlock: blockFolderModal?.asBlock ?? false`（弹窗状态在 :1011）；③ 读取侧 `[id].vue:1503` 判的是 `savedBlocks.settings.asBlock`，为真才加 `BlockPackage` 单节点（:1504-1512），否则走 `copyElements` 平铺（:1513-1520）；④ 包详情页的开关写的是正确位置 `packageState.settings.asBlock`（`src/components/newtab/package/PackageSettings.vue:3`），全仓 `settings.asBlock` 的生产者只有它一处。
影响：只有「先建包 → 去包详情页开 asBlock → 定义输入输出」这条路径能做出可复用的包块；「选中块直接存包」这条更快路径上勾了开关也没用，用户会以为是自己没配对。最坏结果是被平铺展开的节点与包再无关联，后续包更新同步不到这些副本。
建议：`saveBlockToFolder` 里改成 `settings: { asBlock: blockFolderModal?.asBlock ?? false }`（同时保留/去掉顶层字段二选一，别两处并存）；改完顺手确认 `defaultPackage` 的 `variable: []` 是否也有人往顶层写而别处读 `settings.*`。
注：功能可用性缺陷，不是崩溃；与包块的运行时展开（`handlerBlockPackage.js`）无关。
状态：待审核

#### T-231 — `restartWorkersCount` 从未初始化，「出错重启工作流」整条策略崩溃

登记日期：2026-10-12
来源：`src/workflowEngine/WorkflowWorker.js:438`
现象：`onError === 'restart-workflow'` 分支里读写 `this.engine.restartWorkersCount[this.id]`，但全仓库没有任何一处初始化这个对象（`WorkflowEngine` 构造函数与 `reset()` 都没有）。一旦命中该分支，在**错误处理块内部**直接抛 TypeError。
证据：读码确认 —— `grep -rn "restartWorkersCount" src/` 全仓库只有 3 处引用，全在 `WorkflowWorker.js:438/442/452`，无初始化点。
影响：任何把工作流「出错时」设为「重启工作流」的用户，块一报错就撞这个 TypeError；catch 块内没有二次 try/catch，异常变成未处理 rejection，工作流既不重启也不 destroy，state 永久停在 `running`，只能杀扩展。重启次数上限（`restartTimes`）因此整体失效。
建议：在 `WorkflowEngine` 构造函数里建 `this.restartWorkersCount = {}`，并在 `destroy()` 时清理；同时给这段 catch 加二次保护。
状态：待审核

#### T-232 — `BackgroundWorkflowTriggers.js:196` 把实例方法当静态调，启动触发器注册整体中断

登记日期：2026-10-12
来源：`src/background/BackgroundWorkflowTriggers.js:196`
现象：`await BackgroundWorkflowUtils.executeWorkflow(currWorkflow)` 少写了 `.instance`。同文件另外 4 处（:37/:107/:143/:191）都是 `BackgroundWorkflowUtils.instance.executeWorkflow(...)`。
证据：读码确认 —— `src/background/BackgroundWorkflowUtils.js:124` 的 `async executeWorkflow(...)` 无 `static` 修饰（该类只有 `flattenTeamWorkflows`、`getWorkflow` 两个 static）。
影响：浏览器启动（`onRuntimeStartup`）或扩展更新时，若某工作流的 `trigger.triggers` 里含 `on-startup`，此处抛 TypeError；`reRegisterTriggers` 整个函数没有 try/catch，for 循环当场中断，**其后所有工作流的 `registerWorkflowTrigger` 全部不执行** —— 重启后定时/访问网页等触发器大面积静默失效。
建议：补 `.instance`；顺带给 `reRegisterTriggers` 的循环体加 per-item try/catch，别让一个工作流带崩其余。
状态：待审核

#### T-233 — 本地备份「备份工作流」原地删 store 里的活对象字段，污染落盘数据

登记日期：2026-10-12
来源：`src/newtab/pages/settings/SettingsBackup.vue:337-345`
现象：`workflowStore.getWorkflows.reduce(...)` 里对遍历到的每个 workflow 执行 `delete workflow.$id / createdAt / data / isDisabled / isProtected`，然后 `acc.push(workflow)`。这是**原地删**，不是拷贝。
证据：读码确认 —— `src/stores/workflow.js:108` 的 `getWorkflows: (state) => Object.values(state.workflows)` 返回的是 state 里真实对象的引用（Pinia state 是 reactive），`Object.values` 不解绑。
影响：点一次「备份工作流」，store 里所有未保护工作流的 `createdAt` / `isDisabled` / `isProtected` 被抹掉 —— 列表排序错乱、已禁用的工作流变回启用、保护标记丢失；后续任何一次 `saveToStorage` 会把这份残缺数据写进 storage，重启后依然是残缺的。属于静默数据损坏。
建议：`acc.push({ ...workflow })` 先浅拷再删，或直接白名单挑选要导出的字段。同类写法见 `src/components/newtab/settings/SettingsCloudBackup.vue:449-456`（那里 `data.map(async () => {...})` 回调不接元素，用的是外层 `data` 本身，建议一并核）。
状态：待审核

#### T-234 — `WorkflowWorker.reset()` 丢 `activeTab.id` 与 `referenceData.secrets`

登记日期：2026-10-12
来源：`src/workflowEngine/WorkflowWorker.js:482`（`id: this.options?.tabId`）与 `:484-491`（referenceData 重写）
现象：两处都在 `reset()` 里。(a) `this.options` 在 `WorkflowWorker` 上根本不存在 —— 构造函数（:38）只把 `options.blocksDetail` 取出来赋给 `this.blocksDetail`，从未 `this.options = options`，所以 `activeTab.id` 恒为 `undefined`。(b) 重写的 `referenceData` 少了 `secrets` 字段，而引擎原始构造（:84-92）里有 `secrets: {}`，`:323` 还有 `this.referenceData.secrets[name] = value` 的写入。
证据：读码确认 —— `grep -n "this.options" src/workflowEngine/WorkflowWorker.js` 全文件只有 :482 一处引用，没有赋值点。
影响：(a) 走到 `reset()` 的工作流，重启后第一个需要标签页的块立刻抛 `no-tab`（:496-501）；(b) 重启后 JS 块里 `automaRefData('secrets', ...)` 与模板 `{{secrets@...}}` 取到 undefined，或直接在 `:323` 抛 TypeError。仅在重启路径（T-231 的分支）与手动 reset 触发，但一旦触发整条后续流程全废。
建议：`id: this.engine.options?.tabId`；`referenceData` 补 `secrets: {}`（并顺带确认 `googleSheets` 等其它字段是否也有遗漏）。与 T-231 同源，可一起修。
状态：待审核

#### T-235 — `addRefDataSnapshot` 把键名写回裸名，快照永不递增、互相覆盖

登记日期：2026-10-12
来源：`src/workflowEngine/WorkflowEngine.js:348-354`
现象：`refDataSnapshotsKeys[key].index += 1` 之后紧接着 `refDataSnapshotsKeys[key].key = key`，把构造时形如 `##variables0` 的带索引键名覆盖成裸名 `variables`；第 352 行再拿它当 keyName，`refDataSnapshots[keyName]` 每次都写到同一个键上。
证据：读码确认 —— :349-353 三行连续，自增的 `index` 计算完就再没被读过。
影响：所有快照只留最后一次。日志详情页（`EditorDebugging.vue:177-178` 用 `dataSnapshot[referenceData.variables]` 取快照）拿到的永远是最终值，逐步回放数据在调试面板上是错的；`##loopData0` 这类首轮快照根本不存在，回退成空对象。对任何运行中工作流都生效（init 就会调一次）。
建议：删掉 :350 那行，让 keyName 由 index 拼出（`##${key}${index}`），并补一条「连续两次快照得到两个不同键」的测试。
状态：待审核

#### T-236 — `updateBlockData` 的 250ms debounce 在回调里延迟读 `blockId`，会把 A 的字段写进 B

登记日期：2026-10-12
来源：`src/newtab/pages/workflows/[id].vue:778-810`
现象：debounce 回调体里现读 `editState.blockData.blockId` 与 `.itemId`，而不是发起时捕获的那一份。
证据：读码确认 —— :781 的 `editor.value.getNode.value(editState.blockData.blockId)` 在 250ms 后才求值。
影响：改完块字段后 250ms 内点另一个块 → 前一个块的数据被写进后一个节点（字段串味，且 UI 看不出来）；若这期间点了返回箭头触发 `closeEditingCard`（:912-917 把 `blockData` 置空），`getNode.value(undefined)` 返回 undefined，`:796 node.data = dataCopy` 直接 TypeError。
建议：debounce 前捕获 `{blockId, itemId}` 闭包传进去，回调体不再读 `editState`。
状态：待审核

#### T-237 — 顶栏任何写操作都无条件清掉 `dataChanged`，未保存改动静默丢失

登记日期：2026-10-12
来源：`src/newtab/pages/workflows/[id].vue:1371-1372`（`onActionUpdated`）
现象：`state.dataChanged = changedIndicator;` 无条件赋值，而 `updateWorkflow` 的 `changedIndicator` 默认 `false`。
证据：读码确认 —— :1372 直接赋值；同页 :242/:243/:754/:1182 等处都是 `state.dataChanged = true`，唯独这一条从外面盖回来。
影响：画布有未保存改动时，点「重命名」「启用/停用」（:199）或「编辑详情」后，`dataChanged` 变成 false，离开页面的未保存确认（`onBeforeLeave` :1792）不再弹 → 直接丢改动。对用户是「我明明改了，它一声不吭就没了」。
建议：改成 `if (changedIndicator) state.dataChanged = true;`（只升不降），或让各 action 显式传值。
状态：待审核

#### T-238 — `removeModel(p, index)` 拿下标当对象取 `.id`，删掉在用模型后 activeModelId 指向空气

登记日期：2026-10-12
来源：`src/newtab/pages/settings/SettingsAgent.vue:582-589`
现象：形参 `index` 是 `p.models` 的下标（模板 :242 传 `removeModel(p, mi)`），函数体却写 `activeModelId.value === index.id` —— 恒为 `undefined`，比较永不成立。
证据：读码确认 —— :582 `p.models.splice(index, 1)` 用的是下标语义，:585 又当对象用。正确写法应先取 `p.models[index].id` 再 splice。
影响：删掉正在使用的模型后 `activeModelId` 不回退，助手仍指向一个已不存在的模型 id；下次 send 用空/错模型发请求。相邻的同款逻辑（:570-578 删 provider）写法是对的，可以照抄。
建议：splice 前先 `const removedId = p.models[index]?.id`，再按 removedId 比较回退。
状态：待审核

#### T-239 — `throttle` 只丢弃不延后，托管工作流退出前最后一次上传被静默吞掉

登记日期：2026-10-12
来源：`src/utils/helper.js:73-85`（实现）+ `src/newtab/pages/workflows/[id].vue:812`（`updateHostedWorkflow = throttle(async () => {...}, 5000)`）
现象：`waiting` 期间的新调用被直接扔掉，没有 trailing 执行。而 `updateHostedWorkflow` 正是被 `onBeforeUnmount` / `onBeforeLeave` 拿来做退出前最后一次 flush（:1790、:1889）。
证据：读码确认 —— throttle 体内 `if (!waiting) { callback.apply(...); waiting = true; setTimeout(...) }`，else 分支什么都不做。
影响：编辑托管工作流时，5 秒内有过一次自动上传，然后关闭页面 → 退出前那次保存被丢弃，托管端永远落后一个版本，且用户没有任何提示。
建议：给 throttle 加 trailing（`debounce`-like 的尾部执行并带上最后一次 args），或把退出路径改成显式 await 一次非节流版本。其余 throttle 调用点建议一并核（是否都接受「丢弃」语义）。
状态：待审核

#### T-240 — 快捷方式入口 `checkParam` 拼错（少一个 s），参数窗口每次都弹

登记日期：2026-10-12
来源：`src/execute/index.js:56` vs `src/workflowEngine/WorkflowEngine.js:155`
现象：写入 options 的是 `checkParam: !hasVariables`，引擎读的是 `this.options?.checkParams ?? true`。
证据：读码确认 —— 前者单数、后者复数，两处无别名映射，默认 `true` 生效。
影响：用 `chrome-extension://.../execute/index.html#/<id>?var=...` 这类带参快捷方式/webhook 调工作流时，URL 里明明带了变量，引擎仍走参数检查分支弹出输入框，自动化链路被打断；`execute/index.js:60` 还会在 1s 后 `window.close()`，窗口直接消失。
建议：统一成 `checkParams`。
状态：待审核

#### T-241 — `handlerLoopData` 对表格/列数据 `reverse()` 原地反转引擎里的真实数组

登记日期：2026-10-12
来源：`src/workflowEngine/blocksHandler/handlerLoopData.js:102-104`（配合 :27/:29 的 `getLoopData`）
现象：`loopThrough` 为 `table` / `data-columns` 时 `getLoopData` 返回的是 `refData.table` / 引用本身（展开自 `this.engine.referenceData`，同一数组引用），随后 `currLoopData.reverse()` 是原地反转。
证据：读码确认 —— :27/:29 直接 `return refData.table` 类取值，:103 调 `.reverse()`；`Array.prototype.reverse` 是 in-place。
影响：循环数据源选「表格」并勾选 reverseLoop 时，引擎里的 `referenceData.table` 被就地倒序 —— 导出数据、后续 `addDataToColumn`（按 index 写入）与最终落库的表格全部错位。用户只要求「反着遍历」，不要求改数据本身。
建议：`[...currLoopData].reverse()`，或让 `getLoopData` 返回拷贝。
状态：待审核

#### T-242 — 下载完成回调按队首乱序匹配，并发下载时文件名与回调张冠李戴

登记日期：2026-10-12
来源：`src/background/index.js:1256-1258`
现象：`handleDownloadCreated` 里对任意新下载都执行 `pendingRequests.shift()` 取队首，完全不按 `tabId` / URL / 文件名匹配 —— 而 pending 请求里存了 `tabId`（:1414）却没拿来用。
证据：读码确认 —— :1256 无条件 shift，无匹配判据。
影响：两个及以上工作流（或多标签页）并发触发下载时，A 的下载被赋成 B 的文件名，完成回调打给错误的工作流，后续块拿到错的下载结果继续执行。
建议：按 `tabId` + URL（或 filename 建议值）匹配取对应 pending 项，取不到就当作非工作流触发的下载忽略；并给 pending 项加超时清理，避免无限堆积。
状态：待审核

#### T-243 — 「执行工作流」块在子工作流提前 return 的路径上永久挂起

登记日期：2026-10-12
来源：`src/workflowEngine/blocksHandler/handlerExecuteWorkflow.js:19-34`
现象：块用 Promise 包住子引擎，只靠 `engine.on('destroyed')` 一个出口 settle。但 `WorkflowEngine.init()` 有 4 条**提前 return 且不调 destroy** 的路径：子工作流被禁用（:125）、drawflow 无节点（:135-136）、找不到 trigger 块（:144-145）、trigger 定义了 parameters 弹出参数窗口后（:234）。这 4 条路径下 `destroyed` 永不触发。
证据：读码确认 —— :19 `new WorkflowEngine(...)` → :20 `engine.init()` → 只挂 `on('destroyed')`；对照 `WorkflowEngine.js:130-131` 那条（states 缺失）是有 `this.destroy('error')` 的，说明「提前 return 必须 destroy」是既有约定，另外 4 条漏了。
影响：父工作流用「执行工作流」块调用一个被禁用 / 空画布 / 无 trigger / 带参数的子工作流时，该块永久挂起（除非设了 blockTimeout），父工作流既不停也不报错，日志无任何痕迹。
建议：在 `init()` 的每条提前 return 上补 `this.destroy(...)`（含明确的 status/message，让父块能 reject 成一条可读的 error）；或让 handler 侧加一个兜底超时。
状态：待审核

#### T-244 — 错误轮与压缩摘要的 token 消耗完全不计入会话 usage

登记日期：2026-10-12
来源：`src/agent/loop.js:1141`（错误轮 return 丢 usage）+ `:615-646`（`requestSummary` 走独立 stream）
现象：两处漏计。(a) `send()` 在 `if (errorEv) { ... return errorEv; }` 处直接返回，没有把 try 里已 `harvestUsage(usage)` 累加的结果带出去，index.js:552 拿到的 `result.usage` 是 undefined，按 0 累加 —— 尤其是跑了「压缩一次 + continue() 续跑」的溢出恢复路径，那一轮可能比正常轮还贵，账面却是 0。(b) T-76 的压缩摘要走 `streamFnWithRetry` 的独立请求，结果不进 `piAgent.state.messages`，`harvestUsage` 扫的全是 `piAgent.state.messages`，所以每次摘要的 input/output 永远扫不到。
证据：读码确认 —— `loop.js:1141` 的 return 语句只带 errorEv；`harvestUsage`（:580-588）的遍历源恒为 `piAgent.state.messages`，`requestSummary` 的 `stream.result()` 不写回该数组。
影响：设置页/面板显示的累计 token 系统性偏低，多轮长会话（恰恰是最会触发压缩的会话）偏差最大；用户据此判断成本会低估。
建议：(a) 错误轮把 `usage` 一并带出（或让 index.js 走 `agent.getUsage()` 之类的读口）；(b) 摘要请求结束后从 `result.usage` 直接累加。是否要把内部开销算进用户可见用量，属于产品口径，建议先定口径再改。
注：是否为缺陷取决于「用户可见 usage 是否应含内部开销」的口径，先审口径。
状态：待审核

### 改进

#### T-245 — AGENTS.md「把 build/ 重命名挪开」没写命名约定，随手起的旧目录名会逃逸 .gitignore

登记日期：2026-10-12
来源：2026-10-12 会话；`AGENTS.md`「命令与本机坑」第 2 条 vs `.gitignore:15`（`/build.bak.*`）
现象：按 AGENTS.md 的字面做法把 `build/` 重命名挪开时，命名由执行者自定。`.gitignore` 只为这个用途准备了 `/build.bak.*`（点号）一条，其上方注释还写着「构建前把旧 build/ 挪开…时产生」。用连字符命名（本次实际用了 `build.old-20261012`）不匹配，目录逃逸忽略规则。
证据：实测 —— `git check-ignore -v build.old-20261012` 无输出（未被忽略）；改名后 `git check-ignore -v build.bak.20261012` 命中 `.gitignore:15`。扫与不扫的差别直接体现在 lint 上：`npm run lint` 从 **49 秒 / 0 error / EXIT=0** 变成 **18 分钟跑不完 + `FATAL ERROR: Reached heap limit`（exit 134）**；那 7.5M 旧产物里含 3.4MB 的 `newtab.bundle.js` 与 900KB 的 `offscreen.bundle.js`。
影响：任何一次「挪开 build/ 再重建」之后跑全量 lint（或任何按 `.` 递归扫目录的工具），都会把旧构建产物当源码解析，轻则慢十几倍，重则 OOM 崩掉。症状表现为「lint 突然 OOM」，很难联想到根因是自己刚 mv 出来的目录名。
建议：① AGENTS.md 那条坑里把命名写死为 `build.bak.<日期>`，与 `.gitignore` 对齐（代价为零，推荐）；② 或放宽 `.gitignore`，补 `/build.old*` 一类通配（更宽容，但要动忽略规则，可能误伤同名源码目录）。
注：本次已按 ① 把目录就地改名为 `build.bak.20261012` 恢复正轨，**代码与配置均未改动**；本条只为修文档口径。
状态：待审核

#### T-248 — 全项目 toast 都用 vue-toastification 裸默认样式，尺寸与配色均未项目化

登记日期：2026-10-12
来源：2026-10-12 会话；用户原话「（助手面板解除固定的那条通知）我觉得有一点大，颜色也有点不符合项目」。这是原 T-247 的一部分 —— 该条的那一处 toast 已按用户决定**整条删除**（见 `docs/backlog-done.md` T-247），本条是它未覆盖的其余部分。
现象：全项目的 toast 都走 vue-toastification 的**出厂样式**，从未项目化：① **尺寸** —— 库默认 `min-width: 326px / min-height: 64px / padding: 22px 24px / 正文 16px`，在助手面板（内容区 320px）这类窄宿主里比宿主还宽；② **配色** —— `success=#4caf50` / `error=#ff5252` / `info=#2196f3` / `warning=#ffc107` 全是库 CSS 里硬编码的 Material 色，不在项目 `--color-*` token 里。
证据：
- 全局注册无任何 options：`src/newtab/index.js:23` 与 `src/sidepanel/index.js:35` 都是裸 `.use(vueToastification)`；`src/lib/vue-toastification.js` 只 import 默认组件 + `dist/index.css`。
- 项目唯一的 toast 定制是 `src/assets/css/tailwind.css:204` 的 `.Vue-Toastification__toast { font-family: inherit !important }` —— 只改字体，尺寸与配色全是库默认。
- 默认样式（`node_modules/vue-toastification/dist/index.css` 实读）：`.Vue-Toastification__toast{min-height:64px;min-width:326px;padding:22px 24px;border-radius:8px}`、`.Vue-Toastification__toast-body{font-size:16px;line-height:24px}`、`.Vue-Toastification__toast--success{background-color:#4caf50}`、`.Vue-Toastification__container{width:600px}`；另有 `<600px` 视口一套 `width:100vw / border-radius:0 / top:0`（浏览器侧栏宿主很可能命中，观感更「大」，变成贴满宽度的直角条）。
- 调用面：全仓 30+ 处 `toast.success/error`（`SettingsProfile` / `SettingsBackup` / `SettingsAgent*` / `WorkflowShare*` / `UiFileInput` / `StorageVariables` 等），共用同一份样式。
影响：观感层面全项目一致，但与项目视觉语言（三层底色 canvas/surface/field、accent/primary/danger/warn、圆角 chip/control/card）脱节，窄宿主里尤其突兀。T-247 删掉的只是助手面板那一条，其余 30+ 处原样保留 —— 这条是那批的**共同**欠账，不是某一处。
建议：① 在 `src/lib/vue-toastification.js` 或 `tailwind.css` 层给 `.Vue-Toastification__*` 做一次项目化（尺寸收一档 + 语义底色改用 `--color-*`），一处生效、全项目统一；代价是要逐一核对各调用点的观感（推荐）。② 只改窄宿主相关的几处，代价是同一套通知出现两种长相。
注：纯观感统一，无功能缺陷。T-247 的处置（冗余通知该删而不是该美化）对这批同样适用 —— 动手前先过一遍：这 30+ 条里有多少本身也是冗余的？
状态：待审核

#### T-262 — 工作流日志里的块错误消息有 40 条没有 `log.messages` 词条，中文用户看到裸英文（机制早已存在，是补词条 + 少量 slug 化）

登记日期：2026-10-14
来源：T-261 修复时顺着「这两条错误消息为什么会进用户视野」往上追。（**2026-10-14 同日已完成评估**，结论见下；初稿的两处判断已被实测推翻，一并纠正。）
现象：块处理器抛出的错误消息会**原样进工作流日志**（`WorkflowWorker.js:375-379` 把 `error.message` 与 `error.data`/`error.ctxData` 一起摊进日志条目；`LogsHistory.vue:141` / `:264` 直接渲染 `{{ item.message }}`，导出日志也带它）。而日志侧**早就有一套消息翻译机制**，只是没覆盖全。
**机制（已有，不需要新建）**：`translateLog` 把 `log.message` 当 key 去查 `log.messages.<message>`（`t(path, params)` 的 `params` 就是整条 log，故 `{selector}`/`{url}` 这类占位符靠日志对象上的字段插值），查不到就**回落成原始英文**。两处实现：`src/utils/getTranslateLog.js:14`（供「Log Data」块 `handlerLogData.js:22` 输出）与 `src/components/newtab/logs/LogsHistory.vue:542`（供日志 UI）—— **两份是逐字复制**，逻辑同步但属重复知识。词条现挂在 `src/locales/{en,zh}/newtab.json` 的 `log.messages`。
**精确盘点**（脚本扫 `src/workflowEngine` + `src/content` + `src/sandbox` + `src/background`，模式 `new Error(` / `generateError(` / `onError(new Error(` / `error.message = '<字面量>'`，排除 `.test.js` 与 `console.*` 行）：
- 字面量 **102 处 / 去重 62 条**。
- **已覆盖**：**22 条 key、命中 55 处**（slug 形态：`no-tab`/`element-not-found`/`no-permission`/`invalid-active-tab`/`empty-workflow`/`no-clipboard-acces`/`active-tab-removed`…）。`log.messages` en **27 条**、zh **也 27 条、零缺** —— 这一半是好的。（余下 5 条 key 不由扫描到的字面量产生：`stop-timeout` 是运行时赋值、`no-match-tab` 走 `handlerSwitchTab.js:6` 的局部 `generateError` helper，`invalid-url`/`workflow-disabled`/`not-debug-mode` 同理。）
- **未覆盖**：**40 条 / 命中 47 处**（中文用户看到的就是这些英文）：
  - **需插值 12 条**：`Can't find ${data.eventName} event`；`Cant find "${data.varSourceName}" variable`（`handlerDataMapping`/`handlerSortData`）与 `Cant find "${data.variableName}" variable`（`handlerIncreaseVariable`/`handlerRegexVariable`）；`Can't map data with "${dataType}" data type`；`Can't sort data with "${dataType}" data type`；`Can't find download item with "${item.path}" id`；`Can't find block with "${inputNextBlockId}" id`；`Can't find a loop with "${block.data.loopId}" loop id`；`Can't find a tab with ${data.tabIndex} index`（`handlerSwitchTab.js:68`）；`"${data.label}" doesn't have a handler`；`(${response.status}) ${response.statusText}`；`API request failed: ${response.status}`。
  - **纯静态 28 条**：`Can't find active tab`、`AI Workflow block is not available in offline mode`、`AI Power token is not set`、`Input not found`、`Can't find block for this input`、`timeout`（注意 `log.messages` 有 `stop-timeout` 却没有裸 `timeout`）、`Clipboard block is not supported in background execution`、`Invalid JSON format`、`Invalid URL`、`Google Drive block is not available in offline mode`、`You haven't connect Google Drive`、`Google Sheets block is not available in offline mode`、`Download feature requires download permission`、`Download id is not a number`、`The "type" must be "text" or "json"`、`No workflow is selected`、`No specific flow selected`、`Timeout`、`The body must be 2D Array`、`File not found`、`Element is not a link`、`Iframe not found`、**`Could not establish connection to the active tab`**（`WorkflowWorker.js:552` 的 `error.message = ...` 赋值 —— 这类路径是最初两轮扫描都漏掉的第三类），外加 `src/background/index.js` 调试器 JS-code 通道的 6 条（`Callback is missing or invalid` / `Unable to get JavaScript code` / `Callback did not return JavaScript code string` / `Unable execute code` / `The "type" must be "text" or "json"` / `调试器没有返回结果` —— 最后一条**已经是中文**，与其余不一致；这 6 条也是**最该先确认是否真的进日志**的一批，那是调试器通道，可能只 `console`）。
- **插值路径已有现成先例**：`src/workflowEngine/blocksHandler/handlerElementExists.js:6-7` 就是 `new Error('element-not-found')` + `error.data = { selector: block.data.selector }`，靠 `WorkflowWorker` 摊进日志后 `t()` 才插得出 `{selector}`。**即「抛 slug + 挂 data + 语言包写占位符」是本仓自己的做法**，不是新设计（`handlerSwitchTab.js:6` 那个 `generateError` helper 是同一思路的局部实现，可上提共用）。
**纠正初稿两处错误结论**：① 初稿写「slug 部分与 docs 锚点绑定，本地化不能简单换字」——**不成立**。slug 恰恰就是 i18n key（`log.messages.<slug>`）；docs 锚点是**另一件事**：只有 `messageHasReferences`（`src/utils/shared.js:1825`，仅 5 条 `no-tab`/`invalid-active-tab`/`no-match-tab`/`invalid-body`/`element-not-found`）命中时才把 `messageId = message` 拼成 `workflow-common-errors.html#<slug>` 链接（`LogsHistory.vue:559-561`）。翻译 slug 的**显示文案**不影响这个链接。② 初稿估「37 条」是按出现次数算的；按上面口径重扫后，去重未覆盖实际是 **40 条**、已覆盖另有 22 条（且第三轮又发现 `error.message = ...` 赋值这条扫描盲区，补进 1 条）。
影响：中文用户的工作流一旦有块失败，日志里看到的仍是英文句（28 条静态 + 12 条插值）。
**隐性风险（比漏译更值得注意）**：`log.messages` 的 key 是**整条英文原文**（句子当 key）。即**任何一次英文措辞微调都会静默杀掉对应译文**（回落成英文），而全仓没有任何守卫/测试盯着这件事 —— 这也正是既有 27 条 key 一律用 slug 而不是句子的原因。按「句子当 key」快速补 zh，等于把这个脆弱面从 27 条扩到 55 条。
建议（三选一，按推荐排序）：
- **B（推荐）· 按既有 slug 约定补全**：未覆盖的逐条改成 `throw new Error('<slug>')`（插值那 12 条照 `handlerElementExists` 的样子挂 `error.data`），`log.messages` 补 en/zh 词条。收益：与既有 27 条一致、key 不随措辞漂移、插值那批才有救。代价：触及约 20 个文件（引擎层测试覆盖薄，虽只改字符串也要走端到端回归）；建议**分批**：先插值 12 条 + 高频静态，`background/index.js` 那 6 条先单独确认是否真的进日志（调试器通道，可能只 `console`）。
- **A（最小改动，不推荐单独用）· 只补词条、零代码**：因为 key 就是整条消息串，给 28 条静态句子在 `log.messages` 各加一条 `"Can't find active tab": "找不到活动标签页"` 即可生效，**不动一行引擎代码**。代价：把「句子当 key」的脆弱面扩到 55 条，且**插值的 12 条救不了**（渲染后的串不可能当 key）。
- **C（维持现状）**：日志是诊断面、错误消息偏技术，可接受英文。
**B 的实测风险（动手前必须知道）**：
1. **`error.message` 被当标识符比较**：`src/content/index.js:263` 与 `handlerLoopElements.js:71` 都是 `error.message === 'element-not-found'`。→ B **只能把英文句子换成新 slug，绝不能重命名既有 slug**；且新 slug 一旦将来被改，这类比较会**静默失效**（不是报错，是分支不再命中）。
2. **`error.message = '<字面量>'` 赋值是第三类产出点**（最初两轮扫描都漏了）：`WorkflowWorker.js:552` 的 `Could not establish connection to the active tab` 就是这么漏掉的（已补进上面的清单）。→ 说明「按扫描结果逐条改」≠ 改全，这是本项目反复踩的「扫描归零 ≠ 做完」。
3. **插值参数必须真的挂在 `error.data` 上**：locale 里写 `{dataType}`，但 `params` 是整条 log（= `{message, ...error.data, ...error.ctxData}`）。每条都要确认需要的字段确实由 `error.data` 提供，否则插值出来是**空串**——而且**不报错**，只是显示成 `Can't map data with "" data type`。12 条插值里这是最容易做错的部分。
4. **日志消息会进「Log Data」块的输出 → 用户的工作流变量**（`handlerLogData.js:22` 走 `getTranslateLog`）。即这条消息不只是「给人看」，它可以被用户拿去比较/存变量 —— **改文本等于改数据契约**，这是 B 与 A 共同的副作用（A 也一样会改：译文替换原文）。
5. **无测试网**：已实测确认这 40 条**没有任何一条被测试钉住**，引擎层测试覆盖本就薄（见 T-116）→ 改错没有任何自动信号，只能靠端到端回归兜。
6. **`background/index.js` 那 6 条是否真进日志尚未验证**（调试器通道，可能只 `console`）→ 有可能白改。
注：`check:i18n` **不检查** `log.messages` 的覆盖率（只查 en/zh parity），所以这条缺口不会被守卫发现。若要长期守住，B 之外可再加一条守卫：「引擎层 `new Error` 的字面量必须是 `log.messages` 的 key」（形态同 T-258 的扫描器）。另：`translateLog` 两份重复 + `messageHasReferences` 白名单散在 `shared.js`，属同族的小 hygiene，可顺带合并。
状态：待审核（**评估已完成**；推荐 B、分批；等拍板）

### 新功能（要讨论场景，审得慢）

---
## 已批准（待排期）

> **T-213 已于 2026-10-10 清掉**（header 两行 + composer 下半部重排 + 模型选择器）。
> 完整档案见 `docs/backlog-done.md` 的 T-213 条目；定稿依据仍是设计稿
> `docs/agent-ui-header-composer-redesign.html`。本票附带落地了 T-201 的「放哪」。


### T-81b — skills 两级注入 + read_skill 工具 + zip 导入导出（T-81 拆分第二张）

类型：新功能
登记日期：2026-10-05（2026-10-06 会话评审后拆票定稿）
来源：T-81 原票；2026-10-06 会话逐项拍板设计（见下）。机制借鉴 pi `skills.ts:355-380`（formatSkillsForPrompt 两级注入），代码不搬。
内容：
- **record 形状**：`{id, name, description, body, files: {path: content}, enabled}`，`files` 可缺省；附带文件 text-only（`.md` `.txt` `.js` `.json` `.csv` 等），**二进制/脚本导入时拒收并明确告知，不静默丢**；单技能总量软上限 256K（保存时警告不阻断）。
- **两级注入**：system prompt 只放索引（每技能一行「名称 — 描述」，经 facts 的 `skills` 字段），指示模型任务匹配时用工具读全文；**新增 `read_skill` 工具**（args `{name, path?}`：不带 path 读 SKILL.md 正文，带 path 读附带文件；未命中回 error 观察值并列出可用技能名，模型能自行纠正）。挂 **`context` 组**（2026-10-06 拍板：与 get_variables / get_block_schema 同为「查知识」类，宿主 enabledGroups 零改动；记录级 enabled 已承担启停，不新设组）。class: read，红线兼容。
- **zip 导入导出**：导入吃 `.md` 与 `.zip` 两种；导出单技能 zip（还原 `SKILL.md + files` 目录结构，与 pi / Claude Code 的 skill 文件夹形状互通）+ 全量备份 zip（全部技能 + 模板 + 指令一键导出/导入合并）。**新增依赖 JSZip**（浏览器运行时库；现有 archiver 是 Node 侧构建脚本用不了）。
- **附带文件在本运行时只有「读」没有「执行」**：pi 生态 skill 里的 `.sh`/`.py` 靠 CLI shell 执行面，本 agent 工具链不具备——附带文件定位为参考材料。
- **防撑爆**：索引总量 >4K 保存时警告（不阻断）。~~技能描述 ≤100 字符（保存时校验）~~ —— 2026-10-06 实测修正：生态 skill 描述本就数百字符（是给模型的触发判据），硬闸挡住导入主场景，降级为 UI 编辑时软警告（SKILL_DESCRIPTION_MAX 不再进 validateSkills）。
证据：2026-10-06 会话对 pi 机制的代码核对（skills.ts:355-380）；`utils/build-zip.js:4` 确认 archiver 不能用于浏览器运行时；`Agent.vue:22` / `[id].vue:614` 确认 enabledGroups 现状。
影响：用户可从 pi / Claude Code 生态导入现成 skill 文件夹；助手获得可扩展的任务知识库。
建议：在 T-81a 落地后开工，复用其存储底座与 SettingsAgent section。
状态：进行中（2026-10-06 代码落地，488 测试绿 + build 已重建，待用户实测后归档）

（暂无其他）

---

## B 编号 — 内置助手欠账（原 `docs/agent-backlog.md`，2026-10-04 合并）

每项一条：编号、来源、内容、为什么缓、重开的触发条件。**修完的整条移入 `docs/backlog-done.md`**，并把「缓决原因」换成 `结论：`。新增欠账先登记再排期，不允许「口头知道但不记录」。

（暂无）

---

## 已清 → `docs/backlog-done.md`

已解决条目全部在 **`docs/backlog-done.md`**（计数以该文件实物为准，并行会话同日多轮追加）：2026-10-05 拆出 44 条（T-02、T-05、T-06、T-17~T-25、T-26~T-34、T-35~T-43、T-44、T-45、T-47、T-48、B1、B5）；之后各轮：T-61、T-62 与面板 UI 系列（并行会话），T-70、T-71（架构评审 C1），T-82（C3），T-83（C2），T-89 及随其修复的 T-69（C4），T-75、T-76（pi 功能面调研轮：步数上限决策与上下文压缩，2026-10-06），T-91（`list_canvas` 静默截断 200 字符，2026-10-06），T-97~T-103（设置页多 provider 改造轮：密钥明文镜像、独立菜单、多连接、配置测试、图标名、新建连接入口、说明段落，2026-10-06），T-104（归档被截断后的恢复，2026-10-06），T-105（`backlog.md` 与归档失同步，2026-10-06；同批把待审核区的「T-90」改号为 T-107），T-04（报错渲染，并行会话完成）、T-46、T-54、T-56（已消解/已修复）与 T-77~T-80（驳回）——最后一批为 2026-10-06 待审核区按类型分区重构时清出的已裁决条目。2026-10-07 收尾轮补充：B2、B3、B7、B4（B4 交付 `.agent-test/eval/` 任务集，含 T-140 —— 5 个 live 脚本失效随 B4 一并处置）、B9（pi-agent-core 迁移决策记录归档，ADR 0004 / migration spec / tickets / architecture.html 的引用已改指本文件）、T-126、T-137、T-138、T-139、B6（agent:run-js 惰性 CSP 降级，2026-10-07）。2026-10-07 T-81b review 修复轮：T-141~T-149 共 9 条（备份保真、merge 保 enabled/id、技能索引 untrusted 包裹、zip 导入边界、frontmatter 往返、导入上限、导出路径冲突、下载 revoke 时机、索引警告拆分）。2026-10-10 UI 批次（T-199/200/207/213/214/215 当轮整条移出；滞留的 T-205/206/208~212 于 2026-10-12 随 T-216 补搬、T-203/204 补建归档）。2026-10-11~12 backlog 紧急序逐条清偿：T-229、T-225、T-222、T-184、T-216。2026-10-12 当轮：T-246（模型弹层左对齐）、T-247（删掉解除固定的 toast）。

要看「某个坑当初是怎么被实测出来的」，去那个文件；要看「现在该做什么」，留在本文件。

