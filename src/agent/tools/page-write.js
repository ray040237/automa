/**
 * 写类工具：会真正影响页面，所以全部要过确认门。
 *
 * P0 声明过「只读、工具以后再说」。P1 补上这两个，目的不是让 agent 什么都能干，
 * 而是让它能自己验证：写完立刻跑一遍看结果对不对，
 * 比直接写进工作流里、让用户去发现跑不通要可靠得多。
 *
 * 仍然不许做的：任何持久化。agent 永远不碰 workflowStore。
 */

import { countLines } from '../confirm';
import { defineTool } from './define';

/**
 * 试跑一段 JS。只在目标页的 MAIN world 里跑，跑完即弃。
 *
 * @param {Object} ctx
 * @param {Object} ctx.targetTab
 * @param {Function} ctx.sendMessage 注入的消息通道（测试时替换）
 * @param {Object} params
 * @param {string} params.code
 * @returns {Promise<Object>}
 */
export async function testJs(ctx, params) {
  const { targetTab, sendMessage } = ctx;

  if (!targetTab || !targetTab.id) {
    return { status: 'error', payload: '没有确定目标页。' };
  }

  try {
    const res = await sendMessage({
      type: 'agent:run-js',
      tabId: targetTab.id,
      code: params.code,
      ...(params.frame ? { frame: params.frame } : {}),
    });

    if (!res || !res.ok) {
      const why = (res && res.error) || '执行没有返回结果（页面可能在跳转）。';

      return { status: 'error', payload: why };
    }

    const tail = res.json ? '' : '（无法序列化成 JSON，按字符串展示）';

    return { status: 'ok', payload: '返回：' + res.value + tail };
  } catch (err) {
    const why = (err && err.message) || String(err);

    return { status: 'error', payload: '执行失败：' + why };
  }
}
/**
 * 查选择器命中了几个、命中的是什么。
 *
 * 这是最该给模型用的工具：写选择器之前先查一下，
 * 能避免绝大多数「看起来对其实错」的选择器。
 *
 * @param {Object} ctx
 * @param {Object} ctx.targetTab
 * @param {Function} ctx.sendMessage
 * @param {Object} params
 * @param {string} params.selector
 * @param {number} [params.limit]
 * @returns {Promise<Object>}
 */
export async function queryElements(ctx, params) {
  const { targetTab, sendMessage } = ctx;

  if (!targetTab || !targetTab.id) {
    return { status: 'error', payload: '没有确定目标页。' };
  }

  if (!params.selector || !params.selector.trim()) {
    return { status: 'error', payload: 'selector 不能为空。' };
  }

  try {
    const res = await sendMessage({
      type: 'agent:query',
      tabId: targetTab.id,
      selector: params.selector,
      limit: params.limit || 5,
      ...(params.frame ? { frame: params.frame } : {}),
    });

    if (!res || !res.ok) {
      const why = (res && res.error) || '查询失败。';

      return { status: 'error', payload: why };
    }

    if (res.count === 0) {
      const msg =
        '命中 0 个：' + params.selector + ' 在当前页面上找不到任何元素。';

      return { status: 'ok', payload: msg };
    }

    const lines = res.sample.map((el, i) =>
      [
        i +
          1 +
          '. ' +
          (el.frame !== undefined ? '[frame ' + el.frame + '] ' : '') +
          '<' +
          el.tag +
          (el.id ? ' #' + el.id : '') +
          (el.class ? '.' + el.class : '') +
          '> ' +
          (el.visible ? '' : '[隐藏] ') +
          (el.text || '') +
          (el.href ? ' → ' + el.href : '') +
          (el.inputType ? ' [input type=' + el.inputType + ']' : ''),
      ].join('')
    );

    const head =
      '命中 ' +
      res.count +
      ' 个：' +
      params.selector +
      (res.frames !== undefined ? '（跨 ' + res.frames + ' 个 frame）' : '');

    return {
      status: 'ok',
      payload: [head, '前 ' + lines.length + ' 个：', lines.join('\n')].join(
        '\n'
      ),
    };
  } catch (err) {
    const why = (err && err.message) || String(err);

    return { status: 'error', payload: '查询失败：' + why };
  }
}

/**
 * 工具定义。execute 只做参数校验和转发，真正的执行在上面的纯函数里 ——
 * 这样单测不必构造任何浏览器环境。
 */
export const testJsTool = defineTool({
  name: 'test_js',
  class: 'write',
  group: 'page',
  ctx: ['targetTab', 'sendMessage'],
  confirmDetail(args) {
    const code = args ? String(args.code ?? '') : '';

    return { kind: 'code', lines: countLines(code), detail: code };
  },
  description:
    '在目标页里试跑一段 JS 并回传结果。只读式的观察代码可以放心试；' +
    '不要用它点击、提交或导航。写完一段代码先用它验证，比直接写进工作流可靠。',
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description:
          '要试跑的 JS。支持两种形式：表达式（如 JSON.stringify(...) 或 ' +
          '(() => { … })()），或语句序列（const/let 等，数据用 return 带回，' +
          '支持顶层 await）。要用页面 DOM 就直接写 document.xxx。' +
          '返回可 JSON 序列化的值最稳妥。',
      },
      frame: {
        type: 'string',
        description:
          '在哪个 frame 里跑。默认 top=只主 frame；传 frameId 数字=指定 frame；all 取第一个有结果的 frame。',
      },
    },
    required: ['code'],
  },
  async execute(args, ctx) {
    return testJs(ctx, args || {});
  },
});

export const queryElementsTool = defineTool({
  name: 'query_elements',
  class: 'read',
  group: 'page',
  ctx: ['targetTab', 'sendMessage'],
  description:
    '查一个 CSS selector 在目标页命中了几个、命中的是哪些元素（标签/类名/文本/可见性）。' +
    '写完 selector 先查一次，别直接写进工作流。',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: '要查的 CSS selector。' },
      limit: {
        type: 'number',
        description: '最多回传几个样本，默认 5，最多 20。',
      },
      frame: {
        type: 'string',
        description:
          '在哪个 frame 里查。默认 top=只主 frame；all=所有 frame（命中数跨 frame 合并，样本带 frame 来源）；传 frameId 数字=指定 frame。',
      },
    },
    required: ['selector'],
  },
  async execute(args, ctx) {
    return queryElements(ctx, args || {});
  },
});
