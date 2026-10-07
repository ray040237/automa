import assert from 'node:assert';
import test from 'node:test';

import { createMarkdownStream, markdownToBlocks } from './markdown';

// ----------------------------------------------------------------
// T-14：流式增量解析（createMarkdownStream）
//
// 核心断言是**等价性**：不管怎么切 delta，缓存式解析的结果必须与整段解析完全
// 一致。增量解析最危险的不是变慢，而是**切错切点导致丢块/串块** —— 那种 bug 在
// 界面上表现为「代码块里的空行把后面吞了」，极难查。所以用随机切分跑等价性。
// ----------------------------------------------------------------

const CH = String.fromCharCode(10);

const SAMPLE = [
  '## 页面结构',
  '',
  '左边是块列表，右边是画布。当前选中的是 webhook 块。',
  '',
  '- 触发方式是 manual',
  '- 失败时默认终止整个工作流',
  '  补充：也可以在块上改',
  '',
  '~~~js',
  'const a = 1;',
  '',
  '// 这里的空行属于代码内容，不能当成切点',
  '',
  '## 这行在围栏里，不是标题',
  '~~~',
  '',
  '> 引用里也有',
  '> 多个空行',
  '> 隔开的段落',
  '',
  '| 字段 | 说明 |',
  '| --- | --- |',
  '| url | 回调地址 |',
  '| method | POST |',
  '',
  '结尾没有换行',
].join(CH);

/** 确定性伪随机：同一 seed 必须给出同一串切分，测试失败才可复现。 */
function rng(seed) {
  // Park-Miller：不用位运算（本仓 eslint 禁 no-bitwise），乘法 3.6e13 < 2^53 不会失真。
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

test('随机切分的结果与整段解析完全一致（200 组）', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const rand = rng(seed);
    const stream = createMarkdownStream();
    let out = [];
    let i = 0;
    while (i < SAMPLE.length) {
      i = Math.min(SAMPLE.length, i + 1 + Math.floor(rand() * 7));
      out = stream.push(SAMPLE.slice(0, i));
    }
    assert.deepEqual(
      out,
      markdownToBlocks(SAMPLE),
      'seed=' + seed + '，在第 ' + i + ' 字处切分后结果就变了'
    );
  }
});

test('围栏没闭合时不能切（流式中途最常见的形态）', () => {
  const stream = createMarkdownStream();
  const open = ['说明文字', '', '~~~python', 'def f():', '    return 1'].join(
    CH
  );
  const mid = open + CH;

  assert.deepEqual(stream.push(mid), markdownToBlocks(mid));

  const closed = mid + CH + 'print(1)' + CH + '~~~';
  assert.deepEqual(stream.push(closed), markdownToBlocks(closed));
});

test('换成别的内容时整体重来，不是接着上一条追加', () => {
  const stream = createMarkdownStream();
  stream.push(['# 一号消息', '', '内容一', ''].join(CH));
  const other = ['# 二号消息', '', '内容二'].join(CH);
  assert.deepEqual(
    stream.push(other),
    markdownToBlocks(other),
    '组件复用（切会话）不能串到上一条'
  );
  assert.deepEqual(stream.blocks(), markdownToBlocks(other));
});

test('空文本与 reset', () => {
  const stream = createMarkdownStream();
  assert.deepEqual(stream.push(''), []);
  assert.deepEqual(stream.push(undefined), []);

  const doc = ['## 标题', '', '正文'].join(CH);
  assert.deepEqual(stream.push(doc), markdownToBlocks(doc));
  stream.reset();
  assert.deepEqual(stream.blocks(), [], 'reset 后不该还留着上次的块');
});

test('缓存真的在生效：重解析字符数远小于收到总量', () => {
  // 本条的核心收益断言。若有人把 done.concat(缓存) 退化成每轮整段重解析，
  // parsed() 会逼近 text()（比值 ≈1），这里必须远小于 1。
  const stream = createMarkdownStream();
  const long = [SAMPLE, '', SAMPLE, '', SAMPLE].join(CH);

  let out = [];
  let wouldReparse = 0;
  for (let i = 1; i <= long.length; i += 3) {
    wouldReparse += i;
    out = stream.push(long.slice(0, i));
  }
  assert.deepEqual(out, markdownToBlocks(long));

  // 分母是「每轮整段重解析要处理的字符数」= 各次前缀长度之和，不是最终长度 ——
  // 拿最终长度当分母的话，每轮重解析的累计（平方级）会显得比 1 大好几倍，
  // 看着像退化了，其实缓存一直在生效。
  const ratio = stream.parsed() / wouldReparse;
  assert.ok(
    ratio < 0.1,
    '重解析 ' +
      stream.parsed() +
      ' 字 / 整段重解析需要 ' +
      wouldReparse +
      ' 字 = ' +
      ratio.toFixed(3) +
      '，缓存没生效（退化成整段重解析会 ≈1）'
  );
});

test('未闭合表格在补上分隔行后要升级成表格（切点不能切在半张表上）', () => {
  const stream = createMarkdownStream();
  const head = ['说明', '', '| 字段 | 说明 |'].join(CH);
  assert.deepEqual(stream.push(head), markdownToBlocks(head));

  const divider = head + CH + '| --- | --- |';
  assert.deepEqual(stream.push(divider), markdownToBlocks(divider));

  const row = divider + CH + '| url | 回调 |';
  assert.deepEqual(stream.push(row), markdownToBlocks(row));
});
