import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTabs, parseAtDraft, stripAtToken, tabPickPayload } from './at';

/**
 * 这些边界里的多数在界面上长得一模一样（菜单没弹出来），靠点一遍分不出
 * 「判定写对了」和「碰巧没触发」—— 所以逐条钉住，包括**不该触发**的那几种。
 */
test('parseAtDraft：@ 前面是行首或空白才触发', () => {
  assert.equal(parseAtDraft(''), null, '空草稿不触发');
  assert.equal(parseAtDraft(null), null, 'null 不崩、不触发');
  assert.equal(parseAtDraft(undefined), null);

  assert.deepEqual(parseAtDraft('@'), { query: '', start: 0, end: 1 });
  assert.deepEqual(parseAtDraft('你好 @'), { query: '', start: 3, end: 4 });
  assert.deepEqual(
    parseAtDraft('abc\n@'),
    {
      query: '',
      start: 4,
      end: 5,
    },
    '换行也是空白 —— 换一行再打 @ 同样是想选页'
  );

  // 邮箱 / 社交句柄：@ 前面是普通字符，不是在选择目标页
  assert.equal(parseAtDraft('a@b'), null, 'a@b 是邮箱那一类，不该触发');
  assert.equal(parseAtDraft('@a@b'), null, '第二个 @ 前面是 a，不该触发');
});

test('parseAtDraft：查询串不含空白，@ 之后写完就不再是查询', () => {
  assert.deepEqual(parseAtDraft('帮我对一下 @淘宝'), {
    query: '淘宝',
    start: 6,
    end: 9,
  });

  // 已经打完这一句（@淘宝 后面还有字）：光标在末尾时不该再弹菜单 ——
  // 否则用户每打一个字菜单都在，Esc 关掉还会再弹。
  assert.equal(
    parseAtDraft('@淘宝 然后'),
    null,
    'token 已被空白截断，光标在末尾时不触发'
  );
});

test('parseAtDraft：光标位置（caret）决定摘哪一段', () => {
  // 光标停在 token 中间：query 只到光标处，end 也是光标处
  assert.deepEqual(parseAtDraft('@淘宝', 2), {
    query: '淘',
    start: 0,
    end: 2,
  });

  assert.equal(parseAtDraft('@淘宝', 0), null, '光标在最前面时没有 token');

  // 越界的 caret 一律夹住：输入法组合过程中 selectionStart 会给陈旧值
  assert.deepEqual(parseAtDraft('@ab', 99), {
    query: 'ab',
    start: 0,
    end: 3,
  });
  assert.equal(parseAtDraft('@ab', -5), null, '负的 caret 按 0 处理');
});

test('stripAtToken：只摘 @token，正文其余原样保留', () => {
  const token = parseAtDraft('帮我对一下 @淘宝');

  assert.equal(
    stripAtToken('帮我对一下 @淘宝', token),
    '帮我对一下 ',
    '摘掉的是把手本身 —— 它不该被一起发给模型'
  );

  assert.equal(
    stripAtToken('原文', null),
    '原文',
    '没有 token 时原样返回（点别处关掉菜单的那条路径）'
  );

  // 越界的 token 不该把草稿截坏
  assert.doesNotThrow(() => stripAtToken('abc', { start: 99, end: 99 }));
});

test('filterTabs：空查询原样返回，不丢分组', () => {
  const groups = [
    { windowId: 1, tabs: [{ id: 1, title: '商品列表', url: 'https://a.com' }] },
    { windowId: 2, tabs: [] },
  ];

  assert.deepEqual(
    filterTabs(groups, ''),
    groups,
    '刚按下 @ 时要看到全部可选项，连空分组也不该被先过滤掉'
  );
  assert.deepEqual(filterTabs(null, ''), [], 'null 分组不崩');
});

test('filterTabs：标题与 URL 都匹配、大小写不敏感', () => {
  const groups = [
    {
      windowId: 1,
      tabs: [
        { id: 1, title: '商品列表 - 淘宝网', url: 'https://s.taobao.com/x' },
        { id: 2, title: 'Docs', url: 'https://docs.google.com/y' },
      ],
    },
  ];

  const byTitle = filterTabs(groups, '淘宝');
  assert.equal(byTitle.length, 1);
  assert.equal(byTitle[0].tabs.length, 1);
  assert.equal(byTitle[0].tabs[0].id, 1, '按标题命中');

  const byUrl = filterTabs(groups, 'DOCS');
  assert.equal(byUrl[0].tabs.length, 1);
  assert.equal(byUrl[0].tabs[0].id, 2, '按 URL 命中且大小写不敏感');

  // 原分组对象不被就地改坏：过滤是给菜单用的，groups 还要留着下次弹
  assert.equal(groups[0].tabs.length, 2, '不能就地修改传入的分组');
});

test('filterTabs：过滤后丢掉空分组', () => {
  const groups = [
    { windowId: 1, tabs: [{ id: 1, title: '商品', url: 'https://a.com' }] },
    { windowId: 2, tabs: [{ id: 2, title: 'Docs', url: 'https://d.com' }] },
  ];

  const out = filterTabs(groups, '商品');

  assert.equal(out.length, 1, '只留命中的那个窗口');
  assert.equal(out[0].windowId, 1);
  assert.deepEqual(
    filterTabs(groups, '没有的东西'),
    [],
    '一个都不中时返回空数组 —— 而不是留下一串空的「窗口 N」标题'
  );

  // tabs 字段缺失的坏分组不该让整个菜单崩掉
  assert.deepEqual(filterTabs([{ windowId: 9 }], 'x'), []);
});

test('tabPickPayload：列表与 @ 菜单共用一个载荷形状', () => {
  const tab = {
    id: 3,
    url: 'https://a.com/x',
    title: 'A',
    windowId: 2,
    favIconUrl: 'https://a.com/f.ico',
  };

  assert.deepEqual(tabPickPayload(tab), {
    id: 3,
    url: 'https://a.com/x',
    title: 'A',
    windowId: 2,
    favIconUrl: 'https://a.com/f.ico',
  });

  // 展平后的 tab 可能不带 windowId（分组上有），要能补回来
  assert.equal(
    tabPickPayload({ id: 4, url: 'https://b.com', windowId: undefined }, 9)
      .windowId,
    9,
    'tab 自己没带 windowId 时用分组的那个'
  );

  // 图标缺失要是 undefined 而不是空串：chip 靠 v-if 判断画图标还是画地球
  const noIcon = tabPickPayload({ id: 5, url: 'https://c.com' });
  assert.equal(noIcon.favIconUrl, undefined, '空串会被当成「有图标」去加载');
  assert.equal(noIcon.title, 'https://c.com', '没标题时用 URL 顶上');

  assert.doesNotThrow(() => tabPickPayload(null), 'null 不该让菜单崩掉');
});
