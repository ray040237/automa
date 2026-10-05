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
 * @property {(params: {detail?: string, maxChars?: number}) => Promise<string|{text: string, fingerprint?: string}>} ctx.readPage
 * @property {(params: {keyword: string, limit?: number}) => Promise<string|{text: string}>} ctx.findText
 * @property {() => Promise<Object>} ctx.getVariables
 * @property {(name: string) => Promise<Object|null>} ctx.getBlockSchema
 */

/** read_page 的档位（单调阶梯：往后一项只比前一项多）。默认档排在最前。 */
export const READ_PAGE_DETAILS = ['addresses', 'probe', 'content', 'full'];

/**
 * 旧档位映射。
 *
 * 模型会照抄历史上下文里的参数（auto/summary/interactive），直接拒会让旧会话
 * 每次读页都报错 —— 所以映射放在参数入口这层，content 侧只认 4 个新值，
 * 遇到别的直接报错（不静默降级）。映射本身不说话，生效档位由 <page> 头部回显。
 */
const LEGACY_DETAIL = {
  auto: 'addresses',
  summary: 'content',
  interactive: 'addresses',
  full: 'full',
};

// 与 events.js 的观察值硬截断（8000）对齐：再大也会被砍，不如在这里说清楚
const MAX_CHARS_LIMIT = 8000;
const MIN_CHARS_LIMIT = 400;

/**
 * 归一化 read_page 参数：detail 白名单 + 旧值映射 + maxChars 范围校验。
 *
 * 导出是为了能在 node --test 里直接断言（DOM 测试够不到 agent 侧）。
 *
 * @param {{detail?: string, maxChars?: number}|string} args
 * @returns {{detail: string, maxChars?: number}|{error: string}}
 */
export function normalizeReadPageArgs(args) {
  const raw = typeof args === 'string' ? { detail: args } : args || {};

  let detail = 'addresses';
  if (raw.detail !== undefined && raw.detail !== null && raw.detail !== '') {
    const given = String(raw.detail);

    if (READ_PAGE_DETAILS.indexOf(given) !== -1) detail = given;
    else if (Object.prototype.hasOwnProperty.call(LEGACY_DETAIL, given))
      detail = LEGACY_DETAIL[given];
    else
      return {
        error:
          'read_page 的 detail 取值「' +
          given +
          '」不认识。合法值：' +
          READ_PAGE_DETAILS.join(' / ') +
          '（旧值 auto→addresses、summary→content、interactive→addresses、full 不变仍可映射）。',
      };
  }

  if (
    raw.maxChars !== undefined &&
    raw.maxChars !== null &&
    raw.maxChars !== ''
  ) {
    const n = Number(raw.maxChars);
    if (!Number.isFinite(n) || n < MIN_CHARS_LIMIT || n > MAX_CHARS_LIMIT)
      return {
        error:
          'maxChars 必须是 ' +
          MIN_CHARS_LIMIT +
          '–' +
          MAX_CHARS_LIMIT +
          ' 之间的数字，收到 ' +
          JSON.stringify(raw.maxChars) +
          '（观察值硬上限 8000 字符，超出也会被截断）。',
      };
    return { detail, maxChars: Math.floor(n) };
  }

  return { detail };
}

/**
 * 读目标页。
 *
 * detail 控制花多少 token（口径是「给多少地址」，不是「读多少正文」）：
 *   addresses 结构与地址（默认）：列表模式、可操作元素（导航已折叠）、表格、接口
 *   probe     只看概况：URL/标题/元素数/指纹，最省
 *   content   addresses + 可见正文
 *   full      content + HTML 片段（极少用）
 * 预算兜底从参数里拿掉了 —— 旧 auto 档的隐式降级正是「砍错地方」的根因。
 */
export const readPage = {
  name: 'read_page',
  class: 'read',
  group: 'page',
  ctx: ['readPage'],
  description:
    '读取目标页的结构地址：列表模式（容器/单项/字段/取值方式/样例）、可操作元素索引' +
    '（导航已折叠）、表格与页面请求过的接口。默认 detail=addresses（约几百 token），' +
    '写 selector 或抓列表前必须先调用。默认档不含页面正文 —— 要读内容用 detail=content，' +
    '或用 find_text 按关键词取片段；只想确认页面有没有变用 detail=probe（最省）。',
  parameters: {
    type: 'object',
    properties: {
      detail: {
        type: 'string',
        enum: READ_PAGE_DETAILS,
        description:
          'probe=URL/标题/元素数/指纹(~150 token)；addresses=结构与地址(默认，写 selector 用这个)；' +
          'content=再加可见正文；full=再加 HTML 片段(极少用)。',
      },
      maxChars: {
        type: 'number',
        description:
          '输出字符预算，默认 6000（范围 400–8000）。预算不足时按固定砍序省略，省略处会显式标注。',
      },
    },
  },
  async execute(args, ctx) {
    const norm = normalizeReadPageArgs(args);
    if (norm.error) return { status: 'error', payload: norm.error };

    const res = await ctx.readPage({
      detail: norm.detail,
      maxChars: norm.maxChars,
    });

    if (res && typeof res === 'object') {
      return {
        payload: res.text,
        ...(res.fingerprint ? { pageFingerprint: res.fingerprint } : {}),
      };
    }

    return { payload: res };
  },
};

/**
 * 页内按文本找元素。
 *
 * 与 query_elements 的分工：已知 selector 用 query_elements 验证，
 * 不知道 selector 但知道页面上写了什么，用 find_text 找入口。
 * 只做字面匹配（不做正则：注入面 + 语法错误，见设计稿 §12）。
 */
export const findText = {
  name: 'find_text',
  class: 'read',
  group: 'page',
  ctx: ['findText'],
  description:
    '在目标页里按文本关键词找元素（字面匹配、忽略大小写，不支持正则）。' +
    '命中即返回可落盘的 CSS selector、所在容器与前后文片段。' +
    '不知道 selector 但知道页面上写了什么时用它；已知 selector 要验证命中情况用 query_elements。',
  parameters: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description:
          '要找的文本，字面匹配、忽略大小写。关键词被标签切开时可能匹配不到，换更短的词。',
      },
      limit: {
        type: 'number',
        description: '最多返回几条，默认 5，上限 20。',
      },
    },
    required: ['keyword'],
  },
  async execute(args, ctx) {
    const keyword = String((args && args.keyword) || '').trim();
    if (!keyword)
      return {
        status: 'error',
        payload: 'keyword 不能为空：告诉我要在页面里找什么文本。',
      };

    const limitRaw = Number(args && args.limit);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), 20)
        : 5;

    const res = await ctx.findText({ keyword, limit });
    return { payload: res && typeof res === 'object' ? res.text : res };
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
  ctx: ['getVariables'],
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
  ctx: ['getBlockSchema'],
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

    const raw = await ctx.getBlockSchema(name);

    // 形状守卫：契约是「单块对象或 null」。数组/其他真值一律当查不到处理，
    // 否则空数组会走「查到了」分支渲染出 ## undefined（真踩过）。
    const schema =
      raw && !Array.isArray(raw) && typeof raw === 'object' && raw.id
        ? raw
        : null;

    if (!schema) {
      // 模型猜错块名是最常见的情况，所以这一条要把「有什么」直接摆出来。
      // id 和块名都要给：add_block 用 id，get_block_schema 两种写法都认。
      const all = await ctx.getBlockSchema('*');
      const list = Array.isArray(all) ? all : [];

      // 目录合法但为空 ≠ 没有匹配块：真实目录有 61 个块，这里空说明
      // runtime 的 getBlockSchema 又没接上线（backlog T-32 的旧病）。
      // 必须说破，否则模型看到的是「没有任何块可用」，和事实表矛盾，
      // 会陷进 read_page ↔ get_block_schema 的重试循环。
      if (Array.isArray(all) && all.length === 0) {
        return (
          '块目录查不到任何块——get_block_schema 没接上线（agent runtime 缺陷），' +
          '这不是块名写错。请停止用本工具重试，改用其他方式完成任务。'
        );
      }

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
