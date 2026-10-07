/**
 * 生产 loop：read_page 工具闭环 + untrusted 包装（原 agent-live [2]）。
 *
 * 这条覆盖的是「模型发起 tool call → loop 执行 → 结果回传 → 模型给最终答案」。
 * 注：旧脚本里「打 provider 原始 tool-call 分片」的诊断已随 ADR 0004 删除 ——
 * 分片解析归 pi 内部，我们侧不再有观察对象。
 */
import {
  AGENT_EVENTS,
  TOOL_STATUS,
  textOf,
  toolResultsOf,
} from '../harness.mjs';

const CANNED_PAGE = [
  '## 正文',
  'Example Domain：这是一个用来测试的静态页面。',
  '## 交互元素',
  '1. <a #home> 首页',
  '2. <button #buy> 购买',
].join('\n');

const readPageTool = {
  name: 'read_page',
  class: 'read',
  group: 'page',
  ctx: [],
  description: '读取目标页结构。测试桩。',
  parameters: { type: 'object', properties: {} },
  execute: async () => CANNED_PAGE,
};

export default {
  id: 'agent/tool-loop',
  title: '生产 loop：read_page 工具闭环 + untrusted 包装',
  layer: 'loop',
  async run({ config, makeAgent, check, skipIfRateLimited }) {
    const events = [];
    const { agent } = await makeAgent({
      config,
      tools: [readPageTool],
    });

    const ret = await agent.send({
      userText:
        '请先调用 read_page 工具看一眼页面内容，然后告诉我页面上有几个交互元素。不要编造。',
      onEvent: (e) => events.push(e),
    });

    if (skipIfRateLimited(check, ret)) return;

    const results = toolResultsOf(events);
    const text = textOf(events).trim();

    check.hard(
      ret.kind === AGENT_EVENTS.DONE,
      `未正常收尾: ${JSON.stringify(ret)}`
    );

    if (results.length === 0) {
      check.hard(false, `模型没有调用工具。最终文本: ${text.slice(0, 100)}`);

      return;
    }

    const okRes = results.find((r) => r.status === TOOL_STATUS.OK);

    check.hard(
      Boolean(okRes),
      `工具结果状态异常: ${results.map((r) => r.status).join(',')}`
    );
    check.hard(Boolean(text), '工具执行后模型没有给出最终回答');

    if (okRes) {
      check.hard(
        String(okRes.observation).includes('<untrusted_page_content>'),
        '页面类工具结果没有用 untrusted_page_content 包装'
      );
    }
  },
};