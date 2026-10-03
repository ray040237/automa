/**
 * read_page 的 content 侧实现。
 *
 * 通过 src/content/blocksHandler.js 的 require.context 零注册接入：
 *   文件名 handlerAgentReadPage.js -> 去掉 handler 前缀 -> toCamelCase -> agentReadPage
 *   对应 newtab 侧发送的 label: 'agent-read-page'
 *
 * 为什么要有重复项检测（技术方案未覆盖，但对本项目价值最大）：
 * 交互元素索引只能覆盖链接/按钮/输入框，给不出「这页有 20 个 .product_pod，
 * 每项里有 .title 和 .price」这种信息。而后者才是写「循环元素」块需要的。
 * 模型没有它就只能从正文里猜 selector，抓列表的成功率会显著下降。
 *
 * 检测思路：找出「同一父容器下有 >=3 个结构相似子元素」的容器，
 * 为每个这样的容器给出 容器选择器 / 单项选择器 / 每项字段。
 */

const MAX_TEXT_CHARS = 3000;
const MAX_INTERACTIVE = 60;
const MAX_REPEATED = 6;
const MAX_FIELDS_PER_ITEM = 12;
const MIN_REPEAT = 3;
const MAX_DOM_NODES = 40000;

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

    const cls = (
      node.className && typeof node.className === 'string' ? node.className : ''
    )
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);

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
 * 抽一个重复项里的字段：同名 class 的后代元素 + 常见可读属性。
 */
function extractFields(item) {
  const seen = new Map();

  const push = (key, value) => {
    if (!key || seen.size >= MAX_FIELDS_PER_ITEM) return;
    const v = String(value == null ? '' : value)
      .trim()
      .replace(/\s+/g, ' ');
    if (!v || v.length > 160) return;
    if (!seen.has(key)) seen.set(key, v);
  };

  const descendants = item.querySelectorAll('*');
  for (
    let i = 0;
    i < descendants.length && seen.size < MAX_FIELDS_PER_ITEM;
    i += 1
  ) {
    const el = descendants[i];
    if (!isVisible(el)) continue;

    const cls = (
      el.className && typeof el.className === 'string' ? el.className : ''
    )
      .split(/\s+/)
      .filter(Boolean)[0];

    if (cls) {
      if (el.tagName === 'A' && el.getAttribute('href'))
        push(cls, el.getAttribute('href'));
      else push(cls, el.textContent || '');
      continue;
    }

    if (el.tagName === 'IMG' && el.getAttribute('src'))
      push('img', el.getAttribute('src'));
    else if (el.tagName === 'IMG' && el.getAttribute('alt'))
      push('img', el.getAttribute('alt'));
    else if (el.tagName === 'A' && el.getAttribute('href'))
      push('a', el.getAttribute('href'));
    else if (el.tagName === 'TIME' && el.getAttribute('datetime'))
      push('time', el.getAttribute('datetime'));
  }

  return Array.from(seen.entries()).map((e) => ({ field: e[0], sample: e[1] }));
}

/**
 * 重复项检测：遍历所有元素，找同构子元素 >= MIN_REPEAT 的容器。
 */
function detectRepeated(root, budgetNodes) {
  const found = [];
  const all = root.querySelectorAll('body *');
  const limit = Math.min(all.length, budgetNodes);

  for (let i = 0; i < limit && found.length < MAX_REPEATED; i += 1) {
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

    const itemSig = signature(best[0]);

    // 已经有更内层的同构组时跳过外层，避免同一个列表被报很多次
    const dup = found.some((f) =>
      best.some((b) => f.itemSelector === cssPath(b))
    );
    if (dup) continue;

    found.push({
      containerSelector: cssPath(container),
      itemSelector: cssPath(best[0]),
      itemSignature: itemSig,
      count: best.length,
      fields: extractFields(best[0]),
    });
  }

  return found;
}

/**
 * 交互元素索引：链接 / 按钮 / 输入 / 下拉 / 复选。
 */
function collectInteractive(root) {
  const sel =
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]';
  const nodes = Array.from(root.querySelectorAll(sel)).filter(isVisible);

  const out = [];
  for (let i = 0; i < nodes.length && out.length < MAX_INTERACTIVE; i += 1) {
    const el = nodes[i];
    const type = el.tagName.toLowerCase();

    let name = '';
    if (type === 'input') {
      name =
        [
          el.getAttribute('name'),
          el.getAttribute('placeholder'),
          el.getAttribute('aria-label'),
          el.getAttribute('id'),
        ].filter(Boolean)[0] ||
        el.type ||
        '';
    } else {
      name = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (!name)
        name =
          el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    }

    out.push({
      n: out.length + 1,
      tag: type,
      ...(el.getAttribute('type')
        ? { inputType: el.getAttribute('type') }
        : {}),
      ...(name ? { name } : {}),
      ...(el.id ? { id: el.id } : {}),
      selector: cssPath(el),
    });
  }

  if (nodes.length > MAX_INTERACTIVE) {
    out.truncated = true;
    out.total = nodes.length;
  }

  return out;
}

/**
 * 表格结构：表头 + 行数 + 少量样本。
 */
function collectTables(root) {
  const tables = Array.from(root.querySelectorAll('table'))
    .filter(isVisible)
    .slice(0, 4);

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
 */
function collectNetwork(limit) {
  try {
    const entries = performance.getEntriesByType('resource');
    const xhr = entries.filter(
      (e) =>
        ['fetch', 'xmlhttprequest', 'beacon'].indexOf(e.initiatorType) !== -1
    );

    return xhr
      .map((e) => {
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
      })
      .slice(0, limit);
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
 * 入口。
 *
 * @param {{detail?: string, maxChars?: number, budgetNodes?: number}} options
 * @returns {string} 纯文本观察值（由 events.js 包 untrusted 标签）
 */
export default async function readPage(options) {
  const opts = options || {};
  const detail = opts.detail || 'auto';
  const maxChars = opts.maxChars || 8000;
  const budgetNodes = opts.budgetNodes || MAX_DOM_NODES;

  const out = [];
  const push = (s) => out.push(s);

  push(
    '<page url="' +
      String(window.location.href).split('"')[0] +
      '"' +
      ' title="' +
      String(document.title || '').split('"')[0] +
      '"' +
      ' lang="' +
      String(document.documentElement.lang || '') +
      '">'
  );

  // —— 正文 ——
  let text = '';
  try {
    text = (
      document.body && document.body.innerText ? document.body.innerText : ''
    )
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch (e) {
    text = '';
  }

  if (detail !== 'interactive') {
    const slice = text.slice(0, MAX_TEXT_CHARS);
    push(
      '## 可见文本' +
        (text.length > MAX_TEXT_CHARS
          ? '（已截断，全文 ' + text.length + ' 字）'
          : '') +
        '：'
    );
    push(slice || '(空)');
  }

  // —— 重复项检测 ——
  // 这是本工具最有价值的部分：直接告诉模型列表长什么样、每项有哪些字段，
  // 而不是让它从正文里猜 selector。
  let repeated = [];
  let virtualList = null;

  if (detail === 'auto' || detail === 'interactive' || detail === 'summary') {
    try {
      repeated = detectRepeated(
        document.body || document.documentElement,
        budgetNodes
      );
      virtualList = detectVirtualList(
        document.body || document.documentElement
      );
    } catch (e) {
      repeated = [];
    }
  }

  if (repeated.length > 0) {
    push('## 重复项检测（写「循环元素」块时直接用这些选择器）');
    repeated.forEach((r) => {
      push('- 容器 ' + r.containerSelector);
      push('  单项 ' + r.itemSelector + '  × ' + r.count);
      if (r.fields.length > 0) {
        push('  字段 ' + r.fields.map((f) => f.field).join(' / '));
        push(
          '  样例 ' +
            r.fields.map((f) => f.field + '="' + f.sample + '"').join(' ')
        );
      }
    });
  } else {
    push('## 重复项检测');
    push(
      '未发现 3 个以上结构相同的兄弟元素。这页可能不是列表页，或是虚拟列表。'
    );
  }

  if (virtualList) {
    push('## 警告');
    push(virtualList.note);
  }

  if (detail === 'interactive' || detail === 'auto' || detail === 'full') {
    // —— 交互元素索引 ——
    let interactive = [];
    try {
      interactive = collectInteractive(
        document.body || document.documentElement
      );
    } catch (e) {
      interactive = [];
    }

    const idx = out.join('\n').length;

    if (detail === 'auto' && idx > maxChars) {
      push('');
      push(
        '[note: 正文与重复项检测已超出预算，已降级为摘要模式。要看交互元素请显式请求 detail=interactive]'
      );
    } else if (interactive.length > 0) {
      push(
        '## 交互元素索引（共 ' +
          (interactive.total || interactive.length) +
          ' 个' +
          (interactive.truncated ? '，已截断' : '') +
          '）'
      );
      interactive.slice(0, MAX_INTERACTIVE).forEach((e) => {
        push(
          '  [' +
            e.n +
            '] ' +
            e.tag +
            (e.inputType ? '[' + e.inputType + ']' : '') +
            (e.name ? ' "' + e.name + '"' : '') +
            ' -> ' +
            e.selector
        );
      });
    }

    // —— 网络请求 ——
    const net = collectNetwork(12);
    if (net.length > 0) {
      push(
        '## 页面请求过的接口（抓列表时用 automaFetch 直连通常比解析 DOM 更快更稳）'
      );
      net.forEach((n) => push('  ' + n.type + ' ' + n.path));
    }
  }

  // —— 表格 ——
  if (detail === 'interactive' || detail === 'full') {
    let tables = [];
    try {
      tables = collectTables(document.body || document.documentElement);
    } catch (e) {
      tables = [];
    }
    if (tables.length > 0) {
      push('## 表格');
      tables.forEach((t) => {
        push(
          '- ' +
            t.selector +
            '  ' +
            t.rowCount +
            ' 行' +
            (t.headers ? '  表头: ' + t.headers.join(' | ') : '')
        );
      });
    }
  }

  if (detail === 'interactive' || detail === 'full') {
    const fw = collectFrameworkState();
    if (fw.length > 0) {
      push('## 页面框架数据');
      fw.forEach((f) =>
        push(
          '- ' + f.global + '（' + f.framework + '）keys: ' + f.keys.join(', ')
        )
      );
    }
  }

  if (detail === 'full') {
    push('## 完整 HTML（截断）');
    push(document.documentElement.outerHTML.slice(0, MAX_TEXT_CHARS * 2));
  }

  push('</page>');

  return out.join('\n');
}
