import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFolder } from './fold';
import { AGENT_EVENTS, TOOL_STATUS } from './events';

const ev = (kind, extra = {}) => ({ kind, ...extra });
const types = (f) => f.items.map((i) => i.type);
const only = (f, type) => f.items.filter((i) => i.type === type);

/**
 * T-53：折叠层的单测。
 *
 * 这段逻辑原先写死在 AgentTranscript.vue 的 script setup 里，90 行、8 个事件分支，
 * 一条都测不到（T-53 登记时的证据：27 个测试文件全在 src/agent/ 下，.vue 相关 0 个）。
 * 抽到 fold.js 之后，下面每一条都是**直接钉住规则**，而不是钉住「源码里有没有这段字」。
 */

test('T-53：同类型连续 delta 并进同一槽位，换类型另起一块', () => {
  const f = createFolder();
  f.sync([
    ev(AGENT_EVENTS.TEXT_DELTA, { text: '前半' }),
    ev(AGENT_EVENTS.TEXT_DELTA, { text: '后半' }),
    ev(AGENT_EVENTS.THINKING, { text: '在想' }),
    ev(AGENT_EVENTS.TEXT_DELTA, { text: '正文' }),
  ]);

  assert.deepEqual(
    types(f),
    ['text', 'thinking', 'text'],
    'text/thinking/text 折成三块，不是四块（中间插了 thinking 要断开并槽）'
  );
  assert.equal(f.items[0].raw, '前半后半', '同类型 delta 要拼进同一槽位');
  assert.equal(f.items[2].raw, '正文');
});

test('T-53：delta 缺 text 时按空串处理，不能产出 undefined 槽位', () => {
  const f = createFolder();
  f.sync([
    ev(AGENT_EVENTS.TEXT_DELTA),
    ev(AGENT_EVENTS.TEXT_DELTA, { text: '有内容' }),
    ev(AGENT_EVENTS.THINKING, { text: undefined }),
  ]);
  assert.equal(
    f.items[0].raw,
    '有内容',
    'undefined 要落成空串，不能是 "undefined"'
  );
  assert.equal(f.items[1].raw, '');
});

test('T-53：工具卡按 toolCallId 合并，result 不带 args 时不抹掉参数', () => {
  const f = createFolder();
  f.sync([
    ev(AGENT_EVENTS.TOOL_CALL, {
      name: 'read_page',
      step: 0,
      toolCallId: 'c1',
      args: { selector: 'h1' },
      status: TOOL_STATUS.RUNNING,
    }),
    ev(AGENT_EVENTS.TOOL_RESULT, {
      name: 'read_page',
      step: 0,
      toolCallId: 'c1',
      status: TOOL_STATUS.OK,
      observation: '标题文字',
    }),
  ]);

  const cards = only(f, 'tool');
  assert.equal(cards.length, 1, '同一次调用只应有一张卡');
  assert.equal(cards[0].step.status, TOOL_STATUS.OK, 'status 要被 result 更新');
  assert.equal(cards[0].step.observation, '标题文字');
  assert.deepEqual(
    cards[0].step.args,
    { selector: 'h1' },
    'result 事件不带 args 时必须保留 call 阶段记下的参数，而不是变成 undefined'
  );
});

test('T-53：同名并行调用按 toolCallId 各自成卡（不能按 name+step 覆盖）', () => {
  const f = createFolder();
  f.sync([
    ev(AGENT_EVENTS.TOOL_CALL, {
      name: 'read_page',
      step: 0,
      toolCallId: 'c1',
      args: { i: 1 },
    }),
    ev(AGENT_EVENTS.TOOL_CALL, {
      name: 'read_page',
      step: 0,
      toolCallId: 'c2',
      args: { i: 2 },
    }),
    ev(AGENT_EVENTS.TOOL_RESULT, {
      name: 'read_page',
      step: 0,
      toolCallId: 'c2',
      observation: '第二个',
    }),
    ev(AGENT_EVENTS.TOOL_RESULT, {
      name: 'read_page',
      step: 0,
      toolCallId: 'c1',
      observation: '第一个',
    }),
  ]);

  const cards = only(f, 'tool');
  assert.equal(cards.length, 2, '两次并行调用应是两张卡');
  assert.deepEqual(
    cards.map((c) => c.step.args),
    [{ i: 1 }, { i: 2 }]
  );
  assert.deepEqual(
    cards.map((c) => c.step.observation),
    ['第一个', '第二个'],
    '后到的 result 要落到自己的那张卡上（按 id 从后往前找归属）'
  );
});

test('T-53：换了会话整表重放，旧槽位不得残留', () => {
  const f = createFolder();
  const first = [
    ev(AGENT_EVENTS.USER_MESSAGE, { text: '甲' }),
    ev(AGENT_EVENTS.TEXT_DELTA, { text: '答甲' }),
  ];
  f.sync(first);
  assert.deepEqual(types(f), ['user', 'text']);
  assert.equal(f.cursor(), 2);

  const second = [ev(AGENT_EVENTS.USER_MESSAGE, { text: '乙' })];
  f.sync(second);
  assert.deepEqual(
    types(f),
    ['user'],
    '换数组要清空重放，残留上一会话的槽位就是串台'
  );
  assert.equal(f.items[0].text, '乙');

  // 同一数组追加事件：只处理游标之后的新事件
  second.push(ev(AGENT_EVENTS.TEXT_DELTA, { text: '答乙' }));
  f.sync(second);
  assert.deepEqual(
    types(f),
    ['user', 'text'],
    '增量追加不能把已有内容重折一遍'
  );
});

test('T-53：reset 清空槽位并把游标归零', () => {
  const f = createFolder();
  f.sync([ev(AGENT_EVENTS.USER_MESSAGE, { text: '甲' })]);
  f.reset();
  assert.equal(f.items.length, 0);
  assert.equal(f.cursor(), 0);

  f.sync([ev(AGENT_EVENTS.USER_MESSAGE, { text: '乙' })]);
  assert.deepEqual(types(f), ['user'], 'reset 后同一个数组也要重新折');
});

test('T-53：错误事件带 retryText（最近那条用户消息），没有用户消息时为空串', () => {
  const f = createFolder();
  f.sync([
    ev(AGENT_EVENTS.USER_MESSAGE, { text: '第一个问题' }),
    ev(AGENT_EVENTS.TEXT_DELTA, { text: '答' }),
    ev(AGENT_EVENTS.USER_MESSAGE, { text: '第二个问题' }),
    ev(AGENT_EVENTS.ERROR, {
      message: '出错了',
      errorKind: 'network',
      httpStatus: 502,
    }),
  ]);
  const err = only(f, 'error')[0];
  assert.equal(
    err.retryText,
    '第二个问题',
    '「重试」要拿出错这一轮之前最近的那条'
  );
  assert.equal(err.kind, 'network');
  assert.equal(err.httpStatus, 502);
  assert.equal(err.text, '出错了');

  const g = createFolder();
  g.sync([ev(AGENT_EVENTS.ERROR, { message: '无头错误' })]);
  assert.equal(
    g.items[0].retryText,
    '',
    '没有用户消息时给空串，组件据此不给「重试」按钮'
  );
  assert.equal(
    'httpStatus' in g.items[0],
    false,
    '没有 httpStatus 时不要留一个 undefined 字段（errorDetail 会去拼 "HTTP undefined"）'
  );
});

test('T-53：错误事件没有 message 时走注入的 t 兜底，且只在这一次调用', () => {
  const asked = [];
  const f = createFolder({
    t: (key) => {
      asked.push(key);
      return '出了点问题';
    },
  });
  f.sync([ev(AGENT_EVENTS.ERROR, { errorKind: 'internal' })]);
  assert.equal(f.items[0].text, '出了点问题');
  assert.deepEqual(asked, ['workflow.agent.error'], '折叠层只在这一处需要翻译');

  const plain = createFolder();
  plain.sync([ev(AGENT_EVENTS.ERROR, {})]);
  assert.equal(
    plain.items[0].text,
    'workflow.agent.error',
    '不给 t 时原样返回键名 —— 不能静默变成空串'
  );
});

test('T-53：轮次分隔线带 at，缺 at 时落 0（渲染层据此隐藏时刻）', () => {
  const f = createFolder();
  f.sync([
    ev(AGENT_EVENTS.START, { at: 1770000000000 }),
    ev(AGENT_EVENTS.TEXT_DELTA, { text: '答' }),
    ev(AGENT_EVENTS.START),
  ]);
  const turns = only(f, 'turn');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].at, 1770000000000);
  assert.equal(
    turns[1].at,
    0,
    '旧会话的历史事件没有 at，要落 0 而不是 undefined'
  );
});

test('T-53：压缩摘要、系统提示各自成槽，带轮数', () => {
  const f = createFolder();
  f.sync([
    ev(AGENT_EVENTS.COMPACTION, {
      summary: '前面聊了什么',
      summarizedTurns: 3,
    }),
    ev(AGENT_EVENTS.SYSTEM_NOTICE, { text: '已切到新会话' }),
  ]);
  assert.deepEqual(types(f), ['compaction', 'notice']);
  assert.equal(f.items[0].turns, 3);
  assert.equal(f.items[0].open, false, '折叠块默认收起');
  assert.equal(f.items[1].text, '已切到新会话');
});

test('T-53：done / target-tab / 空事件不产出槽位', () => {
  const f = createFolder();
  f.sync([
    null,
    ev(AGENT_EVENTS.DONE, { usage: { input: 1 } }),
    ev(AGENT_EVENTS.TARGET_TAB, { tabId: 3 }),
    ev('agent:没见过的种类'),
  ]);
  assert.equal(f.items.length, 0, '这些事件不产生对话内容，也不能抛异常');
});

test('T-53：槽位 key 递增且唯一（模板 :key 用它）', () => {
  const f = createFolder();
  f.sync([
    ev(AGENT_EVENTS.USER_MESSAGE, { text: '一' }),
    ev(AGENT_EVENTS.TEXT_DELTA, { text: '二' }),
    ev(AGENT_EVENTS.USER_MESSAGE, { text: '三' }),
  ]);
  const keys = f.items.map((i) => i.key);
  assert.equal(
    new Set(keys).size,
    keys.length,
    'key 不能重复，否则 Vue 会复用错节点'
  );
  assert.ok(
    keys.every((k, i) => i === 0 || k > keys[i - 1]),
    'key 要递增'
  );
});

test('T-53：外部传入的 items 数组就是被折叠的那个（组件靠它拿响应式）', () => {
  const mine = [];
  const f = createFolder({ items: mine });
  f.sync([ev(AGENT_EVENTS.USER_MESSAGE, { text: '甲' })]);
  assert.equal(mine.length, 1, '组件传的是 reactive([])，折叠层必须写进那一个');
  assert.equal(mine[0].text, '甲');
});
