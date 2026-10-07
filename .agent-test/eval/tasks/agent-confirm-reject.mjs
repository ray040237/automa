/**
 * 生产 loop：确认门拒绝路径（原 agent-live [3]）。
 *
 * write 工具被用户拒绝后：工具不得执行、要有 REJECTED 结果回传、循环仍能收尾。
 * 这是 ADR 0002「写类工具必过确认门」的端到端断言。
 */
import { AGENT_EVENTS, TOOL_STATUS, textOf, toolResultsOf } from '../harness.mjs';

export default {
  id: 'agent/confirm-reject',
  title: '生产 loop：确认门拒绝（write 工具未执行）',
  layer: 'loop',
  async run({ config, makeAgent, check, skipIfRateLimited }) {
    let executed = false;
    const writeTool = {
      name: 'test_js',
      class: 'write',
      group: 'page',
      ctx: [],
      // T-134：write 类工具必须自带 confirmDetail，否则 validateTools 加载期抛错
      confirmDetail: () => ({ kind: 'js', detail: '' }),
      description: '试跑 JS。测试桩。',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        executed = true;

        return 'ok';
      },
    };

    const events = [];
    const { agent } = await makeAgent({
      config,
      tools: [writeTool],
      requestConfirmation: async () => ({ approved: false }),
    });

    const ret = await agent.send({
      userText: '请调用 test_js 工具一次。',
      onEvent: (e) => events.push(e),
    });

    if (skipIfRateLimited(check, ret)) return;

    const rejected = toolResultsOf(events).find(
      (r) => r.status === TOOL_STATUS.REJECTED
    );

    check.hard(!executed, '拒绝后工具竟然执行了');
    check.hard(
      Boolean(rejected),
      `没有 REJECTED 事件。ret=${JSON.stringify(ret)}`
    );
    check.hard(
      ret.kind === AGENT_EVENTS.DONE,
      `拒绝后循环没收尾: ret=${JSON.stringify(ret)}`
    );
    check.soft(
      textOf(events).trim().length > 0,
      '收尾了但没给用户任何文本'
    );
  },
};