import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityGroups, suggestExamples } from './examples';

const INDEP = ['page', 'context', 'tab']; // 独立助手页
const EDITOR = ['page', 'context', 'tab', 'canvas']; // 编辑器侧栏

test('T-10：徽标顺序固定，与 enabledGroups 的书写顺序无关', () => {
  assert.deepEqual(
    capabilityGroups(INDEP).map((g) => g.id),
    ['page', 'context', 'tab']
  );
  assert.deepEqual(
    capabilityGroups(['canvas', 'page']).map((g) => g.id),
    ['page', 'canvas'],
    '同一组能力在不同宿主里必须落在同一个位置，否则用户会以为顺序有含义'
  );
});

test('T-10：徽标只反映宿主真正开放的组 —— 无画布的助手页不能出现「画布」', () => {
  assert.deepEqual(
    capabilityGroups(INDEP).map((g) => g.id),
    ['page', 'context', 'tab']
  );
  assert.equal(
    capabilityGroups(INDEP).some((g) => g.id === 'canvas'),
    false,
    '独立助手页不开放 canvas，徽标却写着画布 = 当场说谎'
  );
  assert.deepEqual(
    capabilityGroups(EDITOR).map((g) => g.id),
    ['page', 'context', 'tab', 'canvas']
  );
});

test('T-10：enabledGroups 传函数时徽标照样求值（与 runtime 同一种形状）', () => {
  let open = ['page'];
  const fn = () => open;

  assert.deepEqual(
    capabilityGroups(fn).map((g) => g.id),
    ['page']
  );
  open = ['page', 'canvas']; // 团队权限变化后下一轮生效（T-135）
  assert.deepEqual(
    capabilityGroups(fn).map((g) => g.id),
    ['page', 'canvas'],
    '函数形式必须每次重新求值，不能在模块加载时求值一次'
  );
});

test('T-10：未知组不吞掉，保留在末尾（排查新组时要看得到）', () => {
  assert.deepEqual(
    capabilityGroups(['page', 'futureGroup']).map((g) => g.id),
    ['page', 'futureGroup']
  );
});

test('T-10：示例问法按宿主能力过滤 —— 无画布不给「加一个块」', () => {
  const indep = suggestExamples(INDEP).map((e) => e.id);
  assert.equal(
    indep.includes('addBlock'),
    false,
    '助手页没有画布，展示「在画布里加一个块」等于骗用户'
  );
  assert.ok(indep.includes('readPage'), '读页面是通用能力，两个宿主都该有');
  assert.ok(
    suggestExamples(EDITOR).some((e) => e.id === 'addBlock'),
    '编辑器侧栏有画布，该给画布示例'
  );
});

test('T-10：示例最多 limit 条、不重复，默认不超过 4 条（面板窄）', () => {
  assert.equal(suggestExamples(EDITOR, 2).length, 2, 'limit 传 2 就给 2 条');
  assert.equal(suggestExamples(EDITOR, 0).length, 0, 'limit 传 0 就一条不给');

  const all = suggestExamples(EDITOR);
  assert.ok(all.length <= 4, `默认最多 4 条，实际 ${all.length}`);
  assert.equal(new Set(all.map((e) => e.id)).size, all.length, '示例不能重复');
});

test('T-10：一个组都不开放时兜底给通用示例，不让空态退回一句话', () => {
  const none = suggestExamples([]);
  assert.equal(none.length, 1, '兜底也要给一条，否则空态又变成一句提示');
  assert.equal(typeof none[0].text, 'string');
  assert.ok(none[0].text.length > 0);
  assert.deepEqual(
    suggestExamples([]).map((e) => e.id),
    ['generic']
  );
});

test('T-10：脏输入（null / 非数组 / 空串成员）不能让选择逻辑炸掉', () => {
  assert.deepEqual(capabilityGroups(null), []);
  assert.deepEqual(capabilityGroups(undefined), []);
  assert.deepEqual(capabilityGroups(''), []);
  assert.deepEqual(capabilityGroups([null, '', 'page']), [{ id: 'page' }]);
  assert.equal(suggestExamples(null).length, 1, '脏输入也要落到兜底示例');
});
