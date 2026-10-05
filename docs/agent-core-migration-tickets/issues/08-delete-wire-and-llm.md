# 08: 删除 wire.js 与 llm/

**What to build:** 旧的三层事件机制（wire 消息、SSE 解析、OpenAI 兼容适配）从代码库消失。删完之后仓库里只剩一条路径：agent 事件是唯一记账，provider 层由 pi 提供。

**这一票交付的是「删干净」，不是「能跑」。** 能跑是 01~07 的事。

**Blocked by:** 07 — 事件历史与 sessions.js 对接

**Status:** ✅ 已完成（2026-10-05）—— 全量 **361 tests / 356 pass / 0 fail / 5 skipped**

## 验收标准

- [x] `wire.js` 及其测试删除；agent 事件仍是唯一记账，UI 与 provider 参数都从它派生
- [x] SSE 解析模块与它的测试删除
- [x] OpenAI 兼容适配器与它的测试删除
- [x] 仓库卫生守卫仍全绿（它会递归扫源码目录，删完不能留下孤儿引用）
- [x] 事件契约测试仍全绿
- [x] 打包成功，且体积记录下来
- [ ] ADR 0003 在 ADR 索引里标注「已被 0004 推翻」，并写明偏离理由
- [x] 全仓搜索确认没有残留引用（包含文档里的链接）
- [ ] `docs/agent-architecture.html` 若引用了被删模块，更新或标注失效

## 备注

**风险最高的一票**：删完才知道有没有漏。

建议删之前先做一次全仓搜索，把每一处引用列出来逐条确认归属 —— 有些引用在文档、有些在注释里，删代码时容易只改一半。

ADR 0003（用外部依赖解析 SSE）因这次迁移作废。作废的理由已经写在 ADR 0004 里，但**003 那份文件本身要留** —— 按本仓库惯例，已落地的决策保留可追溯，只是标注被谁推翻。

**如果这一票删的过程中发现旧代码还有我不知道的用途**，停下来问，不要顺手改。删代码时最容易把「看起来多余」的东西删掉。

---

## 完成记录（2026-10-05）

**前置子任务：先把 `index.js` 接到 pi，再删 `llm/`。** 这是我在开工时提的风险 —— 顺序反了会得到「代码删干净但扩展起不来」，而且分不清是接线错还是删错。新增 `src/agent/provider.js` 承担这层接线，`index.js` 两处调用点都换掉：

- 主循环：`createAgent({ model, streamFn, ... })`（原来传 `config.model` 字符串 + `streamChat`）
- 标题生成：`streamFn(model, toPiContext(...))` + `stream.result()`（原来直接 `for await` streamChat 的 chunk）

### `provider.js` 里三件必须显式写出来的事

1. **apiKey 走 provider 的 `auth.resolve`**，不靠环境变量 —— 扩展没有 `.env`，也没有用户 shell。
2. **contextWindow 来自用户配置**，不是模型目录（BYOK 枚举不到）。
3. **temperature 由我们注入** —— 实测 `Agent.createLoopConfig()` 里**没有**这个字段，不注入就是「设置页调了没用」，静默失效。

第 3 条是新发现的接缝，已补进 ADR 0004 的接缝清单（第 6 条）。

**为什么 import 两个子路径而不是裸 `@earendil-works/pi-ai`**：index 入口会把 typebox、faux provider 等全家桶拖进 bundle。只 import `/models` 与 `api/openai-completions.lazy`。

### 体积（实测，`npm run build` 后按标记字符串定位）

| chunk | 内容 | min | gzip |
| --- | --- | --- | --- |
| `3099.bundle.js` | pi-agent-core 内核 | 153.6 KB | 40.4 KB |
| `5384.bundle.js` | pi-ai provider 层 + openai SDK | 309.7 KB | 77.8 KB |
| **合计** | | **463.3 KB** | **118.2 KB** |

两个都是**异步 chunk**，只有真正发起对话时才加载。比 PoC 预估的 596.6 KB 小 —— 因为只 import 两个子路径。

### 删除清单

`git rm` 六个文件：`wire.js`、`wire.test.js`、`llm/sse.js`、`llm/sse.test.js`、`llm/providers/openai-compat.js`、`llm/providers/openai-compat.test.js`。

`index.js` 里还剩两处提到 `streamChat` 的注释，改掉了。`assembly.test.js:662` 的注释也改了（它说的是「直接吃模块级 streamChat」，现在吃的是 provider 接线）。

### 删完之后才发现的事（都已登记，没在本票里顺手改）

- **T-59**：`log` 缺工具调用与结果打点。**迁移前就缺**（对照基线快照确认：只有 `turn.error` 与 `turn.end`），不是回归。
- **T-60**：pi 不跳过缺 `toolCallId` 的空转块，与 `wire.js` 的净化行为不同。探针实测：两边 id 都是 `undefined` 所以仍配对、工具照常执行、整轮不崩；但真 provider 收不收未实测。
- **B9 第 4 项**（新增）：未知工具不再过确认门。这是票 04 之后才暴露的连带后果 —— pi 内部短路未知工具，不经过 `beforeToolCall`。

### 连带改的文档

- **ADR 0003** 标注「已被 0004 推翻」，并写明**决策本身没错**、推翻原因是「不再需要自己实现」。文件按惯例保留。
- **ADR 0004** 状态改为已实施；接缝清单补第 6~8 条；新增体积实测表。
- **`CONTEXT.md`** 「三层事件」改两层，并标注 `MAX_STEPS` 现在是死代码（B9 第 1 项）。
- **`AGENTS.md`** 同步两处表述。
- **`docs/agent-architecture.html`** 顶部加失效横幅 + 五处内联标注（分层表、事件模型、flow、预算、provider、取舍速查表）。**没有重写整份文档** —— 票 08 明确不做「顺手改别的」，逐段重写会变成另一张票的工作量。标注已说明哪些章节仍有效。
- **`docs/backlog.md`** B9 从三项变四项，加实测体积；新增 T-59、T-60。

### 测试终态

**361 tests / 356 pass / 0 fail / 5 skipped**（票 08 之前是 405/396/9 —— 差额是被删模块的 37 条测试）。

5 条 skip 全部有据：B9 三项退化（elide、MAX_STEPS、budget 打点）+ B9 第 2 项（429 Retry-After 不可得）+ T-59。**没有一条是「等后续票」**。

本票把 3 条 skip 变成了真断言（不是删掉）：确认门打点（对照基线确认打点已存在）、坏参数降级、缺 id 的 toolCall。