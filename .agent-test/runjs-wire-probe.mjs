/**
 * T-28 后续排查探针（一次性，不进 CI）。
 *
 * 把 build/ 当真实扩展加载进 Chromium，从扩展页直接发 background--agent:run-js
 * 消息，实测「确认后卡死」是不是这条 wire 挂了：
 *   1. 普通只读代码（1+1 / document.title）必须正常返回；
 *   2. 页面同步阻塞代码（while 死循环）—— 预期把 executeScript 挂死，
 *      验证「无超时」假设；
 *   3. 目标页是 chrome:// 或已关闭 tabId —— 看是 reject 还是挂起。
 *
 * 跑法：node --import ../utils/test-loader.mjs .agent-test/runjs-wire-probe.mjs
 * （需本机 Chrome；headless=new 支持扩展）
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const extPath = resolve(here, '../build');

// 本地目标页：host_permissions <all_urls> 覆盖 http://127.0.0.1/*
const server = createServer(
  (
    _req,
    res
  ) => res.end('<html><head><title>probe-target</title></head><body><h1>hi</h1></body></html>')
);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const targetUrl = `http://127.0.0.1:${port}/`;

const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
  ],
});

// 拿扩展 id：等 background service worker 起来
let [sw] = ctx.serviceWorkers();
if (!sw) {
  sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
}
const extId = new URL(sw.url()).host;
console.log(`[probe] extension id = ${extId}`);

// 开目标页
const target = await ctx.newPage();
await target.goto(targetUrl, { waitUntil: 'load' });

ctx.on('close', () => console.log('[probe] context closed unexpectedly'));

// 开扩展的 agent 页作为发送方
const agentPage = await ctx.newPage();
agentPage.on('crash', () => console.log('[probe] agent page CRASHED'));
agentPage.on('pageerror', (e) =>
  console.log('[probe] agent pageerror:', String(e).slice(0, 200))
);
try {
  await agentPage.goto(`chrome-extension://${extId}/newtab.html#/agent`, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
} catch (err) {
  console.log('[probe] agent page goto failed:', String(err).slice(0, 300));
}
await agentPage.waitForTimeout(1500);

const tabId = await agentPage.evaluate(async (url) => {
  const tabs = await chrome.tabs.query({ url });
  return tabs.length ? tabs[0].id : null;
}, `${targetUrl}*`);
console.log(`[probe] target tabId = ${tabId}`);

/** 在扩展页里发一条消息，带硬超时，报告 settle 情况。 */
async function sendRunJs(code, ms) {
  return agentPage.evaluate(
    async ({ tabId, code, ms }) => {
      const timer = new Promise((resolve) =>
        setTimeout(() => resolve({ __hung: true }), ms)
      );
      const send = chrome.runtime
        .sendMessage({ name: 'background--agent:run-js', data: { tabId, code } })
        .then(
          (v) => ({ __settled: true, value: v }),
          (e) => ({ __settled: true, error: String(e && e.message) })
        );
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

// 1. 普通代码：8s 内必须带结果返回
{
  const r = await sendRunJs('1+1', 8000);
  check(
    '普通代码 1+1 正常返回',
    r.__settled && r.value && r.value.ok === true && r.value.value === '2',
    JSON.stringify(r).slice(0, 200)
  );
}

// 2. 读页面标题
{
  const r = await sendRunJs('document.title', 8000);
  check(
    'document.title 返回 probe-target',
    r.__settled && r.value && r.value.ok === true && r.value.value.includes('probe-target'),
    JSON.stringify(r).slice(0, 200)
  );
}

// 3. 页面同步死循环：验证是否把整条链路挂死（无超时假设）
{
  const r = await sendRunJs('while(true){}', 12000);
  check(
    '页面同步死循环会挂死通道（预期 hung，这就是卡死根因）',
    r.__hung === true,
    JSON.stringify(r).slice(0, 200)
  );
}

// 4. 不存在的 tabId：预期立刻 reject/返回错误，不能挂
{
  const r = await sendRunJs.call(null, '1+1', 8000).then(() => null, () => null);
  const r2 = await agentPage.evaluate(async (ms) => {
    const timer = new Promise((resolve) => setTimeout(() => resolve({ __hung: true }), ms));
    const send = chrome.runtime
      .sendMessage({
        name: 'background--agent:run-js',
        data: { tabId: 99999999, code: '1+1' },
      })
      .then(
        (v) => ({ __settled: true, value: v }),
        (e) => ({ __settled: true, error: String(e && e.message) })
      );
    return Promise.race([send, timer]);
  }, 8000);
  check(
    '不存在的 tabId 不挂起（返回错误）',
    r2.__settled === true,
    JSON.stringify(r2).slice(0, 200)
  );
}

console.log(failures === 0 ? '[probe] all pass' : `[probe] ${failures} failure(s)`);

await ctx.close();
server.close();
process.exit(failures === 0 ? 0 : 1);
