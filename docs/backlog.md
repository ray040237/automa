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

## T-225 — `read_page` 把「没有目标页」的裸字符串提示当成功观察值发给模型（isError 为假）

登记日期：2026-10-11
来源：2026-10-11 会话工具 envelope 架构评审（候选 2 的探索 agent 事实清单发现，调用链与两侧源码位置明确，本人未逐行复核执行时序）
现象：`browserAdapter.js:137` 在没有目标页时返回**裸字符串** `'没有确定目标页。请先让用户选一个标签页。'`；`page.js` 的 `read_page` execute 把 `ctx.readPage` 的返回值原样包成 `{payload: res}`（`page.js:153` 一带）——按 adapter 的信封判定这是成功观察值，`isError: false`。模型收到的是「读页成功」+ 正文一句缺目标页的提示。同类：`get_block_schema` 的「块目录为空」分支（`page.js:326-329`）也是语义错误、成功字符串形态。
证据：**源码核对** —— `browserAdapter.js:137`（裸字符串返回）、`page.js:140/153`（`{payload: res}` 包装）、`adapter.js:42-97`（裸字符串直通 → isError:false）；`{error:'x'}` 错形信封走裸值路径变成功观察值的事实同源（`adapter.js:45-49` 只认 own `payload` 键，无测试钉住该路径）。
影响：语义失真但不完全静默——正文有提示文字，模型多数时候能自纠；坏处是确认门判定、错误统计、UI 工具卡（按 isError 分流）都把这次读页当成功。修它要动 browserAdapter 的返回契约（`{ok:false,error}` 化），牵连 targetPage.js 的指纹 probe 链路（probe 依赖 `{fingerprint}` 形状），不宜在 envelope 收口票里顺带。
建议：单独小票——`readPageFromTab` 缺目标页改返回 `{ok:false, error}` 人话形状（与通道超时兜底同族），`read_page`/`find_text`/probe 三处消费点同步适配，测试钉「缺目标页 ⇒ isError 观察值」。
状态：待审核

## T-222 — 上下文水位环把「全session累计计费输入」当「当前上下文占用」用，多轮会话水位虚高

登记日期：2026-10-11
来源：2026-10-11 会话按 improve-codebase-architecture 流程架构评审 `src/agent/`，探索 agent 报告后由本人复核源码坐实；触发点 `src/agent/usage.js:43-52`
现象：会话下拉的上下文水位环（`AgentContextRing.vue`）调用 `contextPercent(usage, contextWindow)`，分子取 `usage.input`。但 `usage.input` 在链路上是**跨轮累加的计费输入总量**：`loop.js:578-588` 的 `harvestUsage` 把每条 assistant 消息的 `usage.input`（那是**单次请求的 prompt 尺寸**）逐条累加，`index.js:666` 的 `accumulateUsage(usageBefore, result.usage)` 再把上一轮的累计值加上——多轮会话里它是单调递增的总和，不是「当前上下文有多大」。
证据：**源码复核** —— `usage.js:50` `const used = Number(usage.input)`；`loop.js:578-588` 逐条累加并注释「多请求轮的 usage 是累加值」；`index.js:527` `usageBefore = rec.usage`（跨轮恢复累计值）+ `index.js:666` 累加。而 `compaction.js:153-208` 已有一段实测依据的完整论述说明为什么裸 `usage.input` 不是当前上下文尺寸（pi 的 input 不含 cacheRead/cacheWrite；跨请求求和是各次 prompt 尺寸之和），并为此实现了 `measuredContextTokens`——但 UI 没用它。
影响：多轮会话水位环单调虚高（10 轮后可能显示 300%+ 的假水位），缓存命中多的会话又偏低；80/95 两档告警阈值在错误分子上触发。纯 UI 误报，不影响模型侧压缩判断（压缩用 `measuredContextTokens`，是对的）。
建议：loop 已算出正确的 `measuredContextTokens`（`runCompaction` 内），把它带在 DONE 事件上（如 `doneEv.contextTokens`），UI 消费它而不是从计费总量反推语义。若产品本意就是「花量仪表」而非「水位」，则改 UI 文案与注释，别叫水位。
状态：待审核

## T-223 — `hasInterruptedTail` 以「最后一条 DONE」为扫描锚点，但 DONE 永不入史，锚点是死的

登记日期：2026-10-11
来源：2026-10-11 会话架构评审 `src/agent/`，探索 agent 报告后由本人复核源码坐实；触发点 `src/agent/sessions.js:118-135`
现象：`hasInterruptedTail(events)` 从「事件历史里最后一条 `agent:done`」之后开始扫描中断尾巴。但 DONE 自 T-72 起是「只发外、不入史」的例外事件（`loop.js:590-598` `emitAndRecord` 注释明写「doneEv 是例外（见 send 末尾：只发外）」，`loop.js:1163` 只 `currentEmit(doneEv)` 不 `history.push`），而持久化记录来自 `agent.getHistory()`（`index.js:665`）——所以**存储里的事件历史永远不含 DONE**，锚点扫描永远找不到，`start` 恒为 0，tail 恒为全部历史。
证据：**源码复核** —— `loop.js:593`（emitAndRecord 注释）与 `loop.js:1163`（doneEv 只发外）；`index.js:665` `pruneEphemeralEvents(agent.getHistory())`；`sessions.js:124-131` 反向扫描 `AGENT_EVENTS.DONE`。历史存量不受影响（该机制上线时 DONE 就已不入史，不存在含 DONE 的旧记录形态）。
影响：当前无实际故障——真正的判定靠悬空 call/result 配对 + 幂等提示，两条都还在工作；但锚点是死代码级的契约漂移：它让人误以为「DONE 在历史里」是事实（与 CONTEXT.md「agent 事件是唯一的事件历史」直接冲突），且重开后的会话无法区分「轮完成」与「轮中止」。后续任何按「最后一条 DONE」分段的新逻辑都会踩同一个空锚点。
建议：二选一——① 让 DONE 入史（emitAndRecord 不再豁免），「history 是唯一账本」名实相符，UI 侧如重复渲染再在 fold 层滤；② 删掉 `hasInterruptedTail` 的 DONE 锚点扫描，注释写明「DONE 不入史，分段只能靠 call/result 配对」。倾向 ②（改动最小、不碰入史契约）。
状态：待审核

## T-229 — hygiene.test.js 的不可见字符守卫依赖工作区换行符，CRLF 工作区（fresh checkout）必假失败

登记日期：2026-10-11
来源：2026-10-11 会话拆 commit 时在 git worktree（autocrlf=true fresh checkout）里独立验证中间 commit，hygiene.test.js 假失败；主工作区（LF）从未复现，故此前所有测试轮都测不出
现象：`src/agent/hygiene.test.js:64-79` 的不可见字符守卫靠 `line.replace(/^\s*\*.*$/, '')` 剥块注释行再扫代码行，但 JS 的 `.` 不匹配 `\r`——工作区文件是 CRLF 时（Windows fresh clone / worktree checkout，autocrlf=true 的默认行为），块注释行剥不掉，注释正文里的 ‹ › ＜ ＞ 〈 〉 示例字符（untrusted.js:11/12/14）直接暴露成违规，测试假失败。
证据：**实测对比** —— 主树（LF）与 worktree（CRLF）同内容：主树 offenders=0、worktree=3；node 单行复现 `' * x ‹foo\r'.replace(/^\s*\*.*$/,'')` 不剥离、去 `\r` 即剥离；`file` 确认两树行尾差异。worktree 用 `-c core.autocrlf=false` 重检出 LF 后 839/838/0 全绿。
影响：Windows 上 fresh clone + 默认 autocrlf 的环境跑 `npm test` 必红，红因与代码质量无关；一切「换机器/CI/fresh checkout」场景都会撞。本项目测试至今只在 LF 工作区跑过，所以一直没暴露。
建议：三选一——① hygiene.test.js 读入后先 `src.replace(/\r\n/g, '\n')` 归一再扫（最小改动）；② 仓库加 `.gitattributes` 强制 `*.js text eol=lf`（治本，fresh checkout 不再产生 CRLF，但触碰全仓行尾需评估波及）；③ 接受现状，文档记「测试只在 LF 工作区跑」。倾向 ①。
状态：待审核

## T-216 — `backlog.md`「待审核」区滞留 9 条已清条目，与本文件头「只放未完成的条目」自相矛盾

登记日期：2026-10-10
来源：2026-10-10 本次会话提交前核对 backlog 状态；触发点 `docs/backlog.md:7-9`（文件头「本文件只放未完成的条目……完成时整条移入 `backlog-done.md`」）与 `docs/backlog.md:65-175`（`### 改进` 区内 9 条 `状态：已清`）
现象：`## 待审核` 下有 9 条状态已是「已清（2026-10-10 完成）」的条目（T-203、T-204、T-205、T-206、T-208、T-209、T-210、T-211、T-212），仍留在待审核区；其中 7 条（T-205/206/208~212）的全文另有一份 `### T-NN` 归档在 `docs/backlog-done.md`，同一条目两处各存一份。同批的 T-199/T-200/T-207/T-213/T-214/T-215 则是按规则整条移出的 —— 同一批里两种处理并存。
证据：**实测** —— `git show HEAD:docs/backlog.md` 后 grep `状态：已清` 得 **0** 命中（HEAD 无此形态，是本工作区新引入的），工作区 `docs/backlog.md` 得 **9** 命中；`docs/backlog-done.md` 里能 grep 出其中 7 条的完整归档（T-203/T-204 无独立归档条目，其状态行指向 T-207）。AGENTS.md「状态流转」原文：「驳回、已消解、已修复的条目同样及时整条移入 `docs/backlog-done.md`——**『待审核』区不留已裁决的条目**」。
影响：用户按「待审核」区逐条审票时会看到 9 条其实已完成的条目，可能重复批准已完成的工作，或误判这些改进还没做；统计未完成条目数失真。不涉及代码。
建议：把 9 条整条搬到 `backlog-done.md`（T-203/T-204 在 done 里没有独立条目，需新建或并进 T-207 那条）；`backlog.md` 只留真正未裁决的 T-189/T-184/T-178/T-186/T-185/T-155/T-201/T-202。**T-201 是「部分落地」**（选择器已可用、多连接弹层组织方式仍待观察），移不移出由用户裁决。
状态：待审核

## T-189 — `MAX_SESSION_TURNS` 的注释还写着「wire 层另有 token 预算」，wire 层已随票 08 删除

登记日期：2026-10-09
来源：2026-10-09 会话 review `docs/agent-architecture.html`（介绍 agent 代码的架构文档）时逐块核对源码，触发点 `src/agent/sessions.js:21`
现象：常量 `MAX_SESSION_TURNS = 20` 上方那句注释是「存储里最多保留多少个用户轮次（**wire 层**另有 token 预算，这里是存储体积上限）」。`wire.js` 在 ADR 0004 / 票 08 已整份删除，现在承担「token 预算」职责的是 `compaction.js` 的上下文压缩（T-76），语义是「模型侧另有压缩阈值」。
证据：**源码核对** —— 全文 grep `wire 层|wire层|wire\.js` 在 `src/`（排除测试）得 4 处，其中 `loop.js:564` 与 `provider.js:5/151` 三处都明确写了「迁移前 / 票 08 删掉了」，是合法的**历史说明**；只有 `sessions.js:21` 这一处把已删模块当成现存模块在描述现状。
影响：注释描述的是「这个上限与谁分工」——它是读代码的人判断「为什么存储只留 20 轮、模型侧会不会也只看到 20 轮」的唯一依据。照现在的写法，会得出「模型侧还有一套 wire 预算」的错误结论，而实际的模型侧机制是压缩（append-only + 投影，历史永不删）。比没有注释更糟。
建议：一行改动，改成「模型侧另有压缩阈值（T-76 `compaction.js`），这里是存储体积上限」。顺带确认 `cropToTurns` 的注释（`:67` 附近）有没有同类表述。
状态：待审核

## T-184 — 块库的分类标题是硬编码英文，中文界面里直接显示英文

登记日期：2026-10-09
来源：2026-10-09 会话评审 agent 助手入口 UI；画设计稿时照实画出来才发现；读 `src/utils/shared.js:1508` 与 `src/components/newtab/workflow/WorkflowBlockList.vue:9`
现象：工作流编辑器侧栏那块库面板，分类标题显示 `Web interaction` / `Browser` / `General` / `Online services` / `Data` / `Control flow` / `Packages` —— 全是英文，且首字母被 CSS `capitalize` 处理过。同一面板里只有「已固定的块」是中文。
证据：代码位置如上，**源码核对**。`categories` 的每个 `name` 是英文字面量，没有 locale 键；`WorkflowBlockList.vue:9` 直接 `{{ category.name }}`，整条链路上没有 `t()`。十个语言包里都没有对应键。
**2026-10-09 用户实拍截图坐实**：块库面板实拍图里分类标题直接显示 `● General`（配一个黄色圆点与右侧 `−`），与同面板上方中文的「已固定的块」同屏混排。视觉观感不再是推断。
影响：所有中文用户，工作流编辑器最常驻的一块面板里，分类标题全是英文；块的名字本身有中文（走 `workflow.blocks.*.name`），所以出现「英文分组 + 中文条目」混排。与本次入口改造无关，是既有缺陷。
建议：给 `categories` 补 locale 键（`workflow.blockCategories.<id>`），`WorkflowBlockList` 走 `t()` 并保留英文兜底（`te()` 判存在，缺语言时回英文而不是显示键名）。改动小、无布局影响，可独立开工。
状态：待审核

## T-178 — `aria-role` 不是合法属性：整个 tab 栏没有 tablist / tab 语义

登记日期：2026-10-09
来源：2026-10-09 会话评审 agent 助手入口 UI；读 `src/components/ui/UiTabs.vue:7` 与 `src/components/ui/UiTab.vue:14`
现象：两个组件写的是 `aria-role="tablist"` / `aria-role="tab"`。WAI-ARIA 里没有 `aria-role` 这个属性——`aria-*` 只承载状态与属性（`aria-label`、`aria-selected` 等），角色一律走 `role`。浏览器把 `aria-role` 当普通未知属性，读屏软件不认。结果：`ui-tabs` 不是 tablist，`ui-tab` 不是 tab；`UiTab.vue:3` 那个写对了的 `:aria-selected` 也就无处附着。键盘上只有 `:tabIndex` 在起作用。
证据：**产物级实测** —— 对 `build/newtab.bundle.js` 等四个 bundle grep，`aria-role` 原样出现各 2 处，上下文为 `"aria-role":"tab"` 与 `"aria-role":"tablist"`，同一段里没有任何 `role="tablist"` / `role="tab"`。源码位置：`UiTabs.vue:7`、`UiTab.vue:14`。
影响：全项目每一处 `ui-tabs`（工作流编辑器、包详情、设置页等）都受影响，不止 agent。读屏用户听到的是一排普通按钮，不会播报「第 2 个标签，共 4 个」；方向键也无法按 tablist 语义在标签间移动。
建议：两处改名 `aria-role` → `role`。改完还需补 `aria-controls` / `role="tabpanel"` 的对应关系才算完整（有 `role="tab"` 却没有 tabpanel 会是另一个 a11y 警告），范围较大，建议单独立项评估。本轮只登记，不动代码。
状态：待审核

### 改进

## T-208 — 复刻 pie 观感第一步：加「三层底色 + 语义文字档」token，用底色代替边框分层

登记日期：2026-10-10
来源：2026-10-10 会话评估「能不能复刻 pie 界面」（产出 `docs/agent-pie-ui-clone-assessment.html`）；用户原话「先做第一步」= 批准该评估里建议的第一步（只改 token 层，不碰组件结构）。
现象：本仓助手面板是「一块白底 + 到处画 `border-gray-*`」——层级靠 1px 边框表达。参考实现 pie 用三层几乎等亮的灰（canvas #FAFBFC / surface #FFFFFF / field #F4F6F8）表达同一个层级，整屏没有一条边框却层次清楚。实测本仓 agent 目录里 `border-gray-200/700` 共 **20 处**、`bg-gray-*` 共 **34 处**，边框是主要分隔手段。
证据：**源码统计** —— `grep -ro "border-gray-[0-9]*" src/components/newtab/workflow/agent/` 共 20 命中；参考值见 `pie-ai-agent/src/sidepanel/index.css:55-108`（`--c-canvas/surface/field/line/fg-1/2/3`），每个都是具体 hex，非估计。
影响：观感层面 —— 边框用得多时整屏都是线，显得「拼装」而非「一体」；窄面板（320px）里尤其明显。不阻塞任何功能。
建议：只加 token、不碰组件结构 ——
1. `tailwind.config.js` 的 `extend.colors` 加 `canvas / surface / field / line` 四档语义色（值走 CSS 变量，与本仓既有 `primary/accent` 同款 `withOpacityValue` 写法）；
2. `src/assets/css/tailwind.css` 的 `:host, :root` 与 `.dark` 补这四组变量的亮/暗值；
3. 逐步把 agent 面板里的 `border-gray-200 dark:border-gray-700` 换成 `border-line`、`bg-white dark:bg-gray-800` 换成 `bg-surface`、面板底 `bg-gray-50 dark:bg-gray-900` 换成 `bg-canvas`、凹陷输入区加 `bg-field`。
注：**不改 `gray` 别名**（`tailwind.config.js:56` 把 `gray` 指向 `colors.zinc`，全项目都在用，动它会波及整个应用）；新 token 与原类并存，可逐个替换、可回退。
注：这一步会让锚在具体 class 串上的旧守卫连锁变红（如 T-187/`panelRender`），**属有意迁移**，需逐条判断「回归 vs 迁移」，不许批量改正则（同 T-207 那次的处理方式）。
状态：已清（2026-10-10 完成）—— 见 `backlog-done.md` T-208：四档语义色 token（canvas/surface/field/line）已入 `tailwind.config.js` + `tailwind.css`（亮暗各一套 RGB 三元组），面板底壳（根/顶栏/左栏分隔/composer 卡）已换 `bg-canvas`/`bg-surface`/`border-line`。**只做第一步（token 层 + 底壳），未碰组件结构与布局**；语义文字档（fg-1/2/3）与正文卡片的面留第二步（= T-209）。

## T-209 — 复刻 pie 观感第二步：把三层底色贯彻到卡片与输入区

登记日期：2026-10-10
来源：2026-10-10 用户实拍反馈「现在这个页面UI和你的设计稿长得不一样啊」（截图见会话记录）。根因：T-208 只做了第一步（底壳换色），而 `docs/agent-pie-ui-clone-assessment.html` §5 画的是三步做完的终态 —— 两者当然不一样。这一步补上「第二步」。
现象：T-208 之后，面板根是 canvas、顶栏/composer 卡是 surface，但**正文区里的卡片、输入区、下拉菜单都还是旧面**：
1. `AgentToolStep.vue` 工具卡外壳仍是 `border-gray-200 dark:border-gray-700`、内部分隔线也是 —— 与新的 line token 不同源；
2. `AgentMarkdown.vue` 代码块仍是 `bg-gray-100 dark:bg-gray-800`、`hr` 仍是 `border-gray-200/700`；
3. `AgentTable.vue` 表头 `bg-gray-50`、单元格 `border-gray-200/700`；
4. `AgentDropdown.vue` 下拉菜单仍是 `bg-white dark:bg-gray-800`、`border-gray-700`；
5. **最要紧的一处**：composer 输入区是 `!bg-transparent`（透出卡片的 surface 白）—— 输入区与白卡糊成一片，「凹陷的 field 面」完全没出来。设计稿里输入区是 `#F4F6F8` 的凹陷灰。
证据：**源码事实** —— `grep -rn "bg-gray-50\|bg-gray-100\|bg-white\|border-gray-200\|border-gray-700" src/components/newtab/workflow/agent/*.vue` 命中工具卡/代码块/表格/下拉/表头多处；`AgentPanel.vue` 的 `<ui-textarea>` class 含 `!bg-transparent`。**渲染实测** —— 用本仓 `utils/sfc-render.mjs` 把工具卡/代码块/用户气泡渲成 HTML 挂真实 `build/newtab.css` 截图核验（产物见 `.scratch/three-layer-audit.html`，一次性脚本不入库）。
影响：观感 —— 面板壳换了，里面还是「边框分层」的旧语言，整体不统一；用户一眼能看出「设计稿跟实际不一样」。不阻塞功能。
建议：把三层底色贯彻到底，**仍然不碰布局结构** ——
1. 正文卡片落 surface（浮起）：工具卡外壳、thinking 卡（已是）、下拉菜单；
2. 凹陷面落 field：markdown 代码块、压缩卡（已是）、表头、**composer 输入区**、T-200 的复制按钮底；
3. 一切分隔线走 `border-line`，清掉 agent 目录里残留的 `border-gray-200/700`；
4. 用户气泡、notice 行这类**有独立语义**的底保持不动（气泡是蓝灰、notice 是 advisory 灰）。
注：**再次会有旧守卫连锁变红，逐条判断**：T-171 的 `MUST_OVERRIDE` 清单（`!px-1/!py-1/!bg-transparent`）、`!rounded-none` 断言 —— 它们钉的是「必须带 ! 才能盖掉组件自身」这条不变量，值变了但不变量没变，改 want 列即可，断言逻辑不动。
状态：已清（2026-10-10 完成）—— 见 `backlog-done.md` T-209。

## T-210 — composer 卡片里有一个孤立的 `>` 文本节点，渲染成可见乱码字符

登记日期：2026-10-10
来源：2026-10-10 用户实拍截图 —— composer 卡片上沿浮着一个孤零零的「<」字符。
现象：`AgentPanel.vue` 的 composer 卡片（`class="rounded-card border border-line bg-surface ..."`）里，紧跟开标签之后有一个**孤立的 `>`**。它落在已经闭合的标签之后，被 Vue 当成**文本节点**渲染出来，成了一个可见的乱码字符。
证据：**代码事实** —— `AgentPanel.vue` 模板里该行只含一个 `>`，上一行是已闭合的 `<div ...>`。**全量扫描** —— 对 agent 目录 12 个 .vue 跑「上一非空行以 `>` 结尾 + 本行只含 `>`」的判定，仅此一处命中（其余 `>` 都是合法多行标签的收尾）。
影响：纯观感 —— 用户看到输入框上方有个莫名其妙的符号，会以为界面坏了。不阻塞输入。
建议：删掉那个字符；补一条守卫（同一判定）防它再回来 —— 这类失效 lint / prettier 都不拦（它们把 `>` 当普通文本），只有渲染或肉眼才发现。
状态：已清（2026-10-10 完成）—— 见 `backlog-done.md` T-210。

## T-211 — 复刻 pie 观感第三步：加语义文字色阶 fg-1/2/3，消掉 dark: 双写

登记日期：2026-10-10
来源：2026-10-10 会话「继续」—— 承接 T-208/T-209，做评估稿里「观感三件套」的最后一件（语义文字色阶）。
现象：面板里的文字色全靠 `text-gray-500 dark:text-gray-400` 这种**双写**表达 —— 同一件事两处声明。实测 agent 目录里「次要文字」双写 14 处、「弱文字」双写 19 处；另有若干**单边** `text-gray-400`（8 处，缺 dark 对应值 —— 暗色下这些图标/占位就是错的）。参考实现 pie 用三档语义 fg（`--c-fg-1/2/3`）一次表达，跨主题稳定。
证据：**源码统计** —— `grep -ro "text-gray-[0-9]*"` 命中 41×gray-400 / 37×gray-500 / 9×gray-600…；双写组合单独统计见上。参考值见 `pie-ai-agent/src/sidepanel/index.css:55-108`（fg-1 #14181D / fg-2 #5A6470 / fg-3 #98A1AC；暗 #E5E8EC / #8A929E / #525965）。
影响：① 维护上「同一件事两处声明」，漏改一处就在某个主题下看不清；② 单边 `text-gray-400` 在暗色下是错的（8 处）；③ 与已落地的 canvas/surface/field 三层**面**不配套 —— 面分了三层，字却还是「第几级灰」。
建议：加 `fg-1/2/3` 三档语义文字色（走 CSS 变量 + withOpacityValue，同 primary/accent），把 agent 目录的 `text-gray-400/500/600` + dark: 双写按档映射过去。**不动** gray 别名、不动有语义的颜色（红/绿/accent）。
状态：已清（2026-10-10 完成）—— 见 `backlog-done.md` T-211。

## T-212 — 修面板「观感三件套」之外的几处具体丑

登记日期：2026-10-10
来源：2026-10-10 用户实拍反馈「UI太丑了」（截图见会话记录 —— 浏览器侧栏态）。根因：T-208/209/210/211 解决了「token + 三层底色 + 语义文字色」这些**基底**问题，但具体组件里还有几处「基底有 token 不用、退而画边框/画胶囊」的旧形态 —— 观感的最后一公里。
现象（按截图逐条）：
1. **用户气泡** `bg-blue-500/15` —— 蓝色透明是「标签/通知」语义色（错误横幅、未配 Key、上下文将满），用户自己的提问用它就把"我说了什么"读成"系统提示"。换 `bg-accent/10`。
2. **工具状态徽标** `bg-green-500/15 text-green-700` + `rounded-chip` —— 三个「完成/失败/完成」并排像「表单错误列表」。徽标去底色 + 去边框，**只留字色 + 图标**（绿/红/琥珀/灰 fg-2）。语义改由字色 + 图标形状承担，色块是冗余通道。
3. **工具卡外壳** `border-line + bg-surface` —— 三个带边框的 surface 卡并排在 canvas 底上仍像「独立卡片」。改 `bg-field`（最暗一档）：「这一行和正文不一样」的信号靠底色差，不再画外框。底色差本身就是分层。
4. **composer 卡** `border-line + bg-surface` 套 `bg-field` 输入区 —— 两层矩形嵌套。composer 外框去掉：canvas→surface（composer）→field（输入）三层关系靠**底色差**看得出，不必再画实线。
5. **composer 底行「Enter 发送」提示** 与发送按钮同行 —— 视觉重量相当，用户分不清哪个是文案哪个可点。挪到 composer 顶上一行 `text-[10px] text-fg-3` 的提示，底行只剩「圆环 + 发送按钮」两个控件。
6. **侧栏面板根** `bg-canvas` 在浏览器 chrome 上面是「白卡浮在深壳上」像弹窗。新增 `bg-shell` token（亮 #F0F2F5 / 暗 #1F2125，**暗色与 chrome 几乎同色**），侧栏 `App.vue` 根容器铺 `bg-shell` 续上 chrome，面板根在 dark 宿主下走透明 —— 透出父级，**消除「白卡浮在深壳上」的弹窗感**。独立页 / 编辑器侧栏宿主无此父级，仍走 `bg-canvas`。
7. **宿主形态声明** —— 给 `useAgentHost` 加 `deps.shell: 'light' | 'dark'`，写到 `host.shell`；面板根根据 `host.shell` 决定透明 / `bg-canvas`。侧栏 App.vue 显式 `shell: 'dark'`。**不让面板自己读 prefers-color-scheme** —— 那是页面主题，与「宿主是不是侧栏」无关。
证据：T-211 之后所有 token 已就位（canvas/surface/field/line + fg-1/2/3），但截图暴露的几处都是「有 token 不用、退而画边框/画胶囊」的旧形态。设计稿 `docs/agent-pie-ui-clone-assessment.html` §5 画的是「三步做完的终态」观感，截图与终态的差距全部在这 7 项里。
影响：截图里的「island 感」是问题 6 单独造成的；「表单错误列表」感是问题 2 单独造成的；「白卡套白卡」感是问题 4 单独造成的 —— 这三项是用户感知最强的；其余是「观感」层面的细节。
建议：逐条迁移到 token 家族 + 加 T-212 守卫。**不动**结构（chip、header、输入区都没改布局）；**不动**T-208/209/210/211 已落地的部分。
状态：已清（2026-10-10 完成）—— 见 `backlog-done.md` T-212。守卫：① 面板根不能写死 bg-canvas（必须按 shell 切）；② composer 必须 `rounded-card bg-surface`（去 border）；③ composer 顶部必须有 `<p data-test="composer-hint">`；④ 工具徽标根不能带 rounded-chip（去框）；⑤ 用户气泡必须 bg-accent/10 不是 bg-blue-*；⑥ --color-shell 在 :root/.dark 各一次；⑦ useAgentHost 必须读 deps.shell，sidepanel 必须显式 shell: "dark"。

## T-203 — 配置好 API Key 之后，面板里再也找不到进设置的路

登记日期：2026-10-10
来源：2026-10-10 会话做「Automa AgentPanel vs pie-ai-agent SidePanel」UI 对比（`docs/agent-sidepanel-ui-compare.html`）；触发点 `src/components/newtab/workflow/agent/AgentPanel.vue:172`
现象：面板上唯一的设置入口是那条「未配置 API Key」红横幅，它挂在 `v-if="!configured"` 上。用户一旦填好 Key，横幅消失，面板里就再没有通往设置页的入口 —— 想换模型、改 baseUrl、看连接状态，得先离开助手回到主界面。
证据：**代码事实** —— `AgentPanel.vue:172-179` 的横幅 `v-if="!configured"`；全面板 grep `goToSettings` 只有这一处调用点（`AgentPanel.vue:610`）。参考实现 sidepanel 的设置入口常驻（会话抽屉右上角 `Settings` IconButton）。
影响：第一次配置完的用户最常做的第二件事就是「换个模型试试」，而这条路的入口恰好在他配置成功的那一刻消失。目前只能靠主界面绕回去，助手面板成了一个单向入口。
建议：在 header 常驻一个设置图标按钮（窄宿主 header 已有会话 chip + 新建两个控件，加第三个要重新算 320px 下的横向预算）。或者只在「已配置」时显示一个更轻的入口（避免和红横幅同时出现两个设置入口 —— 那就是 T-177 刚拆掉的那类重复入口）。
状态：已清（2026-10-10 随 T-207 一起解决）—— 见 `backlog-done.md` T-207：未配置态改为整页引导页，引导页自身就是设置入口且是该状态的唯一形态，「入口随配置成功而消失」的根因不复存在。

## T-204 — composer 顶部用渐隐替代硬分割线

登记日期：2026-10-10
来源：2026-10-10 会话 UI 对比；参考实现 `pie-ai-agent/src/sidepanel/components/Chat.tsx:2003`
现象：composer 是一条实边框卡片（T-166 合并成一框之后），消息滚到输入区边界时是被一条 1px 实线"切断"的，看不出下面还有内容继续溢出。
证据：本仓 `AgentPanel.vue:248-250`（`rounded-card border border-gray-200`）；参考实现在输入区上方放一条 `pointer-events-none absolute inset-x-0 -top-5 h-5 bg-gradient-to-t from-canvas to-transparent`。
影响：纯观感问题，不影响可用性。窄面板（320px）里消息被切线截断的观感比宽屏更明显。
建议：在 composer 上方加一条 20px 高的渐隐层（`from-canvas to-transparent`，`pointer-events-none`）。成本一个绝对定位 div，不参与布局。
状态：已清（2026-10-10）—— `AgentPanel.vue` composer 上加了 `data-test="composer-fade"` 渐隐层（`pointer-events-none absolute inset-x-0 -top-5 h-5 bg-gradient-to-t from-gray-50 to-transparent dark:from-gray-900`），form 改 `relative` 承载它。守卫钉在 `panelUi.test.js`（`composer-fade` 存在 + form 仍 `px-4`）。

## T-205 — 用户长文本超过一屏时自动折叠

登记日期：2026-10-10
来源：2026-10-10 会话 UI 对比；参考实现 `pie-ai-agent/src/sidepanel/components/CollapsibleText.tsx`（`COLLAPSED_MAX_PX = 240`）
现象：用户气泡不折叠。侧栏 360px 宽时，一条长的用户提问（贴一段日志、贴一整段页面文本）能把一屏占满，助手的回答要滚很久才看得到。
证据：本仓 `AgentTranscript.vue:24` 的用户气泡只有 `[overflow-wrap:anywhere]`（防长串撑破已做），没有高度上限。参考实现超过 240px 折叠 + 底部渐隐 + 展开/收起。
影响：助手场景下「贴一大段东西进来问」是高频用法（贴报错、贴 HTML、贴表格），长输入把对话区挤掉比短输入更常见。
建议：超过阈值（240px 或按视口比例）折叠，底部渐隐 + 「展开/收起」。判定放纯模块（可单测），组件只消费 —— 沿用本仓 `usage.js` 那套做法。
状态：已清（2026-10-10）—— 见 `backlog-done.md` T-205：判定抽成纯模块 `src/agent/foldText.js`（`foldDecision` + `USER_FOLD_MAX_PX=240`，5 条单测），用户气泡抽成 `AgentUserBubble.vue`（量 `scrollHeight` + 渐隐 + 开关）。**未做**建议里的「补『重试』」一项 —— 见 T-206 的说明（与错误卡重试语义不同，未一并做）。

## T-206 — 消息级操作只有「复制全文」一个按钮，且它压在首行上

登记日期：2026-10-10
来源：2026-10-10 会话 UI 对比；触发点 `src/components/newtab/workflow/agent/AgentMarkdown.vue:13-23`
现象：助手消息上唯一的操作是悬停才显形的「复制全文」，绝对定位在右上角、压在首行文字上（T-16 的设计）。没有重试 / 删除 / 逐条操作条。
证据：代码位置如上；参考实现有「复制整条（富文本）+ 报告问题」，且 hover 时用 `peer-hover:bg-accent-tint` **高亮将被复制的范围** —— 我们现在只给按钮加底色，用户不知道自己会复制到哪一段。
影响：用户分不清「复制全文」复制的是哪一条（长对话里多条消息各自带一个同款按钮）。
建议：① 复制时高亮作用范围（成本极低，一条 `peer-hover` 类）；② 视情况补「重试」—— 但注意它与错误卡上的「重试」（`AgentTranscript.vue:128-136`）语义不同，别做成两个入口。
状态：已清（2026-10-10）—— 见 `backlog-done.md` T-206：只做了建议①（复制按钮加 `peer` + 正文容器 `peer-hover:bg-accent/5` / `peer-focus:bg-accent/5`）。**建议②未做**：错误卡的「重试」是「这一轮失败了，重发」；消息级重试是「这一条我不满意，重来」，两者的前置条件与后果不同，且后者要处理「从哪一条重试、后续历史怎么办」，属数据模型改动 —— 若要做请单独立项，不在本条顺手实现。

## T-186 — `riMagicLine` 是全项目「AI 助手」的品牌图标，唯一语义不搭的是画布自动布局

登记日期：2026-10-09
来源：2026-10-09 会话实施 T-182 时**产物级核验 `riMagicLine` 计数**才浮出来；触发点 `src/newtab/pages/workflows/[id].vue:280`
现象：T-182 登记时把「魔法棒撞图标」描述成「助手入口 vs 画布自动布局」两处事件。实施后 grep 全仓才发现，`riMagicLine` 在**四个地方**出现，其中三个都是「AI 助手」入口：设置页「AI 助手」导航项（`Settings.vue:52`）、工作流列表页的助手入口项（`Workflows.vue:60`，`t('workflow.agent.tab')`）、以及本轮刚改掉的侧栏 tab。真正语义不搭的是**第四处** —— 画布左下角的自动布局按钮，它跟 AI 没有半点关系，只是借了助手的面包屑。
证据：**产物级实测** —— 对 `build/newtab.bundle.js` 计 `riMagicLine` 得 4 命中；回源码逐个定位为 `vRemixicon.js:106/205`（注册表 import + 注册项，两条被 terser 合并计一条命中之外的部分）、`[id].vue:280`（自动布局）、`Settings.vue:52`、`Workflows.vue:60`，全仓再无第五处（`src/` 下 `*.vue`/`*.js` 全文 grep 已跑）。
影响：不是功能缺陷，是**图标语义一致性**。用户学到的「魔法棒 = AI」这条约定，会被画布上一个纯排版按钮持续违反；反过来，本轮把助手侧换成 `riChat3Line` 之后，「魔法棒 = AI」在助手入口这条链路上反而断了一处（设置页与列表页仍是魔法棒）。两种读法指向相反的修法，**必须由用户裁决，不能由我顺手定**。
建议（两条互斥，代价都很小）：
  1. **认魔法棒为 AI 品牌**，则改 `[id].vue:280` 自动布局 → 对齐类图标（`riAlignLeft` 一类）。侧栏 tab 也换回 `riMagicLine`。代价：改两处。
  2. **认侧栏 tab 的语义优先**（当前实现）：`块 | 助手` 并排时，对话框比魔法棒更准；则把 `Settings.vue:52` 与 `Workflows.vue:60` 一并换成 `riChat3Line`，让「助手」在三个入口统一。代价：同样两处，但风险更低（都是 AI 入口，换成对话气泡不会误导任何人）。
注：本条**不阻塞** T-182 的结论 —— 本轮已按建议 2 的局部形态（只改侧栏 tab）落地并通过守卫。若用户选 1，需同步改守卫 `panelUi.test.js:1901` 的断言方向（当前钉的是「`[id].vue` 里 `riMagicLine` 只剩 1 处」）。
状态：待审核

## T-185 — 侧栏卡头的工作流名称与描述，是顶栏重命名弹窗的重复第二份

登记日期：2026-10-09
来源：2026-10-09 会话评审 agent 助手入口 UI；读 `src/components/newtab/workflow/WorkflowDetailsCard.vue:1-50` 与 `src/components/newtab/workflow/editor/EditorLocalActions.vue:695-706`
现象：侧栏块库面板顶上那行「图标 + 名称 + 描述」里，名称与描述**可以就地编辑**，而顶栏「更多 → 重命名」弹窗（`moreActions` 的 `rename` 项，`riPencilLine`）也能改同样两个字段 —— 同一件事两处入口，且顶栏那处在任何工作流下都在、侧栏那处要先展开侧栏。
证据：代码位置如上。`renameWorkflow()` 写 `{name, description}`；`WorkflowDetailsCard` 的 `descriptionCollapsed` 点击展开与名称输入走 `updateWorkflow({...})`。**未实测**两处是否会互相覆盖或产生竞态。
影响：用户可能在一处改了、另一处看到旧值；更重要的是它让「块库面板」这个叫法别扭 —— 主体是块库，顶上却挂着重复的工作流信息（这是「详情卡」这个名字名不副实的根源）。
影响面补充：**图标不能跟着一起删**。全仓只有侧栏这一处能改工作流图标，`renameWorkflow` 只写 name/description，没有 icon 字段（已核实 `EditorLocalActions.vue` 全文无 icon 输入）。
建议：若要收，去掉卡头的名称与描述两行，保留图标那一格；或者反过来把图标选择器并进顶栏重命名弹窗，然后整个卡头删掉 —— 后者还能给侧栏多让出约 44px 高度。**两者都不是必须的**，纯收益项，用户不碰这两处也不会怎样。
状态：待审核

## T-155 — 下拉缺 a11y 语义与键盘导航

登记日期：2026-10-07
来源：2026-10-07 会话；读 `AgentDropdown.vue:1-21`
现象：下拉面板无 `role="menu"`，trigger 无 `aria-expanded` / `aria-haspopup`；打开后会话列表与 tab 列表不支持 ↑↓ 移动选择（对比 `AgentPanel.vue` 的 slash 菜单已实现 ↑↓/回车/Esc）。
证据：读代码实测（`AgentDropdown.vue` 模板无 aria 属性，script 只有 click-outside 与 Esc 关闭）。
影响：屏幕阅读器用户无从获知「这是个可展开菜单、当前开没开」（项目已有 T-13 的 a11y 投入，此处是缺口）；纯键盘用户在下拉里只能靠 Tab 逐项走。
建议：trigger 加 `aria-expanded`、面板加 `role="menu"`（菜单项 `role="menuitem"`）；列表补 ↑↓ 导航 + 回车选中 + Esc 关闭（复用 slash 菜单已有的路由逻辑）。
状态：待审核

### 新功能（要讨论场景，审得慢）

## T-201 — 面板内没有模型 / 服务商选择器

登记日期：2026-10-10
来源：2026-10-10 会话 UI 对比；触发点 `src/components/newtab/workflow/agent/AgentSessionList.vue:109-116`
现象：面板里能看到的模型信息只有会话列表底部那一行 `config.model` 字符串，**不可点、不可切换**。要换模型必须离开助手去设置页（`src/newtab/pages/settings/SettingsAgent.vue`）。
证据：**代码事实** —— `AgentSessionList.vue:109-116` 显示 `data-test="model-name"` 的纯文本；`AgentPanel.vue` 全面板无模型选择控件。参考实现 sidepanel 有常驻 `ModelPicker`（显示 `Provider · model`，流式时锁定并禁用）。
影响：换模型是「这一轮答得不好，换个模型再试」的常规动作。现在这个动作要跳出助手、在设置页翻到对应连接、改完再回来，且**改完当前会话仍会沿用旧模型直到新建会话**（这个行为面板上完全没说）。
建议：在 composer 底行加一个紧凑的模型选择器（底行现在只有「上下文圆环 + 快捷键提示 + 发送」，320px 下横向预算紧张 —— 可能需要先把快捷键提示那句收掉或缩短）。**要讨论的点**：是否需要「下次发送生效」的提示文案，以及多连接下选择器的组织方式（按 provider 分组还是平铺）。
注：**已随 T-213 落地（2026-10-10）** —— 选择器放在 composer 底行左侧（`flex-1` 撑开前），芯片只剩等宽模型名 + 箭头（不用服务商图标），弹层底部固定小字「换模型后从下一轮开始生效，当前会话不重放」，按连接分组、无 Key 的连接标注。实现见 `src/components/newtab/workflow/agent/AgentModelPicker.vue`（新增）与 `.scratch/t213-impl.png` 的存证。**本票剩余待决项只剩「多连接下弹层怎么组织」的细化**（当前是按连接分组 + 组标题，未做折叠/搜索）。
状态：部分落地（选择器已可用；多连接组织方式仍待观察用户反馈）

## T-202 — 没有「编辑这条消息并回溯重发」

登记日期：2026-10-10
来源：2026-10-10 会话 UI 对比；参考实现 `pie-ai-agent/src/sidepanel` 的 `chat.rewind.*` 与 `useSession/rewind.ts`
现象：想改一句已经发出的话，只能清空重开一轮。错误卡上有「重试」（`AgentTranscript.vue:128-136`），但它重发的是**出错那一轮之前最近的那条用户消息**，不是用户指定的任意一条，也不能改内容。
证据：代码位置如上；全面板无「编辑用户消息」入口。参考实现：点用户气泡的铅笔 → 原地 textarea → Cmd+Enter → 截断该条之后全部历史并重发，文案明确写着「Editing resends this message and discards everything after it.」。
影响：改一句 prompt 重跑是很常见的诉求（尤其调 selector、调抓取规则时）。现在的替代方案是复制原文、新建会话、粘贴、再发 —— 会话历史被切成两截。
建议：先想清楚**语义**再动手：回溯意味着丢弃该条之后的所有内容（含工具调用与画布改动），这个破坏性要有明确确认。且它与红线「agent 永不保存工作流」的关系要理清（画布改动是内存的，回溯要不要一起回滚？）。**这是产品决策，不是 UI 改动**，建议单独立项讨论。
状态：待审核

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

已解决条目全部在 **`docs/backlog-done.md`**（计数以该文件实物为准，并行会话同日多轮追加）：2026-10-05 拆出 44 条（T-02、T-05、T-06、T-17~T-25、T-26~T-34、T-35~T-43、T-44、T-45、T-47、T-48、B1、B5）；之后各轮：T-61、T-62 与面板 UI 系列（并行会话），T-70、T-71（架构评审 C1），T-82（C3），T-83（C2），T-89 及随其修复的 T-69（C4），T-75、T-76（pi 功能面调研轮：步数上限决策与上下文压缩，2026-10-06），T-91（`list_canvas` 静默截断 200 字符，2026-10-06），T-97~T-103（设置页多 provider 改造轮：密钥明文镜像、独立菜单、多连接、配置测试、图标名、新建连接入口、说明段落，2026-10-06），T-104（归档被截断后的恢复，2026-10-06），T-105（`backlog.md` 与归档失同步，2026-10-06；同批把待审核区的「T-90」改号为 T-107），T-04（报错渲染，并行会话完成）、T-46、T-54、T-56（已消解/已修复）与 T-77~T-80（驳回）——最后一批为 2026-10-06 待审核区按类型分区重构时清出的已裁决条目。2026-10-07 收尾轮补充：B2、B3、B7、B4（B4 交付 `.agent-test/eval/` 任务集，含 T-140 —— 5 个 live 脚本失效随 B4 一并处置）、B9（pi-agent-core 迁移决策记录归档，ADR 0004 / migration spec / tickets / architecture.html 的引用已改指本文件）、T-126、T-137、T-138、T-139、B6（agent:run-js 惰性 CSP 降级，2026-10-07）。2026-10-07 T-81b review 修复轮：T-141~T-149 共 9 条（备份保真、merge 保 enabled/id、技能索引 untrusted 包裹、zip 导入边界、frontmatter 往返、导入上限、导出路径冲突、下载 revoke 时机、索引警告拆分）。

要看「某个坑当初是怎么被实测出来的」，去那个文件；要看「现在该做什么」，留在本文件。

