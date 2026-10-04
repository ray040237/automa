/**
 * 一次性探针：确认 detail 各档的分段取舍，重点坐实「detail=full 是否漏掉重复项检测」。
 * 静态阅读 handlerAgentReadPage.js:437 的条件不含 'full'，这里在真 Chromium 里看真实输出。
 * 复现：node .agent-test/full-detail-probe.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const handlerSrc = readFileSync('.agent-test/handler.iife.js', 'utf8');

const HTML =
  '<body><a href="/home">首页</a><button>加入购物车</button>' +
  '<div class="grid">' +
  ['鼠标', '键盘', '显示器', '椅子']
    .map(
      (n, i) =>
        `<div class="card"><h3 class="title"><a href="/p/${i}">${n}</a></h3>` +
        `<span class="price">￥${(i + 1) * 100}</span></div>`
    )
    .join('') +
  '</div></body>';

/** 抽「## 重复项检测」到下一个 ## 之间的内容。 */
function repeatedSection(out) {
  const i = out.indexOf('## 重复项检测');
  if (i === -1) return '(整段不存在)';
  const rest = out.slice(i);
  const j = rest.indexOf('\n## ');
  return (j === -1 ? rest : rest.slice(0, j)).replace(/\n/g, ' | ');
}

const browser = await chromium.launch();
const page = await browser.newPage();

for (const detail of ['summary', 'interactive', 'auto', 'full', 'bogus']) {
  await page.setContent(HTML, { waitUntil: 'load' });
  await page.addScriptTag({ content: handlerSrc });
  const out = await page.evaluate(
    (d) => window.__agentReadPage({ detail: d }),
    detail
  );
  console.log(`--- detail=${detail}  字符=${out.length} ---`);
  console.log('  重复项段: ' + repeatedSection(out));
  console.log(
    '  交互索引: ' +
      (out.includes('交互元素') ? '有' : '无') +
      '   正文: ' +
      (out.includes('## 可见文本') ? '有' : '无') +
      '   完整HTML: ' +
      (out.includes('完整 HTML') ? '有' : '无')
  );
}

await browser.close();
