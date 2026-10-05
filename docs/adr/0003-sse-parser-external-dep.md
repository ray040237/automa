# 0003 — SSE 分帧采用 eventsource-parser,不手搓状态机

日期:2026-10-03(决策实际发生在 openai-compat.js 首版,本 ADR 追认)
状态:**已被 ADR 0004 推翻（2026-10-05）** —— 曾实施,现已随`src/agent/llm/` 一并删除
关联:~~`src/agent/llm/sse.js`~~（已删）、docs/agent-assist-tech-design.md §5.3（已失效）

> **本 ADR 作废,但文件保留。** 按本仓库惯例,已落地的决策保留可追溯。
>
> **为什么被推翻**：本 ADR 的全部前提是「我们自己实现 provider 层」。迁移到
> `@earendil-works/pi-agent-core`（[ADR 0004](0004-pi-agent-core-migration.md)）后，
> SSE 分帧由 pi-ai 的 provider 层负责 —— `openai-completions.js` 直接用 openai SDK，
> 它的流解析在 SDK 内部，`sse.js` 与 `eventsource-parser` 这个依赖都没有存在的位置了。
>
> **决策本身没有错**：它当时的判断（「分帧的每个边界漏掉都只静默丢消息，不报错」）
> 今天依然成立，只是这个风险转移给了上游，本仓库不再自己承担。**推翻的原因是
> 「不再需要自己实现」，不是「当初判断错了」。**

## 背景

技术方案 §5.3 要求"移植 pie 的 sse.ts 47 行,零外部依赖"。pie 的实现是手写逐行切分状态机。实施时发现手搓分帧必须自己处理:TCP 分包边界切断一行、CRLF、结尾无空行的残流、多行 data——这些边界漏掉任何一个都**不报错,只是静默丢消息**。

实测还发现一个具体边界:eventsource-parser 对"结尾没有空行"的残流不发事件(网关并不总是规矩补空行),所以 sse.js 在收尾时自己补一个 `\n\n` 边界把残流逼出来——分帧仍全部由库负责,这层兜底只有 5 行。

## 决定

1. 分帧交给 `eventsource-parser`(`createParser`),自研只保留回调式 parser → AsyncGenerator 的薄壳与"残流补边界"兜底(sse.js,约 130 行含注释)。
2. 网关噪声行(JSON.parse 失败)在 provider 层跳过而非炸流,与分帧无关,维持原方案。

## 被拒备选

- **手搓状态机(方案原文)**:47 行省一个依赖,但每个遗漏边界都是静默丢消息;为"零依赖"目标付出的验证成本(要构造分包/CRLF/残流的完整用例矩阵)远超依赖本身的维护成本。依赖为纯解析、无传递依赖、MIT。

## 已知欠账

无。
