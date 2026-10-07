/**
 * 生产 loop：任务中插话（原 live-p3 [2]）。
 *
 * 验的是「工具执行完的下一步把插话送达，模型按插话修正答案」。
 * 答案是否含 14 记 soft —— 模型可能答「14 元」也可能答「十四」。
 */
import { AGENT_EVENTS, textOf } from '../harness.mjs';

export default {
  id: 'agent/interjection',
  title: '生产 loop：任务中插话被采纳',
  layer: 'loop',
  async run({ config, makeAgent, check, skipIfRateLimited }) {
    let drained = false;
    const drainInstructions = () => {
      if (drained) return [];

      drained = true;

      return ['用户插话：把刚才查到的数字乘以 2 再作为最终答案告诉我。'];
    };

    const priceTool = {
      name: 'get_price',
      class: 'read',
      group: 'context',
      ctx: [],
      description: '查询商品单价。测试桩，返回 7。',
      parameters: { type: 'object', properties: {} },
      execute: async () => '单价: 7 元',
    };

    const events = [];
    const { agent } = await makeAgent({
      config,
      tools: [priceTool],
      drainInstructions,
    });

    const ret = await agent.send({
      userText: '调用 get_price 查一下单价，然后告诉我数字。',
      onEvent: (e) => events.push(e),
    });

    if (skipIfRateLimited(check, ret)) return;

    const injected = events.find(
      (e) => e.kind === AGENT_EVENTS.USER_MESSAGE && e.text.includes('乘以 2')
    );
    const answer = textOf(events);

    check.hard(
      ret.kind === AGENT_EVENTS.DONE,
      `未正常收尾: ${JSON.stringify(ret)}`
    );
    check.hard(Boolean(injected), '插话没有被送达（没有 USER_MESSAGE 事件）');
    check.soft(
      /14/.test(answer),
      `插话送达了但模型没采纳。回答: ${answer.trim().slice(0, 80)}`
    );
  },
};