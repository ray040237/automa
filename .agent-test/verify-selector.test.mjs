/**
 * 「验证选择器」高亮对齐的真实浏览器断言（playwright + 本机 Chrome）。
 *
 * 回归的是这个 bug：多选时高亮框整体偏离元素。根因是
 * scrollIntoView({ behavior: 'smooth' }) 还没滚完就取 getBoundingClientRect()，
 * 详见 src/content/highlightElements.js 头注释。
 *
 * 这里不复刻实现，直接加载 src/content/highlightElements.js 源码本身，
 * 在真实滚动中量「高亮框 y」与「元素实际 y」的差值 —— 修好前实测差 3314px。
 *
 * 跑法：npm run test:dom
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleSrc = readFileSync(
  path.join(here, '../src/content/highlightElements.js'),
  'utf8'
);

const HTML = `<!doctype html><html><head><style>
body { margin: 0; }
.card { height: 120px; border: 1px solid #ccc; box-sizing: border-box; }
</style></head><body>
<div id="wrap"></div>
<script>
// IIFE：setContent 会复用同一个 document，顶层 const 会二次声明直接抛错
(() => {
  const wrap = document.getElementById('wrap');
  for (let i = 0; i < 40; i++) {
    const d = document.createElement('div');
    d.className = 'card';
    d.id = 'card-' + i;
    d.textContent = 'card ' + i;
    wrap.appendChild(d);
  }
})();
</script>
</body></html>`;

const OVERLAY = 'div[style*="99999"]';
const FIRST_RECT = `${OVERLAY} svg rect`;

let browser;
let page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
});

after(async () => {
  await browser.close();
});

/** 灌页面 + 把 highlightElements 模块挂到 window。 */
async function boot() {
  await page.setContent(HTML, { waitUntil: 'load' });
  await page.addScriptTag({
    content: `${moduleSrc}\nwindow.__highlightElements = highlightElements;\nwindow.__waitScrollEnd = waitScrollEnd;\n`,
    type: 'module',
  });
  await page.waitForFunction(() => typeof window.__highlightElements === 'function');

  // 夹具脚本没跑起来就报错，别让后面的断言在空页面上"通过"
  const cardCount = await page.evaluate(
    () => document.querySelectorAll('.card').length
  );
  assert.equal(cardCount, 40, '夹具页面应有 40 个 .card');
}

/** 量每个高亮框的 y 与对应元素实际 y 的差。 */
function sample(selector) {
  return page.evaluate((sel) => {
    const svg = document.querySelector('div[style*="99999"] svg');
    if (!svg) return null;

    const rects = Array.from(svg.querySelectorAll('rect'));
    const els = Array.from(document.querySelectorAll(sel));
    const deltas = rects.map((rect, index) =>
      Number((Number(rect.getAttribute('y')) - els[index].getBoundingClientRect().top).toFixed(2))
    );

    return {
      count: rects.length,
      elCount: els.length,
      deltas,
      maxAbs: Math.max(...deltas.map(Math.abs)),
    };
  }, selector);
}

describe('highlightElements', () => {
  test('多选：平滑滚动结束后才取坐标，高亮框与元素对齐', async () => {
    await boot();

    // 滚到页面最底部 —— 第一个匹配元素在页面最顶部，滚动距离拉满
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    const scrollAtStart = await page.evaluate(() => window.scrollY);

    const done = page.evaluate(() =>
      window.__highlightElements(document.querySelectorAll('.card'), { duration: 2500 })
    );

    await page.waitForFunction(
      (sel) => !!document.querySelector(sel),
      FIRST_RECT,
      { timeout: 10000 }
    );

    // 绘制那一刻滚动必须已经停了：此刻 scrollY 应等于稍后（遮罩存续中）的 scrollY
    const scrollAtDraw = await page.evaluate(() => window.scrollY);
    await page.waitForTimeout(400);
    const scrollLater = await page.evaluate(() => window.scrollY);

    const result = await sample('.card');

    assert.equal(result.count, 40, '应画出 40 个高亮框');
    assert.equal(result.elCount, 40);
    assert.ok(
      scrollAtStart - scrollAtDraw > 1000,
      `平滑滚动确实发生了（起点 ${scrollAtStart} → 绘制时 ${scrollAtDraw}）`
    );
    assert.equal(
      scrollAtDraw,
      scrollLater,
      `绘制时滚动应已停止，绘制时 ${scrollAtDraw} vs 400ms 后 ${scrollLater}`
    );
    assert.ok(
      result.maxAbs <= 1,
      `高亮框与元素最大偏差应 <=1px，实测 ${result.maxAbs}px（偏差 ${result.deltas.slice(0, 4).join(', ')}…）`
    );

    await done;
    assert.equal(
      await page.evaluate((sel) => !!document.querySelector(sel), OVERLAY),
      false,
      '遮罩应在 duration 后被移除'
    );
  });

  test('遮罩存续期间页面再滚动，高亮框跟随元素', async () => {
    await boot();

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);

    const done = page.evaluate(() =>
      window.__highlightElements(document.querySelectorAll('.card'), { duration: 2500 })
    );

    await page.waitForFunction((sel) => !!document.querySelector(sel), FIRST_RECT, {
      timeout: 10000,
    });

    await page.evaluate(() => window.scrollBy(0, 900));
    await page.waitForTimeout(300);

    const result = await sample('.card');

    assert.ok(
      result.maxAbs <= 1,
      `滚动后高亮框仍应对齐元素，实测最大偏差 ${result.maxAbs}px`
    );

    await done;
  });

  test('单选：同样对齐', async () => {
    await boot();

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);

    const done = page.evaluate(() =>
      window.__highlightElements([document.querySelector('#card-30')], { duration: 2000 })
    );

    await page.waitForFunction((sel) => !!document.querySelector(sel), FIRST_RECT, {
      timeout: 10000,
    });

    const result = await sample('#card-30');

    assert.equal(result.count, 1);
    assert.ok(result.maxAbs <= 1, `单选最大偏差 ${result.maxAbs}px`);

    await done;
  });

  test('waitScrollEnd 只在滚动真正停下后 resolve', async () => {
    await boot();

    const res = await page.evaluate(async () => {
      const el = document.querySelector('#card-0');
      const settled = window.__waitScrollEnd(document);

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });

      const before = window.scrollY;
      await settled;
      const after = window.scrollY;

      await new Promise((resolve) => {
        setTimeout(resolve, 400);
      });

      return { before, after, later: window.scrollY };
    });

    assert.ok(res.before - res.after > 1000, `resolve 时已完成滚动（${res.before} → ${res.after}）`);
    assert.equal(res.after, res.later, `resolve 之后不应再滚动（${res.after} vs ${res.later}）`);
  });

  test('空元素列表：直接返回，不插遮罩', async () => {
    await boot();

    await page.evaluate(() => window.__highlightElements([], { duration: 100 }));

    assert.equal(
      await page.evaluate((sel) => !!document.querySelector(sel), OVERLAY),
      false
    );
  });
});
