/**
 * 装配层：整条链路纯对话（原 live-assembly [1]）。
 *
 * 走的是 `createAgentRuntime`（Agent.vue 真正调的那个），因此覆盖
 * collectPromptFacts → buildSystemPrompt → 工具表过滤 → preStepNotice
 * → window 裁剪 → pi streamFn → sessionStore 落盘 这一整条。
 */
import { AGENT_EVENTS, textOf } from '../harness.mjs';

export const PAGE_TEXT = [
  '## 页面标题',
  '示例商城 - 商品列表',
  '## 正文',
  '共 3 件商品，价格分别为 9.9、19.9、29.9。',
  '## 交互元素',
  '1. <a #item-1> 商品一',
  '2. <a #item-2> 商品二',
  '3. <button #buy> 加入购物车',
].join('\n');

export const TABS = [
  {
    id: 7,
    url: 'https://shop.example.com/list',
    title: '商品列表',
    windowId: 1,
  },
];

export default {
  id: 'assembly/chat',
  title: '装配层：整条链路纯对话',
  layer: 'assembly',
  async run({ configDoc, setupAssembly, check, skipIfRateLimited }) {
    const a = await setupAssembly({ doc: configDoc, tabs: TABS, pageText: PAGE_TEXT });
    const runtime = a.makeRuntime();
    const events = [];

    let ret;

    try {
      ret = await runtime.send({
        userText: '用一句话回答：1+1 等于几？',
        onEvent: (e) => events.push(e),
      });
    } catch (err) {
      check.hard(false, `send 抛异常: ${err && err.stack}`);

      return;
    }

    if (skipIfRateLimited(check, ret)) return;

    const text = textOf(events).trim();

    check.hard(
      ret.kind === AGENT_EVENTS.DONE,
      `未正常收尾: ${JSON.stringify(ret)}`
    );
    check.soft(Boolean(text), '收尾了但没有文本输出');
  },
};