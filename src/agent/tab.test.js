import test, { describe } from 'node:test';
import assert from 'node:assert';
import {
  isTargetable,
  resolveTargetTab,
  listTargetableTabs,
  normalize,
  originOf,
  targetHealth,
  tabPickPayload,
  targetFollowPlan,
} from './tab';

/** 构造一个可控的 browser.tabs 替身 */
function fakeBrowser(tabs) {
  return {
    tabs: {
      async query() {
        return tabs;
      },
      async get(id) {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error('No tab with id: ' + id);
        return t;
      },
    },
    windows: {
      async getAll() {
        return [];
      },
    },
  };
}

const tab = (id, url, extra = {}) => ({
  id,
  url,
  title: 'T' + id,
  windowId: 1,
  lastAccessed: 0,
  ...extra,
});

test('禁入清单：无 content script 的 scheme 一律不可作为目标页', () => {
  [
    'chrome://extensions',
    'about:blank',
    'moz-extension://abc/x.html',
    'edge://settings',
    'devtools://devtools/x',
    'view-source:https://a.com',
    'data:text/html,hi',
  ].forEach((u) => {
    assert.equal(isTargetable({ url: u }), false, u + ' 必须被拒');
  });
});

test('禁入清单：扩展自己的页面不可作为目标页（R-1 的根因）', () => {
  assert.equal(
    isTargetable({ url: 'chrome-extension://abcdef/newtab.html' }),
    false
  );
});

test('禁入清单：扩展商店不可作为目标页', () => {
  [
    'https://chromewebstore.google.com/detail/x',
    'https://chrome.google.com/webstore',
    'https://addons.mozilla.org/en-US/firefox/',
  ].forEach((u) => {
    assert.equal(isTargetable({ url: u }), false, u);
  });
});

test('正常网页可作为目标页', () => {
  [
    'https://books.toscrape.com/',
    'http://localhost:3000/x',
    'file:///C:/a.html',
    'https://a.com/p?q=chrome://fake',
  ].forEach((u) => {
    assert.equal(isTargetable({ url: u }), true, u + ' 应被接受');
  });
});

test('空值与非法 URL 不可作为目标页', () => {
  [undefined, null, {}, { url: '' }, { url: 'not a url' }].forEach((t) => {
    assert.equal(isTargetable(t), false);
  });
});

test('优先级 1：pinned tab 优先于其他一切', async () => {
  const api = fakeBrowser([
    tab(1, 'https://recent.com/', { lastAccessed: 999 }),
    tab(2, 'https://pinned.com/'),
  ]);
  const r = await resolveTargetTab(api, { pinnedTabId: 2, windowId: 1 });
  assert.equal(r.id, 2);
});

test('pinned 已被关闭时降级到下一级，不抛错', async () => {
  const api = fakeBrowser([tab(1, 'https://a.com/', { lastAccessed: 10 })]);
  const r = await resolveTargetTab(api, { pinnedTabId: 999, windowId: 1 });
  assert.equal(r.id, 1);
});

test('pinned 存在但 URL 不可注入时也降级', async () => {
  const api = fakeBrowser([
    tab(1, 'https://a.com/', { lastAccessed: 10 }),
    tab(2, 'chrome://settings'),
  ]);
  const r = await resolveTargetTab(api, { pinnedTabId: 2, windowId: 1 });
  assert.equal(r.id, 1);
});

test('优先级 3：当前窗口优先于其他窗口，即使其他窗口更新', async () => {
  const api = fakeBrowser([
    tab(1, 'https://current-window.com/', { windowId: 1, lastAccessed: 1 }),
    tab(2, 'https://other-window.com/', { windowId: 2, lastAccessed: 9999 }),
  ]);
  const r = await resolveTargetTab(api, { windowId: 1 });
  assert.equal(r.id, 1, '用户眼前的窗口优先');
});

test('当前窗口无可注入页时降级到其他窗口', async () => {
  const api = fakeBrowser([
    tab(1, 'chrome-extension://abc/newtab.html', {
      windowId: 1,
      lastAccessed: 9999,
    }),
    tab(2, 'https://other.com/', { windowId: 2, lastAccessed: 1 }),
  ]);
  const r = await resolveTargetTab(api, { windowId: 1 });
  assert.equal(r.id, 2);
});

test('同窗口内按 lastAccessed 取最新的可注入页', async () => {
  const api = fakeBrowser([
    tab(1, 'https://old.com/', { windowId: 1, lastAccessed: 1 }),
    tab(2, 'https://new.com/', { windowId: 1, lastAccessed: 100 }),
  ]);
  const r = await resolveTargetTab(api, { windowId: 1 });
  assert.equal(r.id, 2);
});

test('没有任何可注入页时返回 null（上层报 no-target-tab）', async () => {
  const api = fakeBrowser([
    tab(1, 'chrome-extension://abc/newtab.html'),
    tab(2, 'about:blank'),
  ]);
  assert.equal(await resolveTargetTab(api, { windowId: 1 }), null);
});

test('解析结果归一化出 id/url/title/windowId', async () => {
  const api = fakeBrowser([
    { id: 5, url: 'https://a.com/', windowId: 3, lastAccessed: 1 },
  ]);
  const r = await resolveTargetTab(api, { windowId: 3 });
  assert.deepEqual(r, {
    id: 5,
    url: 'https://a.com/',
    title: 'https://a.com/',
    windowId: 3,
  });
});

test('列表按窗口分组，且只含可注入页', async () => {
  const api = fakeBrowser([
    tab(1, 'https://w1.com/', { windowId: 1, lastAccessed: 5 }),
    tab(2, 'https://w2.com/', { windowId: 2, lastAccessed: 50 }),
    tab(3, 'https://w2b.com/', { windowId: 2, lastAccessed: 10 }),
    tab(4, 'chrome://settings', { windowId: 1 }),
    tab(5, 'chrome-extension://abc/x', { windowId: 1 }),
  ]);
  const groups = await listTargetableTabs(api);
  const flat = groups.flatMap((g) => g.tabs);
  assert.deepEqual(
    flat.map((t) => t.id),
    [2, 3, 1]
  );
  assert.equal(flat.every(isTargetable), true);
});

/* ---------------- originOf（P2 pin 身份） ---------------- */

test('originOf 解析真实 origin，受限页/坏 URL 返回空串', () => {
  assert.equal(
    originOf('https://a.example.com/x?y=1'),
    'https://a.example.com'
  );
  // http 与 https 是不同 origin：跨协议跳转必须被判为漂移
  assert.equal(originOf('http://a.example.com/'), 'http://a.example.com');
  assert.equal(originOf('chrome://settings/'), '');
  assert.equal(originOf('about:blank'), '');
  assert.equal(originOf(''), '');
  assert.equal(originOf(undefined), '');
  assert.equal(originOf('not a url'), '');
});

// T-161：下面两条原本嵌在 `originOf` 那条 test 的**回调内部**。node:test 会在父回调
// 返回后把它们判成 cancelledByParent —— 文件照常报「通过」，断言却一次都没真正跑过
// （npm test 那 2 个 fail 就是这么来的）。改成 describe 分组后子测试才会真正执行。
describe('T-08：normalize 与 targetHealth', () => {
  test('T-08：normalize 带上 favIconUrl，缺省时干脆不写这个键', () => {
    const snap = normalize({
      id: 7,
      url: 'https://a.example/x',
      title: 'A',
      windowId: 1,
      favIconUrl: 'https://a.example/f.ico',
    });
    assert.equal(snap.favIconUrl, 'https://a.example/f.ico');

    const bare = normalize({ id: 8, url: 'https://b.example/', windowId: 1 });
    assert.equal(bare.favIconUrl, undefined);
    assert.ok(
      !('favIconUrl' in bare),
      '没有图标时不该留一个 undefined 键（JSON 序列化会多个假字段，同 errorEvent 的取舍）'
    );
    // 快照的其他四个字段不能因为加了这个而变样
    assert.deepEqual(
      Object.keys(bare).sort(),
      ['id', 'title', 'url', 'windowId'].sort()
    );
  });

  test('T-08：targetHealth 按 origin 判漂移，按存活判关闭', () => {
    const snap = { id: 7, url: 'https://a.example/x' };

    assert.equal(targetHealth(null, null), 'none', '还没有目标页');
    assert.equal(targetHealth(null, undefined), 'none');
    assert.equal(
      targetHealth(null, { url: 'x' }),
      'none',
      '没有数字 id 的快照不算目标页'
    );

    assert.equal(targetHealth(null, snap), 'closed', '拿不到 tab = 被关掉了');
    assert.equal(
      targetHealth({ id: 9, url: 'https://a.example/x' }, snap),
      'closed',
      'id 对不上 = 不是那一页'
    );

    assert.equal(
      targetHealth({ id: 7, url: 'https://a.example/y' }, snap),
      'ok',
      '同 origin 内跳转不算漂移'
    );
    assert.equal(
      targetHealth({ id: 7, url: 'https://b.example/' }, snap),
      'drift',
      '换 origin = 漂移'
    );

    // 快照 url 本身是非法 URL（originOf 返 ''）时不能判成漂移，否则会一直报警
    const odd = { id: 7, url: 'not a url' };
    assert.equal(targetHealth({ id: 7, url: 'https://c.example/' }, odd), 'ok');
  });
});

// T-177：从 at.test.js 搬来 —— `@` 换页入口已删，但这个载荷函数还在（目标页
// 下拉的选项靠它统一形状），所以测试跟着它搬到 tab.test.js。
test('tabPickPayload：面板下拉的载荷形状（区别于 normalize 的内部快照）', () => {
  // 名字避开上层那个 tab() 工厂 —— no-shadow 会拦
  const item = {
    id: 3,
    url: 'https://a.com/x',
    title: 'A',
    windowId: 2,
    favIconUrl: 'https://a.com/f.ico',
  };

  assert.deepEqual(tabPickPayload(item), {
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

  assert.doesNotThrow(() => tabPickPayload(null), 'null 不该让列表崩掉');

  // 与 normalize 的区别：normalize 缺图标时**不写这个键**，这里**写 undefined**。
  // 两者在下游 `v-if` 下等价，但形状不同 —— 钉住它，免得有人「顺手统一」时
  // 静默改掉一个被断言过的形状。
  assert.equal(
    'favIconUrl' in normalize({ id: 5, url: 'https://c.com' }),
    false,
    'normalize 不带 favIconUrl 键'
  );
  assert.equal(
    'favIconUrl' in tabPickPayload({ id: 5, url: 'https://c.com' }),
    true,
    'tabPickPayload 显式带 undefined 键'
  );
});

// ═══════════════════════════════════════════════════════════════
// T-215：跟随态的动作判定（targetFollowPlan）
//
// 背景：跟随态此前只在 pin/unpin/init 各解析一次，之后冻结 —— 没有任何
// 监听者在听「用户切换了标签页」。agentHost 的三个监听器（activated /
// removed / updated）现在统一问本函数拿动作，这里钉住判定矩阵。
// ═══════════════════════════════════════════════════════════════

test('T-215：固定态三个事件都只判健康 —— pin 的纪律就是不跟', () => {
  for (const event of ['activated', 'removed', 'updated']) {
    assert.equal(
      targetFollowPlan({
        pinned: true,
        event,
        eventTabId: 7,
        urlChanged: true,
      }),
      'health',
      event + ' 在固定态必须 health（origin 才是真身份，不自动换页）'
    );
  }
});

test('T-215：自动态 activated —— 换页重解析，激活的就是目标页则跳过', () => {
  assert.equal(
    targetFollowPlan({
      pinned: false,
      event: 'activated',
      targetTabId: 3,
      eventTabId: 5,
    }),
    'reresolve',
    '用户切到另一页：跟随语义就是跟过去'
  );
  assert.equal(
    targetFollowPlan({
      pinned: false,
      event: 'activated',
      targetTabId: 5,
      eventTabId: 5,
    }),
    'skip',
    '激活的就是当前目标页：解析结果不会变，省一次 tabs 查询'
  );
});

test('T-215：自动态 removed —— 读的页没了就跟下一个（不再挂着 closed）', () => {
  assert.equal(
    targetFollowPlan({ pinned: false, event: 'removed' }),
    'reresolve',
    '自动态目标页被关：按降级链重解析，chip 不该停在「已关闭」'
  );
});

test('T-215：自动态 updated —— 同页签导航才重解析，title/favicon 只判健康', () => {
  assert.equal(
    targetFollowPlan({
      pinned: false,
      event: 'updated',
      targetTabId: 3,
      urlChanged: true,
    }),
    'reresolve',
    '同一页签导航到新页面是跟随语义的一部分，目标应更新而不是报 drift'
  );
  assert.equal(
    targetFollowPlan({
      pinned: false,
      event: 'updated',
      targetTabId: 3,
      urlChanged: false,
    }),
    'health',
    'title / favicon 变化无关跟随，照旧判健康'
  );
});
