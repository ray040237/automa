import test from 'node:test';
import assert from 'node:assert';
import { buildWireMessages } from './wire';

const text = (t) => ({ kind: 'agent:text-delta', text: t });
const call = (name, args, id) => ({
  kind: 'agent:tool-call',
  name,
  args,
  toolCallId: id,
});
const result = (id, observation, name) => ({
  kind: 'agent:tool-result',
  toolCallId: id,
  observation,
  name,
});
const DONE = { kind: 'agent:done' };

test('纯文本：assistant 消息', () => {
  const out = buildWireMessages([text('你好'), DONE]);
  assert.deepEqual(out, [{ role: 'assistant', content: '你好' }]);
});

test('空事件不产生空 assistant', () => {
  assert.deepEqual(buildWireMessages([]), []);
  assert.deepEqual(buildWireMessages([DONE]), []);
});

test('system 放在最前，user-message 事件折成 user 行且优先用 wire 形态', () => {
  const out = buildWireMessages(
    [
      {
        kind: 'agent:user-message',
        text: '原文',
        wire: '<untrusted_user_message>原文</untrusted_user_message>',
      },
      text('hi'),
      DONE,
    ],
    { system: 'S' }
  );
  assert.deepEqual(
    out.map((m) => m.role),
    ['system', 'user', 'assistant']
  );
  assert.equal(
    out[1].content,
    '<untrusted_user_message>原文</untrusted_user_message>'
  );
  assert.equal(out[2].content, 'hi');
});

test('user-message 没有 wire 时退回 text', () => {
  const out = buildWireMessages([{ kind: 'agent:user-message', text: '你好' }]);
  assert.deepEqual(out, [{ role: 'user', content: '你好' }]);
});

test('悬空调用（有 call 无 result）收尾时合成中断占位 tool 消息', () => {
  const out = buildWireMessages([call('read_page', {}, 'c1'), DONE]);
  assert.deepEqual(
    out.map((m) => m.role),
    ['assistant', 'tool']
  );
  assert.equal(out[1].tool_call_id, 'c1');
  assert.ok(out[1].content.includes('被中断'), '占位内容要说明是中断');
});

test('历史中段的悬空调用也要补全（上一轮中断后用户又发了消息）', () => {
  const out = buildWireMessages([
    call('read_page', {}, 'c1'),
    { kind: 'agent:user-message', text: '换个说法', wire: '换个说法' },
    text('好的'),
    DONE,
  ]);
  assert.deepEqual(
    out.map((m) => m.role),
    ['assistant', 'tool', 'user', 'assistant']
  );
  assert.equal(out[1].tool_call_id, 'c1');
  assert.ok(out[1].content.includes('被中断'));
});

test('孤儿 result（没有对应 call）不产生 tool 消息', () => {
  const out = buildWireMessages([text('hi'), result('c9', 'OBS'), DONE]);
  assert.deepEqual(out, [{ role: 'assistant', content: 'hi' }]);
});

test('工具结果必须真的进 wire —— 这条是核心回归', () => {
  const out = buildWireMessages([
    call('read_page', { detail: 'auto' }, 'c1'),
    result('c1', '页面正文', 'read_page'),
    DONE,
  ]);

  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].content, '');
  assert.equal(out[0].tool_calls[0].id, 'c1');
  assert.equal(out[0].tool_calls[0].function.name, 'read_page');
  assert.equal(out[0].tool_calls[0].function.arguments, '{"detail":"auto"}');

  assert.equal(out[1].role, 'tool');
  assert.equal(out[1].tool_call_id, 'c1');
  assert.equal(out[1].content, '页面正文');
});

test('assistant(tool_calls) 后面紧跟 tool —— 顺序不能错', () => {
  const out = buildWireMessages([
    text('我看一下页面'),
    call('read_page', {}, 'c1'),
    result('c1', 'OBS', 'read_page'),
    DONE,
  ]);
  assert.deepEqual(
    out.map((m) => m.role),
    ['assistant', 'tool']
  );
  assert.equal(out[0].content, '我看一下页面');
  assert.ok(out[0].tool_calls);
});

test('并行多个工具：一条 assistant 带多个 tool_calls，随后多条 tool', () => {
  const out = buildWireMessages([
    call('read_page', {}, 'c1'),
    call('get_variables', {}, 'c2'),
    result('c1', 'PAGE', 'read_page'),
    result('c2', 'VARS', 'get_variables'),
    DONE,
  ]);

  assert.deepEqual(
    out.map((m) => m.role),
    ['assistant', 'tool', 'tool']
  );
  assert.equal(out[0].tool_calls.length, 2);
  assert.deepEqual(
    out.map((m) => m.tool_call_id),
    [undefined, 'c1', 'c2']
  );
});

test('多轮工具调用会分成多个 assistant/tool 组', () => {
  const out = buildWireMessages([
    call('read_page', {}, 'c1'),
    result('c1', 'PAGE', 'read_page'),
    text('现在写代码'),
    call('read_page', {}, 'c2'),
    result('c2', 'PAGE2', 'read_page'),
    DONE,
  ]);
  assert.deepEqual(
    out.map((m) => m.role),
    ['assistant', 'tool', 'assistant', 'tool']
  );
  assert.equal(out[2].tool_calls[0].id, 'c2');
  assert.equal(out[3].tool_call_id, 'c2');
});

test('缺 toolCallId 的空转块不产生 tool_calls，也不产生 tool 消息', () => {
  const out = buildWireMessages([
    call('x', {}, undefined),
    result(undefined, 'OBS'),
    DONE,
  ]);
  assert.deepEqual(out, []);
});

test('思考内容不进 wire', () => {
  const out = buildWireMessages([
    { kind: 'agent:thinking', text: '推理过程' },
    text('答案'),
    DONE,
  ]);
  assert.deepEqual(out, [{ role: 'assistant', content: '答案' }]);
});

test('展示事件（切页 / 确认 / 提案）不进 wire', () => {
  const out = buildWireMessages([
    { kind: 'agent:target-tab', tab: { url: 'https://a.com' } },
    { kind: 'agent:confirm', title: 'x' },
    { kind: 'agent:proposal', payload: {} },
    text('hi'),
    DONE,
  ]);
  assert.deepEqual(out, [{ role: 'assistant', content: 'hi' }]);
});

test('error 也 flush 已积累的正文，不会丢掉已说出口的话', () => {
  const out = buildWireMessages([
    text('说到一半'),
    { kind: 'agent:error', message: '断了' },
  ]);
  assert.deepEqual(out, [{ role: 'assistant', content: '说到一半' }]);
});

test('args 为 undefined 时补 {}，不让 arguments 变成 undefined', () => {
  const out = buildWireMessages([
    call('x', undefined, 'c1'),
    result('c1', 'O'),
    DONE,
  ]);
  assert.equal(out[0].tool_calls[0].function.arguments, '{}');
});

test('observation 缺失时 content 落空串而不是 undefined', () => {
  const out = buildWireMessages([
    call('x', {}, 'c1'),
    result('c1', undefined),
    DONE,
  ]);
  assert.equal(out[1].content, '');
});

test('system-notice 折成 user 行，优先用 wire 形态', () => {
  const out = buildWireMessages([
    text('hi'),
    {
      kind: 'agent:system-notice',
      text: '目标页已关闭',
      wire: '<untrusted_system_notice>目标页已关闭</untrusted_system_notice>',
    },
    text('好的'),
    DONE,
  ]);
  assert.deepEqual(
    out.map((m) => m.role),
    ['assistant', 'user', 'assistant']
  );
  assert.equal(
    out[1].content,
    '<untrusted_system_notice>目标页已关闭</untrusted_system_notice>'
  );
});
