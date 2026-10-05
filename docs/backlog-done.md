# 已清登记（backlog 历史）

从 `docs/backlog.md` 拆出（2026-10-05）。这里是**已解决条目**的完整档案：现象、实测证据、影响、最终结论。

**这些条目不是待办** —— 想找现在该做什么，去 `docs/backlog.md`（待审核 / 已批准 / B 编号待办三区）。
本文件的价值是**追溯**：某个设计当初为什么这么定、某个坑当初是怎么被实测出来的。

条目格式与 `docs/backlog.md` 的模板一致，但每条以 `结论：` 收尾（落地方式 + 验收数字）。

**这里的内容是快照，不是现行代码。** 条目里的行号、函数名、实测数字都是**当时**的；
今天想知道代码长什么样，去 `src/` 与 `docs/agent-architecture.html`。
本档案回答的是「这个坑当初是怎么被发现的、为什么这么修」。

---


### T-17 — `detail='full'` 跳过重复项检测，有列表的页面也会被告知「未发现列表」

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04「read_page 工具设计研究」，触发点 `src/content/blocksHandler/handlerAgentReadPage.js:437`
现象：`detectRepeated` 的调用条件是 `detail==='auto'||'interactive'||'summary'`，不含 `'full'`；于是 `repeated` 恒为 `[]`，随后 `:464-469` 的 else 分支无条件输出「未发现 3 个以上结构相同的兄弟元素。这页可能不是列表页，或是虚拟列表。」——`detail='full'` 是信息量最高的档，却在**任何**页面上都断言「这页没有列表」，包括明确有 4 项卡片列表的页面。
证据：**实测** — `node .agent-test/full-detail-probe.mjs`（真 Chromium）：`detail=full → ## 重复项检测 | 未发现 3 个以上结构相同的兄弟元素…`；同一页面 `detail=summary` 正确输出 `容器 div.grid / 单项 div.card:nth-of-type(1) × 4 / 字段 title / a / price / 样例 title="鼠标"…`。
影响：模型主动要最详细信息时得到的是**假阴性断言**而非「缺这一段」—— 它可能据此放弃列表路线、改去解析 HTML 或凭空编 selector；与 `docs/agent-readpage-design.md` §1 的「列表模式是 read_page 最有价值的一段」直接冲突。
建议：把 `'full'` 纳入检测条件（一行），并把 else 分支措辞改成中性（「本档未做重复项检测」而不是「未发现」）。补 `dom.test.mjs` 回归：full 档在列表页必须给出列表段。
结论：四档白名单落地后 `full` 与其余档一样走 `detectRepeated`，DOM 断言 F1 钉住「full 档在列表页必须给出列表段」；`npm run test:dom` 26 pass。
状态：已清（2026-10-04 完成）

### T-18 — 未知 `detail` 值静默降级成「只给正文」，且同样谎报「未发现列表」

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04「read_page 工具设计研究」，触发点 `handlerAgentReadPage.js:388`（`opts.detail || 'auto'`，无白名单）
现象：content 侧不校验 `detail` 取值。传入枚举外的值（例如模型幻觉出的 `detail:'overview'`），`repeated`/`interactive`/`tables` 的条件全不成立，只剩 `:419` 的 `detail !== 'interactive'` 输出正文 —— 结果是 145 字符的观察值：一段正文 + 一句「未发现 3 个以上结构相同的兄弟元素」（页面其实有列表），没有任何「参数不被识别」的提示。
证据：**实测** — `node .agent-test/full-detail-probe.mjs`：`detail=bogus 字符=145，重复项段: ## 重复项检测 | 未发现 3 个以上结构相同的兄弟元素，交互索引:无，正文:有`。
影响：模型拿到一份「看起来成功、其实几乎什么都没有、且含错误断言」的观察值 → 大概率重试同一参数或基于空信息编造 selector。JSON schema 的 enum 挡不住模型实参（LLM 不保证遵守枚举），`loop` 与 `tools/page.js` 也都不做参数校验，content 侧是最后一道。违反 AGENTS.md「不静默降级」。
建议：content 侧白名单，未知值回一句明确错误（「detail 取值 X 不被识别，可用值：…」）让模型自纠；`tools/page.js execute` 同步做一次纯函数校验（可单测）。
结论：未知 `detail` 现在两处都明确报错（`tools/page.js normalizeReadPageArgs` 纯函数白名单 + handler 白名单），旧值只在前者映射，单测覆盖「未知值报错」。
状态：已清（2026-10-04 完成）

### T-19 — `detail='full'` 结构上装不进 8000 字符观察值上限，被砍的正是它承诺的 HTML 段

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04「read_page 工具设计研究」，触发点 `handlerAgentReadPage.js:420-428`（正文 3000）+ `:561-564`（HTML 6000）+ `src/agent/events.js:79`（8000 硬截）
现象：full 档固定输出可见正文 3000 字 + 完整 HTML 6000 字 = 9000 字，还没算页头/重复项/索引/表格，就已超过 `MAX_OBSERVATION_CHARS=8000`；`truncateObservation` 从头保留砍尾部，而 HTML 段恰好排在最后。段顺序还把「可再生的正文」放在最安全的头部、「不可再生的地址」排在后面。
证据：**实测** — `node --import ./utils/test-loader.mjs .agent-test/budget-probe.mjs`：handler 输出 9430 字符 → 截断后 8028，`truncated=true`，`## 完整 HTML` 段只剩 4621/6000 字（砍在半截）。
影响：用户显式要求 full 却拿不到承诺的 HTML；观察值尾部带 `[truncated…]` 注记，模型对「半截 HTML」的解读不确定，可能以为页面就长那样；任何档位超预算时优先丢的都是地址。
建议：见 `docs/agent-readpage-design.md` §3/§4 —— 分段预算（handler 自身 ≤6000）+ 段顺序改为「不可再生的地址在前、可再生的正文/HTML 在后」+ 超预算处显式标注省略。
结论：分段预算落地（handler 默认 6000、地址在前正文/HTML 在后），真页面 `full` 4311 字符且 `## 完整 HTML（截断）` 真的出现（`books-trace.mjs` 实测），不再从尾部被硬截。
状态：已清（2026-10-04 完成）

### T-20 — auto 档超预算砍掉交互索引、正文一字不砍（trace P5 复现）

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04「read_page 工具设计研究」复现；原始记录见 `docs/agent-readpage-design.md` §9-F4，触发点 `handlerAgentReadPage.js:489-493`
现象：`detail==='auto' && idx > maxChars` 时整块删除交互元素索引、只留一行降级提示，占大头的可见正文一个字不削。退化后的输出除重复项检测外没有任何可用 selector —— 而索引正是唯一能直接产出 selector 的那段。
证据：**实测（本轮复现）** — `node --import ./utils/test-loader.mjs .agent-test/budget-probe.mjs`：`maxChars=8000/4000 → 3505 字符，索引段有`；`maxChars=3000/2000 → 3274 字符，索引段无、降级提示有、正文仍完整（只少 231 字）`。
影响：预算一紧，模型拿到「报成功但给不出 selector」的观察值，只能重读或猜。同一问题也是 trace §5.1 R6 要修的点。
建议：按 `docs/agent-readpage-design.md` §4 砍序改（正文/明细先砍、列表模式与单条样例永不砍、砍处显式标注）；同时打通 `maxChars`（T-23），否则阈值永远是默认 8000。
结论：§4 六档砍序实现：正文/HTML → 交互索引明细 → 表格样例/接口清单，列表段与单条样例永不砍，每处砍都带 `[note: …]`；`maxChars=1200` 时列表样例仍在（DOM 断言）。
状态：已清（2026-10-04 完成）

### T-21 — 工具返回的 `{status,payload}` 信封被整体 JSON 化进观察值，内层 error 走不到错误渲染

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04「read_page 工具设计研究」（评估结构化返回契约时发现），触发点 `src/agent/loop.js:81-97` + `src/agent/events.js:71-77`
现象：`query_elements` / `test_js` / `highlight_selector` / `list_tabs` / `open_url` / canvas 系工具一律返回 `{status, payload}` 对象，而 `resultEvent` 把整个对象当作 payload 交给 `wrapObservation`，于是模型收到 `{"status":"ok","payload":"命中 3 个…"}` 的 JSON 包裹；当工具内层返回 `status:'error'` 时 loop 侧状态仍是 OK，`events.js:69` 的错误渲染分支不触发，失败信息以 JSON 形式混在「成功」观察值里，UI 工具卡也照 loop 状态渲染成绿色成功。
证据：**实测** — `node --import ./utils/test-loader.mjs .agent-test/observation-shape-probe.mjs`：字符串返回 63 字符，对象返回 100 字符（+59%，含 2 空格缩进）；内层 error 打印为 `{"status": "error", "payload": "选择器不合法：bad ["}`。
影响：① 每次工具结果多付 JSON 结构与转义的 token（长 payload 更明显）；② 模型要解析 JSON 才能发现失败，与「错误即观察值」的设计意图不符；③ 用户看到绿色成功徽标、实际工具报错；④ 任何依赖结构化返回的新能力（read_page 指纹字段，`docs/agent-readpage-design.md` §6.3）都会踩同一个坑。
建议：`loop.js resultEvent` 统一解包：`{status,payload}` → payload 作观察值正文、status 上提为事件状态（error 走 failEvent 同款渲染）。现有测试只断言 `includes`，测不出包裹，需补一条反向断言。
结论：`loop.js normalizeToolOutcome` 解 `{payload,status,...meta}`：payload 当正文、内层 `status:"error"` 升级为事件 error、meta 上提不进文本；`loop.test.js` 三段断言，`npm test` 273 pass。
状态：已清（2026-10-04 完成）

### T-22 — `detail` 各档不是单调阶梯，`interactive` 比 `summary` 少了正文，与工具注释口径矛盾

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04「read_page 工具设计研究」，触发点 `handlerAgentReadPage.js:419` vs `src/agent/tools/page.js:20-23`
现象：注释写 `summary = 正文 + 重复项检测`、`interactive = 再加交互元素索引与接口列表`、`full = 再加表格与完整 HTML`，即应当逐档累加；实现却是 `if (detail !== 'interactive')` —— interactive 档不输出正文，`auto` 又比 `interactive` 多一段正文。档位之间既不单调也和文档对不上。
证据：**实测** — `node .agent-test/full-detail-probe.mjs`：`detail=summary 正文:有`、`detail=interactive 正文:无`、`detail=auto 正文:有`（同一页面）。`dom.test.mjs` 没有覆盖这一取舍。
影响：模型按「档位越高信息越多」选 interactive，发现正文消失，可能误判页面没有正文而重读一次（多花一份完整快照，正是讨论文档 Q1 的第三个成因）；也让 prompt 里讲不清「默认档该选哪个」。
建议：并入 detail 口径改造（`docs/agent-readpage-design.md` §2 的 `probe|addresses|content|full` 单调阶梯 + 白名单），或最小化把 `:419` 改成恒输出正文并接受成本上升。二选一，别停在现状。
结论：detail 改为单调四档 `probe/addresses/content/full`（旧值映射只存在于 `normalizeReadPageArgs` 一处），工具注释与实现同一口径，`dom.test.mjs` 档位断言全部改齐。
状态：已清（2026-10-04 完成）

### T-23 — `maxChars`/`budgetNodes` 在读页链路上不可达，runtime 无法按余量压预算

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04「read_page 工具设计研究」，触发点 `src/agent/index.js:184`（`readPage: (detail) => …`）、`:121-128`（消息体只有 `{type, detail}`）、`src/content/index.js:323-325`（只取 `data.detail`）
现象：handler 接受 `detail/maxChars/budgetNodes` 三个入参（`handlerAgentReadPage.js:386-390`），但整条链路只透传 `detail`，另两个永远取默认值；handler 里按预算降级的分支在生产中只能按固定 8000 字触发。
证据：**代码位置（三处签名逐一核对，静态确认）**；反向实测：直接调 `window.__agentReadPage({detail:'auto', maxChars:3000})` 能触发降级（`budget-probe.mjs`）—— handler 认参数，是链路不给。
影响：`docs/agent-readpage-design.md` §4 的分段预算落不了地；降级阈值无法按页面大小或上下文余量调整；也解释了为什么 T-20 的复现必须绕过生产链路直接调 handler。
建议：`readPageFromTab(tab, {detail, maxChars})` + content 分发透传 + `toolCtx.readPage` 收对象（三处，约 10 行），同步 `tools/index.test.js:101-115` 的透传断言。
结论：`maxChars`/`budgetNodes` 全链路透传（`readPageFromTab` → content 分发 → handler），schema 校验 400–8000、默认 6000；`tools/index.test.js` 透传断言同步。
状态：已清（2026-10-04 完成）

### T-24 — `elideStaleObservations` 写了测了没接线，12 步单轮照样堆 12 份快照

类型：bug
登记日期：2026-10-04
来源：2026-10-04 上下文工程讨论会话的「根因三」与汇总表 P0a（当时只写进讨论文档、未进本登记表；该讨论文档已删除，git `a27f93de`）
现象：`window.js:101` 的陈旧页面快照剔除，全仓只有定义和 `window.test.js:81/104` 两个测试，生产链路 `loop.js:321` 的 `applyTokenBudget(buildWireMessages(...))` 与 `wire.js` 都没调用它 —— 技术方案 §4.2 写的是「在 buildWire 时做」，实现漏了。
证据：沿用前次**实测**（讨论文档，未在本轮复跑）：接上后 12 步单轮 124,769 → 12,145 token（省 90%）；本轮 `grep elideStaleObservations src/agent` 复核调用点：仅 `window.js:101` 定义 + `window.test.js` 两处，无生产调用。
影响：单轮超过 3 步即越过 25,600 阈值（讨论文档 Q1 表格），`applyTokenBudget` 又因 T-25 的缺口一条不丢，超标请求直接发给 provider → 400。当前上下文爆炸的头号成因。
建议：`loop.js:321` 改成 `applyTokenBudget(elideStaleObservations(buildWireMessages(history, {system})), {contextWindow})`（一行）+ 补一条 loop 级断言：历史里旧的 `<untrusted_page_content>` 观察值必须被换成 `STALE_MARKER`、只保留最后一组。
结论：`loop.js` 在 `buildWireMessages` 后接 `elideStaleObservations`，接线测试断言旧 `<untrusted_page_content>` 观察值被换成占位、只留最后一组；`npm test` 273 pass。
状态：已清（2026-10-04 完成）

### T-25 — `dropOldestTurn` 在单轮多步里结构性失效，`window.test.js:156` 的断言恰好掩盖了它

类型：bug
登记日期：2026-10-04
来源：2026-10-04 上下文工程讨论会话的「根因四」（P0b；该讨论文档已删除，git `a27f93de`），触发点 `src/agent/window.js:161-184`、`src/agent/window.test.js:156-161`
现象：`applyTokenBudget` 的丢弃单元是 `(user, assistant, 其后连续的 tool*)` 整组，且硬保最后一个 user。单轮 send 的 wire 全轮只有 index=1 一个 user，循环第一个候选 `i >= lastUserIdx` 直接 break → 返回 null → `dropped=0`。一轮 12 步攒的 12 份页面快照在同一个「轮」里，**没有任何可丢的单元**。`window.test.js:156` 的用例（`[sys, user(500k), asst]` → `assert.equal(r.dropped, 0)`）把 `dropped===0` 写成预期 —— 对它自己的 fixture 是对的，但没有任何用例覆盖「单轮内多个 tool 观察值超预算」，缺口因此测不出来。
证据：**代码位置（逐行核对）**；fixture 自洽性本轮确认：`[sys, user, asst]` 的 `lastUserIdx=1`，`i=1` 即 `i >= lastUserIdx` → break。12 步 124,769 token 的实测见讨论文档 Q1（沿用，未复跑）。
影响：与 T-24 叠加时两层防线全破 —— 陈旧快照不剔、整轮又丢不掉，超额 4.8 倍的请求直接打到 provider 报 400；用户看到的是「助手报错」，实际是预算层无路可走。
建议：给 `dropOldestTurn` 补单轮内降级路径（不越过最后一个 user 的前提下，从最旧的 assistant+tool* 组开始丢，或对 tool 观察值做占位替换）；**新增**一条单轮多 tool 的用例 —— 别改 `:156` 那条，它自己的语义是对的，要在它旁边补覆盖不到的那半。
结论：`window.js` 补单轮内两级丢弃（`lastUserIndex` / `dropOldestStepInLastTurn`）+ 2 条新用例，`dropped===0` 的旧断言不再掩盖单轮多步缺口。
状态：已清（2026-10-04 完成）

### T-05 — 删除会话一键即删，没有二次确认

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `src/components/newtab/workflow/agent/AgentPanel.vue:64-72`
现象：面板上的垃圾桶按钮直接 `emit('delete-session')`，宿主立即 `runtime.deleteSession(id)` → `sessionStore.remove(id)`，整段事件历史被删除且不可撤销。按钮与「新建会话」相邻、图标相似，误触成本极高；busy 之外没有任何拦截，也没有删除对象的标题回显。
证据：**代码位置，推断，未实测** —— `AgentPanel.vue:64-72`（无确认直接 emit）、`agentHost.js:113-121`、`src/agent/index.js:565-569`（`sessionStore.remove` 无前置确认）；全仓未见该路径上的 `UiDialog` 调用。
影响：任何一次误点都永久丢失该会话的全部对话与工具执行记录（会话是唯一的历史载体，CONTEXT.md「会话」条），最坏是用户辛苦跑出来的 selector 结论再也找不回来。
建议：复用项目既有 `UiDialog` 二次确认（标题回显会话 title + 「不可撤销」），并把删除按钮从「新建」旁边移进会话下拉/更多菜单，降低误触概率。
结论：删除前过 `UiDialog` 二次确认（`agentHost.js deleteAgentSession`）：标题「删除这个会话？」、正文回显会话 title + 「删除后无法恢复」、`okVariant: 'danger'`、`async: true`；确认回调里**再核一次** `agent.busy` 与 id 是否仍是当前会话（弹窗期间可能又开跑一轮，删在途会话会被那轮 save 回写成幽灵会话），不满足则返回 false 让弹窗留着。文案 `workflow.agent.session.deleteConfirm*` 已补 en/zh，`npm run check:i18n` 通过。原建议中「把删除按钮移进下拉/更多菜单」**未采纳**：与「新建」并排放着可发现性更好，确认门已把误触代价降下来，等实际用过再评估。
状态：已清（2026-10-04 完成）

> **2026-10-05 推翻（附实测依据）**：实际用下来用户明确指出「更多」溢出菜单过于复杂、删除应直接放进会话下拉。上面那条「保持与新建并排」的结论作废 —— 它成立的前提是「删除按钮紧邻新建、点一次就删」，而实际形态是两点需要开菜单才够得着。现状：T-85 已把删除收进会话下拉列表底部（仍走同一道 `UiDialog` 二次确认），header 只剩「会话 chip + 新建」两个控件。

### T-26 — 会话切换下拉取 `$event.target.value` 抛 TypeError，选了毫无反应

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04「完善会话切换与删除入口」，触发点 `src/components/newtab/workflow/agent/AgentPanel.vue:35`
现象：会话下拉的 change 处理写的是 `emit('select-session', $event.target.value)`，而 `UiSelect` 的 `change` emit 出去的是**字符串 value**（`UiSelect.vue:76-84`），不是原生 DOM 事件 —— `$event.target` 为 `undefined`，再读 `.value` 直接抛 TypeError，选了历史会话毫无反应。全仓 92 处 `<ui-select>` 用法里只有这一处这么写，其余全走 `v-model`。用户侧的表现就是「只有新建，没有切换」：建了第二个会话就再也回不去第一个。
证据：**实测（源码 + 构建产物，未在真机页面手工复现 —— 本仓没有组件测试基建）** —— `UiSelect.vue:76-84`（`emit('change', value)`）与 `AgentPanel.vue:35` 对不上；修复后重新 `npm run build`，`build/newtab.bundle.js` 里 `$event.target` **0 命中**，编译产物为 `function u(e){e&&o("select-session",e)}`（直接收 value、空值忽略）。
影响：多会话的核心入口之一失效。两个宿主（独立助手页、编辑器侧栏）同样中招；配合 T-05（当时删除还没有确认），用户的实际处境是只能新建、切不回去、删又不敢删。
建议：（已修）改 `@change="onSelectSession"`，处理器直接收字符串 value 并忽略空串占位项。
结论：修复落地，并把入口一并补齐 —— 选项文案从 `title || id`（标题未生成时是一串 UUID）改为「标题 · MM-DD HH:mm」+ 当前项标「（当前）」，拼装逻辑抽成 `sessions.js:sessionOptionLabel` 由 `sessions.test.js` 两条用例钉住（缺时间不出半截分隔符、非法时间戳当没时间）；切换侧新增 `assembly.test.js` 5 条 runtime 契约用例（切会话读回各自历史、切不存在的会话不炸、删当前/删非当前的边界、`newSession` 后还能切回）。`npm test` 280 pass / 0 fail（原 273），`npm run check:i18n` 通过，`npm run lint` 仍为存量 2 error / 10 warning，`npm run build` 成功。
状态：已清（2026-10-04 完成）

### T-06 — 确认卡浮层压住输入区，内容低于 tech-design §8.2 的承诺

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 助手 UI/UX 审阅，触发点 `src/newtab/pages/Agent.vue:21-26`、`docs/agent-assist-tech-design.md` §8.2
现象：① 确认卡以 `absolute inset-x-3 bottom-3` 浮在面板底部，正好盖住输入框与发送按钮 —— 等确认期间用户无法补一句上下文，也看不到自己刚发了什么；卡片不阻断滚动，往回翻历史时它一直悬着。② 卡内只有标题 + 一句通用 hint + 裸 `<pre>code</pre>`，而 §8.2 承诺的是：标题含目标页 title、正文给代码行数、明示「严格 CSP 页面走 chrome.debugger 降级，浏览器会显示调试横幅」、按钮为 `[取消] [执行]`。
证据：**代码位置，与方案对照，未实测** —— `Agent.vue:21-26` / `workflows/[id].vue:48-53`（浮层定位）、`AgentConfirmCard.vue:1-40`（无目标页/行数/CSP 文案）、tech-design §8.2 表格 `:640`。会话授权复选框属 **B5**，本条不重复登记。
影响：用户在信息不足的情况下裁决「是否在别人页面上执行代码」，正是 T2「知情执行」要防的场景；浮层遮挡则让确认期间的对话上下文不可见。
建议：卡片改为插入事件流内（工具卡下方，§9.1 骨架图就是这么画的）+ 顶部吸附条保底，正文补目标页 title、代码行数、CSP/debugger 提示；`[取消] [执行]` 对齐方案用词。与 T-02（切走侧栏后确认卡消失、loop 永久挂起）同区域，动手前一并处理。
结论：卡片从 `absolute` 浮层移进 `AgentPanel` 的**文档流**，位置在输入 form 上方（新增 prop `pending-confirm` + 事件 `confirm-answer`；两个宿主只传 prop，`Agent.vue` 与 `workflows/[id].vue` 各自的 `<agent-confirm-card>` 渲染和 import 已删除）。① 的两个症状一起消失 —— 文档流里的卡片既不遮挡输入框与发送按钮，也不会浮在翻动的历史之上。② 按 kind 补齐内容：标题分五种（`在 {target} 上执行 JS` / `在 {target} 上标出元素` / `打开一个新标签页` / `往画布添加一个块` / `修改画布上的节点 {nodeId}`），target 取 `agent.targetTab.title`、缺省退「当前目标页」；正文给 `{n} 行`；按钮 `[取消] [执行]`。
**与原建议的两处偏离**：(a) 未做「插入事件流内 + 顶部吸附条保底」—— `pendingConfirm` 是宿主状态而非事件历史里的条目，塞进 `AgentTranscript` 要新增插槽与 sticky 兜底两套结构；放输入框上方同样保证输入区永远可达，代价小得多，吸附条也就不再需要。(b) §8.2 那句 CSP 提示**刻意不照抄**：方案承诺「严格 CSP 页面走 chrome.debugger 降级、浏览器会显示调试横幅」，而 B6（debugger 降级）未实现，现状是 MAIN world + `new Function`、严格 CSP 页面直接失败且无任何降级 —— 照抄等于向用户承诺一个不存在的能力，文案改写为诚实描述（「严格 CSP 的页面可能拒绝执行，本版没有降级方案」），B6 落地后再按方案回填。附带修正：`workflow.agent.confirm.hint` 原文写死「会在你选中的页面上执行代码」，对 `open_url`/`add_block` 不成立，改为通用表述；按钮文案 `允许执行`/`不允许` → `执行`/`取消`；`<pre>` 加 `v-if`，detail 为空不再渲染空框。
实测：`npm test` 296 pass / 0 fail（原 282）、`npm run check:i18n` 通过、`npm run lint` 1 error / 10 warning（唯一 error 在 `src/lib/dayjs.js:11`，`git diff` 为空、改动前即如此，本批文件 0 贡献）、`npm run build` exit=0。**渲染效果未在真机点开验证**（需装扩展 + 配 key，本机未跑）—— 位置与文案目前只有 vue-eslint-parser 的模板解析与 webpack 编译通过作证，属推断而非实测。
状态：已清（2026-10-04 完成）

### T-27 — 确认卡的 `<pre>` 永远是空的：requestConfirmation 载荷里没有 `code`

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 架构文档梳理，触发点 `src/agent/loop.js:186-188`、`src/composable/agentHost.js:69-75`
现象：write 类工具弹出的确认卡上那块「看一眼内容」的代码框恒为空。`AgentConfirmCard.vue` 只接收一个 `code` prop，而 runtime 存进 `pendingConfirm` 的 `code` 取自 `req.code`——`loop.js` 的 `requestConfirmation({ ...call })` 里 `call` 只有 `{step, name, toolCallId, args}`，**没有 `code` 字段**，于是 `(req && req.code) || ''` 永远落到 `''`。四个 write 工具（`test_js` / `highlight_selector` / `open_url` / `add_block` + `update_block`）全部受影响：用户看到的是一张「需要你确认 / 这一步会在你选中的页面上执行代码。放行前请先看一眼。」+ 一个空白框的卡片，既看不到要跑什么 JS，也看不到要往画布上放什么块。
证据：**代码位置，推断，未实测复现** —— `loop.js:186-188`（`requestConfirmation({ ...call })`，`call` 由 `:441-445` 构造，字段仅 step/name/toolCallId，args 在 `:465` 才补）、`agentHost.js:70`（`code: (req && req.code) || ''`）、`Agent.vue:24` 与 `workflows/[id].vue:51`（只透传 `pendingConfirm.code`）、`AgentConfirmCard.vue:12-15`（`<pre>{{ code }}</pre>` 无 v-if，空串仍渲染出空框）。卡片文案 `workflow.agent.confirm.hint`（`src/locales/zh/newtab.json:704`）写死为「执行代码」，而 `open_url`/`add_block` 并不执行代码，文案与实际动作也对不上。
影响：确认门是本设计唯一的写操作安全闸门（`docs/adr/0002` 的立论正是「确认卡上直接显示选择器，用户点允许恰好回答了『你说的是这个吗』」）。闸门形同虚设：用户只能盲点「允许执行」，或保守地一律拒绝——后者会让 `add_block` 这类主功能不可用。这条直接击穿 ADR 0002 声称的收益。
建议：`loop.js` 改为 `requestConfirmation({ ...call, args: call.args })` 之外的显式载荷——按工具名组装人话摘要（`test_js` 给 code 全文、`highlight_selector`/`query` 类给 selector、`open_url` 给 url、`add_block`/`update_block` 给 blockId/nodeId + 变更字段）；`AgentConfirmCard` 改为接收结构化载荷而非裸 `code`，并按工具名切换标题与 hint 文案。与 T-06（确认卡内容低于 tech-design §8.2 承诺）是同一张卡，建议一并做。
结论：新建纯函数模块 `src/agent/confirm.js` 承载载荷整形 —— `buildConfirmation(req, {targetTitle})` 按 `name` 分五类（`test_js`→code 全文 + `countLines` 行数、`highlight_selector`→selector、`open_url`→url、`add_block`/`update_block`→blockId/nodeId + 变更字段的 JSON 摘要、未知写工具→参数原样摊开），只读 `args`、顶层字段一律忽略；未知/缺 `args`/循环引用都有兜底，不抛。`src/agent/confirm.test.js` 14 条用例钉住（含三条关键回归：**顶层旧 `code` 不许覆盖 `args.code`**、`args` 缺失给空串而非 `undefined`、`data` 带循环引用不炸）。`agentHost.js` 删除 `req.code` 分支改调 `buildConfirmation`；`AgentConfirmCard.vue` 改收结构化 `confirm`，按 `kind` 切标题与 hint，`<pre>` 绑 `confirm.detail` 并加 `v-if`；`workflow.agent.confirm` 下新增 12 个 key（en + zh 同步）。
**原建议中「改 `loop.js` 传显式载荷」未采纳** —— 重新读过 `loop.js:441-465`，`call.args` 在 `executeCall` 之前已赋值，`requestConfirmation({ ...call })` 展开时 `args` 已在载荷里，缺的只是宿主侧的读取；改 loop 反而多一处无关改动。改由 `loop.test.js` 的「写类工具必须经过确认」补一条 `assert.deepEqual(asked[0].args, …)`，把载荷形状钉死在最靠近产出处。
实测：`npm test` 296 pass / 0 fail（原 282，新增 14 条全在 `confirm.test.js`）、`npm run check:i18n` 通过（zh-TW 对新增 12 key 缺译，advisory，与该区其余 agent key 同状态）、`npm run lint` 存量 1 error / 10 warning、`npm run build` exit=0。**未在真机复现原 bug**（需装扩展 + 起模型）—— 修复正确性由新增回归测试与代码路径证明，原「空框」现象本身仍是推断。
状态：已清（2026-10-04 完成）

### T-28 — agent 发给 background 的三条消息带 `type`，路由按 `name` 查表，`test_js`/`query_elements`/`highlight_selector` 一律打不通

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 浏览器侧管道梳理，触发点 `src/agent/index.js:229`、`src/utils/message.js:52-56`、`src/background/index.js:603/656/721`
现象：agent 侧 `toolCtx.sendMessage = (msg) => browser.runtime.sendMessage(msg)`（`src/agent/index.js:229`），工具发出去的载荷是 `{type:'agent:run-js'|'agent:query'|'agent:highlight', tabId, ...}`（`src/agent/tools/page-write.js:30/77`、`src/agent/tools/highlight.js:32`）。但background 侧是 `new MessageListener('background')` + `message.on('agent:run-js', ...)`（`src/background/index.js:61/603/656/721`），而 `MessageListener.listener` 只按 `message.name` 查表（`src/utils/message.js:52`），agent 的载荷根本没有 `name` 字段 —— 于是 `:56` 的 `message.name.split('--')` 抛 TypeError，被 `:74` 的 catch 包成 `Unhandled Background Error` reject。三个工具全部落进各自的 catch 分支，向模型返回「执行失败：Unhandled Background Error…」。
证据：**实测（复刻 listener 逻辑）** —— 按 `src/utils/message.js:48-79` 逐行复刻 listener，用 `{type:'agent:run-js',tabId:1,code:'1+1'}`（listener 表已含 `background--agent:run-js`）喂进去，输出 `REJECTED: Unhandled Background Error: TypeError: Cannot read properties of undefined (reading 'split')`。代码位置：产出侧 `src/agent/index.js:229`，消费侧 `src/utils/message.js:52,56,74`。**真实浏览器端复现：未实测**（需装扩展 + 起模型）。方案文档 `docs/agent-assist-tech-design.md` §7.4 原本写的是 `MessageListener.sendMessage('agent:run-js', payload, 'background')`，实现时换成了裸 `browser.runtime.sendMessage`，两者不是同一个协议。`read_page` 不受影响 —— 它走 `browser.tabs.sendMessage` + `switch (data.type)`（`src/agent/index.js:129-136` → `src/content/index.js:323`），是另一条通道。
影响：三个走 background 的页面工具（`test_js` 写类、`query_elements` 读类、`highlight_selector` 写类）在真实浏览器里全部不可用，模型每次只拿到一条 TypeError 文本，且错误文案完全指不到真因。`src/agent/tools/page-write.test.js` 用注入的假 `sendMessage` 只断言了载荷形状（`:93`/`:41`），这条断链不会被现有测试发现 —— 与 `openai-compat.js:96-104` 记的「测试夹具照消费方写」是同一类陷阱。
建议：① 最小改动 —— `toolCtx.sendMessage` 改用 `MessageListener('background').sendMessage(name, payload)`（`src/utils/message.js:88-90`），工具侧改成 `sendMessage('agent:run-js', {...})` 传两个参数；代价约 10 行，且天然避开 Firefox 需 `JSON.stringify` 的分支。② 或在 background 侧 listener 前加一层把 `{type}` 映射成 `name` 的兜底；代价一处全局改动，影响面比 ① 大。③ 两者都要补一条覆盖真实路由的断言（现在只测了载荷形状）。
结论：采纳 ① 的变体 —— 翻译收敛在装配层一个导出函数 `toBackground({type, ...payload})`（`src/agent/index.js`），内部走 `utils/message` 的 `sendMessage(type, payload, 'background')`（连 Firefox 的 stringify 分支一并覆盖）；三个工具的调用点不动，仍发 `{type, ...}`。补契约测试：`assembly.test.js` 新增 2 条，用 polyfill 桩把 `runtime.sendMessage` 接到**真实** `MessageListener('background')` 上，断言三条载荷原样路由到 handler、返回值原路带回。红证已实测：把 `toBackground` 换回裸 `runtime.sendMessage`，新路径按预期炸出与用户报错一字不差的 `Unhandled Background Error: …(reading 'split')` 且 handler 不被调用。`npm test` 282 pass / 0 fail（原 280），eslint 通过，`npm run build` 成功。工具侧仍发 `{type}` 是刻意的：工具层保持纯函数、不认识 wire 协议，翻译点唯一化在装配层。
状态：已清（2026-10-04 完成）

### T-29 — `agentEvalInPage` 丢掉了文档承诺的求值包装，`test_js` 任何返回值的代码必炸

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 用户报「确认权限后卡死」，触发点 `src/background/index.js:538-550`（构建产物 `build/background.bundle.js` 里的 `le`）
现象：`agentEvalInPage` 写的是 `const fn = new Function('return (' + src + ')')` 然后 `fn()()` —— `new Function('return (1+1)')` 得到的 fn，调用一次就**直接返回值 2**，`fn()()` 是把 2 当函数再调一次，必抛 TypeError。工具文档（`page-write.js:144`）承诺「会被包成 `(function(){ return (…) })() 执行`」，实现把这个包装弄丢了。后果：任何返回普通值的代码都炸（只有返回函数/IIFE 的代码侥幸能跑），模型收到报错后重试 `test_js`，每次重试 write 类都再过一次确认门、再弹一次确认卡，`MAX_STEPS=12` 内反复弹 —— 用户看到的就是「点确认后卡死/无限弹确认」。
证据：**实测（真 Chromium 加载 build/ 扩展，探针 `.agent-test/iso-probe.mjs`）** —— 走完整 wire（扩展页发 `background--agent:run-js` → background → `executeScript` MAIN world）发 `1+1`，返回 `{"error":"代码执行出错：n(...) is not a function","ok":false}`；把压缩产物里的 `le` 原样提取到干净页面单跑、以及手工未压缩同构函数注入，均复现同一错误 —— 与压缩无关，是逻辑本身错了。wire 链路本身正常（错误能 settle、能返回），所以这是 T-28 修好通道后暴露的下一层 bug。
影响：`test_js` 对模型完全不可用（凡有返回值的调用必失败），且失败形态诱发确认卡反复弹，体验为「卡死」。`query_elements` / `highlight_selector` 不走这个函数，不受影响。
建议：补上包装 —— `new Function('return (function(){ return (' + src + ') })')`，保持 `fn()()` 调用形状不变（`fn()` 返回包装函数，`fn()()` 才是求值），一行改动，Promise/超时语义不动。同时把这个函数从 `background/index.js` 抽成纯模块（`npm test` 的 glob 只覆盖 `src/agent/**`）补单测：表达式值、Promise、undefined、SyntaxError 四条。代价约 30 分钟。
结论：按建议落地 —— 抽成纯模块 `src/agent/agentEvalInPage.js`（导出 `agentEvalInPage` + `raceTimeout`，头注写死「必须自包含」的序列化约束），`background/index.js` 改为导入，本地定义删除；包装按建议补回，`fn()()` 形状不变。单测 10 条钉住：表达式值、对象 JSON、Promise 求值、IIFE、undefined、函数退回 String()、对象方法属性被 stringify 丢掉（已知行为钉住）、裸语句 SyntaxError、运行期异常归一。真机验收（探针 6 条全过）：`1+1` → `ok:true "2"`（328ms）、`document.title`、对象字面量 JSON、坏 tabId 立即报错。`npm test` 308 pass / 0 fail，eslint 干净，`npm run build` 成功且产物里包装形态正确。用户贴的错误 `代码执行出错：n(...) is not a function` 与登记的现象一字不差，即本轮修的对象。
状态：已清（2026-10-04 完成）

### T-30 — 工具执行 await 无超时无中止路径，页面同步阻塞代码把 agent 永久卡死

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 同上排查，触发点 `src/background/index.js:579-592`（`runInPage` 无超时）、`src/agent/loop.js:467`（`await executeCall` 无守卫）
现象：`test_js` 允许模型跑任意代码；表达式形式的同步死循环（如 `(()=>{for(;;);})()`）把目标页主线程永久占死，`executeScript` 的 promise 永不 settle，background 通道随之永不响应。`loop.js:467` 的 `await executeCall(...)` 没有超时或中止守卫 —— `abort()` 只 abort LLM 的 fetch signal，对卡在工具执行上的循环无效，整轮 send 永远回不来，agent.busy 永真，唯一出路是重开页面。`agentEvalInPage` 里的 10s `Promise.race` 救不了这种场景：那个 setTimeout 也运行在已被占死的页面主线程上，根本没机会触发。
证据：**实测（真 Chromium 加载 build/ 扩展，探针 `.agent-test/iso-probe.mjs`）** —— 发 `(()=>{for(;;);})()`，15s 硬超时后仍是 `{"__hung":true}`；对照组「不存在的 tabId」立即返回错误。通道与错误路径都正常，唯独页面同步阻塞 = 永久挂起。
影响：模型只要生成一段同步阻塞代码且被 `test_js` 执行，agent 整轮永久卡死，停止按钮救不回。概率低但一旦发生必现、必死。
建议：background 侧 `runInPage` 包一层硬超时（如 15s `Promise.race`，超时返回 `{ok:false,error:'页面执行超时…'}`）让 loop 能继续收尾；loop 侧 `executeCall` 是否也要兜底可再议（有 background 超时后必要性下降）。代价约 15 分钟 + 1 条单测。
结论：按建议落地 —— `runInPage` 的 `executeScript` 套 `raceTimeout`（新抽的纯 helper，`agentEvalInPage.js` 导出），硬超时 `AGENT_PAGE_TIMEOUT_MS = 15s`，超时返回 error 形状（附「别再在这页上执行代码」的指引，模型可据此收手）而不是 reject；迟到 reject 由 helper 内部吞掉（有单测钉住不炸 unhandledrejection）。`agent:query` / `agent:highlight` 同走 `runInPage`，一并获得兜底。真机验收：`(()=>{for(;;);})()` 从「15s 仍挂死」变为「15.0s 返回『页面执行超时（15s）』error」，页内 10s 超时（页面还活着时）不受影响，坏 tabId 立即报错。loop 侧未加守卫：background 超时已兜住永不 settle 的来源，`executeCall` 自身逻辑（纯 JS）没有已知的挂起点，不加多余一层。
状态：已清（2026-10-04 完成）

### T-32 — `get_block_schema` 是从未接线的空壳，永远返回「可用块（一个都没有）」，模型陷入 read_page ↔ get_block_schema 循环

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 用户报「agent 不跑 test_js 且陷入循环」并贴出对话，触发点 `src/agent/index.js:192`、`src/agent/tools/page.js:268-281`、`src/composable/agentHost.js:240-252`
现象：工具 `get_block_schema` 的执行走 `ctx.getBlockSchema(name)`，而 `createAgentRuntime` 的默认实现是 `async () => null`（`index.js:192`），且**全仓没有任何宿主传入真实现**（`agentHost.js` 的 createAgentRuntime 调用只传了 getConfig/targetTab/enabledGroups/sessionStore/getWorkflowId/canvas/onSessionsChanged/requestConfirmation）。于是任何查询都命中「块不存在」分支，兜底的 `getBlockSchema('*')` 也返回 null → 可用块列表渲染成「（一个都没有）」。与 prompt 事实表同时 saying「本版共有 61 个块」（`prompt.js:192`，countBlocks 走真实目录）直接矛盾。用户贴的对话里模型查 `javascript-code`（真实目录里存在、`data.code` 字段齐全），得到「没有名为 javascript-code 的块。可用块：（一个都没有）」，随后在 read_page ↔ get_block_schema 之间震荡直到 MAX_STEPS 烧完；它始终没调 test_js，因为它的计划走的是工作流块路线（画布上已有 trigger/javascript-code/active-tab），而那条路被空 schema 工具堵死。
证据：**实测（代码 + 用户贴的对话双证）** —— ① `grep -rn getBlockSchema src` 仅命中 `index.js`（默认 null 桩 + 透传）和 `page.js`（工具），无任何宿主接线；② 真目录实测：`tasks` 共 61 块、`javascript-code` 存在，条目含 `name/description/category/data{code,...}` —— 工具需要的数据全都有，只是没接；③ 用户贴的 `get_block_schema` 返回原文「可用块（add_block 用第一个）：（一个都没有）」与桩行为逐字吻合。对照：同为块目录消费方的 `add_block` 用的是宿主传入的 `ctx.blocks`（`canvas.js:50`），有真数据 —— 说明目录通道本来就有，唯独 schema 工具漏接。
影响：所有块相关计划（add_block 前查字段、查可用块名）全部死路；模型在矛盾信息下反复重试直至 12 步烧完，用户看到「陷入循环、什么都没干成」。`test_js`/`read_page` 等非块工具不受影响，但模型的注意力被吸进死胡同后也不会去用。
建议：在装配层给 `getBlockSchema` 一个真默认实现（`index.js` 已导入 `tasks` 目录，无需宿主配合）：`'*'` 返回 `[{id, name}]` 全量列表；按 id 或 name 查找返回 `{id, name, description, category, data: Object.keys 风格的字段清单, refDataKeys}`，形状与 `page.js:286-299` 的渲染约定对齐。约 40 行 + `assembly.test.js` 补两条断言（查 `javascript-code` 能拿到 data 字段；`'*'` 返回 61 条）。另建议给「目录为空」加一条防御性断言：若 `getBlockSchema('*')` 返回空数组而 countBlocks>0，说明接线又断了，直接在观察值里说人话。代价约 30 分钟。
结论：按建议落地 —— 装配层新增导出 `lookupBlockSchema(name)`（`src/agent/index.js`，用已导入的 `tasks` 目录：`'*'` 全量 `[{id,name}]`、按 id/块名双认、返回 `{id,name,description,category,data}`），`createAgentRuntime` 的默认从 `async()=>null` 换成它，两个宿主零改动即接线。防御断言落在工具层（`page.js`）：① 形状守卫 —— schema 必须是非数组对象且带 id，否则按查不到处理（写测试时实测踩到：桩回空数组时 `[]` 是 truthy，会走「查到了」分支渲染出 `## undefined`）；② 目录为空 ≠ 没有匹配块 —— 观察值直说「get_block_schema 没接上线，停止重试本工具」。测试 7 条：按 id / 按块名 / `'*'` 镜像目录（条数 === `Object.keys(tasks).length`）/ 查不到 null / 空数组防御 / null 桩走旧分支 / 真实现端到端（`## JavaScript code` + 字段含 code）。`npm test` 314 pass / 0 fail，eslint 干净，`npm run build` 成功。
状态：已清（2026-10-04 完成）

### T-33 — `readPageFromTab` / 指纹 probe 的 `tabs.sendMessage` 无超时，页面被注入代码占死后 agent 永久挂起

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 用户报「同意运行代码后卡住」+ 会话 dump（`Downloads/agent-sessions.json`）分析，触发点 `src/agent/index.js:185`（readPageFromTab）、`:380`（probe）
现象：`test_js` 在目标页注入代码后，若该代码把页面主线程占死（死循环、alert 等），executeScript 通道有 T-30 的 15s 硬超时兜底，但**同一渲染进程的 content script 也会被占死**——之后任何 `browser.tabs.sendMessage`（read_page 工具、每步指纹 probe）的 promise 永不 settle：消息发给了一个无法响应的 renderer，没有浏览器级超时。`readPageFromTab` 的 try/catch 接不住「挂起」只接得住「抛错」，probe 同理。整轮 send 挂死在 step 开头或工具执行处，abort 也救不了（abort 只作用于 fetch signal）。
证据：**实测（真 Chromium + build/ 扩展，探针 `.agent-test/t33-probe.mjs`，2026-10-04 复现全链路）** —— ① 健康页发 `agent:read-page` 消息：立即返回（138 字节）；② 走 background `agent:run-js` 注入 `(()=>{for(;;);})()`：15.0s 后返回「页面执行超时（15s）」（T-30 兜底生效）；③ **同一被占死的页面再发 `agent:read-page`：15s 硬超时后仍是 `{"__hung":true}`** —— tabs.sendMessage 永不 settle，与用户「同意执行注入代码后整个助手页面所有交互失效、控制台无报错」的复现逐环吻合（无限 await 不抛错，控制台自然干净）。用户盲批的注入代码（UI 构建脚本）无需逐字核对：任何把页面主线程占死的形态（死循环/alert/同步重排）都进入这条链。
影响：模型注入一段带死循环/alert 的代码后，agent 当轮永久卡死、停止按钮无效、刷新丢整轮——用户已两次撞上「同意后卡住」。
建议：复用 `raceTimeout`（`agentEvalInPage.js` 已导出）：`readPageFromTab` 的 `tabs.sendMessage` 与 probe 各包 10-15s 超时，超时返回「页面无响应（可能被之前注入的代码占死），请换页或让用户刷新该页」的人话观察值。约 15 行 + 1 条单测。
结论：按建议落地 —— `readPageFromTab` 的 `tabs.sendMessage` 套 `raceTimeout`（`TAB_CHANNEL_TIMEOUT_MS = 15s`，params 可传 `timeoutMs` 覆盖供测试），超时返回「页面无响应（N s 无应答）……请停止对本页的读页和执行操作，让用户手动刷新或关闭该页，或用 focus_tab 换一个标签页」；指纹 probe 走同一函数自动获得兜底，超时返回字符串时 probe 拿不到 fingerprint → 不产生假通知（已核对 `index.js` probe 分支）。单测 2 条（桩永不 settle → 人话；健康通道照常）。`npm test` 328 pass / 0 fail，eslint 干净，`npm run build` 成功且产物含超时文案。局限如实记：单测覆盖的是装配层函数，真机端到端由 t33-probe 的第 3 步场景对应（raw 通道仍会挂，修复在调用点包裹），用户真机复验才算最终闭环。
状态：已清（2026-10-04 完成）

### T-36 — write 工具参数校验失败只回「××不能为空」，不回显实际收到的键，模型连错 6 次无法自纠

类型：改进
登记日期：2026-10-04
来源：同上 dump 分析（`94cd04e9` 第二轮：`update_block` 连续 6 次「nodeId 不能为空」错误，中间夹一次 list_canvas 也没能纠对），触发点 `src/agent/tools/canvas.js:44-49` 及 update_block 同形分支
现象：`add_block`/`update_block` 对缺失参数只返回「blockId 不能为空。」/「nodeId 不能为空。」。模型混淆两个工具的参数名（add 用 `blockId`、update 用 `nodeId`）时，错误信息不含「你实际发了什么」，模型只能瞎猜着重试——dump 里一轮连错 5 次 + 上轮 1 次，每次都烧一步配额与一次（update_block 的）确认弹窗。
证据：**实测（dump）** —— `94cd04e9` 工具错误事件 7 条：add_block 1 次 + update_block 6 次，错误文案逐条相同；工具参数本身不在持久化事件里（见 T-34），「发了错键名」是据错误形态与模型思考上下文的高置信推断。
影响：写路径的可用性被模型的小错放大成多轮失败，且每次失败都可能再弹一次确认卡打扰用户。
建议：参数校验失败时回显收到的顶层键名与值摘要（如「nodeId 不能为空。收到参数: {blockId: "pg8rzgv", data: {...}} —— update_block 用 nodeId，add_block 才用 blockId」）。`canvas.js` 两处分支 + 单测。约 20 分钟。
结论：按建议落地 —— `canvas.js` 新增 `missingParamError(missing, params, hint)`：回显收到参数的 JSON（**长字符串值截断到 60 字符**，整段错误不会被大 data 撑爆），并按工具点名破 blockId/nodeId 分工（add_block：「update_block 才用 nodeId」；update_block：「add_block 才用 blockId」）。新增 `canvas.test.js` 4 条（双向回显 + 长值截断 + 空参数占位）。`npm test` 338 pass / 0 fail，eslint 干净，`npm run build` 成功且产物含「收到参数」。效果：模型混用参数名时一次自纠，不再连错烧步数与确认弹窗。
状态：已清（2026-10-04 完成）

### T-37 — `elideStaleObservations` 保留条件过宽：页面快照只要后面跟了任何别的工具就被压缩，模型被迫反复 read_page

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 用户报「对话反复调用 read_page」并贴出对话，触发点 `src/agent/window.js:101-120`
现象：`elideStaleObservations` 的保留条件是「属于**最后一组工具消息**」（从尾部往前数连续的 role:'tool'），而不是「是**最后一次页面快照**」。只要模型在 read_page 之后调了任何非页面工具（get_variables、list_canvas、query_elements…），先前的页面快照就被换成 `STALE_MARKER`（「此前的页面快照已被压缩…」）——哪怕页面根本没变、这是当前唯一一份页面知识。模型的思考内容不进 wire（`wire.test.js`「思考内容不进 wire」），所以被压缩后它**真的**失去页面结构：用户贴的对话里，step 1 的思考还复述着「书本列表在 ol.row…」（当时快照还在 wire 里），step 2 的思考就变成「我需要先看看当前页面的结构」→ 重读；重读之后再调任何工具，新快照又被压缩 → 再读。10-03 dump 里 `47de996f` 会话「read → query → read → query → read×3」五连同页读取、今天多轮会话的 2-4 连读，都是这台机器压出来的。
证据：**代码逐行核对 + 用户对话逐步对账** —— ① `window.js:102-110`：`lastToolGroupStart` 从尾部收集**连续** tool 消息，`:114` 只豁免 `i >= lastToolGroupStart`；② 用户贴的对话时序：read_page(obs A) → get_variables/list_canvas → 此时 obs A 不在最后一组 → 被压缩 → 下一步模型思考原话「我需要先看看当前页面的结构」（它自己的上下文里已经没有页面了）；③ `window.test.js:70-89` 只覆盖了「旧快照后面还有**新页面快照**」的正确剔除场景，「快照后面跟非页面工具」这一致病场景没有任何用例；④ 第二次 read_page 观察值（detail="addresses"，默认档）与第一次参数相同——重读不是换档位，是上下文里真的没了。
影响：凡模型在 read_page 后调任何一个别的工具，页面知识就从上下文里蒸发，触发反复 read_page——烧步数、烧 token、弹无关的确认门，且观察值越大（content/full 档）压缩损失越重。
建议：`elideStaleObservations` 改为保留**最后一条页面快照**（从尾往前找第一条 `<untrusted_page_content` 开头的 tool 消息），只压缩比它更旧的页面快照；非页面工具不再参与「新旧」判定。约 10 行；`window.test.js` 现有两条（新快照替换旧快照、非页面工具不剔）语义不变，**新增**一条「快照后面跟 get_variables/list_canvas → 快照必须保留」。代价约 30 分钟。
结论：按建议落地 —— `window.js` 的判定从「最后一组工具消息」改为「最后一条页面快照」（从尾往前找第一条页面 content 的 tool 消息，`i === lastPageSnapshot` 豁免），头注写明判定依据（有没有更新的页面快照 ≠ 后面有没有别的工具）。测试 3 条：致病场景（快照后跟非页面工具 → 必须保留且不带 elided）、多条快照只留最后一条、原有两条（新快照替换旧快照 / 非页面工具不剔）语义不变仍绿。loop.test.js 的接线用例（两次 read_page，有更新快照）不受影响仍绿。`npm test` 330 pass / 0 fail（原 328），eslint 干净，`npm run build` 成功。模型侧收益：read_page 之后调别的工具不再失忆，反复 read_page 的结构性根因消除；同页重读只剩模型自身冗余一种来源（可用 [agent] 日志的 tool.call 参数摘要区分）。
状态：已清（2026-10-04 完成）

### T-38 — `test_js` 只接受表达式形式，模型写语句形式必吃 SyntaxError，「时好时坏」

类型：改进
登记日期：2026-10-04
来源：会话 2026-10-04 用户报「部分工具运行不稳定，有时候好有时候不好」并贴出对话（test_js 先报 `Unexpected token 'const'`、重试即成功），触发点 `src/agent/agentEvalInPage.js:31`
现象：`agentEvalInPage` 把代码包成 `(function(){ return (src) })` 求值——**只接受表达式**。模型抓数据时最自然的写法是语句形式（`const items = ...; const list = []; items.forEach(...); list`），以 `const` 开头的代码在表达式包装下必吃 `SyntaxError: Unexpected token 'const'`。重试时模型碰巧包成了 IIFE 才成功——所以「有时候好有时候不好」：不是随机，是**取决于模型这一次有没有记得写 IIFE**，而错误信息 `代码执行出错：Unexpected token 'const'` 完全没提示「该包成 IIFE」，模型要靠运气猜对。update_block 的「nodeId 不能为空」反复失败是同一类病（错误不指路），已在 T-36 登记。
证据：**代码逐行核对 + 用户对话对账** —— ① `agentEvalInPage.js:31` 包装形态如上；② 用户对话：第一次 test_js 报 `Unexpected token 'const'`（语句形式），第二次成功（返回书本数组，IIFE 形式）；③ `agentEvalInPage.test.js` 现有用例「裸语句是 SyntaxError」把该行为钉成了预期。
影响：抓数据的常见写法（语句形式）首试必败，浪费一步 + 一张失败卡片；错误文案不可行动，自纠靠运气。
建议：双形式求值——① 先按现行表达式包装编译；② 若抛 **SyntaxError**（编译期错误，代码尚未执行，回退无双跑副作用风险），改用语句形式 `new Function('return (async function(){\n' + src + '\n})')` 重编译执行（async 包装顺带支持顶层 await；值取 `return` 所得）；③ 语句形式跑完返回 undefined 时，在返回值里附一句指引（「代码已执行完毕但没有返回值——要拿数据请在末尾加 return，或包成 IIFE」）；④ 两种形式都 SyntaxError 才报错，文案说明已尝试两种形式。**严禁**在运行期错误（非 SyntaxError）时回退——那会双跑副作用。同步改 `agentEvalInPage.test.js`：「裸语句 SyntaxError」用例的输入换成两种形式都非法的（如 `const const`），新增语句形式成功 / 顶层 await / undefined 指引三条。代价约 40 分钟。
结论：按建议落地 —— `agentEvalInPage.js` 编译链改为「表达式优先，SyntaxError 才回退语句形式（async 包装，支持顶层 await）」，双形式都炸才报「表达式与语句两种形式都无法解析」；语句形式跑完无返回值时返回值附「加 return 或包 IIFE」指引（表达式形式的 undefined 保持干净字面量）；运行期错误不回退的红线写进了头注与实现（编译 catch 与执行 catch 分离）。测试：`agentEvalInPage.test.js` 原「裸语句 SyntaxError」用例换成双形式都非法的输入（`const const const`——原输入 `while(true){}` 在语句形式下能编译会真跑出 10s 超时），新增语句成功 / 顶层 await / undefined 指引 / 表达式 undefined 不带指引，共 16 条全绿。`npm test` 338 pass / 0 fail，eslint 干净，`npm run build` 成功且产物含双形式编译链。效果：语句形式首试即成，`Unexpected token 'const'` 一类失败消失。
状态：已清（2026-10-04 完成）

### T-02 — 确认门在面板被切走后不 resolve，那一轮 loop 永久挂起

类型：bug
登记日期：2026-10-04
来源：会话 2026-10-04 架构评审，触发点 `src/newtab/pages/workflows/[id].vue:1166-1185`、卡片位置 `[id].vue:26-53`
现象：write 工具等待用户确认时，`agent-confirm-card` 挂在 `v-else-if="state.sidebarPanel === 'agent'"` 分支内；`toggleAgentPanel()` 把 `sidebarPanel` 切到 `details`（无 busy 守卫，也不调 `pendingConfirm.resolve`），或点某个块弹出 `workflow-edit-block`（`v-if="editState.editing"` 优先级更高）时，确认卡被隐藏，但 promise 仍挂着 —— loop 侧永远 await。
证据：**代码位置，推断，未实测复现** —— `agentHost.js:65-75`（promise 只存 `pendingConfirm`）、`:86-92`（仅切会话时拒绝）、`:231-235`（仅 `onBeforeUnmount` 拒绝，而宿主页没有卸载）。`CONTEXT.md:80` 的不变量只写了「切会话/卸载前先 resolve」，没覆盖「面板被藏起来」。
影响：用户在等待确认时切走侧栏或去改别的块 → agent 保持 busy、那一轮不收尾、会话不落盘；用户切回后卡片还在，点一次才恢复。最坏表现像「助手卡死了」。
建议：① `toggleAgentPanel` 与打开块编辑时走 `guardAgentSwitch()` 同款拒绝，代价极小；② 或把确认卡提到宿主根节点（不随 `sidebarPanel` 卸载），代价是卡片要自己处理遮挡；③ 或 busy + 挂确认时禁止切走（体验差，不推荐）。
结论：采纳①的思路，但拒绝点挂在**卡片自己所在的组件**上，而不是散在三个调用点 —— `AgentPanel.vue` 新增 `onBeforeUnmount(() => { if (props.pendingConfirm) emit('confirm-answer', false) })`，走宿主已有的 `answerConfirm`（内部判空，`normalizeAnswer` 认布尔，重复发也安全）。一处钩子覆盖三处卸载路径：切走助手面板、打开块的编辑卡、收起整个侧栏 —— 三者在 `[id].vue` 里都是 `v-if`/`v-else-if` 真卸载（已逐处核对模板，无 `v-show` 隐藏分支），在 `toggleAgentPanel`/`initEditBlock` 各补一句的写法以后新增一处隐藏路径就漏一处。②（卡片搬家到宿主根节点）与③（busy 时禁止切走）都未采纳。loop 拿到「用户拒绝」的 error 观察值照常收尾，busy 与会话状态不受影响。
测试：本仓无组件测试基建（见 T-26），退而在 `confirm.test.js` 加一条**源码接线守卫**：断言 `AgentPanel.vue` 里存在 `onBeforeUnmount(() => {`、钩子内判 `props.pendingConfirm`、发 `emit('confirm-answer', false)`。红证已实测：把 emit 改成 `true` 后该条 `fail 1`，还原后全绿。`npm test` 343 pass / 0 fail（原 338），eslint 通过，`npm run check:i18n` 通过，`npm run build` 成功且产物含 `confirm-answer` 接线。
**局限如实记**：「三处 `v-if` 会真卸载」依据 Vue 语义与模板结构逐处核对，**未在真机点开验证**（需装扩展 + 配 key）—— 即「面板被藏起来后那一轮恢复收尾」这个现象本身仍是推断。
状态：已清（2026-10-05 完成）

### T-39 — runtime 通道发送侧无兜底：background 响应丢失时 agent 轮次永久挂起（真机复现）

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 用户贴出 `[agent]` 日志复现「test_js 同意后卡住」，触发点 `src/agent/index.js` 的 `toBackground`
现象：用户日志显示 `tool.call test_js → confirm.ask → confirm.answer(approved) → channel.send(agent:run-js)` 之后**既无 channel.reply 也无 channel.fail**——`browser.runtime.sendMessage` 的 promise 永不 settle。关键矛盾：该次注入的代码无死循环（query 20 本书 + JSON.stringify，毫秒级），background 侧 T-30 的 15s 兜底理应在 15s 给出响应；响应未到达说明 **background SW → 发送方的回程在用户真实 Chrome 里丢了**（SW 被回收 / 消息通道层面的浏览器行为），T-30 的兜底在 background 内部，救不了回程。
证据：**实测（探针 `.agent-test/t40-probe.mjs`，真 Chromium + 当前 build）** —— 用用户原始代码三层全部通过：热状态 140ms、连发 24ms、SW 空闲 35s 后冷启动 11ms，返回正确书本 JSON。即代码与本机传输路径均健康；差异只剩用户真实 Chrome（版本/环境）与被截断的代码（`+57` 字符未见，若含 alert() 会占死页面，但即便如此 15s 响应也应送达——t33-probe 已实测占死页时 15s 超时正常返回）。用户侧 `channel.send` 无 reply 无 fail 与「SW/传输丢响应」唯一吻合。
影响：与 T-33 同型的永久卡死，但发生在 runtime 通道——T-30/T-33 的兜底都盖不到回程丢失这一层。用户已再次撞上。
建议：发送侧兜底——`toBackground` 整个 round trip 套 `raceTimeout`（20s，大于 background 侧 15s，超时返回 `{ok:false, error:'background 通道无响应…'}` 人话观察值）；`channel.reply/fail` 日志附耗时 ms 便于定位。无论 SW/传输发生什么，agent 轮次都不会再挂死。约 15 行 + 1 条单测。
结论：按建议落地 —— `toBackground` 整个 round trip 套 `raceTimeout`（`BACKGROUND_CHANNEL_TIMEOUT_MS = 20s` > background 侧 15s，`options.timeoutMs` 供测试缩短），超时不 reject 而是回 `{ok:false, error}` 观察值形状；文案如实写「这一步是否已执行无法确认」并让模型先 `read_page` 看现状再决定，不许原地重复同一调用（T-33 的教训）。内部标记 `__timeout` 返回前剥掉，不进观察值。send **真**失败仍照旧 reject 走 `channel.fail` —— 超时兜底不吞真错误，有断言钉住。打点：`channel.reply`/`channel.fail` 都附耗时 `ms`，超时单独打 `channel.timeout`（带 `ms` + `timeoutMs`）。
**连带修掉一个实测到的泄漏**：`raceTimeout` 原来不清 `setTimeout` —— `Promise.race` 不会取消它，实测 `node -e` 一个 20s 定时器让进程多活 **20009ms**；T-39 之后每次工具调用都会走它，不修就是每次漏一个。改成谁先 settle 谁 `clearTimeout`（`.finally`），先完成的一侧由单测钉住（只盯自己注册的那个 60s 定时器，避免误伤别的来源的 timer）。
测试：`assembly.test.js` 新增 3 条（background 永不回应 → 人话 error 且 `__timeout` 不泄漏；超时与正常回程两条日志都带 `ms` 且健康回程不误判超时；send 真失败仍 reject）+ `agentEvalInPage.test.js` 新增 1 条（timer 必须被清）。`npm test` 343 pass / 0 fail（原 338），**耗时 10.2s 与改动前 10.4s 持平**（泄漏已修的旁证，否则会多吊 20s），eslint 通过，`npm run check:i18n` 通过，`npm run build` 成功且产物含超时文案与 `channel.timeout` 打点。
**局限如实记**：回程丢失的**根因**（SW 回收 / 浏览器行为）未复现也未消除 —— 本条修的是「无论回程发生什么都不再挂死」，`t40-probe.mjs` 在本机依旧全通（复现不了用户真机环境），最终闭环仍需用户真机复验。
状态：已清（2026-10-05 完成）

### T-40 — `agent:error` 事件有两种互不兼容的形状，promptFacts 降级的详情在 UI 上被吞掉

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 `src/agent` 架构评审，触发点 `src/agent/loop.js:318-322`（手动 emit）与 `src/agent/loop.js:81-88`（`toAgentEvent` 产出）的形状不一致；唯一消费点 `src/components/newtab/workflow/agent/AgentTranscript.vue:157`
现象：`toAgentEvent` 产出的 error 事件字段是 `{ status, message, errorKind, httpStatus }`；但「提示词事实表构建失败」那条降级路径手工 emit 的是 `{ kind, error: '...' }`，**字段名是 `error` 不是 `message`**。UI 侧只有一处读 `ev.message || t('workflow.agent.error')`，于是这条路径的用户可见内容被静默换成兜底文案——用户看到的是「错误」两个字，看不到「事实表构建失败，本次按空表继续」这个唯一能说明为什么本轮能力退化的信息。
证据：**静态代码确认（两个产出点字段名不同 + UI 只有一个读取点），未跑 UI 实测** —— `loop.js:321` 写 `error:`、`loop.js:84` 写 `message:`；`grep -rn "agent:error|\.errorKind|ev.message" src/components src/composable/agentHost.js` 命中仅 `AgentTranscript.vue:157`（读 message）与 `agentHost.js:254`（写 message）。
影响：① 用户侧：模型权限/领域知识表退化的原因不可见，症状表现为「助手突然变笨」且无任何提示；② 维护侧：`AGENT_EVENTS` 是 loop 与 UI 之间唯一的 seam（`CONTEXT.md` 明文），但它的形状没有任何一方守卫——两个产出方可以各写一套字段名，编译期与测试期都不拦。与 T-04（错误渲染样式）相邻但不同：T-04 是样式，本条是载荷丢失。
建议：① 抽一处 `emitError()` 工厂，所有 error 事件只能从它出，形状只有一份（约 30 分钟）；② 补一条「事件契约测试」——遍历 `AGENT_EVENTS` 全部 key，断言每个 key 至少有一个产出点，防止再出现僵尸常量；③ 顺手把 `agentHost.js:254` 裸写的 `'agent:error'` 换回 `AGENT_EVENTS.ERROR`。建议接 T-04 一起做。
结论：按建议落地 —— `events.js` 新增唯一构造函数 `errorEvent()`（新增 `ERROR_KIND.INTERNAL` 档承接装配类错误），loop 的 streamError / promptFacts 降级、index.js、agentHost.js 的全部产出点统一改走它，`agentHost.js` 裸写 `'agent:error'` 已撤掉；loop.test.js 里仍断言旧 `{ error }` 形状的那条用例同步改为断 `message` + `errorKind === internal`（事实表降级详情现在能在 UI 上显示）。`eventContract.test.js` 静态钉住「错误事件只从 errorEvent() 出」。`npm test` 350 pass / 0 fail。
状态：已清（2026-10-05 完成）

### T-41 — `AGENT_EVENTS` 里 CONFIRM / PROPOSAL 是零产出零消费的残留常量

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 `src/agent` 架构评审，触发点 `src/agent/events.js:19-20`；`START` 亦只有一个产出方且 UI 不消费（`src/agent/loop.js:337`，测试断言在 `loop.test.js:150`）
现象：`AGENT_EVENTS.CONFIRM` 与 `AGENT_EVENTS.PROPOSAL` 在**全仓没有任何产出方，也没有任何消费方**——它们是已废弃的 transcript 时代的展示角色残留（`CONTEXT.md` 已把 transcript 一词废弃，这类残留最应该跟着清干净）。事件常量表是 loop↔UI 契约的唯一声明，读者看到这两个 key 会以为存在一个尚未接线的 seam，实际确认流程是走 `deps.requestConfirmation` 直接回调宿主、不经过事件流。
证据：**静态确认** —— `grep -rn "AGENT_EVENTS.CONFIRM|AGENT_EVENTS.PROPOSAL|AGENT_EVENTS.START|'agent:start'" src` 命中项仅 `events.js:13`（定义）、`loop.js:337`（唯一产出）、`loop.test.js:150`（唯一断言），CONFIRM/PROPOSAL 零命中。
影响：纯认知成本——每次读事件表要多扫两个不存在的概念；将来有人真的想加 CONFIRM 事件时，会发现这个名字已经被占但语义不清。无运行时危害。
建议：删掉 CONFIRM/PROPOSAL（含 `AgentTranscript.vue:190` 注释里对它们的提及），保留 START（有产出方、被测试钉住）。配合 T-40 建议② 的「事件契约测试」一起做，能永久防止这类残留再回流。代价约 10 分钟。
结论：按建议落地 —— CONFIRM / PROPOSAL 已从 `AGENT_EVENTS` 与 `AgentTranscript.vue:190` 注释中删除，START 保留（有产出方、`loop.test.js:150` 钉住）。新增 `src/agent/eventContract.test.js` 三条守卫：每个 key 必须有真实代码引用点（僵尸常量直接红）、错误事件只经 errorEvent()、errorEvent 形状固定。`npm test` 350 pass / 0 fail。
状态：已清（2026-10-05 完成）

### T-42 — `docs/backlog.md` 里 T-40 编号重复，两条不同内容共用一个号

类型：bug（登记表自身）
登记日期：2026-10-05
来源：会话 2026-10-05 读 `architecture-review-20261005-0141.html` 后核对 backlog，触发点 `docs/backlog.md:200` 与 `docs/backlog.md:222`
现象：待审核区有两条都编号 T-40 的条目：`:200` 是「`agent:error` 事件有两种互不兼容的形状」，`:222` 是「agent-architecture.html 的代码快照与行号仍停在 T-29/T-30 之前」。而 `:219`（T-41 的建议）明确写着「配合 T-40 建议②」，指代对象因此二义。
证据：**实测** —— `grep -n "^### T-" docs/backlog.md` 得 39 条条目，其中 `200:### T-40 — agent:error…` 与 `222:### T-40 — agent-architecture.html…` 两行编号相同；全表 T 编号最大值为 T-41（`:211`），T-42 起为空号，说明 `:222` 那条是后补时漏了顺延。
影响：违反本文件顶部自定的「编号顺延」规则；此后任何「按 T-40 修」的口头或文档指代都指向两条不同工作，审核与排期阶段直接踩坑。
建议：把 `:222` 那条重编为 T-42（它编号靠后、是后补进来的那条），本轮新增条目从 T-43 起算已按此预留；另补一句「引用旧编号时同时注明行号」的约定。代价 2 行。
结论：已按建议处理 —— 原 `:222` 的 agent-architecture.html 条目重编为 T-47，待审核区不再有重号；T-41 文案里「配合 T-40」恢复唯一指代。自 T-43 起编号连续（grep 复核无重复）。
状态：已清（2026-10-05 完成）

### T-35 — 标题异步回写读到悬挂的 `currentSessionId`，落出 `agent_session_null` 幽灵会话进索引

类型：bug
登记日期：2026-10-04
来源：同上 dump 分析，触发点 `src/agent/index.js:563-582`（title then 里读 `currentSessionId`）、B1 的姊妹症状
现象：首轮 send 结束后 `generateTitleAsync` fire-and-forget，其 `.then` 里 `sessionStore.save({ id: currentSessionId, ... })` 读的是**resolve 时刻**的 `currentSessionId`。若用户在标题生成期间点了「新建会话」（`newSession()` 把 `currentSessionId` 置 null）或切走，晚到的标题保存就以 null id 落盘。dump 实证：存在键面值 `agent_session_null` 的完整会话记录（createdAt 与 `1d1c9a1e` 同为 12:50，title 是 LLM 生成的「注入JS获取书本列表并批量打开」），且索引里有 `id: "null"` 的条目——用户会看到一个切进去是空的幽灵会话。
证据：**实测（dump）** —— `agent_session_null` 记录存在、`agent_session_index` 含 `{"id":"null"}` 条目；该记录 title 为生成文案而 events 仅为首轮快照，与「title then 回写」路径吻合（save 载荷字段与 `:567-578` 逐一对应）。
影响：会话列表出现幽灵条目，点进去为空/错乱；与 B1 同根——回写用的是「当时的会话身份 + 当时的快照」而不是「请求时的」。
建议：与 B1 合并修：title 回写改为「闭包捕获发起时的 sessionId + 只 patch title 字段（读改写仅 title 键）」，回写前校验 `currentSessionId === 捕获的 id`，不等则放弃。约 20 行。
结论：按建议落地 —— `index.js` 首轮标题回写改为 `sessionStore.patchTitle(titleSessionId, title)`：发起时闭包捕获 sessionId，resolve 后 ID 失效（会话被删/切走）时 `patchTitle` 返回 null 直接放弃并记 `title.skip` 日志，不再可能落出 `agent_session_null`；`patchTitle` 只读改写 title 键、不动 events/pins/usage/lastAccessedAt。`sessions.js` 的 save/remove/patchTitle 统一走串行队列（writeTail），堵住 B1 的整记录覆盖竞态：晚到的 patch 只能改 title，不会回退第二轮已落盘的 events。测试：sessions.test.js 新增 3 条（patchTitle 只改 title、null/空 title/缺会话不落盘、索引同步只改 title）+ assembly.test.js 新增源码接线守卫（捕获 id、patchTitle、then 块内不出现 `id: currentSessionId` 与整记录 save）。`npm test` 350 pass / 0 fail，目标文件 eslint 0 error。
状态：已清（2026-10-05 完成）

### T-43 — runtime 闭包三块状态机没有 seam、零断言覆盖

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 架构评审（`architecture-review-20261005-0141.html` 候选 1），触发点 `src/agent/index.js:359`（`createAgentRuntime`）
现象：`src/agent` 的规矩是「只有 `index.js` 能碰浏览器 API，其余纯函数好让 `node --test` 直接覆盖」，但所有跨进程接线都倒进了这一个文件。`createAgentRuntime`（`:359` 至文件末 `:762`，约 404 行）持有 11 个可变状态，内部缠着三件事：目标页身份状态机（pin 写入 / `focus_tab` 切换 / origin 漂移判定 / 指纹比对，`:370-533`）、会话收尾（usage 累加 / 剪 THINKING / 两份 save 对象 / 标题 fire-and-forget，`:574` 起）、`toolCtx` 字面量拼装（`:391-463`）。
证据：**实测** —— 状态声明逐个核对落在 `:370 targetTab`、`:376 pins`、`:377 focusedTabId`、`:379 lastNoticeKey`、`:382 lastRead`、`:384 fpNoticeKey`、`:386 fpCheckPending`、`:388 currentOnEvent`、`:536 activeAgent`、`:540 currentSessionId`、`:545 instructionQueue`，恰好 11 个。零覆盖同样实测：`Select-String src/agent/*.test.js 'preStepNotice'` 命中 4 处全在 `loop.test.js:729-765`，且 `:733` 自带注释「makeAgent 不支持 preStepNotice，这里直接手动建」—— 测的是传入的 fake，不是 runtime 里那份实现。`tabs.js:78` 写 `typeof ctx.pins === 'function' ? ctx.pins() : ctx.pins` 同时兼容两种形态，说明这个 interface 两边都没人拥有。
**来源文档的数字偏大，须按实测取值**：该评审称 `index.js` 861 行 / `createAgentRuntime` 474 行 / `assembly.test.js` 631 行 / 全目录 43 文件 10,080 行（含 2,700 测试行）；实测为 **762 / 约 404 / 613 / 54 文件 9,234 行（含 4,783 测试行）**。它的行号引用逐条核对**全部准确**（`:370-389` `:391` `:471` `:552` `:574` `:119` `tabs.js:78` `window.js:114,125` `loop.js:153` `events.js:61` `tools/index.js:152,166` 均对上），膨胀的只是汇总统计——结论成立，规模比它说的小。
影响：T-33 / T-39 / B1 / T-34 / T-35 这一串真机 bug 的老家都在这一层，再改动概率与改动难度同时最高，却零断言守护。
建议：分三步，**建议顺序 ② → ① → ③**。② `turnRecord.js`（usage 累加 / 剪 THINKING / 单一 save 对象）—— T-34、T-35、B1 三条已登记 bug 全落在同一段 save 代码上，先抽出记录构造可让它们共用一个入口（注意 T-35 与 B1 已要求「闭包捕获 sessionId + 只 patch title」，抽出来正好一次做对）；① `targetState.js`（pin / focusedTabId，三条 advisory 文案变纯函数返回值）；③ `createToolContext()` 固定形状，`tabs.js:78` 随之简化。三步均为「搬出去 + 补断言」，不改落盘格式、不碰任何 ADR。
状态：已清（2026-10-05）——② turnRecord.js（usage 累加 / 剪 THINKING / 单一 save 对象）已落，npm test 354 pass；① targetState.js（三条 advisory 文案变纯函数返回值 + 首捕 pin/去重追加）已落，npm test 359 pass；③ 不再做整体工厂化：`createAgentRuntime` 里的 toolCtx 仍内联，但它唯一的双形态接口 `ctx.pins` 已钉成只收 getter（tabs.js:78 兼容分支删掉、传错形状直接 error 观察值），tabs.test.js 夹具本就按 getter 传，未做 `createToolContext()` 工厂——当前 getter 惰性语义（deps.editor ref、targetTab 快照）与闭包生命周期强耦合，抽工厂搬的是语义不是代码，收益留证待收益出现再做。

### T-45 — `findTool` / `requiresConfirmation` / `collectPromptFacts` 的工具表参数默认回落到全量 TOOLS

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 架构评审候选 5，触发点 `src/agent/tools/index.js:152`
现象：三个函数的工具表参数都写成默认参数，回落到模块级全量 `TOOLS`。而生产路径永远传的是按 `enabledGroups` 过滤后的子集 —— ADR-0001 明确要求独立助手页绝不能让模型知道画布工具存在。于是「忘了传参」的失败模式是：系统提示里悄悄多出 `add_block / update_block / list_canvas`，模型在独立助手页调用后拿回一句「没有这个工具」，不抛错、不报警。
证据：**实测** —— 默认参数确认存在于 `tools/index.js:152 findTool(name, tools = TOOLS)`、`:166 requiresConfirmation(name, tools = TOOLS)`、`index.js:119 collectPromptFacts(tools = TOOLS)`。**今天生产链路无人踩坑**：`index.js:622` 构造 `activeTools`，`:645`、`:646` 与 `loop.js:199` 都显式传入。属留给未来第二个消费者的坑，不是现行 bug。
影响：一旦新增第二个消费者漏传参数，独立助手页会静默暴露画布工具、违反 ADR-0001，症状是模型「莫名调用不存在的工具」，排查成本高。另注：**`index.test.js:83-85/102-103/308/319` 六处测试依赖这个默认值**（故意不传参），改必填时这 6 处要一并改成显式传全量表，否则直接红。
建议：把默认参数改成必填（缺参即 throw），或在 `createAgentRuntime` 里一次性绑定。代价约 10 行，**搭 T-43 的车一起做最划算**，不建议单独立项。
结论：按建议落地 —— 三处默认参数全部删除：`findTool`/`requiresConfirmation`（tools/index.js）与 `collectPromptFacts`（index.js）现在缺参或非数组直接 throw；6+1 处测试调用点显式传 TOOLS；assembly.test.js 的两个内层 TOOLS 重复导入并入顶层。`npm test` 359 pass / 0 fail，相关文件 eslint 0 error。
状态：已清（2026-10-05 完成）

### T-34 — 会话只在收尾落盘，转中卡死/刷新即整轮丢失，卡住的轮次无法事后诊断

类型：bug
登记日期：2026-10-04
来源：同上 dump 分析，触发点 `src/agent/index.js:546-559`（save 仅在 send 收尾）、`sessionStore.save` 全仓仅两处调用（`:549`/`:567`）
现象：`sessionStore.save` 只在 `send` 正常返回后执行（含 abort 收尾）。转中（步骤之间）没有任何检查点——用户在转中刷新页面、或转中永久挂起后被迫刷新，**该轮所有事件（含工具参数与观察值）全部丢失**。dump 实证：三个会话只有 turn-start 的 3 个事件（start/user-message/target-tab）后再无下文；用户报「同意后卡住」的那一轮在 dump 里完全缺席——不是没发生，是没落盘。这也让「卡住」类问题事后无法诊断：现象发生了，数据没了。
证据：**实测（dump 分析）** —— `agent_session_1d1c9a1e` 与 `agent_session_null`（12:50）各只有 3 个事件；`594b95db`（12:07）在 test_js 报错 + read_page 后戛然而止；对照 `94cd04e9`（12:52）428 个事件完整（两轮都走完了收尾 save）。save 调用点 grep 全仓仅 `index.js:549/567` 两处，均在 send 返回后。
影响：① 用户损失：卡死/误刷新即丢整轮对话与工具结果；② 诊断损失：所有「卡住」类问题都拿不到现场，只能靠用户肉眼转述。
建议：`record()`（loop 的入史口）改为节流落盘——每步结束（tool-result 入史后）调一次 `saveSession`，或至少 debounce 1s；转中 save 失败不影响轮（catch 吞掉但 console.warn）。注意与 B1（标题回写覆盖事件）一起修：B1 的「整记录覆盖」风险在增加落盘频率后会更容易触发，两处应同批处理（patch 单字段或带事件数校验）。约 1-2 小时。
结论：按建议落地 —— index.js 的 send 接上 createCheckpointSaver（turnRecord.js）：USER_MESSAGE / TOOL_RESULT / DONE 入史后 debounce(1s) 落一次；转中 save 失败走 agentLog.warn(checkpoint.save.fail) 不打断轮；收尾前 checkpoints.cancel() 再写最终记录（迟到的旧快照不能覆盖最终态），finally 兜底再取消一次。首轮 send 起 currentSessionId 即创建——卡死轮留下的在途 events 现在能落盘供诊断（usage 字段在途记上一轮，收尾整份覆盖，形状一致）。turnRecord.test.js 新增 3 条（debounce 合并 / flush / cancel / save 失败只 warn），assembly.test.js 新增源码接线守卫（cancel 必须先于最终 save）。`npm test` 363 pass / 0 fail，相关文件 eslint 0 error。
状态：已清（2026-10-05 完成）

### T-47 — agent-architecture.html 的代码快照与行号仍停在 T-29/T-30 之前，与页脚「行号均为实测引用」的承诺不符

类型：bug（文档与代码不一致）
登记日期：2026-10-05
来源：会话 2026-10-05 更新该文档（T-02/T-39 的结论要写进去）时逐块核对源码发现，触发点 `docs/agent-architecture.html` §13「写类工具的 MAIN world 执行」的两个代码块。
现象：§13 里 `runInPage` 标着 `// src/background/index.js:579-592` 且是裸 `try/catch`；`agentEvalInPage` 标着 `// src/background/index.js:538-555 —— test_js 的核心`，代码是 `new Function('return (' + src + ')')` + `fn()()` —— 正是 T-29 判死的那个必炸形状。
证据：**实测** —— `grep -n "function runInPage|function agentEvalInPage|raceTimeout" src/background/index.js` 输出：`12: import { agentEvalInPage, raceTimeout } from '@/agent/agentEvalInPage'`、`528: const AGENT_PAGE_TIMEOUT_MS = 15000`、`544: async function runInPage(...)`、`556: return raceTimeout(exec, AGENT_PAGE_TIMEOUT_MS, {`。即 `runInPage` 行号与实现都已变（T-30 套了超时），`agentEvalInPage` **根本不在这个文件里**（T-29 抽成了 `src/agent/agentEvalInPage.js`，且 T-38 改成双形式求值）。另有行号未复核：§13 通道表的处理端（`background/index.js:603/656/721`）、§06 流程分解（`loop.js:158-211` 等）。**文档页脚自称「代码行号与函数签名均为实测引用」，现状与这句不符。**
影响：这份 117KB 的 html 是本仓的架构入口（AGENTS.md 与 CONTEXT.md 都指向它）。照着它读代码的人（或 agent）会去找一个不存在的函数位置，或把已修掉的 `fn()()` 当成现状 —— 与「把有实测依据的偏离纠正回旧方案」同类的风险，方向相反。
建议：**只复核不重写** —— 按 §13 → §06 → §08 顺序逐个代码块对源码核行号与函数体，更新后在页脚加一行「最后核对于 YYYY-MM-DD」。整篇重写风险大于收益（文档 117KB，且大部分段落仍准确）。本条已在同一轮更新过 §07（确认门快照、四条路径表、T-02/T-27 状态）与 §13（超时分层说明），**剩下的代码快照未动，等审核**。代价约 1 小时。
结论：按「只复核不重写」落地 —— §13 两个快照整体替换为当前实现（`runInPage` 544-569 含 raceTimeout 15s、`agentEvalInPage` 36-101 双形式编译链并标注「T-29 抽出、T-38 双形式求值」、`script:execute-callback` handler 514-523→864）；§06 行号逐条对源码重核（promptFacts 守卫 306-315、MAX_STEPS 33、elide→budget 顺序注释 408-409、预算管线 408-414、abort 停轮 460-464、SyntaxError 降级 506-513、normalizeToolOutcome 109、DONE 537-549）；§03 事件表同步（10 种、删 CONFIRM/PROPOSAL 两行、events.js:12-23）；通道表 603/656/721→576/629/694、AGENT_PAGE_TIMEOUT_MS 556→528、BACKGROUND_CHANNEL_TIMEOUT_MS :181→:202；`handlerAgentReadPage.js` 1360 行核实属实（wc -l）；页脚加「最后核对：2026-10-05，T-47」。狗咬尾巴式的风险点：文档里已删事件表与代码事件表的不一致，靠 eventContract.test.js（T-41）兜住。
状态：已清（2026-10-05 完成）

### T-44 — 「这条观察值是不是页面快照」有三处互不知情的判定，靠字符串对齐

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 架构评审候选 2，触发点 `src/agent/window.js:114`（文本前缀嗅探）
现象：同一个判断有三份独立实现，彼此靠**字符串**而非数据对齐：`loop.js:153` 用 `tool.group === 'page'`（工具对象只在执行那一刻存在）；`events.js:61` 用 `outcome.wrap === 'untrusted_page_content'`（上一层塞进来的字符串）；`window.js:114/125` 用 `m.content.trimStart().startsWith('<untrusted_page_content')`（已混进 content 的文本前缀）。第三处的存在是被持久化逼出来的 —— `TOOL_RESULT` 落盘再读回时事件里只剩 `name`，工具对象连同它的 group 一起没了。
证据：**静态** —— `grep -rn "group === 'page'" src` 仅 `loop.js:153` 一处；`untrusted_page_content` 在实现里的命中点为 `untrusted.js:28`、`events.js:61-62`、`loop.js:153-154`、`window.js:114,125`。持久化代价：**实测** `sessions.js:6` 记录会话以整条 `{events}` 落 IndexedDB，`cropToTurns` / `titleFromEvents` 直接吃这个数组，所以改字段形状必然要一条旧记录 fallback。测试侧 `window.test.js:21` 手工拼 `'<untrusted_page_content>\n' + t` 构造输入，是在复述实现细节。
影响：新增一类「也该被陈旧压缩」的观察值要同时改 4~5 处（group→wrap 映射、wrap 白名单、`window.js` 前缀嗅探、`untrusted.js` 标签登记、`prompt.js` 措辞），漏改任何一处不报错、只静默失效。**排期注意：本条与 T-34 / T-35 / B1 争同一批文件**（都要改会话记录的写入路径），评审未注意这层耦合，排在它们之后做更省事。
建议：把「观察值形态」提升成跟着事件走的一等字段（工具定义上声明一次，或在 `tools/index.js` 做一处 `group → observationKind` 映射作为唯一真源），`loop` 挂到 `TOOL_RESULT` 上、`wire` 写进消息 meta 而不混进 content、`elideStaleObservations` 按 meta 判定。`untrusted_*` 标签仍是安全边界，继续按 `untrusted.js` 登记 —— 两件事职责不同，不要合并。必须同批定下旧会话记录的 fallback 规则（按 `name` 判定或一律当 value），不能「跑不出来再说」。
状态：待审核

### T-48 — LLM 标题在下一轮落盘时被冲回消息前缀，标题回写的成果撑不过第二轮

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 修 T-35/B1 时读 `src/agent/sessions.js` 的 `save()` 发现，触发点 `src/agent/sessions.js` save 的 `title: session.title || titleFromEvents(session.events)`，与 `src/agent/index.js` 第二轮 `save`（不传 `title` 字段）。
现象：标题回写（`patchTitle`）把 LLM 标题写进记录之后，**任何一次后续轮次的 `save()` 都会把它冲掉** —— 轮次 save 不带 `title`，`save()` 落盘时走 `titleFromEvents` 兜底取首条用户消息前缀，于是标题变回该前缀。
证据：**实测（取证脚本）** —— `.scratch/title-wipe.test.mjs`：首轮 save → 带 `title` 的 save → 按第二轮的形状 save（不带 title、events 变 4 条），断言标题仍为 LLM 标题 → **`pass 0 / fail 1`**，`AssertionError：实际 = "帮我抓列表"`。即 LLM 标题只在下一轮落盘前有效。
影响：`generateTitleAsync` 的可见成果基本被抵消 —— 发第二轮后会话标题（面板下拉 / 标题区）会变回消息前缀；不丢数据（索引与本体一致），但功能等于半失效。
建议：`save()` 的 title 兜底改为「传入的 title → 已存记录的 title → titleFromEvents」三级，记录的 title 只增不覆盖；仍走已串行化的写链，别引入新的读改写窗口。**未修，等审核批准。**
结论：按建议落地 —— `sessions.js` 的 `save()` title 兜底升级为三级：`session.title` → 已存记录的 title → `titleFromEvents`。读改写走已有串行队列（T-35/B1 的 writeTail），不引入新窗口。sessions.test.js 新增回归：patchTitle 后第二轮不带 title 的 save，标题与索引均保持 LLM 标题（索引同步是 `indexEntryFromSession` 直接吃 clean，跟着走）。`npm test` 364 pass / 0 fail，sessions 两文件 eslint 0 error。
状态：已清（2026-10-05 完成）

### T-61 — 轮末在全量历史里找 ERROR，会话出过一次错之后每轮成功也不发 DONE

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 pi 迁移 code review，触发点 `src/agent/loop.js:676-677`
现象：每轮收尾用 `history.find((e) => e.kind === AGENT_EVENTS.ERROR)` 判断「本轮是否出错」，但 `loop.js:600` 把 `params.initialHistory`（上一轮持久化的全部事件）整体灌进了 `history`，而 ERROR 事件会被持久化（`turnRecord.js:27` 的 `pruneEphemeralEvents` 只剪 THINKING）。于是只要历史里存在**任何一轮**的旧 ERROR，本轮即使完全成功也会命中 find、走 `return errorEv` 分支，不发 DONE。
证据：**代码位置核实（2026-10-05）** —— `loop.js:600`（`history = [...(params.initialHistory || [])]`）、`:677`（find 全量）、`src/agent/index.js:610`（`initialHistory = rec.events`，来自上一轮落盘）、`src/agent/turnRecord.js:26-27`（ERROR 不被剪）。
影响：多轮会话里一旦某轮失败过，之后每一轮成功收尾都被判为失败——UI 收不到 DONE，表现为「回答正常流完但会话状态不对」一类静默异常。
结论：`send()` 在历史重置后记 `turnHistoryStart` 基线，轮末错误判定改为 `history.slice(turnHistoryStart).find(ERROR)`，只扫本轮新增事件。回归测试钉住「initialHistory 含旧 ERROR 时本轮成功仍发 DONE、usage 不受历史影响」。
状态：已清（2026-10-05 完成）

### T-62 — 轮 usage 只取最后一条 assistant 消息，多步轮次 token 用量低估

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 pi 迁移 code review，触发点 `src/agent/loop.js:652-661`
现象：DONE 事件的 usage 从 transcript 末尾找第一条带 usage 的 assistant 消息就 break，只统计了本轮最后一个 LLM 请求的用量。一个工具轮里模型调了 3 次工具就有 3 条 assistant 消息，前两次的 input/output 全部丢掉。迁移前实现是按流 chunk 累加的。
证据：**代码位置核实（2026-10-05）** —— `loop.js:654-661`（倒序找到即 break）；旧实现 `git show 894ec164:src/agent/loop.js` 第 447-449 行为 `usage.input += ...` 累加。
影响：多步工具轮的 token 用量系统性低估（最坏只报 1/N），UI 展示与后续任何按用量计费/限流的逻辑都会失真。
结论：prompt 前记 `turnTranscriptStart` 基线，usage 改为累加本轮范围内全部带 usage 的 assistant 消息。回归测试两条：多步轮 100+200=300 钉住累加；同一 agent 跨轮第二次 send 只含自身用量，钉住基线不把上一轮算进来。
状态：已清（2026-10-05 完成）

### T-63 — `ev.wire || ev.text` 裸文本回落随票 07 复活进 loop.js，T-56 宣称已修但同形兜底仍在

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 pi 迁移 code review；原条目 T-56（`wire.js` 的裸文本回落，票 08 随文件删除）
现象：票 07 新增的 `historyToPiMessages` 里，USER_MESSAGE 与 SYSTEM_NOTICE 两支都写 `content: ev.wire || ev.text || ''`（`loop.js:95`、`:104`）。`ev.text` 是**未包装**的原始文本——历史事件一旦缺 `wire` 字段，未包装文本就直达模型，正是 T-56 登记过的那条裸文本回落通道。票 03/08 提交信息宣称 T-56「新路径无裸文本通道」，与代码不符。
证据：**代码位置核实（2026-10-05）** —— `loop.js:95`、`:104`。当前生产路径（用户消息/预检/插话）都写 wire，迁移前落盘的历史事件也带 wire，故现网触发路径未实测到，属推断风险。
影响：任何未来新增的 USER_MESSAGE/SYSTEM_NOTICE 发射点漏写 wire 字段时，不可信内容不经包装直达模型，且无测试报警。
结论：删掉 `|| ev.text` 回落，USER_MESSAGE / SYSTEM_NOTICE 缺 wire 直接 throw（带事件文本摘要，与「不静默降级」一致）。回归测试钉住两类事件缺 wire 必抛错。
状态：已清（2026-10-05 完成）

### T-64 — provider.js 硬编码 `maxTokens: 4096`，长回答被静默截断且 spec 无此要求

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 pi 迁移 code review，触发点 `src/agent/provider.js:80`
现象：模型参数对象里写死 `maxTokens: 4096`，spec 与 ADR 0004 都没有这条要求，迁移前 provider 也没有输出上限。效果是每次回复最多约 4096 token，长代码/长工作流 JSON 会被静默截断（stopReason=length，用户只看到话说一半）。
证据：**代码位置核实（2026-10-05）** —— `provider.js:80`；`git grep maxTokens src/agent/` 仅此一处硬编码；旧 provider 不设该参数。
影响：所有「回答很长」的场景都踩到；无报错、无提示，表现为回答戛然而止。
结论：删掉该行，输出上限交给端点默认（pi 不设 maxTokens 时请求不带 max_tokens）。provider.test.js 无该字段断言，全量测试不受影响。
状态：已清（2026-10-05 完成）

### T-65 — 输出 token 截断保护（story 2）无测试钉住

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 pi 迁移 code review，对照 `docs/agent-core-migration-spec.md:32`（story 2）
现象：spec story 2 要求「模型撞到输出 token 上限时被告知参数可能不完整、重新发起，而不是执行一个参数被截断的工具」，迁移后仓库里没有测试钉住这个行为。（更正：登记时误写成「上下文超预算时截断保护」，story 2 实际指**输出** token 上限，与 B9 的「上下文预算裁剪不做」是两回事。）
证据：**代码位置核实（2026-10-05）** —— `src/agent/*.test.js` 中无相关断言。
影响：pi 升级或映射层改动悄悄破坏该行为时，模型会执行参数被截断的工具，无测试报警。
结论：实测 pi 内核已实现该行为（`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` 的 `failToolCallsFromTruncatedMessage`：`stopReason==='length'` 时消息里所有 toolCall 一律不执行，产出 isError 的「arguments may be truncated. Re-issue the tool call」错误结果）。新增测试把这个行为钉死：截断消息里的工具不执行、isError 为真、错误文案含 truncated/output token limit、整轮不终止。
状态：已清（2026-10-05 完成）

### T-66 — loop.js 头部不变式写「只能 import src/agent 下的纯模块」，实现却动态 import pi-agent-core

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 pi 迁移 code review（Standards 轴），触发点 `src/agent/loop.js:4-7` 与 `:451`
现象：头部不变式声明「本文件与 tools/* 只能 import src/agent 下的纯模块」，但票 01 起本文件动态 `import('@earendil-works/pi-agent-core')`。实现没违反 ADR 0004（pi 走 npm 是决策的一部分），违反的是自己头部的声明。
证据：**代码位置核实（2026-10-05）**。
影响：文档性缺陷，误导后续维护者。
结论：头部改写为真实不变式：不碰 `node:`/`process.`/webextension-polyfill/`@/` 别名/工作流保存；pi 包是 ADR 0004 明文允许的唯一 import 例外，与「三层事件」段落同步改为两层。
状态：已清（2026-10-05 完成）

### T-67 — 「wire」措辞残留：事件字段名 `wire` 与多处新注释仍在扩散已删除的第三层命名

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 pi 迁移 code review（Standards 轴），对照 `CONTEXT.md`「2026-10-05 变更：第三层 wire 消息已删除」
现象：`loop.js` 事件字段名仍叫 `wire`（3 处发射 + historyToPiMessages 消费），注释写「wire 字段」「通知进 wire」；`index.js:5` 模块清单列着已删除的 wire、`:603` 说「由 wire 配对净化兜住」。
证据：**代码位置核实（2026-10-05）**；UI（.vue）不消费该字段，只在 src/agent 内部与持久化事件里出现。
影响：命名指向一个不存在的层，新读者会去找 wire.js。
结论：字段改名 `promptText`（进 prompt 的最终包装文本）；`historyToPiMessages` 兼容读旧记录的 `ev.wire`（升级前的老会话续接不炸），兼容读有专测；`index.js` 两处注释改为现行表述（悬空 tool_calls 由 pi 的消息净化兜住）。
状态：已清（2026-10-05 完成）

### T-68 — piMessages 死存储：每轮成功后 `piMessages = agent.state.messages.slice()` 无人读

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 pi 迁移 code review（Standards 轴），触发点 `src/agent/loop.js:720`
现象：轮末把 transcript 拷进 `piMessages`，注释说「留给下一轮 / 票 07 的历史对接」，但下一轮续接走 `historyToPiMessages(params.initialHistory)` 重建，`piMessages` 从未被读。
证据：**代码位置核实（2026-10-05）** —— grep piMessages 仅声明、send 内局部使用、死赋值三处。
影响：误导性死代码；遮蔽「续接靠 initialHistory 重建」这个真实机制。
结论：删除死赋值与外层声明，重建用变量收进 send() 内局部 const。全量测试无行为变化。
状态：已清（2026-10-05 完成）

### T-69 — adapter.js 必填的 `wrapUntrusted` 形参从未被调用，必填校验是摆设

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 pi 迁移 code review（Standards 轴），触发点 `src/agent/tools/adapter.js`
现象：`toAgentTools`/`toToolResult` 把 `wrapUntrusted` 当必填依赖、缺失即 throw，但函数体内从不调用它 —— 实际包装由 `wrapObservation`（内部 import untrusted.js）完成。必填形参是假契约。
证据：**代码位置核实（2026-10-05）** —— adapter.js 内 `wrapUntrusted` 仅出现于解构、校验与透传，无调用点。
影响：误导契约；调用方被迫传一个不用的参数。
结论：形参与校验从 adapter 删除（包装点只准有一个）。原「缺注入必须炸」的 T-55 校验迁到真正的消费点 `createAgent`（缺 wrapUntrusted 即 throw，有专测）；adapter.test.js 的对应断言改为「不再收该形参 + 包装照常」。
状态：已清（2026-10-05 完成）

### T-70 — tool_execution_end 的 observation 恒为空占位：UI 工具卡从不显示结果文本，跨会话重建把 AgentToolResult 整个 JSON 进上下文

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 pi 迁移 code review（Standards 轴），触发点 `src/agent/loop.js` fromPiEvent
现象：`tool_execution_end` 映射出 `observation: ''`（注释还是票 02/03 之前的占位说辞）。后果一：UI 工具卡读 `step.observation`，普通工具结果在界面上从不显示文本。后果二：票 07 的 transcript 重建走 `ev.observation || JSON.stringify(ev.details)`，把整个 AgentToolResult JSON 化送进上下文——未包装、双层编码、混着 content 结构噪音。
证据：**代码位置核实（2026-10-05）** —— `loop.js` fromPiEvent、`AgentTranscript.vue:166,178-181`、`AgentToolStep.vue:25-26`、historyToPiMessages TOOL_RESULT 分支。
影响：所有工具调用的结果对用户不可见；重开会话后模型看到 JSON 垃圾而非结果文本，跨会话记忆质量受损。
结论：fromPiEvent 的 end 分支从 `event.result.content` 提取文本作 observation：adapter 产出的（已包装、单块、首部即 `<untrusted_*>`）原样透传；pi 自产结果（未知工具短路、输出截断、参数校验失败）在映射层补 `untrusted_tool_result` 包装 —— 红线第 2 条全路径保住。两条新测试分别钉「已包装透传 / pi 自产补包装」与「重建用 observation 而非 details 的 JSON」。附带效果：UI 工具卡恢复显示结果正文（`<untrusted_*>` 标签露出是 T-07 已登记的独立展示问题）。
状态：已清（2026-10-05 完成）

### T-71 — historyToPiMessages 的 default 分支注释说「不能静默丢」，实现却静默丢

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 pi 迁移 code review（Standards 轴）
现象：default 分支注释写「映射不了必须知道，不能静默丢」，实现是 `flushAssistant(); break;`。与 fromPiEvent 的抛错策略自相矛盾，违反「不静默降级」。
证据：**代码位置核实（2026-10-05）**。
影响：未来新增的带内容事件类型漏改本函数时，内容静默不进 transcript，跨会话丢记忆且无报警。
结论：default 分支改 throw（带 kind 值），与 fromPiEvent 一致；现有 AGENT_EVENTS 全集已被 switch 覆盖，正常路径不受影响。专测钉住未知 kind 必抛。
状态：已清（2026-10-05 完成）

### T-72 — record + currentEmit 成对调用在 loop.js 重复约 9 处，「入史+发外」单一入口不变式被拆散

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 pi 迁移 code review（Standards 轴，Duplicated Code 坏味道）
现象：`record(ev); if (currentEmit) currentEmit(ev);` 成对模式散落约 9 处，新增发射点漏掉一半不会有人报错。
证据：**代码位置核实（2026-10-05）**。
影响：维护性；只入史不发外 = UI 缺行，只发外不入史 = 续接丢数据。
结论：抽 `emitAndRecord(ev)` 单一入口替换全部 9 处成对调用，头部注释写明「新增发射点只准走这里」；`doneEv` 保持只发外不入史的现状（emitAndRecord 注释里显式点名这是唯一例外）。全量测试无行为变化。
状态：已清（2026-10-05 完成）

### T-73 — historyToPiMessages 伪造 `provider:'test'` / `model:'rehydrated'` 魔法值且无注释说明

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 pi 迁移 code review（Standards 轴，Primitive Obsession 坏味道）
现象：重建 assistant 消息时填 `provider: 'test', model: 'rehydrated'`，像测试夹具泄漏进生产代码，也无注释解释。
证据：**代码位置核实（2026-10-05）**。
影响：读者怀疑夹具泄漏；'test' 字样进了生产 transcript。
结论：改为 `provider: 'replay', model: 'replayed-history'`，注释说明这只是 pi 消息形状要求的非空占位、消息来自历史重放、usage 按 0 记。
状态：已清（2026-10-05 完成）

### T-74 — TOOL_CALL 事件顶层字段与 calls[] 重复携带：并行调用在 UI 与跨会话重建里只活下来第一个

类型：bug（兼契约坏味道 Data Clumps）
登记日期：2026-10-05
来源：会话 2026-10-05 pi 迁移 code review 二轮口头清单，用户追问后探针实测坐实；触发点 `src/agent/loop.js` fromPiEvent 的 TOOL_CALL 组装与 historyToPiMessages 的 TOOL_CALL 分支
现象：一条 assistant 消息里 N 个并行工具调用被折成**一条** TOOL_CALL 事件，第一个调用的 name/args/toolCallId 同时出现在顶层和 calls[0]，其余调用只存在于 calls[]。后果一（实测）：跨会话重建 transcript 时 historyToPiMessages 每条 TOOL_CALL 事件只 push 一个 toolCall 块，calls[1..N] 全部丢失，重建出的 assistant 消息只有 c1 的 toolCall，c2..cN 的 toolResult 成为孤儿。后果二（代码读判定，未实测渲染）：UI 合并逻辑键是 name+step 且不读 calls[]，同名并行调用的卡片互相覆盖。
证据：**实测（探针，2026-10-05）** —— `.scratch/probe-calls.mjs`：喂入含两个并行调用（c1/c2）+ 两条 TOOL_RESULT 的历史，输出 `重建出的 toolCall 块: ["c1"]`、`重建出的 toolResult: ["c1","c2"]`、`孤儿 toolResult: ["c2"]`。孤儿结果发到端点是否被拒（400）推断未实测；「模型丢失对 c2 调用的记忆」由输出直接成立。
影响：用过并行工具调用的会话重开后，模型的上下文里那次并行只剩第一个调用，后续轮次的引用/对比/追问建立在残缺历史上；孤儿 toolResult 有让续接请求被端点拒绝的风险。
结论：按**方案 B「一条调用一条事件」**落地（用户 2026-10-05 选定）。① `handlePiEvent`（唯一发射点）把翻译层的合装事件拆成 N 条单调用 TOOL_CALL 事件，事件流里不再有 calls[] 字段，事件流与 TOOL_RESULT 形成 1:1 配对；`fromPiEvent` 的合装形状保留为翻译层内部形状（测试已改注释说明）。② `historyToPiMessages` 展开逻辑重写：新格式走顶层平铺字段，旧持久化记录按 calls[] 展开（升级前的老会话并行调用不再丢），两条重建测试分别钉新格式无孤儿与旧格式展开。③ `AgentTranscript.vue` 卡片合并键从 name+step 改为 toolCallId（从后往前找归属卡，并行交错也能正确归并），卡片对象增加 toolCallId 字段。验收：`npm test` 373 pass / 0 fail（新增 3 条），eslint 0 error，`npm run build` exit=0（22:07 产物）。**局限**：UI 卡片合并的实际渲染效果无法在 node 单测覆盖（T-53 已登记的欠账），需真机验证——装新构建后跑一轮「一条消息并行调两个同名工具」看是否出两张卡。
状态：已清（2026-10-05 完成）

### B 区已清

- **B5 — 技术方案 Q4：确认卡会话级授权**（2026-10-04 完成）
  - 来源：`docs/agent-assist-tech-design.md` §8.2 / `docs/adr/0002` 已知欠账。内容：test_js 确认卡加「本会话允许试跑代码」复选框（面板卸载/中止即失效）；确认卡按 §8.2 展示目标页标题、代码行数、CSP 提示。方案语义：仅 test_js 可用会话授权，workflow 写操作永不允许。
  - 结论：会话授权落在 `agentHost.js` 的单个 `let sessionAuth`（内存态，不落盘），出口在新增的 `answerConfirm`（先判空 `pendingConfirm`，避免切会话/卸载路径清掉后再点按钮抛 TypeError）。闸在新建的 `src/agent/confirm.js`：`canRememberSession(name)` 只对 `test_js` 为 true，`shouldSkipConfirmation(name, sessionAuth) = sessionAuth && canRememberSession(name)`，因此 workflow 写操作在授权在手时**仍逐次确认** —— 这条语义由 `confirm.test.js` 5 条用例钉住（含「授权在手也不能免掉画布写操作的确认」）。卡片侧只有 `kind === 'code'` 才出现复选框，勾选状态只活在卡片内、卡一关即消失；答案走 `{approved, remember}`，由 `normalizeAnswer` 归一化（严格 `=== true`，失败即拒）后再 resolve 给 loop。三个失效点齐了：`abort()`、`guardAgentSwitch()`（新建/切换/删除会话；置在 `resolve(false)` **之后**，否则会被 resolve 内部那次 `nextSessionAuth` 回写覆盖）、面板卸载（随闭包消失）。
  - 与 §8.2 的偏离：CSP 提示不写「严格 CSP 页面走 chrome.debugger 降级」，理由同 T-06 —— B6 未实现，不能向用户承诺一个不存在的能力。
  - **留给用户判断**：授权只绑会话、不绑目标页 —— 勾了之后换目标页（`onPickTab`）不会重新确认，而 §8.2 列的失效点里本来也没有它。要更保守就在 `onPickTab` 里一并清一次，本次未擅自加。
  - 实测：`npm test` 296 pass / 0 fail（原 282）、`npm run check:i18n` 通过、`npm run lint` 存量 1 error / 10 warning、`npm run build` exit=0。**复选框的实际交互未在真机点过**（需装扩展 + 配 key）。
- （2026-10-03 code-review 的 14 项修复不在本登记范围，见 git 历史与 `docs/adr/0001~0003`）

### B1 — 标题异步回写可能覆盖并发写入的会话事件 🚨 bug

来源：`docs/pie-agent-borrowing-practices.md` A3（2026-10-03 对 pie 调研发现）。
内容：`src/agent/index.js` 的 `generateTitleAsync().then` 用**整记录 save()** 回写，`events` 是首轮捕获的快照。若用户在标题生成期间发出第二轮，晚到的标题保存会用首轮事件覆盖第二轮已落盘的事件（最终一致性受损；标题本身正确）。
缓决原因：窗口小（标题请求只发一次、通常秒回），需要用户在亚秒级内发第二轮才触发。
重开条件：立即修——改为只 patch title 字段，或回写前校验会话 `lastAccessedAt`/事件数未增长。
结论：按「重开条件」落地 —— 标题回写不再用整记录 `save()`，改为 `sessionStore.patchTitle(id, title)` 只 patch title 键；同时 `sessions.js` 把 save / remove / patchTitle 串进同一条串行队列，晚到的标题写入被排到第二轮收尾 save 之后执行，天然只覆盖 title、覆盖不了 events。并修掉同一处闭包读到悬挂 currentSessionId 的幽灵会话（T-35）。局限：串行队列只保证单运行时实例内有序，跨实例（多标签页同时开同一工作流）仍靠 lastAccessedAt 的最后写入获胜，本轮未引入锁。`npm test` 350 pass / 0 fail。
状态：**已清（2026-10-05）**。

### T-61 — `variant="text"` 不是 `UiButton` 的合法 variant，助手面板三个关键按钮完全没有样式

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 用户提「整个界面的 CSS 设计上应该和整个项目一致，比如滚动条很不好看，会话删除按钮不可见等等」，触发点 `src/components/newtab/workflow/agent/AgentPanel.vue:15-21`、`:55-63`、`:64-72` 与 `src/components/ui/UiButton.vue:7`、`:62-75`
现象：`UiButton` 的变体表里**没有 `text` 这个 variant**。三个按钮（标签页切换「选择目标页」、新建会话 ＋、删除会话 🗑）传的 `variant="text"` 取到 `undefined`，Vue 的 class 绑定拿到 `undefined` 就不输出任何样式类 —— 于是它们**既没有底色、也没有 hover 反馈**。用户看到的直接后果就是「会话删除按钮不可见」：不是颜色太浅，是它压根没拿到任何样式。
证据：**实测** —— 从 `UiButton.vue` 源码里抽出 `variants` 字面量在 node 里求值，合法组合与取值如下：
```
transparent/default => hoverable
fill/default        => bg-input
fill/accent         => bg-accent hover:bg-gray-700 ... text-white
fill/primary        => bg-primary text-white ...
fill/danger         => bg-red-400 text-white ...

AgentPanel.vue:16   variant="text" (btnType 默认 fill) => undefined
AgentPanel.vue:57   variant="text"                     => undefined
AgentPanel.vue:65   variant="text"                     => undefined
合法名：btnType=transparent -> [default]；btnType=fill -> [default, accent, primary, danger]
```
消费端是 `UiButton.vue:7` 的 `color ? color : variants[btnType][variant]`。**附带**：这三个图标按钮都没传 `icon` 属性，于是走 `:8` 的 `icon ? 'p-2' : 'py-2 px-4'` 分支拿到 `px-4` 水平内边距，图标按钮被撑成文字按钮的观感。**渲染效果未在浏览器实测**，但样式类为空是确定的。
影响：① 用户把「切换目标页 / 新建会话 / 删除会话」三个入口当成了不可点的文字；② 鼠标移上去没有任何反馈，用户不会知道它们可点；③ 同一个错误写法若出现在别的组件上是静默失败，没有任何测试或 lint 会报 —— `variant` 是自由字符串，`UiButton` 对未知值既不 warn 也不 throw。
建议：① 把三处 `variant="text"` 改为项目已有的正确写法 `btn-type="transparent"`（解析为 `hoverable`），先例 `EditorPkgActions.vue:12`、`:54`；② 图标按钮同时补 `icon` 属性；③ **可选但建议**：在 `UiButton.vue:7` 加一道守卫 —— 未知 variant 时开发期 `console.warn`（或直接 throw），把「静默无样式」变成可见失败，否则这个坑还会再踩。代价：①② 约 4 行；③ 约 3 行。
状态：待审核

### T-62 — 助手面板的滚动容器漏加项目现成的 `.scroll` / `.scroll-xs`，走浏览器默认滚动条

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 用户提「滚动条很不好看」，触发点 `src/components/newtab/workflow/agent/AgentTranscript.vue:5`、`src/components/newtab/workflow/agent/AgentTabPicker.vue:8`
现象：项目有现成的滚动条工具类 `.scroll`（宽 7px）与 `.scroll-xs`（5px），全仓 30+ 处在用，助手面板是漏网之鱼。事件流主滚动容器写的是 `overflow-y-auto p-3`，标签页弹窗的列表写的是 `max-h-[60vh] overflow-y-auto`，两处都没有 `scroll`，因此渲染成浏览器默认滚动条（Windows 上约 17px 宽、灰底灰块），在 320px 的侧栏里显得笨重。
证据：**实测（grep + 读源码）** —— 定义在 `src/assets/css/tailwind.css:94-112`（`.scroll` 及其 `.scroll-xs` 变体，含 `::-webkit-scrollbar` width/height 与 thumb/track 样式）；使用点抽样：`Workflows.vue:7`（`scroll scroll-xs`）、`BlockGroup.vue:43`、`UiAutocomplete.vue:6`、`StorageTables.vue:18`、`WorkflowDetailsCard.vue:60` 等 30 余处。漏加的两处：`AgentTranscript.vue:5`（`class="flex h-full flex-col gap-3 overflow-y-auto p-3"`）、`AgentTabPicker.vue:8`（`class="max-h-[60vh] overflow-y-auto"`）。
影响：纯观感。滚动条宽度差约 10px，在 320px 侧栏里挤占的是**对话正文**的空间；且同一个面板内部（如果后续加了别的滚动容器）会出现两种粗细不一致的滚动条。
建议：两处各补一个 `scroll`（事件流用 `scroll`，窄列表可用 `scroll-xs`），即 `AgentTranscript.vue:5` → `scroll scroll-xs` 以贴合 `Workflows.vue:7` 的先例。代价：各 1 个词，无逻辑改动。注意：若按 T-15 把标签页弹窗改成 popover，这一处会随之改造，届时一并带上即可。
状态：待审核

结论（三处都改了，不只是改写法）：
- **① 三处 `variant="text"` 直接消失**。面板这次按方案 C 重排（见 `docs/agent-panel-ui-proposal.md`），header 上的新建 / 更多两个入口与标签页 chip 都换成原生 `<button class="hoverable">`（先例 `[id].vue:97-110`），不再经过 `UiButton`，因此不存在「传错 variant」的可能。改用原生按钮还顺带躲开了 `UiButton.vue:5` 硬编码的 `h-10`（40px）—— 那正是旧 header 撑到 56px 的原因。
- **② 给 `UiButton` 补了会响的检查**（本条建议 ③）。未知 variant 且没传 `color` 时 `console.warn`，并把合法名从**真实的 variants 表**里列出来（`variants[props.btnType]`），不是写死一份名单 —— 写死的话表一改守卫就会说谎。
- **③ 新增 `src/agent/panelUi.test.js`**，5 条源码接线守卫（含本条与 T-62 的回归）。**红证已实测**：把 `variant="text"` 塞回面板 → T-61 守卫 fail；还原 → 全绿。
- 影响面确认：全仓 `grep variant="text"` 只有面板那 3 处；其余 `ui-button` 只用 `accent`(34) / `danger`(1) / `default`(2)，都是合法值，所以这条欠账**范围仅限助手面板**，没有第二个受害者。
验证：`npm test` 373 pass / 0 fail；`npx eslint` 对改动文件 0 error；`npm run check:i18n` 通过；`npm run build` exit=0（产物已 grep 确认含新接线、无 `variant="text"`）。
状态：已清（2026-10-05 完成）

### T-62 — 助手面板的滚动容器漏加项目现成的 `.scroll` / `.scroll-xs`，走浏览器默认滚动条

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 用户提「滚动条很不好看」，触发点 `AgentTranscript.vue:5`、`AgentTabPicker.vue:8`
现象：项目有现成的 `.scroll`（7px）/`.scroll-xs`（5px），全仓 30+ 处在用，助手面板是漏网之鱼 —— 事件流写的是 `overflow-y-auto p-3`，标签页列表写的是 `max-h-[60vh] overflow-y-auto`，两处都没有 `scroll`，渲染成浏览器默认滚动条。
证据：**实测（grep + 读源码）** —— 定义 `src/assets/css/tailwind.css:94-112`；漏加处 `AgentTranscript.vue:5`、`AgentTabPicker.vue:8`（旧版）。
影响：纯观感；滚动条宽度差约 10px，在 320px 侧栏里挤占的是对话正文。
建议：两处各补 `scroll`（原建议）。
结论：按原建议补齐，并顺手覆盖了新出现的三处滚动容器 —— 标签页弹窗改 popover 后列表挪进了新文件，所以是**四个**容器而不是两个：
- `AgentTranscript.vue` 事件流 → `scroll scroll-xs`（贴合 `Workflows.vue:7` 先例）。
- `AgentTabList.vue`（新，从旧 `AgentTabPicker` 抽出的无容器列表）→ `scroll scroll-xs`。
- `AgentSessionList.vue`（新，header 会话 popover 的列表）→ `scroll scroll-xs`。
- 旧 `AgentTabPicker.vue` 的 `max-h-[60vh] overflow-y-auto` 随弹窗一起没了 —— 弹窗本身是被本轮改造**删除**的（见 `docs/agent-panel-ui-proposal.md`）。

守卫：`panelUi.test.js` 的 T-62 条断言这两个滚动容器的 class 上都带 `scroll`。**红证已实测**：去掉事件流的 `scroll` 类 → fail；还原 → 全绿。
验证：`npm test` 373 pass / 0 fail；eslint 0 error；`npm run build` exit=0。
状态：已清（2026-10-05 完成）

### T-70 — focus_tab 在生产装配下必失败：pins 的「getter」一词在两侧各说各话（T-43③ 引入）

类型：bug（核心读类工具失效）
登记日期：2026-10-05
来源：会话 2026-10-05 架构评审 C1 候选 grilling 期间探针实测，触发点 `src/agent/tools/tabs.js:80-86` 与 `src/agent/index.js:456-458`
现象：tabs.js 的契约是「ctx.pins 必须是**函数** `() => pins`」（`:80` 判 `typeof ctx.pins !== 'function'` 即报错，`:86` 以 `ctx.pins()` 调用）；index.js 的 toolCtx 提供的是 **JS getter**（`get pins() { return pins; }`，求值后是数组）；adapter.js:130-134 每次 execute 用 spread 组 ctx —— spread 会**求值** getter，工具拿到的是普通数组。于是 `typeof ctx.pins === 'object'` → focus_tab 恒返回 `{status:'error', payload:'ctx.pins 契约错误…'}`。
证据：**实测** —— 探针 `.scratch/pins-probe.mjs`（复刻 index.js 的 getter 形状 + adapter 的 spread，调真 focusTabTool）：输出 `typeof ctx.pins after spread = object`、`focus_tab result = {"status":"error","payload":"ctx.pins 契约错误：必须是 () => pins 的 getter。"}`。
影响：自 T-43③（97de58f7「ctx.pins 契约钉成 getter」）起 focus_tab 在生产里 100% 失败 —— 跨页任务模型无法切换目标页，只能用 open_url 开新页绕行（open_url 不读 pins，不受影响）。tabs.test.js 夹具按函数形态传所以全绿：两侧各自自洽、集成点无人测，是「测试夹具替实现圆谎」的典型。
结论：按 T-71/C1 grilling 定案①（活值一律 JS getter，adapter spread = 「execute 时刻快照」语义）落地 —— tabs.js 守卫改 `!Array.isArray(ctx.pins)`、取值改 `const { pins } = ctx`，JSDoc 重写为「契约是数组」；tabs.test.js 夹具改 JS getter 形态与生产 toolCtx 同形；**另在 adapter.test.js 新增「T-70 回归」测试**：复刻生产链路（getter 形状 toolCtx → toAgentTools spread → 真 focus_tab execute 断言成功），谁再把「getter」理解成函数、或 adapter 不再 spread，这条就红。红证 = 修复前探针（focus_tab 恒 error）。
验证：`npm test` 378 pass / 0 fail（含新回归）；`npx eslint src/agent` 0 error；`npm run build` exit=0，产物 grep 含新守卫文案。
状态：已清（2026-10-05 完成）

### T-71 — C1 架构候选落地：toolCtx 收窄（声明式 ctx 依赖 + 活值统一 JS getter）

类型：改进（架构评审 C1 候选，grilling 五项决策由用户拍板「按推荐」）
登记日期：2026-10-05
来源：会话 2026-10-05 架构评审报告候选 1（improve-codebase-architecture 流程，报告在 %TEMP%，候选经人工回读核实），触发点 `src/agent/index.js:418-490`、`src/agent/tools/index.js:67-124`
现象：toolCtx 是 17 键大口袋，单工具最多用 4 键；缺注入有四种失败姿势（静默默认/人话报错/契约字符串/TypeError 吞成观察值）且装配期不拦；「活值」有三种习语且已产出 T-70 生产事故；targetTab 的手动同步不变式靠注释与守护测试维持。
决策（grilling 定案）：① 活值一律 JS getter（adapter spread = 「execute 时刻快照」语义），修 T-70；② 工具定义加 `ctx: ['键', …]` 简单数组声明；③ 严格——缺 `ctx` 字段模块加载期 throw；④ 校验两级：validateTools 查声明形状（模块期）、toAgentTools 查键绑定（装配期，canvas 句柄漏传在此炸）；⑤ CONTEXT.md 登记。范围不含 getVariables 静默默认（T-50）。
结论：全部按定案落地——
- 13 个工具全部补 `ctx` 声明（清单：read_page=[readPage]、find_text=[findText]、get_variables=[getVariables]、get_block_schema=[getBlockSchema]、query_elements/highlight_selector/test_js=[targetTab,sendMessage]、list_canvas=[editor]、add_block=[blocks,editor,newId,onCanvasChanged]、update_block=[editor,onCanvasChanged]、list_tabs=[listTabs]、focus_tab=[pins,getTab,addPin,focusTab]、open_url=[createTab,addPin,focusTab]）。
- `validateTools` 新增声明形状校验（缺字段/非字符串数组 → 模块加载期 throw，与「缺 class 即 throw」同哲学）。
- `toAgentTools` 新增键绑定校验（缺键 → 装配期 throw，点名「工具 ← ctx.键」，多个缺失一次报全）——**canvas 句柄漏传由此在装配期炸**（原 C4 候选的这个子项搭车完成）。
- index.js 的 toolCtx.targetTab 改 JS getter，setTargetTab 只改闭包变量，删手动回写、初值对齐与「必须同步」注释；assembly.test.js 守护测试改名跟随新语义。
- CONTEXT.md「工具」节新增「工具的 ctx 声明」「活值」两条（Avoid：函数式取新）。
- 新增测试 5 条（缺声明抛错 / ctx 形状 / 13 工具声明对照表 / 装配期绑定抛错 / T-70 回归）；loop.test.js、adapter.test.js 桩夹具补 `ctx`。
验证：`npm test` 378 pass / 0 fail（5 skip 为历史遗留）；`npx eslint src/agent` 0 error；`npm run build` exit=0，产物 grep 含「缺少 ctx 声明」「装配层漏传依赖」新文案。
状态：已清（2026-10-05 完成）

### T-82 — C3 架构候选落地：window.js 僵尸接口清理 + 模型侧承诺归真（T-64）

类型：改进（架构评审 C3 候选，grilling 三项决策由用户拍板「按推荐」）
登记日期：2026-10-05
来源：会话 2026-10-05 架构评审报告候选 3（improve-codebase-architecture 流程），触发点 `src/agent/window.js:106-160`、`src/agent/prompt.js:105-109`
现象：window.js 的 10 个导出里只有 truncateObservation（+ 它私用的 MAX_OBSERVATION_CHARS）是活的（唯一生产消费者 events.js 的 wrapObservation，8K 截断）；estimateTokens / elideStaleObservations / applyTokenBudget / STALE_MARKER / 三个估算常量 / DEFAULT_CONTEXT_WINDOW 全部零生产调用（grep 实测），且接口形状还是旧 wire 消息（role:'tool'、字符串 content），与 pi 的 content-block 现状不匹配。prompt.js:105-109 仍向模型承诺「read_page 历史快照会被压缩成一行占位」——迁移前为真（`git show 894ec164:loop.js:410-411` 每步跑 elide），迁移后成为对模型的失实承诺（T-64）；config.js:66-68 注释声称 contextWindow「决定旧轮次多快被裁掉」、provider.js:16 提到 estimateTokens 诊断输出，同病。
决策（grilling 定案）：① 整个删除 window.js，truncateObservation 并入 events.js（与唯一消费者同居），2 条截断单测挪进新建 events.test.js，window.test.js 其余 14 条死行为测试随删；② prompt.js 那条改写成真话版、保留「关键 selector 复述进方案」指引；③ config.js / provider.js 注释归真；loop.test.js 两条主语已死的 skip 桩删除，其余 3 条 skip（MAX_STEPS、429、log 打点）不动。
结论：
- **window.js 整文件删除**（~175 行），`truncateObservation` + `MAX_OBSERVATION_CHARS` 并入 `events.js`（放在唯一消费者 `wrapObservation` 正上方，头注写死「截断必须在包装之前」的顺序契约）；新建 `events.test.js` 收两条截断单测（自 window.test.js 原样迁入）。
- **prompt.js 失实承诺改写为真话版**：「历史观察值不是永久可查的：超长的观察值会被硬截断（8K 字符），更旧的轮次还会随会话修剪而不可见。关键 selector、条数与取值方式要复述进你自己的方案里」——行为指引保留（对用户复制友好，T-76 压缩真落地时依然成立），理由换成真机制。
- config.js / provider.js 三处注释归真（contextWindow 现在只是喂给 pi 的模型元数据，我们侧无任何代码读它做预算）。
- loop.test.js 删两条死 skip 桩（elide、预算打点）；保留 MAX_STEPS（T-75 接线时复活）、429 Retry-After（B9-2）、log 工具打点（T-59）三处。
- 全仓 grep 零残留引用。
验证：`npm test` 366 pass / 0 fail / 2 skipped（均为约定保留项）；`npx eslint src/agent` 0 error；`npm run build` exit=0，产物 grep 含新 prompt 文案「历史观察值不是永久可查」与截断标记「truncated: 超出」。
状态：已清（2026-10-05 完成）


### T-83 — 面板可点控件没有底色，与面板背景融为一体看不出哪里能点

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 用户原话「相关交互组件比如下拉框和按钮应该和工作流组件一样有一个底色，不然看起来和背景融为一体，看不出哪些是可交互的组件」
现象：面板 header 的会话 chip、新建按钮、输入区上方的标签页 chip 全部只有 `hoverable`（仅 hover 时变色）。鼠标不在控件上时，它们与面板背景同色，用户看不出哪里能点、哪里是下拉。
证据：代码位置 —— `AgentPanel.vue` header 两个按钮与 `AgentTabPicker.vue` chip 的 class 均只含 `hoverable`；`tailwind.css` 的 `.hoverable` 只定义 hover 态，无静态底色。对比 `bg-box-transparent` 在全仓 46+ 处在用（含工作流块 `BlockBase`/`BlockBasic`/`BlockGroup`、`UiAutocomplete`、`packages/newtab`），是项目既有的「这是个可点的盒子」约定。
影响：面板首屏的可发现性 —— 用户需要逐个 hover 试探才知道哪里能点。已在上一轮「删除按钮完全看不见」的反馈里体现过一次同源问题。
结论：三个触发器统一改用项目既有 token `bg-box-transparent` + `hover:bg-opacity-10`（比 `hoverable` 多一层静态底色，hover 时加深）。没有新造 class。守卫 `panelUi.test.js`「守卫：删除在会话下拉里，且可点控件都有底色」钉住三处，红证实测通过。
状态：已清（2026-10-05 完成）

### T-84 — header 的「更多」溢出菜单没有明显标识

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 用户原话「header上的更多按钮为什么没有明显标识？」
现象：`⋯`（`riMore2Fill`）是纯图标按钮，只在 hover 时变色。溢出菜单本身的图标语义在界面里没有文字解释，用户无法预期点开是什么。
证据：代码位置 —— 上一轮 `AgentPanel.vue` header 的 `⋯` 按钮只有 `:title`（悬停才可见），无可见文字。
影响：该按钮承载 token 用量与删除会话两项功能，看不出是什么就等于不存在。
结论：随 T-85 整条删除 —— `⋯` 不复存在，`riMore2Fill` 已从产物中消失（build grep 实测为 False），不存在「没有标识」的场景。守卫断言 header 不再出现 `riMore2Fill` 与 `session.more`。
状态：已清（2026-10-05 完成）

### T-85 — 「更多」溢出菜单属过度设计：删除应直接放进会话下拉

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 用户原话「你在header上使用了更多的按钮，这是出于什么考虑，为什么不直接设置成删除，或者把删除按钮放在下拉栏的列表中，下拉可直接删除，现在这个实现方法过于复杂」
现象：为了「token 用量」和「删除当前会话」两件事，header 多出一个 `⋯` 按钮、多出一层菜单。删除要先点 `⋯` 再点菜单项，两层跳转；而这两件事本来就都属于「会话」。
证据：代码位置 —— 上一轮 `AgentPanel.vue` header 的 `⋯` 下拉内只有用量文本与删除按钮两项。对比同仓库会话下拉（`AgentSessionList`）本来就承载全部会话相关操作。
影响：header 多一个控件（320px 宽里占了约 36px），删除多一次点击。
建议：采纳用户的第二个方案（放进下拉列表）而非第一个（header 常驻删除按钮）—— 常驻删除按钮与「新建」仅隔一个图标，正是 T-05 最初想避免的误触相邻布局；而放进下拉是用户已经打开「会话列表」这一上下文下的自然位置。
结论：
- `AgentSessionList.vue` 接管三件事：会话列表 + token 用量（`usage` 作为新 prop 传入下拉，做成列表底部的分隔行）+ **删除当前会话**（列表最后一行，破坏性红色 `text-red-500`，与「切换会话」明确区分）。
- header 只剩两个控件：会话 chip（`bg-box-transparent`，w-72 下拉）+ 新建按钮（`bg-box-transparent`）。`AgentDropdown` 的 `align="right"` 分支因此暂时无人使用但保留（是该组件的通用能力，非死代码）。
- 删除的两步防护不变：仍走 `agentHost.js` 的 `UiDialog` 二次确认（标题回显会话 title + 不可撤销），点击后先收起下拉再弹确认，避免两个浮层叠着。
- 死代码与文案清理：删掉 `AgentPanel` 里的 `moreMenuOpen` 状态与互斥 watch、失效的 `fmtTokens` 副本（已移入 `AgentSessionList`）、`session.more` i18n key（en/zh 全删，产物 grep 实测无残留）。
- 守卫：删除「必须在更多菜单之后」的旧断言作废，改为断言 ① header 不出现 `riMore2Fill`/`session.more`；② 删除能在下拉里直接点到；③ 删除行带浅色模式红色（`(?:^|\s)text-red-\d+`，避免只留 `dark:text-red-400` 也蒙混过关 —— 第一版守卫正栽在这上面）。红证 5 条全部实测通过。
验证：`npm test` 0 fail（`panelUi.test.js` 8 条守卫全绿，含既有 T-02 卸载拒确认门）；改动文件 eslint 0 error；`npm run check:i18n` 通过；`npm run build` exit=0，产物 grep：`bg-box-transparent` ✓、`text-red-500` ✓、`riMore2Fill` ✗（已移除）、`w-[32rem]` ✗。
状态：已清（2026-10-05 完成）

### T-83 — C2 架构候选落地：确认门知识回归单点（工具自带 confirmDetail）

类型：改进（架构评审 C2 候选，grilling 三项决策由用户拍板「按推荐」）
登记日期：2026-10-05
来源：会话 2026-10-05 架构评审报告候选 2，触发点 `src/agent/loop.js` beforeToolCall、`src/agent/confirm.js:90-158`、`src/agent/tools/index.js`
现象：ADR 0002 点名的闸执行者 `requiresConfirmation` 全仓零调用，闸以内联等价形式活在 loop 的 beforeToolCall；`toWireTools`（旧 wire 形状）零调用；「用户到底在放行什么」的提取逻辑以工具名硬编码在 confirm.js 的分支表里，长在工具之外——新增写类工具要动 5 处，漏一处静默落进 generic 摊开。
决策（grilling 定案）：① loop 改调 `requiresConfirmation`，删 `toWireTools`；② 工具自带 `confirmDetail(args)`，loop 经 `requestConfirmation({name,args,tool})` 送货，confirm.js 留基础形状+归属钉死+generic 兜底；③ validateTools 强制 write ⇒ confirmDetail；卡片/i18n/sessionAuth/ADR 0002 不碰。
结论：
- **闸收归单点**：loop 的 beforeToolCall 改调 `requiresConfirmation(toolCall.name, tools)`——与原内联（`tool && tool.class === 'read'` 放行）真值表逐字相同，行为零变化；ADR 0002 点名的闸函数成为真执行者，其 fail-closed 语义（未知工具→确认）保留专测；`toWireTools` 删除。
- **confirmDetail 落地**：5 个写类工具（test_js / highlight_selector / open_url / add_block / update_block）自带 `confirmDetail(args)`；loop 把闸里查到的 tool 带进 `requestConfirmation` 载荷；confirm.js 的 buildConfirmation 只补基础形状并**钉死归属**（name/targetTitle/canRemember 不许工具覆盖——canRemember 是 ADR 0002/B5 的会话授权闸）；generic 兜底覆盖「没带 tool」「read 工具误入闸」「未知工具」三种情形；`safeJson`/`joinLines` 从 confirm.js 导出复用，canvas.js 抽 `canvasConfirmDetail` 给两个画布工具共用。
- **装配期强制**：validateTools 新增 write ⇒ confirmDetail 校验（缺了加载期 throw，与「缺 class 即 throw」同哲学）。
- **测试**：confirm.test.js 全部载荷用例改为经真实工具注册表走整链（钉住 loop→宿主→confirm 全链形状），新增 3 条（没带 tool 兜底 / read 误入 / 归属钉死）；tools/index.test.js 新增 2 条（write 缺 confirmDetail 抛错 / 全部 write 工具 confirmDetail 产出合法 kind）；桩夹具（adapter.test.js 的 do_write、loop.test.js 的 writeTool）补 confirmDetail。**AgentConfirmCard 与 i18n 零改动**——kind→文案是视图插值，不是重复知识。
- CONTEXT.md「确认门」条补 confirmDetail 契约与 Avoid（工具外另建危险面映射表）。
验证：`npm test` 385 pass / 1 fail —— 该失败（panelUi 守卫）属**并行会话在途**的面板/compaction 工作（其 usage 重构与 compaction.js 为同轮在途文件），与本条无关；本条范围内 confirm / tools / loop 闸相关测试全绿。`npx eslint` 本条触碰文件 0 error（compaction*.js 的 lint error 属并行在途文件）。`npm run build` exit=0，产物含「缺少 confirmDetail」新文案。
状态：已清（2026-10-05 完成）


### T-86 — 删除要删的那一条会话：列表每项自带删除按钮，而不是「删除当前会话」

类型：改进
登记日期：2026-10-05
来源：会话 2026-10-05 用户原话「你应该在下拉栏中的每一个会话项中后面添加删除按钮，点击下拉-在会话列表中直接点击删除-确认。这样交互是不是合理一些？」
现象：下拉底部只有一行「删除当前会话」，所以删除的路径是「下拉 → 选中某个会话 → 下拉 → 删除当前会话 → 确认」四步。想删一个**旧会话**时必须先切换过去（切换会顺带丢掉当前上下文、且有 `guardAgentSwitch` 的副作用），而删除后立刻又回到新会话状态 —— 为了删一条历史记录被迫把面板搬到那条记录上。
证据：代码位置 —— `AgentSessionList.vue` 删除行绑的是 `emit('delete')`（不带 id）；`agentHost.js:171` 的 `deleteAgentSession()` **不接受参数**，恒定删 `agent.sessionId`；`agentHost.js:186` 确认回调里 `if (agent.busy || agent.sessionId !== id) return false` —— 「必须仍是当前会话」这条在按项删除下会直接否掉合法操作。
影响：删除一个非当前会话要多两次点击 + 一次会话切换；且切换动作本身会作废会话级授权（`guardAgentSwitch` 置 `sessionAuth = false`），属于删除动作不该有的副作用。
建议：采纳用户方案。每行右侧加删除图标，行主体仍管切换；`deleteAgentSession(targetId)` 接受可选 id；确认回调的复核从「仍是当前会话」改成「该会话仍存在」；删完只在「删的就是当前会话」时才清 `sessionId`/`events`/`usage`。二次确认（`UiDialog`）与 `runtime.deleteSession` 均不变。
结论：
- `AgentSessionList.vue`：每行改成一个 `<div>` 组 —— 行主体 `<button>`（点开切换，保留 `bg-box-transparent` 当前态 + `hoverable`）与行尾垃圾桶 `<button>` 并列。列表底部那行「删除当前会话」整行删除。垃圾桶默认中性灰、`hover:text-red-500` + `dark:hover:text-red-400` + `hover:bg-red-500/10`，并补了 `:aria-label`。
- `AgentPanel.vue`：`onDeleteSession(id)` 带上 id，`emit('delete-session', id)`。两个宿主（`workflows/[id].vue`、`Agent.vue`）都直接写 `@delete-session="…deleteSession"`，Vue 会把 emit 的 payload 当第一个实参传入，**父组件无需改动**。
- `agentHost.js` `deleteAgentSession(targetId)`：接受可选 id（为空仍删当前会话，向后兼容）。确认回调的复核从 `agent.sessionId !== id`（仍是当前会话）改为 `agent.sessions.some((s) => s.id === id)`（该会话仍存在）—— 前者在按项删除下会把合法操作直接否掉。删完只在「删的就是当前会话」时才清 `sessionId`/`events`/`usage`，删别的会话要保留当前上下文。`runtime.deleteSession(id)` 本身已支持任意 id，未改。
- 二次确认 `UiDialog`、正文回显标题、`guardAgentSwitch` 的 busy 拦截全部保留。
- 守卫新增 3 条：每行自带删除且带 id；删除按钮自己的 `<button>` 标签内不得出现 `emit('select'`（否则点删除连带切换）；host 必须按 id 删且不得再要求「仍是当前会话」。红证 6 条实测全部生效。
- 过程中修了自己两个写错的守卫：①「删除会话入口必须保留」的正则没跟上 `emit('delete-session', id)` 的新签名；②「删除不得复用行主体点击」写成「从 select 那行往后切 400 字符再断言里面没有 select」—— 那段切片自己就以 select 开头，**守卫在断言一件它自己制造的事**，改成取删除按钮自己的 `<button ...>` 标签再断言。
- 设计取舍：删除图标刻意只在 hover 时变红 —— 满列表常红的垃圾桶很吵，而这一行的区分主要靠结构（独立按钮 + 垃圾桶图标 + 二次确认）而非颜色。守卫因此要求 hover 红信号存在，但不再要求常驻红色，并把这个取舍写进守卫注释而非悄悄放宽正则。
验证：`npm test` 中本文件 8 条守卫全绿（含既有 T-02 卸载拒确认门）；改动文件 eslint 0 error；`npm run check:i18n` 通过；`npm run build` exit=0。
（同批 `npm test` 有 1 条失败：`loop.test.js:1724` 上下文压缩 T-76 —— 属另一进程在改的 `src/agent/compaction.js`，grep 确认该测试与本次改动零引用关系，非本条引入。）
状态：已清（2026-10-05 完成）


### T-87 — agent 面板 5 个图标名不存在于项目白名单，图标全程不渲染（我引入的）

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 用户原话「你的删除按钮是用什么做标识，我发现你从头到尾这个标识都不会显示出来，你排查一下原因」
现象：删除按钮的垃圾桶图标**从头到尾都没有渲染过**。排查发现不止删除一个 —— agent 组件里 5 个图标名在项目图标白名单里根本不存在：
`riDeleteBinLine`（删除按钮，用户反馈的那个）、`riArrowDownSLine`（header/输入区 chip 的下拉箭头）、`riChatHistoryLine`（会话图标）、`riArrowDownLine`（transcript 箭头）、`riLoader4Line`（转圈）。
证据：`src/lib/vRemixicon.js` 是项目本地的图标白名单 —— 顶部 `import { … } from 'v-remixicon/icons'` 显式 import，再在 `export const icons = { … }` 里逐个 provide，`install()` 时 `app.provide('remixicons', icons)`。指令侧（`vRemixicon.js` 的 `setup`）走 `inject('remixicons')[props.name]`：取不到就 `console.error('[v-remixicon] … name of the icon is incorrect')` 并 `return null`，渲染出一个**空的 SVG** —— 既不报错也不显示。所以「删除按钮看不见」的真实原因是图标没被 provide，与颜色无关。

> **2026-10-06 更正**：本条初版的证据写的是「本项目是改名过的 fork，删除图标叫 `riDeleteBin7Line` 而上游是 `riDeleteBinLine`」—— **这句是错的，系事后编造**。实测 `node_modules/v-remixicon/icons.js` 共导出 **2271** 个图标，其中 `riDeleteBinLine`、`riChatHistoryLine`、`riLoader4Line`、`riArrowDownSLine` **全都有**。真实原因是上游 2271 个、项目只 provide 了其中一部分（当时 144 个），我用的名字恰好不在被 provide 的那部分里。结论（图标名必须查白名单）不变，但理由必须写对 —— 错误的理由会让下一个人去查「哪里被改名了」，而不是去查白名单。
影响：5 处图标在界面上完全不显示且无任何可见报错。删除按钮只剩空白（纯图标按钮 = 什么都没有）。
教训：T-61 当初把「删除按钮不可见」归因为「字色继承成底色」，那是**误诊** —— 真正原因是图标名不存在。以后写图标前必须先查白名单，不能凭记忆拼 RemixIcon 的名字（上游叫 `ri-delete-bin-line`，本项目是改名过的 fork）。
建议：换成白名单里的正确名；并加一条守卫，断言 agent 组件里所有 `name="ri…"` 都在白名单中，附红证。
结论：
- 5 处先换成白名单内的现成名（临时代替）；2026-10-06 用户拍板后，又把最初想用的那批图标**加进白名单**并改回原意图标：
  `riDeleteBinLine → riDeleteBin7Line`、`riArrowDownSLine / riArrowDownLine → riArrowDropDownLine`、`riChatHistoryLine → riChat3Line`、`riLoader4Line → riLoader2Line`。
- 新增守卫「图标名必须存在于项目白名单 vRemixicon.js」：解析 `src/lib/vRemixicon.js` 的白名单，扫 `src/components/newtab/workflow/agent/*.vue` 里所有 `name="ri…"`，任何一个不在白名单就失败并列出文件名与图标名。白名单解析结果 < 100 个时守卫自身也失败（防止解析写错导致守卫静默空转）。
- 红证 4 条实测：把删除/会话/转圈/箭头四个图标分别改回原来的错名，四条全部转红；还原后转绿。
- **修正 T-61 的误诊**：T-61 把「删除按钮不可见」归因为「字色继承成底色」是错的 —— 真实原因是图标名不存在，渲染出的是空 SVG。颜色那次的改动（换掉无样式的 `variant="text"`）本身没错，但没能解释这个现象。
验证：`panelUi.test.js` 9 条守卫全绿；改动文件 eslint 0 error；`npm run check:i18n` 通过；`npm run build` exit=0。
（同批 `npm test` 的 4 条失败全在 `src/agent/loop.test.js`，grep 确认与本次改动零引用关系，属另一进程在改的 T-76/压缩链路的在途状态。）
状态：已清（2026-10-05 完成）

### T-89 — C4 架构候选落地：装配缝定向校验（含 T-69 修复）

类型：改进（架构评审 C4 候选；grilling 四项决策由用户拍板「按推荐」，Q1 明确收缩——「deps 四分组搬迁」不做：C1 的 ctx 声明+键绑定校验已覆盖最大静默失效面，分组是纯形状搬迁不新增行为，删码测试不过关）
登记日期：2026-10-06
来源：会话 2026-10-05 架构评审报告候选 4，触发点 `src/agent/loop.js` createAgent 缺省兜底、`src/agent/index.js` send 内 activeTools、`src/composable/agentHost.js` useAgentHost、`[id].vue` enabledGroups
现象：① `createAgent` 的 `buildUserMessage` 缺省兜底 `({userText}) => userText` 会静默丢 targetTab/workflowContext（模型失去目标页锚点），漏注入无任何报警；② T-69：`[id].vue` 的 enabledGroups 在 setup 期对 `haveEditAccess.value` 求值成快照，团队权限异步加载未就绪时永久缺 canvas 组；③ loop 传给 preStepNotice 的 `{step}` 是死参数（实现用内容键判重从不读 step），`stepCounter` 与「它按 step 判重」注释同病；④ `useAgentHost` 的 deps 无必填校验（漏传 getWorkflowId → 会话静默落成全局列表；漏传 enabledGroups → 按未过滤处理，canvas 组泄露）。
决策（grilling 定案）：① buildUserMessage 缺注入即 throw（T-55 同款）；② enabledGroups 支持数组或 () => 数组，runtime 每次 send 求值，[id].vue 改传 getter；③ 删 {step} 死参数与 stepCounter；④ useAgentHost 装配期校验 enabledGroups/getWorkflowId 必填；⑤ onEvent 子项降级为 send JSDoc 契约说明（唯一调用方 agentHost 恒传，不改行为）。
结论：
- **buildUserMessage 改必填**：删缺省兜底，createAgent 校验链（streamFn → model → wrapUntrusted → buildUserMessage）末位补 throw；loop.test.js 四处直调 createAgent 的夹具补传，新增「缺 buildUserMessage 直接抛」测试。
- **T-69 修复**：`createAgentRuntime` 的 enabledGroups 支持 `() => 数组`、每次 send 求值（权限收紧/放开下一轮生效，promptFacts per-send 重建自动跟上，无需重建 runtime）；`[id].vue` 改传 getter 并注释原因。
- **死参数清理**：`preStepNotice({step})` 改 `preStepNotice()`，`stepCounter` 声明/自增/重置与失实注释全删。
- **agentHost 装配期校验**：useAgentHost 开头校验 deps.enabledGroups（数组或函数）与 deps.getWorkflowId（函数），缺失 throw 并说明后果。
- **接线守卫**：assembly.test.js 新增源码守卫（index.js 支持函数求值 / agentHost 两条必填校验在 / [id].vue 传 getter）——`.vue` 与 composable 无测试基建，按 confirm.test.js T-02 守卫的既有手法钉源码。
- loop.js send JSDoc 补 onEvent 契约（缺了 focus_tab 的 UI 同步静默丢，宿主必须传）。
验证：`npm test` 394 pass / 0 fail / 2 skipped（含新守卫与 throw 测试）；`npx eslint` 触碰文件 0 error（[id].vue:670 的 no-console 为 T-31 在案存量）；`npm run build` exit=0，产物 grep 含「缺 buildUserMessage」「deps.enabledGroups 必填」。
状态：已清（2026-10-06 完成）

### T-69 — 编辑器宿主 enabledGroups 在 setup 期对团队权限求值一次，权限变化后工具集静默过期

类型：bug（团队场景）
登记日期：2026-10-05
来源：会话 2026-10-05 架构评审，触发点 `src/newtab/pages/workflows/[id].vue:629-631`
现象：`enabledGroups: haveEditAccess.value ? [...含 canvas] : [...]` 在页面 setup 时求值成普通数组传进 useAgentHost；haveEditAccess 依赖异步加载的团队数据，页面打开时权限多半未就绪 → 侧栏助手按「无编辑权」装配（缺 canvas 组）；反向（先有后失）则保留写权。runtime 不随权限变化重建。
证据：**静态确认**（`[id].vue` computed 与一次性求值）；团队权限的加载时序未实测。
影响：团队用户「让助手把块搭到画布上」静默不可用（模型看不到 canvas 工具，事实表同步裁剪），无任何报错。
结论：随 T-89/C4 修复——`createAgentRuntime` 的 enabledGroups 支持 `() => 数组` 且**每次 send 求值**（比原建议「init 时求值」更进一步：权限收紧也下一轮生效），`[id].vue` 改传 getter；agentHost 装配期校验 enabledGroups 必填；assembly.test.js 源码守卫钉住三处（runtime 函数支持 / 宿主校验 / 页面 getter）。
验证：同 T-89（394 pass / 0 fail；build exit=0）。
状态：已清（2026-10-06 完成，随 T-89/C4）

### T-75 — MAX_STEPS=12 定义了但从未接线：工具循环没有步数上限（B9 第 1 项未兑现）

类型：bug
登记日期：2026-10-05
来源：会话 2026-10-05 pi 功能面调研顺带发现，触发点 `src/agent/loop.js:39`
现象：`MAX_STEPS = 12`（注释「一轮里最多来回多少次工具调用，防止模型卡在工具循环里」）在整个 src/ 里只有定义处一个引用；loop 内部只有 `stepCounter`（为 preStepNotice 判重计数），没有任何位置拿它比较并中断循环。模型若陷入工具循环，会一直请求下去直到用户手点停止或撞 provider 上限。
证据：**实测** —— `grep -rn MAX_STEPS src/`（排除测试）仅命中 loop.js:39 定义行；loop.js 全文 grep `step` 仅计数与重置，无中断比较。pi-agent-core 自身也无默认步数上限（B9 第 1 项实测记录），两头都没有就是没人管。
影响：B9 第 1 项的「无步数上限」一半实际未补。最坏情况：模型循环调用工具，每轮都烧 token 花钱，直到用户手动停止。
结论：**用户拍板（2026-10-05）：不设步数上限，何时停止由用户决定**（与 B9 第 1 项原决策一致），故不做接线，直接删除死代码 `MAX_STEPS` 与其配套的 skip 测试，消除「看起来有保护、实际没有」的误导。CONTEXT.md「步」词条的死代码 ⚠️ 注记同步改写为「不设步数上限」决策记录。`docs/agent-architecture.html` 里对旧手搓循环 `MAX_STEPS` 的描述属迁移前历史文档，未随本条更新。
状态：已清（2026-10-06 完成）

### T-76 — 上下文压缩 + 溢出恢复（B9 第 1 项另一半；用户点名的头号项）

类型：新功能
登记日期：2026-10-05
来源：会话 2026-10-05 用户原话「对于上下文压缩等 pi agent 的高级功能还没有实现……看看有哪些好的功能是适合让我使用的」；同时命中 B9 第 1 项的重开条件。
现象：迁移 pi 后 transcript 无任何预算管理：事件历史随轮次累积，跨会话续接时 historyToPiMessages 全量重建，长对话/大页面直接撞 provider context 上限（主用 ModelScope 128k，页面正文动辄几万 token），用户只能弃会话重开。MAX_SESSION_TURNS=20 是存储体积上限，与上下文长度无关。pi 侧：pi-agent-core 1.0.0 已把压缩随 AgentHarness 一起移除（其 CHANGELOG.md:11-13），官方压缩在 coding-agent 的 harness 层实现（`pi/packages/coding-agent/src/core/compaction/`），机制可借鉴但代码不能搬（红线 4）。
证据：实测 grep——src/ 对 pi 的 import 仅 pi-agent-core 与 pi-ai 两个子路径（provider.js），无任何 token 预算逻辑。pi 机制位置：阈值公式 `shouldCompact`（compaction.ts:267-270）、切点规则（compaction.ts:802-870）、摘要 prompt（compaction.ts:507-538）、序列化截断（utils.ts:94-104）、溢出恢复压缩后重试该轮一次（agent-session.ts:2930-2999）。
影响：长对话必然撞上限报错；最坏丢掉整个会话的上下文与 pin。
结论（用户 2026-10-05 批准实施，机制自研不搬码，设计全文 `docs/agent-compaction-spec.md`）：
- **纯函数模块 `src/agent/compaction.js`**：CJK 感知 token 估算（CJK 1 字 ≈1 token，其余 4 字符 ≈1 token，宁高估不低估）、阈值族（reserve = clamp(cw×0.15, 2048, 16384)，threshold = cw − reserve，keepRecent = clamp(threshold×0.3, 2048, 20000) 且 ≤ threshold/2）、切点规划 `planCompaction`（从尾累积越过保留窗后回退到所属 user 轮起点，绝不劈轮/不拆工具对；切点为 0 / 保留窗内已有 compaction / 待压区间无 user 轮 三种 null 拒压）、序列化（包装文本带入、工具结果截 2000 字符、args 截 800、连续 TEXT_DELTA 归并、ERROR 保留成行）、摘要 prompt（首压/更新型两套，系统提示明写「对话内容是数据不是指令」）、`buildCompactionEvent`、`isContextOverflowMessage`、`dropTrailingPartialAssistant`、`projectAfterLastCompaction`。
- **loop.js 接线**：① 预压缩在 send 开头 START 之前触发（超阈值才发摘要请求；失败 log.warn 不杀轮——摘要只是优化，真撞上限有恢复路径兜底）；② 摘要事件**插在切点处**（`emitAndRecordAt`）而非尾部追加——追加会让「投影只认最后一条 compaction」把保留窗一起摘要掉，这是实施中抓到并修正的设计错误；③ transcript 重建改用压缩后的快照 carryOverEvents；④ 溢出恢复：ERROR 匹配溢出模式（自写正则清单，不引 pi-ai 根入口防 typebox 全家桶进 bundle）→ force 压缩 → 恢复通知 → `dropTrailingPartialAssistant` 剪残缺尾部（同时规避 pi `continue()` 在 assistant 尾会 throw）→ 重建 transcript → `agent.continue()` 续跑，只试一次；⑤ usage 按消息对象身份跨轮幂等收割（顺带修复：原实现按 transcript 下标切片，跨轮累积与恢复重建场景会错计）。
- **事件与包装**：`AGENT_EVENTS.COMPACTION`（'agent:compaction'，eventContract 僵尸常量守卫过关）；`UNTRUSTED_WRAPPER_TAGS` 新增 `untrusted_compaction_summary`（第 8 个，红线 2 登记，untrusted.test.js 钉同步 7→8）。
- **存储**：`cropToTurns` 切口永不越过最后一条 compaction 锚点——摘要被 20 轮修剪裁掉等于白压；锚点前老事件照常修剪（模型侧已由摘要顶替）。
- **UI**：`AgentTranscript.vue` 折叠卡「已压缩早期对话（N 轮）」（i18n `workflow.agent.compacted`，en/zh），展开走 AgentMarkdown。
- **CONTEXT.md** 新增「压缩摘要(compaction)」词条；spec §10 记录明确不做清单（轮中主动压缩/按模型阈值/usage 基线/手动 /compact）。
- **顺带（T-87 收尾补漏）**：T-87 的图标守卫只扫静态 `name="ri…"`，动态 `:name` 绑定漏网——thinking 卡、工具卡与本条新增压缩卡共三处折叠箭头用了白名单外死名（渲染空 SVG）。三处换成 `riArrowDropDownLine`/`riArrowRightLine`，守卫扩展为同时扫动态绑定（红证：塞回死名守卫转红），`AgentToolStep.vue` 的一处即由扩展后守卫首次抓出。
验证：`npm test` 396 pass / 0 fail / 2 skipped（约定保留；compaction.test.js 15 条、loop.test.js 4 条、sessions.test.js 1 条新增全绿，panelUi 守卫全绿）；改动文件 eslint 0 error；`npm run check:i18n` 通过；`npm run build` exit=0，产物 grep：`agent:compaction` ✓、`untrusted_compaction_summary` ✓、`riArrowDownSLine` ✗（死名已消失）。
状态：已清（2026-10-06 完成）

### T-90 — C5 架构候选落地：宿主 seam 收敛（面板 host-prop 化 + 会话授权状态机抽纯）

类型：改进（架构评审 C5 候选，grilling 四项决策由用户拍板「按推荐」）
登记日期：2026-10-06
来源：会话 2026-10-05 架构评审报告候选 5，触发点两宿主页的面板绑定与 `src/composable/agentHost.js` 的 sessionAuth 闭包
现象：两个宿主页逐字重复 9 props + 9 emits 的面板绑定（并行会话的面板重排后仍如此，本轮重读核实）；listTabs 由两页各自 import 绕过 agentHost seam；会话授权生命周期与切换守卫顺序散在 composable 闭包（无测试基建，一条分支测不到）；agent.runtime 被 reactive() 深代理。
决策（grilling 定案）：① AgentPanel 收单个 :host 对象 prop、直调 host 方法、9 emits 撤销；② listTabs 收进 useAgentHost；③ 会话授权抽 createSessionAuth() 纯状态机进 confirm.js；④ markRaw(runtime)。
结论：
- **AgentPanel.vue 重写**：props 收敛为单个 `host: {type: Object, required: true}`，`defineEmits` 整个删除——面板直调 `host.send/pickTab/answerConfirm/openSession/newSession/deleteSession/abort/noTarget/goToSettings`，模板约 40 处引用改 `host.*`；头注写明「为什么收整对象」的删码测试论证。
- **两宿主瘦身**：Agent.vue 与 [id].vue 的面板绑定各从 20 行缩为 `<agent-panel :host="agent" />` 一行，各自的 `import { listTabs } from '@/agent'` 删除（改由 agentHost 返回值携带，seam 不再被绕过）。
- **createSessionAuth 状态机**（confirm.js）：组合既有 nextSessionAuth/shouldSkipConfirmation/normalizeAnswer，提供 ask（已授权 test_js 直接放行）/answer（归一化+记录+清挂起）/invalidate/planSwitch（busy 不放行；先拒挂起再失效的动作顺序）；agentHost 的 askAgentConfirmation/guardAgentSwitch/abort 改为薄执行层，`let sessionAuth` 闭包标志位消失。
- **markRaw(runtime)**：挡 reactive 深代理。
- **测试**：confirm.test.js 新增 3 条状态机用例（授权只经 record、invalidate 后不可复活、planSwitch 动作与顺序）；assembly.test.js 新增 T-90 源码守卫（两页只绑 :host、面板无 defineEmits、listTabs 不许直连 @/agent）；confirm.test.js 的 T-02 守卫与 panelUi.test.js 的布局守卫同步更新匹配形状（emit → host 直调，语义不变）。
- agentHost 头注更新：宿主实测差分（enabledGroups/getWorkflowId/sessionWorkflowId/canvas 四句柄 + getter 形态）。
验证：`npm test` 398 pass / 0 fail / 2 skipped；`npx eslint` 触碰文件 0 error（--fix 修 2 处 prettier）；`npm run build` exit=0，产物含 agentHost 新校验文案。
状态：已清（2026-10-06 完成）


### T-88 — 全仓另有 3 处无效图标名（存量，非本次引入）

类型：bug
登记日期：2026-10-05
来源：T-87 排查时全仓扫描 `src/**/*.vue` 顺带发现（`git status` 证实这些文件未被本会话改动）
现象：另有 3 个无效图标名，同样静默渲染空 SVG：
`riSparklingLine` → `src/newtab/pages/workflows/[id].vue`、`src/newtab/pages/Workflows.vue`；`riDragMoveLine` → `src/content/elementSelector/App.vue`；`riListUnordered` → `src/components/content/selector/SelectorQuery.vue`。
证据：白名单来自 `src/lib/vRemixicon.js:1-146`（145 个）。三个名字均不在其中；已按同类语义确认可用替代名：
`riSparklingLine → riMagicLine`、`riDragMoveLine → riDragDropLine`、`riListUnordered → riFileListLine`（前两个直接可用；`riFileListLine` 与「无序列表」语义不完全等价，替代前需看 `SelectorQuery.vue` 那个图标原本想表达什么）。
影响：三处界面上不显示图标。`Workflows.vue` / `[id].vue` 的 sparkle 若是「AI 助手」入口标识，缺图标会让入口更难被注意到。
建议：逐个换成白名单内的等价图标。**不在 T-87 里顺手改** —— 超出本轮范围，且需要确认每个位置原本想要的语义。
建议：逐个换成白名单内的等价图标。**不在 T-87 里顺手改** —— 超出本轮范围，且需要确认每个位置原本想要的语义。
结论（2026-10-06 用户选「补 3 处 + 面板想要的贴切图标」）：
- 三个名字里**只有 `riSparklingLine` 上游真的没有**；`riDragMoveLine` 与 `riListUnordered` 上游都存在，**只是没被 import** —— 名字不用改，补 import 即可。这一点纠正了我初版的判断（当时按三个一起归为「无效名」）。
- `riSparklingLine`（2 处，均为「AI 助手」入口按钮 `workflow.agent.tab`）→ **`riMagicLine`**，该图标原本就在白名单里，无需新增 import。
- `src/lib/vRemixicon.js` 新增 6 个图标（144 → 150），全部插在同类图标旁边：`riDragMoveLine`（`riDragDropLine` 后）、`riListUnordered`（`riFileListLine` 后）、`riChatHistoryLine`（`riChat3Line` 后）、`riArrowDownSLine`（`riArrowLeftSLine` 后）、`riArrowDownLine`（`riArrowDropDownLine` 后）、`riLoader4Line`（`riLoader2Line` 后）。import 与 provide 两侧数量一致（均 150），CRLF 行尾保持不变。
- agent 面板同时改回原意图标：`riChatHistoryLine`（会话）、`riArrowDownSLine`（下拉小箭头）、`riArrowDownLine`（transcript 箭头）、`riLoader4Line`（转圈）。删除仍用 `riDeleteBin7Line` —— 它是项目既有的删除图标，无须再引入同义的 `riDeleteBinLine`。
- 守卫从「只扫 agent 组件」升级为**全仓 .vue**：递归扫 `src`，凡是 `name="ri…"` 不在白名单即失败并列出文件与图标名。局部守卫当初看不到这 3 处，正是它不够宽的证据。红证 3 条实测（改回未 import 的名字 / 面板错名 / 塞一个不存在的名字，均转红）。
- 体积代价：新增 6 个图标约 +2 KB 未压缩（白名单 144→150，全量 2271 个是 625 KB，未采用）。
验证：`panelUi.test.js` 10 条守卫全绿；改动文件 eslint 0 error；`npm test` 401 tests / 399 pass / 0 fail / 2 skipped；`npm run check:i18n` 通过；`npm run build` exit=0，产物 grep 确认 8 个正确名都在、`riSparklingLine` 已消失。
状态：已清（2026-10-06 完成）

### T-91 — `list_canvas` 把块代码静默截断到 200 字符，模型读不到 JS 块全文

类型：bug（静默降级）+ 新功能（补一个精确读字段的 read 工具）
登记日期：2026-10-06
来源：会话 2026-10-06 用户原话「list_canvas 好像对块的长度会做截断，我在解析 js 注入块的时候读不到全部内容」；触发点 `src/agent/tools/canvas.js:186`
现象：agent 调 `list_canvas` 读画布上的 `javascript-code` 块，只能拿到 `data.code` 的前 200 字符，且**输出里没有任何截断标记**，模型以为那就是全文。
证据：**静态确认（代码位置，未跑浏览器实测）** —— 三道闸门叠加：
① `src/agent/tools/canvas.js:186` `String(n.data.code).slice(0, 200)`，硬编码 200、无标记、无「还有多少字符」的提示；
② 同一处（canvas.js:184-189）只输出 `code` 与 `description` 两个字段，块的其余字段（selector/url/timeout 等）模型完全看不到，连「该去读哪个字段」都无从判断；
③ 第二道天花板 `src/agent/events.js:84 MAX_OBSERVATION_CHARS = 8000`，`wrapObservation` 对所有工具 payload 硬截断（这一层**有** `[truncated: ...]` 标记）。因此单纯把 200 放大到 8000 是错的：画布上有 5 个 JS 块就全体一起被砍，砍的是排在后面的节点，比现在更不可预测。
影响：任何「让助手读/改画布上已有 JS 块」的场景都会踩 —— 模型基于被截断的前 200 字符做修改，`update_block` 合并字段时容易写出半截代码或重复片段；用户看到的是助手「瞎改我的代码」，且无从察觉是截断导致。属于本项目最忌讳的「静默降级」。
建议（分层，推荐 A+B 一起做）：
- **A** `list_canvas` 不再静默截断：输出每个节点的全字段清单 + 各字段字符数，摘要保留但必须带「前 200 字符，共 N 字符，已截断，读全文用 read_block」的标记与指路。
- **B** 新增 read 类工具 `read_block`（group: canvas，ctx: ['editor']），参数 `nodeId` 必填 + 可选 `field` / `offset` / `limit`，按字段精确取全文并支持分页；read 类不过确认门。
- **C 连带**：`canvas.test.js` 的 `canvasTools.length === 3` 要改 4；`index.test.js` 的 TOOLS 名字列表与 ctx 契约表要插入 `read_block`。
- **D 顺手**：`update_block` 回执带写入后 code 的字符数，便于模型自核对。
结论：A+B+C+D 全做（2026-10-06 完成，用户批准「开工」）。落地要点与设计取舍：
- `list_canvas` 改为渲染每个节点的**全部字段**：短值（≤40 字符）直出，`code` 给 200 字符摘要并强制附「共 N 字符 / **已截断** / 读全文用 read_block(nodeId=…, field=…)」，其余长值只报字符数不报内容 —— 清单因此恒定很短，不会被一个块撑爆。
- 新增 `read_block`（read 类，group canvas，ctx ['editor']）：一次只取一个节点的一个字段，天然撞不破 8000 上限；回执带分页头（`共 N 字符，本次 0–7000，后面还有 M 字符`）与续读 offset，读到底时明说「到这里就是全文」。
- **limit 上限取 7000 而非 8000**：分页头/脚注与 untrusted 包装标签本身占字符，顶到 8000 会被 `wrapObservation` 二次截断 —— 模型传了 8000 却只拿到 7900，正是本条要消灭的那种静默降级。下限 200，超范围**报错**不静默夹取（与 `page.js` 的 maxChars 同款哲学）。
- 未跑浏览器实测（工具逻辑纯内存，走单测）：`canvas.test.js` 新增 13 条断言，钉住「摘要必带截断标记」「read_block 必须拿到全文（1240 字符连续比对）」「15000 字符顺着回执 offset 一路读到尾、分片拼回原文且每片 < 8000」「limit 越界报错」「offset 越界报实情而非返回空串」「MAX_FIELD_CHARS < 8000」。
- 文档同步：`docs/agent-architecture.html` 工具表补 `read_block` 行、`list_canvas` 描述改为「只给清单」，三处「13 个工具」改 14，并加一段说明两个读工具为什么必须分开。
验证：`npm test` 416 tests / 414 pass / 0 fail / 2 skipped；prettier 格式化后回归仍全绿；`npm run build` 成功（首次因清空 `build/` 撞删除守卫，按既定做法把 `build/` 挪到 `.scratch/build-old-20261006-0111` 后在空目录重建），产物 `newtab.bundle.js` grep 到 5 处 `read_block`，manifest/html/locales 齐全。
状态：已清（2026-10-06 完成）
### T-92 — 摘要响应未检查 toolCall，pi 有这道防御我们没有（驳回）

类型：bug（防御缺口）
登记日期：2026-10-06
来源：会话 2026-10-06「压缩是否参考 pi、摘要怎么生成」，对照点 `pi/packages/coding-agent/src/core/compaction/compaction.ts:759`（及 turn-prefix 分支 :1111）vs `src/agent/loop.js:567-580`
现象：pi 的 `generateSummaryWithUsage` 拿到响应后会额外检查 `response.content.some(b => b.type === 'toolCall')`，命中即抛错「Summarization attempted to call a tool」。我们的 `requestSummary` 只校验 `stopReason === 'error' / 'length'` 与空文本，不检查响应是否夹带 toolCall 块。
证据：实测——读 pi 上述两处与 `src/agent/loop.js` 的校验段；摘要请求本身不传 tools（`streamFnWithRetry(model, {systemPrompt, messages}, {maxTokens})`），故触发概率低。
影响：BYOK 端点上模型若幻觉出 toolCall 块，我们按 `filter(c => c.type === 'text')` 静默接受，可能落一份形状异常的摘要。与本项目纪律「宁可没摘要，不要错的摘要」不符。
建议：文本抽取前加一条 toolCall 检查并抛错（由调用方降级）；补一条单测——桩返回含 toolCall 的响应，期望抛错。
结论：**驳回（用户 2026-10-06 决定不做）** —— 摘要请求不传 tools，模型返回 toolCall 属极低概率事件，加这道检查的收益低于它带来的代码与测试成本。需求消失时按用户指示整条撤下，保留档案以备「将来接了会幻觉 toolCall 的端点」时重开。


### T-89 — 会话下拉选中后 header chip 仍显示占位文案

类型：bug
登记日期：2026-10-06
来源：会话 2026-10-06 用户原话「agent的会话管理下拉框选择后不会显示为选中会话的标题，还是显示「选择历史会话」，改一下」
现象：从下拉里选中一个会话后，header 的会话 chip 仍然是占位文案「选择历史会话」，不变成那条会话的标题。**同源症状**：下拉里当前会话的高亮底色与勾选图标也一直没有出现。
证据：`AgentPanel.vue` 读 `props.host.currentSessionId`（两处：`:current-session-id` 绑定与 `sessionLabel` computed），而 `agentHost.js` 暴露的字段叫 **`sessionId`** —— `agentHost.js` 全文不含 `currentSessionId` 字符串。于是 `sessions.find((s) => s.id === undefined)` 恒为 `undefined`，`if (!entry) return t('workflow.agent.session.placeholder')` 永远命中占位符；`s.id === currentSessionId` 也恒为 false，高亮与勾选一起失效。
影响：会话切换在界面上「没有反应」—— 实际 transcript 已切换（走 `openAgentSession`），只有 chip 与高亮不动，用户会以为点击无效并反复点。
成因：面板改成 `:host` 整体传参后，属性名与 host 字段名对不上。此类错误的危险在于**不抛错、不告警**，只是一个恒为 `undefined` 的属性。
结论：
- `AgentPanel.vue` 两处 `host.currentSessionId` → `host.sessionId`。host 是 `reactive` 对象经 `Object.assign(agent, {...})` 返回，`props.host.sessionId` 能正常建立响应式依赖。
- 新增守卫「面板只能读 agentHost 真实暴露的字段」：从 `agentHost.js` 的 `reactive({...})` 与 `return Object.assign(agent, {...})` 两处解析出真实字段名（实测 20 个），面板读任何不在其中的字段即失败并点名。该守卫带自我保护：`sessionId` 不在暴露集合里、或解析出的字段数 < 11 时，守卫自身先失败（防止解析写错导致静默空转）。
- 红证：A 把字段改回 `currentSessionId`（即本 bug 原样）→ 红；B 换成另一个不存在的字段名 `sessionz` → 红。另有一次「两侧一起改名」的对照实验转红，原因是守卫的自我保护锚点 `sessionId` 不在了 —— 这是**预期行为**：改动这个字段名必须显式改守卫，不允许悄悄漂移。
验证：`panelUi.test.js` 11 条守卫全绿；改动文件 eslint 0 error；`npm test` 422 tests / 420 pass / 0 fail / 2 skipped；`npm run check:i18n` 通过；`npm run build` exit=0。
状态：已清（2026-10-06 完成）
### T-93 — 摘要请求的 maxTokens 未与模型输出上限取 min（已修）

类型：bug（推断，未实测）
登记日期：2026-10-06
来源：会话 2026-10-06 对照 pi，触发点 `src/agent/compaction.js:124`（`summaryMaxTokens = max(512, round(reserve*0.8))`，默认窗口下 3840）与 `src/agent/provider.js:80`（不设 maxTokens，走端点默认）
现象：pi 是 `maxTokens = min(floor(0.8 * reserveTokens), model.maxTokens)`。我们的 config 没有 maxTokens 字段、provider 不设输出上限，于是摘要请求直接按 0.8×reserve 发。若端点/模型的输出上限低于该值，摘要请求撞上限 → `stopReason === 'length'` → `requestSummary` 抛错 → 本次压缩跳过；预压缩失败只 `log.warn`，等于该配置下压缩系统性不生效，只剩溢出恢复兜底。
证据：静态确认上述两处代码；「某端点上限 < 3840」是推断，未实测 —— 需找低上限端点或用桩造 length 响应证实。
影响：用小输出上限模型（或自定义端点设了保守 max_tokens）的用户，长对话压缩静默失效，表现为更容易撞上下文上限、频繁走溢出恢复。
建议（2026-10-06 讨论后修正）：① 夹绝对上限；② length 的 warn 补上下文；③ 摘要不跟随用户 maxTokens。
结论：**已修（2026-10-06）**。三条建议全部落地：① `compaction.js` 新增导出常量 `SUMMARY_MAX_TOKENS_CAP = 2048`，`summaryMaxTokens = min(max(512, 0.8*reserve), 2048)`——128k 窗口下从 13107 降到 2048，32k 窗口下从 3840 降到 2048；② `loop.js` 的 `runCompaction` 在摘要请求抛错时重新 throw 并带上 `summaryMaxTokens` 与估算 token 数，`compaction.skip` 日志现在能区分「上限过大」与「模型写太长」；③ 摘要走内部常量，不读 config.maxTokens（用户设 512 也不会让压缩整体跳过）。验收：`compaction.test.js` 新增「summaryMaxTokens 恒不超过绝对上限」跨 5 档窗口断言，`loop.test.js` 新增「摘要输出被截断时日志带 summaryMaxTokens」；`npm test` 424 项全绿。原推断（低上限端点导致压缩失效）仍未实测证实，但上限已夹到 2048，触发面大幅收窄。

### T-94 — PROVIDERS 预设不带 contextWindow，默认 32000 对多数模型偏低（已修）

类型：改进
登记日期：2026-10-06
来源：会话 2026-10-06 用户提问「需要设置 maxTokens 和 contextWindow 参数吗」；触发点 `src/agent/config.js:14-58`（PROVIDERS 只有 id/label/baseUrl/models，无 contextWindow）、`src/agent/config.js:69`（默认 32000）
现象：用户选 provider/model 后 contextWindow 不随之变化，恒为默认 32000。而 deepseek-chat、gpt-4o、glm-4-plus、qwen-plus 等实际窗口远大于此（64k~128k 量级）。于是 threshold 恒为 27200，在真实窗口还很宽裕时就开始压缩——多花摘要请求、上下文被无谓缩短。反向（填得比真实大）则压缩永不触发，只剩溢出恢复兜底。
证据：静态确认——`config.js` 的 PROVIDERS 数组无 contextWindow 字段；阈值公式实测（cw=32000 → threshold 27200 / keepRecent 8160）。
影响：所有不手动改这个数字的用户都在「过早压缩」或「永不压缩」的一侧，且无从察觉；这个数字用户本来也不知道该填多少。
结论：**已修（2026-10-06）**。PROVIDERS 每项加 `contextWindow` 建议值（openai 128000 / modelscope 32768 / deepseek 65536 / moonshot 32768 / zhipu 131072 / aliyun 131072；openrouter 与自定义端点不预填——模型名由用户自填、没有表可查），新增导出 `resolveContextWindow(providerId, model)`（支持 per-model 的 `modelWindows` 覆盖，查不到回落默认）。设置页 `SettingsAgent.vue` 在切换 provider 时预填建议值，**且只在用户没手动改过时覆盖**（当前值等于上一处的建议值才算没动过）。验收：`config.test.js` 新增三条断言（按 provider 取值 / 查不到回落默认 / 所有建议值 ≥4096 以免压缩被判为不可用）；`npm test` 全绿。注：这些是官方公开标称值，同模型不同版本/账号档位可能不同，用户可随时改——代码注释与 UI 文案都写明了这点。

### T-96 — 设置页新增「单次回复上限 maxTokens」（已实现，含三件配套）

类型：新功能（用户提议）
登记日期：2026-10-06
来源：会话 2026-10-06 用户原话「在 ai 助手设置中（现在实现了 api 和 key 等功能）加入设置模型参数的功能，可让用户设置 contextWindow 和 maxToken 参数」
现象与诉求：用户希望在助手设置页增加「模型参数」区块，可设置 contextWindow 与 maxTokens。实测现状：`SettingsAgent.vue:47-55` **已有 contextWindow 输入框**，真正缺的只有 maxTokens；且 contextWindow 是裸数字、不随 provider/model 变化（见 T-94）。
证据：静态确认——`SettingsAgent.vue:47-55`、`provider.js:80`（注释记录「曾写死 4096 会让长回答静默截断在半句（stopReason=length）」）、全仓只有 `loop.js:571` 处理 `stopReason === 'length'`（仅摘要请求），**主对话的 length 截断无任何处理**。
建议（三件配套）：① 默认留空 = 不传；② 主对话 length 必须有可见反馈；③ 摘要 maxTokens 不跟随用户值。
结论：**已实现（2026-10-06），三件配套全部落地**。① `config.js` 新增 `maxTokens`（默认 0 = 不传），`validateConfig` 校验「空/0 = 不限制，填了必须 ≥256」；`provider.js` 的 `buildModel` 传 `maxTokens: Number(config.maxTokens) || 0`。② `loop.js` 的 `fromPiEvent` 在 `message_end` 分支新增 `stopReason === 'length'` → SYSTEM_NOTICE（`TRUNCATED_NOTICE`，包 `untrusted_system_notice`），UI 走已有的琥珀色提示条槽位；**优先级放在 toolCall 之前**——参数被截断时不发半截 TOOL_CALL。③ 摘要走 `compaction.js` 的内部常量，不读用户值（见 T-93③）。设置页把 model / contextWindow / maxTokens 收进「模型参数」区块，maxTokens 留空即不限制。验收：新增 6 条断言（config 2 / provider 1 / loop 3），`npm test` 424 项全绿、`npm run check:i18n` 通过（en/zh 同步，并顺手把 contextWindowHint 里「超过它会被裁剪」的旧说法改成压缩语义——原始记录不删除、界面仍可翻看）。
