# read_page 现状实测与改造方案

样本：`https://books.toscrape.com/`（真实页面，2026-10-04 实测，真 Chromium 里跑）
复现：`node .agent-test/books-trace.mjs`（详见文末「复现方式」）

本文只记录**实测结论**，所有数字都来自真页面真跑，不是估算。

---

## 1. 现状：页面信息是怎么到模型手里的

六跳链路，每一跳都有落点：

| # | 环节 | 位置 |
|---|---|---|
| 1 | 模型调 `read_page({detail})` | `src/agent/tools/page.js:25` |
| 2 | 工具转 `ctx.readPage(detail)` | `src/agent/tools/page.js:42-45` |
| 3 | newtab 侧发消息到目标 tab | `src/agent/index.js:184` → `readPageFromTab` |
| 4 | `browser.tabs.sendMessage({type:'agent:read-page'})` | `src/agent/index.js:121-126` |
| 5 | content script 接住并跑 handler | `src/content/index.js:322-325` → `blocksHandler().agentReadPage({detail})` |
| 6 | **content 侧把页面拼成一段文本字符串返回** | `src/content/blocksHandler/handlerAgentReadPage.js:386` |

第 6 跳就是整个问题的核心：content 侧返回的是**一段给模型读的自然语言式文本**，不是结构化数据。
模型看到这坨文本，靠自己推理出 JS 该怎么写，最后用 `add_block` / `update_block`
（`src/agent/tools/canvas.js`）把 `javascript-code` 块的 `code` 字段写进画布——**落盘的是代码字符串，
不是页面结构**。这一条决定了后面所有取舍。

---

## 2. 实测：`detail='auto'` 到底给了模型什么

总输出 **6705 字符 ≈ 4470 token**（口径用 `src/agent/window.js` 的 `estimateTokens`）。

| 段 | 字符 | 占比 |
|---|---|---|
| `<page>` 头 + 可见文本 | 2038 | 30% |
| `## 重复项检测` | 1146 | 17% |
| `## 交互元素索引（共 114 个，已截断）` | 3416 | 51% |

关键摘录（原文）：

```
## 重复项检测（写「循环元素」块时直接用这些选择器）
- 容器 li > ul
  单项 li > ul > li:nth-of-type(1)  × 50
  字段 a
  样例 a="catalogue/category/books/travel_2/index.html"
- 容器 form.form-horizontal
  单项 form.form-horizontal > strong:nth-of-type(1)  × 3
- 容器 ol.row
  单项 li.col-xs-6.col-sm-4:nth-of-type(1)  × 20
  字段 product_pod / a / product_price / price_color / instock / btn
  样例 product_pod="A Light in the ... £51.77 In stock Add to basket" a="catalogue/a-light-in-the-attic_1000/index.html" ...
- 容器 li.col-xs-6.col-sm-4:nth-of-type(1) > article.product_pod > p.star-rating.Three
  单项 ... > p.star-rating.Three > i:nth-of-type(1)  × 5
（后两条同构，都是 ×5）
```

```
## 交互元素索引（共 114 个，已截断）
  [1] a "Books to Scrape" -> div.col-sm-8.h1 > a
  [3] a "Books" -> ul.nav.nav-list > li > a
  ...
  [53] a "Crime" -> li:nth-of-type(50) > a
  [54] a -> li.col-xs-6.col-sm-4:nth-of-type(1) > article.product_pod > div.image_container:nth-of-type(1) > a
  [55] a "A Light in the ..." -> li.col-xs-6.col-sm-4:nth-of-type(1) > article.product_pod > h3 > a
  [56] button[submit] "Add to basket" -> ... > div.product_price:nth-of-type(2) > form > button.btn.btn-primary
```

---

## 3. 五个实证问题

### P1 — 索引预算被布局吃掉，书元素只露出 4 本

`MAX_INTERACTIVE = 60`，但 `collectInteractive`（`handlerAgentReadPage.js:216`）是
`root.querySelectorAll(sel)` 的**文档顺序**取前 60 个。这个页面侧栏在内容区前面，结果：

60 条里 **53 条是侧栏分类导航**（[1]–[53]），真正的书元素从 **[54]** 才开始。
一轮 `read_page` 里模型能看到的书元素只有 **4 本**（[54]–[60]，每本 3 个：图片链接 / 标题链接 / 加购按钮）。

这不是随机截断，是**跟布局强相关**的偏差：内容区在 DOM 后面的页面（侧栏在左、正文在右、页脚内容多）
系统性吃亏。

### P2 — 书名取的是 `textContent`，长书名被站点截断了

```
[55] a "A Light in the ..." -> ... > h3 > a
```

books.toscrape.com 的链接文本就是 `A Light in the ...`（站点自己截的），
**完整书名在 `title` 属性里**：`A Light in the Attic`。

`collectInteractive` 里 `name = el.textContent`（`:245`）没兜 `title`。
所以模型如果照这个输出写 `a.textContent`，抓到的是 `"A Light in the ..."`——**静默错误，
而且只有过长的书名才中招，短书名（比如 [58] "Tipping the Velvet"）完全正常**，模型很难察觉。

### P3 — 正确的列表被噪声压在第 3 位

重复项检测报了 6 个「重复容器」，真正的书列表（`ol.row` × 20）排第 3：
1. `li > ul` × 50 —— 侧栏分类导航
2. `form.form-horizontal` × 3 —— 登录表单
3. **`ol.row` × 20 —— 这才是要抓的书列表**
4–6. `p.star-rating.Three/.One/.One` × 5 —— 星级图标

第 1 条 ×50 是「看起来最像列表」的一个，模型很可能误拿来当循环目标。

根因：`MIN_REPEAT = 3` 太松，只按 DOM 顺序找到就 push，没有「信息量」排序，也没排除导航容器。

### P4 — 字段名是无语义的标签名

```
字段 product_pod / a / product_price / price_color / instock / btn
```

字段用标签名当字段名，模型得自己猜 `a` 是「链接」、`price_color` 是「价格」。
链接给的是相对路径 `catalogue/a-light-in-the-attic_1000/index.html`，没标是否相对、要怎么拼域名。

### P5 — 超预算时砍错地方（实测坐实）

`detail:'auto'` 的降级分支（`:489`）是 `if (detail === 'auto' && idx > maxChars)`——
**砍掉整个交互元素索引**。实测把 `maxChars` 压下来：

```
maxChars=8000   输出  6705 字符   正文:有  重复项:有  交互索引:有
maxChars=3200   输出  3359 字符   正文:有  重复项:有  交互索引:无
maxChars=2000   输出  3359 字符   正文:有  重复项:有  交互索引:无
```

预算一破，**唯一能直接产出 selector 的那 3416 字符整块消失**，而占 30% 的正文一个字没砍。
退化后的输出里除了重复项检测那几行，没有任何可用的元素 selector——正是「报成功但给不出东西」。

---

## 4. 那 agent 为什么还是写对了

因为有两条兜底：

1. 重复项检测的 `ol.row` 段给了 `li.col-xs-6.col-sm-4:nth-of-type(1)` 和字段标签名，
   模型能自己拼出 `article.product_pod`；
2. 正文里能看到 `£51.77` / `In stock` / `Add to basket`，模型知道字段长什么样。

**这是靠模型，不靠工具。** 工具给的是一堆需要人工翻译的碎片。
一旦换成侧栏在内容区之后的布局（P1 更严重）、或正文里字段不可辨、或模型弱一点，
就会静默写错。

---

## 5. 改造方案

### 5.1 `src/content/blocksHandler/handlerAgentReadPage.js`（主战场）

| 编号 | 改动 | 位置 |
|---|---|---|
| R1 | 新增「列表模式」段：容器 / 单项 / 字段（语义名 + 取值方式）/ 条数 / **单条样例** / 明确写「其余 N 条结构相同，未逐条展开」 | 新增 `collectListPatterns()`，接在重复项检测之后 |
| R2 | 导航折叠：`isNavish()` 判 `nav, aside, header, footer, .sidebar, .nav-list, .breadcrumb`，**不占 `MAX_INTERACTIVE` 预算**，折叠成一行「导航/页脚 N 个已折叠」 | `collectInteractive()` 内 |
| R3 | 字段值取全：`name` 兜底顺序改成 `title` → `aria-label` → `placeholder` → `textContent`；链接字段显式标 `href` 并注明是否相对路径 | `collectInteractive()` 的 `name` 计算 `:240-248` |
| R4 | 重复项检测排序：排除导航容器 + 按「字段信息量」（字段数 × 样例长度）降序，正确的列表排第一 | `collectRepeated()` `:160-212` |
| R5 | 正文默认不输出：`detail='full'` 才给 `MAX_TEXT_CHARS` 正文，其余档只给锚点片段（或整段不输出） | `:417-427` |
| R6 | 降级方向修正：超预算砍的是「展开明细」，且**必须保留单条样例**，不能全砍成空白 | `:489-491` |

R1 + R2 解决 P1/P3/P4，R3 解决 P2，R5 解决 P5 的一半，R6 兜住 P5。

### 5.2 `src/agent/tools/page.js`

`detail` 枚举与 description 改口径：现在是「summary / interactive / full ≈ 读多少正文」，
改成「给多少地址」。`summary` 不再含正文。

### 5.3 新增两个取内容工具（可选，第二步）

- `find_text({keyword})` —— 页内检索，回命中项（带 selector + 前后片段）≈ 650 token
- `resolve_selector({role, name, index})` —— 给元素描述，回一个持久 cssPath

只在**用户真的要页面内容**时用。写 selector、抓列表这类任务不需要它们。

### 5.4 沿用前面的结论，不动

- `loop.js` / `wire.js`：接上 `elideStaleObservations`（P0a）
- `dropOldestTurn` 支持单轮内降级淘汰（P0b）

---

## 6. 原型实测（同一真页面，三种方案）

| 方案 | 字符 | token | 相对现状 |
|---|---|---|---|
| 现状 `detail:'auto'` | 6705 | 4470 | 100% |
| 原型「地址优先」：去正文 + 导航折叠 + 24 条明细 | 4636 | 3091 | 69% |
| **原型「列表模式」：列表模式 + 单条样例** | **455** | **304** | **−93%** |

列表模式那版完整输出（原样）：

```
<page url=https://books.toscrape.com/ title=All products | Books to Scrape - Sandbox>
## 列表（自动检出）
  单项 div.row > div.col-sm-8.col-md-9 > section > div > ol.row > li.col-xs-6.col-sm-4  ×20 条
  字段 h3 > a    → 书名（用 title 属性，文本被站点截断）  样例 "A Light in the Attic"
  字段 h3 > a[href] → 链接   样例 catalogue/a-light-in-the-attic_1000/index.html
  字段 .price_color → 价格   样例 £51.77
  其余 20 条结构完全相同，未逐条展开；需要某一条的完整属性用 details 参数取值
## 可操作元素：内容区 61 个、导航/页脚 53 个（已折叠）
</page>
```

**304 token 里就装了写出正确 JS 需要的一切**：单项 selector、书名/链接/价格三个字段的
取值路径、样例值、条数，以及「其余相同」的显式声明。

这印证了上一轮的判断，而且比合成素材更狠：**列表任务里逐条展开元素是纯浪费**——
20 本书结构完全一样，展开 24 条和展开 1 条给模型的信息量几乎相等，token 差 6 倍。

---

## 7. 明确不做

- **全文 a11y 树替换现在的索引**：a11y 树本身更省（实测 552 vs 960 token / 同样 24 元素），
  但它是**会话内快照的临时句柄**，而落盘位置是块的 `data.selector`；运行期
  `src/utils/FindElement.js` 只有 `cssSelector` 和 `xpath` 两个方法，`ref=e5` 不是合法 CSS，
  写进工作流必然「选择器不匹配」。**可以抄它的表示，不能抄它的寻址。**
- **JSON 结构化输出**：实测 1552 token，比现在的 960 贵 62%。
- **给 `read_page` 加 `query` 参数做相关性排序**：职责混淆，一个工具干两件事。

---

## 8. 落地顺序

1. **R1 + R2 + R3**（同一文件，改动集中）—— 解决 P1/P2/P3/P4，原型已验证
2. **R5 + R6** —— 删正文预算，修降级方向，解决 P5
3. 跑 `npm test` + `npm run test:dom`，补回归断言（特别是「书元素必须出现在前 30 条索引内」）
4. `detail` 口径改造（tools/page.js）
5. `find_text` / `resolve_selector`（可选）
6. P0a / P0b 上下文接线（上一轮已定）

---

## 复现方式

```bash
# 需要 .agent-test/node_modules 指向含 playwright 的 node_modules（见 .agent-test/README.md）
node .agent-test/books-trace.mjs     # 真页面跑 read_page，按段打出来
npm test                             # 单测
npm run test:dom                     # Chromium 里的 handler 断言
```

`.agent-test/handler.iife.js` 是生成物（已被 .gitignore 忽略），改了
`handlerAgentReadPage.js` 之后要按 `.agent-test/README.md` 的配方重新生成。
