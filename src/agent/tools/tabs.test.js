import test from 'node:test';
import assert from 'node:assert';
import { listTabs, focusTab, openUrl } from './tabs';

const OK_TAB = {
  id: 3,
  url: 'https://b.example.com/x',
  title: 'B页',
  windowId: 1,
};

function ctx(over = {}) {
  const state = {
    pins: [{ tabId: 1, origin: 'https://a.example.com', title: 'A页' }],
    focused: null,
    created: [],
  };
  return {
    state,
    ...{
      listTabs: async () => [
        {
          windowId: 1,
          tabs: [{ id: 1, url: 'https://a.example.com', title: 'A页' }],
        },
      ],
      getTab: async (id) =>
        id === 2
          ? { id: 2, url: 'https://b.example.com/y', title: 'B页' }
          : null,
      // T-132：契约是数组。生产里 index.js 用 JS getter、adapter spread 求值，
      // 夹具必须复刻「工具最终收到数组」这个形状，不许再传函数。
      get pins() {
        return state.pins;
      },
      focusTab: async (tabId) => {
        state.focused = tabId;
        return OK_TAB;
      },
      createTab: async (url) => {
        state.created.push(url);
        return { id: 9, url, title: '新页' };
      },
      addPin: async (pin) => {
        if (!state.pins.some((p) => p.tabId === pin.tabId))
          state.pins.push(pin);
      },
    },
    ...over,
  };
}

/* ---------------- list_tabs ---------------- */

test('list_tabs 按 tabId 列出，错误通道返回 error', async () => {
  const r = await listTabs(ctx());
  assert.equal(r.status, 'ok');
  assert.ok(r.payload.includes('tabId 1'));

  const empty = await listTabs(ctx({ listTabs: async () => [] }));
  assert.ok(empty.payload.includes('没有任何'));

  const err = await listTabs(
    ctx({
      listTabs: async () => {
        throw new Error('boom');
      },
    })
  );
  assert.equal(err.status, 'error');
});

/* ---------------- focus_tab ---------------- */

test('focus_tab 只允许切到 pin 里的 tabId', async () => {
  const c = ctx();

  const okR = await focusTab(c, { tabId: 1 });
  assert.equal(okR.status, 'ok');
  assert.equal(c.state.focused, 1);
  assert.ok(okR.payload.includes('下一个工具调用起生效'));

  // 不在 pin 里的页自动收进 pin 后切焦点（页开着就允许 focus，别逼模型开重复页）
  const auto = await focusTab(c, { tabId: 2 });
  assert.equal(auto.status, 'ok');
  assert.ok(auto.payload.includes('已自动加入'));
  assert.equal(c.state.focused, 2);
  assert.ok(c.state.pins.some((p) => p.tabId === 2));

  const badArgs = await focusTab(c, { tabId: '1' });
  assert.equal(badArgs.status, 'error');

  const gone = await focusTab(c, { tabId: 999 });
  assert.equal(gone.status, 'error');
  assert.ok(gone.payload.includes('不存在'));
});

/* ---------------- open_url ---------------- */

test('open_url 只放行 http/https', async () => {
  const c = ctx();

  const okR = await openUrl(c, { url: 'https://new.example.com/search?q=1' });
  assert.equal(okR.status, 'ok');
  assert.deepEqual(c.state.created, ['https://new.example.com/search?q=1']);
  assert.ok(
    c.state.pins.some((p) => p.tabId === 9),
    '开出的页要进 pin'
  );
  assert.equal(c.state.focused, 9, '并切焦点过去');

  for (const bad of [
    // eslint-disable-next-line no-script-url -- 测试数据，验证协议拒绝
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,x',
    'not a url',
  ]) {
    const r = await openUrl(ctx(), { url: bad });
    assert.equal(r.status, 'error', bad);
    if (/^(javascript|file|data):/.test(bad)) {
      assert.ok(r.payload.includes('http'), '协议拒绝要说明原因: ' + bad);
    }
  }
});

test('open_url 对浏览器返回无效 tab 的情况报错', async () => {
  const c = ctx({ createTab: async () => ({ id: -1 }) });
  const r = await openUrl(c, { url: 'https://x.example.com' });
  assert.equal(r.status, 'error');
});
