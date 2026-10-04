# read_page 工具设计：地址优先（v1，已批准 → 已落地）

> 产出日期：2026-10-04，来源会话「read_page 工具如何设计」。
> 依据三份材料：`docs/agent-context-discussion-2026-10-04.md`（上下文工程讨论 Q1–Q7）、
> `docs/agent-readpage-trace.md`（真页面现状实测 + 原型）、本文 §9（本轮新增实测）。
> 状态：**已落地**（2026-10-04 实施：A 线 T-24/T-25、B 线 T-17~T-25 全部完成，实测见 §10）。
> 落地过程按真页面实测新增 3 条收敛规则 + 1 处砍序补档，见 §4 末「落地时补的两处」与 §10.2。
> §12 的 4 个开放决策已在会话中拍板：改名 `probe/addresses/content/full`、`maxChars` 暴露（默认 6000）、
> A 线先合、`find_text` 只做字面匹配。
> 所有数字标注来源：**实测** = 真 Chromium 跑真页面或项目自带 estimator；**推断** = 未实测。

---

## 0. 一句话

**`read_page` 给地址，内容按需取。**

默认档只回答三件事——这页有什么、每类东西的 selector 是什么、每类长什么样一条样例；不搬正文。
要读内容用 `content` 档或 `find_text`，要判断"页面变没变"用 `probe` 档。

现状（实测，books.toscrape.com，`detail:'auto'`）：6705 字符 / 4470 token，其中正文占 30%、
对写 selector 几乎无贡献；原型「列表模式」把同样的信息压到 **455 字符 / 304 token（−93%）**。

---

## 1. 边界：先立不做的

| 不做 | 为什么 | 出处 |
|---|---|---|
| ref 寻址（`ref=e5`）、坐标点击 | 落盘位置是块的 `data.selector`，运行期 `src/utils/FindElement.js` 只有 `cssSelector`/`xpath`，`e5` 不是合法 CSS → 永远不命中 | trace §7、讨论 Q6 |
| JSON 结构化输出 | 实测 1552 token vs 现状 960（同 24 元素），贵 62% | 讨论 Q6 |
| 全文 a11y 树替换交互索引 | 表示层可抄（552 vs 960 更省），寻址层不可抄 —— 一票否决 | trace §7 |
| 给 `read_page` 加 `query` 参数 | 职责混淆，一个工具干两件事 | trace §7 |
| 语义化选择器（`:has-text()` / `getByRole`） | 要扩 `FindElement` 才能用，属范围扩张 | 讨论 Q6 |
| MutationObserver 检测页面变化 | 轮播图/实时数据在滚 → 触发重读 → 等于没省 | 讨论 Q3 |
| agent 保存工作流 | 红线 G5，与本设计无关但同属一条链路 | AGENTS.md |

**硬约束**（设计必须满足，违反即缺陷）：

1. 进 prompt 的观察值必须是**字符串**并包在 `<untrusted_page_content>` 里
   （`loop.js:81` → `events.js:55`）；`window.js:101` 的陈旧快照剔除正是按这个前缀识别的，
   **格式必须保持以它开头**。工具内部可以返回结构化对象，但要在 `resultEvent` 处解包成字符串（§6.3）。
2. 单观察值 ≤ `MAX_OBSERVATION_CHARS = 8000` 字符（`window.js:28`），`events.js:79` 从头保留、砍尾部。
3. 每个可交互元素/列表字段都必须给**可直接落盘的 CSS selector** —— 这是约束①的下游，也是"能写出正确操作代码"的判据。
4. `class: 'read'`（免确认）；新增工具同理，`validateTools` 在模块加载期校验。
5. **不静默降级**：省了什么必须显式说出来；不认识的参数必须显式报错。

---

## 2. 接口

### 2.1 `detail` 口径：从「读多少正文」改成「给多少地址」

现在四个值是 `auto / summary / interactive / full`，语义是「正文 → 加索引 → 加 HTML」，
且**不是单调阶梯**（实测：`interactive` 比 `summary` 少了正文，见 §9-F5）。
新口径必须单调，且把"预算兜底"从参数里拿掉 —— `auto` 的隐式降级正是 P5 砍错地方的根因。

| detail | 回答的问题 | 内容 | 成本 |
|---|---|---|---|
| `probe` | 页面变没变？ | url / title / lang / 交互元素总数 / 可见文本长度 / 指纹 | ~150 token（讨论 Q3 估算） |
| `addresses` **（新默认）** | 有什么、怎么找 | 列表模式 + 可操作元素（导航折叠）+ 表格 + 接口 + 虚拟列表警告；**无正文** | 实测列表页 304 token |
| `content` | 再加上内容 | `addresses` + 可见正文（末尾追加） | + 正文预算（≤3000 字） |
| `full` | 再加原始 HTML | `content` + HTML 片段（末尾追加，预算内截断） | 必须显式请求 |

**旧值兼容**（模型会照抄历史上下文里的参数，不能直接拒）：

| 旧值 | 映射到 | 备注 |
|---|---|---|
| `auto` | `addresses` | 不再隐式降级；档位由输出头部回显 |
| `summary` | `content` | 旧语义 = 正文 + 重复项 |
| `interactive` | `addresses` | 旧语义 = 索引 + 接口，无正文 |
| `full` | `full` | — |
| 其它任何值 | **报错，不降级** | 见 §5 白名单 |

映射是静默的，但 `<page>` 头部必须回显**生效档位**（`detail=addresses`），模型看到的永远是实际拿到的东西。

### 2.2 工具定义（代码形态）

```js
// src/agent/tools/page.js
export const readPage = {
  name: 'read_page',
  class: 'read',
  group: 'page',
  description:
    '读取目标页的结构地址：列表模式（容器/单项/字段/样例）、可操作元素索引（导航已折叠）、' +
    '表格与页面请求过的接口。默认 detail=addresses（约几百 token），写 selector 或抓列表前必须先调用。' +
    '默认档不含页面正文 —— 要读内容用 detail=content，或用 find_text 按关键词取片段；' +
    '只想确认页面有没有变用 detail=probe（最省）。',
  parameters: {
    type: 'object',
    properties: {
      detail: {
        type: 'string',
        enum: ['addresses', 'probe', 'content', 'full'],
        description:
          'probe=URL/标题/元素数/指纹(~150 token)；addresses=结构与地址(默认，写 selector 用这个)；' +
          'content=再加可见正文；full=再加 HTML 片段(极少用)。',
      },
      maxChars: {
        type: 'number',
        description: '输出字符预算，默认 6000。预算不足时按固定砍序省略，省略处会显式标注。',
      },
    },
  },
  async execute(args, ctx) {
    return ctx.readPage({
      detail: (args && args.detail) || 'addresses',
      maxChars: args && args.maxChars,
    });
  },
};
```

改动点：`ctx.readPage` 从收字符串改成收对象（`src/agent/index.js:184`）、
`readPageFromTab` 消息体补 `maxChars`（`index.js:121-128`）、
content 分发透传（`src/content/index.js:323-325`）—— 这条链路今天把 `maxChars` 全丢了，见 **T-23**。

---

## 3. 输出契约（`addresses` 档）

段顺序是一条硬规则：**不可再生的地址在前，可再生的内容在后**。
理由：`events.js:79` 的硬截断从头保留、砍尾部 —— 让被砍的永远是"再读一次还能拿到"的那部分。
现状把正文放最前（`handlerAgentReadPage.js:407`），等于让可再生内容占据最安全的位置，见 **T-19**。

```text
<page url="…" title="…" lang="zh" detail="addresses" fingerprint="9f2c1a4e">
## 列表（自动检出，按信息量排序，最多 3 个）
  容器 div.row > div.col-sm-8 > section > ol.row
  单项 li.col-xs-6.col-sm-4  ×20 条
  字段 h3 > a          → 书名（取 title 属性；链接文本被站点截断） 样例 "A Light in the Attic"
  字段 h3 > a[href]    → 链接（相对路径）                          样例 catalogue/a-light-in-the-attic_1000/index.html
  字段 .price_color    → 价格                                      样例 £51.77
  其余 19 条结构完全相同，未逐条展开；要某一条的完整属性用 detail=content 或 find_text
## 可操作元素（内容区 61 个；导航/页脚 53 个已折叠）
  [1] a "Add to basket" -> li.col-xs-6.col-sm-4:nth-of-type(1) > article.product_pod > ... > form > button.btn
  [2] …
## 表格（仅当存在）
  | selector | 行数 | 表头 | 首 2 行样例 |
## 页面请求过的接口（仅当存在）
  fetch /api/products?page=1
## 警告（仅当存在：虚拟列表 / 内部滚动容器）
</page>
```

`content` 档在 `</page>` 前追加 `## 可见文本`（≤3000 字）；
`full` 档再追加 `## 完整 HTML（截断）`。两者都排在尾部，被截断时先丢它们。

---

## 4. 分段预算与砍序（R5/R6 的具体化）

handler 自身预算 `maxChars`（默认 **6000**，留 2000 字符给 `<untrusted_page_content>` 标签、
转义膨胀与截断注记 —— 推断，未实测各部分实际占比）。

超预算时的砍序，**只往一个方向砍**：

| 优先级 | 段 | 砍法 |
|---|---|---|
| 先砍 | `content`/`full` 的正文、HTML | 整段按比例削，保头部 1000 字 |
| 再砍 | 交互索引明细 | 60 → 30 → 15 条 |
| 再砍 | 表格样例（2 行 → 1 行）、接口清单（12 → 6） | 数量减半 |
| **永不砍** | `<page>` 头、**列表模式 + 单条样例**、折叠计数 | —— |

每次砍必须补一行显式说明，例如：

```text
[note: 交互索引只列出前 30 个（共 61 个内容区元素），其余已省略；要按文本找元素用 find_text。]
```

这直接替换现在的降级分支（`handlerAgentReadPage.js:489-493`）——它在超预算时**整块删掉交互索引、
正文一字不砍**，实测 3505 → 3274 字符，砍掉的恰恰是唯一能产出 selector 的 231 字（**T-20/P5**）。

**落地时补的两处**（实测驱动，2026-10-04）：

1. **HTML 必须逐级变小，不能 6000 直接跳 0。** 照上表会踩空档：骨架 1252 + html 6000 > 6000 预算，
   下一档直接 `htmlChars: 0` —— `detail=full` 在真页面上**永远拿不到 HTML**（改造初实测 `full` 2328 字符
   反而比 `content` 3289 字符短，只剩一条「已省略」note）。补 `6000 → 3000 → 1000 → 0` 两档后，
   真页面 `full` = 4311 字符，`## 完整 HTML（截断）` 真的出现（**实测**，`dom.test.mjs` 两条断言钉着）。
2. **正文先砍、HTML 后砍**（正文 3000 → 1000 → 0 期间 HTML 一直留在 6000）：调 `full` 的人要的就是 HTML。

---

## 5. 内容侧改动清单（`src/content/blocksHandler/handlerAgentReadPage.js`）

单文件完成 —— 不能拆文件，因为 `.agent-test/README.md` 的 iife 生成配方是**按 `export default`
切片的单文件替换**，`blocksHandler.js:4` 的 `require.context(..., false, ...)` 也不递归子目录；
拆出去等于要么改测试配方、要么把 `cssPath` 复制两份（正是 `content/index.js:321` 注释警告的"两份实现必然走偏"）。

| 编号 | 改动 | 位置（现行） | 修的是 |
|---|---|---|---|
| R1 | 新增 `collectListPatterns()`：容器 / 单项 / 字段（语义名 + **取值方式** + 样例）/ 条数 / 「其余 N 条结构相同」 | 接在重复项检测后 | P4、列表任务的主粮 |
| R2 | `isNavish()` 折叠导航，**不占 `MAX_INTERACTIVE=60` 名额**，内容区优先填满 | `collectInteractive()` | P1（60 条里 53 条是侧栏） |
| R3 | name 兜底顺序 `title` → `aria-label` → `placeholder` → `textContent`；链接显式标绝对/相对 | `:240-248` | P2（书名取到被截断的文本） |
| R4 | 重复项排序：排除导航容器 + 按 `字段数 × 样例长度` 降序 | `detectRepeated()` | P3（正确列表排第 3） |
| R5 | 正文只在 `content`/`full` 输出 | `:419` | 正文占 30% 且不可寻址 |
| R6 | 砍序按 §4，保列表样例 | `:487-514` | P5 / **T-20** |
| D1 | `detail='full'` 纳入重复项检测条件 | `:437` | **T-17** |
| D2 | detail 白名单：未知值返回明确错误，不降级 | `:388` | **T-18** |
| D3 | 段顺序调整（地址在前、正文在后） | `:407` 起 | **T-19** |
| FP | `pageFingerprint()`：url + title + 元素总数 + `body.textContent` 采样 hash | 新增 | §6 |

`MIN_REPEAT = 3` 保持不变（`dom.test.mjs:66` 有断言钉着「2 个兄弟不报」，是有意的）。

---

## 6. 指纹与「第二轮还要不要 read_page」

### 6.1 算法

```text
fingerprint = fnv1a(
  url + '\n' + title + '\n' +
  document.querySelectorAll('*').length + '\n' +
  body.textContent.length + '\n' +
  body.textContent.slice(0, 4096)
)
```

刻意**不用 `innerText`**：它要触发样式计算与布局，大页面上每步都算是浪费（推断，未实测耗时）。
`textContent` 不触发 layout，采样 4096 字符足够捕捉 SPA 换路由、翻页、筛选、展开。

### 6.2 两个落点，各有各的消费者

| 落点 | 消费者 | 用途 |
|---|---|---|
| **`TOOL_RESULT` 事件的独立字段** `pageFingerprint` | runtime（preStepNotice、跨轮比对） | 页面变没变的**唯一判据** |
| `<page fingerprint="…">` 头部 | 模型 | 自己两次 `read_page` 对比，省一次重读 |

**指纹绝不能只存在观察值文本里** —— 一旦启用「旧快照作废」（`window.js:101`），
那段文本会被替换成 `STALE_MARKER`，指纹跟着一起没（讨论 Q3 的原话）。
runtime 侧判断必须读事件字段，不读文本（页面正文可以伪造一个假 `<page fingerprint>` 行，文本不可信）。

### 6.3 链路改动（依赖 T-21）

handler 返回 `{text, fingerprint}` → `readPageFromTab` 返回对象 →
`tools/page.js` 返回 `{payload, pageFingerprint}` → `loop.js resultEvent` **解包**：

```js
// payload 作观察值正文；pageFingerprint 上提到事件顶层；不进 wire、不进 untrusted 标签
const { payload, ...meta } = isEnvelope(observation) ? observation : { payload: observation };
```

`wire.js:103` 只读 `ev.observation`，`sessions.js` 按原样存事件 —— 新字段对两者天然兼容，
旧会话读出来是 `undefined`，用 `|| null` 容错即可。

**先后依赖**：今天所有结构化返回的工具（`query_elements`/`test_js`/`highlight`/`tabs`/`canvas`）
都会被 `events.js:74-76` 整个 `JSON.stringify` 进观察值（实测：63 字符的正文变成 100 字符的 JSON 包裹，
内层 `status:'error'` 走不到错误分支）—— 这是 **T-21**。先修 T-21，指纹搭同一趟车；
不修就只能把指纹塞进文本，然后被 elide 抹掉，等于白做。

### 6.4 比对时机（advisory，不设闸门）

沿用 `preStepNotice` 的原则：**runtime 不替模型决定读不读**。

1. **每步**：现有的 `tab.url`/`origin` 检查（免费，`index.js:250-286`）保留 —— 它看不见站内路由/翻页/筛选，这是已知盲区。
2. **每轮 `send` 开始**：做一次轻量 probe（不进 prompt），与上次存的指纹比；**变了才**注入一条 system-notice。
   成本是一次 content 消息往返，每轮一次（推断，未实测往返耗时）。
3. **模型自己**：随时可调 `detail='probe'`（~150 token），每步都调也不心疼。

不做 MutationObserver（§1）。

---

## 7. 新增工具 `find_text`（页内按文本找元素）

现有工具箱（`tools/index.js:45-58`）里没有任何一个能"按文本内容找元素"——
模型是被逼着用全文才去找运费/退换货政策这类页面底部文本的（讨论 Q4）。

```js
{
  name: 'find_text',
  class: 'read',          // 只读，不改页面 → 免确认（ADR 0002 的分级原则）
  group: 'page',
  parameters: {
    keyword: { type: 'string' },   // 字面匹配，大小写不敏感；不做正则（注入面 + 语法错误）
    limit:   { type: 'number' },   // 默认 5，最多 20
  },
}
```

返回：命中数 + 每条 `selector + 前后 40 字片段 + 所在容器 selector`，约 650 token（讨论 Q4 估算）。

**实现位置**：同一个 `handlerAgentReadPage.js`，加 `op: 'find-text'` 参数（复用 `cssPath`/`isVisible`），
`content/index.js:323` 的 case 里按 `op` 分发。理由同 §5：不拆文件、不复制 `cssPath`。

**与 `query_elements` 的分工**（两者互补，不是重复）：

| | 已知 selector？ | 回什么 |
|---|---|---|
| `query_elements` | 是 | 命中几个、长什么样（验证用） |
| `find_text` | 否 | 命中元素的 selector（找入口用） |

`resolve_selector`（trace §5.3 的第三个候选）**暂缓**：`find_text` 命中即带 selector，
`query_elements` 能验证，第三个工具的收益重叠，等 `find_text` 用过再评。

---

## 8. prompt 配套改动（`src/agent/prompt.js`）

read_page 改口径后，prompt 里三句话要跟着动，否则模型会按旧习惯行事：

1. `:97`「重要结论在写进方案前要重新 read_page 确认」→ 改成
   **「先用 `detail=probe` 或 `<page>` 头部的 fingerprint 确认页面变了，再重读；页面没变就沿用上次结论」**
   —— 否则每自纠一次就多吃一份快照（讨论 Q1 的第三个成因）。
2. `:79-80`「抓列表时先看重复项检测结果」→ 补「**列表段的字段会写明取值方式**（text/title 属性/href），
   按它取值，不要默认取 `textContent`」。
3. 新增一条（配合 elide，讨论 Q2 的"靠 observability 兜"）：
   **「read_page 的历史快照会被压缩成一行占位；关键 selector 与条数请复述进你自己的方案里，别只留在观察值里。」**

---

## 9. 本轮实测（新增证据，均已登记进 `docs/backlog.md`）

复现命令见各条 `证据` 字段；三个探针脚本留在 `.agent-test/`。

| # | 发现 | 实测结果 | 登记 |
|---|---|---|---|
| F1 | `detail='full'` 跳过重复项检测 | 有 4 项卡片列表的页面上，`full` 档输出「**未发现 3 个以上结构相同的兄弟元素**」，同页 `summary` 档正确给出 `容器 div.grid ×4` | T-17 |
| F2 | 未知 `detail` 静默降级 | `detail:'bogus'` → 145 字符，只剩正文 + 同款「未发现列表」假断言，无任何参数报错 | T-18 |
| F3 | `full` 档结构性超观察值上限 | handler 输出 9430 字符 → 8K 截断后 8028，`## 完整 HTML` 只剩 4621/6000 字（3000 正文 + 6000 HTML 本身就 > 8000） | T-19 |
| F4 | 超预算砍索引、留正文 | `maxChars=3000/2000` → 输出 3505 → 3274，交互索引整块消失、正文一字未砍、只剩降级提示 | T-20（即 trace 的 P5，本轮复现） |
| F5 | `detail` 不是单调阶梯 | `summary` 有正文、`interactive` 无正文、`auto` 又有 —— 与 `tools/page.js:20-23` 的「再加」口径矛盾 | T-22 |
| F6 | 结构化返回被 JSON 包裹 | 字符串 63 字符 vs 对象 100 字符（+59%）；内层 `status:'error'` 渲染成 JSON 而非错误观察值 | T-21 |
| F7 | `maxChars`/`budgetNodes` 链路不可达 | 静态确认三处签名只传 `detail`；反向实测直接调 handler 能触发降级 → 参数存在但接不通 | T-23 |

> 沿用前次实测（未在本轮复跑，出处 `docs/agent-context-discussion-2026-10-04.md`）：
> 12 步 = 124,769 token、接上陈旧快照剔除省 90%（124,769 → 12,145）、
> 原型「列表模式」304 token、a11y/ref/JSON 表示法对比。

---

## 10. 测试计划

| 层 | 命令 | 要补的断言 |
|---|---|---|
| 单测 | `npm test` | `tools/index.test.js:117` 的枚举断言改新值；新增「未知 detail 报错」的纯函数测试；`loop.test` 补「结构化返回被解包」（现有测试只查 `includes`，测不出包裹） |
| DOM | `npm run test:dom` | **F1**：`full` 档在列表页必须给出列表段（不是「未发现」）；**F2**：未知 detail → 明确报错；**F3**：`addresses` 输出 < 6000 字符；**F4**：`maxChars` 逼紧时列表样例仍在；**R1**：列表模式字段/取值方式/样例/条数；**R3**：`title` 属性优先于 `textContent`；**R2**：导航折叠后内容区元素排前 30 |
| 真页面 | `node .agent-test/books-trace.mjs` | 改造前后 token 对照（现状 4470 → 目标 ≤ 900） |
| 收尾 | `npm run lint`、`npm run check:i18n` | 动了多语言文案才需要 i18n |

`dom.test.mjs` 现有 9 条测试的 `readOn(..., detail)` 都要改档位名（`summary/interactive/full` → 新枚举），
`detail 三档的取舍` 这个 describe 名也随之过期。

### 10.1 落地后实测（2026-10-04，同一台机器）

| 层 | 命令 | 结果 |
|---|---|---|
| 单测 | `npm test` | 14 suites / **273 pass / 0 fail**（新增：新枚举与白名单、未知 detail 报错、T-21 解包三段断言） |
| DOM | `npm run test:dom` | 4 suites / **26 pass / 0 fail**（F1–F4、R1–R3、段顺序、预算砍序、导航折叠、列表项折叠、HTML 逐级砍、`find_text`） |
| 真页面 | `node --import ./utils/test-loader.mjs .agent-test/books-trace.mjs` | 见下表 |
| 收尾 | `npm run lint` | 本次改动的文件 **0 问题**；全量仅剩 2 个存量错误（`.eslintrc.js:90`、`src/lib/dayjs.js:11`，均未被本次触碰） |

真页面对照（books.toscrape.com；改造前 `detail:'auto'` = 6705 字符 / 4470 token）：

| 档 | 字符 | token | 占基线 |
|---|---|---|---|
| `probe` | 293 | 196 | 4% |
| `addresses`（默认） | 1252 | **835** | 19% |
| `content` | 3289 | 2193 | 49% |
| `full` | 4311 | 2874 | 64% |

默认档目标 ≤ 900 token：**835 达成**（−81%）。

### 10.2 实施中新增的收敛规则（原设计表之外，实测驱动）

| 规则 | 实测来源 | 效果（真页面实测） |
|---|---|---|
| 列表项内、**第一项之外**的可操作元素折叠计数（`listFoldRegions()`），头里报 `列表项内 N 个已折叠` | books 首页 60 个内容区元素里 57 个是同 3 条路径的 nth-of-type 变体，交互索引 4172/5328 字符 = 78%，而列表段已给出这 3 条路径 | addresses 5328 → 1424 字符 |
| 抽不出字段的结构组不列（0 字段过滤；在「未发现」里报数） | 星级图标组 `article.product_pod > p.star-rating > i × 5` 过同构检测但一个字段都抽不出 | 列表段不再有空壳条目 |
| 整组是行内强调标记（`strong/em/b/i/small/mark`）不算列表 | results 计数器 `<strong>1000</strong> results - showing <strong>1</strong> to <strong>20</strong>` 被当成列表，给出的 `strong:nth-of-type(1)` 对写循环块无用 | addresses 1424 → 1252 字符 |

> 三条都是「同一结构的重复行不提供新地址」这一原则的延伸；实现与理由写在
> `handlerAgentReadPage.js` 对应函数的头注释里，DOM 断言在 `dom.test.mjs`，
> 真页面数字由 `books-trace.mjs` 复跑得出。

---

## 11. 落地顺序（已全部执行完，2026-10-04）

分两条线，互不阻塞，但**收益互相依赖**：

**A 线 · 上下文层**（讨论文档里的 P0，read_page 改造省下的 token 要靠它兑现）

1. **T-24** `loop.js:321` 在 `buildWireMessages` 后接 `elideStaleObservations`（一行）—— 实测省 90%
2. **T-25** `dropOldestTurn` 补单轮内降级路径 + `window.test.js:156` 的回归断言（现在的 `dropped===0` 断言恰好掩盖了这个缺口）

**B 线 · read_page 本体**

3. **T-21** 结构化返回解包（`loop.js resultEvent`）—— 指纹字段的地基，也让 `read_page` 之外的工具（`query_elements`/`test_js`/`tabs`/`canvas`）立刻受益
4. **T-17 / T-18** 两个正确性缺陷（一行级，先修先受益）
5. **R1 + R2 + R3**（同一文件，改动集中）—— 解决 P1/P2/P3/P4，原型已验证 −93%
6. **R5 + R6 + 段顺序（T-19）+ detail 白名单与枚举切换（T-17/T-18、T-23 链路透传）**
7. 跑 `npm test` + `npm run test:dom`，补 §10 的回归断言
8. **指纹 + `probe` 档 + preStepNotice 升级**（§6）
9. **`find_text`**（§7）
10. prompt 三处改动（§8）—— 可与 8/9 同批

**不做**（已登记为候选）：语义化选择器、`resolve_selector`、diff 档、全文 a11y 替换。

---

## 12. 开放决策（已拍板，原文保留供追溯）

> 2026-10-04 会话拍板：① 枚举改名 `probe/addresses/content/full`；② `maxChars` 暴露给模型（默认 6000）；
> ③ A 线先合；④ `find_text` 只做字面匹配（要正则另开工具）。以下为原文。

1. **枚举改名 vs 保留旧名。** 推荐改 `addresses/probe/content/full`（单调、语义直白），
   代价是 `dom.test.mjs` 与 `tools/index.test.js` 的档位断言要改，旧值走映射表。
   备选：保留 `auto/summary/interactive/full` 只改语义 —— 少改测试，但 `summary` 这个名字
   会继续误导（它已不含正文），且 `interactive`/`summary` 的差别更难解释。
2. **`maxChars` 要不要暴露给模型。** 暴露 = 模型可以自己压预算（多一个旋钮，也可能乱按）；
   不暴露 = 只给 runtime 用，接口更窄。推荐先暴露（默认 6000），观察实际用法再收。
3. **A 线和 B 线谁先。** A 线改动小、收益 90%，但只在多步多轮时显现；
   B 线是功能质量。推荐 A 线先合（两处都是几行 + 测试），B 线按 4→7 推进。
4. **`find_text` 的正则支持。** 本设计明确只做字面匹配；若后续发现需要范围匹配（价格区间、日期），
   再单开工具，不给现有工具加 `regex: true`。
