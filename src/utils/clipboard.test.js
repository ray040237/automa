/* eslint-env node, es2022 -- 跑在 Node 里，要用到 globalThis */
/**
 * T-250 回归守卫。
 *
 * 元素选择器面板（content script，注入到用户正在浏览的页面）曾经裸调
 * `navigator.clipboard.writeText(...)`。http 页面上 `navigator.clipboard`
 * 根本不存在（secure-context-only），于是在读 `writeText` 这一步同步抛
 * `TypeError: Cannot read properties of undefined (reading 'writeText')`，
 * 而后面挂的 `.catch()` 因为 Promise 压根没生成，永远够不着 —— 兜底形同虚设。
 *
 * 下面第二条用例把 `navigator.clipboard` 设为不存在来钉住这件事：谁要是把
 * `copyTextToClipboard` 改回裸调，这条会当场红。
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { copyTextToClipboard } from './clipboard';

const originalNavigator = globalThis.navigator;

/** clipboard 传 undefined 即模拟「非安全上下文，属性不存在」。 */
function stubNavigator(clipboard) {
  Object.defineProperty(globalThis, 'navigator', {
    value: clipboard ? { clipboard } : {},
    configurable: true,
    writable: true,
  });
}

function stubDocument() {
  const calls = { appended: [], removed: [], execCommand: [] };

  globalThis.document = {
    createElement: () => ({
      value: '',
      style: {},
      focus() {},
      select() {},
    }),
    body: {
      appendChild: (el) => calls.appended.push(el),
      removeChild: (el) => calls.removed.push(el),
    },
    execCommand: (cmd) => {
      calls.execCommand.push(cmd);
      return true;
    },
  };

  return calls;
}

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: originalNavigator,
    configurable: true,
    writable: true,
  });
  delete globalThis.document;
});

describe('copyTextToClipboard', () => {
  it('clipboard 可用时走 writeText，不碰兜底', async () => {
    const written = [];
    stubNavigator({
      writeText: (text) => {
        written.push(text);
        return Promise.resolve();
      },
    });
    const dom = stubDocument();

    const result = await copyTextToClipboard('div#target');

    assert.strictEqual(result, true);
    assert.deepStrictEqual(written, ['div#target']);
    assert.deepStrictEqual(dom.execCommand, [], '不该走 execCommand 兜底');
    assert.deepStrictEqual(dom.appended, [], '不该插 textarea');
  });

  it('非安全上下文（navigator.clipboard 不存在）不抛错，走 execCommand 兜底', async () => {
    stubNavigator(undefined);
    const dom = stubDocument();

    const result = await copyTextToClipboard('div#target');

    assert.strictEqual(result, true);
    assert.deepStrictEqual(dom.execCommand, ['copy'], '必须落到 execCommand');
    assert.strictEqual(dom.appended.length, 1, '要插一个临时 textarea');
    assert.strictEqual(dom.appended[0].value, 'div#target');
    assert.strictEqual(dom.removed.length, 1, '用完要摘掉，不能留在页面上');
  });

  it('writeText 失败时照旧 reject', async () => {
    stubNavigator({ writeText: () => Promise.reject(new Error('denied')) });
    stubDocument();

    // handlerClipboard 靠这个 reject 让工作流块报错，不能在这里吞掉
    await assert.rejects(copyTextToClipboard('x'), /denied/);
  });
});
