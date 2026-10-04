import test from 'node:test';
import assert from 'node:assert';
import {
  estimateTokens,
  truncateObservation,
  elideStaleObservations,
  applyTokenBudget,
  STALE_MARKER,
  MAX_OBSERVATION_CHARS,
} from './window';

const sys = { role: 'system', content: '系统提示' };
const user = (t) => ({ role: 'user', content: t });
const asst = (t, tc) => ({
  role: 'assistant',
  content: t,
  ...(tc ? { tool_calls: tc } : {}),
});
const tool = (id, c) => ({ role: 'tool', tool_call_id: id, content: c });
const pageObs = (id, t) =>
  tool(id, '<untrusted_page_content>\n' + t + '\n</untrusted_page_content>');
const tc = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: args || '{}' },
});

test('空历史估为 0', () => {
  assert.equal(estimateTokens([]), 0);
});

test('ASCII 走 1.5 字符/token 的保守口径', () => {
  // 150 个 ASCII 字符 -> 100 token
  assert.equal(estimateTokens([user('a'.repeat(150))]), 100);
});

test('纯 CJK 走 0.7 字符/token', () => {
  // 70 个汉字 -> 100 token
  assert.equal(estimateTokens([user('中'.repeat(70))]), 100);
});

test('CJK 占比不高时用 ASCII 除数', () => {
  const mixed = user('中'.repeat(7) + 'a'.repeat(143));
  assert.equal(estimateTokens([mixed]), Math.ceil(150 / 1.5));
});

test('tool_calls 的参数也计入估算', () => {
  const withArgs = [
    asst('', [tc('c1', 'read_page', JSON.stringify({ detail: 'full' }))]),
  ];
  const withoutArgs = [asst('')];
  assert.ok(estimateTokens(withArgs) > estimateTokens(withoutArgs));
});

test('观察值截断到 8K 并标记', () => {
  const long = 'x'.repeat(MAX_OBSERVATION_CHARS + 5000);
  const r = truncateObservation(long);
  assert.ok(r.truncated);
  assert.ok(r.text.startsWith('x'.repeat(100)));
  assert.ok(r.text.includes('已截断'));
  assert.ok(r.text.length < long.length);
});

test('未超限的观察值原样返回且 truncated=false', () => {
  const r = truncateObservation('short');
  assert.equal(r.text, 'short');
  assert.equal(r.truncated, false);
});

test('剔除陈旧页面观察值，但保留 tool_call_id 配对', () => {
  const history = [
    sys,
    user('第一轮'),
    asst('', [tc('c1')]),
    pageObs('c1', '旧页面 A'),
    asst('回答一'),
    user('第二轮'),
    asst('', [tc('c2')]),
    pageObs('c2', '新页面 B'),
  ];
  const out = elideStaleObservations(history);

  assert.equal(out[3].content, STALE_MARKER);
  assert.equal(
    out[3].tool_call_id,
    'c1',
    'tool_call_id 必须保留，否则 OpenAI 400'
  );
  assert.ok(out[7].content.includes('新页面 B'), '最后一轮观察值必须保留');
  assert.equal(
    history[3].content.includes('旧页面 A'),
    true,
    '不能原地改输入数组'
  );
});

test('非页面类工具观察值不剔除', () => {
  const history = [
    sys,
    user('u'),
    asst('', [tc('c1')]),
    tool('c1', '<untrusted_tool_result>x</untrusted_tool_result>'),
  ];
  const out = elideStaleObservations(history);
  assert.ok(out[3].content.includes('untrusted_tool_result'));
});

test('页面快照后面只跟非页面工具：快照必须保留（T-37）', () => {
  // 致病场景：read_page 之后调 get_variables / list_canvas 这类非页面工具，
  // 旧实现按「最后一组工具消息」判定，把仍是最新页面知识的快照压成占位符，
  // 模型上下文里没了页面结构，只能反复 read_page。
  const history = [
    sys,
    user('u'),
    asst('', [tc('c1')]),
    pageObs('c1', '页面 A 的结构'),
    asst('', [tc('c2')]),
    tool(
      'c2',
      '<untrusted_tool_result>{"status":"ok"}</untrusted_tool_result>'
    ),
    asst('', [tc('c3')]),
    tool('c3', '<untrusted_tool_result>y</untrusted_tool_result>'),
  ];
  const out = elideStaleObservations(history);

  assert.ok(
    out[3].content.includes('页面 A 的结构'),
    '后面没有更新的页面快照，这份必须保留'
  );
  assert.equal(out[3].elided, undefined, '保留的不该带 elided 标记');
  assert.ok(
    out.every((m) => m.role !== 'tool' || !m.elided),
    '此历史里没有任何被压缩的快照'
  );
});

test('多条页面快照：只保留最后一条，更旧的照旧压缩', () => {
  const history = [
    sys,
    user('u'),
    asst('', [tc('c1')]),
    pageObs('c1', '旧页面 A'),
    asst('', [tc('c2')]),
    pageObs('c2', '中间页面 B'),
    asst('', [tc('c3')]),
    tool('c3', '<untrusted_tool_result>x</untrusted_tool_result>'),
    asst('', [tc('c4')]),
    pageObs('c4', '新页面 C'),
  ];
  const out = elideStaleObservations(history);

  assert.equal(out[3].content, STALE_MARKER);
  assert.equal(out[5].content, STALE_MARKER, '中间那份也该压');
  assert.ok(out[9].content.includes('新页面 C'), '最后一条页面快照保留');
});

test('超预算时丢最旧的一整轮，且 system 与末轮 user 永不被丢', () => {
  const big = '页面内容'.repeat(4000);
  const history = [
    sys,
    user('第一轮 ' + big),
    asst('回答一 ' + big),
    user('第二轮 ' + big),
    asst('回答二 ' + big),
    user('当前任务'),
  ];
  const r = applyTokenBudget(history, { contextWindow: 4000 });
  assert.ok(r.estimated <= r.threshold, r.estimated + ' <= ' + r.threshold);
  assert.equal(r.messages[0].role, 'system', 'system 不能被丢');
  assert.equal(
    r.messages[r.messages.length - 1].content,
    '当前任务',
    '末轮 user 不能被丢'
  );
  assert.ok(r.dropped > 0);
});

test('裁剪以 (user, assistant, tool*) 整组为单位，不留孤儿 tool 消息', () => {
  const big = 'x'.repeat(30000);
  const history = [
    sys,
    user('第一轮'),
    asst('', [tc('c1')]),
    tool('c1', big),
    user('第二轮'),
    asst('', [tc('c2')]),
    tool('c2', big),
    user('当前任务'),
  ];
  const r = applyTokenBudget(history, { contextWindow: 20000 });

  // 每一组 tool 都必须紧跟在产生它的 assistant 之后
  const ids = new Set();
  r.messages.forEach((m) => {
    if (m.role === 'assistant' && m.tool_calls)
      m.tool_calls.forEach((c) => ids.add(c.id));
  });
  r.messages.forEach((m) => {
    if (m.role === 'tool')
      assert.ok(ids.has(m.tool_call_id), '孤儿 tool 消息: ' + m.tool_call_id);
  });
  assert.ok(r.estimated <= r.threshold);
});

test('单条消息就超预算时不硬丢，原样交给 provider 并如实返回', () => {
  const history = [sys, user('x'.repeat(500000)), asst('y')];
  const r = applyTokenBudget(history, { contextWindow: 1000 });
  assert.equal(r.dropped, 0);
  assert.ok(r.estimated > r.threshold, '如实反映超预算，不假装解决了');
});

test('单轮多步超预算时在轮内降级：从最旧的一组 assistant+tool* 开始丢', () => {
  // 单轮 send 的 wire：只有一个 user，整组法无候选可丢（T-25 的场景）
  const big = 'x'.repeat(6000); // 4000 token
  const history = [sys, user('任务')];
  for (let i = 0; i < 6; i += 1) {
    history.push(asst('', [tc('c' + i, 'read_page')]));
    history.push(pageObs('c' + i, '第 ' + i + ' 步页面 ' + big));
  }

  const r = applyTokenBudget(history, { contextWindow: 8000 });

  assert.ok(r.dropped > 0, '单轮内必须能丢，dropped=0 等于预算层失效');
  assert.ok(r.estimated <= r.threshold, r.estimated + ' <= ' + r.threshold);
  assert.equal(r.messages[0].role, 'system', 'system 不能被丢');
  assert.equal(r.messages[1].content, '任务', '末轮 user 不能被丢');

  // 最近一组是当前步骤的现场，必须留下
  const last = r.messages[r.messages.length - 1];
  assert.equal(last.role, 'tool');
  assert.ok(last.content.includes('第 5 步页面'), '最近一组必须保留');

  // 不留孤儿 tool 消息
  const ids = new Set();
  r.messages.forEach((m) => (m.tool_calls || []).forEach((c) => ids.add(c.id)));
  r.messages.forEach((m) => {
    if (m.role === 'tool')
      assert.ok(ids.has(m.tool_call_id), '孤儿 tool: ' + m.tool_call_id);
  });
});

test('单轮内只剩一组时不再丢，如实返回超预算', () => {
  const history = [
    sys,
    user('任务'),
    asst('', [tc('c1')]),
    pageObs('c1', 'x'.repeat(30000)),
  ];
  const r = applyTokenBudget(history, { contextWindow: 1000 });
  assert.equal(r.dropped, 0, '只剩一组时不能把现场也丢掉');
  assert.equal(r.messages.length, 4);
  assert.ok(r.estimated > r.threshold, '如实反映超预算');
});
