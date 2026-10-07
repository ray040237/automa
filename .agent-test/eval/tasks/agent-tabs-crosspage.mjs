/**
 * 生产 loop：跨页取数（原 live-tabs.mjs）。
 *
 * 两个假页面各存一个数字，验模型能否 list_tabs → focus_tab → read_page
 * 跨页把 B 店的 5 取回来。焦点是否真切到 B 页记 hard（这是工具语义），
 * 答案数字记 soft（措辞自由度大）。
 *
 * 只挂这三个真实工具（不是整份 TOOLS）：整份会要求 toolCtx 里备齐画布/背景
 * 等一堆依赖（T-133 的 ctx 校验），与跨页这条无关。工具从各自模块直接拿。
 */
import {
  AGENT_EVENTS,
  TOOL_STATUS,
  textOf,
  toolCallNames,
  toolResultsOf,
} from '../harness.mjs';
import { readPage } from '../../../src/agent/tools/page.js';
import { listTabsTool, focusTabTool } from '../../../src/agent/tools/tabs.js';

const PAGE_TOOLS = [listTabsTool, focusTabTool, readPage];

// 假浏览器：两个页面，A 页库存 3，B 页库存 5
const fakeTabs = new Map([
  [11, { id: 11, url: 'https://shop-a.test/stock', title: 'A店库存页' }],
  [22, { id: 22, url: 'https://shop-b.test/stock', title: 'B店库存页' }],
]);
const pageContent = new Map([
  [11, '## 正文\nA店库存页：苹果（apple）库存 3 件。'],
  [22, '## 正文\nB店库存页：苹果（apple）库存 5 件。'],
]);

export default {
  id: 'agent/tabs-crosspage',
  title: '生产 loop：跨页取数（list_tabs → focus_tab → read_page）',
  layer: 'loop',
  async run({ config, makeAgent, check, defaultFacts, skipIfRateLimited }) {
    let targetTab = { ...fakeTabs.get(11) };
    let pins = [
      { tabId: 11, origin: 'https://shop-a.test', title: 'A店库存页' },
    ];
    let focusedTabId = 11;

    const toolCtx = {
      get pins() {
        return pins;
      },
      listTabs: async () => [
        {
          windowId: 1,
          tabs: [...fakeTabs.values()].map((t) => ({ ...t })),
        },
      ],
      getTab: async (id) => fakeTabs.get(id) || null,
      focusTab: async (tabId) => {
        if (!fakeTabs.has(tabId)) throw new Error('no such tab: ' + tabId);

        targetTab = { ...fakeTabs.get(tabId) };
        focusedTabId = tabId;

        return targetTab;
      },
      createTab: async (url) => {
        const id = Math.max(...fakeTabs.keys()) + 1;

        fakeTabs.set(id, { id, url, title: '新页 ' + id });

        return fakeTabs.get(id);
      },
      addPin: async (pin) => {
        if (!pins.some((p) => p.tabId === pin.tabId)) pins = [...pins, pin];

        focusedTabId = pin.tabId;
      },
      // read_page 直接按当前 targetTab 给桩内容
      readPage: async () =>
        '页面: ' +
        targetTab.title +
        ' (' +
        targetTab.url +
        ')\n' +
        (pageContent.get(targetTab.id) || '(空)'),
      get targetTab() {
        return targetTab;
      },
    };

    const events = [];
    const { agent } = await makeAgent({
      config,
      tools: PAGE_TOOLS,
      toolCtx,
      facts: defaultFacts(PAGE_TOOLS),
      requestConfirmation: async () => ({ approved: true }),
    });

    const ret = await agent.send({
      userText:
        '当前目标页是 A 店的库存页。B 店也有一张库存页开着。请查一下 B 店苹果的库存数量：先 list_tabs 找到 B 店页，focus_tab 切过去，read_page 确认后告诉我数字。',
      targetTab,
      workflowContext: '',
      onEvent: (e) => events.push(e),
    });

    if (skipIfRateLimited(check, ret)) return;

    const used = toolCallNames(events);
    const okResults = toolResultsOf(events).filter(
      (r) => r.status === TOOL_STATUS.OK
    );
    const text = textOf(events).trim();

    check.hard(
      ret.kind === AGENT_EVENTS.DONE,
      `未正常收尾: ${JSON.stringify(ret)}`
    );
    check.hard(okResults.length > 0, `没有成功的工具调用: ${used.join(' -> ')}`);
    check.hard(used.includes('list_tabs'), `没调 list_tabs: ${used.join(' -> ')}`);
    check.hard(used.includes('focus_tab'), `没调 focus_tab: ${used.join(' -> ')}`);
    check.hard(focusedTabId === 22, `焦点没切到 B 页，实为 tabId=${focusedTabId}`);
    check.soft(
      /\b5\b|5 件|库存.*5/.test(text),
      `焦点切对了但答案没说出 5: ${text.slice(0, 120)}`
    );
  },
};