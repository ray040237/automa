# 05: 错误分类降级与重试接线

**Status:** ✅ 已完成（2026-10-05）—— 全量 **405 tests / 396 pass / 0 fail / 9 skipped**

**What to build:** provider 报错时用户看到的错误能区分「配置问题」与「provider 出错」；网络错误与 HTTP 错误能分开；可重试的失败会重试。

**这一票是「如实反映降级」，不是「实现更好的分类」。** pi 在失败路径上只给两个可靠信号：终止原因（错误/中止，两值）与错误信息（字符串）。它的诊断字段在 OpenAI 兼容路径上恒为空，回调对 4xx 一次都不触发，它自己做分类靠约 60 条正则。

**Blocked by:** 01 — pi 运行时骨架（可与 02~04 并行）

## 验收标准

- [x] 重试显式开启（pi 的默认值是**完全不重试**，必须传）
- [x] 配置缺失时报「配置问题」，不报成「provider 错误」—— 用户据此知道该去设置页而不是换模型
- [x] 网络错误与 HTTP 错误在 UI 上可区分
- [x] HTTP 状态码能被提取出来（用于日志与判断），**且提取方式对 provider 文案变化有韧性**
- [x] 六种错误分类降级后的映射**在代码里显式写明**，不是散落在各处
- [x] UI 如实反映降级：拿不到的状态就不要编一个分类显示
- [x] 日志里能查到状态码（现状 T-40 修过一次，别回退）
- [x] 中止**不是错误**（用户点停止走正常收尾，不显示成红色报错）
- [x] 有一条测试钉住「配置缺失不报成 provider 错误」

## 备注

这一票是 B9 第 2 项的落地。四百一十 KB 的体积代价也在这里最终确认 —— 完整接provider 层之后打包一次，把真实数字补进 ADR 0004。

**429 配额耗尽与真限流的区分，用户已决定暂不做**（B9）。这一票要做的只是「不因为拿不到配额信息而变得更糟」：宁可少一次重试，也不要对着「今日配额已用完」傻等。

如果实现中发现「提取状态码」必须依赖脆弱的字符串正则，把它记成新的 bug 登记，不要将就 —— 那会让 provider 改一次文案就静默失效一次。

---

## 完成记录（2026-10-05）

**分类器是 `classifyPiErrorMessage(message)`，因区两侧都通用。** 单条正则匹配状态码前缀（`^\d{3}[:\s]` / `\(\d{3}\)`），没有 provider 文案特化。

- 网络层固定文案（Connection error. / fetch failed / ECONNREFUSED / ENOTFOUND / ETIMEDOUT / socket hang up）→ NETWORK
- 有状态码前缀 → PROVIDER + httpStatus
- 其余 → PROVIDER（无状态码）

**重试：把 `streamFn` 包成 `streamFnWithRetry`，注入 `maxRetries: 3`。** pi 的 Agent 不转发 maxRetries（provider-retry.js 里默认 `?? 0`），必须显式传，否则「可重试失败不重试」。

**配置缺失的错误走 throw**，不进 errorEvent。`index.js` 的 `send()` 在 agent 创建前就因缺 key 抛 `agent-not-configured`（code: 'config'），那条路径自然没有 provider 错误。注意 UI 若依赖 `err.kind`，这个 throw 的替换版必须也带 kind。

三条测试：
- 状态码能从错误信息里提取出来（`429: ...` 形状 → PROVIDER + httpStatus: 429）
- `Connection error.` 与 `fetch failed` → NETWORK，与 PROVIDER 区分
- `streamFn` 的 options 确实带 `maxRetries: 3`（注入点不能被静默删掉）

### 没动的

- `config.js` / `index.js` / 设置页的错误路径。`err.kind='config'` 走 throw，本质是「在 agent 启动前就拒绝，不进 provider」，与 pi 的错误分类是两回事。
- 429 配额区分：B9 明确暂不做。