import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fingerprintChangedNotice,
  fingerprintKey,
  initialPinsFromTab,
  originDriftKey,
  originDriftNotice,
  restoredTarget,
  TAB_GONE_TITLE,
  tabClosedNotice,
  upsertPin,
} from './targetState';

test('tabClosedNotice：文案带 tabId 与出路指引', () => {
  const msg = tabClosedNotice(42);
  assert.ok(msg.includes('id 42'));
  assert.ok(msg.includes('list_tabs'));
  assert.ok(msg.includes('open_url'));
});

test('originDriftNotice：只在 origin 真的变了时出文案', () => {
  assert.equal(
    originDriftNotice({ expected: 'https://a.com', actual: 'https://a.com' }),
    null
  );
  assert.equal(
    originDriftNotice({ expected: '', actual: 'https://b.com' }),
    null
  );
  assert.equal(
    originDriftNotice({ expected: 'https://a.com', actual: '' }),
    null
  );
  const msg = originDriftNotice({
    expected: 'https://a.com',
    actual: 'https://b.com',
    url: 'https://b.com/x',
  });
  assert.ok(msg.includes('https://a.com') && msg.includes('https://b.com'));
  assert.ok(msg.includes('https://b.com/x'));
  assert.equal(
    originDriftKey('https://a.com', 'https://b.com'),
    'origin:https://a.com>https://b.com'
  );
});

test('fingerprintChangedNotice：相同或缺失返回 null，变化出去重键', () => {
  assert.equal(fingerprintChangedNotice({ before: 'fp1', after: 'fp1' }), null);
  assert.equal(fingerprintChangedNotice({ before: null, after: 'fp2' }), null);
  assert.equal(fingerprintChangedNotice({ before: 'fp1', after: null }), null);
  const msg = fingerprintChangedNotice({ before: 'fp1', after: 'fp2' });
  assert.ok(msg.includes('fp1') && msg.includes('fp2'));
  assert.equal(fingerprintKey('fp1', 'fp2'), 'fp:fp1>fp2');
});

test('initialPinsFromTab：只在「无 pin 且目标页是真 tab」时捕获', () => {
  const originOf = (url) => new URL(url).origin;
  assert.equal(initialPinsFromTab([], null, originOf), null);
  assert.equal(
    initialPinsFromTab([], { id: -1, url: 'about:blank' }, originOf),
    null,
    'id<0 是恢复/分离页假 tab，绝不能当 pin 身份'
  );
  assert.equal(
    initialPinsFromTab(
      [{ tabId: 1 }],
      { id: 2, url: 'https://a.com' },
      originOf
    ),
    null,
    '已有 pin 时不重写'
  );
  const pins = initialPinsFromTab(
    [],
    { id: 7, url: 'https://a.com/x', title: 'A' },
    originOf
  );
  assert.deepEqual(pins, [{ tabId: 7, origin: 'https://a.com', title: 'A' }]);
});

test('upsertPin：按 tabId 去重；重复时保持原引用', () => {
  const list = [{ tabId: 1, origin: 'a' }];
  assert.equal(upsertPin(list, { tabId: 1 }), list, '同 tabId 追加是 no-op');
  const next = upsertPin(list, { tabId: 2, origin: 'b' });
  assert.deepEqual(next, [
    { tabId: 1, origin: 'a' },
    { tabId: 2, origin: 'b' },
  ]);
  assert.notEqual(next, list, '新 pin 产出新数组，不改写入参');
});

// —— T-196 / T-197：打开会话时按 pin 还原「目标页三件套」 ——
//
// 这两条 bug 的根因是 openSession 只回一个 targetTab，pinned / state 沿用旧值。
// 判定抽成 restoredTarget 纯函数后，下面把三种情形钉死：无 pin、pin 且活、
// pin 但页已关。谁再退回「只算 targetTab 不回其余两个状态」的写法，这里就红。

test('T-196 restoredTarget：该会话没有 pin → 无目标、非固定、state=none', () => {
  assert.deepEqual(restoredTarget(null, null), {
    tab: null,
    pinned: false,
    state: 'none',
  });
});

test('T-196 restoredTarget：pin 且页还活着 → 固定(pinned) + state=ok', () => {
  const live = { id: 7, url: 'https://a.com', title: 'A', windowId: 2 };
  const out = restoredTarget({ tabId: 7, title: 'A' }, live);
  assert.equal(out.tab, live, '活 tab 原样透传，不重造快照');
  assert.equal(out.pinned, true, 'pin 命中的目标页必须标成「已固定」');
  assert.equal(out.state, 'ok');
});

test('T-197 restoredTarget：pin 但页已关 → 兜底快照 + state=closed（进红色失效态）', () => {
  const out = restoredTarget({ tabId: 9, title: '旧标题' }, null);
  assert.equal(out.tab.id, 9);
  assert.equal(out.tab.url, '', '页已关时 url 为空');
  assert.equal(out.tab.title, '旧标题', '保留 pin 记下的标题');
  assert.equal(out.tab.windowId, -1);
  assert.equal(out.pinned, true);
  assert.equal(
    out.state,
    'closed',
    '必须是 closed，不能停在 ok（T-197 的根因）'
  );
});

test('T-197 restoredTarget：pin 无标题时用兜底文案', () => {
  const out = restoredTarget({ tabId: 3 }, null);
  assert.equal(out.tab.title, TAB_GONE_TITLE);
});
