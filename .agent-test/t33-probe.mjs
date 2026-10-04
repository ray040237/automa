/**
 * T-33 验收探针（一次性）：复现「同意注入代码后 agent 永久卡死」的完整链路。
 * 前提：build/ 已含 T-29/T-30 修复（executeScript 15s 超时）。
 * 验证：test_js 注入死循环 → executeScript 15s 超时返回（T-30 生效）
 *       → 同页 tabs.sendMessage(agent:read-page) → 永不 settle（T-33 坐实）
 */
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { createServer } from 'node:http';

const extPath = resolve('D:/project/automa/build');
const server = createServer((_req, res) => res.end('<html><title>t33</title></html>'));
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
console.log('[t33] target tabId =', tabId);

// —— 第 1 步：对照组，健康页面 read_page 消息应快速返回 ——
const healthy = await sender.evaluate(async ({ tabId, ms }) => {
  const timer = new Promise((r) => setTimeout(() => r({ __hung: true }), ms));
  const send = chrome.tabs
    .sendMessage(tabId, { type: 'agent:read-page', op: 'read', detail: 'summary' })
    .then((v) => ({ __settled: true, len: JSON.stringify(v).length }), (e) => ({ __settled: true, error: String(e && e.message).slice(0, 80) }));
  return Promise.race([send, timer]);
}, { tabId, ms: 8000 });
console.log('[1] 健康页 read_page:', JSON.stringify(healthy).slice(0, 140));

// —— 第 2 步：test_js 注入同步死循环（走 background --agent:run-js，T-30 应在 15s 兜底）——
const t0 = Date.now();
const blocked = await sender.evaluate(async ({ tabId, ms }) => {
  const timer = new Promise((r) => setTimeout(() => r({ __hung: true }), ms));
  const send = chrome.runtime
    .sendMessage({ name: 'background--agent:run-js', data: { tabId, code: '(()=>{for(;;);})()' } })
    .then((v) => ({ __settled: true, value: v }), (e) => ({ __settled: true, error: String(e && e.message).slice(0, 80) }));
  return Promise.race([send, timer]);
}, { tabId, ms: 22000 });
console.log('[2] 注入死循环:', JSON.stringify(blocked).slice(0, 160), `(${Date.now() - t0}ms)`);

// —— 第 3 步：页已被占死，read_page 的 tabs.sendMessage 是否永不 settle ——
const t1 = Date.now();
const hung = await sender.evaluate(async ({ tabId, ms }) => {
  const timer = new Promise((r) => setTimeout(() => r({ __hung: true }), ms));
  const send = chrome.tabs
    .sendMessage(tabId, { type: 'agent:read-page', op: 'read', detail: 'summary' })
    .then((v) => ({ __settled: true, len: JSON.stringify(v).length }), (e) => ({ __settled: true, error: String(e && e.message).slice(0, 80) }));
  return Promise.race([send, timer]);
}, { tabId, ms: 15000 });
console.log('[3] 占死后 read_page:', JSON.stringify(hung), `(${Date.now() - t1}ms)`);

console.log(hung.__hung === true ? '[t33] T-33 坐实：tabs.sendMessage 永久挂起' : '[t33] 未复现挂起，需另行排查');
await ctx.close().catch(() => {});
server.close();
process.exit(0);
