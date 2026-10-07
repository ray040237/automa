import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockAt, contextPercent, fmtTokens } from './usage';

test('T-09③：水位按 usage.input / contextWindow 算，超 100 不夹', () => {
  assert.equal(contextPercent({ input: 6400 }, 128000), 5);
  assert.equal(contextPercent({ input: 128000 }, 128000), 100);
  assert.equal(
    contextPercent({ input: 200000 }, 128000),
    156,
    '超了要如实显示 156%，夹成 100 用户就看不出已经超了'
  );
  assert.equal(
    contextPercent({ input: 0 }, 128000),
    0,
    '0 是合法值，与 null 含义不同'
  );
});

test('T-09③：分母拿不到返回 null（UI 整行不渲染），不是 0%', () => {
  for (const win of [0, null, undefined, '', -1, NaN, 'abc']) {
    assert.equal(
      contextPercent({ input: 100 }, win),
      null,
      `contextWindow=${String(win)} 应算出 null`
    );
  }
  assert.equal(contextPercent(null, 128000), null, '没有 usage 也是 null');
  assert.equal(
    contextPercent({ input: -5 }, 128000),
    null,
    '已用为负是脏数据，宁可不显示'
  );
});

test('T-09③：0% 与 null 在 UI 上必须能分开（守卫用）', () => {
  assert.notEqual(
    contextPercent({ input: 0 }, 128000),
    null,
    '0% 与 null 是两回事：0% 是「确实没占」，null 是「算不出来」'
  );
});

test('T-09③：百分比取整，不显示 12.5% 这种假精度', () => {
  assert.equal(contextPercent({ input: 1 }, 3), 33);
  assert.equal(contextPercent({ input: 2 }, 3), 67);
});

test('T-09：fmtTokens 缩写的边界', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(1000), '1.0k');
  assert.equal(fmtTokens(1234), '1.2k');
  assert.equal(fmtTokens(128000), '128.0k');
  assert.equal(fmtTokens(null), '0', 'null 不该渲染成 NaN');
});

test('T-09①：轮次时刻取不到合法时间返回空串（不显示 1970 之类）', () => {
  assert.equal(clockAt(0), '');
  assert.equal(clockAt(null), '');
  assert.equal(clockAt(undefined), '');
  assert.equal(clockAt('abc'), '');
  assert.equal(clockAt(-1), '');
});

test('T-09①：合法时间戳出 HH:MM 形状的字符串（不随 locale 崩掉）', () => {
  const out = clockAt(Date.UTC(2026, 9, 7, 9, 30));
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0, '合法时间戳不该返回空串');
  assert.match(out, /\d/, `时刻里应该有数字，实际 ${out}`);
});
