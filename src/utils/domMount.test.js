/* eslint-env node, es2022 -- 跑在 Node 里，要用到 globalThis */
/**
 * T-251 回归守卫。
 *
 * SVG 文档（image/svg+xml，含内嵌 SVG frame）里 document.body 与 document.head
 * 都是 null，只有 documentElement 在。直接 `document.body.appendChild(x)` 会抛
 * `TypeError: Cannot read properties of null (reading 'appendChild')`。
 *
 * 以前 content script 一片地方都是裸 `document.body.appendChild`，在 SVG 页面上
 * 要么崩、要么被 try/catch 吞成静默失效（选择器选不了、Alt+K 没反应、样式丢失）。
 * 现在统一走 `appendToDocument`；下面第 2、3 条把 null body 钉死。
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { appendToDocument, getDocumentMount } from './domMount';

function stubDocument({ body, documentElement }) {
  globalThis.document = { body, documentElement };
}

/** 假的元素/节点：记录 appendChild 调用，供断言比对。 */
function fakeNode(tag) {
  return {
    tagName: tag,
    parentNode: null,
    appendChild(child) {
      child.parentNode = this;
      return child;
    },
    appendChildCalled: 0,
  };
}

afterEach(() => {
  delete globalThis.document;
});

describe('SVG / 非 HTML 文档下的挂载（T-251）', () => {
  it('普通 HTML 文档：照旧挂到 body', () => {
    const body = fakeNode('BODY');
    const docEl = fakeNode('HTML');
    stubDocument({ body, documentElement: docEl });

    const el = fakeNode('DIV');
    appendToDocument(el);

    assert.strictEqual(el.parentNode, body, '必须挂在 body 上');
    assert.strictEqual(getDocumentMount(), body);
    assert.strictEqual(docEl.appendChildCalled, 0, '不该碰 documentElement');
  });

  it('SVG 文档（body 为 null）：不抛错，挂到 documentElement', () => {
    const docEl = fakeNode('SVG');
    stubDocument({ body: null, documentElement: docEl });

    const el = fakeNode('STYLE');
    assert.doesNotThrow(
      () => appendToDocument(el),
      'SVG 文档里不许抛 TypeError'
    );
    assert.strictEqual(el.parentNode, docEl, '必须退回 documentElement');
    assert.strictEqual(getDocumentMount(), docEl);
  });

  it('head 也为 null（injectAppStyles 的查询路径）时同样有挂载点可用', () => {
    const docEl = fakeNode('SVG');
    stubDocument({ body: null, documentElement: docEl });

    // injectAppStyles.js 的写法：(document.head || document.documentElement)
    const mount =
      globalThis.document.head || globalThis.document.documentElement;
    assert.strictEqual(mount, docEl);
  });
});
