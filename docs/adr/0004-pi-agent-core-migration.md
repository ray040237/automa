# 0004 — 用 pi-agent-core 替换自研 agent 内核

状态：进行中
日期：2026-10-05
取代：无
相关：`docs/adr/0002-tool-confirmation-classes.md`（确认门分级，本次重构须完整保住）、`docs/adr/0003-sse-parser-external-dep.md`（SSE 解析器，本次可能被推翻）

## 背景

`src/agent` 是自研的 agent 循环：`loop.js`（561行主循环）+ `wire.js`（事件历史 → OpenAI wire messages）+ `llm/sse.js` + `llm/providers/openai-compat.js`（430 行）。三年前者的上游 Automa 不含这部分，是本分支新增的内置 AI 助手。

用户提出用 [`pi`](https://github.com/earendil-works/pi) 的 `@earendil-works/pi-agent-core` 替换这套自研内核。`pi/` 是只读参考仓库（已gitignore，`.gitignore:52-57`），运行时依赖走 npm 装。

## 决策

**换掉循环内核 + provider 层，保留全部产品契约。**

具体边界：

| 保留 | 交给 pi |
| --- | --- |
| `tools/` 的13 个工具定义与 `class: read\|write` 分级 | 循环内核（`loop.js` 的561 行） |
| `confirm.js` 确认门与 ADR 0002 的分级 | provider 层（`llm/sse.js`、`llm/providers/openai-compat.js`） |
| `events.js` 的 10 种事件与 `wrapObservation` | 悬空 tool_calls 净化 |
| `sessions.js`、`config.js`、`index.js` 装配层 | 并行工具执行、truncation 保护、steering 队列 |
| `window.js` 以外的 `untrusted.js`、`prompt.js` 全部 | |

**不做**：token 预算裁剪、步数上限、`ERROR_KIND` 六种分类、429 配额区分。这四项的代价与理由记在 `docs/backlog.md` 的 **B9**。

## 为什么

**实测可行的部分**（PoC 见 `.scratch/pi-poc/`，7 步全通）：

- `pi/packages/agent/src` 无任何 `node:` 导入、无 `process.` 引用，只用 `fetch`/`ReadableStream`/`AbortController` —— 浏览器扩展可跑
- esbuild `platform: browser` 打包通过，内核 165 KB min / **43.8 KB gzip**
- 用 `.env` 的 ModelScope 端点跑通真实 BYOK 链路：流式文本 + 工具调用 + 两轮循环
- 六个核心语义都有钩子且实测生效：确认门（`beforeToolCall`）、步数上限（`finishTurn`）、上下文裁剪（`transformContext`）、错误即观察值、坏 JSON 降级、插话（`steer()`）

**为什么仍然换 provider 层**：pi 的 provider 层带来模型目录、用量统计、缓存亲和，且悬空 tool_calls 净化（`transform-messages.ts:158-186`）比 `wire.js` 完善 —— 它会为孤儿调用插入合成结果，还会把夹在中间的 system 消息暂存到结果之后。

**代价**（用户明知并接受，记在 B9）：完整栈 596.6 KB min（vs 内核+类型层 182.8 KB min，差值是 openai SDK）；`llm/` 下 37 条测试作废；`ERROR_KIND` 降级—— pi 的失败路径上 `diagnostics` 恒为 `undefined`、`onResponse` 对 4xx 一次都不触发，只能对 `errorMessage` 字符串做正则反解。

## 迁移必须写死的三条红线约束

这三条是实测发现的，不是推测。**违反任何一条都是静默失败**。

### 1. untrusted 内容绝对不能进pi 的 system 角色

pi 的 `openai-completions.ts:1677` 默认 `supportsMidConvoSystemMessages: false`，走 `collapseSystemMessages`（`transcript.ts:108-112`）—— **把所有后续 system 消息并进 system prompt 首部**。untrusted 内容一旦走 system 角色，就被永久提升为可信系统指令，比现在的「user 角色 + untrusted 标签」严格更弱。

现状安全：`preStepNotice`（`loop.js:372-385`）与 `drainInstructions`（`:389-406`）本来就是 `role:'user'`（`wire.js:112-117` 有注释记录了这个设计理由）。**迁移时必须继续映射成 `role:'user'`**，pi 的 `UserMessage.content` 允许直接是字符串，不需要凑块数组。

> 注意术语陷阱：`untrusted_system_notice` 这个**标签名**表示「这条事实由系统侧产生」，与「以 system 角色发送」是两件必须解耦的事。

### 2. untrusted 包装必须是单个 text 块

pi 在 `openai-completions.ts:1414-1417` 把 toolResult 内容 `join("\n")`。若把观察值拆成多个块，块间插入换行——**拆分点落在标签内部时闭合标签就断了，内层内容对模型裸奔，不报任何错**。

即：`content: [{ type:'text', text: wrapObservation(...) }]`，不许拆成 head/body/tail。

### 3. 工具返回值必须显式给 `content`

`page.js:236`（`get_variables`）与 `:266/288/299/317`（`get_block_schema`）现在返回**裸字符串**。pi 的 `agent-loop.ts:929` 把没有 `content` 的结果兜成 `[]`，`openai-completions.ts:1422` 发出 `"(no tool output)"`—— **正文和 untrusted 标记一起消失，不报错、不降级、模型只是看不到东西**。

同类的还有 `isError` 必须显式给：pi 的契约是「throw 或 `isError:true`，不要只在 content 里描述失败」（`types.ts:477-480`）。沿用 `{status:'error'}` 而不设 `isError`，模型会把失败当成功读。

## 接缝清单（实测）

1. **`Agent` 无条件覆盖 `getSteeringMessages`**（`agent/dist/agent.js:331`），构造参数里传的会被丢掉。插话只能走 `agent.steer()`。
2. **`tool_execution_start` 在 `beforeToolCall` 之前就发**（`agent-loop.js:378` vs `:493`）。被确认门拦下的工具同样先发 start，UI 需按 `end.isError` 判定是否真执行。
3. **user 消息的 `content` 是内容块数组**（`types.ts:542-546`，也允许字符串）。`window.js:114/125` 的 `m.content.trimStart().startsWith('<untrusted_page_content')` 前缀判定在块数组下必然失效。
4. **pi 无内置步数上限**，得自己用 `finishTurn` 兜（本项目按 B9 不做）。
5. **`beforeToolCall` 的 block 路径产出 error 工具结果**（`agent-loop.js:508`），不是「用户拒绝」这种结构化状态。`TOOL_STATUS.REJECTED` 需在适配层自己编码。

## 回滚

基线快照在 `.scratch/agent-baseline/`（commit `894ec164` 的完整 `src/`，配 `run-baseline-tests.mjs`）。`.scratch/` 已 gitignore，**不在版本库里** —— 重构落地时应把关键断言补成新测试并注明替代了哪条旧断言（见 B9 第 3 项）。

单文件回滚：`git checkout 894ec164 -- src/agent/<file>`。

## 停损点

**连续两个 ticket 出现「说不清是重构引入还是本来就有的问题」时，停下来回滚，重新评估。** 依据：Q11 选择了全部重写测试，重写期间没有回归保护可依靠；基线快照能回答「这里本来对不对」，但它不在版本库里。