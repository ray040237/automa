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

import { readPage, findText, getVariables, getBlockSchema } from './page';
import { testJsTool, queryElementsTool } from './page-write';
import { highlightSelector } from './highlight';
import { readSkillTool } from './skill';
import {
  addBlockTool,
  updateBlockTool,
  listCanvasTool,
  readBlockTool,
} from './canvas';
import { listTabsTool, focusTabTool, openUrlTool } from './tabs';
import { TOOL_CLASSES, defineTool } from './define';

/**
 * 所有允许的工具分类。新增分类必须同时想清楚「需不需要用户确认」。
 *
 * 搬去 `define.js` 了（T-127）：`defineTool` 也要用这份清单，而工具文件
 * 反过来 import `defineTool` 会与本文件成环。
 */
export { TOOL_CLASSES, defineTool } from './define';

/** highlightSelector 只是纯函数，这里补上工具外壳。 */
export const highlightSelectorTool = defineTool({
  name: 'highlight_selector',
  class: 'write',
  group: 'page',
  ctx: ['targetTab', 'sendMessage'],
  confirmDetail(args) {
    return {
      kind: 'selector',
      detail: args ? String(args.selector ?? '') : '',
    };
  },
  description:
    '在目标页上高亮某个选择器命中的元素，让用户肉眼确认模型有没有找错。' +
    '讨论具体某个元素时先调它，不要只给选择器让用户自己猜。',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: '要高亮的 CSS selector。' },
      limit: { type: 'number', description: '最多高亮几个，默认 10。' },
      durationMs: { type: 'number', description: '保持多久毫秒，默认 4000。' },
      frame: {
        type: 'string',
        description:
          '在哪个 frame 里高亮。默认 top=只主 frame；all=所有 frame（计数跨 frame 合并）；传 frameId 数字=指定 frame。',
      },
    },
    required: ['selector'],
  },
  async execute(args, ctx) {
    return highlightSelector(ctx, args || {});
  },
});

export const TOOLS = [
  readPage,
  findText,
  getVariables,
  getBlockSchema,
  readSkillTool,
  queryElementsTool,
  highlightSelectorTool,
  testJsTool,
  listCanvasTool,
  readBlockTool,
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

    if (!Array.isArray(tool.ctx)) {
      throw new Error(
        '工具 ' +
          tool.name +
          ' 缺少 ctx 声明。ctx 列出 execute 需要的 toolCtx 键，' +
          '是工具与装配层的 interface 契约 —— 缺声明等于放弃装配期校验（T-133）。'
      );
    }

    if (tool.ctx.some((k) => typeof k !== 'string' || !k)) {
      throw new Error(
        '工具 ' + tool.name + ' 的 ctx 声明必须是非空字符串数组。'
      );
    }

    // T-134：写类工具必须自带「用户在放行什么」的事实。缺了确认卡会静默
    // 落进 generic 摊开（不报错但文案丢失），所以在加载期就拦 —— 与
    // 「缺 class 即 throw」同一哲学。read 工具不过闸，无此要求。
    if (tool.class === 'write' && typeof tool.confirmDetail !== 'function') {
      throw new Error(
        '工具 ' +
          tool.name +
          ' 是 write 类但缺少 confirmDetail(args)。' +
          '确认卡要展示用户到底在放行什么，这段事实必须由工具自带。'
      );
    }
  });

  return true;
}

validateTools(TOOLS);

/**
 * 按名字找工具。
 *
 * @param {string} name
 * @param {Array<Object>} tools
 * @returns {Object|null}
 */
export function findTool(name, tools) {
  if (!Array.isArray(tools)) {
    throw new Error(
      'findTool: tools 参数必填（T-45）——默认回落全量 TOOLS 会泄露画布工具'
    );
  }
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
export function requiresConfirmation(name, tools) {
  if (!Array.isArray(tools)) {
    throw new Error('requiresConfirmation: tools 参数必填（T-45）');
  }
  const tool = findTool(name, tools);
  return !tool || tool.class !== 'read';
}
