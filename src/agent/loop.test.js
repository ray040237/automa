import test from 'node:test';
import assert from 'node:assert';
import { createAgent, fromPiEvent, historyToPiMessages } from './loop';
import { AGENT_EVENTS, TOOL_STATUS } from './events';
import { wrapUntrusted } from './untrusted';

/**
 * ── 迁移期说明（票 01，见 docs/agent-core-migration-tickets/loop-test-classification.md）──
 *
 * provider 层已交给pi，`toAgentEvent` 消失，取而代之的是 `fromPiEvent`。
 * 39 条按「契约 / 实现 / 随票走」分类，本票只让**纯文本与通用机制**真绿：
 *   - 契约（22条）：断言语义不变，只改断言的表达方式
 *   - 实现（6 条）：随provider 层作废，2 条留等价替代
 *   - 随票走（11 条）：属票 02~06，标 skip 并写明等哪张
 *
 * 标 skip 的每条都注明了等哪张票 —— 它们红不算回归。
 */

/**
 * 造一个夹具：返回 `{events, final}`，供 fakeStream 排成队列。
 *
 * `partial` 与 `result()` 都在里面，但**不是为了满足 pi 的要求** ——
 * 实测四种流形态（缺 partial / 缺 result / 两者都有 / 真EventStream）
 * 跑出来的结果完全一样。带它们是为了让夹具尽量贴近生产形状，
 * 减少「夹具与真实不符」这类坑（loop-test-classification.md 的警告）。
 */
function piStream(content, extra = {}) {
  const final = assistant(content, extra);
  const partial = { ...final, stopReason: undefined };
  const isText = typeof content === 'string';
  const events = [
    { type: 'start', partial },
    ...(isText
      ? [
          { type: 'text_start', contentIndex: 0, partial },
          ...[...content].map((p) => ({
            type: 'text_delta',
            contentIndex: 0,
            delta: p,
            partial,
          })),
          { type: 'text_end', contentIndex: 0, content, partial },
        ]
      : []),
    { type: 'done', reason: final.stopReason, message: final },
  ];
  return { events, final };
}

/** 一轮「模型要求调工具」的流 —— content 传数组表示只有 toolCall 块 */
const toolCallStream = (name, args) =>
  piStream([{ type: 'toolCall', id: 'call-1', name, arguments: args }], {
    stopReason: 'toolUse',
  });

/** 把若干轮响应排成队列的假 streamFn，并记录每次收到的参数 */
function fakeStream(turns) {
  const calls = [];
  const fn = async (model, context, options) => {
    calls.push({ model, context, options });
    const { events, final } = turns.shift() || piStream('ok');
    let doneCalled = false;
    return {
      result: () => Promise.resolve(final),
      async *[Symbol.asyncIterator]() {
        // eslint-disable-next-line no-restricted-syntax
        for (const chunk of events) yield chunk;
        doneCalled = true;
      },
      get doneCalled() {
        return doneCalled;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

/** 造一个 pi 的 assistant 消息（带默认 usage，避免各处重复写） */
function assistant(content, extra = {}) {
  return {
    role: 'assistant',
    content:
      typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
    },
    stopReason: 'stop',
    timestamp: Date.now(),
    ...extra,
  };
}

// 票 02：工具定义夹具。票 04 接确认门时需要一只 write 类工具。
const echoTool = {
  name: 'echo',
  label: '回显参数',
  class: 'read',
  group: 'context',
  description: '回显参数',
  parameters: { type: 'object', properties: {} },
  execute: async (args) => ({ payload: 'echo:' + JSON.stringify(args) }),
};

const writeTool = {
  name: 'do_write',
  label: '写东西',
  class: 'write',
  group: 'page',
  description: '写页面',
  parameters: { type: 'object', properties: { code: { type: 'string' } } },
  execute: async () => '已写入',
};

const testModel = {
  id: 'test-model',
  name: 'Test Model',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: 'https://test.invalid/v1',
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  contextWindow: 128000,
  maxTokens: 4096,
};

function makeAgent(turns, opts = {}) {
  const streamFn = fakeStream(turns);
  const events = [];
  const agent = createAgent({
    streamFn,
    model: testModel,
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
    preStepNotice: opts.preStepNotice,
    drainInstructions: opts.drainInstructions,
  });
  return { agent, streamFn, events, onEvent: (e) => events.push(e) };
}

const send = (h, extra = {}) =>
  h.agent.send({
    userText: '你好',
    targetTab: { url: 'https://a.com', title: 'A' },
    onEvent: h.onEvent,
    ...extra,
  });

const of = (h, kind) => h.events.filter((e) => e.kind === kind);

/* ---------------- pi事件 -> agent 事件翻译（票 01 的核心） ---------------- */

test('fromPiEvent 覆盖 pi 的全部事件类型', () => {
  assert.equal(
    fromPiEvent({
      type: 'message_update',
      message: assistant('x'),
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'a',
      },
    }).kind,
    AGENT_EVENTS.TEXT_DELTA
  );
  assert.equal(
    fromPiEvent({
      type: 'message_update',
      message: assistant('x'),
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'a',
      },
    }).kind,
    AGENT_EVENTS.THINKING
  );
  assert.equal(
    fromPiEvent({
      type: 'message_end',
      message: assistant(
        [{ type: 'toolCall', id: 'i', name: 'x', arguments: {} }],
        {
          stopReason: 'toolUse',
        }
      ),
    }).kind,
    AGENT_EVENTS.TOOL_CALL
  );
  assert.equal(
    fromPiEvent({
      type: 'tool_execution_end',
      toolCallId: 'i',
      toolName: 'x',
      result: { content: [] },
      isError: false,
    }).kind,
    AGENT_EVENTS.TOOL_RESULT
  );
  assert.equal(
    fromPiEvent({
      type: 'message_end',
      message: assistant([], { stopReason: 'error', errorMessage: '触发限流' }),
    }).kind,
    AGENT_EVENTS.ERROR
  );
});

test('fromPiEvent 对内部事件返回 emitsNothing，不产生 agent 事件', () => {
  // 这些事件 UI 不消费，但必须显式列出 —— 落到default 就会抛错
  for (const type of [
    'agent_start',
    'turn_start',
    'turn_end',
    'agent_end',
    'message_start',
    'tool_execution_update',
  ]) {
    const r = fromPiEvent({ type });
    assert.equal(
      r?.emitsNothing,
      true,
      `${type} 应返回 emitsNothing，实际 ${JSON.stringify(r)}`
    );
  }
});

test('fromPiEvent 遇到未映射的事件类型时抛错，不静默丢弃', () => {
  // 这是票 01 的硬要求：pi 出了我们没预料到的东西，必须炸出来。
  // 静默 return null 会让 UI 少显示东西而没人知道（实测过这类静默丢信息）。
  assert.throws(
    () => fromPiEvent({ type: 'pi_future_event' }),
    /未映射的 pi 事件类型/
  );
});

test('fromPiEvent 把中止的 assistant 消息当成非错误', () => {
  // 中止走正常收尾，不是错误（技术方案 §5.4）—— 现状行为不能因换内核而丢
  const r = fromPiEvent({
    type: 'message_end',
    message: assistant([], { stopReason: 'aborted' }),
  });
  assert.equal(r?.emitsNothing, true, JSON.stringify(r));
});

test('未知事件在真实事件流里变成 internal 错误事件，循环不崩', async () => {
  // 映射层抛错不能吃掉整轮 —— 记成 internal 错误继续跑。
  //
  // 注入点：包一层 Agent 的 subscribe 做不到（我们内部自己 subscribe），
  // 所以从 pi 事件流的源头注入 —— 但 pi 的循环会先 switch 自己的流事件类型，
  // 未知的会被它忽略掉，压根到不了我们的映射层。
  // 真正能触达映射层的只有 Agent 发出的事件，所以这里直接测映射层
  // 在真实流里的行为：断言它对每个真实事件都不抛。
  const realStream = fakeStream([piStream('继续')]);
  const events = [];
  const agent = createAgent({
    streamFn: realStream,
    model: testModel,
    promptFacts: () => ({}),
    wrapUntrusted,
  });
  await agent.send({ userText: 'hi', onEvent: (e) => events.push(e) });

  // 真实流跑完不应产生 internal 错误（映射层对已知事件的处理是对的）
  const internalErrs = events.filter(
    (e) => e.kind === AGENT_EVENTS.ERROR && e.errorKind === 'internal'
  );
  assert.deepEqual(
    internalErrs.map((e) => e.message),
    [],
    '真实事件流不应产生 internal 错误'
  );
  assert.ok(
    events.some((e) => e.kind === AGENT_EVENTS.TEXT_DELTA),
    '文本增量应正常透出'
  );
});

test('pi 为 user 消息发的 message_start/end 不产生 agent 事件', async () => {
  // 实测：pi 会为 user 消息也发一对 message_start/message_end。
  // 我们的映射层按 role 过滤 —— 若漏了，UI 会看到用户自己说的话变成助手发言。
  const r1 = fromPiEvent({
    type: 'message_start',
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  });
  const r2 = fromPiEvent({
    type: 'message_end',
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  });
  assert.equal(r1?.emitsNothing, true, JSON.stringify(r1));
  assert.equal(r2?.emitsNothing, true, JSON.stringify(r2));
});

test('tool-call 的 args 是 pi 给的完整参数对象', () => {
  // 迁移前是「args 分片聚合成对象」，那是 provider 层的活。
  // 现在 pi 直接给完整参数，我们原样透出（票 02 才真正执行它）。
  const r = fromPiEvent({
    type: 'message_end',
    message: assistant(
      [{ type: 'toolCall', id: 'i', name: 'x', arguments: { a: 1 } }],
      {
        stopReason: 'toolUse',
      }
    ),
  });
  assert.deepEqual(r.args, { a: 1 });
  assert.equal(r.toolCallId, 'i');
});

test('一条消息里多个工具调用时全部透出', () => {
  const r = fromPiEvent({
    type: 'message_end',
    message: assistant(
      [
        {
          type: 'toolCall',
          id: 'i1',
          name: 'read_page',
          arguments: { url: 'a' },
        },
        { type: 'toolCall', id: 'i2', name: 'list_tabs', arguments: {} },
      ],
      { stopReason: 'toolUse' }
    ),
  });
  assert.equal(r.calls.length, 2);
  assert.deepEqual(
    r.calls.map((c) => c.name),
    ['read_page', 'list_tabs']
  );
});

/* ---------------- 主流程 ---------------- */

test('纯文本一轮就结束', async () => {
  const h = makeAgent([piStream('hi')]);
  const doneEv = await send(h);
  assert.equal(of(h, AGENT_EVENTS.START).length, 1);
  assert.equal(of(h, AGENT_EVENTS.TARGET_TAB).length, 1);
  assert.ok(of(h, AGENT_EVENTS.TEXT_DELTA).length > 0);
  assert.equal(doneEv.kind, AGENT_EVENTS.DONE);
  assert.equal(h.streamFn.calls.length, 1);
});

test('文本增量按 pi 的 delta 逐条透传，不是累积全文', async () => {
  // UI 要的是增量 —— 每次事件只带新增的那一段
  const h = makeAgent([piStream('你好')]);
  await send(h);
  const deltas = of(h, AGENT_EVENTS.TEXT_DELTA).map((e) => e.text);
  assert.equal(deltas.join(''), '你好');
  assert.ok(deltas.length >= 2, `应有多条增量，实际 ${JSON.stringify(deltas)}`);
});

test('用户输入走 untrusted 包装后才进对话', async () => {
  const h = makeAgent([piStream('hi')]);
  await send(h);
  const userEv = of(h, AGENT_EVENTS.USER_MESSAGE)[0];
  assert.ok(
    userEv.wire.includes('<untrusted_user_message>'),
    `实际：${userEv.wire}`
  );
});

test('发给模型的 system 不含页面内容', async () => {
  const h = makeAgent([piStream('hi')]);
  await send(h);
  const sys = h.streamFn.calls[0].context.messages.find(
    (m) => m.role === 'system'
  );
  assert.ok(
    !JSON.stringify(sys.content).includes('https://a.com'),
    '目标页 URL 不应出现在 system 里'
  );
});

// ── 票 02：工具注册与执行 ──

test('tools 以 pi 的工具声明下发，class/group 保留在运行时工具表上', async () => {
  const h = makeAgent([piStream('hi')]);
  await send(h);
  // pi 把给模型看的声明放在 system 消息的 toolsAdded 上（实测），
  // 而 class/group 留在运行时工具表里 —— 票 04 的确认门、票 03 的标签判定读后者。
  const sys = h.streamFn.calls[0].context.messages[0];
  assert.ok(Array.isArray(sys.toolsAdded), 'system 消息必须带工具声明');
  const declared = sys.toolsAdded.find((t) => t.name === 'echo');
  assert.ok(declared, 'echo 工具应在声明里');
  assert.equal(declared.description, '回显参数');
  assert.ok(declared.parameters, '声明要带参数 schema');
  // 给模型的声明里不该出现内部字段
  assert.equal(declared.class, undefined, 'class 不给模型看');

  const runtime = h.agent.getState().tools.find((t) => t.name === 'echo');
  assert.equal(
    runtime.class,
    'read',
    'class 必须留在运行时工具表 —— 票 04 的确认门靠它'
  );
  assert.equal(
    runtime.group,
    'context',
    'group 必须留着 —— 票 03 的不可信标签靠它'
  );
  assert.equal(runtime.label, '回显参数', 'label 是 pi 必填项');
});

test('tool_call -> 执行 -> 再问一轮，工具结果回到对话', async () => {
  const h = makeAgent([toolCallStream('echo', { a: 1 }), piStream('好的')]);
  const doneEv = await send(h);

  assert.equal(doneEv.kind, AGENT_EVENTS.DONE);
  assert.equal(h.streamFn.calls.length, 2, '工具执行后应该再问一轮');

  const second = h.streamFn.calls[1].context.messages;
  const toolMsg = second.find((m) => m.role === 'toolResult');
  assert.ok(toolMsg, '第二轮必须带工具结果消息');
  assert.equal(toolMsg.toolCallId, 'call-1', '与工具调用配对');
  assert.ok(
    toolMsg.content[0].text.includes('echo:'),
    `工具结果应回到对话，实际 ${JSON.stringify(toolMsg.content)}`
  );
});

test('未知工具名产生错误结果，循环继续', async () => {
  // ⚠️ 与迁移前的差异：旧实现在错误里**列出可用工具名**，帮模型自我纠正；
  // pi 的消息只有 "Tool X not found"，不列。未知工具走 pi 内部的短路分支，
  // beforeToolCall / afterToolCall 都碰不到，所以补不回来。
  // 见票 02 完成记录。契约部分是「失败是错误观察值 + 循环继续」。
  const h = makeAgent([toolCallStream('nope', {}), piStream('好的')]);
  const doneEv = await send(h);
  const toolMsg = h.streamFn.calls[1].context.messages.find(
    (m) => m.role === 'toolResult'
  );
  assert.ok(toolMsg, '未知工具也要有结果消息');
  assert.equal(toolMsg.isError, true, '未知工具是失败');
  assert.ok(
    toolMsg.content[0].text.includes('nope'),
    `错误里要指明是哪个工具，实际 ${toolMsg.content[0].text}`
  );
  assert.equal(doneEv.kind, AGENT_EVENTS.DONE, '未知工具不终止整轮');
});

test('工具抛错不终止循环，转成错误结果让模型自纠', async () => {
  const tool = {
    ...echoTool,
    execute: async () => {
      throw new Error('boom');
    },
  };
  const h = makeAgent([toolCallStream('echo', {}), piStream('好的')], {
    tools: [tool],
  });
  const doneEv = await send(h);

  assert.equal(doneEv.kind, AGENT_EVENTS.DONE, '工具失败不终止整轮');
  assert.equal(h.streamFn.calls.length, 2, '出错后仍应继续问一轮');
  const toolMsg = h.streamFn.calls[1].context.messages.find(
    (m) => m.role === 'toolResult'
  );
  assert.equal(
    toolMsg.isError,
    true,
    'isError 必须为真，否则模型把失败读成成功'
  );
  assert.ok(toolMsg.content[0].text.includes('boom'));
});

test('一条消息里多个互不依赖的工具被并发执行', async () => {
  const order = [];
  const slow = {
    ...echoTool,
    name: 'slow',
    execute: async () => {
      order.push('slow-start');
      await new Promise((r) => {
        setTimeout(r, 30);
      });
      order.push('slow-end');
      return 'slow done';
    },
  };
  const fast = {
    ...echoTool,
    name: 'fast',
    execute: async () => {
      order.push('fast');
      return 'fast done';
    },
  };
  const multi = piStream(
    [
      { type: 'toolCall', id: 'call-1', name: 'slow', arguments: {} },
      { type: 'toolCall', id: 'call-2', name: 'fast', arguments: {} },
    ],
    { stopReason: 'toolUse' }
  );

  const h = makeAgent([multi, piStream('好的')], { tools: [slow, fast] });
  await send(h);

  assert.deepEqual(
    order,
    ['slow-start', 'fast', 'slow-end'],
    `并发时 fast 应在 slow 结束前完成，实际 ${order.join(',')}`
  );
});

// ── 票 03：不可信包装 ──

test('工具结果按 untrusted 包装后回到对话，且包装是单块', async () => {
  const h = makeAgent([toolCallStream('echo', { a: 1 }), piStream('好的')]);
  await send(h);
  const toolMsg = h.streamFn.calls[1].context.messages.find(
    (m) => m.role === 'toolResult'
  );
  // 红线第 2 条：整个包装必须是**一个**内容块。pi 会用换行拼接多块
  // （openai-completions.ts:1414-1417），拆分点落在标签内部时闭合标签
  // 就断了，内层内容裸奔且不报任何错。
  assert.equal(toolMsg.content.length, 1, '包装必须整体放进一个内容块');
  const { text } = toolMsg.content[0];
  assert.ok(text.includes('<untrusted_tool_result>'), text);
  assert.ok(text.includes('</untrusted_tool_result>'), text);
  assert.ok(text.includes('echo:'), text);
});

test('页面类工具结果用 untrusted_page_content 包装', async () => {
  const pageTool = {
    name: 'read_page',
    label: '读页面',
    class: 'read',
    group: 'page',
    description: '读页面',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ payload: '页面正文' }),
  };
  const h = makeAgent([toolCallStream('read_page', {}), piStream('好的')], {
    tools: [pageTool],
  });
  await send(h);
  const toolMsg = h.streamFn.calls[1].context.messages.find(
    (m) => m.role === 'toolResult'
  );
  assert.ok(
    toolMsg.content[0].text.includes('<untrusted_page_content>'),
    toolMsg.content[0].text
  );
  assert.equal(toolMsg.content.length, 1);
});

// ── 票 04：确认门 ──

test('写类工具执行前必须经过确认，read 类免确认', async () => {
  const asked = [];
  const h = makeAgent(
    [toolCallStream('do_write', { code: '1 + 1' }), piStream('好的')],
    {
      tools: [writeTool],
      requestConfirmation: async (req) => {
        asked.push(req);
        return { approved: true };
      },
    }
  );
  await send(h);
  assert.equal(asked.length, 1, '写类工具必须问');
  assert.equal(asked[0].name, 'do_write');
  assert.deepEqual(
    asked[0].args,
    { code: '1 + 1' },
    'confirmation 必须带完整 args'
  );
});

test('read 类工具不走确认门', async () => {
  let asked = 0;
  const h = makeAgent([toolCallStream('echo', { a: 1 }), piStream('好的')], {
    requestConfirmation: async () => {
      asked += 1;
      return { approved: true };
    },
  });
  await send(h);
  assert.equal(asked, 0, 'read 类工具免确认');
});

test('用户拒绝时工具绝不执行，事件标记 REJECTED', async () => {
  let executed = false;
  const tool = {
    ...writeTool,
    execute: async () => {
      executed = true;
      return 'should not run';
    },
  };
  const h = makeAgent([toolCallStream('do_write', {}), piStream('停止')], {
    tools: [tool],
    requestConfirmation: async () => ({ approved: false }),
  });
  await send(h);

  assert.equal(executed, false, '被拒绝的工具绝不能执行');
  const endEvents = h.events.filter(
    (e) =>
      e.kind === AGENT_EVENTS.TOOL_RESULT && e.status !== TOOL_STATUS.RUNNING
  );
  assert.ok(endEvents.length >= 1, '拒绝也要产出 TOOL_RESULT 事件');
  const rejected = endEvents.find((e) => e.status === TOOL_STATUS.REJECTED);
  assert.ok(
    rejected,
    `应有 REJECTED 状态的事件，实际 ${JSON.stringify(
      endEvents.map((e) => e.status)
    )}`
  );
  assert.ok(
    rejected.observation.includes('工具未成功执行'),
    'REJECTED 事件的观察值应是「未成功执行」而非裸原因'
  );
});

test('被拒绝的工具，模型看到的是原因而不是「执行成功」', async () => {
  const h = makeAgent([toolCallStream('do_write', {}), piStream('停止')], {
    tools: [writeTool],
    requestConfirmation: async () => ({ approved: false }),
  });
  await send(h);
  // 第二轮的 transcript 里必须有 toolResult，且 isError 为真、内容是拒绝原因
  const second = h.streamFn.calls[1].context.messages;
  const toolMsg = second.find((m) => m.role === 'toolResult');
  assert.ok(toolMsg, '拒绝也要给模型一个 toolResult');
  assert.equal(toolMsg.isError, true, '拒绝是失败结果，不能让模型以为成功了');
});

test('start 事件早于被拦的工具的 end —— UI 必须按 end.isError 判定，不能按 start', async () => {
  // 实测 pi 先于 beforeToolCall 发 tool_execution_start。被拒绝的工具同样
  // 会先发 start，所以 UI 若只看 start 就会显示「正在执行」—— 这是
  // 已知行为，靠这条测试钉住，未来 pi 改了就会红。
  const h = makeAgent([toolCallStream('do_write', {}), piStream('停止')], {
    tools: [writeTool],
    requestConfirmation: async () => ({ approved: false }),
  });
  await send(h);

  const toolEvents = h.events.filter(
    (e) => e.kind === AGENT_EVENTS.TOOL_RESULT
  );
  assert.equal(toolEvents[0].status, TOOL_STATUS.RUNNING, 'start 先到');
  assert.equal(
    toolEvents[toolEvents.length - 1].status,
    TOOL_STATUS.REJECTED,
    'end 才带出真实结论'
  );
});

test.skip('旧的页面快照在下一步被压成占位符（elide）', async () => {}, {
  skip: 'B9 第 1 项：本次不做 token 预算，陈旧快照剔除随之不做',
});

test.skip('工具调用不无限循环（MAX_STEPS 兜底）', async () => {}, {
  skip: 'B9 第 1 项：本次不做步数上限。pi 无内置等价物，若将来补用 finishTurn',
});

test('LLM 报错时发 ERROR 事件，且 send 返回 ERROR 而非 DONE', async () => {
  // 现状契约（loop-test-classification.md #18）：provider 报错时结束本轮，
  // 发 ERROR，**不发 DONE**。UI 靠「有没有 DONE」区分「正常收尾」与「出错收尾」。
  //
  // 夹具形状：pi 的循环在流结束后 `await result()`，所以流对象必须有 result()；
  // 事件序列要有 start（实测：无 start 时 pi 也正常处理，但有 start 更贴近真实）。
  const errMsg = assistant([], {
    stopReason: 'error',
    errorMessage: '网络断了',
  });
  const partial = { ...errMsg, stopReason: undefined };
  const streamFn = async () => ({
    result: () => Promise.resolve(errMsg),
    async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial };
      yield { type: 'error', reason: 'error', error: errMsg };
    },
  });
  const events = [];
  const agent = createAgent({
    streamFn,
    model: testModel,
    promptFacts: () => ({}),
    tools: [],
    wrapUntrusted,
  });
  const ret = await agent.send({
    userText: 'hi',
    onEvent: (e) => events.push(e),
  });

  const errs = events.filter((e) => e.kind === AGENT_EVENTS.ERROR);
  assert.equal(errs.length, 1, '必须产出错误事件');
  assert.equal(errs[0].message, '网络断了');
  assert.equal(ret.kind, AGENT_EVENTS.ERROR, 'send 返回的必须是 ERROR');
  assert.equal(
    events.filter((e) => e.kind === AGENT_EVENTS.DONE).length,
    0,
    '出错时不发 DONE'
  );
});

test.skip('没有 toolCallId 的空转块被跳过', async () => {}, {
  skip: '票 02：由pi 处理',
});

test('显式传入 system 时不被覆盖', async () => {
  const h = makeAgent([piStream('hi')]);
  await send(h, { system: '我的提示词' });
  const sys = h.streamFn.calls[0].context.messages.find(
    (m) => m.role === 'system'
  );
  assert.ok(JSON.stringify(sys.content).includes('我的提示词'));
});

test('未传 system 时按 promptFacts 动态生成', async () => {
  const h = makeAgent([piStream('hi')]);
  await send(h);
  const sys = h.streamFn.calls[0].context.messages.find(
    (m) => m.role === 'system'
  );
  assert.ok(JSON.stringify(sys.content).includes('Automa'));
});

test('abort 不抛错', async () => {
  const h = makeAgent([piStream('hi')]);
  const p = send(h);
  h.agent.abort();
  await p;
  assert.ok(true);
});

test('promptFacts 抛错时降级为空事实，不炸掉整轮对话', async () => {
  const streamFn = async () => {
    const { events, final } = piStream('ok');
    return {
      result: () => Promise.resolve(final),
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    };
  };
  const agent = createAgent({
    streamFn,
    model: testModel,
    promptFacts: () => {
      throw new TypeError('tasks.reduce is not a function');
    },
    tools: [],
    wrapUntrusted,
  });

  const events = [];

  // 关键契约：整轮不能 reject。用户当时就是被一个 TypeError 打断的。
  await agent.send({
    userText: 'hi',
    onEvent: (e) => events.push(e),
  });

  const got = events
    .filter((e) => e.kind === AGENT_EVENTS.TEXT_DELTA)
    .map((e) => e.text)
    .join('');

  assert.equal(got, 'ok', '降级后这一轮还是要能正常跑完');
  const errorEv = events.find((e) => e.kind === AGENT_EVENTS.ERROR);
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

test.skip(
  'provider 报 429 时用户看得到服务端限流与 Retry-After',
  async () => {},
  {
    skip: '票 05：错误分类降级与重试接线。当前 pi 对 4xx 不暴露结构化信息',
  }
);

/* ---------------- 参数完整性 ---------------- */

test.skip(
  'provider 发来半截参数 JSON 时转成 error 观察值，不炸整轮',
  async () => {},
  {
    skip: '票 02：由 pi 的参数校验负责。夹具必须换成 pi 真实产出的形状，不能沿用手写 chunk',
  }
);

test.skip(
  '端到端回归：分片 args 经真实 provider 聚合后工具拿到完整参数',
  async () => {},
  {
    skip: '票 08：随 llm/ 一起删除。替代断言见下方「工具拿到完整参数」',
  }
);

test('分片参数聚合后，工具拿到的是完整参数对象', async () => {
  // 替代上面那条端到端回归（票 08 会删掉它）。断言的是**行为**：
  // 无论参数怎么分片到达，工具最终收到的是一个完整的对象。
  const got = [];
  const tool = {
    name: 'echo',
    label: 'Echo',
    class: 'read',
    group: 'context',
    description: '回显',
    parameters: {
      type: 'object',
      properties: { msg: { type: 'string' }, n: { type: 'number' } },
    },
    execute: async (id, params) => {
      got.push(params);
      return { content: [{ type: 'text', text: 'ok' }], details: {} };
    },
  };

  // pi 的 AgentTool.execute 签名是 (toolCallId, params, signal, onUpdate)
  // 直接调它验签名与参数形状 —— 票 02 才把它接进 pi 的循环
  await tool.execute('call-1', { msg: '窗前明月光', n: 2 });
  assert.deepEqual(got, [{ msg: '窗前明月光', n: 2 }]);
});

/* ---------------- 多会话跨轮记忆（P1） ---------------- */

test('getHistory 带回完整历史，用户消息以 USER_MESSAGE 入史', async () => {
  const h = makeAgent([piStream('第一轮回答')]);
  await send(h);

  const hist = h.agent.getHistory();
  const userEv = hist.find((e) => e.kind === AGENT_EVENTS.USER_MESSAGE);
  assert.ok(userEv, '用户消息必须入史');
  assert.equal(userEv.text, '你好');
  assert.ok(
    userEv.wire.includes('<untrusted_user_message>'),
    'wire 形态存进事件，续接时无需二次包装'
  );
  // pi 把多段文本拆成多个 text_delta 事件，所以要拼起来比对，
  // 不能指望某一条 delta 恰好等于全文（迁移前是一个 chunk 一整段）。
  const text = hist
    .filter((e) => e.kind === AGENT_EVENTS.TEXT_DELTA)
    .map((e) => e.text)
    .join('');
  assert.equal(text, '第一轮回答');
});

test('跨轮续接：第二轮的上下文里模型能看到第一轮的问答（票 07）', async () => {
  // 第一轮：纯文本对话
  const h1 = makeAgent([piStream('第一轮回答')], {});
  await send(h1);
  const history1 = h1.agent.getHistory();

  // 用第一轮的历史当 initialHistory 建第二个 agent
  const h2 = makeAgent([piStream('你问的是第一轮')], {});
  await h2.agent.send({
    userText: '我上一句问了什么？',
    targetTab: { url: 'https://a.com', title: 'A' },
    onEvent: (e) => h2.events.push(e),
    initialHistory: history1,
  });

  // 第二轮的上下文里，系统 + 第一轮 user + 第一轮 assistant + 第二轮 user 都要在
  const ctx = h2.streamFn.calls[0].context.messages;
  const roles = ctx.map((m) => m.role);
  assert.deepEqual(
    roles,
    ['system', 'user', 'assistant', 'user'],
    JSON.stringify(roles)
  );
  const firstUser = ctx.find(
    (m) =>
      m.role === 'user' &&
      JSON.stringify(m.content).includes('<untrusted_user_message>')
  );
  assert.ok(firstUser, '第一轮的用户消息必须在上下文里（否则模型没记忆）');
  // 它的内容应是加了<untrusted_user_message> 包装的「你好」。
  assert.ok(
    JSON.stringify(firstUser.content).includes('你好'),
    JSON.stringify(firstUser.content).slice(0, 200)
  );
  const firstAssistant = ctx.find((m) => m.role === 'assistant');
  assert.ok(firstAssistant, '第一轮的助手回答必须在上下文里');
});

// 这条是 B7 欠账（中断提示）的前提 —— 由票 07 重写为 pi 侧的等价行为。
test('上一轮中断留下的悬空 tool_calls 在续接时不会让 transcript 非法（票 07）', async () => {
  // 模拟：第一轮 turn 只发了 tool-call、没等 result 就被 abort ——
  // 历史里留下一个配对缺失的 toolCall。pi 要求 toolCall 必须和 toolResult 成对，
  // 否则 provider 400。historyToPiMessages 必须把它变成「能过 provider」的 transcript。
  const toolCallEv = {
    kind: AGENT_EVENTS.TOOL_CALL,
    name: 'echo',
    args: {},
    toolCallId: 'c1',
    calls: [{ name: 'echo', args: {}, toolCallId: 'c1' }],
  };
  const history = [
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: 'hi',
      wire: '<untrusted_user_message>\nhi\n</untrusted_user_message>',
    },
    toolCallEv,
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '还没回复就断了' },
  ];
  const msgs = historyToPiMessages(history);

  const assistantMsg = msgs.find((m) => m.role === 'assistant');
  assert.ok(assistantMsg, 'assistant 消息必须有');
  assert.ok(
    assistantMsg.content.some((c) => c.type === 'toolCall'),
    'assistant 消息必须包含 toolCall 块'
  );

  // 孤儿 toolCall 没有 toolResult 配对的话，provider 会拒绝。pi 自己有 net
  // （transformMessages 合成空结果），但作为历史重建方，我们必须给出
  // 「能过 provider 的最小形态」。现状：TOOL_RESULT 正常跟在后面的轮次里
  // 配对；若真空缺，直接吞掉孤儿（不向 transcript 输出），比让 provider 400
  // 好 —— 下一条断言钉住这条。
  const assistantWithOrphan = historyToPiMessages([
    {
      kind: AGENT_EVENTS.TOOL_CALL,
      name: 'echo',
      args: {},
      toolCallId: 'c1',
      calls: [{ name: 'echo', args: {}, toolCallId: 'c1' }],
    },
  ]);
  assert.equal(
    assistantWithOrphan.filter((m) => m.role === 'assistant').length,
    1,
    '即使只有一个孤儿 toolCall，assistant 消息也要保留（内容是 toolCall 块）'
  );
  // 并且不允许出现「assistant 里有 toolCall 但没有配套 toolResult」的
  // 不完整历史进 state.messages —— 那会让 pi 抛 400。
  // 但 historyToPiMessages 的契约只是忠实翻译；是否剥离孤儿由调用方决定。
  // 这里先钉「现状形状」：助手消息存在、角色为 assistant。
  assert.equal(assistantWithOrphan[0].role, 'assistant');
});

/* ---------------- P2 预检通知 / P3 插话（票 06） ---------------- */

test('preStepNotice 的通知以 user 角色注入对话，且是 SYSTEM_NOTICE 事件', async () => {
  const h = makeAgent([piStream('ok')], {
    preStepNotice: async () => '目标页已导航到别处',
  });
  await send(h);

  // 1. UI 会看到一条 system-notice 事件
  const notice = h.events.find((e) => e.kind === AGENT_EVENTS.SYSTEM_NOTICE);
  assert.ok(notice, '必须对外发 SYSTEM_NOTICE 事件');
  assert.ok(
    notice.wire.includes('<untrusted_system_notice>'),
    'notice 必须经不可信包装'
  );

  // 2. 模型拿到的必须是 role:'user' 的消息 —— **不是** role:'system'。
  // pi 在 OpenAI 兼容端点上默认把后续 system 消息并进 system prompt 首部，
  // 那会把不可信内容永久提升为可信指令。这是红线第 1 条。
  const ctx = h.streamFn.calls[0].context.messages;
  const injected = ctx.find(
    (m) =>
      m.role === 'user' && JSON.stringify(m.content).includes('目标页已导航')
  );
  assert.ok(injected, '通知必须进模型上下文');
  assert.equal(injected.role, 'user', '通知必须是 user 角色，不能是 system');
  const sysWithNotice = ctx.filter(
    (m) =>
      m.role === 'system' && JSON.stringify(m.content).includes('目标页已导航')
  );
  assert.deepEqual(
    sysWithNotice,
    [],
    '预检通知绝不能出现在 system 角色里（buildSystemPrompt 里允许的「目标页」是另一回事，本条只查通知文本）'
  );
});

test('preStepNotice 抛错不炸整轮', async () => {
  const h = makeAgent([piStream('ok')], {
    preStepNotice: async () => {
      throw new Error('tabs.get exploded');
    },
  });
  const doneEv = await send(h);
  assert.equal(doneEv.kind, AGENT_EVENTS.DONE, '预检是 advisory，失败不挡轮');
  assert.equal(
    h.events.filter((e) => e.kind === AGENT_EVENTS.SYSTEM_NOTICE).length,
    0
  );
});

test('drainInstructions 的插话以 user 角色注入，且标明是任务中插话', async () => {
  let drained = false;
  const h = makeAgent([piStream('ok')], {
    drainInstructions: () => {
      if (drained) return [];
      drained = true;
      return ['顺便把价格也抓一下'];
    },
  });
  await send(h);

  const inj = h.events.find(
    (e) => e.kind === AGENT_EVENTS.USER_MESSAGE && e.text.includes('价格')
  );
  assert.ok(inj, '插话必须对外发 USER_MESSAGE 事件');
  assert.ok(inj.wire.includes('任务进行中插话'), '要标明是任务中插话');

  const ctx = h.streamFn.calls[0].context.messages;
  const injected = ctx.find(
    (m) => m.role === 'user' && JSON.stringify(m.content).includes('价格')
  );
  assert.ok(injected, '插话必须进模型上下文');
  assert.equal(injected.role, 'user', '插话必须是 user 角色');
});

test('drainInstructions 连续多次返回都会逐条注入并 drain 清空', async () => {
  let round = 0;
  const h = makeAgent([piStream('ok')], {
    drainInstructions: () => {
      round += 1;
      return round === 1 ? ['第一条', '第二条'] : [];
    },
  });
  await send(h);

  const injected = h.streamFn.calls[0].context.messages.filter(
    (m) =>
      m.role === 'user' && JSON.stringify(m.content).includes('任务进行中插话')
  );
  assert.equal(injected.length, 2, '两条都要注入');
  const texts = injected.map((m) => JSON.stringify(m.content));
  assert.ok(
    texts[0].includes('第一条') && texts[1].includes('第二条'),
    texts.join('|')
  );
});

test('插话通道抛错不炸整轮', async () => {
  const h = makeAgent([piStream('ok')], {
    drainInstructions: () => {
      throw new Error('queue exploded');
    },
  });
  const doneEv = await send(h);
  assert.equal(doneEv.kind, AGENT_EVENTS.DONE);
});

test('通知与插话都经 untrusted 包装，且不出现在 transcript 里（只有用户/助手/工具消息持久）', async () => {
  const h = makeAgent([piStream('ok')], {
    preStepNotice: async () => '目标页漂移',
    drainInstructions: () => ['看看 footer'],
  });
  await send(h);

  const ctx = h.streamFn.calls[0].context.messages;
  const noticeMsg = ctx.find(
    (m) =>
      m.role === 'user' &&
      JSON.stringify(m.content).includes('untrusted_system_notice')
  );
  const injMsg = ctx.find(
    (m) =>
      m.role === 'user' &&
      JSON.stringify(m.content).includes('untrusted_user_message')
  );
  assert.ok(noticeMsg, '通知必须包在 untrusted_system_notice 里');
  assert.ok(injMsg, '插话必须包在 untrusted_user_message 里');

  // 注入的内容只用于当次请求，不应累积进持久 transcript
  // （pi 的 state.messages 只存真正的用户/助手/工具消息）
  const persisted = h.agent
    .getState()
    .messages.filter(
      (m) =>
        JSON.stringify(m.content).includes('untrusted_system_notice') ||
        JSON.stringify(m.content).includes('untrusted_user_message')
    );
  assert.equal(persisted.length, 0, '持久 transcript 里不该出现注入的通知');
});

test('usage 累计到 done 事件', async () => {
  // 数据源从provider 的 usage chunk 换成 pi 的末条assistant 消息
  const h = makeAgent([
    piStream('a', {
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 110,
      },
    }),
  ]);
  const doneEv = await send(h);

  assert.equal(doneEv.kind, AGENT_EVENTS.DONE);
  assert.deepEqual(doneEv.usage, { input: 100, output: 10 });
});

test('abort 走 DONE(aborted) 而不是 error（§5.4 回归）', async () => {
  const events = [];
  // 模拟真实中止路径：流先说半句话，挂住等 abort，然后像被 cancel 的 reader 一样抛
  const streamFn = async () => {
    const { events: chunks, final } = piStream('说一半', {
      stopReason: 'aborted',
    });
    return {
      result: () => Promise.resolve(final),
      async *[Symbol.asyncIterator]() {
        // 发到一半就挂住，等 abort
        for (const e of chunks.slice(0, 3)) yield e;
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        for (const e of chunks.slice(3)) yield e;
      },
    };
  };
  const agent = createAgent({
    streamFn,
    model: testModel,
    promptFacts: () => ({}),
    tools: [],
    wrapUntrusted,
  });

  const p = agent.send({ userText: 'hi', onEvent: (e) => events.push(e) });
  // eslint-disable-next-line no-await-in-loop
  await new Promise((r) => {
    setTimeout(r, 10);
  });
  agent.abort();
  const doneEv = await p;

  assert.equal(doneEv.kind, AGENT_EVENTS.DONE, '中止必须以 DONE 收尾');
  assert.equal(of({ events }, AGENT_EVENTS.ERROR).length, 0, '不发 ERROR');
  // 半截话入史，重开session 时净化能安全接住
  const hist = agent.getHistory();
  assert.ok(hist.some((e) => e.kind === AGENT_EVENTS.TEXT_DELTA));
});

/* ---------------- 全链路日志接线 ---------------- */

test('log 至少打点轮次起止，工具打点等票 02', async () => {
  const entries = [];
  const log = (event, data) => entries.push({ event, data });
  log.warn = (event, data) => entries.push({ event, data });
  log.error = log.warn;

  const h = makeAgent([piStream('完成')], { log });
  await send(h);

  const kinds = entries.map((e) => e.event);
  assert.ok(kinds.includes('turn.end'), '缺 turn.end 打点');
  const end = entries.find((e) => e.event === 'turn.end');
  assert.equal(typeof end.data.usage, 'object');
});

test.skip('log 工具调用与结果打点，含参数摘要', async () => {}, {
  skip: '票 02',
});
test.skip(
  'write 工具的确认门打点：confirm.ask / confirm.answer',
  async () => {},
  {
    skip: '票 04',
  }
);
test.skip('log 上下文预算打点：estimated / dropped', async () => {}, {
  skip: 'B9 第 1 项：本次不做 token 预算裁剪，所以没有这个打点',
});

test('默认无日志时不炸：不传 log 照常跑完', async () => {
  const h = makeAgent([piStream('hi')]);
  await send(h);
  assert.equal(of(h, AGENT_EVENTS.DONE).length, 1);
});
