/**
 * 标签页工具（P2 标签页定位）。
 *
 * 设计参照 pie-ai-agent 的 TAB_TOOLS，裁剪到三件：
 *   list_tabs  读：有哪些可注入的标签页
 *   focus_tab  读：把 agent 后续操作的目标切到某个 pin（不改用户浏览器视图）
 *   open_url   写：开一个新标签页并加入会话 pin（有真实副作用，过确认门）
 *
 * 红线：focus_tab 只改 agent 内部的目标指针，绝不 activate 用户的浏览器窗口；
 * 要让用户看到某个页，那是 activate_tab 的活，本版不做。
 *
 * 安全：open_url 只放行 http(s)。tabs.create 对 javascript: URL 的处理
 * 因浏览器而异，与其赌文档不如直接关死。
 */

import { originOf } from '../tab';

/**
 * 列出可注入的标签页，按窗口分组、最近访问在前。
 *
 * @param {Object} ctx
 * @param {Function} ctx.listTabs
 * @returns {Promise<Object>}
 */
export async function listTabs(ctx) {
  let groups;
  try {
    groups = await ctx.listTabs();
  } catch (err) {
    return {
      status: 'error',
      payload: '读取标签页失败：' + ((err && err.message) || err),
    };
  }

  if (!groups || groups.length === 0) {
    return { status: 'ok', payload: '当前没有任何可作为目标页的标签页。' };
  }

  const lines = [];
  groups.forEach((g) => {
    lines.push('窗口 ' + g.windowId + ':');
    g.tabs.forEach((t) => {
      lines.push(
        '  - tabId ' + t.id + ' [' + (t.title || '(无标题)') + '] ' + t.url
      );
    });
  });

  return {
    status: 'ok',
    payload: '可操作的标签页（focus_tab 用 tabId）：\n' + lines.join('\n'),
  };
}

/**
 * 切换 agent 的操作焦点到某个标签页。
 * 生效时机是「下一个工具调用」——本调用只改指针。
 *
 * 目标页不在 pin 里时自动收进 pin（模型既然要点名它，意图就是明确的），
 * 不然面对「页开着但没 pin」的场景模型只能 open_url 开重复页。
 *
 * @param {Object} ctx
 * @param {() => Array<{tabId: number, origin: string, title?: string}>} ctx.pins
 *   T-43 ③：固定契约——pins 永远是 getter，调用方每次调它取最新数组。
 *   运行时（index.js toolCtx）与测试夹具都按这个形状传，不再兼容「直接传数组」。
 * @param {Function} ctx.addPin (pin) => Promise<void>
 * @param {Function} ctx.focusTab (tabId) => Promise<tab>
 */
export async function focusTab(ctx, params) {
  const tabId = params && params.tabId;

  if (typeof tabId !== 'number') {
    return {
      status: 'error',
      payload: 'tabId 必须是数字。先用 list_tabs 查。',
    };
  }

  if (typeof ctx.pins !== 'function') {
    return {
      status: 'error',
      payload: 'ctx.pins 契约错误：必须是 () => pins 的 getter。',
    };
  }
  const pins = ctx.pins() || [];

  try {
    // 不在 pin 里就先收进来 —— addPin 之后 focusTab 才有身份可比对
    const wasPinned = pins.some((p) => p.tabId === tabId);
    if (!wasPinned) {
      const t = await ctx.getTab(tabId);
      if (!t)
        return {
          status: 'error',
          payload: 'tabId ' + tabId + ' 不存在（页面可能已关闭）。',
        };
      await ctx.addPin({ tabId, origin: originOf(t.url), title: t.title });
    }

    const tab = await ctx.focusTab(tabId);
    return {
      status: 'ok',
      payload:
        '已把操作焦点切到 [' +
        (tab.title || tabId) +
        '] ' +
        tab.url +
        (wasPinned ? '。' : '（已自动加入本会话 pin）') +
        '下一个工具调用起生效。',
    };
  } catch (err) {
    return {
      status: 'error',
      payload: '切换失败：' + ((err && err.message) || err),
    };
  }
}

/**
 * 开一个 http(s) 新标签页（不抢焦点），成功后加入会话 pin 并切焦点过去。
 *
 * @param {Object} ctx
 * @param {Function} ctx.createTab (url) => Promise<{id, url, title?}>
 * @param {Function} ctx.addPin (pin) => void
 * @param {Function} ctx.focusTab
 */
export async function openUrl(ctx, params) {
  const raw = params && params.url;

  if (!raw || !raw.trim()) {
    return { status: 'error', payload: 'url 不能为空。' };
  }

  let url;
  try {
    url = new URL(String(raw).trim()).href;
  } catch {
    return { status: 'error', payload: 'url 不是合法的绝对地址：' + raw };
  }

  if (!/^https?:/.test(url)) {
    return {
      status: 'error',
      payload: '只允许 http/https 地址，拒绝 ' + url.slice(0, 60),
    };
  }

  let tab;
  try {
    tab = await ctx.createTab(url);
  } catch (err) {
    return {
      status: 'error',
      payload: '打开失败：' + ((err && err.message) || err),
    };
  }

  if (!tab || typeof tab.id !== 'number' || tab.id < 0) {
    return { status: 'error', payload: '浏览器没有返回有效标签页。' };
  }

  const pin = { tabId: tab.id, origin: originOf(url), title: tab.title || url };
  await ctx.addPin(pin);
  await ctx.focusTab(tab.id);

  return {
    status: 'ok',
    payload:
      '已打开 ' +
      url +
      '（tabId ' +
      tab.id +
      '），已加入会话 pin 并切换焦点。下一个工具调用起生效。',
  };
}

export const listTabsTool = {
  name: 'list_tabs',
  class: 'read',
  group: 'tab',
  description:
    '列出当前所有可作为目标页的标签页（按窗口分组，含 tabId/标题/URL）。' +
    '要切到别的页之前先用它拿 tabId。',
  parameters: { type: 'object', properties: {} },
  async execute(args, ctx) {
    return listTabs(ctx, args || {});
  },
};

export const focusTabTool = {
  name: 'focus_tab',
  // 只改 agent 内部指针（用户浏览器视图不动），所以是 read 不是 write
  class: 'read',
  group: 'tab',
  description:
    '把你的操作焦点切到某个标签页（tabId 来自 list_tabs）。目标页不在会话 pin 里时' +
    '会自动收进 pin。只影响你后续的 read_page / query_elements 等调用，不会打断用户。' +
    '跨页任务（在 A 页读、B 页填）用它切换。',
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'number', description: '目标标签页 id。' },
    },
    required: ['tabId'],
  },
  async execute(args, ctx) {
    return focusTab(ctx, args || {});
  },
};

export const openUrlTool = {
  name: 'open_url',
  class: 'write',
  group: 'tab',
  description:
    '打开一个 http/https 网页作为新的标签页（不会抢用户当前窗口焦点），' +
    '它自动加入本会话 pin 并切换焦点过去。用于任务需要访问别的新页面时。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要打开的完整 http(s) 地址。' },
    },
    required: ['url'],
  },
  async execute(args, ctx) {
    return openUrl(ctx, args || {});
  },
};
