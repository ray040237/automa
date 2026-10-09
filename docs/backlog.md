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

