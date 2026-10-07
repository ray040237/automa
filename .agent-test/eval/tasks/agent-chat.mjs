/** 生产 loop：纯流式对话能正常收尾并给出答案（原 agent-live [1]）。 */
import { AGENT_EVENTS, textOf } from '../harness.mjs';

export default {
  id: 'agent/chat',
  title: '生产 loop：纯流式对话',
  layer: 'loop',
  async run({ config, makeAgent, check, skipIfRateLimited }) {
    const events = [];
    const { agent } = await makeAgent({ config });

    const ret = await agent.send({
      userText: '用一句话回答：1+1 等于几？只回答算式和结果。',
      onEvent: (e) => events.push(e),
    });

    if (skipIfRateLimited(check, ret)) return;

    const text = textOf(events).trim();

    check.hard(
      ret.kind === AGENT_EVENTS.DONE,
      `未正常收尾: ret=${JSON.stringify(ret)}`
    );
    check.soft(/\b2\b/.test(text), `回答里没看到 2: ${text.slice(0, 80)}`);
  },
};