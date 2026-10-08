import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUP_EARLIER,
  GROUP_TODAY,
  GROUP_YESTERDAY,
  clockOf,
  dateOf,
  dayGroupOf,
  filterSessionsByTitle,
  groupSessionsByDay,
} from './sessionGroups';

/** 2026-03-05 14:32 本地时间；测试里的「今天」一律以它为基准。 */
const NOW = new Date(2026, 2, 5, 14, 32, 0, 0).getTime();
const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test('dayGroupOf：按自然日切，不是按 24 小时滑窗', () => {
  assert.equal(dayGroupOf(at(2026, 3, 5, 9, 0), NOW), GROUP_TODAY);
  assert.equal(dayGroupOf(at(2026, 3, 5, 23, 59), NOW), GROUP_TODAY);

  assert.equal(
    dayGroupOf(at(2026, 3, 4, 23, 50), NOW),
    GROUP_YESTERDAY,
    '昨晚 23:50 距今只 9 小时，但用户心里它是「昨天的」'
  );
  assert.equal(dayGroupOf(at(2026, 3, 4, 0, 1), NOW), GROUP_YESTERDAY);

  assert.equal(dayGroupOf(at(2026, 3, 3, 23, 59), NOW), GROUP_EARLIER);
  assert.equal(dayGroupOf(at(2026, 1, 20), NOW), GROUP_EARLIER);
});

test('dayGroupOf：时间戳缺失或 now 缺失一律归「更早」', () => {
  assert.equal(dayGroupOf(0, NOW), GROUP_EARLIER, '0 不是今天');
  assert.equal(dayGroupOf(undefined, NOW), GROUP_EARLIER);
  assert.equal(dayGroupOf(NaN, NOW), GROUP_EARLIER);
  assert.equal(
    dayGroupOf(at(2026, 3, 5, 9, 0), 0),
    GROUP_EARLIER,
    'now 拿不到时不敢猜「今天」—— 归到更早，用户不会误以为刚聊过'
  );
});

test('clockOf / dateOf：拿不到合法时间返回空串，不是「0」', () => {
  assert.equal(clockOf(at(2026, 3, 5, 9, 5)), '09:05');
  assert.equal(clockOf(0), '');
  assert.equal(clockOf(undefined), '');

  assert.equal(dateOf(at(2026, 12, 30)), '12-30');
  assert.equal(dateOf(at(2026, 1, 2)), '01-02');
  assert.equal(dateOf(0), '');
});

test('groupSessionsByDay：组内保序、丢掉空分组', () => {
  const entries = [
    { id: 'a', title: '今天的', lastAccessedAt: at(2026, 3, 5, 10, 0) },
    { id: 'b', title: '今天的早些', lastAccessedAt: at(2026, 3, 5, 8, 0) },
    { id: 'c', title: '昨天的', lastAccessedAt: at(2026, 3, 4, 18, 0) },
    { id: 'd', title: '更早的', lastAccessedAt: at(2026, 2, 20, 9, 0) },
  ];

  const groups = groupSessionsByDay(entries, NOW);

  assert.deepEqual(
    groups.map((g) => g.key),
    [GROUP_TODAY, GROUP_YESTERDAY, GROUP_EARLIER],
    '分组顺序固定为 今天 / 昨天 / 更早'
  );
  assert.deepEqual(
    groups[0].items.map((s) => s.id),
    ['a', 'b'],
    '组内沿用输入顺序（listIndex 已按 lastAccessedAt 降序）'
  );

  // 只有今天有会话时不该冒出空的「昨天」「更早」标题
  const onlyToday = groupSessionsByDay([entries[0]], NOW);
  assert.equal(onlyToday.length, 1);
  assert.equal(onlyToday[0].key, GROUP_TODAY);

  assert.deepEqual(groupSessionsByDay([], NOW), [], '空列表返回空数组');
  assert.deepEqual(groupSessionsByDay(null, NOW), [], 'null 不崩');
});

test('groupSessionsByDay：createdAt 兜底、跨年归入更早', () => {
  // 老索引条目可能只有 createdAt
  const groups = groupSessionsByDay(
    [{ id: 'x', title: 'x', createdAt: at(2026, 3, 5, 9, 0) }],
    NOW
  );
  assert.equal(
    groups[0].key,
    GROUP_TODAY,
    '没有 lastAccessedAt 时退回 createdAt'
  );

  // 去年同月的会话：MM-DD 长得一样，但分组把它放到「更早」，不会并列在今天旁边
  const withLastYear = groupSessionsByDay(
    [
      { id: 'now', title: 'n', lastAccessedAt: at(2026, 3, 5, 9, 0) },
      { id: 'old', title: 'o', lastAccessedAt: at(2025, 3, 5, 9, 0) },
    ],
    NOW
  );
  assert.deepEqual(
    withLastYear.map((g) => g.key),
    [GROUP_TODAY, GROUP_EARLIER]
  );
  assert.equal(
    dateOf(at(2025, 3, 5)),
    dateOf(at(2026, 3, 5)),
    '跨年是已知取舍：日期不带年份，靠分组兜住（见 dateOf 注释）'
  );
});

test('filterSessionsByTitle：只搜标题、大小写不敏感、空查询原样返回', () => {
  const entries = [
    { id: '1', title: '商品列表 · 比价' },
    { id: '2', title: '把这个流程改成每天跑一次' },
    { id: '3', title: '' },
  ];

  assert.equal(filterSessionsByTitle(entries, '比价').length, 1);
  assert.equal(
    filterSessionsByTitle(entries, 'BIJIA').length,
    0,
    '中文标题不做拼音匹配 —— 搜不到就是搜不到，别假装'
  );
  assert.equal(filterSessionsByTitle(entries, '').length, 3, '空查询原样返回');
  assert.equal(
    filterSessionsByTitle(entries, '   ').length,
    3,
    '纯空白等同空查询'
  );
  assert.deepEqual(
    filterSessionsByTitle(entries, ''),
    entries,
    '返回的是原数组引用'
  );

  // 无标题的条目（界面上显示「未命名会话」）不该被任意查询命中
  assert.equal(filterSessionsByTitle(entries, '未命名').length, 0);

  assert.deepEqual(filterSessionsByTitle(null, 'x'), [], 'null 不崩');
});
