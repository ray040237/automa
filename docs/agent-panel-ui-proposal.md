# 助手面板 UI 改进方案（待审核）

> 状态：**已审核并实施（2026-10-05）** —— 用户选定方案 C。下文 §4~§8 是实施前的方案原文，保留作为决策记录；实际落地与两处偏离见文末「实施结果」。
> 触发：会话 2026-10-05 用户提 4 点诉求 —— ① 标签页选择「弹窗改下拉」；② 会话管理并入 header；③ CSS 与项目统一；④ 小空间里怎么放下基础组件，请调研业界做法。

---

## 0. 结论速览

| 诉求 | 与既有登记的关系 | 本方案的动作 |
| --- | --- | --- |
| ① 标签页弹窗 → 下拉 | **已由 T-15 覆盖** | 在 T-15 上**追加设计决定**，不新开条目 |
| ② 会话管理 → header | **已由 T-15 覆盖** | 同上；本方案**部分不同意**「一起放进 header」，见 §4 |
| ③ CSS 与项目统一 | **未被登记** | 新登记 **T-61**、**T-62** 两条 |
| ④ 小空间布局调研 | 部分落在 T-15 / T-12 / T-49 | 本篇给出**量化空间预算**（§5）与业界模式对照（§3） |

**最重要的一条**：调研支持你 #2 的判断（会话管理确实该从输入区搬走），但对 #1 给出了一个更细的结论 —— **页面上下文不必和会话挤在一个 header，它更适合做成输入框上方的「可移除 chip」**。你嫌那个位置「割裂」，根因不是位置，而是那里放了一个原生 `<select>` 行。详见 §4。

---

## 1. 实测现状（本轮亲自核对，非推断的部分）

### 1.1 两个宿主的真实宽度 —— 这是所有取舍的前提

| 宿主 | 容器 | 内容可用宽度 |
| --- | --- | --- |
| 工作流编辑器侧栏 | `[id].vue:10` `sidebar w-80` + inline `padding: 20px`；`sidebarCss.width` 默认 **360**、下限 360（`:441`、`:450`） | **320px** |
| 独立助手页 | `Agent.vue:2` `w-full` | 宽，但**同一份 `AgentPanel` 必须同时适配两边** |

> 即：`AgentPanel` 的设计下限是 **320px**，不是「大概 360」。360 − 20×2 = 320。

### 1.2 标签页弹窗比它的宿主还宽

`AgentTabPicker.vue:5` 的 `content-class=` 写的是 `w-[32rem]`，即 **512px**，而宿主内容区只有 320px。
**用 modal 不是设计选择，是被逼的** —— 这个列表本来就放不进 320px 的下拉，代码作者才去借了 512px 的弹窗。

### 1.3 固定 chrome 占了 220px 竖向空间

按类名逐行推算（**推断，未在浏览器实测**）：

| 区域 | 代码位置 | 计算 | 高度 |
| --- | --- | --- | --- |
| 目标页行 | `AgentPanel.vue:4-22` | `py-2`(16) + 最高子元素 `ui-button h-10`(40) | **56px** |
| 会话行 | `AgentPanel.vue:27-73` | `py-1.5`(12) + `ui-button h-10`(40) | **52px** |
| 输入 form | `AgentPanel.vue:97-125` | `p-3`(24) + `textarea rows=3`(3×24 + `py-2` 16 = 88) | **112px** |
| | | **合计** | **220px** |

`UiButton.vue:5` 硬编码 `h-10`，所以面板里**每一个按钮最低 40px 高** —— 这是 header 撑到 56px 的直接原因。侧栏可见高度约 600px 时，事件流只剩约 340px。

---

## 2. 两个实测出来的 CSS 缺陷（新登记）

### 2.1 `variant="text"` 不是合法 variant → 按钮**完全没有样式**

`UiButton.vue:62-75` 的 variants 表只有两组：

- `btnType="transparent"` → `{ default: 'hoverable' }`
- `btnType="fill"`（默认）→ `{ default: 'bg-input', accent, primary, danger }`

而 `AgentPanel.vue:16 / 57 / 65` 传的是 `variant="text"`，即 `variants['fill']['text']` → **`undefined`**。Vue 的 class 绑定拿到 undefined 就不输出该类，于是这几个按钮**既无底色也无 hover 反馈**（`UiButton.vue:7`）。

命中的是面板上最关键的三个控件：标签页切换（`:15-21`）、新建会话（`:55-63`）、删除会话（`:64-72`）。

> **这就是「会话删除按钮不可见」的根因** —— 不是颜色浅，是它**压根没拿到任何样式类**。

项目里的正确写法是 `btn-type="transparent"`，先例在 `EditorPkgActions.vue:12` 与 `:54`（后者同时用了 `icon`）。

附带一条：这三个图标按钮都**没传 `icon` 属性**，于是走 `UiButton.vue:8` 的 `icon ? 'p-2' : 'py-2 px-4'` 分支拿到 `px-4` 水平内边距 —— 图标按钮被撑成 32px 宽的「文字按钮」外观。

### 2.2 事件流滚动条没走项目约定

项目有现成的滚动条工具类：`src/assets/css/tailwind.css:94-112` 的 `.scroll`（7px）与 `.scroll-xs`（5px），**全仓 30+ 处在用**（`Workflows.vue:7`、`BlockGroup.vue:43`、`UiAutocomplete.vue:6` 等）。

而 `AgentTranscript.vue:5` 是 `overflow-y-auto p-3` —— **没有 `scroll`**，走浏览器默认滚动条；`AgentTabPicker.vue:8` 的 `max-h-[60vh] overflow-y-auto` 同样漏了。

---

## 3. 业界调研（外部证据）

> 方法：直连厂商官方文档取证。`web_search` 在本机无 API key 不可用；
> 浏览器扩展类（Monica / Sider / HARPA / BrowserGPT / Page Assist）与 Slack / Linear / Notion 本轮**未取到证据**，下面不引用。

### 3.1 取到证据的四家

**VS Code / GitHub Copilot Chat**（证据最丰富）
- 会话列表在**顶部**，对话在中，**聊天输入框底部自带一行配置行**：`Session Target, Agent, Language model, Permissions`。<https://code.visualstudio.com/docs/agents/run/chat-view>
- 右上角一个开关在**紧凑模式**（列表嵌在同一面板内，选中即替换对话，**靠返回键退回**）与**并排模式**之间切换。同上链接。
- **悬停 vs 右键分工**：悬停会话 → 置顶 / 归档；**右键** → 删除等更多动作。归档 ≠ 删除：归档可逆、无确认、藏在筛选后；删除不可逆、藏在右键菜单里。<https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions>
- 上下文窗口控件**既显示用量又可管理**：悬停看 token 明细，点击出菜单。同上链接。
- New Chat 是一个菜单（New Chat / New Chat Editor / New Chat Window），不是裸图标。chat-view 链接。

**Cursor**
- **「Projects live in the left-hand nav」** —— 更大作用域的上下文是**导航项，不是 chip**。<https://cursor.com/docs/agent/projects>
- **「Once it has at least one, a Listening pill appears above the chat input. Click it to see every event... Remove a subscription from the same list.」** ← 这是与 Automa 那个「悬在输入框上方」控件**最接近的已发表同类设计**。同上链接。
- 上下文环在输入框旁，点击展开明细托盘；模型选择器在**聊天输入框顶部**而非 header。<https://cursor.com/docs/agent/prompting>

**Claude.ai**
- 左侧栏 recents；**悬停行 → ⋮ → 重命名 / 删除**，删除需**二次确认**。<https://support.claude.com/en/articles/8230524-delete-or-rename-a-conversation>
- Projects 是**独立界面**；把对话移进项目用「对话名旁边的下拉箭头」→ 弹窗选择器。<https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects>

**ChatGPT**
- 每个对话一个 **••• 菜单** → 删除（需确认）或归档，且明确「归档**不需要**确认」。<https://help.openai.com/en/articles/8809935-deleting-and-archiving-chats-in-chatgpt>

### 3.2 四家共同的结论（这是最硬的一条）

> **破坏性删除永远是 2 步以上，且从不与「切换」共用同一次点击。重命名 / 归档 / 删除一律住在「悬停 ⋮」或「⋯」里，从不作为独立常驻按钮。**

这条直接印证了 §2.1 —— 现在那个常驻的裸垃圾桶按钮，**在四家产品里都不存在**。

### 3.3 标准

- WAI-ARIA APG Menu Button 模式：opener 带 `role=button` + `aria-haspopup=menu`，切换 `aria-expanded`，Enter/Space/↓ 可开。<https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/>
- Popover API 已是 **Baseline 2025**：top layer，能逃出 `overflow:hidden`，自带 light dismiss。<https://developer.mozilla.org/en-US/docs/Web/API/Popover_API>

---

## 4. 四种布局模式对照，以及我的推荐

| | 形态 | 常驻成本 | 优点 | 缺点 |
| --- | --- | --- | --- | --- |
| **A** | 双行 header（会话一行 + 页面上下文一行，都带 ▾） | 56px | 两个状态永远可见，零弹窗 | 320px 下**两个标题都被截到约 4 个词**；双行本身就是你想逃离的「挤」 |
| **B** | 单行 header：`[🌐 页面标题 ▾] … [＋] [⋯]`，会话列表收进 ⋯ | 40px | 省得最多 | 同一行两个语义；但因两者**各点各的**，歧义其实很轻 |
| **C** | **会话占 header**，页面上下文做成**输入框上方的可移除 chip**（点 chip 开 popover，`✕` 解除） | 40px + 28px | 两个问题都有**逐产品引用**；chip 在「发送」这个决策点上回答「我在读什么」；无 tab 时整行折叠 | 仍占输入区上方那块 |
| **D** | 全面板接管式列表（点标题滑出覆盖层，就地替换对话，带返回键） | 折叠时 0px | 唯一能让 30+ 条列表在 320px 下真正可读；回收所有 header 行 | 切换时看不到对话；代码更多 |

### 推荐：C，但按 Automa 的约束微调

选 C 的理由：
1. **两个问题都有逐产品引用**，只有 C 同时满足「上下文在哪」与「会话在哪」都有先例；
2. **§1.1 的 320px 是硬约束** —— A 的两个标题会同时被截断到约 4 个词，这是调研自己给 A 列的反对理由；
3. 上下文 chip 放在**发送决策点**上，比放在 header 更强：你正要问「这个列表怎么抓」，chip 正好在那里回答「我读的是这个页」。Cursor 的 Listening pill 正是这个位置。

**与你原提案的唯一分歧**：你希望「两者都做在 header」（= B）。我建议页面上下文留在 header 之外。

但要说清楚 —— **你现在觉得那个位置「割裂」，根因大概率不是位置，是控件形态**：那里放的是一整行**原生 `<select>`**，选项只有标题、没有时间、当前项靠追加「（当前）」这种字符串后缀来标记（`AgentPanel.vue:218-224`）。
换成一个真正的 chip（favicon + 截断标题 + `✕`，点击开列表）之后，同样的位置观感完全不同。

> **如果你仍偏好两者都在 header（方案 B）**：我照做，改动量更小、省 68px，调研也支持 —— 只是要接受两个标题在 320px 下互相挤压。**这一条请你拍板。**

### D 作为升级路径

会话数超过约 10 条时再上 D —— 一个开关在 header-rail 模式与接管模式间切换，正是 VS Code 紧凑 / 并排的做法。**现在不做。**

### 4.1 两个方案的共同决定（无论 A/B/C 都成立）

1. **杀掉 512px 的 modal**，改成 `UiPopover` 下拉。项目已有 tippy 封装的 `UiPopover.vue` + `UiList` / `UiListItem` / `v-close-popover`，**14+ 处在用**，先例见 `Workflows.vue:40-64`、`workflows/index.vue:17-47`。**零新依赖。**
2. **删除收进会话列表行的悬停 ⋮**，绝不与「切换」共用一次点击 —— 落实 §3.2 那条四家共识。二次确认的 `dialog.confirm` 已在 `agentHost.js:179-196` 接好，**沿用，零改动**。
3. **新建会话保留一级直连按钮**。VS Code 的 New Chat 是三选一菜单，但那是因为它有多个落点；浏览器扩展只有一个，不需要。
4. **标签页列表加过滤输入框** —— T-15 已登记「标签页一多只能滚动翻」。
5. **窗口标题改成可读文案** —— T-15 已登记「窗口 2 / 窗口 3 对用户没有意义」。

---

## 5. 改造后的空间预算

| | 当前 | 方案 B（都在 header） | 方案 C（推荐） |
| --- | --- | --- | --- |
| 目标页行 | 56px | — | — |
| 会话行 | 52px | — | — |
| header | — | 40px | 40px |
| 上下文 chip | — | — | 28px |
| 输入 form | 112px | 112px | 112px |
| **固定 chrome** | **220px** | **152px** | **180px** |
| **净节省** | — | **68px** | **40px** |

（三者均未计入 T-12 的 autoresize —— 本方案不碰输入框高度。）

---

## 6. 与既有 backlog 的关系（避免重复登记）

- **T-15**（会话选择器与标签页弹窗的信息密度）已覆盖诉求 ①② 的绝大部分。本方案对它做两件事：**追加**用户明确的设计决定（标签页也走下拉、会话管理并入 header），以及**把「会话改 popover 列表」细化成 §4.1 的具体菜单结构**。
- **T-08**（目标页条缺 favicon / pin 态 / 失效态）不重复。本方案只保证 chip 有承载位，不实现 T-08 的内容。
- **T-12**（输入框固定三行、无长度上限）不重复。本方案不碰 autoresize。
- **T-13**（缺 aria-live / 状态只靠颜色）不重复，但方案 C 新增的 popover / menu 应当按 WAI-ARIA APG Menu Button 模式实现，属 T-13 的自然延伸。

---

## 7. 本轮新登记的 backlog 条目

- **T-61**（bug）`variant="text"` 不是 `UiButton` 的合法 variant，三个关键按钮因此完全没有样式 —— 即「会话删除按钮不可见」的根因。
- **T-62**（改进）事件流与标签页列表的滚动容器漏加项目现成的 `.scroll` / `.scroll-xs`，走浏览器默认滚动条。

两条都是低风险、可独立验证的纯样式修复。

---

## 8. 审核通过后的开工顺序

每步收尾跑 `npm run build` 重建产物（用户装进浏览器的是 `build/`）。

1. **T-61 + T-62**（纯样式，低风险，先单独验证视觉是否立刻改善）。
2. 抽 `AgentTabPicker` 的列表内容为**无容器组件**，`UiModal` 与 `UiPopover` 两种外壳共用；`openPicker()` 的空列表预检逻辑（`AgentPanel.vue:230-247`）保持不变。
3. 按 §4 拍板的方案改造 header；**`AgentConfirmCard` 必须继续留在 `AgentPanel.vue` 内** —— 它靠 `onBeforeUnmount` 拒绝挂起的确认门（`:191-193`，T-02），一旦搬家就会重新引入「助手卡死」。
4. 新文案同步 **11 个 locale** 文件（`src/locales/` 下 en/es/fr/it/pt-BR/tr/uk/vi/zh/zh-TW 等），跑 `npm run check:i18n`。
---

## 9. 实施结果（2026-10-05，方案 C）

### 落地了什么

| 方案 | 实施 |
| --- | --- |
| header 收成会话 chip ＋ ＋ ＋ ⋯ | 已做。`AgentPanel.vue` 重排，新建与「更多」用原生 `<button class="hoverable">`（先例 `[id].vue:97-110`），不再走 `UiButton` |
| 标签页选择：512px modal → popover | 已做。列表抽成无容器的 `AgentTabList.vue`，`ui-modal` 整条删除 |
| 会话列表 → popover | 已做。新增 `AgentSessionList.vue`，文案复用 `sessions.js` 的 `sessionOptionLabel` |
| 删除收进「⋯」菜单 | 已做。二次确认沿用 `agentHost.js:179-196` 已有的 `dialog.confirm` |
| token 用量搬进「⋯」 | 已做 |
| T-61 / T-62 | 已做，均移入 `backlog-done.md` |

### 两处偏离（有意为之，不是漏做）

1. **没有保留 modal 外壳。** §8 第 2 步写的是「抽列表、`UiModal` 与 `UiPopover` 两种外壳共用」，那是为迁移期准备的。`AgentTabPicker` 的 modal 全仓只有面板一个调用方，没有第二个消费者，所以直接删掉、不留死代码。
2. **chip 上没有「✕ 解除」。** §4 的形态描述里带了这个按钮，但 `resolveTargetTab` 永远会解析出一个目标页（pinned → lastAccessed → 当前窗口 → 其他窗口），**运行时不存在「无目标」这个状态** —— 硬加解除按钮等于造一个底层不支持的假状态。真要做「不绑定任何页」，得先改 `tab.js` 的解析策略，那是独立决策。

### 空列表的行为变了

原来 `openPicker()` 会先预检 `listTabs()`，为 0 就不开弹窗只发 toast。换成 popover 后弹窗由 tippy 驱动、在预检之前就开了，所以改成：**照样显示列表自带的空态文案**（比 toast 具体得多：「请先打开一个普通网页（扩展页和 chrome:// 内置页读不了）」），**同时**发 `no-target` 保留原有 toast。两个宿主的 `no-target` 接线一行没动。

### 仍挂着（在 T-15 里，未做）

- 标签页列表的搜索/过滤输入框。
- 窗口分组标题的可读文案（现在仍显示内部 `windowId`）。
- T-08（favicon / 固定-自动态 / 失效态）、T-12（输入框 autoresize）、T-13（aria）均未触碰。

### 验收

- `npm test` **373 pass / 0 fail**（新增 `src/agent/panelUi.test.js` 5 条接线守卫）。
- **红证已实测**：把 `variant="text"` 塞回面板 → T-61 守卫 fail；去掉事件流的 `scroll` 类 → T-62 守卫 fail；各自还原后全绿。
- `npx eslint` 对改动文件 **0 error**；`npm run check:i18n` 通过；`npm run build` exit=0。
- 产物已 grep 确认：`build/newtab.bundle.js` 含新接线与 `session.more` / `session.empty`，**不含** `w-[32rem]`，`currentLabel` 已随 key 一并删除。

### 一处需要你亲自验的

> **这段已被下一节取代** —— `content-full` 那套 `UiPopover` 接线在实测中被换掉了。


`content-full` 这个类不是猜的 —— 它是 `UiPopover.vue:152` 自带的规则（`.ui-popover.content-full .ui-popover__trigger { width: 100% }`）。没有它，trigger 容器是 inline-block 宽度自适应，按钮里的 `truncate` **不会生效**，长会话标题会直接顶出 320px 的面板。所以会话那个 popover 加了 `content-full min-w-0 flex-1`。**这一条只有装进浏览器才看得出来，请顺手确认长标题会省略而不是撑破。**

---

## 10. 第二轮：换掉 UiPopover（2026-10-05，用户装 build/ 实测后）

用户实测报三条：① 会话下拉顶出侧栏、压到新建/删除按钮；② 删除按钮与底色同色看不见；③ chip 点开后把面板撑开。

**三条同根**：`UiPopover` 用 tippy 把内容挂到 `document.body` 自行定位，脱离 320px 这道宽度约束。新增 `AgentDropdown.vue`（留在本列、`absolute`、显式字色）替掉面板内全部三个下拉；`UiPopover` 本身不动。

- 会话 `align=left side=bottom w-72`；「⋯」`align=right side=bottom w-56`；chip `side=top`（贴底，往下会被视口截断）
- 两个 header 下拉互斥；选完/删除后立即收起

**新增教训（比代码更值钱）**：源码文本守卫**会被注释骗**。本文件第一版守卫把 `w-[32rem]`、`side="top"`、`text-gray-800` 写进解释性注释后照样匹配 —— 守卫对着注释自说自话，真改坏代码反而测不出来。现已加 `stripComments()`（剥 `<!-- -->` 与 `/* */`）并应用到全部 9 处 `read()`。红证 5 条已实测，其中「只改注释」必须保持 green。

**再说一次构建纪律**：后台 build 期间改源码 → 产物是旧的（本轮第二次犯）。改完必须重建，并用 `grep` 特征串验证产物。

验收：`npm test` 385/380 pass/0 fail（7 条守卫）；eslint 0 error；`check:i18n` 通过；build exit=0，产物已 grep 验证。
