# AGENTS.md

Automa 分支版：上游 [AutomaApp/automa](https://github.com/AutomaApp/automa)（浏览器工作流自动化 Chrome/Firefox 扩展）+ 本分支新增的内置 AI 助手（`src/agent/`）。Vue 3 + Webpack 5，无 TypeScript，`node_modules` 已就位。

改这块代码前，先读这三处——它们记录的是代码里查不到的「为什么」：

- **`CONTEXT.md`** —— 领域术语表与**禁用词**。事件三层（provider 事件 / agent 事件 / wire 消息）、会话-轮-步、targetTab / pin、工具分级等概念都以这里为准；代码里的命名、注释、文档与此不符时，以这里为准。
- **`docs/adr/`** —— 已落地的架构决策（0001 助手独立入口、0002 工具确认门分级、0003 SSE 解析器用外部依赖、**0004 pi-agent-core 迁移**）。动手前先看有无相关 ADR，避免把有实测依据的偏离「纠正」回旧方案。
- **`src/agent/*.js` 文件顶部注释** —— 每个模块头部写着它的契约和踩过的坑（例如 `agentHost.js` 必须用 `reactive`、`index.js` 的工具注册契约）。改这些文件先读它的头。

## 红线

以下四条是硬约束，违反即视为缺陷，不论当前任务是不是它：

- **agent 永不保存工作流。** 助手只允许改内存画布并置 dirty（`onCanvasChanged`），保存动作由用户自己点。`saveWorkflow` / `workflowStore.update` 出现在 agent 可达路径上即是违规（G5）。
- **第三方内容一律 untrusted 包裹。** 页面正文、工具返回、用户输入回显进 prompt 前必须包 `<untrusted_*>` 并做逃逸清洗；新增标签必须登记进 `UNTRUSTED_WRAPPER_TAGS`（当前 7 个，被测试钉死）。
- **工具必须显式声明 `class: read | write`。** 缺失或未知一律走确认门，`validateTools` 在模块加载期就 throw，不存在「默认放行」。改工具特权前查 `docs/adr/0002`。
- **`/pie-ai-agent` 与 `/pi` 只读。** 两个第三方参考仓库（各 1.6 万 / 2 万文件，均已 gitignore），只在本机翻阅汲取机制：不改动它们，也不把实现搬进 `src/`。`pi` 的运行时依赖走 npm 装 `@earendil-works/pi-*`（见 `docs/adr/0004`）。

## 命令与本机坑

命令以 `package.json` scripts 为准（`npm run <script>`）。几个查不出来的坑：

- 测试：`npm test` 跑 `src/agent/**/*.test.js`（node:test + `utils/test-loader.mjs`）；`npm run test:dom` 跑 `.agent-test/dom.test.mjs`，需要本机 Chrome 与 playwright harness。
- **构建会先清空 `build/`**：在 agent 通道里单轮删除超过阈值会撞文件安全守卫而失败。构建因删除失败中断时，**把 `build/` 重命名挪开**，在空目录重新构建，不要反复重试同一命令。
- **新增依赖可以直接装**（2026-10-05 实测推翻旧结论）：`pnpm add <pkg>` 与 `pnpm install` 在 agent 通道均能跑通，链接阶段不再触发守卫。若某个包仍装不上，把命令交给用户自己跑。**装完必须验证产物完整性**——本机曾出现 `pi/` 里`openai@7.19.0` 的 ESM 产物（`*.mjs`）整体缺失、只剩 CJS 的情况，`package.json` 的 `exports` 指向一个不存在的文件，从npm 装则正常。判据：`(Get-ChildItem <pkg> -Recurse -Filter *.mjs).Count` 与 `exports["."]` 指向的文件是否存在。
- 提交前：`npm run lint`（simple-git-hooks 已挂 lint-staged）。动了多语言文案顺手跑 `npm run check:i18n`。

## 工作方式

- **实测优先。** 结论要么带实测输出，要么明确标注是推断。拿推测冒充结论在本项目是最严重的错。
- **不静默降级。** 测试里不允许吞失败（`|| 0` 式兜底、catch 之后继续断言，等于没写）。宁可报错，也不要「看起来成功、实际什么都没做」。
- **控制在当前范围内。** 改动要有断言覆盖；范围外的想法走下一节的登记流程，不顺手实现。
- **收尾写日志。** 有实质改动时，追加当日 `.workbuddy/memory/YYYY-MM-DD.md`（append-only，写结论与影响，不复述过程）。

## 发现即登记

对话过程中出现下面三类信号，**先登记到 `docs/backlog.md`，等用户审核批准后再写第一行代码**：

| 信号 | 例子 | 要求 |
| --- | --- | --- |
| **bug** —— 读代码、跑测试、调试时发现的实际缺陷 | 「这里 `events` 是首轮快照，晚到的回写会覆盖第二轮」 | 登记 + 当场口头告知用户；涉及安全或数据丢失的，立即停下手上无关操作来确认 |
| **改进** —— 用户提到某个现有行为不好、希望变好 | 「这个确认弹窗太频繁了」「侧栏宽度每次都要重新拖」 | 记录用户原话 + 现象 |
| **新功能** —— 用户或我提出的新想法 | 「以后想让它支持 X」 | 一条一个想法，写清诉求和它要解决的真实场景 |

登记步骤：

1. 追加一条到 **`docs/backlog.md`** 的「待审核」区，编号顺延（`T-01`、`T-02`…），套用该文件顶部的模板。
2. **必填**：标题、类型、登记日期、来源（会话日期 + 用户原话，或触发它的 `文件名:行号`）、现象、**证据**（实测输出或代码位置——没证据就明写「推断，未实测」）、影响面（谁在什么情况下会踩，最坏结果）。
3. **选填**：建议方案与各自代价。拿不准就留空交用户判断，不要猜一个混过去。
4. 在当轮回复末尾列出本次会话新增的登记项（编号 + 一句话），然后停在这里。**不要开始实现。**

状态流转：`待审核` → 用户审核 → `已批准（待排期）` / `驳回（附理由）` → 开工时改为 `进行中` → **完成后整条移入 `docs/backlog-done.md` 并补一行 `结论：`**。

不许做的事：**口头知道但不记录**；把多个发现挤成一条；用户还没明确批准就「顺手一起改了」。

> 编号分工：两个文档分工记 —— **`docs/backlog.md`** 放**未完成**的条目（T 编号 = 会话捕获的一切 bug / 改进 / 新功能，全仓库范围；B 编号 = 内置助手功能自身的已知欠账，原 `agent-backlog.md`，2026-10-04 并入，沿用原格式与编号）。两区不混写。**`docs/backlog-done.md`** 是已完成条目的档案（2026-10-05 从 backlog.md 拆出），保留完整的现象、实测证据与结论，只用于追溯，不是待办。

## Agent skills

工程流水线（`/grill-with-docs` `/to-spec` `/to-tickets` `/implement` `/triage` 等）的配置在 `docs/agents/`。

### Issue tracker

本地 markdown —— spec 与 tickets 在 `docs/<feature>-spec.md` 与 `docs/<feature>/issues/`（进版本库）；一次性探针脚本、基线快照等过程材料在 `.scratch/`（已 gitignore）。**结论与实测数据必须进版本库**，否则换机器就丢。见 `docs/agents/issue-tracker.md`。

### Triage labels

默认五档：needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix。本仓库用 `Status:` 行记录，不用 GitHub label。与上面 `docs/backlog.md` 的「待审核 / 已批准」是两套东西。见 `docs/agents/triage-labels.md`。

### Domain docs

single-context。**术语表叫 `CONTEXT.md`，不叫 `GLOSSARY.md`** —— 标准 skill 模板让读后者，读不到时不要新建，直接读前者。ADR 在 `docs/adr/`（0001~0004）。见 `docs/agents/domain.md`。
