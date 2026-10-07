# eval —— 助手轻量回归集（对应 B4）

把原来散在 `.agent-test/*.mjs` 的 5 个 live 冒烟脚本，收成一套**按 pi API 重写**的
固定任务集：改 prompt / 换模型后一键回归，不用再逐个手跑。

> 背景：那 5 个旧脚本（`agent-live` / `live-assembly` / `live-p3` / `live-tabs` /
> `live-memory`）在 ADR 0004（pi-agent-core 迁移）后**全部 import 失败** —— 它们
> import 的 `src/agent/llm/providers/openai-compat.js` 整个目录已删。见 `docs/backlog.md`
> 的 T-140。本目录是它们的替代品。

## 跑法

```bash
npm run test:eval                      # 跑全部（需要仓库根有 .env）
npm run test:eval -- --list            # 只列任务，不跑（不需要 .env）
npm run test:eval -- --only=agent/chat
npm run test:eval -- --only=agent/chat,agent/tool-loop
npm run test:eval -- --model=Qwen/Qwen2.5-72B-Instruct   # 换模型对比
npm run test:eval -- --base-url=https://... --api-key=sk-...
```

这些任务**打真实 API**，故不塞进 `npm test`（与 `test:dom` 同理单列命令），也不进 CI。

## `.env` 约定

仓库根放 `.env`（已被 `.gitignore` 挡掉），三个键：

```
modelscope_url=https://api-inference.modelscope.cn/v1/
modelscope_api_key=sk-...
modelscope_model=deepseek-ai/DeepSeek-V4-Flash-0731
```

`env.mjs` 是唯一读它的地方。配置形状只有**一套运行时扁平配置**（`agentConfig`：
`provider/baseUrl/apiKey/model/temperature/contextWindow`），`createPiProvider` 与
`resolveActiveConfig` 的产物一致；装配层写盘另用 `configDoc()` 造 v2 多连接文档
（`saveConfig` 从 T-97 起收 `{providers[], activeProviderId, ...}`）。

## 判据分级（`harness.mjs` 的 `makeCheck`）

| 级别 | 含义 | 影响退出码 |
|---|---|---|
| `hard` | 硬断言（工具没被调用、401 归类不对、焦点没切过去） | 不符即 FAIL |
| `soft` | 措辞类断言（模型换个说法，如「14」vs「十四」） | 只记 WARN |
| `skip` | 本轮没验证（撞额度/限流、网关不回传 usage） | 记 SKIP，不算失败 |

退出码：有任何 `hard` 失败或任务抛异常 → 1；否则 0。**唯一会自动判 SKIP 的错误是
429/限流**（`skipIfRateLimited`）——免费额度下这是常态，不是回归；别的错误照旧 FAIL，
不静默降级。

## 任务清单

每任务一个 `.mjs`（default export `{id, title, layer, run}`），在 `tasks/index.mjs`
按顺序登记。`layer` 决定走哪条链路：

- `loop` —— 直接 `createAgent` + `createPiProvider`（生产 loop 层）。
- `assembly` —— 走 `createAgentRuntime`（Agent.vue 真正调的那个，含 facts/落盘）。

| id | layer | 覆盖 |
|---|---|---|
| `assembly/config` | assembly | 配置写盘 → 解密读回（不需模型，最便宜） |
| `agent/error-401` | loop | 假 key → 401 → `errorKind=provider` |
| `agent/chat` | loop | 纯流式对话收尾 |
| `agent/tool-loop` | loop | read_page 闭环 + `untrusted_page_content` 包装 |
| `agent/tool-args` | loop | 带参数工具 args 送达不丢 |
| `agent/confirm-reject` | loop | 确认门拒绝（write 工具未执行） |
| `agent/memory` | loop | 多轮记忆（`initialHistory` 续接） |
| `agent/usage` | loop | 网关 usage 回传（缺则 SKIP） |
| `agent/interjection` | loop | 任务中插话被采纳 |
| `agent/title` | loop | LLM 会话标题非空 |
| `agent/tabs-crosspage` | loop | 跨页 `list_tabs → focus_tab → read_page` |
| `assembly/chat` | assembly | 整条链路纯对话 |
| `assembly/tool-page` | assembly | read_page 闭环（真 content script 桩文本） |
| `assembly/multiturn` | assembly | 多轮落盘续接 + 会话索引 |

## 加一条任务

1. 新建 `tasks/<名>.mjs`，default export `{id, title, layer, run}`。
2. 在 `tasks/index.mjs` import 并放进数组（顺序即执行顺序）。
3. `run(ctx)` 里可用的东西（见 `runner.mjs` 的 `ctx`）：`config` / `configDoc` /
   `check` / `makeAgent` / `createPiProvider` / `toPiContext` / `setupAssembly` /
   `defaultFacts` / `skipIfRateLimited` / `textOf` / `toolResultsOf` / `toolCallNames` /
   `AGENT_EVENTS` / `TOOL_STATUS`。

写任务时注意（都是 pi 迁移后新增的硬约束）：

- **自定义工具必须声明 `ctx`**（如 `ctx: []`），write 类还要带 `confirmDetail`
  （T-133 / T-134，`validateTools` 在加载期抛错）。
- **loop 层的 `makeAgent` 是 async**（内部要 `await createPiProvider`）。
- 用**真实工具**（如 `tools/page.js`）时，`toolCtx` 要备齐该工具 `ctx` 声明的键。

## 限额与稳定性

- 免费额度下 429 是常态：任务会 SKIP 而不是 FAIL。全量跑出现多条 SKIP 属预期。
- 部分任务依赖模型能力（多轮记忆、插话采纳），弱模型下可能 WARN/FAIL —— 措辞类
  断言的已降成 soft；「跨轮记忆链路是否通」仍记 hard（那是代码路径，不是措辞）。
- 旧脚本里「观察 provider 原始 tool-call 分片」的诊断已删除：分片解析归 pi 内部，
  我们侧不再有观察对象。