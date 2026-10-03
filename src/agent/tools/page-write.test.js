import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { queryElements, testJs } from './page-write';

/** 造一个假的 sendMessage，返回预设结果。 */
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

describe('query_elements', () => {
  test('把命中数量和样本整理成模型能直接用的文本', async () => {
    const s = stub({
      ok: true,
      count: 12,
      sample: [
        { tag: 'a', class: 'title', text: '第一条', visible: true, href: '/a' },
        { tag: 'a', class: 'title', text: '第二条', visible: false },
      ],
    });

    const r = await queryElements(
      { targetTab: { id: 7 }, sendMessage: s.send },
      { selector: 'a.title' }
    );

    assert.equal(r.status, 'ok');
    assert.match(r.payload, /命中 12 个/);
    assert.match(r.payload, /\[隐藏\]/);
    assert.match(r.payload, /→ \/a/);
    assert.equal(s.calls[0].type, 'agent:query');
    assert.equal(s.calls[0].tabId, 7);
  });

  test('命中 0 个要说清楚，别让模型以为是自己读错了', async () => {
    const s = stub({ ok: true, count: 0, sample: [] });
    const r = await queryElements(
      { targetTab: { id: 1 }, sendMessage: s.send },
      { selector: '.nope' }
    );

    assert.match(r.payload, /命中 0 个/);
  });

  test('没有目标页 / 空 selector 直接报错，不去打消息通道', async () => {
    const s = stub({ ok: true, count: 0, sample: [] });

    const a = await queryElements({ sendMessage: s.send }, { selector: 'div' });
    const b = await queryElements(
      { targetTab: { id: 1 }, sendMessage: s.send },
      { selector: '  ' }
    );

    assert.equal(a.status, 'error');
    assert.equal(b.status, 'error');
    assert.equal(s.calls.length, 0);
  });

  test('选择器不合法时把浏览器的原话带回去', async () => {
    const s = stub({ ok: false, error: '选择器不合法：bad' });
    const r = await queryElements(
      { targetTab: { id: 1 }, sendMessage: s.send },
      { selector: '###' }
    );

    assert.equal(r.status, 'error');
    assert.match(r.payload, /选择器不合法/);
  });
});

describe('test_js', () => {
  test('成功时回传返回值', async () => {
    const s = stub({ ok: true, value: '["甲","乙"]', json: true });
    const r = await testJs(
      { targetTab: { id: 3 }, sendMessage: s.send },
      {
        code: 'Array.from(document.querySelectorAll("li")).map(n => n.innerText)',
      }
    );

    assert.equal(r.status, 'ok');
    assert.match(r.payload, /\[/);
    assert.equal(s.calls[0].type, 'agent:run-js');
    assert.equal(s.calls[0].tabId, 3);
  });

  test('无法 JSON 序列化时明说，别让模型以为是页面返回的', async () => {
    const s = stub({ ok: true, value: '[object HTMLDivElement]', json: false });
    const r = await testJs(
      { targetTab: { id: 3 }, sendMessage: s.send },
      { code: 'document.body' }
    );

    assert.match(r.payload, /无法序列化/);
  });

  test('页面里抛错要原样带回，模型才能照着改', async () => {
    const s = stub({ ok: false, error: '代码执行出错：x is not defined' });
    const r = await testJs(
      { targetTab: { id: 3 }, sendMessage: s.send },
      { code: 'x.y()' }
    );

    assert.equal(r.status, 'error');
    assert.match(r.payload, /x is not defined/);
  });

  test('通道抛异常也兜住，不让整个对话崩掉', async () => {
    const s = stub(new Error('Extension context invalidated'));
    const r = await testJs(
      { targetTab: { id: 3 }, sendMessage: s.send },
      { code: '1' }
    );

    assert.equal(r.status, 'error');
    assert.match(r.payload, /Extension context invalidated/);
  });

  test('没有目标页绝不执行', async () => {
    const s = stub({ ok: true, value: '1', json: true });
    const r = await testJs({ sendMessage: s.send }, { code: '1' });

    assert.equal(r.status, 'error');
    assert.equal(s.calls.length, 0);
  });
});
