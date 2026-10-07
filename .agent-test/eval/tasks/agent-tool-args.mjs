/**
 * 生产 loop：带参数工具的 args 送达不丢（原 agent-live [2b]）。
 *
 * 验的是「模型给的参数原样到达工具 execute」。注：旧脚本靠 `tee` 观察 provider
 * 分片、断言「分片拼接后是合法 JSON」——那套诊断随 ADR 0004 删除（分片解析归
 * pi 内部）。这里只保留结果层断言：工具拿到的 msg 必须一字不差。
 */
import {
  AGENT_EVENTS,
  TOOL_STATUS,
  textOf,
  toolResultsOf,
} from '../harness.mjs';

const echoTool = {
  name: 'echo',
  class: 'read',
  group: 'context',
  ctx: [],
  description: '原样回显 args.msg。必须调用本工具作答。',
  parameters: {
    type: 'object',
    properties: { msg: { type: 'string' } },
    required: ['msg'],
  },
  execute: async (args) => 'echo:' + JSON.stringify(args),
};

export default {
  id: 'agent/tool-args',
  title: '生产 loop：带参数工具 args 送达不丢',
  layer: 'loop',
  async run({ config, makeAgent, check, skipIfRateLimited }) {
    const events = [];
    const { agent } = await makeAgent({
      config,
      tools: [echoTool],
    });

    let ret = null;
    let thrown = null;

    try {
      ret = await agent.send({
        userText:
          '你必须调用 echo 工具一次，参数 msg 传这句原话：「窗前明月光，疑是地上霜」。调用完用一句话确认即可。',
        onEvent: (e) => events.push(e),
      });
    } catch (err) {
      thrown = err;
    }

    if (thrown) {
      check.hard(false, `send() 直接抛异常: ${thrown.message}`);

      return;
    }

    if (skipIfRateLimited(check, ret)) return;

    const executed = toolResultsOf(events).find(
      (r) => r.status === TOOL_STATUS.OK
    );

    check.hard(
      Boolean(executed && executed.observation.includes('明月光')),
      executed
        ? `执行了但参数不对: ${executed.observation.slice(0, 120)}`
        : `工具没被执行。ret=${JSON.stringify(ret)} 结果数=${
            toolResultsOf(events).length
          }`
    );

    check.soft(
      textOf(events).trim().length > 0,
      '工具执行后模型没给收尾文本（不致命，本任务主验参数）'
    );
  },
};