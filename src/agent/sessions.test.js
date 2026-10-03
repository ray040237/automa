import test from 'node:test';
import assert from 'node:assert';
import {
  SESSION_INDEX_KEY,
  createSessionId,
  createSessionStore,
  cropToTurns,
  indexEntryFromSession,
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
