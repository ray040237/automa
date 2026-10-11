/**
 * 在目标页上高亮一批元素。
 *
 * 为什么它归到 write（要过确认门）而不是 read：
 * 它确实会改用户正在看的页面。虽然只是描边、几秒后自动撤掉、不碰任何数据，
 * 但「模型每说一句就改一次你的页面」本身就该由用户点头 ——
 * 而且确认卡片上直接显示选择器，用户点「允许」正好是在回答「你说的是这个吗」。
 * 把它算成 read 看着更省事，但那是拿一致性换方便。
 *
 * @param {Object} ctx
 * @param {Object} ctx.targetTab
 * @param {Function} ctx.sendMessage
 * @param {Object} params
 * @param {string} params.selector
 * @param {number} [params.limit]
 * @param {number} [params.durationMs]
 * @returns {Promise<Object>}
 */

import { toolOk, toolError, noTargetTabError, callChannel } from './define';

export async function highlightSelector(ctx, params) {
  const { targetTab, sendMessage } = ctx;

  if (!targetTab || !targetTab.id) {
    return noTargetTabError();
  }

  if (!params.selector || !params.selector.trim()) {
    return toolError('selector 不能为空。');
  }

  const out = await callChannel(
    sendMessage,
    {
      type: 'agent:highlight',
      tabId: targetTab.id,
      selector: params.selector,
      limit: params.limit || 10,
      durationMs: params.durationMs || 4000,
      ...(params.frame ? { frame: params.frame } : {}),
    },
    { fallback: '高亮失败。', errorPrefix: '高亮失败：' }
  );

  if (!out.ok) return toolError(out.error);

  const { res } = out;

  if (res.highlighted === 0) {
    const msg =
      '没有高亮任何元素：' + params.selector + ' 在当前页面上匹配不到。';

    return toolOk(msg);
  }

  const head = `已在页面上标出 ${res.highlighted} 个（该选择器共命中 ${res.count} 个）。`;

  return toolOk(head);
}
