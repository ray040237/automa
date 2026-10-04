/**
 * 一次性探针（二）：
 *  (a) detail=full 在长正文页上，经 events.js 同款 8K 截断后剩下什么、砍掉哪一段；
 *  (b) detail=auto 把 maxChars 逼紧时，是不是砍交互索引、留正文（P5 复现）。
 * 复现：node .agent-test/budget-probe.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { truncateObservation } from '../src/agent/window.js';

const handlerSrc = readFileSync('.agent-test/handler.iife.js', 'utf8');

const LONG_TEXT = Array.from(
  { length: 120 },
  (_, i) => `这是第 ${i} 段正文，用来把可见文本撑到三千字以上。`
).join('\n');

const HTML =
  '<body><a href="/home">首页</a><button>加入购物车</button>' +
  `<p>${LONG_TEXT}</p>` +
  '<div class="grid">' +
  ['鼠标', '键盘', '显示器', '椅子']
    .map(
      (n, i) =>
        `<div class="card"><h3 class="title"><a href="/p/${i}">${n}</a></h3>` +
        `<span class="price">￥${(i + 1) * 100}</span></div>`
    )
    .join('') +
  '</div></body>';

const browser = await chromium.launch();
const page = await browser.newPage();

async function run(opts) {
  await page.setContent(HTML, { waitUntil: 'load' });
  await page.addScriptTag({ content: handlerSrc });
  return page.evaluate((o) => window.__agentReadPage(o), opts);
}

const has = (s, k) => (s.includes(k) ? '有' : '无');

// (a) full 档 + 8K 截断
const fullOut = await run({ detail: 'full' });
const cut = truncateObservation(fullOut);
console.log('=== (a) detail=full ===');
console.log('handler 输出字符:', fullOut.length);
console.log('8K 截断后字符:', cut.text.length, ' truncated =', cut.truncated);
console.log('  截断前 → 正文', has(fullOut, '## 可见文本'), ' 重复项', has(fullOut, '## 重复项检测'), ' 交互索引', has(fullOut, '## 交互元素索引'), ' 完整HTML', has(fullOut, '完整 HTML'));
console.log('  截断后 → 正文', has(cut.text, '## 可见文本'), ' 重复项', has(cut.text, '## 重复项检测'), ' 交互索引', has(cut.text, '## 交互元素索引'), ' 完整HTML', has(cut.text, '完整 HTML'));
console.log('  完整 HTML 段拿到的字符数:', (() => {
  const i = cut.text.indexOf('## 完整 HTML');
  return i === -1 ? 0 : cut.text.length - i;
})());

// (b) auto 档逼紧预算
console.log('\n=== (b) detail=auto 各 maxChars ===');
for (const maxChars of [8000, 4000, 3000, 2000]) {
  const out = await run({ detail: 'auto', maxChars });
  console.log(
    `maxChars=${String(maxChars).padEnd(5)} 输出=${String(out.length).padStart(5)} 字符  正文:${has(
      out,
      '## 可见文本'
    )}  重复项:${has(out, '## 重复项检测')}  交互索引段:${
      // 降级提示里也含「交互元素」四个字，必须按段标题判；has() 返回的是字符串，
      // 直接拿来做三元判断恒为真 —— 这里必须用 includes 的布尔值。
      out.includes('## 交互元素索引') ? '有' : '无'
    }  降级提示:${has(out, '已降级为摘要模式')}`
  );
}

await browser.close();
