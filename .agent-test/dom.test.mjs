import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const handlerSrc = readFileSync(path.join(here, 'handler.iife.js'), 'utf8');

let browser;
let page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

after(async () => {
  await browser.close();
});

/** 灌一页 HTML，跑 read_page，返回观察值文本。 */
async function readOn(html, detail, opts = {}) {
  await page.setContent(html, { waitUntil: 'load' });
  await page.addScriptTag({ content: handlerSrc });

  const res = await page.evaluate(
    (o) => window.__agentReadPage({ detail: o.detail, maxChars: o.maxChars }),
    { detail, maxChars: opts.maxChars }
  );

  return res.text;
}

/** 跑 find_text，返回观察值文本。 */
async function findOn(html, keyword, limit) {
  await page.setContent(html, { waitUntil: 'load' });
  await page.addScriptTag({ content: handlerSrc });

  const res = await page.evaluate(
    (o) => window.__agentReadPage({ op: 'find-text', keyword: o.keyword, limit: o.limit }),
    { keyword, limit }
  );

  return res.text;
}

/** 只取列表段，方便断言。 */
function listSection(out) {
  const i = out.indexOf('## 列表');
  if (i === -1) return '';

  const rest = out.slice(i);
  const j = rest.indexOf('\n## ');

  return j === -1 ? rest : rest.slice(0, j);
}

/** 只取交互索引段。 */
function interactiveSection(out) {
  const i = out.indexOf('## 可操作元素');
  if (i === -1) return '';

  const rest = out.slice(i);
  const j = rest.indexOf('\n## ');

  return j === -1 ? rest : rest.slice(0, j);
}

const CARD_LIST = [
  '<div class="grid">',
  ...['无线鼠标', '机械键盘', '显示器', '人体工学椅', '扩展坞'].map(
    (n, i) =>
      '<div class="card">' +
      `<h3 class="title">${n}</h3>` +
      `<span class="price">￥${(i + 1) * 100}</span>` +
      `<a class="link" href="/item/${i + 1}">详情</a>` +
      '</div>'
  ),
  '</div>',
].join('');

/** 侧栏导航：10 个链接 + 一个 10 项的列表，全都在 nav 里。 */
const SIDE_NAV = [
  '<nav class="main-nav">',
  ...Array.from({ length: 10 }, (_, i) => `<a href="/p/${i}">页码 ${i}</a>`),
  '</nav>',
].join('');

/** 内容区：70 个按钮（类名各不相同 —— 否则会被列表检测当成 70 条重复项一起折叠）。 */
const BUTTONS_70 = Array.from(
  { length: 70 },
  (_, i) => `<button class="btn-${i}" type="button">按钮${i}</button>`
).join('');

describe('read_page 的列表模式', () => {
  test('卡片列表：容器、单项、条数、字段的取值方式与样例都要对', async () => {
    const out = await readOn('<body>' + CARD_LIST + '</body>', 'addresses');
    const rep = listSection(out);

    assert.match(rep, /容器 div\.grid/, '应认出卡片容器');
    assert.match(rep, /× 5 条/, '应数出 5 张卡');
    assert.match(rep, /字段 h3\.title → 取 text 样例 "无线鼠标"/, '字段要有取值方式与样例');
    assert.match(rep, /字段 span\.price → 取 text 样例 "￥100"/);
    assert.match(
      rep,
      /字段 a\.link → 取 href（相对） 样例 "\/item\/1"/,
      '链接字段要标相对/绝对'
    );
    assert.match(rep, /其余 4 条结构相同/, '要明说其余条目没逐条展开');
  });

  test('只有 2 个重复项时不报 —— 阈值 3 是有意的，避免把普通段落当列表', async () => {
    const html =
      '<body><div class="wrap">' +
      '<p class="row">A</p><p class="row">B</p>' +
      '</div></body>';

    const out = await readOn(html, 'addresses');
    const rep = listSection(out);

    assert.ok(!rep.includes('容器 div\.wrap'), '2 个兄弟不该被当成列表');
  });

  test('嵌套的列表只认最内层那一组，不重复报父容器', async () => {
    const inner =
      '<div class="items">' +
      Array.from({ length: 4 }, (_, i) => `<div class="it">条${i}</div>`).join('') +
      '</div>';

    const out = await readOn(
      '<body><ul class="outer"><li>' + inner + '</li></ul></body>',
      'addresses'
    );
    const rep = listSection(out);

    assert.match(rep, /容器 div\.items/, '应认出内层容器');
    assert.ok(!rep.includes('容器 ul\.outer'), '父容器只包着 1 个 li，不该报成列表');
  });

  test('表格：tbody/tr 是一组，表头不是', async () => {
    const html =
      '<body><table><thead><tr><th>名称</th><th>数量</th></tr></thead>' +
      '<tbody>' +
      '<tr><td>A</td><td>1</td></tr>' +
      '<tr><td>B</td><td>2</td></tr>' +
      '<tr><td>C</td><td>3</td></tr>' +
      '</tbody></table></body>';

    const out = await readOn(html, 'addresses');

    assert.match(listSection(out), /容器 tbody/);
    assert.match(listSection(out), /× 3/);
    assert.match(out, /## 表格/, '表格段要单独给');
    assert.match(out, /首行: A \| 1/, '表格要有样例行');
  });

  test('空页面不能崩，要给出可读的空结果', async () => {
    const out = await readOn('<body></body>', 'addresses');

    assert.match(out, /<page/);
    assert.match(out, /<\/page>/);
    assert.match(out, /未发现/);
  });

  test('页面结构畸形（没包 html/body）也不能抛', async () => {
    const out = await readOn('只有纯文本，没有标签', 'content');

    assert.match(out, /只有纯文本/);
  });

  test('full 档也必须跑列表检测（T-17：旧版 full 会谎报「未发现」）', async () => {
    const out = await readOn('<body>' + CARD_LIST + '</body>', 'full');
    const rep = listSection(out);

    assert.match(rep, /容器 div\.grid/, 'full 档不该跳过列表检测');
    assert.ok(!rep.includes('未发现'), '明明有列表就不能说未发现');
  });

  test('字段取值优先 title 属性，不取被截断的链接文本（R3/P2）', async () => {
    const card = (i) =>
      '<div class="card"><h3><a href="/item/' +
      i +
      '" title="A Light in the Attic">A Light in the Att…</a></h3></div>';

    const out = await readOn(
      '<body><div class="grid">' +
        [1, 2, 3, 4].map(card).join('') +
        '</div></body>',
      'addresses'
    );

    assert.match(
      out,
      /字段 h3 > a → 取 title 属性 样例 "A Light in the Attic"/,
      '真值在 title 属性里'
    );
    assert.match(out, /href（相对） \/item\/1/);
    assert.ok(
      !listSection(out).includes('字段 h3 → 取 text'),
      '包裹层的半截文本不该和 title 里的真值抢位置'
    );
  });

  test('导航/页脚里的列表被折叠，只在「未发现」时说明被折叠了几个', async () => {
    const out = await readOn('<body>' + SIDE_NAV + CARD_LIST + '</body>', 'addresses');
    const rep = listSection(out);

    assert.match(rep, /容器 div\.grid/, '内容区的列表该在');
    assert.ok(!rep.includes('main-nav'), '导航里的列表不占名单');
  });

  test('行内强调片段不算列表，并在跳过时说明原因', async () => {
    // 实测来源：books.toscrape.com 的结果计数器
    // <strong>1000</strong> results - showing <strong>1</strong> to <strong>20</strong>
    const out = await readOn(
      '<body><form class="box"><strong>1000</strong> results - showing ' +
        '<strong>1</strong> to <strong>20</strong>.</form></body>',
      'addresses'
    );
    const rep = listSection(out);

    assert.ok(!rep.includes('容器 form'), '强调片段不该占列表名额');
    assert.match(rep, /未发现/);
    assert.match(rep, /行内强调片段/, '跳过了什么要说出来');
  });
});

describe('detail 四档的取舍', () => {
  const html = '<body><input id="q" placeholder="搜索"><button>go</button></body>';

  test('probe 只给概况：指纹、元素计数，不跑列表检测也不带明细', async () => {
    const out = await readOn(html, 'probe');

    assert.match(out, /detail="probe"/);
    assert.match(out, /## 概览/);
    assert.match(out, /fingerprint="[0-9a-f]{8}"/);
    assert.match(out, /可操作元素 2 个（内容区 2/);
    assert.ok(!out.includes('## 列表'), 'probe 不该跑列表检测');
    assert.ok(!out.includes('## 可见文本'), 'probe 不带正文');
    assert.ok(!out.includes('  [1] '), 'probe 不列交互明细');
    assert.ok(out.length < 600, 'probe 必须便宜：' + out.length);
  });

  test('addresses 带交互索引，但不带正文（默认档）', async () => {
    const out = await readOn(html, 'addresses');

    assert.match(out, /detail="addresses"/);
    assert.match(out, /可操作元素/);
    assert.match(out, /#q/);
    assert.ok(!out.includes('## 可见文本'), '默认档不带正文');
  });

  test('content 在 addresses 之上加正文', async () => {
    const out = await readOn(html, 'content');

    assert.match(out, /## 可见文本/);
    assert.match(out, /搜索/);
    assert.match(out, /可操作元素/, 'content 必须包含 addresses 的全部内容');
  });

  test('full 额外带完整 HTML', async () => {
    const out = await readOn('<body><div id="z">x</div></body>', 'full', {
      // 注入的 handler 本身也算页面 HTML（约 30K），不给足预算砍的会是它自己
      maxChars: 8000,
    });

    assert.match(out, /## 完整 HTML/);
    assert.match(out, /## 可见文本/, 'full 必须包含 content 的全部内容');
  });

  test('未知 detail 明确报错，不静默降级（T-18/F2）', async () => {
    const out = await readOn('<body>' + CARD_LIST + '</body>', 'bogus');

    assert.match(out, /「bogus」不认识/, '要指名道姓');
    assert.match(out, /addresses/, '要把合法值列出来');
    assert.ok(!out.includes('容器 div.grid'), '报错就不该顺带给内容');
  });

  test('addresses 输出必须装进默认预算 6000 字符（F3）', async () => {
    const out = await readOn(
      '<body>' + SIDE_NAV + CARD_LIST + '<p>' + '正文'.repeat(4000) + '</p></body>',
      'addresses'
    );

    assert.ok(out.length <= 6000, out.length + ' <= 6000');
  });

  test('maxChars 逼紧时砍的是明细，列表样例必须还在（T-20/F4）', async () => {
    const out = await readOn(
      '<body>' + CARD_LIST + BUTTONS_70 + '</body>',
      'addresses',
      { maxChars: 1200 }
    );

    assert.ok(out.length <= 1200, '必须尊重预算，实际 ' + out.length);
    assert.ok(out.includes('[note:'), '砍了要说出来，不能静默');
    assert.match(out, /## 列表/, '列表段永不砍');
    assert.match(out, /样例 "无线鼠标"/, '单条样例永不砍');
  });

  test('正文与 HTML 排在地址之后，超预算时先丢它们（段顺序/T-19）', async () => {
    const out = await readOn(
      '<body>' + CARD_LIST + '<p>' + '正文'.repeat(4000) + '</p></body>',
      'content',
      { maxChars: 2500 }
    );

    const listAt = out.indexOf('## 列表');
    const textAt = out.indexOf('## 可见文本');

    assert.ok(listAt !== -1, '列表段要在');
    assert.ok(out.length <= 2500, '必须尊重预算，实际 ' + out.length);
    if (textAt !== -1) assert.ok(listAt < textAt, '地址必须排在正文前面');
  });

  test('HTML 逐级变小而不是 6000 直接跳 0（full 档要真能拿到 HTML）', async () => {
    const out = await readOn(
      '<body>' + CARD_LIST + '</body>',
      'full',
      { maxChars: 5000 }
    );

    assert.ok(out.length <= 5000, '必须尊重预算，实际 ' + out.length);
    assert.match(
      out,
      /## 完整 HTML（截断）/,
      '预算够装下一档 HTML 片段时必须给，否则 detail=full 永远拿不到 HTML'
    );
    assert.match(out, /## 列表/, '列表段永不砍');
  });

  test('连 HTML 片段都装不下时才整体省略，且明说（full 档兜底）', async () => {
    const out = await readOn(
      '<body>' + CARD_LIST + '</body>',
      'full',
      { maxChars: 1200 }
    );

    assert.ok(out.length <= 1200, '必须尊重预算，实际 ' + out.length);
    assert.ok(!out.includes('## 完整 HTML'), '装不下就不该有 HTML 段');
    assert.match(out, /HTML 片段已按预算省略/, '省略必须说出来');
    assert.match(out, /## 列表/, '列表段永不砍');
  });
});

describe('可操作元素索引', () => {
  test('导航折叠后内容区元素排前，且名额被内容区占满（R2/P1）', async () => {
    const out = await readOn(
      '<body>' + SIDE_NAV + BUTTONS_70 + '</body>',
      'addresses'
    );
    const sec = interactiveSection(out);

    assert.match(sec, /内容区 70 个/, '应报出内容区真实数量');
    assert.match(sec, /导航\/页脚 10 个已折叠/, '折叠了几条要说出来');
    assert.ok(
      /\[1\] button(\[button\])? "按钮0"/.test(sec),
      '第一条应该是内容区的，实际:\n' + sec.slice(0, 300)
    );
    assert.ok(!sec.includes('main-nav'), '导航链接不该占索引名额');
    assert.match(sec, /只列出前 60 个（共 70 个内容区元素）/, '截断要显式标注');
  });

  test('列表项内的可操作元素只留第一项那一组，其余折叠并在头里计数', async () => {
    const card = (i) =>
      `<div class="card"><a class="link" href="/p/${i}">详情${i}</a>` +
      '<button class="buy">买</button></div>';

    const out = await readOn(
      '<body><div class="grid">' +
        [1, 2, 3, 4, 5].map(card).join('') +
        '</div></body>',
      'addresses'
    );
    const sec = interactiveSection(out);

    assert.match(out, /列表项内 8 个已折叠（见列表段）/, '折叠量必须报出来');
    assert.match(sec, /"详情1"/, '第一项的元素作为样例留着');
    assert.ok(!sec.includes('"详情2"'), '第二项起不再重复列同构元素');
    assert.ok(!sec.includes('[note: 交互索引只列出前'), '折叠不该被误报成截断');
  });
});

describe('find_text', () => {
  const html =
    '<body><div class="main">' +
    '<ul class="ship"><li>满 39 元免运费</li><li>偏远地区加收</li></ul>' +
    '<p>今天天气不错</p>' +
    '</div></body>';

  test('命中即给出可落盘的 selector 与前后文片段', async () => {
    const out = await findOn(html, '运费');

    assert.match(out, /命中 1 个/);
    assert.match(out, /\[1\] li/, '要给出元素 tag');
    assert.match(out, /\[1\] li  selector \S/, '要给出可落盘的 selector');
    assert.match(out, /片段 .+免运费/, '要给出前后文');
    assert.match(out, /容器 .+ship/, '要给出所在容器');
  });

  test('大小写不敏感、按 limit 截断并说明总数', async () => {
    const out = await findOn(
      '<body>' + '<b>ABC</b>'.repeat(10) + '</body>',
      'abc',
      3
    );

    assert.match(out, /命中 10 个（keyword "abc"，只列出前 3 个）/);
  });

  test('没命中时明说，并提示关键词被标签切开的可能', async () => {
    const out = await findOn(html, '不存在的词');

    assert.match(out, /没有找到/);
    assert.match(out, /切开/);
  });

  test('空 keyword 报错而不是返回整页', async () => {
    const out = await findOn(html, '   ');

    assert.match(out, /keyword 不能为空/);
  });
});
