import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_EVENTS } from './events';
import {
  estimateTokens,
  estimateHistoryTokens,
  compactionThresholds,
  shouldCompact,
  measuredContextTokens,
  planCompaction,
  serializeForSummary,
  buildSummaryUserPrompt,
  buildCompactionEvent,
  isContextOverflowMessage,
  dropTrailingPartialAssistant,
  projectAfterLastCompaction,
  TOOL_RESULT_MAX_CHARS,
  TOOL_ARGS_MAX_CHARS,
  SUMMARY_MAX_TOKENS_CAP,
} from './compaction';

/** 造一个 user 轮的事件组：user-message + N 段正文 + 可选的工具往返。 */
function turn(
  userText,
  {
    reply = '好的。',
    toolName = null,
    toolArgs = {},
    observation = '结果',
  } = {}
) {
  const events = [
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: userText,
      promptText: `<untrusted_user_message>\n${userText}\n</untrusted_user_message>`,
    },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: reply },
  ];
  if (toolName) {
    events.push(
      {
        kind: AGENT_EVENTS.TOOL_CALL,
        name: toolName,
        args: toolArgs,
        toolCallId: 't1',
      },
      {
        kind: AGENT_EVENTS.TOOL_RESULT,
        name: toolName,
        toolCallId: 't1',
        status: 'ok',
        observation,
      }
    );
  }
  return events;
}

test('estimateTokens：CJK 按字计、其余按 4 字符计', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1); // 4 字符 1 token
  assert.equal(estimateTokens('自动化助手'), 5); // 5 个 CJK 字
  assert.equal(estimateTokens('自动ab'), 3); // 2 + ceil(2/4)
});

test('estimateHistoryTokens：事件按包装文本计，system 与 tools 计入', () => {
  const events = [...turn('帮我看看页面', { reply: 'abcd' })];
  const base = estimateHistoryTokens({ events, systemPrompt: '', tools: [] });
  assert.ok(base > 0);

  const withSystem = estimateHistoryTokens({
    events,
    systemPrompt: 'x'.repeat(400),
    tools: [],
  });
  assert.equal(withSystem - base, 100); // 400/4

  const withTools = estimateHistoryTokens({
    events,
    systemPrompt: '',
    tools: [{ name: 'read_page' }],
  });
  assert.ok(withTools > base);
});

test('compactionThresholds：32k 与 128k 两档的关键值', () => {
  const t32 = compactionThresholds(32000);
  assert.deepEqual(t32, {
    reserveTokens: 4800,
    thresholdTokens: 27200,
    keepRecentTokens: 8160,
    summaryMaxTokens: 2048, // 0.8*reserve=3840 → 夹到 T-93② 的上限
  });

  const t128 = compactionThresholds(131072);
  assert.equal(t128.reserveTokens, 16384); // 19661 → clamp
  assert.equal(t128.thresholdTokens, 131072 - 16384);
  assert.equal(t128.keepRecentTokens, 20000); // pi 的 128k 默认同数量级

  // 关系式：保留窗必须小于阈值，否则压缩后立刻再次越线
  for (const cw of [4096, 8000, 32000, 131072]) {
    const t = compactionThresholds(cw);
    assert.ok(t.keepRecentTokens <= t.thresholdTokens * 0.5, `cw=${cw}`);
    assert.ok(t.thresholdTokens < cw);
  }

  assert.equal(compactionThresholds(0), null);
  assert.equal(compactionThresholds(Number.NaN), null);
  assert.equal(compactionThresholds(1024), null); // 太小的窗口没有压缩意义
});

test('summaryMaxTokens 恒不超过绝对上限（T-93②）', () => {
  // 大窗口下 0.8*reserve 会算到 13107，远超摘要需要；撞模型输出上限会让
  // 压缩整体跳过（stopReason='length' → 抛错），所以必须夹住
  for (const cw of [4096, 8000, 32000, 131072, 1000000]) {
    const t = compactionThresholds(cw);
    assert.ok(
      t.summaryMaxTokens <= SUMMARY_MAX_TOKENS_CAP,
      `cw=${cw} 的 summaryMaxTokens=${t.summaryMaxTokens} 超过上限`
    );
    assert.ok(t.summaryMaxTokens >= 512, `cw=${cw} 的下限破了`);
  }
  assert.equal(compactionThresholds(131072).summaryMaxTokens, 2048);
  assert.equal(compactionThresholds(4096).summaryMaxTokens, 1638); // 小窗口取小值
});

test('shouldCompact：阈值上下各归各位，非法窗口恒 false', () => {
  assert.equal(shouldCompact(27200, 32000), false); // 等于阈值不压
  assert.equal(shouldCompact(27201, 32000), true);
  assert.equal(shouldCompact(999999, 0), false);
});

test('planCompaction：切口落在 user 轮起点，绝不劈轮', () => {
  // 3 轮，每轮正文约 1950 token（CJK 1 字 1 token）+ 3 token 回复；
  // 保留窗取 8000 档（keep 2048）：第三轮全文 + 回复不足 2048，越线发生在第二轮开头
  const events = [
    ...turn('第一轮'.repeat(650)),
    ...turn('第二轮'.repeat(650)),
    ...turn('第三轮'.repeat(650)),
  ];
  const plan = planCompaction(events, 8000);
  assert.ok(plan, '超过保留窗应给出切点');
  // 从尾部累积在第二轮开头越过 2048 → 切口回退到第二轮起点（index 2）
  assert.equal(events[plan.cutIndex].kind, AGENT_EVENTS.USER_MESSAGE);
  assert.equal(plan.cutIndex, 2);
  // 待压缩区间只含第一轮的 user 轮，保留区间从第二轮起点开始到结尾
  assert.equal(plan.summarizedTurns, 1);
});

test('planCompaction：保留窗内装得下就不压', () => {
  const events = [...turn('小轮次', {})];
  assert.equal(planCompaction(events, 32000), null);
});

test('planCompaction：只有一轮且全部在保留窗内溢出（切口为 0）时拒绝', () => {
  const events = [...turn('唯一一轮'.repeat(2000))];
  // keepRecent 2048 < 本轮文本估算，但切口回退到轮起点 = 0 → 没得压
  assert.equal(planCompaction(events, 8000), null);
});

test('planCompaction：接力——上一条摘要被识别为 previousSummary，不重复计轮', () => {
  const compactionEv = buildCompactionEvent({
    summary: '## 任务目标\n做某事',
    tokensBefore: 99999,
    summarizedTurns: 4,
    now: 1000,
  });
  // compaction 之后三轮：小 + 大 + 大，切口回退到「第二轮」起点（在 compaction 之后）
  const events = [
    compactionEv,
    ...turn('压缩后第一轮'.repeat(50)),
    ...turn('压缩后第二轮'.repeat(750)),
    ...turn('压缩后第三轮'.repeat(750)),
  ];

  const plan = planCompaction(events, 8000);
  assert.ok(plan);
  assert.equal(plan.previousSummary, '## 任务目标\n做某事');
  // 从尾部累积在「第三轮」的 user 消息处就越线 → 切口 = 第三轮起点，
  // 待压缩区间 = compaction + 前两轮的 user 消息，按 2 轮计
  assert.ok(events[plan.cutIndex].kind === AGENT_EVENTS.USER_MESSAGE);
  assert.equal(plan.summarizedTurns, 2);
  assert.ok(plan.cutIndex > events.indexOf(compactionEv));
});

test('planCompaction：最后一条 compaction 在保留窗内时拒绝（刚压过）', () => {
  const events = [
    ...turn('一轮'.repeat(10)),
    ...turn('二轮'.repeat(900)),
    buildCompactionEvent({
      summary: '摘要',
      tokensBefore: 1,
      summarizedTurns: 1,
      now: 1,
    }),
    ...turn('三轮'.repeat(50)),
    ...turn('四轮'.repeat(50)),
  ];
  // 从尾部累积在「二轮」的 user 消息处越线 → 切口 = 二轮起点（index 2），
  // 落在 compaction（index 4）之前 → 摘要还在保留窗里 → 拒绝
  assert.equal(planCompaction(events, 8000), null);
});

test('serializeForSummary：包装文本、归并正文、双截断、ERROR 保留', () => {
  const longObservation = 'x'.repeat(TOOL_RESULT_MAX_CHARS + 500);
  const events = [
    { kind: AGENT_EVENTS.START },
    {
      kind: AGENT_EVENTS.USER_MESSAGE,
      text: '帮我把标题改红',
      promptText:
        '<untrusted_user_message>\n帮我把标题改红\n</untrusted_user_message>',
    },
    { kind: AGENT_EVENTS.TARGET_TAB, tab: {} },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '我先读' },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '一下页面。' },
    {
      kind: AGENT_EVENTS.TOOL_CALL,
      name: 'read_page',
      args: { detail: 'text' },
      toolCallId: 'a',
    },
    {
      kind: AGENT_EVENTS.TOOL_RESULT,
      name: 'read_page',
      toolCallId: 'a',
      status: 'ok',
      observation: `<untrusted_page_content>\n${longObservation}\n</untrusted_page_content>`,
    },
    {
      kind: AGENT_EVENTS.TOOL_CALL,
      name: 'write_style',
      args: { css: 'y'.repeat(TOOL_ARGS_MAX_CHARS + 100) },
      toolCallId: 'b',
    },
    {
      kind: AGENT_EVENTS.TOOL_RESULT,
      name: 'write_style',
      toolCallId: 'b',
      status: 'error',
      observation: '',
    },
    { kind: AGENT_EVENTS.ERROR, message: '上下文长度超出限制' },
    { kind: AGENT_EVENTS.DONE, stopped: true, usage: {} },
  ];

  const text = serializeForSummary(events);
  assert.ok(
    text.includes('[用户]: <untrusted_user_message>'),
    '用户走包装文本'
  );
  assert.ok(text.includes('[助手]: 我先读一下页面。'), '连续 TEXT_DELTA 归并');
  assert.ok(!text.includes('[助手]: 我先读\n\n'), '不逐 delta 起行');
  assert.ok(text.includes('[助手调用工具]: read_page({"detail":"text"})'));
  const obsLine = text
    .split('\n')
    .find((l) => l.startsWith('[工具结果 read_page]'));
  assert.ok(obsLine.length < TOOL_RESULT_MAX_CHARS + 200, '观察值被截断');
  assert.ok(text.includes('已截断，省略'), '截断标记在换行后的独立一行');
  assert.ok(text.includes('[助手调用工具]: write_style({"css":"yyy'));
  assert.ok(!text.includes('yyyyyyyyyyyyyyyyyyyy'.repeat(50)), 'args 截断生效');
  assert.ok(text.includes('[错误]: 上下文长度超出限制'));
  assert.ok(
    !text.includes('agent:done') && !text.includes('[DONE]'),
    '信号事件不进正文'
  );
});

test('buildSummaryUserPrompt：无既往摘要走首压指令，有则走更新指令', () => {
  const first = buildSummaryUserPrompt({ serialized: '[用户]: hi' });
  assert.ok(first.includes('<conversation>\n[用户]: hi\n</conversation>'));
  assert.ok(first.includes('忽略'));
  assert.ok(!first.includes('<previous_summary>'));

  const update = buildSummaryUserPrompt({
    serialized: '[用户]: hi',
    previousSummary: '## 任务目标\n旧目标',
  });
  assert.ok(
    update.includes(
      '<previous_summary>\n## 任务目标\n旧目标\n</previous_summary>'
    )
  );
  assert.ok(update.includes('合并'));
  assert.ok(!update.includes('忽略上面'));
});

test('buildCompactionEvent：形状固定，usage 全零不挂键', () => {
  const ev = buildCompactionEvent({
    summary: '摘要',
    tokensBefore: 30000,
    summarizedTurns: 6,
    usage: { input: 10, output: 5 },
    now: 1234,
  });
  assert.deepEqual(ev, {
    kind: 'agent:compaction',
    summary: '摘要',
    tokensBefore: 30000,
    summarizedTurns: 6,
    createdAt: 1234,
    usage: { input: 10, output: 5 },
  });

  const noUsage = buildCompactionEvent({
    summary: 's',
    tokensBefore: 1,
    summarizedTurns: 1,
    now: 1,
  });
  assert.ok(!('usage' in noUsage));
});

test('isContextOverflowMessage：各家文案命中，普通错误不误报', () => {
  const hits = [
    "This model's maximum context length is 32768 tokens",
    '400 {"error":{"code":"context_length_exceeded"}}',
    'Prompt is too long: 200000 tokens > 128000 maximum',
    '输入的上下文长度超出模型限制',
    'Request too large: too many input tokens',
  ];
  for (const m of hits) assert.equal(isContextOverflowMessage(m), true, m);

  const misses = [
    '400 Bad Request',
    'Connection error.',
    '429 Rate limit reached',
    'invalid api key',
    '',
  ];
  for (const m of misses) assert.equal(isContextOverflowMessage(m), false, m);
});

test('dropTrailingPartialAssistant：剪残缺尾部，保留完整工具往返', () => {
  const toolRound = [
    { kind: AGENT_EVENTS.USER_MESSAGE, text: 'u', promptText: 'w' },
    {
      kind: AGENT_EVENTS.TOOL_CALL,
      name: 'read_page',
      args: {},
      toolCallId: 'a',
    },
    {
      kind: AGENT_EVENTS.TOOL_RESULT,
      name: 'read_page',
      toolCallId: 'a',
      status: 'ok',
      observation: 'o',
    },
  ];
  // 工具往返 + 失败尝试的碎片 + ERROR → 剪到 TOOL_RESULT 为止
  const withPartial = [
    ...toolRound,
    { kind: AGENT_EVENTS.TEXT_DELTA, text: '片段' },
    { kind: AGENT_EVENTS.ERROR, message: 'overflow' },
  ];
  assert.equal(
    withPartial[dropTrailingPartialAssistant(withPartial).length - 1].kind,
    AGENT_EVENTS.TOOL_RESULT
  );

  // 没有碎片时原样保留
  assert.deepEqual(dropTrailingPartialAssistant(toolRound), toolRound);
  assert.deepEqual(dropTrailingPartialAssistant([]), []);
  // 入参不被改写
  assert.equal(withPartial.length, toolRound.length + 2);
});

test('projectAfterLastCompaction：无摘要原样返回，多条取最后一条', () => {
  const a = [...turn('a')];
  assert.equal(projectAfterLastCompaction(a), a);

  const c1 = buildCompactionEvent({
    summary: '一',
    tokensBefore: 1,
    summarizedTurns: 1,
    now: 1,
  });
  const c2 = buildCompactionEvent({
    summary: '二',
    tokensBefore: 2,
    summarizedTurns: 2,
    now: 2,
  });
  const multi = [...a, c1, ...turn('b'), c2, ...turn('c')];
  const projected = projectAfterLastCompaction(multi);
  assert.equal(projected[0], c2);
  assert.equal(projected.length, multi.length - multi.indexOf(c2));

  // ---------------- T-95：活轮次的实测上下文 ----------------

  /** 造一条带 usage 的 pi assistant 消息（形状见 pi-ai 的 AssistantMessage）。 */
  function piMsg(usage, extra = {}) {
    return {
      role: 'assistant',
      content: [{ type: 'text', text: '答' }],
      provider: 'test',
      ...extra,
      usage,
    };
  }

  test('T-95：完整 prompt = input + cacheRead + cacheWrite（pi 已从 input 里扣掉缓存）', () => {
    // 只读 input 的话，命中提示词缓存时会低估 8 成 —— 长会话正是最容易命中的场景。
    const got = measuredContextTokens({
      messages: [
        piMsg({ input: 100, output: 50, cacheRead: 4000, cacheWrite: 0 }),
      ],
    });
    assert.equal(got, 4100);
  });

  test('T-95：一个工具轮有多次请求时取**最后一条**，不是累加', () => {
    const got = measuredContextTokens({
      messages: [
        piMsg({ input: 1000, output: 10 }),
        piMsg({ input: 3000, output: 10 }),
      ],
    });
    assert.equal(
      got,
      3000,
      '最后一次请求的 prompt 已包含前面全部内容，累加是 2 倍高估'
    );
  });

  test('T-95：重放消息一律不采信（即便它带着 usage）', () => {
    assert.equal(
      measuredContextTokens({
        messages: [piMsg({ input: 0, output: 0 }, { provider: 'replay' })],
      }),
      null
    );
    // 刻意再给一条**非零** usage 的重放消息：重放历史现在是全 0，用全 0 写
    // 断言的话，过的其实是「零值过滤」而不是「replay 过滤」—— 把 provider
    // 判断删掉它照样绿。这条钉的是「重放出来的数字不是实测」。
    assert.equal(
      measuredContextTokens({
        messages: [piMsg({ input: 500, output: 5 }, { provider: 'replay' })],
      }),
      null,
      '重放历史即使带 usage 也不是实测，不能拿来判阈值'
    );
  });

  test('T-95：没有 assistant / 没有 usage / 全零 usage 都返回 null（调用方退回估算）', () => {
    assert.equal(measuredContextTokens({}), null);
    assert.equal(measuredContextTokens({ messages: [] }), null);
    assert.equal(
      measuredContextTokens({ messages: [{ role: 'user', content: 'hi' }] }),
      null
    );
    assert.equal(measuredContextTokens({ messages: [piMsg(null)] }), null);
    assert.equal(
      measuredContextTokens({ messages: [piMsg({ input: 0, output: 0 })] }),
      null
    );
  });

  test('T-95：实测只覆盖到上次请求那一刻，之后追加的内容要补上', () => {
    const messages = [
      piMsg({ input: 500, output: 10 }),
      {
        role: 'user',
        content: [{ type: 'text', text: '工具之后又来的一轮' }],
      },
    ];
    const got = measuredContextTokens({ messages, pendingText: '本轮指令' });
    // 500（实测） + 那条 user 消息的估算 + pendingText 的估算
    assert.ok(got > 500, '至少要把测量点之后的内容算进去');
    assert.ok(
      got < 700,
      '补的只是测量点之后那一小段，不该把整段历史再估一遍，实际 ' + got
    );
    // 同理钉住「测量点之后那条消息」这一项：否则把 since 抹成 0 也照样绿。
    assert.ok(
      measuredContextTokens({ messages }) >
        measuredContextTokens({ messages: messages.slice(0, 1) }),
      '最后一条实测消息之后追加的内容（工具结果、后续 user 消息）必须计入'
    );
    // 差值钉住 pendingText 这一项：'abcd' 恰好 1 个 token（其余按 4 字符 1 token）。
    // 上面两条区间断言对它是钝的（少算了也照样落在区间里），这里必须正好差 1。
    assert.equal(
      measuredContextTokens({ messages, pendingText: 'abcd' }) -
        measuredContextTokens({ messages }),
      1,
      '本轮 user 消息尚未计入那次请求，必须按估算补进去'
    );
  });

  test('T-95：坏数据不许变成 NaN 或 0 混进阈值判断', () => {
    const got = measuredContextTokens({
      messages: [
        piMsg({ input: 'abc', cacheRead: null, cacheWrite: undefined }),
      ],
    });
    assert.equal(got, null, 'usage 字段脏到算不出正数就该退回估算，而不是当 0');
  });
});
