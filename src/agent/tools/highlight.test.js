/**
 * `highlightSelector` 的行为测试（T-139）。
 *
 * 这条工具的实现此前零测试命中 —— 全仓 `grep highlightSelector` 只在
 * `tools/index.js` 的外壳里（import / `defineTool` 包装 / 调用），
 * 没有任何测试文件引用它。**不是测不了**，同族的 `queryElements` /
 * `testJs` 在 `page-write.test.js` 里各有几条测试、夹具现成。
 *
 * 5 个分支每个都在给模型回话，回错模型就原地打转。所以下面每条都钉一个
 * 具体的话术分支，不是为了覆盖率。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { highlightSelector } from './highlight';

/**
 * 造一个假的 sendMessage，记录发出的消息并返回预设结果。
 * 照抄 `page-write.test.js` 的 `stub` —— 那两个函数走的是同一条通道。
 */
const stub = (res) => {
  const calls = [];

  return {
    calls,
    send: async (msg) => {
      calls.push(msg);

      if (res instanceof Error) throw res;

      return res;
    },
  };
};

describe('highlight_selector', () => {
  test('成功时回「标出 N 个 / 共命中 M 个」，并打对通道与 tabId', async () => {
    const s = stub({ ok: true, highlighted: 3, count: 12 });

    const r = await highlightSelector(
      { targetTab: { id: 7 }, sendMessage: s.send },
      { selector: 'a.title' }
    );

    assert.equal(r.status, 'ok');
    // 两个数字是不同含义：highlighted = 实际描了边框的（受 limit 截断），
    // count = 选择器总共命中多少。混成一个模型就会以为页面元素变少了。
    assert.match(r.payload, /已在页面上标出 3 个/);
    assert.match(r.payload, /共命中 12 个/);

    assert.equal(s.calls[0].type, 'agent:highlight');
    assert.equal(s.calls[0].tabId, 7);
    assert.equal(s.calls[0].selector, 'a.title');
  });

  test('T-139：命中 0 个时 status 必须是 ok，不是 error', async () => {
    // 这条最容易在重构里被改坏，而且改坏了不报错。
    //
    // 「高亮成功执行了，但页面上没匹配到元素」是**页面事实**，不是工具失败。
    // 返回 error 的话，模型会以为通道坏了或参数非法，于是改 selector 重试
    // —— 而正确的下一步是「先 read_page / query_elements 看看页面长什么样」。
    // 同款设计见 queryElements 的「命中 0 个要说清楚，别让模型以为是自己
    // 读错了」（page-write.test.js:45-53）。
    const s = stub({ ok: true, highlighted: 0, count: 0 });

    const r = await highlightSelector(
      { targetTab: { id: 1 }, sendMessage: s.send },
      { selector: '.nope' }
    );

    assert.equal(
      r.status,
      'ok',
      '命中 0 个是页面事实不是工具失败 —— 改成 error 会让模型无意义地重试'
    );
    assert.match(r.payload, /没有高亮任何元素/);
    // 把原 selector 带回去，模型才知道该改哪个
    assert.match(r.payload, /\.nope/);
  });

  test('limit 与 durationMs 有默认值，也接受显式传值', async () => {
    const d = stub({ ok: true, highlighted: 1, count: 1 });

    await highlightSelector(
      { targetTab: { id: 1 }, sendMessage: d.send },
      { selector: 'div' }
    );
    assert.equal(d.calls[0].limit, 10, '默认 limit=10');
    assert.equal(d.calls[0].durationMs, 4000, '默认 durationMs=4000');

    const c = stub({ ok: true, highlighted: 1, count: 1 });
    await highlightSelector(
      { targetTab: { id: 1 }, sendMessage: c.send },
      { selector: 'div', limit: 3, durationMs: 500 }
    );
    assert.equal(c.calls[0].limit, 3, '显式 limit 不被默认值盖掉');
    assert.equal(c.calls[0].durationMs, 500);
  });

  test('没有目标页 / 空 selector 直接报错，不去打消息通道', async () => {
    // 白跑一趟通道既慢又可能真的改到别人的页面 —— 没有 tab 就该立刻退。
    const s = stub({ ok: true, highlighted: 1, count: 1 });

    const a = await highlightSelector(
      { sendMessage: s.send },
      { selector: 'div' }
    );
    const b = await highlightSelector(
      { targetTab: { id: 1 }, sendMessage: s.send },
      { selector: '   ' }
    );
    const c = await highlightSelector(
      { targetTab: { id: 0 }, sendMessage: s.send },
      { selector: 'div' }
    );

    assert.equal(a.status, 'error');
    assert.match(a.payload, /没有确定目标页/);
    assert.equal(b.status, 'error');
    assert.match(b.payload, /selector 不能为空/);
    assert.equal(c.status, 'error', 'tabId=0 视为没有目标页');
    assert.equal(s.calls.length, 0, '这三个都不该打通道');
  });

  test('通道返回 ok:false 时把浏览器的原话带回去，别吞成「高亮失败。」', async () => {
    // 吞掉原话的话，模型只知道「失败了」，不知道是选择器不合法还是页面没注入
    // content script —— 两种情况的正确下一步完全不同。
    const s = stub({ ok: false, error: '页面尚未加载完' });

    const r = await highlightSelector(
      { targetTab: { id: 1 }, sendMessage: s.send },
      { selector: 'div' }
    );

    assert.equal(r.status, 'error');
    assert.match(r.payload, /页面尚未加载完/);
    assert.ok(!/高亮失败。$/.test(r.payload), '原话被吞掉了：' + r.payload);
  });

  test('ok:false 且没有 error 字段时兜一句人话，不是 undefined', async () => {
    const s = stub({ ok: false });

    const r = await highlightSelector(
      { targetTab: { id: 1 }, sendMessage: s.send },
      { selector: 'div' }
    );

    assert.equal(r.status, 'error');
    assert.match(r.payload, /高亮失败。/);
  });

  test('sendMessage 抛异常时降级成「高亮失败：<原因>」，不把栈抛给模型', async () => {
    // 抛上去的话 loop 会把它转成 error 观察值，但栈对模型毫无意义，
    // 而「通道连不上」这句话才是它能据此换一种做法的东西。
    const s = stub(new Error('Could not establish connection'));

    const r = await highlightSelector(
      { targetTab: { id: 1 }, sendMessage: s.send },
      { selector: 'div' }
    );

    assert.equal(r.status, 'error');
    assert.match(r.payload, /高亮失败：/);
    assert.match(r.payload, /Could not establish connection/);
  });

  test('T-122：frame 参数透传，不给就不带这个键', async () => {
    // T-122 给 runInPage 加了 frame 支持，这条通道同样有 frame 键。
    // 透传漏掉是静默失败：模型明确说了查 iframe，工具却高亮了主 frame，
    // 页面上看不到变化，模型只会以为自己看错了。
    const withFrame = stub({ ok: true, highlighted: 1, count: 1 });

    await highlightSelector(
      { targetTab: { id: 1 }, sendMessage: withFrame.send },
      { selector: 'div', frame: 'all' }
    );
    assert.equal(withFrame.calls[0].frame, 'all');

    const without = stub({ ok: true, highlighted: 1, count: 1 });
    await highlightSelector(
      { targetTab: { id: 1 }, sendMessage: without.send },
      { selector: 'div' }
    );
    assert.ok(
      !('frame' in without.calls[0]),
      '没传 frame 就不该造出这个键：background 侧按缺省处理（top）'
    );
  });
});
