/**
 * 工具注册表。
 *
 * 装配期（模块被 import 时）做穷尽校验：任何一个工具漏写 class，或 class 不在
 * 允许集合里，都直接抛错。理由：
 *
 *   class 决定「要不要用户点确认」。漏写 class 而被当成 read 放行，
 *   就等于把写操作悄悄变成了免确认 —— 这是本设计里最危险的默认值，
 *   所以宁可在启动时炸掉，也不要让它静默降级。
 *
 * 本文件只允许 import 同目录下的纯模块，不得引入 webextension-polyfill 或 @/ 别名。
 */

import { readPage, getVariables, getBlockSchema } from './page';
import { testJsTool, queryElementsTool } from './page-write';
import { highlightSelector } from './highlight';
import { addBlockTool, updateBlockTool, listCanvasTool } from './canvas';
import { listTabsTool, focusTabTool, openUrlTool } from './tabs';

/** 所有允许的工具分类。新增分类必须同时想清楚「需不需要用户确认」。 */
export const TOOL_CLASSES = ['read', 'write'];

/** highlightSelector 只是纯函数，这里补上工具外壳。 */
export const highlightSelectorTool = {
  name: 'highlight_selector',
  class: 'write',
  group: 'page',
  description:
    '在目标页上高亮某个选择器命中的元素，让用户肉眼确认模型有没有找错。' +
    '讨论具体某个元素时先调它，不要只给选择器让用户自己猜。',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: '要高亮的 CSS selector。' },
      limit: { type: 'number', description: '最多高亮几个，默认 10。' },
      durationMs: { type: 'number', description: '保持多久毫秒，默认 4000。' },
    },
    required: ['selector'],
  },
  async execute(args, ctx) {
    return highlightSelector(ctx, args || {});
  },
};

export const TOOLS = [
  readPage,
  getVariables,
  getBlockSchema,
  queryElementsTool,
  highlightSelectorTool,
  testJsTool,
  listCanvasTool,
  addBlockTool,
  updateBlockTool,
  listTabsTool,
  focusTabTool,
  openUrlTool,
];

/**
 * 校验工具定义是否完整。导出以便测试直接调用。
 *
 * @param {Array<Object>} tools
 * @throws {Error} 发现问题时直接抛，附带具体是哪个工具、缺什么
 */
export function validateTools(tools) {
  const seen = new Set();

  tools.forEach((tool, idx) => {
    const at = '第 ' + (idx + 1) + ' 个工具';

    if (!tool || typeof tool !== 'object') {
      throw new Error(at + '不是对象');
    }

    if (!tool.name || typeof tool.name !== 'string') {
      throw new Error(at + '缺少 name');
    }

    if (seen.has(tool.name)) {
      throw new Error('工具名重复: ' + tool.name);
    }
    seen.add(tool.name);

    if (!tool.class) {
      throw new Error(
        '工具 ' +
          tool.name +
          ' 没有声明 class。' +
          'class 决定是否需要用户确认，缺省放行等于把写操作变成免确认，必须显式声明。'
      );
    }

    if (TOOL_CLASSES.indexOf(tool.class) === -1) {
      throw new Error(
        '工具 ' +
          tool.name +
          ' 的 class 是 ' +
          tool.class +
          '，只允许 ' +
          TOOL_CLASSES.join(' / ')
      );
    }

    if (typeof tool.execute !== 'function') {
      throw new Error('工具 ' + tool.name + ' 缺少 execute');
    }

    if (!tool.description || typeof tool.description !== 'string') {
      throw new Error('工具 ' + tool.name + ' 缺少 description');
    }

    if (!tool.parameters || typeof tool.parameters !== 'object') {
      throw new Error('工具 ' + tool.name + ' 缺少 parameters');
    }

    if (!tool.group) {
      throw new Error('工具 ' + tool.name + ' 缺少 group');
    }
  });

  return true;
}

validateTools(TOOLS);

/**
 * 转成 OpenAI tool 定义。
 *
 * @param {Array<Object>} tools
 * @returns {Array<{type: string, function: Object}>}
 */
export function toWireTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * 按名字找工具。
 *
 * @param {string} name
 * @param {Array<Object>} tools
 * @returns {Object|null}
 */
export function findTool(name, tools = TOOLS) {
  return tools.find((t) => t.name === name) || null;
}

/**
 * 是否需要用户确认。
 *
 * 未知工具一律当成需要确认 —— 与 tools 的 class 缺失直接抛错是同一条原则：
 * 权限判定上的不确定，一律往更保守的方向倒。
 *
 * @param {string} name
 * @param {Array<Object>} tools
 * @returns {boolean}
 */
export function requiresConfirmation(name, tools = TOOLS) {
  const tool = findTool(name, tools);
  return !tool || tool.class !== 'read';
}
