import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { agentEvalInPage, raceTimeout } from './agentEvalInPage';

/**
 * 这个函数会被 executeScript 序列化后注入页面 MAIN world ——
 * 序列化版本的行为只有真机探针能全覆盖，这里钉住的是纯逻辑：
 * 包装形态、Promise 求值、序列化回退、报错形状。
 */
describe('agentEvalInPage —— 注入页面的求值包装（backlog T-29）', () => {
  test('表达式返回普通值：1+1 必须得到 "2"，不能再出现 fn()() 把值当函数调', async () => {
    const r = await agentEvalInPage('1+1');

    assert.deepEqual(r, { ok: true, value: '2', json: true });
  });

  test('对象字面量序列化成 JSON 回传', async () => {
    const r = await agentEvalInPage('({a: 1, b: "x"})');

    assert.deepEqual(r, { ok: true, value: '{"a":1,"b":"x"}', json: true });
  });

  test('返回 Promise 的代码要被 await 到（模型忘写 await 是常态）', async () => {
    const r = await agentEvalInPage(
      'new Promise((res) => setTimeout(() => res(7), 5))'
    );

    assert.deepEqual(r, { ok: true, value: '7', json: true });
  });

  test('IIFE（表达式形式的语句序列）正常求值', async () => {
    const r = await agentEvalInPage('(() => { const x = 2; return x * 3; })()');

    assert.deepEqual(r, { ok: true, value: '6', json: true });
  });

  test('undefined 返回值按字面量 "undefined" 回传，不走向字符串分支', async () => {
    const r = await agentEvalInPage('void 0');

    assert.deepEqual(r, { ok: true, value: 'undefined', json: true });
  });

  test('不可 JSON 序列化的顶层值（函数）退回 String()，json:false', async () => {
    const r = await agentEvalInPage('(() => 1)');

    assert.equal(r.ok, true);
    assert.equal(r.json, false);
    assert.equal(r.value, '() => 1');
  });

  test('对象里的函数属性会被 JSON.stringify 静默丢掉（已知行为，钉住）', async () => {
    const r = await agentEvalInPage('({ fn() {} })');

    assert.deepEqual(r, { ok: true, value: '{}', json: true });
  });

  test('两种形式都解析不了才报错：文案说明已尝试两种形式', async () => {
    // 注意不能用 while(true){} 当反例——语句形式能编译会真跑出 10s 超时
    const r = await agentEvalInPage('const const const');

    assert.equal(r.ok, false);
    assert.match(r.error, /表达式与语句两种形式都无法解析/);
  });

  test('语句形式（const 开头）直接可跑——T-38 的致病场景', async () => {
    // 旧实现必炸 Unexpected token 'const'，模型只能碰运气包 IIFE
    const r = await agentEvalInPage('const x = 2;\nreturn x * 3;');

    assert.deepEqual(r, { ok: true, value: '6', json: true });
  });

  test('语句形式支持顶层 await', async () => {
    const r = await agentEvalInPage(
      'const v = await new Promise((res) => setTimeout(() => res(7), 5));\nreturn v;'
    );

    assert.deepEqual(r, { ok: true, value: '7', json: true });
  });

  test('语句形式跑完没 return：ok 但附「怎么拿数据」的指引', async () => {
    const r = await agentEvalInPage('const x = 2;\nx * 3;');

    assert.equal(r.ok, true);
    assert.equal(r.json, false);
    assert.match(r.value, /^undefined/);
    assert.match(r.value, /return|IIFE/);
  });

  test('表达式形式的 undefined 仍是干净的字面量，不带指引', async () => {
    const r = await agentEvalInPage('void 0');

    assert.deepEqual(r, { ok: true, value: 'undefined', json: true });
  });

  test('运行期异常归一成 error 观察值', async () => {
    const r = await agentEvalInPage('JSON.parse("{")');

    assert.equal(r.ok, false);
    assert.match(r.error, /代码执行出错：/);
  });
});

describe('raceTimeout —— 永不 settle 的 promise 的硬超时兜底（backlog T-30）', () => {
  test('promise 先完成：原样返回结果，不等待超时', async () => {
    const out = await raceTimeout(Promise.resolve('fast'), 5000, 'timeout');

    assert.equal(out, 'fast');
  });

  test('promise 挂死：ms 后返回兜底值，而不是 reject', async () => {
    const never = new Promise(() => {});
    const out = await raceTimeout(never, 20, {
      ok: false,
      error: '页面执行超时',
    });

    assert.deepEqual(out, { ok: false, error: '页面执行超时' });
  });

  test('超时后底层 promise 才 reject：不能炸 unhandledrejection，结果仍是兜底值', async () => {
    // 挂一个监听，进程级 unhandledRejection 会让 node:test 直接红
    let unhandled = null;
    const onUnhandled = (err) => {
      unhandled = err;
    };
    process.on('unhandledRejection', onUnhandled);

    const late = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('late')), 60);
    });
    const out = await raceTimeout(late, 10, 'timeout-fallback');

    assert.equal(out, 'timeout-fallback');

    // 给迟到的那次 reject 留出触发窗口，再确认它被吞掉了
    await new Promise((r) => {
      setTimeout(r, 120);
    });
    process.off('unhandledRejection', onUnhandled);

    assert.equal(unhandled, null, '迟到的 reject 必须被内部吞掉');
  });

  test('先 settle 的一侧必须 clearTimeout —— 悬空定时器会吊住进程/页面', async () => {
    const created = [];
    const cleared = [];
    const origSet = globalThis.setTimeout;
    const origClear = globalThis.clearTimeout;

    // 只盯我们自己那个 60s 定时器，别的来源的 timer 原样放行，免得误伤
    globalThis.setTimeout = (fn, ms, ...rest) => {
      const handle = origSet(fn, ms, ...rest);
      if (ms === 60000) created.push(handle);
      return handle;
    };
    globalThis.clearTimeout = (handle) => {
      if (created.includes(handle)) cleared.push(handle);
      return origClear(handle);
    };

    try {
      const out = await raceTimeout(Promise.resolve('fast'), 60000, 'timeout');

      assert.equal(out, 'fast');
      assert.equal(created.length, 1, 'raceTimeout 注册过超时定时器');
      assert.equal(
        cleared.length,
        1,
        '先完成时必须撤掉定时器 —— 实测不撤的话进程被吊满 60s'
      );
    } finally {
      globalThis.setTimeout = origSet;
      globalThis.clearTimeout = origClear;
    }
  });
});
