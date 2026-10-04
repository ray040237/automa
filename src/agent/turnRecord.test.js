import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accumulateUsage,
  buildTurnRecord,
  createCheckpointSaver,
  pruneEphemeralEvents,
} from './turnRecord';
import { AGENT_EVENTS } from './events';

test('pruneEphemeralEvents：只剪 THINKING，其余原样保序', () => {
  const events = [
    { kind: AGENT_EVENTS.START },
    { kind: AGENT_EVENTS.THINKING, text: '...' },
    { kind: AGENT_EVENTS.TEXT_DELTA, text: 'hi' },
    { kind: AGENT_EVENTS.THINKING, text: '...' },
    { kind: AGENT_EVENTS.DONE },
  ];
  const out = pruneEphemeralEvents(events);
  assert.deepEqual(
    out.map((e) => e.kind),
    [AGENT_EVENTS.START, AGENT_EVENTS.TEXT_DELTA, AGENT_EVENTS.DONE]
  );
  assert.equal(events.length, 5, '不改写入参');
});

test('pruneEphemeralEvents：空历史与缺字段输入健壮', () => {
  assert.deepEqual(pruneEphemeralEvents([]), []);
  assert.deepEqual(pruneEphemeralEvents(undefined), []);
  assert.deepEqual(pruneEphemeralEvents([null, { kind: 'x' }]), [
    { kind: 'x' },
  ]);
});

test('accumulateUsage：正常累加，usage 缺席按 0 计', () => {
  assert.deepEqual(
    accumulateUsage({ input: 10, output: 20 }, { input: 5, output: 7 }),
    { input: 15, output: 27 }
  );
  assert.deepEqual(
    accumulateUsage({ input: 10, output: 20 }, undefined),
    { input: 10, output: 20 },
    'provider 不回 usage 字段时本轮不算负数也不清零'
  );
  assert.deepEqual(
    accumulateUsage({ input: 10, output: 20 }, { input: 3 }),
    { input: 13, output: 20 },
    '部分字段缺失按 0 视'
  );
  assert.deepEqual(accumulateUsage(null, { input: 1, output: 2 }), {
    input: 1,
    output: 2,
  });
});

test('createCheckpointSaver：schedule 合并多次调用为一次 save', async () => {
  let saves = 0;
  const saver = createCheckpointSaver({
    buildRecord: () => ({ events: [] }),
    save: async () => {
      saves += 1;
    },
    delayMs: 20,
  });

  saver.schedule();
  saver.schedule();
  saver.schedule();
  await new Promise((r) => {
    setTimeout(r, 80);
  });
  assert.equal(saves, 1, 'debounce 应合并成一次');
});

test('createCheckpointSaver：flush 立即落一次，cancel 丢弃未 flush 的', async () => {
  let saves = 0;
  const saver = createCheckpointSaver({
    buildRecord: () => ({}),
    save: async () => {
      saves += 1;
    },
    delayMs: 50,
  });

  saver.schedule();
  await saver.flush();
  assert.equal(saves, 1);

  saver.schedule();
  saver.cancel();
  await new Promise((r) => {
    setTimeout(r, 120);
  });
  assert.equal(saves, 1, 'cancel 后不应再有在途 save');
});

test('createCheckpointSaver：save 失败只 logWarn 不抛', async () => {
  const warns = [];
  const saver = createCheckpointSaver({
    buildRecord: () => ({}),
    save: async () => {
      throw new Error('磁盘满');
    },
    delayMs: 10,
    logWarn: (err) => warns.push(err),
  });

  saver.schedule();
  await new Promise((r) => {
    setTimeout(r, 60);
  });
  assert.equal(warns.length, 1);
  assert.equal(warns[0].message, '磁盘满');
});

test('buildTurnRecord：键集合单一定义，缺省值正确', () => {
  const rec = buildTurnRecord({
    id: 's1',
    workflowId: 'wf1',
    createdAt: 1000,
    events: [{ kind: 'x' }],
    pins: [{ tabId: 1 }],
    focusedTabId: 1,
    usage: { input: 3, output: 4 },
    now: 2000,
  });
  assert.deepEqual(rec, {
    id: 's1',
    workflowId: 'wf1',
    status: 'active',
    createdAt: 1000,
    lastAccessedAt: 2000,
    events: [{ kind: 'x' }],
    pins: [{ tabId: 1 }],
    focusedTabId: 1,
    usage: { input: 3, output: 4 },
  });
  assert.ok(!('title' in rec), 'title 不在收尾构造里——走 patchTitle');

  const minimal = buildTurnRecord({ id: 's2', now: 3000 });
  assert.equal(minimal.createdAt, 3000, '首轮 createdAt 回落到 now');
  assert.equal(minimal.lastAccessedAt, 3000);
  assert.equal(minimal.focusedTabId, null);
  assert.deepEqual(minimal.usage, { input: 0, output: 0 });
});
