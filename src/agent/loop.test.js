import test from 'node:test';
import assert from 'node:assert';
import { createAgent, fromPiEvent, historyToPiMessages } from './loop';
import { defineTool } from './tools/define';
import { AGENT_EVENTS, ERROR_KIND, TOOL_STATUS } from './events';
import { wrapUntrusted } from './untrusted';
import { buildUserMessage } from './prompt';
import { SUMMARIZATION_SYSTEM_PROMPT } from './compaction';

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

/** 同上，但 toolCall 块**不带 id**（真实 provider 偶尔产出这种空转块） */
const toolCallStreamNoId = (name, args) =>
  piStream([{ type: 'toolCall', name, arguments: args }], {
    stopReason: 'toolUse',
  });

/** 一轮「参数是半截 JSON 字符串」的流 */
const toolCallStreamRawArgs = (name, rawArgs) =>
  piStream([{ type: 'toolCall', id: 'call-1', name, arguments: rawArgs }], {
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
//
// T-127：这两只夹具现在走 `defineTool` —— 与 15 个生产工具同一条构造器。
// 以前它们显式写 `label` 而生产工具一个都没有，于是「主循环默认回归路径」
// 验的从来不是生产形状：`adapter.js` 的 `tool.label || tool.name` 兜底
// 分支从没被真正跑过。改 label / ctx 声明 / class 时，两边一起被构造器拦。
const echoTool = defineTool({
  name: 'echo',
  class: 'read',
  group: 'context',
  ctx: [],
  description: '回显参数',
  parameters: { type: 'object', properties: {} },
  execute: async (args) => ({ payload: 'echo:' + JSON.stringify(args) }),
});

const writeTool = defineTool({
  name: 'do_write',
  class: 'write',
  group: 'page',
  ctx: [],
  confirmDetail: () => ({ kind: 'generic', detail: '写页面' }),
  description: '写页面',
  parameters: { type: 'object', properties: { code: { type: 'string' } } },
  execute: async () => '已写入',
});

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
    // 桩只处理用户原文，但**必须与真函数同样认 wrapUserText**（T-63）：活轮次传
    // false，桩若无视这个标志就会把活轮次重新包起来，通知/插话那条用例会假红。
    // 要验真实形态（元数据段等）用 opts.buildUserMessage 换成 prompt.js 的真的。
    buildUserMessage:
      opts.buildUserMessage ||
      (({ userText, wrapUserText = true }) =>
        wrapUserText
          ? wrapUntrusted('untrusted_user_message', userText)
          : userText),
    toolCtx: opts.toolCtx || {},
    requestConfirmation:
      opts.requestConfirmation || (async () => ({ approved: true })),
    systemPromptOverride: opts.systemPromptOverride,
    contextWindow: opts.contextWindow,
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

test('回复被长度截断时发 SYSTEM_NOTICE，不再静默收尾（T-96②）', () => {
  // pi 把 length 当正常收尾，不进 error 分支 —— 若不显式处理，用户看到的是
  // 「话说到一半没了」而界面毫无提示（provider.js 记着「曾写死 4096」的坑）。
  const ev = fromPiEvent({
    type: 'message_end',
    message: assistant('说了一半', { stopReason: 'length' }),
  });
  assert.equal(ev.kind, AGENT_EVENTS.SYSTEM_NOTICE);
  assert.ok(ev.text.includes('截断'));
  // 进 transcript 的契约：SYSTEM_NOTICE 必须带包装文本，否则投影层抛错
  assert.ok(
    ev.promptText && ev.promptText.startsWith('<untrusted_system_notice'),
    'SYSTEM_NOTICE 必须带 untrusted 包装'
  );
});

test('长度截断优先级高于工具调用：参数被截断时不发半截 TOOL_CALL', () => {
  const ev = fromPiEvent({
    type: 'message_end',
    message: assistant(
      [{ type: 'toolCall', id: 'i', name: 'click', arguments: {} }],
      { stopReason: 'length' }
    ),
  });
  // 参数可能是半截 JSON，按未截断处理会让工具拿着残缺参数执行
  assert.equal(ev.kind, AGENT_EVENTS.SYSTEM_NOTICE);
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
    buildUserMessage: ({ userText }) => userText,
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

test('fromPiEvent 翻译层保留合装形状（含 calls[]），扇出在发射点做（T-74）', () => {
  // 这个形状只在翻译层内部存在：handlePiEvent 会把它拆成 N 条单调用事件
  // 再入史（见「并行工具调用拆成 N 条 TOOL_CALL 事件」那条）。
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
    userEv.promptText.includes('<untrusted_user_message>'),
    `实际：${userEv.promptText}`
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
  // T-127：夹具改走 defineTool 后，label 由 name 补齐 —— 这正是 15 个生产
  // 工具的实际形状（它们都不显式写 label，靠 `label || name`）。以前这里断言
  // '回显参数'，验的是夹具自己声明的 label，与生产不同形。
  assert.equal(runtime.label, 'echo', 'label 由构造器补 name（与生产同形）');
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
    ctx: [],
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
    buildUserMessage: ({ userText }) => userText,
  });
  const ret = await agent.send({
    userText: 'hi',
    onEvent: (e) => events.push(e),
  });

  const errs = events.filter((e) => e.kind === AGENT_EVENTS.ERROR);
  assert.equal(errs.length, 1, '必须产出错误事件');
  assert.equal(errs[0].message, '网络断了');
  assert.equal(
    errs[0].errorKind,
    'provider',
    '无法分类时至少归为 provider，不留空'
  );
  assert.equal(ret.kind, AGENT_EVENTS.ERROR, 'send 返回的必须是 ERROR');
  assert.equal(
    events.filter((e) => e.kind === AGENT_EVENTS.DONE).length,
    0,
    '出错时不发 DONE'
  );
});

test('T-60：缺 toolCallId 要有独立打点，且正常轮次计数为 0（反向断言）', async () => {
  const entries = [];
  const log = (event, data) => entries.push({ event, data });
  log.warn = log;
  log.error = log;

  // 先跑有 id 的正常轮次：计数器必须是 0，否则「恒 ≥ 1」这种实现也能过
  const ok = makeAgent(
    [toolCallStream('echo', { msg: 'x' }), piStream('好的')],
    {
      log,
    }
  );
  const okDone = await send(ok);
  assert.equal(okDone.missingToolCallIds, 0, '有 id 的调用不该被记成缺失');
  assert.equal(
    entries.filter((e) => e.event === 'tool.call.missingId').length,
    0,
    '正常轮次不该打 missingId'
  );

  // 再跑缺 id 的轮次：计数与打点都要出现
  const entries2 = [];
  const log2 = (event, data) => entries2.push({ event, data });
  log2.warn = log2;
  log2.error = log2;
  const bad = makeAgent(
    [toolCallStreamNoId('echo', { msg: 'x' }), piStream('好的')],
    { log: log2 }
  );
  const badDone = await send(bad);
  assert.equal(badDone.missingToolCallIds, 1, '缺 id 的调用要计 1');
  const warn = entries2.filter((e) => e.event === 'tool.call.missingId');
  assert.equal(
    warn.length,
    1,
    '缺 id 要有一条独立打点，而不是混在 tool.call 里'
  );
  assert.equal(warn[0].data.name, 'echo', '打点要带上是哪个工具');

  // 计数必须是「本轮」的：**同一个 agent** 再发一轮（fakeStream 队列空了就回
  // piStream('ok')，这轮没有工具调用），计数要归零。不这么写就测不到重置 ——
  // 换一个 agent 测的话，闭包本来就是新的，恒过。
  const second = await send(bad);
  assert.equal(
    second.missingToolCallIds,
    0,
    '第二轮没有缺 id 的调用，计数必须清零'
  );
});
test('toolCall 块缺 id 时 pi 不崩，工具照常执行', async () => {
  // 迁移前 wire.js 会跳过没有 toolCallId 的空转块。pi 的行为**不同**：
  // 实测（探针，见票 08 完成记录）它不跳过，直接把 id 当undefined 传下去，
  // assistant 块与 toolResult 两边的 id 都是 undefined，仍然配对。
  //
  // 这条钉的是「不炸整轮」这个契约。⚠️ 配对靠的是两边都 undefined ——
  // 真发到 provider 时会不会被拒未实测（夹具层看不到请求）。
  const h = makeAgent([
    toolCallStreamNoId('echo', { msg: 'x' }),
    piStream('好的'),
  ]);
  const doneEv = await send(h);

  const toolMsg = h.streamFn.calls[1].context.messages.find(
    (m) => m.role === 'toolResult'
  );
  assert.ok(toolMsg, '缺 id 也要产出工具结果');
  assert.equal(toolMsg.isError, false, '缺 id 不是工具的错');
  assert.ok(
    toolMsg.content[0].text.includes('echo:'),
    `工具应照常执行，实际 ${toolMsg.content[0].text}`
  );
  assert.equal(doneEv.kind, AGENT_EVENTS.DONE, '缺 id 不终止整轮');

  // T-60：光「不炸」不够 —— 要让这件事在这一轮的收尾处看得见。
  assert.equal(
    doneEv.missingToolCallIds,
    1,
    '缺 toolCallId 的调用要计入 DONE，否则只能事后翻日志找'
  );
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
    buildUserMessage: ({ userText }) => userText,
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
    // 票 05 已完成，但这条**做不到**：Retry-After 是响应头，pi 在 OpenAI 兼容
    // 路径上 `onResponse` 对 4xx 一次都不触发，headers 拿不到。
    // 降级后的能力是「提取到 429 状态码」（票 05 的两条测试钉住那个）。
    skip: 'B9 第 2 项：Retry-After 头在 pi 的 openai-compat 路径上不可得',
  }
);

/* ---------------- 参数完整性 ---------------- */

test('provider 发来半截参数 JSON 时转成 error 观察值，不炸整轮', async () => {
  // 迁移前由 openai-compat 的 JSON.parse try/catch 兜住。pi 的参数校验接手了
  // 这件事 —— 实测产出：`Validation failed for tool "echo": - root: must be object`，
  // isError 为真，且带原样回显的 arguments（模型据此自我纠正）。
  const h = makeAgent([
    toolCallStreamRawArgs('echo', '{"msg":'),
    piStream('好的'),
  ]);
  const doneEv = await send(h);

  const toolMsg = h.streamFn.calls[1].context.messages.find(
    (m) => m.role === 'toolResult'
  );
  assert.ok(toolMsg, '坏参数也要有结果消息');
  assert.equal(toolMsg.isError, true, '参数坏掉是错误观察值');
  assert.match(
    toolMsg.content[0].text,
    /Validation failed|must be object/i,
    `错误信息要指明是参数问题，实际 ${toolMsg.content[0].text}`
  );
  assert.equal(doneEv.kind, AGENT_EVENTS.DONE, '坏参数不终止整轮');
});

// 原「端到端回归：分片 args 经真实 provider 聚合」一条已在票 08 随 llm/ 删除，
// 真实 provider 的分片聚合现在由 pi 负责。替代断言是下面这条 —— 断言的是**行为**
// （工具最终拿到完整对象），不关心它经了几片。
test('分片参数聚合后，工具拿到的是完整参数对象', async () => {
  // 替代上面那条端到端回归（票 08 会删掉它）。断言的是**行为**：
  // 无论参数怎么分片到达，工具最终收到的是一个完整的对象。
  const got = [];
  const tool = {
    name: 'echo',
    label: 'Echo',
    class: 'read',
    group: 'context',
    ctx: [],
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

// ── 票 05：错误分类降级与重试接线 ──

test('HTTP 状态码能从错误信息里提取出来（韧性要求）', () => {
  // pi 的错误信息里实测带状态码：「429: {...}」「OpenAI API error (429): ...」。
  // 票 05 明确：分类必须在降级后如实保留 HTTP 状态码，不能只有个「网络错误」模糊词。
  const err = fromPiEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: '429: {"error": {"message": "rate limited"}}',
    },
  });
  assert.equal(err.errorKind, ERROR_KIND.PROVIDER);
  assert.equal(err.httpStatus, 429, '必须提取出状态码 429');
});

test('「Connection error.」与「fetch failed」归为 network，与 provider 区分', () => {
  // pi 网络层失败的固定文案（实测：Connection error.）。这类错误和
  // provider 返回错误在用户语义上截然不同（一个是「没连上」，一个是
  // 「连上了但服务端报错」），UI 要靠 kind 分开。
  const net = fromPiEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Connection error.',
    },
  });
  assert.equal(net.errorKind, ERROR_KIND.NETWORK);

  const fetchFail = fromPiEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'fetch failed',
    },
  });
  assert.equal(fetchFail.errorKind, ERROR_KIND.NETWORK);
});

test('streamFn 的 optionsd 带 maxRetries: 3，可重试失败有救', async () => {
  // pi 的 Agent 不转发maxRetries（provider-retry 里默认 0），我们包了一层
  // streamFnWithRetry 显式注入。这条测试钉住注入点——它不能静默降级成不重试。
  const h = makeAgent([piStream('ok')]);
  await send(h);
  const opts = h.streamFn.calls[0].options;
  assert.equal(opts.maxRetries, 3, `实际 ${JSON.stringify(opts.maxRetries)}`);
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
    userEv.promptText.includes('<untrusted_user_message>'),
    'promptText 形态存进事件，续接时无需二次包装（票 08 前叫 wire）'
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
      promptText: '<untrusted_user_message>\nhi\n</untrusted_user_message>',
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
    notice.promptText.includes('<untrusted_system_notice>'),
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
  assert.ok(inj.promptText.includes('任务进行中插话'), '要标明是任务中插话');

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
    buildUserMessage: ({ userText }) => userText,
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

test('T-59：read 类工具的调用与结果都要有打点（含参数摘要）', async () => {
  const entries = [];
  const log = (event, data) => entries.push({ event, data });
  log.warn = log;
  log.error = log;

  // 用 read 类工具：write 类本来就有 confirm.ask 带 args，read 类此前一个点都没有
  const h = makeAgent(
    [toolCallStream('echo', { q: '关键词' }), piStream('好的')],
    { log }
  );
  await send(h);

  const call = entries.find((e) => e.event === 'tool.call');
  assert.ok(call, '缺 tool.call 打点');
  assert.equal(call.data.name, 'echo');
  assert.ok(
    call.data.toolCallId,
    '打点要能对上 toolCallId，否则并行调用分不清'
  );
  assert.equal(
    call.data.args,
    '{"q":"关键词"}',
    '参数摘要必须是模型真传的那份（pi start 事件带的 args）'
  );

  const result = entries.find((e) => e.event === 'tool.result');
  assert.ok(result, '缺 tool.result 打点');
  assert.equal(result.data.name, 'echo');
  assert.equal(
    result.data.status,
    TOOL_STATUS.OK,
    '结果打点要带上终态，用户被拒的应是 REJECTED'
  );
  assert.ok(
    result.data.observation.includes('echo:'),
    '结果摘要要能看到工具返回了什么，实际：' + result.data.observation
  );
});

test('T-59：用户拒的工具，tool.result 打点记 REJECTED 而不是失败', async () => {
  const entries = [];
  const log = (event, data) => entries.push({ event, data });
  log.warn = log;
  log.error = log;

  const h = makeAgent(
    [toolCallStream('do_write', { code: '1' }), piStream('好')],
    {
      tools: [writeTool],
      log,
      requestConfirmation: async () => ({ approved: false }),
    }
  );
  await send(h);

  const result = entries.find((e) => e.event === 'tool.result');
  assert.ok(result, '缺 tool.result 打点');
  assert.equal(
    result.data.status,
    TOOL_STATUS.REJECTED,
    'pi 只知道「这次工具失败了」，拒绝这件事只有我们的钩子知道'
  );
});

test('T-59：超长参数要截断，否则一行日志能冲垮 ring 缓冲', async () => {
  const entries = [];
  const log = (event, data) => entries.push({ event, data });
  log.warn = log;
  log.error = log;

  const big = 'x'.repeat(5000);
  const h = makeAgent([toolCallStream('echo', { q: big }), piStream('好的')], {
    log,
  });
  await send(h);

  const call = entries.find((e) => e.event === 'tool.call');
  assert.ok(call, '缺 tool.call 打点');
  assert.ok(
    call.data.args.length < 500,
    '截断后不该超过约 400 + 截断标记，实际 ' + call.data.args.length
  );
  assert.ok(
    call.data.args.includes('已截断'),
    '要写明这是截断的，否则读日志的人会以为参数就这么多'
  );
});

test('write 工具的确认门打点：confirm.ask / confirm.answer', async () => {
  const entries = [];
  const log = (event, data) => entries.push({ event, data });
  log.warn = (event, data) => entries.push({ event, data });
  log.error = log.warn;

  const h = makeAgent(
    [toolCallStream('do_write', { code: '1 + 1' }), piStream('好的')],
    {
      tools: [writeTool],
      log,
      requestConfirmation: async () => ({ approved: false }),
    }
  );
  await send(h);

  const ask = entries.find((e) => e.event === 'tool.confirm.ask');
  assert.ok(ask, '缺 tool.confirm.ask 打点');
  assert.equal(ask.data.name, 'do_write');
  assert.deepEqual(ask.data.args, { code: '1 + 1' }, '打点要带参数摘要');

  const answer = entries.find((e) => e.event === 'tool.confirm.answer');
  assert.ok(answer, '缺 tool.confirm.answer 打点');
  assert.equal(
    answer.data.approved,
    false,
    '拒绝也要打点，否则事后查不出卡在哪'
  );
});

test('默认无日志时不炸：不传 log 照常跑完', async () => {
  const h = makeAgent([piStream('hi')]);
  await send(h);
  assert.equal(of(h, AGENT_EVENTS.DONE).length, 1);
});

/* ---------------- T-61~T-65（2026-10-05 迁移 review 修复回归） ---------------- */

test('initialHistory 带着上一轮的旧 ERROR 时，本轮成功仍发 DONE（T-61）', async () => {
  // 轮末的「本轮是否出错」判定只准扫本轮新增的事件 —— history 里灌进了
  // 上轮落盘的全部事件，旧 ERROR 会把本轮成功误判成失败、不发 DONE。
  const history1 = [
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '你好',
      promptText: wrapUntrusted('untrusted_user_message', '你好'),
    },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '第一轮半路断了' },
    {
      kind: AGENT_EVENTS.ERROR,
      message: '网络断了',
      errorKind: ERROR_KIND.PROVIDER,
      timestamp: Date.now(),
    },
  ];
  const h = makeAgent([piStream('第二轮成功了')]);
  const doneEv = await h.agent.send({
    userText: '再试一次',
    onEvent: (e) => h.events.push(e),
    initialHistory: history1,
  });

  assert.equal(doneEv.kind, AGENT_EVENTS.DONE, '旧 ERROR 不能把本轮判成失败');
  assert.deepEqual(
    doneEv.usage,
    { input: 10, output: 5 },
    'usage 也只统计本轮，不受历史影响'
  );
});

test('usage 累加本轮全部 assistant 消息，多步轮不低估（T-62）', async () => {
  const step1 = piStream(
    [{ type: 'toolCall', id: 'call-1', name: 'echo', arguments: {} }],
    {
      stopReason: 'toolUse',
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 110,
      },
    }
  );
  const step2 = piStream('好的', {
    usage: {
      input: 200,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 220,
    },
  });
  const h = makeAgent([step1, step2]);
  const doneEv = await send(h);

  assert.equal(doneEv.kind, AGENT_EVENTS.DONE);
  assert.deepEqual(
    doneEv.usage,
    { input: 300, output: 30 },
    '一个工具轮两次 LLM 请求的用量必须累加，只取末条会低估'
  );

  // 跨轮：piAgent 复用，第二轮只准统计本轮新增的 assistant 消息
  const doneEv2 = await send(h);
  assert.deepEqual(
    doneEv2.usage,
    { input: 10, output: 5 },
    '第二轮只含它自己那一次请求的用量'
  );
});

test('USER_MESSAGE / SYSTEM_NOTICE 事件缺 promptText 时抛错，不回落裸文本（T-63）', () => {
  // ev.text 是未包装原文，回落即裸文本直达模型（T-56 的同形复活）。
  // 包装缺失必须炸出来，不能静默降级。
  assert.throws(
    () =>
      historyToPiMessages([
        { kind: AGENT_EVENTS.USER_MESSAGE, text: '未包装的原文' },
      ]),
    /缺 promptText/
  );
  assert.throws(
    () =>
      historyToPiMessages([
        { kind: AGENT_EVENTS.SYSTEM_NOTICE, text: '未包装的通知' },
      ]),
    /缺 promptText/
  );
});

test('输出撞到 token 上限时工具不执行，模型收到「参数可能被截断」（story 2 / T-65）', async () => {
  // pi 对 stopReason==='length' 的处理（agent-loop.js failToolCallsFromTruncatedMessage）：
  // 消息里所有 toolCall 一律不执行，产出 isError 的「参数可能被截断，请重发」
  // 错误结果。spec story 2 要求的正是这个行为，这条测试把它钉住 —— pi 改了就会红。
  let executed = false;
  const tool = {
    ...echoTool,
    ctx: [],
    execute: async () => {
      executed = true;
      return 'should not run';
    },
  };
  const h = makeAgent(
    [
      piStream(
        [
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'echo',
            arguments: { msg: 'x' },
          },
        ],
        { stopReason: 'length' }
      ),
      piStream('好的'),
    ],
    { tools: [tool] }
  );
  const doneEv = await send(h);

  assert.equal(executed, false, '截断消息里的工具调用绝不能执行');
  const toolMsg = h.streamFn.calls[1].context.messages.find(
    (m) => m.role === 'toolResult'
  );
  assert.ok(toolMsg, '截断也要产出工具结果消息');
  assert.equal(toolMsg.isError, true, '截断是错误结果，不能让模型以为执行成功');
  assert.match(
    toolMsg.content[0].text,
    /truncat|output token limit/i,
    `错误信息要说明参数可能被截断，实际 ${toolMsg.content[0].text}`
  );
  assert.equal(doneEv.kind, AGENT_EVENTS.DONE, '截断不终止整轮，模型可重发');
});

/* ---------------- T-66~T-73（2026-10-05 review 二轮修复回归） ---------------- */

test('createAgent 缺 wrapUntrusted 直接抛（T-55 校验迁到消费点，T-69）', () => {
  // adapter 的同名形参删除后，「缺注入必须炸」由真正的消费点 createAgent 执行：
  // 用户消息回显、预检、插话、pi 自产工具结果的包装全靠它。
  assert.throws(
    () =>
      createAgent({
        streamFn: async () => ({}),
        model: testModel,
        promptFacts: () => ({}),
      }),
    /缺 wrapUntrusted/
  );
});

test('createAgent 缺 buildUserMessage 直接抛（T-84）——旧缺省兜底会静默丢 targetTab 元数据', () => {
  assert.throws(
    () =>
      createAgent({
        streamFn: async () => ({}),
        model: testModel,
        promptFacts: () => ({}),
        wrapUntrusted,
      }),
    /缺 buildUserMessage/
  );
});

test('旧持久化记录的 wire 字段在续接时兼容读（T-67）', () => {
  // 升级前的会话记录里字段名叫 wire；改名后老会话续接不能炸。
  const msgs = historyToPiMessages([
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '旧会话的消息',
      wire: '<untrusted_user_message>\n旧会话的消息\n</untrusted_user_message>',
    },
  ]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'user');
  assert.ok(
    String(msgs[0].content).includes('<untrusted_user_message>'),
    '兼容读必须拿到包装文本'
  );
});

test('historyToPiMessages 遇到未知事件类型抛错，不静默丢（T-71）', () => {
  // default 分支的旧实现是注释喊着「不能静默丢」、实现悄悄 break。
  assert.throws(
    () =>
      historyToPiMessages([
        { kind: 'agent:future-kind', text: '未来才有的事件' },
      ]),
    /未知的 agent 事件类型/
  );
});

test('tool_execution_end 的 observation 是包装好的结果文本（T-132）', () => {
  // adapter 产出的结果已包装：原样透传，不二次包装
  const wrapped = wrapUntrusted('untrusted_tool_result', '工具的产出');
  const ours = fromPiEvent({
    type: 'tool_execution_end',
    toolCallId: 'c1',
    toolName: 'echo',
    result: { content: [{ type: 'text', text: wrapped }], details: {} },
    isError: false,
  });
  assert.equal(ours.observation, wrapped, '已包装的结果原样透传');
  assert.equal(ours.status, TOOL_STATUS.OK);

  // pi 自产的结果（未知工具短路等）没有经过 adapter：必须在这里补包装
  const piNative = fromPiEvent({
    type: 'tool_execution_end',
    toolCallId: 'c2',
    toolName: 'nope',
    result: {
      content: [{ type: 'text', text: 'Tool "nope" not found' }],
    },
    isError: true,
  });
  assert.equal(piNative.status, TOOL_STATUS.ERROR);
  assert.ok(
    piNative.observation.includes('<untrusted_tool_result>'),
    `pi 自产结果必须补包装，实际 ${piNative.observation}`
  );
  assert.ok(piNative.observation.includes('not found'), '错误文本保留');
});

test('重建 transcript 用的是 observation 包装文本，不是 details 的 JSON（T-132）', () => {
  // 修复前 end 事件 observation 是空占位，重建时把整个 AgentToolResult
  // JSON.stringify 进上下文 —— 未包装、双层编码。
  const observation = wrapUntrusted('untrusted_tool_result', '工具的产出');
  const msgs = historyToPiMessages([
    {
      kind: AGENT_EVENTS.TOOL_RESULT,
      toolCallId: 'c1',
      name: 'echo',
      status: TOOL_STATUS.OK,
      observation,
      details: { content: [{ type: 'text', text: 'should not appear' }] },
    },
  ]);
  const toolMsg = msgs.find((m) => m.role === 'toolResult');
  assert.equal(toolMsg.content[0].text, observation, 'transcript 里是包装文本');
  assert.ok(
    !toolMsg.content[0].text.includes('should not appear'),
    'details 的 JSON 不许漏进 transcript'
  );
});

/* ---------------- T-74 方案 B：TOOL_CALL 按调用拆开发射 ---------------- */

test('并行工具调用拆成 N 条 TOOL_CALL 事件，事件流里不再有 calls[]（T-74 方案 B）', async () => {
  const multi = piStream(
    [
      { type: 'toolCall', id: 'c1', name: 'echo', arguments: { n: 1 } },
      { type: 'toolCall', id: 'c2', name: 'echo', arguments: { n: 2 } },
    ],
    { stopReason: 'toolUse' }
  );
  const h = makeAgent([multi, piStream('好的')]);
  await send(h);

  const callEvents = of(h, AGENT_EVENTS.TOOL_CALL);
  assert.equal(callEvents.length, 2, '两个调用必须拆成两条事件');
  assert.deepEqual(
    callEvents.map((e) => e.toolCallId),
    ['c1', 'c2'],
    JSON.stringify(callEvents.map((e) => e.toolCallId))
  );
  assert.deepEqual(
    callEvents.map((e) => e.args),
    [{ n: 1 }, { n: 2 }]
  );
  for (const e of callEvents) {
    assert.equal(e.calls, undefined, '事件流里不许再有 calls[] 字段');
    assert.ok(e.name, '平铺字段必须齐全');
  }
});

test('重建：新格式（平铺两条 TOOL_CALL）的并行调用全部进 transcript，无孤儿（T-74）', () => {
  const msgs = historyToPiMessages([
    {
      kind: AGENT_EVENTS.TOOL_CALL,
      name: 'echo',
      args: { n: 1 },
      toolCallId: 'c1',
    },
    {
      kind: AGENT_EVENTS.TOOL_CALL,
      name: 'echo',
      args: { n: 2 },
      toolCallId: 'c2',
    },
    {
      kind: AGENT_EVENTS.TOOL_RESULT,
      toolCallId: 'c1',
      name: 'echo',
      status: TOOL_STATUS.OK,
      observation: '一',
    },
    {
      kind: AGENT_EVENTS.TOOL_RESULT,
      toolCallId: 'c2',
      name: 'echo',
      status: TOOL_STATUS.OK,
      observation: '二',
    },
  ]);
  const rebuilt = msgs.find((m) => m.role === 'assistant');
  const ids = rebuilt.content
    .filter((c) => c.type === 'toolCall')
    .map((c) => c.id);
  assert.deepEqual(ids, ['c1', 'c2'], '两个调用块都必须在');
  const results = msgs
    .filter((m) => m.role === 'toolResult')
    .map((m) => m.toolCallId);
  assert.deepEqual(results, ['c1', 'c2']);
  for (const id of results) {
    assert.ok(ids.includes(id), `toolResult ${id} 成了孤儿（没有配对的调用）`);
  }
});

test('重建：旧格式（一条事件装 calls[]）兼容展开，不再丢第 2..N 个调用（T-74）', () => {
  // 修复前的探针场景（.scratch/probe-calls.mjs）：一条 TOOL_CALL 事件装
  // c1/c2，重建只活 c1，c2 的结果成了孤儿。旧记录升级后必须照样展开。
  const msgs = historyToPiMessages([
    {
      kind: AGENT_EVENTS.TOOL_CALL,
      name: 'echo',
      args: { n: 1 },
      toolCallId: 'c1',
      calls: [
        { name: 'echo', args: { n: 1 }, toolCallId: 'c1' },
        { name: 'echo', args: { n: 2 }, toolCallId: 'c2' },
      ],
    },
    {
      kind: AGENT_EVENTS.TOOL_RESULT,
      toolCallId: 'c1',
      name: 'echo',
      status: TOOL_STATUS.OK,
      observation: '一',
    },
    {
      kind: AGENT_EVENTS.TOOL_RESULT,
      toolCallId: 'c2',
      name: 'echo',
      status: TOOL_STATUS.OK,
      observation: '二',
    },
  ]);
  const rebuilt = msgs.find((m) => m.role === 'assistant');
  const ids = rebuilt.content
    .filter((c) => c.type === 'toolCall')
    .map((c) => c.id);
  assert.deepEqual(
    ids,
    ['c1', 'c2'],
    `旧记录的并行调用必须全部展开，实际 ${JSON.stringify(ids)}`
  );
});

/* ---------------- T-76 上下文压缩 ---------------- */

const wrapUser = (t) => wrapUntrusted('untrusted_user_message', t);

test('historyToPiMessages 投影 compaction：摘要之前的旧事件不再进 transcript（T-76）', () => {
  const events = [
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '旧问题',
      promptText: wrapUser('旧问题'),
    },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '旧回答' },
    {
      kind: AGENT_EVENTS.COMPACTION,
      summary: '## 任务目标\n做某事',
      tokensBefore: 100,
      summarizedTurns: 1,
      createdAt: 1,
    },
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '新问题',
      promptText: wrapUser('新问题'),
    },
  ];
  const msgs = historyToPiMessages(events);
  // [compaction 摘要消息, 新问题]
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.ok(msgs[0].content.includes('已压缩为摘要'));
  assert.ok(msgs[0].content.includes('<untrusted_compaction_summary>'));
  assert.ok(msgs[0].content.includes('## 任务目标'));
  assert.ok(
    !msgs.some((m) => JSON.stringify(m).includes('旧问题')),
    '被摘要掉的老轮次不得进 transcript'
  );
  assert.ok(msgs[1].content.includes('新问题'));
});

test('上下文估算超阈值：send 先发摘要请求，compaction 事件在 START 之前入史（T-76）', async () => {
  // contextWindow 4096 → threshold 2048 / keep 1024。
  // initialHistory：小轮 + 大轮（约 3900 token）→ 越过阈值，切点落在第二轮开头。
  const initialHistory = [
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '旧一',
      promptText: wrapUser('旧一'),
    },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '好' },
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '旧二',
      promptText: wrapUser('旧二'.repeat(650)),
    },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '旧答'.repeat(650) },
  ];
  const h = makeAgent([piStream('这是摘要'), piStream('本轮回答')], {
    contextWindow: 4096,
    systemPromptOverride: 'sys',
  });
  const doneEv = await send(h, { initialHistory });

  assert.equal(doneEv.kind, AGENT_EVENTS.DONE);
  // 第 1 次调用是摘要请求，第 2 次才是主请求
  assert.equal(h.streamFn.calls.length, 2);
  assert.equal(
    h.streamFn.calls[0].context.systemPrompt,
    SUMMARIZATION_SYSTEM_PROMPT
  );
  assert.ok(
    h.streamFn.calls[0].context.messages[0].content.includes('<conversation>'),
    '摘要请求携带序列化后的对话'
  );
  assert.ok(h.streamFn.calls[0].options.maxTokens > 0, '摘要请求带输出上限');
  assert.notEqual(
    h.streamFn.calls[1].context.systemPrompt,
    SUMMARIZATION_SYSTEM_PROMPT
  );

  // 压缩事件入史且在 START 之前；用户事件流可见
  const hist = h.agent.getHistory();
  const compIdx = hist.findIndex((e) => e.kind === AGENT_EVENTS.COMPACTION);
  const startIdx = hist.findIndex((e) => e.kind === AGENT_EVENTS.START);
  assert.ok(compIdx !== -1, 'compaction 事件必须入史');
  assert.ok(startIdx !== -1 && compIdx < startIdx);
  assert.ok(h.events.some((e) => e.kind === AGENT_EVENTS.COMPACTION));

  // 主请求的 transcript：摘要进了；被摘要的第一轮没进；
  // 第二轮在保留窗内（切口回退到它的轮首），原样保留
  const mainMessages = JSON.stringify(h.streamFn.calls[1].context.messages);
  assert.ok(mainMessages.includes('untrusted_compaction_summary'));
  assert.ok(!mainMessages.includes('旧一'), '被摘要的旧轮不得再进 transcript');
  assert.ok(mainMessages.includes('旧二'), '保留窗内的轮次原样保留');
});

test('摘要请求失败不杀轮：压缩跳过，主轮照常（T-76）', async () => {
  const initialHistory = [
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '旧一',
      promptText: wrapUser('旧一'),
    },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '好' },
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '旧二',
      promptText: wrapUser('旧二'.repeat(650)),
    },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '旧答'.repeat(650) },
  ];
  const logCalls = [];
  const log = (e) => logCalls.push(e);
  log.warn = (e) => logCalls.push(e);
  log.error = (e) => logCalls.push(e);
  log.ring = [];
  log.has = (e) => logCalls.includes(e);

  const h = makeAgent(
    [
      // 摘要请求报错
      piStream('x', { stopReason: 'error', errorMessage: '余额不足' }),
      piStream('本轮回答'),
    ],
    { contextWindow: 4096, systemPromptOverride: 'sys', log }
  );
  const doneEv = await send(h, { initialHistory });

  assert.equal(doneEv.kind, AGENT_EVENTS.DONE, '压缩失败不能把轮变成错误');
  assert.equal(h.streamFn.calls.length, 2, '摘要失败后主请求照发');
  assert.ok(logCalls.includes('compaction.skip'), '跳过压缩必须留痕');
  assert.ok(
    !h.agent.getHistory().some((e) => e.kind === AGENT_EVENTS.COMPACTION),
    '失败的摘要绝不落库'
  );
});

test('摘要输出被截断时日志带 summaryMaxTokens，否则排查不出是上限太大（T-93②）', async () => {
  const initialHistory = [
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '旧一',
      promptText: wrapUser('旧一'),
    },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '好' },
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '旧二',
      promptText: wrapUser('旧二'.repeat(650)),
    },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '旧答'.repeat(650) },
  ];
  const warns = [];
  const log = () => {};
  log.warn = (e, d) => warns.push({ e, d });
  log.error = () => {};
  log.ring = [];
  log.has = () => false;

  const h = makeAgent(
    [
      // 摘要输出撞上 maxTokens：stopReason='length'
      piStream('半截摘要', { stopReason: 'length' }),
      piStream('本轮回答'),
    ],
    { contextWindow: 4096, systemPromptOverride: 'sys', log }
  );
  const doneEv = await send(h, { initialHistory });

  assert.equal(doneEv.kind, AGENT_EVENTS.DONE, '摘要截断不能把轮变成错误');
  const skip = warns.find((w) => w.e === 'compaction.skip');
  assert.ok(skip, '跳过压缩必须留痕');
  assert.ok(
    skip.d.message.includes('summaryMaxTokens'),
    '日志里看不出 maxTokens 就无法区分「上限过大」与「模型写太长」：' +
      skip.d.message
  );
});

test('主请求撞上下文上限：压缩 → continue 续跑 → 正常收尾（T-76）', async () => {
  // initialHistory 约 1030 token：低于阈值（不触发预压缩）但超过保留窗 1024
  // （溢出恢复的 force 压缩有切点可用）。systemPromptOverride 钉死 system 体积。
  const initialHistory = [
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '旧一',
      promptText: wrapUser('旧一'),
    },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '好' },
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '旧二',
      promptText: wrapUser('旧二'.repeat(300)),
    },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '旧答'.repeat(300) },
  ];
  const h = makeAgent(
    [
      // 主请求：provider 报 context overflow
      piStream('x', {
        stopReason: 'error',
        errorMessage: "This model's maximum context length is 4096 tokens",
      }),
      // 恢复路径的摘要请求
      piStream('这是摘要'),
      // continue() 续跑的回答
      piStream('恢复后的回答'),
    ],
    { contextWindow: 4096, systemPromptOverride: 'sys' }
  );
  const doneEv = await send(h, { initialHistory });

  assert.equal(
    doneEv.kind,
    AGENT_EVENTS.DONE,
    '恢复成功必须正常收尾，不返回错误'
  );
  assert.equal(h.streamFn.calls.length, 3, '主请求 + 摘要 + continue 共三次');
  assert.equal(
    h.streamFn.calls[1].context.systemPrompt,
    SUMMARIZATION_SYSTEM_PROMPT
  );

  // 恢复后的续跑请求：被摘要的第一轮已被摘要取代；
  // 第二轮在保留窗内原样保留，尾巴是本轮 user 消息（continue 的前置条件）
  const continueMessages = JSON.stringify(h.streamFn.calls[2].context.messages);
  assert.ok(continueMessages.includes('untrusted_compaction_summary'));
  assert.ok(
    !continueMessages.includes('旧一'),
    '被摘要的旧轮不得再进 transcript'
  );
  assert.ok(continueMessages.includes('旧二'), '保留窗内的轮次原样保留');

  // 用户看得见：压缩事件 + 恢复通知
  assert.ok(h.events.some((e) => e.kind === AGENT_EVENTS.COMPACTION));
  assert.ok(h.events.some((e) => e.kind === AGENT_EVENTS.SYSTEM_NOTICE));
});

/* ---------------- T-63: 活轮次发「元数据 + 原文」, 入史仍是全包装 ---------------- */

test('T-63: 活轮次请求带目标页元数据, 用户原文不进 untrusted 标签', async () => {
  const h = makeAgent([piStream('好的')], { buildUserMessage });
  await send(h, { userText: '帮我看看这个页面' });

  const live = h.streamFn.calls[0].context.messages
    .filter((m) => m.role === 'user')
    .pop();
  // pi 的 user 消息 content 是 [{type:'text',text}] —— 先取块文本再断言
  const liveText = live.content.map((c) => c.text).join('');

  assert.ok(
    liveText.includes('<untrusted_tab_metadata'),
    '首轮也必须让模型知道在哪个页面: ' + liveText
  );
  assert.ok(liveText.includes('url="https://a.com"'), liveText);
  assert.ok(
    !liveText.includes('<untrusted_user_message'),
    '当轮指令不包装: ' + liveText
  );
  assert.ok(
    liveText.endsWith('帮我看看这个页面'),
    '原文逐字送到模型: ' + liveText
  );
});

test('T-63: 入史的 promptText 仍是全包装版（重放侧契约不变）', async () => {
  const h = makeAgent([piStream('好的')], { buildUserMessage });
  await send(h, { userText: '帮我看看这个页面' });

  const stored = h.events.find((e) => e.kind === AGENT_EVENTS.USER_MESSAGE);
  assert.ok(stored.promptText, '必须入史');
  assert.ok(
    stored.promptText.includes('<untrusted_user_message'),
    stored.promptText
  );
  assert.ok(
    stored.promptText.includes('<untrusted_tab_metadata'),
    stored.promptText
  );
  assert.equal(stored.text, '帮我看看这个页面', '面板回显用原文, 不受影响');

  // 重放进 pi 的是入史那份（包装版）, 不是活轮次那份
  // historyToPiMessages 投影出的 user 消息 content 是**字符串**（promptText 整体）
  const replayedText = historyToPiMessages([stored])[0].content;
  assert.ok(replayedText.includes('<untrusted_user_message'), replayedText);
});

test('T-63: 没有目标页时活轮次只剩用户原文, 不留空包装块', async () => {
  const h = makeAgent([piStream('好的')], { buildUserMessage });
  await send(h, { userText: '你好', targetTab: null });

  const live = h.streamFn.calls[0].context.messages
    .filter((m) => m.role === 'user')
    .pop();
  assert.deepEqual(live.content, [{ type: 'text', text: '你好' }]);
});

/* ---------------- T-95：活轮次的实测上下文 ---------------- */

test('T-95：活轮次有实测 usage 时用实测判阈值，不再按估算压历史', async () => {
  // 与上面那条 T-76 用例同一份 initialHistory：估算约 3900 token > 阈值 2048，
  // 所以**没有**实测值时会先发一次摘要请求。
  const initialHistory = [
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '旧一',
      promptText: wrapUser('旧一'),
    },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '好' },
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '旧二',
      promptText: wrapUser('旧二'.repeat(650)),
    },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '旧答'.repeat(650) },
  ];

  // 先跑一轮把 pi 的 transcript 填上：最后一条 assistant 带真实 usage，
  // 报「上一次请求的完整 prompt 只有 1600 token」= input 100 + cacheRead 1500。
  // （cacheRead 必须算进去，否则这条就退化成「只读 input」的弱断言。）
  const h = makeAgent(
    [
      piStream('第一轮回答', {
        usage: { input: 100, output: 20, cacheRead: 1500, cacheWrite: 0 },
      }),
      piStream('本轮回答'),
    ],
    { contextWindow: 4096, systemPromptOverride: 'sys' }
  );
  await send(h);

  const doneEv = await send(h, { initialHistory });
  assert.equal(doneEv.kind, AGENT_EVENTS.DONE);
  assert.equal(
    h.streamFn.calls.length,
    2,
    '两轮各一次主请求，没有多出摘要请求'
  );
  assert.ok(
    !h.streamFn.calls.some(
      (c) => c.context.systemPrompt === SUMMARIZATION_SYSTEM_PROMPT
    ),
    '实测上下文 1600 < 阈值 2048，不该按 3900 的估算去压历史'
  );
  assert.equal(of(h, AGENT_EVENTS.COMPACTION).length, 0, '不该产生压缩事件');
});

test('T-95：没有实测值时行为不变（照旧按估算压）', async () => {
  const initialHistory = [
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '旧一',
      promptText: wrapUser('旧一'),
    },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '好' },
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '旧二',
      promptText: wrapUser('旧二'.repeat(650)),
    },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '旧答'.repeat(650) },
  ];
  const h = makeAgent(
    [piStream('第一轮回答'), piStream('这是摘要'), piStream('本轮回答')],
    {
      contextWindow: 4096,
      systemPromptOverride: 'sys',
    }
  );
  // 第 1 轮报 0 用量（重放历史正是这个样子）→ 第 2 轮没有可用实测值
  await send(h, { initialHistory });
  assert.ok(
    h.streamFn.calls.length >= 2,
    '没有可用实测值时阈值判断还得跟以前一样按估算走'
  );
});
