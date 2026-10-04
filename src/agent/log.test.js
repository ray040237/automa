import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createAgentLog, noopLog } from './log';

describe('createAgentLog —— agent 全链路日志', () => {
  /** 收集调用的假 sink：info/warn/error 分流可断言 */
  function fakeSink() {
    const calls = [];
    const fn =
      (level) =>
      (...args) =>
        calls.push({ level, args });
    return { calls, info: fn('info'), warn: fn('warn'), error: fn('error') };
  }

  test('常规打点走 info，带 [agent] 前缀，data 原样透传', () => {
    const sink = fakeSink();
    const log = createAgentLog({ sink });

    log('tool.call', { name: 'test_js' });

    assert.equal(sink.calls.length, 1);
    assert.equal(sink.calls[0].level, 'info');
    assert.equal(sink.calls[0].args[0], '[agent] tool.call');
    assert.deepEqual(sink.calls[0].args[1], { name: 'test_js' });
  });

  test('warn / error 走对应级别的 sink 方法', () => {
    const sink = fakeSink();
    const log = createAgentLog({ sink });

    log.warn('page.timeout', { tabId: 7 });
    log.error('stream.error', { httpStatus: 429 });

    assert.equal(sink.calls[0].level, 'warn');
    assert.equal(sink.calls[1].level, 'error');
  });

  test('无 data 时只打一行，不传 undefined', () => {
    const sink = fakeSink();
    const log = createAgentLog({ sink });

    log('turn.start');

    assert.equal(sink.calls[0].args.length, 1);
  });

  test('环形缓冲封顶：容量 3，进 5 条只留最新 3 条', () => {
    const log = createAgentLog({ sink: fakeSink(), ringSize: 3 });

    for (let i = 0; i < 5; i += 1) log('e' + i);

    assert.equal(log.ring.length, 3);
    assert.deepEqual(
      log.ring.map((e) => e.event),
      ['e2', 'e3', 'e4'],
      '最旧的被挤掉，最新在尾'
    );
  });

  test('ring 条目带时间戳与级别，has() 可断言事件是否出现过', () => {
    let clock = 100;
    const now = () => {
      clock += 1;
      return clock;
    };
    const log = createAgentLog({ sink: fakeSink(), now });

    log('a');
    log.warn('b');

    assert.equal(log.ring[0].t, 101);
    assert.equal(log.ring[0].level, 'info');
    assert.equal(log.ring[1].level, 'warn');
    assert.equal(log.has('a'), true);
    assert.equal(log.has('never'), false);
  });

  test('sink 缺 warn/error 方法时降级到 info，不抛', () => {
    const calls = [];
    const sink = { info: (...args) => calls.push(args) };
    const log = createAgentLog({ sink });

    assert.doesNotThrow(() => log.error('boom', { x: 1 }));
    assert.equal(calls.length, 1);
  });

  test('noopLog 形状齐全且零输出', () => {
    assert.equal(typeof noopLog, 'function');
    assert.equal(typeof noopLog.warn, 'function');
    assert.equal(typeof noopLog.error, 'function');
    assert.deepEqual(noopLog.ring, []);
    assert.equal(noopLog.has('x'), false);
    assert.doesNotThrow(() => {
      noopLog('a');
      noopLog.warn('b');
      noopLog.error('c');
    });
  });
});
