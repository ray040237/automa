import test from 'node:test';
import assert from 'node:assert';
import {
  isTargetable,
  resolveTargetTab,
  listTargetableTabs,
  normalize,
  originOf,
  targetHealth,
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

  assert.equal(originOf('not a url'), '');
});
