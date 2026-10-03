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
async function readOn(html, detail) {
  await page.setContent(html, { waitUntil: 'load' });
  await page.addScriptTag({ content: handlerSrc });

  return page.evaluate((d) => window.__agentReadPage({ detail: d }), detail);
}

/** 只取重复项检测那一段，方便断言。 */
function repeatedSection(out) {
  const i = out.indexOf('## 重复项检测');
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

describe('read_page 的重复项检测', () => {
  test('卡片列表：容器、单项、数量、字段都要对', async () => {
    const out = await readOn('<body>' + CARD_LIST + '</body>', 'summary');
    const rep = repeatedSection(out);

    assert.match(rep, /容器 div\.grid/, '应认出卡片容器');
    assert.match(rep, /× 5/, '应数出 5 张卡');
    assert.match(rep, /字段 title \/ price \/ link/, '应列出每项的字段');
    assert.match(rep, /title="无线鼠标"/, '应给出一条样例');
  });

  test('只有 2 个重复项时不报 —— 阈值 3 是有意的，避免把普通段落当列表', async () => {
    const html =
      '<body><div class="wrap">' +
      '<p class="row">A</p><p class="row">B</p>' +
      '</div></body>';

    const out = await readOn(html, 'summary');
    const rep = repeatedSection(out);

    assert.ok(!rep.includes('容器 div\.wrap'), '2 个兄弟不该被当成列表');
  });

  test('嵌套的列表只认最内层那一组，不重复报父容器', async () => {
    const inner =
      '<div class="items">' +
      Array.from({ length: 4 }, (_, i) => '<div class="it">条' + i + '</div>').join('') +
      '</div>';

    const out = await readOn('<body><ul class="outer"><li>' + inner + '</li></ul></body>', 'summary');
    const rep = repeatedSection(out);

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

    const out = await readOn(html, 'summary');

    assert.match(repeatedSection(out), /容器 tbody/);
    assert.match(repeatedSection(out), /× 3/);
  });

  test('空页面不能崩，要给出可读的空结果', async () => {
    const out = await readOn('<body></body>', 'summary');

    assert.match(out, /<page/);
    assert.match(out, /<\/page>/);
  });

  test('页面结构畸形（没包 html/body）也不能抛', async () => {
    const out = await readOn('只有纯文本，没有标签', 'summary');

    assert.match(out, /只有纯文本/);
  });
});

describe('detail 三档的取舍', () => {
  test('summary 不吐交互元素索引', async () => {
    const html = '<body><input id="q" placeholder="搜索"><button>go</button></body>';
    const out = await readOn(html, 'summary');

    assert.ok(!out.includes('交互元素'), 'summary 不该带交互索引');
  });

  test('interactive 带上交互元素索引', async () => {
    const html = '<body><input id="q" placeholder="搜索"><button>go</button></body>';
    const out = await readOn(html, 'interactive');

    assert.match(out, /交互元素/);
    assert.match(out, /#q/);
  });

  test('full 额外带完整 HTML', async () => {
    const out = await readOn('<body><div id="z">x</div></body>', 'full');

    assert.match(out, /完整 HTML/);
  });
});
