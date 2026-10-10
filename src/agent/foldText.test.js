/**
 * `foldText.js` 的单测（T-205）。
 *
 * 折叠判定的三个边界在界面上都「看起来正常」，只有单测能钉住：
 * 未测量不折、阈值附近不抖、非法输入不糊。见模块头注。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { foldDecision, USER_FOLD_MAX_PX } from './foldText';

test('T-205：未量到高度（0 / NaN / 负数）时不折，避免首帧闪折叠', () => {
  for (const measuredPx of [0, undefined, null, NaN, -1, 'abc']) {
    assert.deepEqual(
      foldDecision({ measuredPx }),
      { foldable: false, collapsed: false },
      `measuredPx=${String(measuredPx)} 时不该折（组件首帧还没布局）`
    );
  }
});

test('T-205：恰好等于阈值不折，超过一个像素才折', () => {
  assert.equal(
    foldDecision({ measuredPx: USER_FOLD_MAX_PX }).foldable,
    false,
    '等于阈值不该折 —— 边界归「不折」一侧，避免临界内容被莫名收起'
  );
  assert.deepEqual(
    foldDecision({ measuredPx: USER_FOLD_MAX_PX + 1 }),
    { foldable: true, collapsed: true },
    '刚超过阈值就该折，且默认是折着的'
  );
});

test('T-205：超阈值但已展开时，仍算 foldable 但不 collapsed（防展开瞬间弹回）', () => {
  // 这是头注②要防的那个 bug：展开后高度必然更大，若展开/收起共用一个阈值，
  // 展开的瞬间就会被判回「要折」——用户点了按钮像没反应。
  const r = foldDecision({ measuredPx: 900, expanded: true });
  assert.equal(
    r.foldable,
    true,
    '它本来就是个长消息，折叠能力要一直在（按钮显示「收起」）'
  );
  assert.equal(r.collapsed, false, '用户已展开，不能被高度重新盖回去');
});

test('T-205：maxPx 非法时退化为「不折」，而不是把所有内容都折起来', () => {
  for (const maxPx of [0, -10, NaN, 'x']) {
    assert.deepEqual(
      foldDecision({ measuredPx: 999, maxPx }),
      { foldable: false, collapsed: false },
      `maxPx=${String(maxPx)} 非法时不该把内容折起来`
    );
  }
});

test('T-205：默认阈值是 240（与参考实现一致，改动要重跑守卫）', () => {
  assert.equal(USER_FOLD_MAX_PX, 240);
});
