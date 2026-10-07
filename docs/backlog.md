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

## T-157 — 工具卡的观察值/参数长串撑开面板，产生横向滚动条

登记日期：2026-10-07
来源：2026-10-07 会话（用户反馈「对话中工具调用的细节会撑出容器、出现左右滚动条」）；`AgentToolStep.vue:27-32`
现象：工具卡展开后的 `<pre>` 只有 `whitespace-pre-wrap`，既没有 `break-words` 也没有 `overflow-x-auto`。观察值/参数里出现超长无空格串（长 URL / base64 / data URI / 单行压缩 JSON）时不会在中间断行，横向撑开卡片 → 撑开 transcript；而 transcript 是 `overflow-y-auto`，按 CSS 规范 `overflow-x` 被一并计算为 `auto`，于是整个面板出现左右滚动条。
证据：读代码实测——`AgentToolStep.vue:27` `class="mb-2 whitespace-pre-wrap"`、`:31` `class="whitespace-pre-wrap"`；对比 `AgentConfirmCard.vue:12` 同样承载不可信长文本，用的是 `max-h-48 overflow-auto whitespace-pre-wrap break-words`（有 break-words + overflow-auto）。未做浏览器渲染实测。
影响：编辑器侧栏（内容区 320px）与独立助手页都会出现横向滚动条，对话区被整体横向推移，阅读中断；最坏是长串只能靠横向滚动才读得完。
建议：两处 `<pre>` 加 `break-words`（极端串可用 `break-all`）+ `overflow-x-auto`，容器加 `min-w-0`——把滚动下沉到叶子节点，父级 transcript 不再横向滚。写法照抄确认卡；与 markdown 表格/代码块已有的 `overflow-x-auto` 保持一致。
注：侧栏 `[id].vue:431` 是 `Math.max(360, startWidth + diffX)`，下限 360、只能拖宽不能拖窄，内容区恒 ≥320px——故「拖窄导致下拉硬编码宽度溢出」不成立，勿按那个方向修。
状态：待审核

## T-161 — `test()` 回调里嵌套 `test()`，子测试被静默取消（npm test 常态 2 fail）

登记日期：2026-10-08
来源：2026-10-08 会话（跑 `npm test` 验收 T-153 时发现）；`src/agent/compaction.test.js:371`、`:405`、`:415`、`:429`、`:448`、`:462`、`:493`；`src/agent/tab.test.js:184`、`:195`、`:218`
现象：`compaction.test.js:371` 与 `tab.test.js:184` 的**顶层 `test()` 回调内部又写了 `test()`**。node:test 下父 test 的回调同步返回后，嵌套注册的子测试会被判 `cancelledByParent`（`test did not finish before its parent and was cancelled`），**一条都没真正执行**。表现：`npm test` 恒为 `# fail 2 / # cancelled 6`，其中 5 条是 compaction 的 T-95 用例、1 条是 tab 的 T-08 用例。
证据：实测 —— 单独跑 `node --import ./utils/test-loader.mjs --test src/agent/compaction.test.js` 输出 `fail 1 / cancelled 5`；`npm test` 顶层失败为 `not ok 39 - projectAfterLastCompaction…` 与 `not ok 418 - originOf 解析真实 origin…`。两个文件 mtime 分别为 2026-10-07 12:45 与 2026-10-06 14:53，均早于本轮改动，**非本次引入**。
影响：T-95（活轮次实测上下文）与 T-08（normalize/targetHealth）两组断言**实际未执行**，覆盖静默丢失 —— 表面「只挂了 2 条」，真相是 7 条断言从未跑过。与项目「不静默降级」红线同型：看起来在测，其实没测。
建议：把嵌套的 `test()` 提取为顶层 `test()`（或包进 `describe` + `await`）。改完应见 `# fail 0 / # cancelled 0`。**未做**——超出本轮（T-153/T-158）范围，需单独开一轮并逐条确认提取后断言仍成立（T-95 那 5 条依赖父作用域里的 `piMsg` 辅助函数，提取时要一并搬）。
注：登记源于验收时的一次完整 `npm test`，不是刻意排查 —— 这类「测试自己写坏了」的问题只有看汇总数字（cancelled > 0）才会暴露。
状态：待审核

### 改进

## T-150 — 目标页 chip 的「自动」徽标对非技术用户语义不清

登记日期：2026-10-07
来源：2026-10-07 会话；用户指出初版 UI 评价误读截图后，读 `AgentTabPicker.vue:44-49` 与 `CONTEXT.md` 目标页/pin 概念
现象：chip 上显示「自动」徽标（= targetTab 解析模式：auto 运行时自动选当前页 / pinned 用户固定）。普通用户看不懂「自动」指什么，易误以为是数据来源或抓取模式（初版评价即因此误读）。
证据：推断，未实测（读代码：`AgentTabPicker.vue` 里 `pinned ? pickTab.pinned : pickTab.auto`；`CONTEXT.md` 明定 targetTab 由 pinned→lastAccessed→当前窗口→其他窗口解析，无「无目标」态）。
影响：非技术用户不理解助手正读哪一页、为何有的页可固定有的不能；最坏把「自动」当成某个可切换的功能开关。
建议：
① 文案（零风险，必做）：`pickTab.auto`「自动」→「跟随当前页」；`pickTab.pinned`「固定」→「已固定」。键位 `src/locales/zh|en/newtab.json:775-776`。
② tooltip（零风险）：徽标 span 加 `:title` 解释 auto=助手自动选当前页 / pinned=你已锁定此页（当前整个 chip 只有 `pickTab.title` 一个 title，不解释 auto 含义；`AgentTabPicker.vue:39-49`）。
③ 样式（零风险）：auto 用中性灰、pinned 用 accent 高亮，让「已固定」更显眼（当前两态同色 `bg-gray-500/15`，看不出区别）。
④ 解除固定入口（有逻辑，需评审）：`AgentTabList.vue` 下拉点选即 `onPickTab`→`targetPinned=true`，且**无退回 auto 的路径**——一旦手选就永久 pinned（pin 跨轮持久化于会话 pins，`targetState.js` 的 initialPinsFromTab/upsertPin）。建议下拉加「解除固定 / 跟随当前页」项，调用 host.unpin() 置 `targetPinned=false`（pin 持久化由 CONTEXT「resolveTargetTab 永远解析出一个页」保证退回安全）。代价：新增 host 方法 + runtime 清 pins 接口，牵连会话持久化，单独评审。
状态：待审核

## T-151 — 输入框 placeholder 在独立助手页误导（两宿主共用同一文案）

登记日期：2026-10-07
来源：2026-10-07 会话；读 `AgentPanel.vue:170` 与 `Agent.vue:20-31`
现象（2026-10-07 读代码修正）：输入框 placeholder 两宿主共用 `workflow.agent.placeholder`（「问问这个页面…」）。原登记称「独立页无 targetTab 概念」——**不成立**：`Agent.vue:22` 的 `enabledGroups` 含 `tab` 组（`['page','context','tab']`），两宿主都跑 `resolveTarget`，独立页同样有 targetTab（默认解析当前窗口页）。故「这个页面」在独立页也成立，原「无页可读导致误导」前提证据不足。仅剩的弱点是：独立页用户心智偏「通用助手」，文案可更泛；属可选优化，非缺陷。
证据：读代码实测（`Agent.vue:22` enabledGroups；`agentHost.js:466` 两宿主都 `resolveTarget`；`AgentTabPicker` 仅依赖 targetTab 是否存在）。已推翻原「推断，未实测」结论。
影响：基本无——原担心的「误导」不成立。
建议：降级为「可选文案软优化」或直接驳回。若做，独立页文案改更泛（如「问我任何事」），需 host 暴露标志位区分两宿主（composable 层注入）。非缺陷，是否保留由用户定。
状态：待审核（建议驳回或降级）

## T-152 — 琥珀/黄色被三种语义共用，警示退化（确认门 ≈ notice ≈ 未配置横幅）

登记日期：2026-10-07
来源：2026-10-07 会话（用户追问「UI 上有没有可以改进的地方」）；读 `AgentConfirmCard.vue:2-4`、`AgentTranscript.vue:79-81`、`AgentPanel.vue:88-89`
现象：三类语义完全不同的卡片用了几乎相同的琥珀/黄配色——notice（advisory 善意提醒）`bg-amber-500/10`、确认门（必须由用户裁决的写操作）`border-amber-300 bg-amber-500/10`、未配置 API Key（功能不可用的阻塞态）`border-yellow-300 bg-yellow-500/10`。视觉上无法区分「提醒」「要你裁决」「不可用」。
证据：读代码实测（上述三处 class 逐字比对）。与 T-04「error 曾与 notice 共用琥珀、已改红」是同一类问题，只是确认门与配置横幅当年漏网。
影响：用户把「需要我点允许/拒绝的写操作」看成普通提示而随手放行（最坏：误批 `test_js` / 画布写入）；把「功能不可用」看成轻提醒而反复发消息。
建议：notice 退中性灰（advisory）；确认门升主色 accent + 明确双按钮（需你行动）；未配置改红色（阻塞，发送已禁用则明说）。纯 class 调整，零逻辑风险。
状态：待审核

## T-154 — 思考过程卡与压缩摘要卡视觉完全相同，无法区分

登记日期：2026-10-07
来源：2026-10-07 会话；读 `AgentTranscript.vue:41-69` 与 `:149-173`
现象：`thinking` 折叠卡与 `compaction` 折叠卡的结构、配色（`rounded border-gray-200 bg-gray-50 dark:bg-gray-800/40`）、展开箭头完全一致。但前者是「模型怎么想」，后者是「上面若干轮被压成了一段历史摘要」——语义不同却长得一样。
证据：读代码实测（两处 class 逐字比对）。
影响：长会话里用户看到两张一样的折叠卡，分不清哪张是可忽略的思考过程、哪张是已被压缩的历史（后者意味着原始内容不再进 transcript，见 CONTEXT「压缩摘要」条）。
建议：压缩摘要卡换档案类图标 + 微蓝边框/色调，与思考卡区分。零逻辑风险，纯 class。
状态：待审核

## T-155 — 下拉缺 a11y 语义与键盘导航

登记日期：2026-10-07
来源：2026-10-07 会话；读 `AgentDropdown.vue:1-21`
现象：下拉面板无 `role="menu"`，trigger 无 `aria-expanded` / `aria-haspopup`；打开后会话列表与 tab 列表不支持 ↑↓ 移动选择（对比 `AgentPanel.vue` 的 slash 菜单已实现 ↑↓/回车/Esc）。
证据：读代码实测（`AgentDropdown.vue` 模板无 aria 属性，script 只有 click-outside 与 Esc 关闭）。
影响：屏幕阅读器用户无从获知「这是个可展开菜单、当前开没开」（项目已有 T-13 的 a11y 投入，此处是缺口）；纯键盘用户在下拉里只能靠 Tab 逐项走。
建议：trigger 加 `aria-expanded`、面板加 `role="menu"`（菜单项 `role="menuitem"`）；列表补 ↑↓ 导航 + 回车选中 + Esc 关闭（复用 slash 菜单已有的路由逻辑）。
状态：待审核

## T-156 — 窄侧栏 markdown 表格溢出时没有「可横滑」提示

登记日期：2026-10-07
来源：2026-10-07 会话；读 `AgentMarkdown.vue:73`
现象：markdown 表格容器是 `overflow-x-auto`，但侧栏仅 320px，表格常横向溢出，界面上没有任何视觉提示表明可以横向滑动，用户以为内容被截断。
证据：读代码实测（`AgentMarkdown.vue:73` `<div class="my-2 overflow-x-auto">`，无渐变遮罩/角标/滚动条强化）。
影响：用户看不到表格右侧的列（尤其接口/参数类表格），误判回答不完整，或去翻历史找「完整版」。
建议：长表格加右侧渐变遮罩提示，或滚动时显示「可横向滑动」角标；也可在给模型的输出约定里建议窄表拆分（后者属 prompt 层，改动面更大，先做 UI）。
注：属「推断未实测用户反馈」——代码层溢出无提示是事实，但用户是否因此困惑未做可用性验证。
状态：待审核

## T-159 — busy 态输入区被两个按钮挤到约 208px

登记日期：2026-10-07
来源：2026-10-07 会话（追问空间优化时推算发现）；读 `AgentPanel.vue:173-191`
现象：`host.busy` 时 form 内同时出现「停止」图标按钮与「插话」文字按钮：320 − 16(padding) − 36(停止) − ≈44(插话) − 16(gap) ≈ 208px 留给 textarea，比空闲时的约 240px **更窄**。而 busy 恰恰是用户最想打字（插话）的时候。
证据：读代码 + 按 Tailwind spacing 与按钮 padding 推算，**未做浏览器实测**（实际宽度取决于 ui-button 的内边距与字号）。
影响：插话时输入框可视宽度反而最小，长句要靠横向/纵向滚动才能回看已输入内容。
建议：先量一次真实像素再定方案。可选方向：插话按钮在窄态退化为图标 + `title`；或把「停止」并入已存在的 pendingInterjections 行（`:148`，但该行仅在有排队时出现，需要常驻化）。
注：**本轮不落地**——未实测就改容易改坏（插话是主操作，文字是其语义来源，图标化有风险）。
状态：待审核（需先实测）

## T-160 — disabled 的发送按钮说不出「为什么点不动」

登记日期：2026-10-07
来源：2026-10-07 会话；读 `AgentPanel.vue:183-191`，对照 `AgentSessionList.vue:17-18` 的既有经验
现象：发送按钮 `:disabled="!draft.trim() || !configured"` 且**没有任何 title**。未配 Key 时用户 hover 按钮得不到解释（横幅在别处，未必被看到）。
证据：读代码实测（`:183-191` 无 title 属性）。项目自己在 `AgentSessionList.vue:17-18` 注释里明确写过「disabled 按钮在部分浏览器不派发鼠标事件，title 只挂在按钮上有时弹不出来；容器不是 disabled，稳」——同一面板里这条经验没贯彻到发送按钮（T-11 只在会话列表与新建按钮上贯彻了）。
影响：与 T-11 同一类问题——用户看到「有按钮但不给理由」。没配 Key 时尤其，因为按钮禁用的原因不在按钮上。
建议：照抄 T-11 做法，把 `:title` 挂到**非 disabled 的包裹层**，文案按原因分两种（没草稿 / 没配 Key）。纯属性，但要区分两种原因，属小逻辑，需评审。
状态：待审核

### 新功能（要讨论场景，审得慢）

---
## 已批准（待排期）

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

已解决条目全部在 **`docs/backlog-done.md`**（计数以该文件实物为准，并行会话同日多轮追加）：2026-10-05 拆出 44 条（T-02、T-05、T-06、T-17~T-25、T-26~T-34、T-35~T-43、T-44、T-45、T-47、T-48、B1、B5）；之后各轮：T-61、T-62 与面板 UI 系列（并行会话），T-70、T-71（架构评审 C1），T-82（C3），T-83（C2），T-89 及随其修复的 T-69（C4），T-75、T-76（pi 功能面调研轮：步数上限决策与上下文压缩，2026-10-06），T-91（`list_canvas` 静默截断 200 字符，2026-10-06），T-97~T-103（设置页多 provider 改造轮：密钥明文镜像、独立菜单、多连接、配置测试、图标名、新建连接入口、说明段落，2026-10-06），T-104（归档被截断后的恢复，2026-10-06），T-105（`backlog.md` 与归档失同步，2026-10-06；同批把待审核区的「T-90」改号为 T-107），T-04（报错渲染，并行会话完成）、T-46、T-54、T-56（已消解/已修复）与 T-77~T-80（驳回）——最后一批为 2026-10-06 待审核区按类型分区重构时清出的已裁决条目。2026-10-07 收尾轮补充：B2、B3、B7、B4（B4 交付 `.agent-test/eval/` 任务集，含 T-140 —— 5 个 live 脚本失效随 B4 一并处置）、B9（pi-agent-core 迁移决策记录归档，ADR 0004 / migration spec / tickets / architecture.html 的引用已改指本文件）、T-126、T-137、T-138、T-139、B6（agent:run-js 惰性 CSP 降级，2026-10-07）。2026-10-07 T-81b review 修复轮：T-141~T-149 共 9 条（备份保真、merge 保 enabled/id、技能索引 untrusted 包裹、zip 导入边界、frontmatter 往返、导入上限、导出路径冲突、下载 revoke 时机、索引警告拆分）。

要看「某个坑当初是怎么被实测出来的」，去那个文件；要看「现在该做什么」，留在本文件。

