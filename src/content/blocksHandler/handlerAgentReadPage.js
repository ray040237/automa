/**
 * read_page / find_text 的 content 侧实现。
 *
 * 通过 src/content/blocksHandler.js 的 require.context 零注册接入：
 *   文件名 handlerAgentReadPage.js -> 去掉 handler 前缀 -> toCamelCase -> agentReadPage
 *   对应 newtab 侧发送的 label: 'agent-read-page'
 *
 * 为什么必须单文件（docs/agent-readpage-design.md §5）：.agent-test/README.md 的 iife
 * 生成配方是按 `export default` 切片的单文件替换，blocksHandler.js 的
 * require.context(..., false, ...) 也不递归子目录 —— 拆出去要么改配方、要么把
 * cssPath 复制两份，而 content/index.js:321 的注释已经警告过两份实现必然走偏。
 *
 * 本文件的契约（改之前先读，每条都是有代价换来的）：
 *   1. 返回 {text, fingerprint}；text 是纯文本观察值，由 events.js 包进
 *      <untrusted_page_content>；fingerprint 上提到事件字段，不进观察值文本 ——
 *      观察值会被陈旧快照剔除整段换成占位符，runtime 判断页面变没变不能读文本。
 *   2. detail 只认 probe/addresses/content/full。旧值（auto/summary/interactive）
 *      由 agent 侧 tools/page.js 映射，未知值在这里明确报错，不静默降级（T-18）。
 *   3. 段顺序：不可再生的地址在前，可再生的正文/HTML 在后 —— events.js 的 8K 硬截断
 *      从头保留砍尾部，这样被砍的永远是「再读一次还能拿到」的（T-19）。
 *   4. 预算按固定砍序降级：正文/HTML → 交互索引 → 表格样例/接口清单；
 *      列表模式与单条样例永不砍，砍到哪必须显式标注（R6）。
 *   5. 列表字段必须写明取值方式（title 属性 / href / text）—— 只回 textContent 的话，
 *      模型会拿着被站点截断的链接文本当真值去比对（R3）。
 */

const MAX_TEXT_CHARS = 3000;
const MAX_HTML_CHARS = 6000;
const MAX_INTERACTIVE = 60;
const MAX_CANDIDATES = 12; // 排序前的列表候选上限
const MAX_LISTS = 3; // 输出的列表段上限
const MAX_TABLES = 4;
const MAX_NET = 12;
const MAX_FIELDS_PER_ITEM = 12;
const MIN_REPEAT = 3;
const MAX_DOM_NODES = 40000;
const DEFAULT_MAX_CHARS = 6000; // 8000 观察值上限 - 2000 留给标签、转义膨胀与截断注记
const MIN_MAX_CHARS = 400;
const HARD_MAX_CHARS = 8000; // 与 events.js 的观察值硬截断对齐
const FINGERPRINT_SAMPLE_CHARS = 4096;
const FIND_TEXT_DEFAULT_LIMIT = 5;
const FIND_TEXT_MAX_LIMIT = 20;
const DETAIL_VALUES = ['addresses', 'probe', 'content', 'full'];

const ATTR_KEYS = ['title', 'aria-label', 'placeholder', 'alt'];

/**
 * 行内强调标记。一组 <strong>/<em>/<i> 兄弟几乎总是句子里的强调片段
 * （实测 books.toscrape.com 的「<strong>1000</strong> results - showing
 * <strong>1</strong> to <strong>20</strong>」被当成列表报了出来，给出的
 * 单项选择器 strong:nth-of-type(1) 对写循环块毫无用处），不是数据项。
 * span 不在此列 —— 标签云里的 <span> 是真列表。
 */
const INLINE_MARK_TAGS = ['STRONG', 'EM', 'B', 'I', 'SMALL', 'MARK'];

const EMPTY_INTERACTIVE = {
  items: [],
  navCount: 0,
  contentTotal: 0,
  listFolded: 0,
  total: 0,
};

/**
 * 预算砍序（设计稿 §4）。只往一个方向砍：先砍可再生的正文/HTML，再砍交互索引明细，
 * 最后砍表格样例与接口清单；列表模式与单条样例永不参与。渲染到第一个装得下的档为止。
 */
const BUDGET_LADDER = [
  {
    rows: MAX_INTERACTIVE,
    tblRows: 2,
    netLimit: MAX_NET,
    textChars: MAX_TEXT_CHARS,
    htmlChars: MAX_HTML_CHARS,
  },
  // HTML 必须逐级变小，不能 6000 直接跳 0：跳档会让 detail=full 在真页面上
  // 永远拿不到 HTML（1252（骨架）+ 6000 > 预算 → 下一档 html=0 → full 比
  // content 还短，只留一条「已省略」的 note）。正文先砍、HTML 后砍：调 full 的
  // 人要的就是 HTML。
  {
    rows: MAX_INTERACTIVE,
    tblRows: 2,
    netLimit: MAX_NET,
    textChars: 1000,
    htmlChars: MAX_HTML_CHARS,
  },
  {
    rows: MAX_INTERACTIVE,
    tblRows: 2,
    netLimit: MAX_NET,
    textChars: 0,
    htmlChars: MAX_HTML_CHARS,
  },
  {
    rows: MAX_INTERACTIVE,
    tblRows: 2,
    netLimit: MAX_NET,
    textChars: 0,
    htmlChars: 3000,
  },
  {
    rows: MAX_INTERACTIVE,
    tblRows: 2,
    netLimit: MAX_NET,
    textChars: 0,
    htmlChars: 1000,
  },
  {
    rows: MAX_INTERACTIVE,
    tblRows: 2,
    netLimit: MAX_NET,
    textChars: 0,
    htmlChars: 0,
  },
  { rows: 30, tblRows: 2, netLimit: MAX_NET, textChars: 0, htmlChars: 0 },
  { rows: 15, tblRows: 1, netLimit: 6, textChars: 0, htmlChars: 0 },
  { rows: 0, tblRows: 1, netLimit: 6, textChars: 0, htmlChars: 0 },
];

const HARD_TRUNCATE_NOTE =
  '[note: 输出已按预算截断，尾部内容丢失；要更细的信息请缩小范围（如 find_text）或调大 maxChars。]';

/**
 * 元素是否可见（能撑出盒子）。
 */
function isVisible(el) {
  if (!el) return false;
  if (el.hidden) return false;
  const style = window.getComputedStyle(el);
  if (!style || style.display === 'none' || style.visibility === 'hidden')
    return false;
  return el.getClientRects().length > 0;
}

/**
 * 元素签名：tag + 归一化 class 的前几个。用它判断一组兄弟是否同构。
 */
function signature(el) {
  const cls = (
    el.className && typeof el.className === 'string' ? el.className : ''
  )
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join('.');
  return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
}

/** class 列表（前 n 个）；SVG 等 className 不是字符串的元素返回空数组。 */
function classesOf(el, n) {
  const raw =
    el.className && typeof el.className === 'string' ? el.className : '';
  return raw.split(/\s+/).filter(Boolean).slice(0, n);
}

/**
 * 元素是否属于导航/页脚区。
 *
 * 侧栏、分页、面包屑、站内导航里的列表和链接对「写选择器」几乎没有贡献，
 * 却会把列表候选与交互索引的名额吃光（实测 60 条里 53 条是侧栏，P1）。
 * 只认标签（nav/header/footer）、role，以及一组明确的类名 token —— 不做模糊
 * 子串匹配，否则 content-header 里的正文列表也会被误折叠。
 */
function isNavish(el) {
  let node = el;
  let depth = 0;

  while (node && node.nodeType === 1 && depth < 6) {
    const tag = node.tagName;
    if (tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER') return true;

    const role = node.getAttribute && node.getAttribute('role');
    if (role === 'navigation' || role === 'banner' || role === 'contentinfo')
      return true;

    const hint = [node.id || ''].concat(classesOf(node, 8)).join(' ');
    const tokens = hint.toLowerCase().split(/[^a-z0-9]+/);
    if (
      tokens.some(
        (t) =>
          [
            'nav',
            'navbar',
            'sidenav',
            'navigation',
            'sidebar',
            'menu',
            'menubar',
            'breadcrumb',
            'pagination',
            'pager',
            'toolbar',
          ].indexOf(t) !== -1
      )
    ) {
      return true;
    }

    node = node.parentElement;
    depth += 1;
  }

  return false;
}

/**
 * 给元素生成一个尽量稳定的选择器。
 * 优先级：唯一 id > 带 id 的祖先链 > class 链（必要时补 nth-of-type）。
 */
function cssPath(el) {
  if (
    el.id &&
    document.querySelectorAll('#' + CSS.escape(el.id)).length === 1
  ) {
    return '#' + CSS.escape(el.id);
  }

  const parts = [];
  let node = el;
  let depth = 0;

  while (node && node.nodeType === 1 && depth < 6) {
    let part = node.tagName.toLowerCase();

    if (
      node.id &&
      document.querySelectorAll('#' + CSS.escape(node.id)).length === 1
    ) {
      parts.unshift('#' + CSS.escape(node.id));
      break;
    }

    const cls = classesOf(node, 2);

    // class 太泛（数量太多）就不用，否则选择器不可靠
    cls.forEach((c) => {
      try {
        if (document.querySelectorAll('.' + CSS.escape(c)).length <= 40)
          part += '.' + CSS.escape(c);
      } catch (e) {
        /* 非法 class 名，跳过 */
      }
    });

    const parent = node.parentElement;
    if (parent) {
      const { tagName } = node;
      const sameTag = Array.from(parent.children).filter(
        (s) => s.tagName === tagName
      );
      if (sameTag.length > 1)
        part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
    }

    parts.unshift(part);

    // 如果这一段已经能唯一命中，就不用再往上找了
    try {
      if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
    } catch (e) {
      /* 继续往上 */
    }

    node = parent;
    depth += 1;
  }

  return parts.join(' > ');
}

/**
 * 相对选择器：从列表项内部定位字段。
 *
 * 绝对路径（cssPath）换个页面就废了，而字段永远是项的后代 —— 给项内的子路径，
 * 模型才能直接把它拼进「循环元素」块。
 */
function relativeSelector(el, item) {
  const parts = [];
  let node = el;
  let depth = 0;

  while (node && node.nodeType === 1 && node !== item && depth < 5) {
    let part = node.tagName.toLowerCase();
    const cls = classesOf(node, 1);
    cls.forEach((c) => {
      part += '.' + c;
    });

    const parent = node.parentElement;
    if (parent) {
      const tag = node.tagName;
      const sameTag = Array.from(parent.children).filter(
        (s) => s.tagName === tag
      );
      if (sameTag.length > 1)
        part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
    }

    parts.unshift(part);
    node = parent;
    depth += 1;
  }

  if (parts.length === 0) return signature(el);
  return parts.join(' > ');
}

/** href 是相对还是绝对 —— 模型拿相对路径去 open_url 会直接 404。 */
function hrefKind(href) {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.indexOf('//') === 0
    ? '（绝对）'
    : '（相对）';
}

/**
 * 判断一个字段元素的取值方式与样例（R3）。
 *
 * 关键点：链接文本常被站点截断（"A Light in the Att…"），真值在 title 属性里；
 * 只回 textContent 的话，模型会拿着半截文本当真值去比对。
 * 返回 null 表示这个元素没有可报的值。
 */
function fieldTake(el) {
  if (el.tagName === 'IMG') {
    const src = el.getAttribute('src');
    if (src) return { take: 'src 属性', sample: src };
    const alt = el.getAttribute('alt');
    if (alt) return { take: 'alt 属性', sample: alt };
    return null;
  }

  if (el.tagName === 'TIME') {
    const dt = el.getAttribute('datetime');
    if (dt) return { take: 'datetime 属性', sample: dt };
  }

  if (el.tagName === 'A') {
    const title = (el.getAttribute('title') || '').trim();
    const href = el.getAttribute('href');
    if (title)
      return {
        take: 'title 属性',
        sample: title,
        extra: href ? 'href' + hrefKind(href) + ' ' + href : '',
      };
    if (href) return { take: 'href' + hrefKind(href), sample: href };
  }

  if (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT'
  ) {
    const v = el.value != null ? String(el.value).trim() : '';
    if (v) return { take: 'value 属性', sample: v };
  }

  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text) return { take: 'text', sample: text };

  return null;
}

/**
 * 抽一个重复项里的字段：项内相对选择器 + 语义名（aria-label）+ 取值方式 + 样例。
 *
 * 从深到浅遍历，两条去冗余规则（否则 `<h3><a title="全名">半截文本</a></h3>`
 * 会把包裹层的半截文本也当成一个字段报出来，和 title 里的真值打架）：
 *   - 包裹层取 text 且子层已经报过等长/更长的值 → 包裹层丢（它没带来新信息）；
 *   - 包裹层的文本覆盖了子层片段（span 里的 b 只有半个符号）→ 子层丢。
 * 属性类取值（title/href/src/datetime/value）不参与裁剪，它们是真值来源。
 */
function extractFields(item) {
  const kept = [];
  const descendants = Array.from(item.querySelectorAll('*'));

  for (let i = descendants.length - 1; i >= 0; i -= 1) {
    if (kept.length >= 40) break;

    const el = descendants[i];
    if (!isVisible(el)) continue;

    const got = fieldTake(el);
    if (!got) continue;

    const sample = String(got.sample || '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!sample || sample.length > 160) continue;

    const childrenKept = kept.filter((k) => el.contains(k.el));

    if (got.take === 'text') {
      if (childrenKept.some((k) => k.sample.length >= sample.length)) continue;

      for (let j = kept.length - 1; j >= 0; j -= 1) {
        if (el.contains(kept[j].el) && sample.indexOf(kept[j].sample) !== -1)
          kept.splice(j, 1);
      }
    }

    const semantic = (el.getAttribute && el.getAttribute('aria-label')) || '';
    kept.push({
      idx: i,
      el,
      take: got.take,
      sample,
      ...(semantic ? { semantic } : {}),
      ...(got.extra ? { extra: got.extra } : {}),
    });
  }

  // 项本身就是值（<li>条0</li>、<div class="it">条0</div>）：后代一个字段都没抽出时，
  // 项自身的取值就是这条列表的内容 —— 否则纯文本列表会被「抽不出字段」误杀。
  // 有后代字段时不加这一条：卡片的整段拼接文本（"无线鼠标 ￥100 详情"）只会添乱。
  if (kept.length === 0) {
    const got = fieldTake(item);
    const sample = got
      ? String(got.sample || '')
          .trim()
          .replace(/\s+/g, ' ')
      : '';
    const semantic =
      (item.getAttribute && item.getAttribute('aria-label')) || '';

    if (got && sample && sample.length <= 160)
      kept.push({
        idx: -1,
        el: item,
        take: got.take,
        sample,
        ...(semantic ? { semantic } : {}),
        ...(got.extra ? { extra: got.extra } : {}),
      });
  }

  // 输出保持文档顺序（遍历是倒着来的）
  kept.sort((a, b) => a.idx - b.idx);

  const seen = new Set();
  const out = [];

  for (let i = 0; i < kept.length && out.length < MAX_FIELDS_PER_ITEM; i += 1) {
    const f = kept[i];
    const selector = relativeSelector(f.el, item);
    if (seen.has(selector)) continue;
    seen.add(selector);

    out.push({
      selector,
      ...(f.semantic ? { semantic: f.semantic } : {}),
      take: f.take,
      sample: f.sample,
      ...(f.extra ? { extra: f.extra } : {}),
    });
  }

  return out;
}

/**
 * 重复项检测：遍历所有元素，找同构子元素 >= MIN_REPEAT 的容器。
 *
 * 三条排序/取舍规则（R4）：
 *   - 导航/页脚容器里的列表只计数不输出（P3：正确列表被挤到第 3 之后）；
 *   - 抽不出字段的结构组不输出（实测星级图标的 5 个 <i>、表单里的 3 个 <strong>
 *     都能过同构检测，但一个字段都抽不出来 —— 给模型的就是「有列表」的错觉）；
 *   - 按 字段数 × 样例长度 降序，信息量最大的列表排最前。
 */
function detectRepeated(root, budgetNodes) {
  const found = [];
  const all = root.querySelectorAll('body *');
  const limit = Math.min(all.length, budgetNodes);
  let navLists = 0;
  let emptyLists = 0;
  let inlineMarks = 0;

  for (let i = 0; i < limit && found.length < MAX_CANDIDATES; i += 1) {
    const container = all[i];
    if (!isVisible(container)) continue;

    const children = Array.from(container.children).filter((c) => isVisible(c));
    if (children.length < MIN_REPEAT) continue;

    // 按签名分组，取最大的一组
    const groups = new Map();
    children.forEach((c) => {
      const sig = signature(c);
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push(c);
    });

    let best = null;
    groups.forEach((g) => {
      if (!best || g.length > best.length) best = g;
    });

    if (!best || best.length < MIN_REPEAT) continue;

    // 有列表形状但长在导航/页脚区：只记账，不占候选（R4）
    if (isNavish(container)) {
      navLists += 1;
      continue;
    }

    // 整组都是行内强调标记：那是句子里的排版，不是重复项（见 INLINE_MARK_TAGS）
    if (best.every((el) => INLINE_MARK_TAGS.indexOf(el.tagName) !== -1)) {
      inlineMarks += 1;
      continue;
    }

    // 已经有更内层的同构组时跳过外层，避免同一个列表被报很多次
    const dup = found.some((f) =>
      best.some((b) => f.itemSelector === cssPath(b))
    );
    if (dup) continue;

    const fields = extractFields(best[0]);
    if (fields.length === 0) {
      emptyLists += 1;
      continue;
    }

    found.push({
      containerSelector: cssPath(container),
      itemSelector: cssPath(best[0]),
      itemSignature: signature(best[0]),
      count: best.length,
      fields,
      score:
        fields.length *
        (fields.reduce((sum, f) => sum + f.sample.length, 0) || 1),
    });
  }

  // 排序 + 截断会生成新数组，属性要挂在返回值上（挂在原数组上会被 slice 抹掉）
  const top = found.sort((a, b) => b.score - a.score).slice(0, MAX_LISTS);
  top.navLists = navLists;
  top.emptyLists = emptyLists;
  top.inlineMarks = inlineMarks;

  return top;
}

/**
 * 「列表项内、第一项之外」的元素集合。
 *
 * 真页面实测（books.toscrape.com，20 条 × 3 个元素）：交互索引 60 行占了
 * addresses 输出的 78%（4172/5328 字符），其中 57 行只是同 3 条路径的
 * nth-of-type 变体 —— 而列表段已经把这 3 条路径给了。重复列它们不提供新地址，
 * 只把默认档撑到 3552 token（目标 ≤900，见设计稿 §10）。
 *
 * 折叠只发生在「第一项之外」：第一项的元素留着，作为一条具体样例。
 * 嵌套列表的「第一项」可能落在别的列表项里（卡片里再嵌标签列表），
 * 这类元素先被标成第一项、再被标成可折叠 —— 以第一项为准，不折叠。
 *
 * @param {Array} repeated detectRepeated 的结果
 * @returns {Set<Element>}
 */
function listFoldRegions(repeated) {
  const fold = new Set();
  const first = new Set();

  const markSubtree = (set, el) => {
    set.add(el);
    const kids = el.querySelectorAll('*');
    for (let i = 0; i < kids.length; i += 1) set.add(kids[i]);
  };

  repeated.forEach((r) => {
    let container = null;
    try {
      container = document.querySelector(r.containerSelector);
    } catch (e) {
      container = null;
    }
    if (!container) return;

    const items = Array.from(container.children).filter(
      (c) => signature(c) === r.itemSignature
    );
    if (items.length < 2) return;

    markSubtree(first, items[0]);
    for (let i = 1; i < items.length; i += 1) markSubtree(fold, items[i]);
  });

  const keep = [];
  fold.forEach((el) => {
    let node = el;
    while (node && node.nodeType === 1) {
      if (first.has(node)) {
        keep.push(el);
        break;
      }
      node = node.parentElement;
    }
  });
  keep.forEach((el) => fold.delete(el));

  return fold;
}

/**
 * 交互元素索引：链接 / 按钮 / 输入 / 下拉 / 复选。
 *
 * 折叠顺序（每类都计数、只列内容区的）：
 *   1. 导航/页脚里的元素（R2）—— 否则 60 条名额被侧栏吃掉一半；
 *   2. 列表项内第一项之外的元素 —— 列表段已给出该结构的 selector，重复列只是
 *      nth 变体；头里写明折叠了多少，要具体某项用 content 档或 find_text。
 * maxItems=0 时只统计不渲染（probe 档用）。
 */
function collectInteractive(root, maxItems, foldSet) {
  const cap = maxItems === undefined ? MAX_INTERACTIVE : maxItems;
  const sel =
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]';
  const nodes = Array.from(root.querySelectorAll(sel)).filter(isVisible);

  const out = [];
  let navCount = 0;
  let contentTotal = 0;
  let listFolded = 0;

  for (let i = 0; i < nodes.length; i += 1) {
    const el = nodes[i];

    if (isNavish(el)) {
      navCount += 1;
      continue;
    }

    contentTotal += 1;

    if (foldSet && foldSet.has(el)) {
      listFolded += 1;
      continue;
    }

    if (out.length >= cap) continue;

    const type = el.tagName.toLowerCase();

    // 取名顺序（R3）：title → aria-label → placeholder → 文本。
    // 站点常把完整值放在 title 里而文本被截断，取文本会拿到半截名字（P2）。
    let name = '';
    for (let k = 0; k < ATTR_KEYS.length - 1; k += 1) {
      const v = el.getAttribute(ATTR_KEYS[k]);
      if (v && v.trim()) {
        name = v.trim();
        break;
      }
    }
    if (!name)
      name = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name && type === 'input')
      name = [el.getAttribute('name'), el.id, el.type].filter(Boolean)[0] || '';

    const href = el.tagName === 'A' ? el.getAttribute('href') : null;

    out.push({
      n: out.length + 1,
      tag: type,
      ...(el.getAttribute('type')
        ? { inputType: el.getAttribute('type') }
        : {}),
      ...(name ? { name } : {}),
      ...(href ? { hrefKind: hrefKind(href) } : {}),
      ...(el.id ? { id: el.id } : {}),
      selector: cssPath(el),
    });
  }

  return {
    items: out,
    navCount,
    contentTotal,
    listFolded,
    total: nodes.length,
  };
}

/**
 * 表格结构：表头 + 行数 + 少量样本。
 */
function collectTables(root) {
  const tables = Array.from(root.querySelectorAll('table'))
    .filter(isVisible)
    .slice(0, MAX_TABLES);

  return tables.map((t) => {
    const headCells = Array.from(
      t.querySelectorAll(
        'thead th, thead td, tr:first-child th, tr:first-child td'
      )
    );
    const headers = headCells
      .map((h) => (h.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 20);
    const bodyRows = t.querySelectorAll('tbody tr, tr:not(:first-child)');
    const sample = Array.from(bodyRows)
      .slice(0, 2)
      .map((r) =>
        Array.from(r.querySelectorAll('td, th')).map((c) =>
          (c.textContent || '').trim().slice(0, 60)
        )
      );
    return {
      selector: cssPath(t),
      ...(headers.length ? { headers } : {}),
      rowCount: bodyRows.length,
      ...(sample.length ? { sample } : {}),
    };
  });
}

/**
 * 网络请求：抓列表往往有比解析 DOM 稳得多的做法（直接 automaFetch 调接口）。
 * total 单独记账：本档只收前 MAX_NET 条，不把「只统计了 12 条」说成「只有 12 条」。
 */
function collectNetwork(limit) {
  try {
    const entries = performance.getEntriesByType('resource');
    const xhr = entries.filter(
      (e) =>
        ['fetch', 'xmlhttprequest', 'beacon'].indexOf(e.initiatorType) !== -1
    );

    const out = xhr.slice(0, limit).map((e) => {
      let pathname = '';
      try {
        pathname = new URL(e.name).pathname;
      } catch (err) {
        pathname = e.name;
      }
      return {
        type: e.initiatorType,
        ...(pathname ? { path: pathname } : {}),
      };
    });
    out.total = xhr.length;

    return out;
  } catch (e) {
    return [];
  }
}

/**
 * 框架全局状态：只报 key 与体积，不报内容（内容可能很大）。
 */
const FRAMEWORK_GLOBALS = [
  ['__NEXT_DATA__', 'Next.js'],
  ['__NUXT__', 'Nuxt'],
  ['__INITIAL_STATE__', 'Vuex'],
  ['__APOLLO_STATE__', 'Apollo'],
  ['__PRELOADED_STATE__', 'Nuxt'],
  ['_vueData', 'Nuxt 2'],
];

function collectFrameworkState() {
  return FRAMEWORK_GLOBALS.filter((e) => window[e[0]] !== undefined).map(
    (e) => ({
      global: e[0],
      framework: e[1],
      keys: Object.keys(window[e[0]] || {}).slice(0, 12),
    })
  );
}

/**
 * 虚拟列表检测：DOM 里只有可视区那几条时，模型必须知道抓 DOM 抓不全。
 */
function detectVirtualList(root) {
  const scrollables = Array.from(
    root.querySelectorAll('div, ul, section, main')
  ).filter((el) => {
    if (!isVisible(el)) return false;
    return el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 200;
  });

  if (scrollables.length === 0) return null;

  const el = scrollables[0];
  return {
    ...(el.id ? { selector: '#' + CSS.escape(el.id) } : {}),
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    note: '存在内部滚动容器，DOM 中可能只渲染了可视区的行。要抓全量数据应优先调用页面自身的接口。',
  };
}

/**
 * 页面指纹：URL + 标题 + 元素总数 + textContent 采样哈希。
 *
 * 刻意不用 innerText —— 它要触发样式计算与布局，大页面上每步都算是浪费；
 * textContent 不触发 layout，采样 4096 字符足以捕捉 SPA 换路由、翻页、筛选、展开。
 *
 * @param {string} url
 * @param {string} title
 * @param {string} textContent
 * @returns {string} 8 位十六进制
 */
function pageFingerprint(url, title, textContent) {
  let input;
  try {
    input =
      url +
      '\n' +
      String(title || '') +
      '\n' +
      document.querySelectorAll('*').length +
      '\n' +
      String(textContent || '').length +
      '\n' +
      String(textContent || '').slice(0, FINGERPRINT_SAMPLE_CHARS);
  } catch (e) {
    input = url + '\n' + String(title || '');
  }

  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    // fnv1a 就是按位算的，没有不用位运算的写法
    // eslint-disable-next-line no-bitwise
    h ^= input.charCodeAt(i);
    // eslint-disable-next-line no-bitwise
    h = Math.imul(h, 0x01000193);
  }

  // eslint-disable-next-line no-bitwise
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** detail 白名单：未知值明确报错，绝不静默降级（T-18）。 */
function parseDetail(raw) {
  const d =
    raw === undefined || raw === null || raw === '' ? 'addresses' : String(raw);

  if (DETAIL_VALUES.indexOf(d) === -1) {
    return {
      error:
        'detail 参数取值「' +
        d +
        '」不认识。合法值：' +
        DETAIL_VALUES.join(' / ') +
        '（probe 只看概况，addresses 给结构与 selector，默认；content 加正文；full 再加 HTML）。',
    };
  }

  return { detail: d };
}

function resolveMaxChars(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CHARS;
  return Math.min(Math.max(Math.floor(n), MIN_MAX_CHARS), HARD_MAX_CHARS);
}

/**
 * 元素的直接文本节点（不算后代的文本）。
 * 不这么做的话 body 会命中页面上每一个关键词。
 */
function ownText(el) {
  let s = '';
  const kids = el.childNodes;
  for (let i = 0; i < kids.length; i += 1) {
    if (kids[i].nodeType === 3) s += kids[i].nodeValue;
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** 元素是否命中关键词（字面、忽略大小写），命中则给出来源与原文。 */
function matchSource(el, needle) {
  if (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT'
  ) {
    const v = el.value != null ? String(el.value) : '';
    if (v && v.toLowerCase().indexOf(needle) !== -1)
      return { source: 'value 属性', text: v };

    const keys = ['placeholder', 'aria-label', 'title', 'name'];
    for (let i = 0; i < keys.length; i += 1) {
      const val = el.getAttribute(keys[i]);
      if (val && val.toLowerCase().indexOf(needle) !== -1)
        return { source: keys[i] + ' 属性', text: val };
    }
    return null;
  }

  const own = ownText(el);
  if (own && own.toLowerCase().indexOf(needle) !== -1)
    return { source: 'text', text: own };

  for (let i = 0; i < ATTR_KEYS.length; i += 1) {
    const val = el.getAttribute(ATTR_KEYS[i]);
    if (val && val.toLowerCase().indexOf(needle) !== -1)
      return { source: ATTR_KEYS[i] + ' 属性', text: val };
  }

  return null;
}

/** 关键词前后的 40 字片段。 */
function fragment(text, needle) {
  const at = text.toLowerCase().indexOf(needle);
  if (at === -1) return text.slice(0, 80);

  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + needle.length + 40);

  return (
    (start > 0 ? '…' : '') +
    text.slice(start, end).trim() +
    (end < text.length ? '…' : '')
  );
}

/**
 * find_text：页内按文本找元素。
 *
 * 字面匹配、忽略大小写，不做正则（注入面 + 语法错误，见设计稿 §12）。
 * 只认元素自己的文本节点与常见属性 —— 否则 body 会命中每一个关键词。
 *
 * @param {{keyword?: string, limit?: number}} opts
 * @returns {{text: string}}
 */
function findText(opts) {
  const keyword = String(opts.keyword == null ? '' : opts.keyword).trim();
  if (!keyword)
    return { text: 'keyword 不能为空：告诉我要在页面里找什么文本。' };

  const limitRaw = Number(opts.limit);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), FIND_TEXT_MAX_LIMIT)
      : FIND_TEXT_DEFAULT_LIMIT;

  const needle = keyword.toLowerCase();
  const hits = [];
  let total = 0;

  const all = document.querySelectorAll('body *');
  for (let i = 0; i < all.length; i += 1) {
    const el = all[i];
    if (!isVisible(el)) continue;

    const got = matchSource(el, needle);
    if (!got) continue;

    total += 1;
    if (hits.length >= limit) continue;

    hits.push({ el, source: got.source, text: got.text });
  }

  const lines = [];

  if (total === 0) {
    lines.push('页面里没有找到「' + keyword + '」。');
    lines.push(
      '注意：关键词被标签切开（跨多个元素）时匹配不到 —— 换更短的关键词，或用 read_page 看结构。'
    );
    return { text: lines.join('\n') };
  }

  lines.push(
    '命中 ' +
      total +
      ' 个（keyword "' +
      keyword +
      '"' +
      (total > hits.length ? '，只列出前 ' + hits.length + ' 个' : '') +
      '）'
  );

  hits.forEach((h, i) => {
    const parent = h.el.parentElement;
    lines.push(
      '[' +
        (i + 1) +
        '] ' +
        h.el.tagName.toLowerCase() +
        '  selector ' +
        cssPath(h.el)
    );
    if (parent) lines.push('    容器 ' + cssPath(parent));
    lines.push('    ' + h.source + ' 片段 ' + fragment(h.text, needle));
  });

  return { text: lines.join('\n') };
}

/** 预算兜底：连最省的一档都装不下时砍尾部，并显式说砍了什么。 */
function hardTruncate(text, maxChars) {
  if (text.length <= maxChars) return text;

  const room = Math.max(0, maxChars - HARD_TRUNCATE_NOTE.length - 1);
  let cut = text.slice(0, room);
  // 别把代理对劈一半 —— 半个 surrogate 会渲染成 U+FFFD
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);

  return cut + (room > 0 ? '\n' : '') + HARD_TRUNCATE_NOTE;
}

/**
 * 入口。
 *
 * @param {{detail?: string, maxChars?: number, budgetNodes?: number, op?: string,
 *          keyword?: string, limit?: number}} options
 * @returns {Promise<{text: string, fingerprint?: string}>}
 */
export default async function readPage(options) {
  const opts = options || {};

  if (opts.op === 'find-text') return findText(opts);

  const parsed = parseDetail(opts.detail);
  if (parsed.error) return { text: parsed.error };
  const { detail } = parsed;

  const maxChars = resolveMaxChars(opts.maxChars);
  const budgetNodes =
    Number(opts.budgetNodes) > 0 ? Number(opts.budgetNodes) : MAX_DOM_NODES;

  const root = document.body || document.documentElement || document;
  const url = String(window.location.href).split('"')[0];
  const title = String(document.title || '').split('"')[0];
  const lang = String(document.documentElement.lang || '').split('"')[0];

  let textContent = '';
  try {
    textContent = (document.body && document.body.textContent) || '';
  } catch (e) {
    textContent = '';
  }

  const fingerprint = pageFingerprint(url, document.title || '', textContent);
  const header =
    '<page url="' +
    url +
    '" title="' +
    title +
    '" lang="' +
    lang +
    '" detail="' +
    detail +
    '" fingerprint="' +
    fingerprint +
    '">';

  // —— probe：只答「页面变没变」，不跑列表检测，便宜到每步都能调 ——
  if (detail === 'probe') {
    let inter = EMPTY_INTERACTIVE;
    try {
      inter = collectInteractive(root, 0);
    } catch (e) {
      inter = EMPTY_INTERACTIVE;
    }

    return {
      text: [
        header,
        '## 概览',
        '  可见文本 ' + textContent.length + ' 字（textContent）',
        '  可操作元素 ' +
          inter.total +
          ' 个（内容区 ' +
          inter.contentTotal +
          '，导航/页脚 ' +
          inter.navCount +
          ' 已折叠）',
        '  列表、正文、HTML 不在本档：要结构与 selector 用 detail=addresses（默认），读正文用 detail=content。',
        '</page>',
      ].join('\n'),
      fingerprint,
    };
  }

  // —— 采集（只做一次；渲染时按预算档取子集，不重复扫 DOM）——
  let repeated;
  let virtualList = null;
  try {
    repeated = detectRepeated(root, budgetNodes);
    virtualList = detectVirtualList(root);
  } catch (e) {
    repeated = [];
    virtualList = null;
  }

  let foldSet = null;
  try {
    foldSet = listFoldRegions(repeated);
  } catch (e) {
    foldSet = null;
  }

  let interactive = EMPTY_INTERACTIVE;
  try {
    interactive = collectInteractive(root, undefined, foldSet);
  } catch (e) {
    interactive = EMPTY_INTERACTIVE;
  }

  let tables = [];
  try {
    tables = collectTables(root);
  } catch (e) {
    tables = [];
  }

  const net = collectNetwork(MAX_NET);
  const fw = collectFrameworkState();

  let visibleText = '';
  if (detail === 'content' || detail === 'full') {
    try {
      visibleText = (
        document.body && document.body.innerText ? document.body.innerText : ''
      )
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    } catch (e) {
      visibleText = '';
    }
  }

  let html = '';
  if (detail === 'full') {
    try {
      html = document.documentElement.outerHTML;
    } catch (e) {
      html = '';
    }
  }

  const hasText = detail === 'content' || detail === 'full';

  /** 按某一档渲染整页输出。段顺序是硬规则：地址在前，可再生内容在后。 */
  const render = (level) => {
    const out = [];
    const push = (s) => out.push(s);

    push(header);

    // —— 列表模式（永不砍）——
    if (repeated.length > 0) {
      push('## 列表（自动检出，按信息量排序，最多 ' + MAX_LISTS + ' 个）');
      repeated.forEach((r) => {
        push('  容器 ' + r.containerSelector);
        push('  单项 ' + r.itemSelector + '  × ' + r.count + ' 条');
        r.fields.forEach((f) => {
          push(
            '  字段 ' +
              f.selector +
              (f.semantic ? '（' + f.semantic + '）' : '') +
              ' → 取 ' +
              f.take +
              ' 样例 ' +
              JSON.stringify(f.sample) +
              (f.extra ? '（' + f.extra + '）' : '')
          );
        });
        if (r.count > 1)
          push(
            '  （其余 ' +
              (r.count - 1) +
              ' 条结构相同，未逐条展开；要某条的完整属性用 detail=content 或 find_text）'
          );
      });
    } else {
      const skipped = [];
      if (repeated.emptyLists > 0)
        skipped.push(repeated.emptyLists + ' 个抽不出字段的结构组');
      if (repeated.inlineMarks > 0)
        skipped.push(repeated.inlineMarks + ' 个行内强调片段组');

      push('## 列表');
      push(
        '未发现 3 个以上结构相同的兄弟元素。' +
          (repeated.navLists > 0
            ? '（导航/页脚里的 ' + repeated.navLists + ' 个列表已折叠不计。）'
            : '') +
          (skipped.length ? '（另有 ' + skipped.join('、') + ' 未列。）' : '') +
          '这页可能不是列表页，或是虚拟列表。'
      );
    }

    // —— 可操作元素索引（明细可砍）——
    if (interactive.contentTotal > 0) {
      const shown =
        level.rows === 0 ? [] : interactive.items.slice(0, level.rows);
      // 折叠掉的不算进「还能列出来」的名额，否则没超预算也会报一条假截断
      const listable = interactive.contentTotal - interactive.listFolded;

      push(
        '## 可操作元素（内容区 ' +
          interactive.contentTotal +
          ' 个' +
          (interactive.navCount > 0
            ? '；导航/页脚 ' + interactive.navCount + ' 个已折叠'
            : '') +
          (interactive.listFolded > 0
            ? '；列表项内 ' + interactive.listFolded + ' 个已折叠（见列表段）'
            : '') +
          '）'
      );

      shown.forEach((e) => {
        push(
          '  [' +
            e.n +
            '] ' +
            e.tag +
            (e.inputType ? '[' + e.inputType + ']' : '') +
            (e.name ? ' "' + e.name + '"' : '') +
            (e.hrefKind ? e.hrefKind : '') +
            ' -> ' +
            e.selector
        );
      });

      if (shown.length < listable) {
        push(
          level.rows === 0
            ? '[note: 交互索引已按预算整块省略（共 ' +
                listable +
                ' 个内容区元素）。要看元素请调大 maxChars，或用 find_text 按文本找。]'
            : '[note: 交互索引只列出前 ' +
                shown.length +
                ' 个（共 ' +
                listable +
                ' 个内容区元素），其余已省略；要按文本找元素用 find_text。]'
        );
      }
    }

    // —— 表格 ——
    if (tables.length > 0) {
      push('## 表格');
      tables.forEach((t) => {
        push(
          '  - ' +
            t.selector +
            '  ' +
            t.rowCount +
            ' 行' +
            (t.headers ? '  表头: ' + t.headers.join(' | ') : '')
        );
        (t.sample || [])
          .slice(0, level.tblRows)
          .forEach((row, ri) =>
            push(
              '      ' +
                (ri === 0 ? '首行' : '第 2 行') +
                ': ' +
                row.join(' | ')
            )
          );
      });

      if (tables.some((t) => (t.sample || []).length > level.tblRows))
        push('[note: 表格样例已按预算减到 ' + level.tblRows + ' 行。]');
    }

    // —— 接口 ——
    if (net.length > 0) {
      push(
        '## 页面请求过的接口（抓列表时用 automaFetch 直连通常比解析 DOM 更快更稳' +
          (net.total > net.length
            ? '；本档只统计前 ' + net.length + ' 条'
            : '') +
          '）'
      );
      net
        .slice(0, level.netLimit)
        .forEach((n) => push('  ' + n.type + ' ' + n.path));
      if (net.length > level.netLimit)
        push(
          '[note: 接口清单只列出前 ' +
            level.netLimit +
            ' 条（本档收集到 ' +
            net.length +
            ' 条）。]'
        );
    }

    // —— 框架数据 ——
    if (fw.length > 0) {
      push('## 页面框架数据');
      fw.forEach((f) =>
        push(
          '- ' + f.global + '（' + f.framework + '）keys: ' + f.keys.join(', ')
        )
      );
    }

    // —— 警告（永不砍：漏掉它模型会去抓抓不全的 DOM）——
    if (virtualList) {
      push('## 警告');
      push(virtualList.note);
    }

    // —— 可见正文（可再生，排在地址之后）——
    if (hasText) {
      if (level.textChars > 0) {
        push(
          '## 可见文本' +
            (visibleText.length > level.textChars
              ? '（已截断，全文 ' + visibleText.length + ' 字）'
              : '') +
            '：'
        );
        push(visibleText.slice(0, level.textChars) || '(空)');
      } else {
        push(
          '[note: 可见文本已按预算省略（全文 ' +
            visibleText.length +
            ' 字）；要看正文请调大 maxChars。]'
        );
      }
    }

    // —— HTML（可再生，排最后）——
    if (detail === 'full') {
      if (level.htmlChars > 0) {
        push('## 完整 HTML（截断）');
        push(html.slice(0, level.htmlChars));
      } else {
        push(
          '[note: HTML 片段已按预算省略（全文 ' +
            html.length +
            ' 字）；要看 HTML 请调大 maxChars。]'
        );
      }
    }

    push('</page>');

    return out.join('\n');
  };

  let chosen = null;
  for (let i = 0; i < BUDGET_LADDER.length; i += 1) {
    const s = render(BUDGET_LADDER[i]);
    if (s.length <= maxChars) {
      chosen = s;
      break;
    }
  }

  if (chosen === null) {
    chosen = hardTruncate(
      render(BUDGET_LADDER[BUDGET_LADDER.length - 1]),
      maxChars
    );
  }

  return { text: chosen, fingerprint };
}
