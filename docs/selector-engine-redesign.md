# 选择器引擎重构方案 (RFC)

| | |
|---|---|
| 状态 | **待审核** |
| 分支 | `feature/offline` |
| 相关代码 | `src/utils/FindElement.js`、`src/content/handleSelector.js` |
| 引入时间线 | 2022-12-09 Sizzle (`6b0b2bf4`) → 2023-02-10 `:equal` (`220587ae`) → 2023-03-02 iframe 上下文修复 (`727b1365`) |

---

## 1. 背景

Automa 的"元素选择器"是一个**单一字符串字段** `data.selector`，由 `data.findBy` 决定走 CSS 还是 XPath。UI 上它表现为"CSS 选择器 / XPath"二选一，用户以为自己在写 CSS。

实际情况是：`FindElement.cssSelector()` 内部有**三条互斥的查询路径**，靠对字符串做正则嗅探来分派：

```js
// src/utils/FindElement.js:22-52
static cssSelector(data, documentCtx = document) {
  const selector = data.markEl
    ? `${data.selector.trim()}:not([${data.blockIdAttr}])`
    : data.selector;

  if (specialSelectorsRegex.test(selector)) {
    const elements = Sizzle(selector, documentCtx);   // 路径 A：jQuery 引擎
    return data.multiple ? elements : elements[0];
  }

  if (selector.includes('>>')) {
    const newSelector = selector.replaceAll('>>', '');  // 路径 B：Shadow DOM 深查询
    return data.multiple
      ? querySelectorAllDeep(newSelector)                // ⚠ 未传 documentCtx
      : querySelectorDeep(newSelector);
  }

  // 路径 C：原生
  return data.multiple
    ? documentCtx.querySelectorAll(selector)
    : documentCtx.querySelector(selector);
}
```

Sizzle 2.3.10 是全项目**唯一**一处 `import Sizzle`（`FindElement.js:1`）的依赖，引入它的唯一目的是获得标准 CSS 不具备的 `:contains`（见 §2）。

---

## 2. 为什么会有 Sizzle

git 历史给出确定答案，不是架构选择，是功能倒逼：

```
6b0b2bf4  feat: support `:contains` in CSS Selector (#973)   Ahmad Kholid, 2022-12-09
  package.json            | 1 +
  src/utils/FindElement.js | 12 ++++++++++++++++
```

该 commit 除 import、一个三元素数组、一个 `regex.test()` 分支外无其他改动。2022 年 `:has()` 支持率尚低，要自研 `:contains` 需实现完整选择器 parser，成本远高于引入 72KB 的库。

随后 `220587ae` 直接白捡了扩展点：

```js
Sizzle.selectors.pseudos.equal = Sizzle.selectors.createPseudo(function (text) {...});
```

**结论**：Sizzle 不是"选择了老引擎"，而是"为 `:contains` 这个标准 CSS 缺失的能力，被迫接受了一个 jQuery 子集引擎"，且该选择被写入了用户的工作流 JSON，此后未再变更。

---

## 3. 缺陷清单

| # | 缺陷 | 位置 | 影响 |
|---|---|---|---|
| D1 | 分派正则未锚定 | `FindElement.js:18-19` | `[title=":parent"]` 被误路由到 Sizzle |
| D2 | `>>` 分支不传 `documentCtx` | `FindElement.js:39` | iframe 内穿 Shadow DOM 必然失败 |
| D3 | `>>` 用 `replaceAll` 删字符串 | `FindElement.js:36` | `a>>b` → `ab`；空格敏感，静默选错元素 |
| D4 | 伪类语义 = 换引擎 | 整个 `cssSelector()` | `:contains` 与 `:is()` 互斥（能力悬崖） |
| D5 | 类型嗅探 `isXPath` 散落 7 处 | 见 §3.1 | 改一处漏六处 |
| D6 | `markEl` 注入为 CSS 专属字符串拼接 | `FindElement.js:23` | XPath 模式下标记/去重失效，行为不对称 |
| D7 | UI 解析失败静默吞异常 | `App.vue:267-270` | 手写错误选择器零反馈，仅运行时暴露 |
| D8 | 存在 3 条独立查询路径 | `selectorFrameContext.js:89`、`elementObserver.js:51` | 均直连 `FindElement`，修复需逐一验证 |
| D9 | `src` 下无任何测试 | — | 无法证明重构前后行为等价 |

### 3.1 `isXPath` 的 7 个调用点

```
src/content/handleSelector.js:18
src/content/index.js:63
src/content/elementObserver.js:50
src/content/blocksHandler/handlerSwitchTo.js:8
src/content/blocksHandler/handlerConditions.js:9
src/content/blocksHandler/handlerPressKey.js
src/newtab/utils/elementSelector.js:54
src/workflowEngine/blocksHandler/handlerLoopData.js:57
```

规则本体在 `src/utils/helper.js:29-33`：

```js
export function isXPath(str) {
  const regex = /^([(/@]|id\()/;
  return regex.test(str);
}
```

---

## 4. 目标与非目标

### 目标
- G1 选择器字符串有**单一解析入口**，不再靠正则嗅探分派引擎
- G2 伪类与标准 CSS 可自由组合，消除能力悬崖
- G3 `iframe` 与 `shadow DOM` 可任意组合
- G4 解析错误可定位到字符位置，编辑器可即时反馈
- G5 `markEl` / 多选 / 等待等行为在 CSS 与 XPath 下完全对称
- G6 删除 Sizzle 依赖

### 非目标
- N1 **不改写任何存量用户数据**（见 §7迁移原则）
- N2 不替换 `@medv/finder`（选择器**生成**侧不在本次范围）
- N3 不改选择器**生成**逻辑（`generateXPath`、`findSelector`、`generateElementsSelector` 保持原样）
- N4 不做 Playwright 式 locator 语法（`text=`、`role=` 等）作为对外 API

---

## 5. 方案

### 5.1 分层

```
  selector 字符串
        │
   ┌────▼─────┐
   │  parse   │  纯函数，无 DOM 依赖，可单测
   └────┬─────┘
        │  AST（frames[] + target）
   ┌────▼─────┐
   │   exec   │  单一执行器，root 显式逐层下传
   └────┬─────┘
        │      └─ filters[] 后置文本过滤
   ┌────▼─────┐
   │  native  │  querySelector(All) / querySelectorAllDeep
   └──────────┘
```

### 5.2 AST 定义

```ts
type AST = {
  ok: true
  frames: Part[]      // |> 分隔的 iframe 链（可为空）
  target: Part        // 目标元素选择器
} | {
  ok: false
  error: string       // 人类可读，如 "unclosed parenthesis"
  at: number          // 出错字符下标，用于编辑器红标
}

type Part = {
  kind: 'css' | 'xpath'
  deep: boolean       // 段内是否含 >>；是标记位，不是删除动作
  base: string        // 交给原生引擎的原始选择器（不含 >> 标记）
  filters: Filter[]   // 文本类伪类，降级为后置过滤
}

type Filter = { name: 'contains' | 'equal', arg: string }
```

### 5.3 解析规则

| 输入 | 产出 |
|---|---|
| `|>` | 顶层切分为 `frames[]` + `target` |
| `>>` | 仅在段内解析 → `deep: true`，`base` 保留其余部分 |
| `:contains(x)` `:equal(x)` | 从 `base` 剥离 → `filters[]` |
| `kind` 判定 | `findBy` 有值则用之；缺失时 fallback `isXPath`（**唯一**保留嗅探之处） |
| 引号/转义 | 复用 `src/lib/query-selector-shadow-dom/index.js:137` 的 `splitByCharacterUnlessQuoted` |

> **兼容性说明**：现行 `|> ` 链要求全链同为 CSS 或同为 XPath（`handleSelector.js:18` 对整串嗅探后统一取 type）。AST 天然支持分段指定，但对外**暂不开放混合**，保持现有行为。

### 5.4 执行器

```js
// src/selector/exec.js
function execPart(part, root) {
  // D2 修复：root 一路显式下传
  const els = part.deep
    ? querySelectorAllDeep(part.base, root)
    : Array.from(root.querySelectorAll(part.base));

  // D4 修复：伪类是过滤器而非引擎
  const filtered = part.filters.length
    ? els.filter((el) => part.filters.every((f) => matchFilter(el, f)))
    : els;

  // D6 修复：markEl 是过滤，与引擎无关 → CSS/XPath 对称
  const marked = part.blockIdAttr
    ? filtered.filter((el) => !el.hasAttribute(part.blockIdAttr))
    : filtered;

  return part.multiple ? marked : marked[0] ?? null;
}

function resolve(raw, { root = document, ...options }) {
  const ast = parse(raw);
  if (!ast.ok) throw new SelectorError(ast);       // D7：结构化错误

  let ctx = root;
  for (const f of ast.frames) {
    const el = execPart({ ...f, multiple: false }, ctx);
    if (!el) return null;                          // frame 未命中
    ctx = el.contentDocument;                      // 下传
  }
  return execPart(ast.target, ctx);
}
```

### 5.5 伪类规格

| 名称 | 现状 | 改造后语义 | 备注 |
|---|---|---|---|
| `:contains(t)` | Sizzle | `el.textContent.includes(t)` | 保持原行为 |
| `:equal(t)` | Automa 自定义 | `el.textContent.trim() === t` | 保持原行为 |
| `:header` | Sizzle | `/^H[1-6]$/.test(tagName)` | 同 Sizzle `rheader` |
| `:parent` | Sizzle | `!!el.firstElementChild` | 同 Sizzle `!empty` |
| `:first/:last/:eq()/:even/:odd/:lt()/:gt()/:nth()` | Sizzle 顺带可用 | **移除** | 未在文档中公开，属意外副作用 |
| `:has()/:not()/:is()/:nth-child()` 等 | CSS4 原生 | 保持原生 | 与 filters 可共存 |
| `:visible` | — | **可选新增** | 见 §9 开放问题 Q2 |

> **⚠️ 需审核确认**：Sizzle 顺带提供的 jQuery 位置伪类（`:eq(0)` 等）虽未文档化，但用户工作流里可能存在。若确认移除，需在 P3 双跑对比阶段量化实际影响。

---

## 6. 对比

| 维度 | 现状 | 改造后 |
|---|---|---|
| 引擎数量 | 3 | 1（原生 + 过滤器层） |
| 依赖 | sizzle 2.3.10 / 72KB dist | 删除 |
| 文本条件 | 独占引擎，与 CSS4 互斥 | 与任意 CSS 组合 |
| iframe + shadow | 不可组合（D2） | root 逐层下传，天然可组合 |
| `markEl` | CSS 有效 / XPath 失效 | 两边对称 |
| 错误反馈 | 运行时抛 / UI 静默 | `{error, at}`，输入框即时红标 |
| `isXPath` 份数 | 7 | 1 |
| 可测试性 | 需 DOM | parser 纯函数，无需 DOM |

---

## 7. 迁移原则

**用户的工作流 JSON 是用户资产，禁止静默重写。**

`migrate.js` 提供**用户主动触发**的单向转换：

```
button:contains("登录")  →  button:text="登录"
p:equal("cat")           →  p:text="cat"
```

在"校验选择器"面板中展示变更前后 diff，用户确认后才写入。存量数据在解析层**永久兼容**老语法。

---

## 8. 分阶段计划

| 阶段 | 内容 | 工作量 | 风险 | 交付判定 |
|---|---|---|---|---|
| **P0** | 修 D2：`FindElement.js:39` 传入 `documentCtx` | 0.5h | 极低 | iframe + `>>` 可用 |
| **P1** | 修 D5：`isXPath` 收敛为单一导出，`findBy` 优先语义写死 | 1h | 极低 | 7 处调用点统一 |
| **P2** | 测试基建：vitest + 选择器行为基线 spec（§10） | 半天 | 无 | `npm test` 可跑 |
| **P3** | 引入 `src/selector/{parse,exec,filters}.js`，`FindElement` 内部改走 AST，**Sizzle 分支保留 feature flag** | 2–3 天 | 中 | 双跑对比 `new ≠ old` 零差异，持续 1 周 |
| **P4** | 删 Sizzle 分支与依赖，接入 migrate UI | 1 天 | 低 | bundle 减小；P3 观察期通过 |

> **强烈建议**：P2 是 P3 的硬前提。没有基线测试就无法论证"删掉 Sizzle 后存量工作流行为不变"，这才是重构的真实风险点——不是 parser 难写，而是**无法证明等价**。

---

## 9. 开放问题（需审核决策）

| # | 问题 | 选项 |
|---|---|---|
| Q1 | 是否移除 Sizzle 顺带提供的 `:eq()/:first/:last` 等位置伪类？ | A. 移除（规格更干净）<br>B. 用 filters 补齐（实现 + 约 40 行） |
| Q2 | 是否新增 `:visible`（可见性过滤）伪类？ | A. 不加（越界）<br>B. 加（自动化强需求，但需定义"可见"语义） |
| Q3 | P3 双跑观察期是否需要开关 UI？还是仅内部 feature flag？ | A. 仅内部<br>B. 对用户可见灰度 |
| Q4 | 是否借机收敛 `selectorFrameContext.js:89` / `elementObserver.js:51` 两条独立路径（D8）？ | A. 仅接入新 executor<br>B. 一并重写 |

---

## 10. 测试基线 spec（P2 交付物）

每个用例固定三档断言：**解析结果 / 匹配元素数 / 引擎路径**。

| # | 输入 | `findBy` | multiple | 期望 |
|---|---|---|---|---|
| T01 | `#id` | css | false | 1 个，原生路径 |
| T02 | `.a, .b` | css | true | 全部匹配，原生路径 |
| T03 | `div:has(> p)` | css | true | 原生路径 |
| T04 | `button:contains("登录")` | css | false | 1 个，Sizzle 路径 |
| T05 | `p:equal("cat")` | css | false | 1 个，Sizzle 路径 |
| T06 | `div:parent` | css | true | 含子元素者 |
| T07 | `my-app >> .btn` | css | false | 1 个，deep 路径 |
| T08 | `my-app>>.btn`（无空格） | css | false | **锁定当前错误行为**，作为 D3 修复的对照 |
| T09 | `#frame |> .inner` | css | false | iframe 内 1 个 |
| T10 | `//div[@id="a"]` | xpath | false | XPath 路径 |
| T11 | `//div` | xpath | true | 全部 |
| T12 | `#a`，`markEl: true` | css | false | 排除 `[block--x]` |
| T13 | `//div`，`markEl: true` | xpath | false | **锁定当前失效行为**，作为 D6 修复的对照 |
| T14 | `[title=":parent"]` | css | false | **锁定当前误路由**，作为 D1 修复的对照 |
| T15 | `div:contains("x"):is(.a)` | css | false | 现状应报错，作为 D4 修复的对照 |
| T16 | `#frame |> my-app >> .btn` | css | false | **当前必失败**（D2），修复后应通过 |

---

## 附录 A：现状行为备忘（重构时勿破坏）

- 等待：`waitForSelector` 开启后每 **200ms** 轮询，超时 `waitSelectorTimeout`（默认 5000ms）返回 `null` — `handleSelector.js:34-56`
- 多选关闭时取**第一个**匹配项（`querySelector`），非数组
- XPath 多选用 `ORDERED_NODE_ITERATOR_TYPE`，手动迭代 — `FindElement.js:54-82`
- 生成侧：`@medv/finder` 默认只认 `data-testid` 属性 — `lib/findSelector.js:3`
- 列表选择器生成形态：`父选择器 > tag` 或 `列表选择器 子选择器` — `generateElementsSelector.js:35,41`
- iframe 命中失败时 `onError(new Error('iframe-not-found'))` — `handleSelector.js:72`

## 附录 B：P0 单点 diff 预览

```diff
   if (selector.includes('>>')) {
     const newSelector = selector.replaceAll('>>', '');
 
     return data.multiple
-      ? querySelectorAllDeep(newSelector)
-      : querySelectorDeep(newSelector);
+      ? querySelectorAllDeep(newSelector, documentCtx)
+      : querySelectorDeep(newSelector, documentCtx);
   }
```
