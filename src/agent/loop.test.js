import test from 'node:test';
import assert from 'node:assert';
import { createAgent, toAgentEvent } from './loop';
import { AGENT_EVENTS, TOOL_STATUS } from './events';
import { wrapUntrusted } from './untrusted';
import { STALE_MARKER } from './window';

/** 把若干轮响应排成队列的假 streamChat，并记录每次收到的参数 */
function fakeStream(turns) {
  const calls = [];
  const fn = async function* streamChat(params) {
    calls.push(params);
    const turn = turns.shift() || [{ type: 'done', stopReason: 'end' }];
    // eslint-disable-next-line no-restricted-syntax
    for (const chunk of turn) yield chunk;
  };
  fn.calls = calls;
  return fn;
}

const text = (t) => ({ type: 'text-delta', text: t });
const call = (index, name, args = {}, id = 'c' + index) => ({
  type: 'tool-call-delta',
  index,
  name,
  argsDelta: JSON.stringify(args),
  id,
});

const echoTool = {
  name: 'echo',
  class: 'read',
  group: 'context',
  description: '回显参数',
  parameters: { type: 'object', properties: {} },
  execute: async (args) => 'echo:' + JSON.stringify(args),
};

const pageTool = {
  name: 'read_page',
  class: 'read',
  group: 'page',
  description: '读页面',
  parameters: { type: 'object', properties: {} },
  execute: async () => '页面正文',
};

const writeTool = {
  name: 'do_write',
  class: 'write',
  group: 'page',
  description: '写东西',
  parameters: { type: 'object', properties: {} },
  execute: async () => '已写入',
};

function makeAgent(turns, opts = {}) {
  const streamChat = fakeStream(turns);
  const events = [];
  const agent = createAgent({
    streamChat,
    promptFacts: () => ({
      automaFuncs: [],
      templatingFns: [],
      blockCount: 0,
      tools: [echoTool],
    }),
    tools: opts.tools || [echoTool],
    wrapUntrusted,
    buildUserMessage: ({ userText }) =>
      wrapUntrusted('untrusted_user_message', userText),
    toolCtx: opts.toolCtx || {},
    requestConfirmation:
      opts.requestConfirmation || (async () => ({ approved: true })),
    log: opts.log,
  });
  return { agent, streamChat, events, onEvent: (e) => events.push(e) };
}

const send = (h, extra = {}) =>
  h.agent.send({
    userText: '你好',
    targetTab: { url: 'https://a.com', title: 'A' },
    onEvent: h.onEvent,
    ...extra,
  });

const of = (h, kind) => h.events.filter((e) => e.kind === kind);

/* ---------------- provider -> agent 事件翻译 ---------------- */

test('toAgentEvent 覆盖全部 provider 事件类型', () => {
  assert.equal(
    toAgentEvent({ type: 'text-delta', text: 'a' }).kind,
    AGENT_EVENTS.TEXT_DELTA
  );
  assert.equal(
    toAgentEvent({ type: 'thinking-delta', text: 'a' }).kind,
    AGENT_EVENTS.THINKING
  );
  assert.equal(
    toAgentEvent({
      type: 'tool-call-delta',
      index: 0,
      name: 'x',
      argsDelta: '{}',
      id: 'i',
    }).kind,
    AGENT_EVENTS.TOOL_CALL
  );
  assert.equal(
    toAgentEvent({ type: 'done', stopReason: 'end' }).kind,
    AGENT_EVENTS.DONE
  );
  assert.equal(
    toAgentEvent({
      type: 'error',
      kind: 'provider',
      message: '触发限流',
    }).kind,
    AGENT_EVENTS.ERROR
  );
  assert.equal(toAgentEvent({ type: '未知' }), null);
});

test('tool-call 的 args 被解析成对象，缺省为空对象', () => {
  const a = toAgentEvent({
    type: 'tool-call-delta',
    index: 0,
    name: 'x',
    argsDelta: '{"a":1}',
    id: 'i',
  });
  assert.deepEqual(a.args, { a: 1 });
  const b = toAgentEvent({
    type: 'tool-call-delta',
    index: 0,
    name: 'x',
    argsDelta: '',
    id: 'i',
  });
  assert.deepEqual(b.args, {});
});

/* ---------------- 主流程 ---------------- */

test('纯文本一轮就结束', async () => {
  const h = makeAgent([[text('hi')]]);
  const done = await send(h);
  assert.equal(of(h, AGENT_EVENTS.START).length, 1);
  assert.equal(of(h, AGENT_EVENTS.TARGET_TAB).length, 1);
  assert.ok(of(h, AGENT_EVENTS.TEXT_DELTA).length > 0);
  assert.equal(done.kind, AGENT_EVENTS.DONE);
  assert.equal(h.streamChat.calls.length, 1);
});

test('用户输入走 untrusted 包装后才进 messages', async () => {
  const h = makeAgent([[text('hi')]]);
  await send(h);
  const userMsg = h.streamChat.calls[0].messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('<untrusted_user_message>'));
});

test('发给模型的 system 不含页面内容', async () => {
  const h = makeAgent([[text('hi')]]);
  await send(h);
  const sys = h.streamChat.calls[0].messages.find((m) => m.role === 'system');
  assert.ok(
    !sys.content.includes('https://a.com'),
    '目标页 URL 不应出现在 system 里'
  );
});

test('tools 以 OpenAI wire 形状下发', async () => {
  const h = makeAgent([[text('hi')]]);
  await send(h);
  const sent = h.streamChat.calls[0].tools;
  assert.equal(sent[0].type, 'function');
  assert.equal(sent[0].function.name, 'echo');
});

test('tool_call -> 执行 -> 再问一轮', async () => {
  const h = makeAgent([[call(0, 'echo', { a: 1 })], [text('好的')]]);
  await send(h);

  assert.equal(h.streamChat.calls.length, 2, '应该问了两轮');
  const res = of(h, AGENT_EVENTS.TOOL_RESULT);
  assert.equal(res.length, 1);
  assert.equal(res[0].status, TOOL_STATUS.OK);
  assert.ok(res[0].observation.includes('echo:'));
});

test('工具结果按 tool 消息回传且 tool_call_id 成对', async () => {
  const h = makeAgent([[call(0, 'echo', {}, 'call-1')], []]);
  await send(h);
  const second = h.streamChat.calls[1];
  const toolMsg = second.messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, '第二轮必须带 tool 消息');
  assert.equal(toolMsg.tool_call_id, 'call-1');
  assert.ok(toolMsg.content.includes('<untrusted_tool_result>'));
});

test('页面类工具结果用 untrusted_page_content 包装', async () => {
  const h = makeAgent([[call(0, 'read_page')], []], { tools: [pageTool] });
  await send(h);
  const res = of(h, AGENT_EVENTS.TOOL_RESULT)[0];
  assert.ok(res.observation.includes('<untrusted_page_content>'));
});

test('非页面类工具用 untrusted_tool_result 包装', async () => {
  const h = makeAgent([[call(0, 'echo')], []]);
  await send(h);
  const res = of(h, AGENT_EVENTS.TOOL_RESULT)[0];
  assert.ok(res.observation.includes('<untrusted_tool_result>'));
  assert.ok(!res.observation.includes('page_content'));
});

test('旧的页面快照在下一步被压成占位符，只保留最近一组（elide 已接线）', async () => {
  const h = makeAgent(
    [
      [call(0, 'read_page', {}, 'r1')],
      [call(0, 'read_page', {}, 'r2')],
      [text('完成')],
    ],
    { tools: [pageTool] }
  );
  await send(h);

  // buildWireMessages 每步现算：第三步的 wire 里必须已经压掉前两步的快照
  const third = h.streamChat.calls[2].messages;
  const toolMsgs = third.filter((m) => m.role === 'tool');

  assert.equal(toolMsgs.length, 2, '两次 read_page 都要有配对的 tool 消息');
  assert.equal(
    toolMsgs[0].content,
    STALE_MARKER,
    '除最近一组外的页面观察值必须被换成占位符'
  );
  assert.ok(
    toolMsgs[1].content.includes('页面正文'),
    '最近一组必须保留真实内容'
  );
  assert.equal(toolMsgs[0].tool_call_id, 'r1', 'tool_call_id 配对不能丢');
});

test('结构化返回被解包：payload 当正文、内层 error 升级、meta 上提', async () => {
  const make = (name, result) => ({
    ...echoTool,
    name,
    execute: async () => result,
  });
  const okTool = make('okTool', {
    status: 'ok',
    payload: '正文只有 63 字符',
  });
  const h = makeAgent([[call(0, 'okTool')], []], { tools: [okTool] });
  await send(h);
  let res = of(h, AGENT_EVENTS.TOOL_RESULT)[0];
  assert.ok(res.observation.includes('正文只有 63 字符'));
  assert.ok(
    !res.observation.includes('"status"'),
    '解包后不能再给模型套一层 JSON'
  );
  assert.equal(res.status, TOOL_STATUS.OK);

  const errTool = make('errTool', {
    status: 'error',
    payload: '选择器不合法：bad [',
  });
  const h2 = makeAgent([[call(0, 'errTool')], []], { tools: [errTool] });
  await send(h2);
  [res] = of(h2, AGENT_EVENTS.TOOL_RESULT);
  assert.equal(res.status, TOOL_STATUS.ERROR, '内层 error 必须升级为事件状态');
  assert.ok(res.observation.includes('工具未成功执行'), '走错误观察值分支');
  assert.ok(res.observation.includes('选择器不合法'));

  const fpTool = make('fpTool', {
    payload: '地址正文',
    pageFingerprint: '9f2c1a4e',
  });
  const h3 = makeAgent([[call(0, 'fpTool')], []], { tools: [fpTool] });
  await send(h3);
  [res] = of(h3, AGENT_EVENTS.TOOL_RESULT);
  assert.equal(res.pageFingerprint, '9f2c1a4e', 'meta 必须上提到事件顶层');
  assert.ok(res.observation.includes('地址正文'));
  assert.ok(!res.observation.includes('9f2c1a4e'), 'meta 不进观察值文本');
});

/* ---------------- 确认门 ---------------- */

test('写类工具必须经过确认', async () => {
  const asked = [];
  const h = makeAgent([[call(0, 'do_write', { code: '1 + 1' })], []], {
    tools: [writeTool],
    requestConfirmation: async (c) => {
      asked.push(c);
      return { approved: true };
    },
  });
  await send(h);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].name, 'do_write');
  // T-27：确认卡要展示的就是这些参数。顶层没有 code，宿主只能从 args 取 ——
  // 这条断言钉住载荷形状，谁再把它裁掉，确认卡就又变成空框了。
  assert.deepEqual(
    asked[0].args,
    { code: '1 + 1' },
    'requestConfirmation 必须带上完整的 args'
  );
});

test('读类工具不问确认', async () => {
  let asked = 0;
  const h = makeAgent([[call(0, 'echo')], []], {
    requestConfirmation: async () => {
      asked += 1;
      return { approved: true };
    },
  });
  await send(h);
  assert.equal(asked, 0);
});

test('用户拒绝时工具绝不能执行，且拒绝原因回给模型', async () => {
  let executed = false;
  const tool = {
    ...writeTool,
    execute: async () => {
      executed = true;
      return 'x';
    },
  };
  const h = makeAgent([[call(0, 'do_write')], []], {
    tools: [tool],
    requestConfirmation: async () => ({ approved: false }),
  });
  await send(h);

  assert.equal(executed, false, '被拒绝的工具绝不能执行');
  const res = of(h, AGENT_EVENTS.TOOL_RESULT)[0];
  assert.equal(res.status, TOOL_STATUS.REJECTED);
  const toolMsg = h.streamChat.calls[1].messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg.content.includes('未成功执行'));
});

/* ---------------- 错误处理 ---------------- */

test('未知工具报明确错误并列出可用工具', async () => {
  const h = makeAgent([[call(0, 'nope')], []]);
  await send(h);
  const res = of(h, AGENT_EVENTS.TOOL_RESULT)[0];
  assert.equal(res.status, TOOL_STATUS.ERROR);
  assert.ok(res.observation.includes('echo'));
});

test('工具抛错不终止循环，转成观察值让模型自纠', async () => {
  const tool = {
    ...echoTool,
    execute: async () => {
      throw new Error('boom');
    },
  };
  const h = makeAgent([[call(0, 'echo')], []], { tools: [tool] });
  await send(h);
  assert.equal(h.streamChat.calls.length, 2, '出错后仍应继续问一轮');
  const res = of(h, AGENT_EVENTS.TOOL_RESULT)[0];
  assert.equal(res.status, TOOL_STATUS.ERROR);
  assert.ok(res.observation.includes('boom'));
});

test('LLM 报错时结束本轮并发 ERROR，不发 DONE', async () => {
  const h = makeAgent([
    [{ type: 'error', kind: 'network', message: '网络断了' }],
  ]);
  const ret = await send(h);
  assert.equal(of(h, AGENT_EVENTS.ERROR).length, 1);
  assert.equal(ret.kind, AGENT_EVENTS.ERROR);
  assert.equal(of(h, AGENT_EVENTS.DONE).length, 0);
});

test('没有 toolCallId 的空转块被跳过', async () => {
  const h = makeAgent([
    [{ type: 'tool-call-delta', index: 0, argsDelta: '' }],
    [],
  ]);
  await send(h);
  assert.equal(of(h, AGENT_EVENTS.TOOL_RESULT).length, 0);
});

test('工具调用不无限循环', async () => {
  const turns = [];
  for (let i = 0; i < 40; i += 1) turns.push([call(i, 'echo')]);
  const h = makeAgent(turns);
  await send(h);
  assert.ok(
    h.streamChat.calls.length <= 12,
    '实际轮数 ' + h.streamChat.calls.length
  );
  assert.equal(of(h, AGENT_EVENTS.DONE).length, 1, '仍然要正常收尾');
});

test('显式传入 system 时不被覆盖', async () => {
  const h = makeAgent([[text('hi')]]);
  await send(h, { system: '我的提示词' });
  const sys = h.streamChat.calls[0].messages.find((m) => m.role === 'system');
  assert.ok(sys.content.includes('我的提示词'));
});

test('未传 system 时按 promptFacts 动态生成', async () => {
  const h = makeAgent([[text('hi')]]);
  await send(h);
  const sys = h.streamChat.calls[0].messages.find((m) => m.role === 'system');
  assert.ok(sys.content.includes('你是 Automa 工作流编辑器的助手'));
});

test('abort 不抛错', async () => {
  const h = makeAgent([[call(0, 'echo')], [text('hi')]]);
  const p = send(h);
  h.agent.abort();
  await p;
  assert.ok(true);
});
test('promptFacts 抛错时降级为空事实，不炸掉整轮对话', async () => {
  const agent = createAgent({
    async *streamChat() {
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'done' };
    },
    promptFacts: () => {
      throw new TypeError('tasks.reduce is not a function');
    },
    tools: [],
  });

  const events = [];

  // 关键契约：整轮不能 reject。用户当时就是被一个 TypeError 打断的。
  await agent.send({
    userText: 'hi',
    onEvent: (e) => events.push(e),
  });

  const got = events
    .filter((e) => e.kind === 'agent:text-delta')
    .map((e) => e.text)
    .join('');

  assert.equal(got, 'ok', '降级后这一轮还是要能正常跑完');
  const errorEv = events.find((e) => e.kind === 'agent:error');
  assert.ok(errorEv, '应发出一条 agent:error');
  assert.ok(
    String(errorEv.message || '').includes('事实表构建失败'),
    '但要如实告诉用户事实表坏了 —— 静默降级等于把问题藏起来'
  );
  assert.equal(
    errorEv.errorKind,
    'internal',
    'T-40：形状必须是 errorEvent() 产出的那一份，errorKind 归入 internal'
  );
});
test('provider 报 429 时，用户看得到服务端说的限流（回归）', async () => {
  // 这条不能再用手写的假 chunk 当夹具 —— 上一版就是这么漏掉的：
  // 夹具按消费方写的形状，生产方根本不产出那个形状。
  // 所以这里让真正的 streamChat 去打一个返回 429 的假服务。
  const real = await import('./llm/providers/openai-compat');

  const events = [];
  const agent = createAgent({
    streamChat: (params) =>
      real.streamChat({
        ...params,
        config: {
          baseUrl: 'https://fake.invalid/v1',
          apiKey: 'sk-x',
          model: 'm',
        },
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '7' },
          }),
        // 退避表已由 provider 层的测试覆盖；这里验的是错误能不能透到 loop，
        // 不注入的话这条要真等 12 秒
        retryDelays: [],
      }),
    promptFacts: () => ({}),
    tools: [],
  });

  await agent.send({ userText: 'hi', onEvent: (e) => events.push(e) });

  const err = events.find((e) => e.kind === 'agent:error');

  assert.ok(err, '必须产出错误事件');
  assert.match(err.message, /限流/, `实际消息：${err.message}`);
  assert.match(err.message, /7s/, 'Retry-After 也要透出来');
  assert.equal(err.errorKind, 'provider');
  assert.equal(err.httpStatus, 429);
});

/* ---------------- 分片 args 回归（2026-10 实测 P0） ---------------- */

test('provider 发来半截参数 JSON 时转成 error 观察值，不炸整轮', async () => {
  const h = makeAgent([
    [
      {
        type: 'tool-call-delta',
        index: 0,
        id: 'c1',
        name: 'echo',
        argsDelta: '{"msg": "窗前',
      },
    ],
    [],
  ]);
  const done = await send(h);

  assert.equal(done.kind, AGENT_EVENTS.DONE, '整轮必须正常收尾');
  const res = of(h, AGENT_EVENTS.TOOL_RESULT)[0];
  assert.equal(res.status, TOOL_STATUS.ERROR);
  assert.ok(
    res.observation.includes('合法 JSON'),
    '错误要告诉模型参数坏了，让它重新调用'
  );
});

test('端到端回归：分片 args 经真实 streamChat 聚合后，工具拿到完整参数', async () => {
  const real = await import('./llm/providers/openai-compat');

  const sse = (chunks) =>
    new Response(
      new ReadableStream({
        start(c) {
          const body =
            chunks.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('') +
            'data: [DONE]\n\n';
          c.enqueue(new TextEncoder().encode(body));
          c.close();
        },
      }),
      { status: 200 }
    );

  let turn = 0;
  const fetchImpl = async () => {
    turn += 1;
    return turn === 1
      ? sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_x',
                      function: { name: 'echo', arguments: '' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: '{"msg": "窗前' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: '明月光"}' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ])
      : sse([
          { choices: [{ delta: { content: '好的' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]);
  };

  const got = [];
  const echoTool2 = {
    name: 'echo',
    class: 'read',
    group: 'context',
    description: '回显',
    parameters: {
      type: 'object',
      properties: { msg: { type: 'string' } },
    },
    execute: async (args) => {
      got.push(args);
      return 'ok';
    },
  };

  const events = [];
  const agent = createAgent({
    streamChat: (params) =>
      real.streamChat({
        ...params,
        config: { baseUrl: 'https://fake.invalid/v1', apiKey: 'k', model: 'm' },
        fetchImpl,
      }),
    promptFacts: () => ({}),
    tools: [echoTool2],
    wrapUntrusted,
    buildUserMessage: ({ userText }) =>
      wrapUntrusted('untrusted_user_message', userText),
  });

  const done = await agent.send({
    userText: 'hi',
    onEvent: (e) => events.push(e),
  });

  assert.equal(done.kind, AGENT_EVENTS.DONE);
  assert.equal(turn, 2, '应该跑了两轮');
  assert.deepEqual(
    got,
    [{ msg: '窗前明月光' }],
    '工具必须拿到聚合后的完整参数'
  );
});

/* ---------------- 多会话跨轮记忆（P1） ---------------- */

test('getHistory 带回完整历史，用户消息以 USER_MESSAGE 入史', async () => {
  const h = makeAgent([[text('第一轮回答')]]);
  await send(h);

  const hist = h.agent.getHistory();
  const userEv = hist.find((e) => e.kind === AGENT_EVENTS.USER_MESSAGE);
  assert.ok(userEv, '用户消息必须入史');
  assert.equal(userEv.text, '你好');
  assert.ok(
    userEv.wire.includes('<untrusted_user_message>'),
    'wire 形态存进事件，续接时无需二次包装'
  );
  assert.ok(
    hist.some(
      (e) => e.kind === AGENT_EVENTS.TEXT_DELTA && e.text === '第一轮回答'
    )
  );
});

test('跨轮续接：第二轮的 wire 里模型能看到第一轮的问答', async () => {
  const h = makeAgent([[text('第一轮回答')], [text('第二轮回答')]]);
  await send(h);

  const first = h.agent.getHistory();
  assert.ok(first.length > 0);

  // 用第一轮历史续接第二个 agent（模拟 runtime 重开同一会话）
  const events2 = [];
  const agent2 = createAgent({
    streamChat: h.streamChat,
    promptFacts: h.promptFacts ?? (() => ({})),
    tools: [echoTool],
    wrapUntrusted,
    buildUserMessage: ({ userText }) =>
      wrapUntrusted('untrusted_user_message', userText),
    requestConfirmation: async () => ({ approved: true }),
  });
  await agent2.send({
    userText: '我上一句问了什么？',
    initialHistory: first,
    onEvent: (e) => events2.push(e),
  });

  const wire = h.streamChat.calls[h.streamChat.calls.length - 1].messages;
  const userMsgs = wire.filter((m) => m.role === 'user');
  assert.equal(userMsgs.length, 2, '两轮的用户消息都要在');
  const assistantMsgs = wire.filter((m) => m.role === 'assistant');
  assert.ok(
    assistantMsgs.some((m) => m.content.includes('第一轮回答')),
    '第一轮的助手回答必须在 wire 里，否则模型没有记忆'
  );
});

test('上一轮中断留下的悬空 tool_calls 在续接时被净化，不发坏 wire', async () => {
  // 模拟：第一轮 turn 只发了 tool-call、没等 result 就被 abort
  const h = makeAgent([
    [
      {
        type: 'tool-call-delta',
        index: 0,
        id: 'c1',
        name: 'echo',
        argsDelta: '{}',
      },
    ],
  ]);
  const h2 = makeAgent([]);
  const first = h.agent.getHistory();

  const agent2 = createAgent({
    streamChat: h2.streamChat,
    promptFacts: () => ({}),
    tools: [echoTool],
    wrapUntrusted,
    buildUserMessage: ({ userText }) => userText,
    requestConfirmation: async () => ({ approved: true }),
  });
  await agent2.send({
    userText: '继续',
    initialHistory: first,
    onEvent: () => {},
  });

  const wire = h2.streamChat.calls[0].messages;
  const assistantWithCalls = wire.filter((m) => m.tool_calls);
  assistantWithCalls.forEach((m) => {
    m.tool_calls.forEach((c) => {
      const paired = wire.some(
        (x) => x.role === 'tool' && x.tool_call_id === c.id
      );
      assert.ok(paired, `tool_call ${c.id} 必须有配对的 tool 消息，否则 400`);
    });
  });
});

/* ---------------- P2 preStepNotice ---------------- */

test('preStepNotice 的 notice 作为 system-notice 入史并进 wire', async () => {
  const h = makeAgent([[text('ok')]]);
  // makeAgent 不支持 preStepNotice，这里直接手动建
  const agent = createAgent({
    streamChat: h.streamChat,
    promptFacts: () => ({}),
    tools: [echoTool],
    wrapUntrusted,
    buildUserMessage: ({ userText }) => userText,
    requestConfirmation: async () => ({ approved: true }),
    preStepNotice: ({ step }) => (step === 0 ? '目标页已导航到别处' : null),
  });

  await agent.send({ userText: 'hi', onEvent: h.onEvent });

  const notice = h.events.find((e) => e.kind === 'agent:system-notice');
  assert.ok(notice, '必须对外发 system-notice 事件');
  assert.ok(notice.wire.includes('untrusted_system_notice'));

  const wire = h.streamChat.calls[0].messages;
  assert.ok(
    wire.some((m) => m.role === 'user' && m.content.includes('目标页已导航')),
    'notice 必须进 wire，模型才看得见'
  );
});

test('preStepNotice 抛错不炸整轮', async () => {
  const h = makeAgent([[text('ok')]]);
  const agent = createAgent({
    streamChat: h.streamChat,
    promptFacts: () => ({}),
    tools: [],
    wrapUntrusted,
    buildUserMessage: ({ userText }) => userText,
    preStepNotice: () => {
      throw new Error('tabs.get exploded');
    },
  });

  const done = await agent.send({ userText: 'hi', onEvent: h.onEvent });
  assert.equal(done.kind, AGENT_EVENTS.DONE, '预检是 advisory，失败不挡轮');
});

/* ---------------- P3 插话队列 + 用量 ---------------- */

test('drainInstructions 的插话作为 USER_MESSAGE 注入下一步 wire', async () => {
  const h = makeAgent([[call(0, 'echo', { a: 1 })], [text('done')]]);
  const drained = [];
  const agent = createAgent({
    streamChat: h.streamChat,
    promptFacts: () => ({}),
    tools: [echoTool],
    wrapUntrusted,
    buildUserMessage: ({ userText }) => userText,
    requestConfirmation: async () => ({ approved: true }),
    drainInstructions: () => {
      if (drained.length) return [];
      drained.push('x');
      return ['顺便把价格也抓一下'];
    },
  });

  await agent.send({ userText: '开始', onEvent: h.onEvent });

  const inj = h.events.find(
    (e) => e.kind === AGENT_EVENTS.USER_MESSAGE && e.text.includes('价格')
  );
  assert.ok(inj, '插话必须对外发 USER_MESSAGE 事件');
  assert.ok(inj.wire.includes('任务进行中插话'), 'wire 里要标明是任务中插话');

  const secondTurn = h.streamChat.calls[1].messages;
  assert.ok(
    secondTurn.some((m) => m.role === 'user' && m.content.includes('价格')),
    '第二轮请求里必须带上插话'
  );
});

test('usage chunk 累计到 done 事件', async () => {
  // 第一轮必须带 tool call，loop 才会继续第二步（纯文本一轮即收尾）
  const h = makeAgent([
    [call(0, 'echo', { a: 1 }), { type: 'usage', input: 100, output: 10 }],
    [text('b'), { type: 'usage', input: 50, output: 5 }],
  ]);
  const done = await send(h);

  assert.equal(done.kind, AGENT_EVENTS.DONE);
  assert.deepEqual(done.usage, { input: 150, output: 15 });
});

test('插话通道抛错不炸整轮', async () => {
  const h = makeAgent([[text('ok')]]);
  const agent = createAgent({
    streamChat: h.streamChat,
    promptFacts: () => ({}),
    tools: [],
    wrapUntrusted,
    buildUserMessage: ({ userText }) => userText,
    drainInstructions: () => {
      throw new Error('queue exploded');
    },
  });
  const done = await agent.send({ userText: 'hi', onEvent: h.onEvent });
  assert.equal(done.kind, AGENT_EVENTS.DONE);
});

test('abort 走 DONE(aborted) 而不是 error（§5.4 回归）', async () => {
  const events = [];
  const agent = createAgent({
    // 模拟真实中止路径：流先说半句话，挂住等 abort，然后像被 cancel 的
    // reader 一样抛 AbortError
    streamChat: (params) =>
      (async function* () {
        yield { type: 'text-delta', text: '说一半' };
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          params.signal.addEventListener('abort', resolve);
        });
        throw new DOMException('The user aborted a request.', 'AbortError');
      })(),
    promptFacts: () => ({}),
    tools: [],
    wrapUntrusted,
    buildUserMessage: ({ userText }) => userText,
  });

  const p = agent.send({ userText: 'hi', onEvent: (e) => events.push(e) });
  // eslint-disable-next-line no-await-in-loop
  await new Promise((r) => {
    setTimeout(r, 10);
  });
  agent.abort();
  const done = await p;

  assert.equal(done.kind, AGENT_EVENTS.DONE, '中止必须以 DONE 收尾');
  assert.equal(done.aborted, true);
  assert.equal(of({ events }, AGENT_EVENTS.ERROR).length, 0, '不发 ERROR');
  // 半截话入史，重开 session 时 wire 净化能安全接住
  const hist = agent.getHistory();
  assert.ok(hist.some((e) => e.kind === AGENT_EVENTS.TEXT_DELTA));
});

/* ---------------- 全链路日志接线 ---------------- */

test('log 全链路打点：turn/step/tool.call/tool.result/confirm/budget/turn.end', async () => {
  const entries = [];
  const log = (event, data) => entries.push({ event, data });
  log.warn = (event, data) => entries.push({ event, data });
  log.error = log.warn;

  const h = makeAgent([[call(0, 'echo', { a: 1 })], [text('完成')]], {
    log,
  });
  await send(h);

  const kinds = entries.map((e) => e.event);
  for (const name of [
    // turn.start 在装配层（index.js）打点，loop 只管步骤与工具
    'step.start',
    'budget',
    'tool.call',
    'tool.result',
    'turn.end',
  ]) {
    assert.ok(kinds.includes(name), `缺 ${name} 打点`);
  }

  const toolCall = entries.find((e) => e.event === 'tool.call');
  assert.equal(toolCall.data.name, 'echo');
  assert.match(
    String(toolCall.data.args),
    /"a":1/,
    '参数摘要要能看出模型传了什么'
  );

  const toolResult = entries.find((e) => e.event === 'tool.result');
  assert.equal(toolResult.data.name, 'echo');
  assert.equal(toolResult.data.status, 'ok');

  const budget = entries.find((e) => e.event === 'budget');
  assert.equal(typeof budget.data.estimated, 'number');
  assert.equal(typeof budget.data.dropped, 'number');
});

test('write 工具的确认门打点：confirm.ask 带参数摘要、confirm.answer 带结果', async () => {
  const entries = [];
  const log = (event, data) => entries.push({ event, data });
  log.warn = log;
  log.error = log;

  const h = makeAgent([[call(0, 'do_write')], []], {
    tools: [writeTool],
    log,
  });
  await send(h);

  assert.ok(
    entries.some((e) => e.event === 'confirm.ask'),
    '缺 confirm.ask'
  );
  const answer = entries.find((e) => e.event === 'confirm.answer');
  assert.ok(answer, '缺 confirm.answer');
  assert.equal(answer.data.approved, true);
});

test('默认无日志时不炸：makeAgent 不传 log 照常跑完', async () => {
  const h = makeAgent([[call(0, 'echo', { a: 1 })], []]);
  await send(h);
  assert.equal(of(h, AGENT_EVENTS.DONE).length, 1);
});
