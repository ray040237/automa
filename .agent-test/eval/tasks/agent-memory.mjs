/**
 * 生产 loop：多轮记忆（原 agent-live [5] + 独立脚本 live-memory.mjs）。
 *
 * live-memory.mjs 原本只是把这一段抽出来单跑以省额度 —— 现在用
 * `npm run test:eval -- --only=agent/memory` 即可，不必再单独一个文件。
 *
 * 措辞刻意避开「暗号/密码」：那类字眼会让模型以安全理由拒绝复述，把
 * 「跨轮记忆链路是否通」误判成失败（实测：用「暗号」措辞时模型答
 * 「我没有记录任何暗号」）。这里改成中性的「记住一个购物清单里的词」。
 */
import { AGENT_EVENTS, textOf } from '../harness.mjs';

const SECRET = '菠萝披萨';

export default {
  id: 'agent/memory',
  title: '生产 loop：多轮记忆（initialHistory 续接）',
  layer: 'loop',
  async run({ config, makeAgent, check, skipIfRateLimited }) {
    const events1 = [];
    const a1 = await makeAgent({ config });

    const r1 = await a1.agent.send({
      userText: `我在列购物清单。请把「${SECRET}」这个词记着，只回复"好的"两个字。`,
      onEvent: (e) => events1.push(e),
    });

    if (skipIfRateLimited(check, r1)) return;

    const history = a1.agent.getHistory();

    if (!history.some((e) => e.kind === AGENT_EVENTS.USER_MESSAGE)) {
      check.hard(false, '第一轮结束后历史里没有用户消息');

      return;
    }

    const events2 = [];
    const a2 = await makeAgent({ config });

    const r2 = await a2.agent.send({
      userText: '刚才我让你在购物清单里留意的那个词是什么？直接说出来。',
      initialHistory: history,
      onEvent: (e) => events2.push(e),
    });

    if (skipIfRateLimited(check, r2)) return;

    const text = textOf(events2).trim();

    check.hard(
      text.includes(SECRET),
      `模型没记住暗号。回答: ${text.slice(0, 80)}`
    );
  },
};