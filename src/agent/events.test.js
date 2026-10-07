import test from 'node:test';
import assert from 'node:assert';
import {
  truncateObservation,
  toolCallsOf,
  MAX_OBSERVATION_CHARS,
} from './events';

/* ---------------- truncateObservation（T-82 自 window.test.js 迁入） ---------------- */

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

/* ---------------- toolCallsOf（T-125） ----------------
 *
 * 这条原语原先在 loop.js / compaction.js 各抄一份，加起来三处。全部消费点
 * 改调这里之后，它就是「一条 TOOL_CALL 事件里有几个调用」的唯一答案 ——
 * 所以下面每种入参形状都要钉住，尤其 `calls.length > 1`（T-74 的并行调用）：
 * 少返回一个是静默丢失一次工具调用，不报错、只是 transcript 里少一段。
 */

test('新协议：calls[] 有多个时全部返回（并行调用一个都不能少）', () => {
  const ev = {
    kind: 'agent:tool-call',
    calls: [
      { name: 'a', args: { x: 1 }, toolCallId: 'c1' },
      { name: 'b', args: { y: 2 }, toolCallId: 'c2' },
      { name: 'c', args: {}, toolCallId: 'c3' },
    ],
  };
  const calls = toolCallsOf(ev);

  assert.equal(calls.length, 3, '三条并行调用必须都在');
  assert.deepEqual(
    calls.map((c) => c.toolCallId),
    ['c1', 'c2', 'c3']
  );
});

test('新协议：calls[] 只有一个时原样返回', () => {
  const one = { name: 'a', args: { x: 1 }, toolCallId: 'c1' };
  assert.deepEqual(toolCallsOf({ calls: [one] }), [one]);
});

test('旧协议：没有 calls 时从扁平的 name/args/toolCallId 兜出单调用', () => {
  // 历史事件是「一条事件一个调用」：没有 calls 键，只有 name/args/toolCallId。
  const calls = toolCallsOf({
    kind: 'agent:tool-call',
    name: 'echo',
    args: { a: 1 },
    toolCallId: 'c9',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'echo');
  assert.deepEqual(calls[0].args, { a: 1 });
  assert.equal(calls[0].toolCallId, 'c9');
});

test('旧协议：args 缺失时兜成空对象，消费方不必自己判 undefined', () => {
  const calls = toolCallsOf({ name: 'echo', toolCallId: 'c1' });
  assert.deepEqual(calls[0].args, {});
});

test('空数组当旧协议处理 —— calls:[] 不该返回零个调用', () => {
  // calls: [] 在旧代码里走 falsy 分支。这里保持一致：
  // 有 name 就按单调用兜出，没有 name 才返回空。
  const withName = toolCallsOf({ name: 'echo', calls: [] });
  assert.equal(withName.length, 1, 'calls:[] + 有 name → 兜出单调用');
  assert.equal(withName[0].name, 'echo');

  assert.deepEqual(toolCallsOf({ calls: [] }), [], 'calls:[] + 无 name → 空');
});

test('既没有 calls 也没有 name 时返回空数组，不返回 [{name:undefined}]', () => {
  assert.deepEqual(toolCallsOf({}), []);
  assert.deepEqual(toolCallsOf({ calls: null }), []);
  assert.deepEqual(toolCallsOf(null), []);
  assert.deepEqual(toolCallsOf(undefined), []);
});

test('name 为 null/undefined 不算有效调用（不能造出 name:undefined 的假调用）', () => {
  // 造出来的话，下游 `c.name` 会进 JSON 变成 {"name":null}，
  // 模型看到一条没有名字的工具调用，只能原地打转。
  assert.deepEqual(toolCallsOf({ name: null }), []);
  assert.deepEqual(toolCallsOf({ name: undefined }), []);
});
