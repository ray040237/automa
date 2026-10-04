/**
 * T-29 / T-30 修复验收探针（真 Chromium + build/ 扩展，一次性脚本）。
 * 走完整 wire：扩展页 → background --agent:run-js → executeScript(MAIN)。
 */
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { createServer } from 'node:http';

const extPath = resolve('D:/project/automa/build');
const server = createServer((_req, res) =>
  res.end('<html><head><title>probe-target</title></head><body>hi</body></html>')
);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const targetUrl = `http://127.0.0.1:${server.address().port}/`;

const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;

const target = await ctx.newPage();
await target.goto(targetUrl, { waitUntil: 'load' });

const sender = await ctx.newPage();
await sender.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
const tabId = await sender.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, targetUrl);

async function sendRunJs(code, ms) {
  return sender.evaluate(
    async ({ tabId, code, ms }) => {
      const timer = new Promise((resolve) => setTimeout(() => resolve({ __hung: true }), ms));
      const send = chrome.runtime
        .sendMessage({ name: 'background--agent:run-js', data: { tabId, code } })
        .then((v) => ({ __settled: true, value: v }), (e) => ({ __settled: true, error: String(e && e.message) }));
      return Promise.race([send, timer]);
    },
    { tabId, code, ms }
  );
}

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};

{
  const t0 = Date.now();
  const r = await sendRunJs('1+1', 8000);
  check('T-29: 1+1 → ok:true "2"', r.__settled && r.value && r.value.ok === true && r.value.value === '2', `${JSON.stringify(r).slice(0, 120)} (${Date.now() - t0}ms)`);
}
{
  const r = await sendRunJs('document.title', 8000);
  check('T-29: document.title → probe-target', r.__settled && r.value && r.value.ok && r.value.value.includes('probe-target'), JSON.stringify(r).slice(0, 120));
}
{
  const r = await sendRunJs('(() => ({n: 1, arr: [1, 2]}))()', 8000);
  check('T-29: 对象字面量 JSON 回传', r.__settled && r.value && r.value.value === '{"n":1,"arr":[1,2]}', JSON.stringify(r).slice(0, 120));
}
{
  const t0 = Date.now();
  const r = await sendRunJs('new Promise(() => {})', 13000);
  check('页内 10s 超时兜住「忘 resolve 的 Promise」', r.__settled && r.value && r.value.ok === false && r.value.error.includes('执行超时（10s）'), `${JSON.stringify(r).slice(0, 120)} (${Date.now() - t0}ms)`);
}
{
  const t0 = Date.now();
  const r = await sendRunJs('(() => { for(;;); })()', 25000);
  check('T-30: 同步死循环 → 15s 硬超时返回错误，不再永久挂死', r.__settled && r.value && r.value.ok === false && r.value.error.includes('页面执行超时'), `${JSON.stringify(r).slice(0, 140)} (${Date.now() - t0}ms)`);
}
{
  const r = await sender.evaluate(async (ms) => {
    const timer = new Promise((resolve) => setTimeout(() => resolve({ __hung: true }), ms));
    const send = chrome.runtime
      .sendMessage({ name: 'background--agent:run-js', data: { tabId: 99999999, code: '1+1' } })
      .then((v) => ({ __settled: true, value: v }), (e) => ({ __settled: true, error: String(e && e.message) }));
    return Promise.race([send, timer]);
  }, 8000);
  check('坏 tabId 仍立即报错', r.__settled === true, JSON.stringify(r).slice(0, 120));
}

console.log(failures === 0 ? '[probe] ALL PASS' : `[probe] ${failures} failure(s)`);
await ctx.close().catch(() => {});
server.close();
process.exit(failures === 0 ? 0 : 1);
