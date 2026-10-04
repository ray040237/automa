/**
 * T-40 探针：test_js round trip 挂死复现（用户实测 channel.send 后无 reply）。
 * 用用户的原始代码（无死循环，毫秒级应返回），测冷启动/热状态两种情形。
 */
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const extPath = resolve('D:/project/automa/build');

const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
console.log('[t40] ext', extId);

const target = await ctx.newPage();
await target.goto('https://books.toscrape.com/', { waitUntil: 'load', timeout: 30000 });
console.log('[t40] target up:', await target.title());

const sender = await ctx.newPage();
await sender.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
const tabId = await sender.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, 'https://books.toscrape.com/*');
console.log('[t40] tabId', tabId);

// 用户的原始代码（截断处按最自然的补全）
const CODE = `JSON.stringify((() => {
  const books = [];
  document.querySelectorAll('li.col-xs-6.col-sm-4').forEach(item => {
    const titleEl = item.querySelector('h3 > a');
    if (titleEl) {
      books.push({
        title: titleEl.getAttribute('title'),
        href: titleEl.getAttribute('href')
      });
    }
  });
  return books;
})())`;

async function sendRunJs(ms) {
  return sender.evaluate(
    async ({ tabId, code, ms }) => {
      const timer = new Promise((r) => setTimeout(() => r({ __hung: true }), ms));
      const send = chrome.runtime
        .sendMessage({ name: 'background--agent:run-js', data: { tabId, code } })
        .then(
          (v) => ({ __settled: true, value: v }),
          (e) => ({ __settled: true, error: String(e && e.message).slice(0, 100) })
        );
      return Promise.race([send, timer]);
    },
    { tabId, code: CODE, ms }
  );
}

// 热状态第一发
let t0 = Date.now();
let r = await sendRunJs(25000);
console.log('[1] 热状态:', JSON.stringify(r).slice(0, 130), `(${Date.now() - t0}ms)`);

// 连发第二次
t0 = Date.now();
r = await sendRunJs(25000);
console.log('[2] 连发:', JSON.stringify(r).slice(0, 130), `(${Date.now() - t0}ms)`);

// 冷启动：等 35s 让 SW 进入空闲，再发（用户场景里 agent 常隔一阵才点确认）
console.log('[t40] 等待 35s 让 SW 空闲…');
await new Promise((r2) => setTimeout(r2, 35000));
t0 = Date.now();
r = await sendRunJs(40000);
console.log('[3] 冷启动后:', JSON.stringify(r).slice(0, 130), `(${Date.now() - t0}ms)`);

await ctx.close().catch(() => {});
process.exit(0);
