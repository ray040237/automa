/**
 * 页面读取工具。
 *
 * ctx.readPage 是由调用方注入的，本文件不直接碰 browser API ——
 * 这样它仍然能在 node --test 里跑。
 *
 * P0 只做只读工具。写类工具（test_js / insert_block 等）留到 P1，
 * 因为 P0 的验收标准是「能不能一次写出正确的 selector」，与写操作无关。
 */

/**
 * @typedef {Object} ToolCtx
 * @property {(detail: string) => Promise<string>} ctx.readPage
 * @property {() => Promise<Object>} ctx.getVariables
 * @property {(name: string) => Promise<Object|null>} ctx.getBlockSchema
 */

/**
 * 读目标页。detail 控制花多少 token：
 *   summary    正文 + 重复项检测（最省）
 *   interactive 再加交互元素索引与接口列表
 *   full       再加表格与完整 HTML 片段
 *   auto       按预算自动在 summary / interactive 之间降级
 */
export const readPage = {
  name: 'read_page',
  class: 'read',
  group: 'page',
  description:
    '读取目标页的真实结构：可见文本、重复项检测（列表容器/单项/每项字段）、' +
    '交互元素索引、页面请求过的接口。要写 selector 或抓列表前必须先调用它。',
  parameters: {
    type: 'object',
    properties: {
      detail: {
        type: 'string',
        enum: ['auto', 'summary', 'interactive', 'full'],
        description: '要读到什么程度。默认 auto：超预算时自动降级为摘要。',
      },
    },
  },
  async execute(args, ctx) {
    const detail = (args && args.detail) || 'auto';
    return ctx.readPage(detail);
  },
};

/**
 * 读工作流当前变量。
 *
 * 只读，不改。模型需要知道用户已有哪些变量，才能引用对名字。
 */
export const getVariables = {
  name: 'get_variables',
  class: 'read',
  group: 'context',
  description:
    '读取当前工作流已定义的变量与全局变量（含值与类型）。' +
    '写 JS 或讲模板引用前应先看，避免引用不存在的变量名。',
  parameters: { type: 'object', properties: {} },
  async execute(args, ctx) {
    const data = await ctx.getVariables();
    const vars = (data && data.variables) || {};
    const globals = (data && data.globals) || {};
    const lines = ['## 变量'];

    lines.push('工作流变量:');
    const varKeys = Object.keys(vars);
    if (varKeys.length === 0) lines.push('  （空）');
    else
      varKeys.forEach((k) =>
        lines.push('  - ' + k + ' = ' + JSON.stringify(vars[k]))
      );

    lines.push('全局变量:');
    const globalKeys = Object.keys(globals);
    if (globalKeys.length === 0) lines.push('  （空）');
    else
      globalKeys.forEach((k) =>
        lines.push('  - ' + k + ' = ' + JSON.stringify(globals[k]))
      );

    if (data && data.workflowId) lines.push('');
    if (data && data.workflowId)
      lines.push('当前工作流 id: ' + data.workflowId);

    return lines.join('\n');
  },
};

/**
 * 查块 schema。
 *
 * 刻意不做模糊匹配：模型猜错块名时，返回明确的可用块名列表，
 * 而不是拿最像的那个糊弄过去 —— 糊弄过去的代价是生成一个静默失效的工作流。
 */
export const getBlockSchema = {
  name: 'get_block_schema',
  class: 'read',
  group: 'context',
  description:
    '查某个工作流块的字段定义（块 name 或 id）。写工作流 JSON 前用它确认字段名，' +
    '不要凭记忆猜。块名不存在时会返回本版全部可用块名。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '块的 name 或 id，如 search-query、javascript-code',
      },
    },
    required: ['name'],
  },
  async execute(args, ctx) {
    const { name } = args || {};

    if (!name) return '请提供块名。';

    const schema = await ctx.getBlockSchema(name);

    if (!schema) {
      // 模型猜错块名是最常见的情况，所以这一条要把「有什么」直接摆出来。
      // id 和块名都要给：add_block 用 id，get_block_schema 两种写法都认。
      const all = await ctx.getBlockSchema('*');
      const list = Array.isArray(all) ? all : [];

      return [
        `没有名为 ${name} 的块。`,
        '可用块（add_block 用第一个）：',
        list.map((b) => `- ${b.id}（${b.name}）`).join('\n') ||
          '（一个都没有）',
      ].join('\n');
    }

    // 字段清单是这一段的重点：add_block 的 data 要按这些键填。
    // 只回名字和描述的话，模型除了瞎猜没有别的选择。
    const fields = Object.keys(schema.data || {});

    const lines = [
      `## ${schema.name}（id: ${schema.id}）`,
      '说明: ' + (schema.description || '(无)'),
      '分类: ' + (schema.category || '(未知)'),
      '字段: ' + (fields.length ? fields.join('、') : '(无)'),
    ];

    if (schema.refDataKeys && schema.refDataKeys.length) {
      lines.push('可用的数据引用: ' + schema.refDataKeys.join('、'));
    }

    return lines.join('\n');
  },
};
