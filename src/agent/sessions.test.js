import test from 'node:test';
import assert from 'node:assert';
import {
  SESSION_INDEX_KEY,
  createSessionId,
  createSessionStore,
  cropToTurns,
  indexEntryFromSession,
  sessionOptionLabel,
  sessionStorageKey,
  titleFromEvents,
} from './sessions';
import { AGENT_EVENTS } from './events';

/** 内存版 IO，形状与 configIO/sessionIO 一致 */
function memoryIO() {
  const data = new Map();
  return {
    data,
    get: async (k) => data.get(k),
    set: async (k, v) => data.set(k, v),
    remove: async (k) => data.delete(k),
  };
}

const userMsg = (t) => ({ kind: AGENT_EVENTS.USER_MESSAGE, text: t, wire: t });
const delta = (t) => ({ kind: AGENT_EVENTS.TEXT_DELTA, text: t });

test('createSessionId 生成非空且互不相同的 id', () => {
  const a = createSessionId();
  const b = createSessionId();
  assert.ok(a && b && a !== b);
});

test('titleFromEvents 取首条用户消息前缀，超长加省略号', () => {
  assert.equal(
    titleFromEvents([userMsg('帮我抓这个列表'), delta('好')]),
    '帮我抓这个列表'
  );
  assert.equal(titleFromEvents([]), '');
  const long = '一'.repeat(40);
  const t = titleFromEvents([userMsg(long)]);
  assert.equal(t.length, 24 + 1);
  assert.ok(t.endsWith('…'));
});

test('cropToTurns 按整轮裁剪，保留最近 N 轮且不拆散轮内事件', () => {
  const oneTurn = () => [userMsg('问'), delta('答一半'), delta('答完')];
  const events = [...oneTurn(), ...oneTurn(), ...oneTurn(), ...oneTurn()];

  const cropped = cropToTurns(events, 2);
  const users = cropped.filter((e) => e.kind === AGENT_EVENTS.USER_MESSAGE);
  assert.equal(users.length, 2);
  // 裁剪点必须落在 user-message 上（整轮边界），第一个事件就是用户消息
  assert.equal(cropped[0].kind, AGENT_EVENTS.USER_MESSAGE);
});

test('cropToTurns 轮数不足时原样返回', () => {
  const events = [userMsg('问'), delta('答')];
  assert.equal(cropToTurns(events, 20), events);
});

test('indexEntryFromSession 不带 events', () => {
  const entry = indexEntryFromSession({
    id: 's1',
    workflowId: 'wf1',
    title: 'T',
    status: 'active',
    createdAt: 1,
    events: [userMsg('x'), delta('y')],
  });
  assert.ok(!('events' in entry));
  assert.equal(entry.messageCount, 2);
});

/* ---------------- 会话下拉的选项文案（面板切换入口） ---------------- */

test('sessionOptionLabel 拼「标题 · MM-DD HH:mm」，时间取 lastAccessedAt', () => {
  // 本地时间构造，期望自己算而不是硬编码日期 —— 换时区也能跑
  const ts = new Date(2026, 9, 4, 9, 5).getTime();

  assert.equal(
    sessionOptionLabel({ id: 'a', title: '抓列表', lastAccessedAt: ts }),
    '抓列表 · 10-04 09:05'
  );
  assert.equal(
    sessionOptionLabel({ id: 'a', title: '抓列表', createdAt: ts }),
    '抓列表 · 10-04 09:05',
    '没有 lastAccessedAt 时退回 createdAt'
  );
});

test('sessionOptionLabel 缺字段时不出半截分隔符', () => {
  const ts = new Date(2026, 9, 4, 9, 5).getTime();

  // 标题空 → 用调用方给的兜底文案（文案由面板翻译）
  assert.equal(
    sessionOptionLabel(
      { id: 'a', title: '', lastAccessedAt: ts },
      '未命名会话'
    ),
    '未命名会话 · 10-04 09:05'
  );
  // 两个时间都没有（老索引条目）→ 只有标题，绝不能出现「 · 」
  assert.equal(
    sessionOptionLabel({ id: 'a', title: '抓列表' }),
    '抓列表',
    '缺时间时不能留下悬空的分隔符'
  );
  // 时间有、标题没有 → 只出时间，同样不带分隔符
  assert.equal(
    sessionOptionLabel({ id: 'a', lastAccessedAt: ts }),
    '10-04 09:05'
  );
  // 全空 / null 条目 → 兜底文案或空串，不炸
  assert.equal(sessionOptionLabel({}, '未命名会话'), '未命名会话');
  assert.equal(sessionOptionLabel(null), '');
  // 非法时间戳（NaN）当没有时间处理
  assert.equal(
    sessionOptionLabel({ id: 'a', title: 'T', lastAccessedAt: 'oops' }),
    'T'
  );
});

test('store 往返：save 后 load 原样读回，索引同步且不带 events', async () => {
  const io = memoryIO();
  const store = createSessionStore(io);

  await store.save({
    id: 's1',
    workflowId: 'wf1',
    status: 'active',
    createdAt: 111,
    lastAccessedAt: 222,
    events: [userMsg('帮我看看这个页面'), delta('好的')],
  });

  const rec = await store.load('s1');
  assert.equal(rec.events.length, 2);
  assert.equal(rec.title, '帮我看看这个页面');

  const index = await store.listIndex('wf1');
  assert.equal(index.length, 1);
  assert.equal(index[0].id, 's1');
  assert.ok(!('events' in index[0]));

  const raw = io.data.get(SESSION_INDEX_KEY);
  assert.ok(
    !JSON.stringify(raw).includes('untrusted_'),
    '索引里不能混进事件正文'
  );
});

test('listIndex 按 workflowId 过滤且 lastAccessedAt 降序', async () => {
  const io = memoryIO();
  const store = createSessionStore(io);

  await store.save({
    id: 'a',
    workflowId: 'wf1',
    createdAt: 1,
    lastAccessedAt: 100,
    events: [userMsg('a')],
  });
  await store.save({
    id: 'b',
    workflowId: 'wf2',
    createdAt: 2,
    lastAccessedAt: 300,
    events: [userMsg('b')],
  });
  await store.save({
    id: 'c',
    workflowId: 'wf1',
    createdAt: 3,
    lastAccessedAt: 200,
    events: [userMsg('c')],
  });

  const wf1 = await store.listIndex('wf1');
  assert.deepEqual(
    wf1.map((e) => e.id),
    ['c', 'a']
  );

  const all = await store.listIndex();
  assert.deepEqual(
    all.map((e) => e.id),
    ['b', 'c', 'a']
  );
});

test('save 同 id 更新而不是新增索引条目；load 不存在返回 null', async () => {
  const io = memoryIO();
  const store = createSessionStore(io);

  await store.save({
    id: 's1',
    workflowId: 'wf1',
    createdAt: 1,
    events: [userMsg('v1')],
  });
  await store.save({
    id: 's1',
    workflowId: 'wf1',
    createdAt: 1,
    events: [userMsg('v1'), userMsg('v2')],
  });

  const index = await store.listIndex('wf1');
  assert.equal(index.length, 1);
  assert.equal(index[0].messageCount, 2);

  assert.equal(await store.load('missing'), null);
});

test('remove 同时清掉索引与本体', async () => {
  const io = memoryIO();
  const store = createSessionStore(io);

  await store.save({
    id: 's1',
    workflowId: 'wf1',
    createdAt: 1,
    events: [userMsg('x')],
  });
  const removed = await store.remove('s1');

  assert.ok(removed, '返回被删的本体');
  assert.equal(await store.load('s1'), null);
  assert.equal((await store.listIndex()).length, 0);
});

/* ---------------- 标题回写通道 patchTitle（backlog T-35 + B1） ---------------- */

test('patchTitle 只改标题这一个字段，别的一律原样', async () => {
  const io = memoryIO();
  const store = createSessionStore(io);

  await store.save({
    id: 's1',
    workflowId: 'wf1',
    status: 'active',
    createdAt: 1,
    lastAccessedAt: 222,
    events: [
      userMsg('帮我抓列表'),
      delta('好'),
      userMsg('第二轮'),
      delta('嗯'),
    ],
    pins: [{ tabId: 7 }],
    focusedTabId: 7,
    usage: { input: 10, output: 20 },
  });
  const before = JSON.parse(JSON.stringify(await store.load('s1')));

  const patched = await store.patchTitle('s1', 'LLM 生成的标题');
  const after = JSON.parse(JSON.stringify(await store.load('s1')));

  assert.deepEqual(
    after,
    { ...before, title: 'LLM 生成的标题' },
    '除 title 外一个字段都不许动 —— 整记录 save 会把首轮 events 快照盖到第二轮上（B1）'
  );
  assert.equal(patched.title, 'LLM 生成的标题');
  assert.equal(
    after.lastAccessedAt,
    before.lastAccessedAt,
    '回写标题不算一次访问，不能顺手把会话顶到列表最前'
  );

  const idx = (await store.listIndex('wf1'))[0];
  assert.equal(
    idx.title,
    'LLM 生成的标题',
    '索引里的标题要跟着换，否则下拉还是旧的'
  );
  assert.ok(!('events' in idx), '索引条目仍然不带 events');
});

test('patchTitle 对空 id / 已删会话返回 null，绝不落出幽灵记录', async () => {
  const io = memoryIO();
  const store = createSessionStore(io);

  assert.equal(await store.patchTitle(null, 'x'), null, 'id 为空必须拒绝');
  assert.equal(await store.patchTitle(undefined, 'x'), null);
  assert.equal(await store.patchTitle('s1', ''), null, '标题为空没有可写的');
  assert.equal(await store.patchTitle('missing', 'x'), null, '会话已删就放弃');

  const keys = [...io.data.keys()];
  assert.ok(
    !keys.some((k) => k.includes('null')),
    `不许出现幽灵键，实际键：${keys}`
  );
  const index = io.data.get(SESSION_INDEX_KEY) || [];
  assert.ok(
    !index.some((e) => e.id === 'null' || e.id == null),
    '索引里不许有 id 为 null 的条目 —— 用户会看到一个点进去是空的会话'
  );
  assert.equal(
    await store.load('s1'),
    null,
    '不存在的会话不能因为一次标题回写被复活'
  );
  assert.ok(
    !io.data.has(sessionStorageKey('missing')),
    '更不许凭空造出一条只有标题的半截记录'
  );
});

test('patchTitle 与并发的第二轮 save 串行：回写不把 events 盖回第一轮', async () => {
  const data = new Map();
  let armed = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  // 读拿到「这一刻」的快照后卡住，给第二轮 save 腾出一个确定的落盘窗口
  const io = {
    data,
    get: async (k) => {
      if (!armed) return data.get(k);
      armed = false;
      const snapshot = data.get(k);
      await gate;
      return snapshot;
    },
    set: async (k, v) => data.set(k, v),
    remove: async (k) => data.delete(k),
  };

  const store = createSessionStore(io);
  const turn1 = [userMsg('帮我抓列表'), delta('好')];
  await store.save({
    id: 's1',
    workflowId: 'wf1',
    createdAt: 1,
    lastAccessedAt: 1,
    events: turn1,
  });

  armed = true;
  const patching = store.patchTitle('s1', 'LLM 生成的标题');
  const turn2 = store.save({
    id: 's1',
    workflowId: 'wf1',
    createdAt: 1,
    lastAccessedAt: 2,
    events: [...turn1, userMsg('第二轮'), delta('嗯')],
  });
  release();

  const [patched] = await Promise.all([patching, turn2]);
  assert.equal(patched.title, 'LLM 生成的标题', '回写本身必须写成');

  const rec = await store.load('s1');
  assert.equal(
    rec.events.length,
    4,
    '回写读到的是旧快照，若不与 save 串行就会把第二轮 events 盖回第一轮（B1 换窗口复发）'
  );
});
