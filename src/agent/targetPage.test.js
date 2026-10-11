/**
 * 目标页账本（targetPage.js）的行为测试 —— T-224。
 *
 * 这份测试是 refactor 的一部分，不是事后补的：先钉行为、再搬状态。
 * 全部断言都走 createTargetPageLedger 的公开 interface —— 实现内部
 * 怎么摆变量，这里一概不问（那正是 T-224 要收进盒子里的东西）。
 *
 * 两类断言值得点名：
 *  - 「严格等价怪癖」组：T-224 拍板「重构不修行为」，所以 lastRead /
 *    fpNoticeKey 跨会话残留这两个已知怪癖**故意**在这里钉成绿的 ——
 *    哪天裁决要修，改的就是这两条（连同 backlog T-224 的裁决记录）。
 *  - 「T-132 活值回归」组：CONTEXT.md 明文要求跨 seam 钉住「宿主传
 *    JS getter → 工具 execute 时刻拿到活值」，这条事故的教训。
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createTargetPageLedger } from './targetPage';

/** 构造可控的 browserApi：只有账本会用到的 tabs.get。 */
function fakeBrowserApi(tabs) {
  return {
    tabs: {
      async get(id) {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error('No tab with id: ' + id);
        return t;
      },
    },
  };
}

/** 可记录调用次数的 readPage 替身（指纹探针用）。 */
function fakeReadPage(fingerprintOrFn) {
  const calls = [];
  const fn =
    typeof fingerprintOrFn === 'function'
      ? fingerprintOrFn
      : async () => ({ text: '<page>', fingerprint: fingerprintOrFn });
  const readPage = async (tab, params) => {
    calls.push({ tab, params });
    return fn(tab, params);
  };
  readPage.calls = calls;
  return readPage;
}

const ledgerOf = ({ initialTab = null, tabs = [], readPage = null } = {}) =>
  createTargetPageLedger({
    browserApi: fakeBrowserApi(tabs),
    readPage: readPage || fakeReadPage('fp-x'),
    initialTab,
  });

const tab = (id, url, extra = {}) => ({
  id,
  url,
  title: 'T' + id,
  windowId: 1,
  ...extra,
});

describe('基础读写', () => {
  test('setTarget 换目标页，current() 跟随且返回值就是新快照', () => {
    const led = ledgerOf({ initialTab: tab(1, 'https://a.com/x') });
    const next = tab(2, 'https://b.com/y');

    assert.equal(led.setTarget(next), next);
    assert.equal(led.current(), next);
  });

  test('pickTab：换目标 + 并入 pin + 设焦点；id<0 的假 tab 只换目标不动 pin', () => {
    const led = ledgerOf();
    const real = tab(3, 'https://real.com/a');

    led.pickTab(real);
    assert.equal(led.current(), real);
    assert.deepEqual(led.getPins(), [
      { tabId: 3, origin: 'https://real.com', title: 'T3' },
    ]);
    assert.equal(led.getFocusedTabId(), 3);

    // 浏览器会话恢复/分离页的假 tab（id<0）不能当 pin 身份
    const ghost = tab(-5, 'https://ghost.com/b');
    led.pickTab(ghost);
    assert.equal(led.current(), ghost);
    assert.equal(led.getPins().length, 1, 'ghost tab 不入 pin');
    assert.equal(led.getFocusedTabId(), 3, '焦点也不被 ghost 抢走');

    // pickTab(null) 只换目标（变成无目标快照），pin 原样留着
    led.pickTab(null);
    assert.equal(led.current(), null);
    assert.equal(led.getPins().length, 1);
  });
});

describe('pin 与焦点', () => {
  test('addPin 按 tabId 去重，重复追加不改焦点以外的任何东西', async () => {
    const led = ledgerOf();
    await led.addPin({ tabId: 5, origin: 'https://five.com', title: 'F5' });
    await led.addPin({ tabId: 6, origin: 'https://six.com', title: 'F6' });
    await led.addPin({ tabId: 5, origin: 'https://five.com', title: 'F5' });

    assert.deepEqual(
      led.getPins().map((p) => p.tabId),
      [5, 6]
    );
    assert.equal(
      led.getFocusedTabId(),
      5,
      '重复 upsert 时焦点仍是最后一次 addPin 的'
    );
  });

  test('focusTab：经 browserApi 取新快照、换目标、设焦点，返回新快照本身', async () => {
    const led = ledgerOf({
      tabs: [tab(7, 'https://seven.com/now', { title: '第七页' })],
    });
    await led.addPin({
      tabId: 7,
      origin: 'https://seven.com',
      title: '旧标题',
    });

    const fresh = await led.focusTab(7);

    assert.equal(fresh.title, '第七页', '拿到的是 tabs.get 的新快照');
    assert.equal(led.current(), fresh);
    assert.equal(led.getFocusedTabId(), 7);
  });

  test('unpin 清空**整份** pins（含 open_url 追加的），第二次返回 false', async () => {
    const led = ledgerOf({ initialTab: tab(1, 'https://a.com/x') });
    led.pickTab(tab(1, 'https://a.com/x'));
    await led.addPin({ tabId: 9, origin: 'https://nine.com', title: 'N9' });
    assert.equal(led.getPins().length, 2);

    assert.equal(led.unpin(), true, '有 pin 时返回 true，宿主据此重解析');
    assert.deepEqual(
      led.getPins(),
      [],
      '清的是整份 —— 只摘一个会留 open_url 的页'
    );
    assert.equal(led.getFocusedTabId(), null);
    assert.ok(led.current(), '解除的是「固定」不是目标页本身');

    assert.equal(
      led.unpin(),
      false,
      '自动态再解除返回 false，宿主据此跳过重解析'
    );
  });

  test('T-132 活值回归：getter 经 spread（adapter 的习语）拿到的是数组且是活的', async () => {
    const led = ledgerOf();
    // 与 index.js 的 toolCtx 同一形状：JS getter，不是函数（T-132 的病灶）
    const ctx = {
      get pins() {
        return led.getPins();
      },
      addPin: (pin) => led.addPin(pin),
      getTab: async () => {
        throw new Error('not needed here');
      },
    };

    // adapter 每次 execute 都 {...toolCtx} spread —— spread 时求值 getter
    let spread = { ...ctx };
    assert.ok(
      Array.isArray(spread.pins),
      'spread 后必须是数组（T-132：契约是数组不是函数）'
    );

    await spread.addPin({ tabId: 4, origin: 'https://four.com' });
    spread = { ...ctx };
    assert.deepEqual(
      spread.pins.map((p) => p.tabId),
      [4],
      '重新 spread 要看到 addPin 之后的值 —— 活值，不是旧快照'
    );
  });
});

describe('preStepNotice（T-224 起的第一个直测）', () => {
  test('没有目标页 / 目标页没有数字 id 时返回 null，不碰 browser', async () => {
    const led = ledgerOf();
    assert.equal(await led.preStepNotice(), null);

    const noId = ledgerOf({ initialTab: { url: 'https://a.com' } });
    assert.equal(await noId.preStepNotice(), null);
  });

  test('焦点 tab 被关（tabs.get 抛错）返回关闭通知，不改目标页', async () => {
    const gone = tab(11, 'https://gone.com/x');
    const led = ledgerOf({ initialTab: gone, tabs: [] });

    const notice = await led.preStepNotice();
    assert.match(notice, /已经关闭/);
    assert.match(notice, /11/);
    assert.equal(led.current(), gone, '页没了，快照保留原样给面板/模型看');
  });

  test('目标页活着时刷新快照（url/title 更新），origin 没动就不提示', async () => {
    const led = ledgerOf({
      initialTab: tab(12, 'https://shop.com/list', { title: '旧标题' }),
      tabs: [tab(12, 'https://shop.com/list?page=2', { title: '新标题' })],
    });

    assert.equal(await led.preStepNotice(), null);
    const cur = led.current();
    assert.equal(cur.title, '新标题', '快照刷新成「这一刻」的');
    assert.equal(cur.url, 'https://shop.com/list?page=2');
  });

  test('origin 漂移提示一次；同一漂移第二次（同轮）不再刷', async () => {
    const led = ledgerOf({
      initialTab: tab(13, 'https://shop.com/list'),
      tabs: [tab(13, 'https://checkout.com/pay')],
    });
    // pin 记录的 origin 是旧页的 —— 模拟用户从 pin 的页导航走了
    led.restoreFromRecord(
      [{ tabId: 13, origin: 'https://shop.com', title: 'T13' }],
      13
    );

    const first = await led.preStepNotice();
    assert.match(first, /https:\/\/shop\.com/);
    assert.match(first, /https:\/\/checkout\.com/);
    assert.equal(await led.preStepNotice(), null, '同一条漂移只提示一次');
  });

  test('指纹变化：prepareTurn 后 probe 一次，变了就提示；latch 保证每轮只 probe 一次', async () => {
    let fp = 'fp-1';
    const readPage = fakeReadPage(async () => ({
      text: '<page>',
      fingerprint: fp,
    }));
    const led = ledgerOf({
      initialTab: tab(14, 'https://a.com/x'),
      tabs: [tab(14, 'https://a.com/x')],
      readPage,
    });

    // 模型真的读过页：记下基线指纹
    led.recordRead({ text: '<page>', fingerprint: 'fp-1' });
    led.prepareTurn();

    const first = await led.preStepNotice();
    assert.equal(first, null, 'probe 与基线相同 → 不提示');
    assert.equal(readPage.calls.length, 1);

    fp = 'fp-2';
    // 同一轮内第二次调用：latch 已消费，不许再 probe
    assert.equal(await led.preStepNotice(), null);
    assert.equal(readPage.calls.length, 1, '每轮最多一次 probe');

    // 下一轮：基线还是 fp-1，页面已是 fp-2 → 提示
    led.prepareTurn();
    const notice = await led.preStepNotice();
    assert.match(notice, /fp-1/);
    assert.match(notice, /fp-2/);
    assert.equal(readPage.calls.length, 2);
  });

  test('T-225：probe 拿到失败形状（{ok:false,error}）不提示不炸，比对跳过', async () => {
    const readPage = fakeReadPage(async () => ({
      ok: false,
      error: '页面无响应（15s 无应答）：页面可能被占死了。',
    }));
    const led = ledgerOf({
      initialTab: tab(16, 'https://a.com/x'),
      tabs: [tab(16, 'https://a.com/x')],
      readPage,
    });

    led.recordRead({ text: '<page>', fingerprint: 'fp-1' });
    led.prepareTurn();

    assert.equal(
      await led.preStepNotice(),
      null,
      '读不到页 ≠ 页面没变：没有指纹可比，不许产生假「没变」结论'
    );
    assert.equal(
      readPage.calls.length,
      1,
      'probe 确实发生了（不是被静默跳过）'
    );
  });

  test('T-225：recordRead 收到失败形状不记基线，下一轮不再触发 probe', () => {
    const readPage = fakeReadPage('fp-any');
    const led = ledgerOf({
      initialTab: tab(17, 'https://a.com/x'),
      tabs: [tab(17, 'https://a.com/x')],
      readPage,
    });

    led.recordRead({ ok: false, error: '没有确定目标页。' });
    led.prepareTurn();

    assert.equal(
      readPage.calls.length,
      0,
      '基线没记上 → prepareTurn 不开 probe'
    );
  });

  test('模型从没读过页 → prepareTurn 不开 probe（省一次 content 往返）', async () => {
    const readPage = fakeReadPage('fp-any');
    const led = ledgerOf({
      initialTab: tab(15, 'https://a.com/x'),
      tabs: [tab(15, 'https://a.com/x')],
      readPage,
    });

    led.prepareTurn();
    assert.equal(await led.preStepNotice(), null);
    assert.equal(readPage.calls.length, 0);
  });

  test('prepareTurn 重置漂移去重键：同一漂移下一轮要再提示', async () => {
    const led = ledgerOf({
      initialTab: tab(16, 'https://shop.com/list'),
      tabs: [tab(16, 'https://checkout.com/pay')],
    });
    led.restoreFromRecord(
      [{ tabId: 16, origin: 'https://shop.com', title: 'T16' }],
      16
    );

    assert.match(await led.preStepNotice(), /checkout\.com/);
    assert.equal(await led.preStepNotice(), null, '同轮去重');

    led.prepareTurn();
    assert.match(
      await led.preStepNotice(),
      /checkout\.com/,
      '新的一轮是新的告知窗口 —— 同一漂移重新提示'
    );
  });
});

describe('会话切换与恢复（严格等价怪癖在此钉死）', () => {
  test('restoreFromRecord 从记录恢复 pins 与焦点', () => {
    const led = ledgerOf();
    led.restoreFromRecord(
      [
        { tabId: 20, origin: 'https://a.com', title: 'A' },
        { tabId: 21, origin: 'https://b.com', title: 'B' },
      ],
      21
    );

    assert.deepEqual(
      led.getPins().map((p) => p.tabId),
      [20, 21]
    );
    assert.equal(led.getFocusedTabId(), 21);
  });

  test('怪癖（T-224 拍板暂不修）：lastRead 跨会话残留 —— 新会话首轮 probe 仍会打', async () => {
    const readPage = fakeReadPage('fp-leaked');
    const led = ledgerOf({
      initialTab: tab(30, 'https://a.com/x'),
      tabs: [tab(30, 'https://a.com/x')],
      readPage,
    });

    led.recordRead({ text: '<page>', fingerprint: 'fp-old' });
    // 切会话：restoreFromRecord / resetForNewSession 都不清 lastRead
    led.resetForNewSession();
    led.prepareTurn();

    await led.preStepNotice();
    assert.equal(
      readPage.calls.length,
      1,
      'lastRead 残留导致 fpCheckPending 开着 —— 已知怪癖，行为与重构前逐字一致'
    );
  });

  test('怪癖（T-224 拍板暂不修）：resetForNewSession 清 pins/焦点/漂移键，不动 targetTab 与 fpNoticeKey', async () => {
    let fp = 'fp-1';
    const readPage = fakeReadPage(async () => ({
      text: '<page>',
      fingerprint: fp,
    }));
    const led = ledgerOf({
      initialTab: tab(31, 'https://a.com/x'),
      tabs: [tab(31, 'https://a.com/x')],
      readPage,
    });

    led.pickTab(tab(31, 'https://a.com/x'));
    led.recordRead({ text: '<page>', fingerprint: 'fp-1' });
    led.prepareTurn();
    fp = 'fp-2';
    assert.match(
      await led.preStepNotice(),
      /fp-1/,
      '造出 fp:fp-1>fp-2 的去重键'
    );

    led.resetForNewSession();
    assert.deepEqual(led.getPins(), [], 'pins 清空');
    assert.equal(led.getFocusedTabId(), null, '焦点清空');
    assert.ok(led.current(), 'targetTab 不清（怪癖：chip 继续显示旧页）');

    // fpNoticeKey 残留：同样的指纹变化下轮不再提示
    led.recordRead({ text: '<page>', fingerprint: 'fp-1' });
    led.prepareTurn();
    assert.equal(
      await led.preStepNotice(),
      null,
      'fp:fp-1>fp-2 键没被清 —— 同一变化跨会话不再提示（已知怪癖）'
    );
  });

  test('restoreTarget：pin 的页活着 → ok + 换目标；页已关 → closed + 兜底快照；无 pin → none', async () => {
    const aliveLed = ledgerOf({
      tabs: [tab(40, 'https://alive.com/x', { title: '活着' })],
    });
    aliveLed.restoreFromRecord(
      [{ tabId: 40, origin: 'https://alive.com', title: '活着' }],
      40
    );
    const ok = await aliveLed.restoreTarget();
    assert.ok(ok.tab, '活页要恢复成目标');
    assert.equal(ok.pinned, true);
    assert.equal(ok.state, 'ok');
    assert.equal(ok.tab.title, '活着');
    assert.equal(aliveLed.current(), ok.tab, '恢复出的活页要成为当前目标');

    const deadLed = ledgerOf({ tabs: [] });
    deadLed.restoreFromRecord(
      [{ tabId: 41, origin: 'https://dead.com', title: '死了' }],
      41
    );
    const closed = await deadLed.restoreTarget();
    assert.equal(closed.pinned, true);
    assert.equal(closed.state, 'closed', '面板据此进红色失效态（T-197）');
    assert.equal(closed.tab.id, 41);
    assert.ok(closed.tab.title, '兜底快照要带得出现在身份');

    const noneLed = ledgerOf({ initialTab: tab(1, 'https://a.com/x') });
    const before = noneLed.current();
    const none = await noneLed.restoreTarget();
    assert.deepEqual(none, { tab: null, pinned: false, state: 'none' });
    assert.equal(
      noneLed.current(),
      before,
      '无 pin 不动目标页（同一引用，不是重建的快照）'
    );
  });

  test('open_url 式追加的 pin 也参与 restoreTarget 的选择（focusedTabId 优先，否则首个）', async () => {
    const led = ledgerOf({
      tabs: [
        tab(50, 'https://first.com/x'),
        tab(51, 'https://second.com/x', { title: '二页' }),
      ],
    });
    led.restoreFromRecord(
      [
        { tabId: 50, origin: 'https://first.com', title: 'T50' },
        { tabId: 51, origin: 'https://second.com', title: '二页' },
      ],
      null
    );

    const restored = await led.restoreTarget();
    assert.equal(restored.tab.id, 50, '焦点缺失时回落到首个 pin（50）');

    led.restoreFromRecord(
      [
        { tabId: 50, origin: 'https://first.com', title: 'T50' },
        { tabId: 51, origin: 'https://second.com', title: '二页' },
      ],
      51
    );
    const focused = await led.restoreTarget();
    assert.equal(focused.tab.id, 51, 'focusedTabId 命中优先于列表顺序');
  });
});

describe('跨会话锁（tabLocks 模块单例：跨 runtime 共享）', () => {
  test('acquireLocks 占住全部 pin 的 tabId；自己的锁不算「别人占着」', () => {
    const led = ledgerOf({ initialTab: tab(60, 'https://a.com/x') });
    led.pickTab(tab(60, 'https://a.com/x'));

    led.acquireLocks();
    assert.equal(led.isLockedByOther(60), false, '持有者本人放行');
    assert.equal(led.isLockedByOther(null), false, '无目标页时谈不上被锁');
  });

  test('另一个 runtime 的在途会话占着页 → isLockedByOther true；先占者优先', () => {
    const first = ledgerOf({ initialTab: tab(61, 'https://a.com/x') });
    first.pickTab(tab(61, 'https://a.com/x'));
    const second = ledgerOf({ initialTab: tab(61, 'https://a.com/x') });
    second.pickTab(tab(61, 'https://a.com/x'));

    first.acquireLocks();
    assert.equal(
      second.isLockedByOther(61),
      true,
      'second 看到的是 first 的锁 —— 守卫据此拒写'
    );

    // second 的 acquire 不得覆盖 first 的锁（先占者优先）
    second.acquireLocks();
    assert.equal(second.isLockedByOther(61), true);
    first.releaseLocks();
    // first 释放后锁没了；second 的 acquire 之前没能登记，此刻无锁
    assert.equal(first.isLockedByOther(61), false);
  });

  test('releaseLocks 只释放自己的锁，别人的不动', () => {
    const a = ledgerOf({ initialTab: tab(62, 'https://a.com/x') });
    a.pickTab(tab(62, 'https://a.com/x'));
    const b = ledgerOf({ initialTab: tab(63, 'https://b.com/x') });
    b.pickTab(tab(63, 'https://b.com/x'));

    a.acquireLocks();
    b.acquireLocks();

    a.releaseLocks();
    assert.equal(a.isLockedByOther(62), false, '自己的锁没了');
    assert.equal(
      b.isLockedByOther(63),
      false,
      'b 自己的锁还在（a 的释放不波及别人）'
    );
    assert.equal(
      a.isLockedByOther(63),
      true,
      'a 看到 b 的锁仍然挂着 —— 释放是有边界的'
    );
    b.releaseLocks();
  });

  test('同 runtime 内多个 pin 一起占、一起放', () => {
    const led = ledgerOf();
    led.restoreFromRecord(
      [
        { tabId: 70, origin: 'https://a.com', title: 'A' },
        { tabId: 71, origin: 'https://b.com', title: 'B' },
      ],
      70
    );
    led.acquireLocks();
    assert.equal(led.isLockedByOther(70), false);
    assert.equal(led.isLockedByOther(71), false);
    led.releaseLocks();
    assert.equal(led.isLockedByOther(70), false);
    assert.equal(led.isLockedByOther(71), false);
  });
});
