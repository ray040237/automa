/**
 * 画布写工具。
 *
 * 这是整个 agent 最能兑现承诺的部分：用户问「这个列表怎么抓」，
 * agent 不只是给一段代码，而是把块直接放到画布上。
 *
 * 但有一条不可动摇的红线（技术方案 G5）：**agent 永远不能保存工作流**。
 * 它只能改内存里的画布，改完由用户自己看过、自己点保存。
 * 所以本文件里出现的一切都必须是纯内存操作 —— 任何 save / update / persist
 * 一旦混进来，agent 就从「助手」变成了「自动改你代码的东西」。
 *
 * 画布句柄由 index.js 从宿主注入（vue-flow 的 editor 实例），
 * 这样本模块不需要知道任何 vue-flow 的细节，也可以被直接单测。
 */

import { joinLines, safeJson } from '../confirm';

/**
 * 在画布上加一个块。
 *
 * @param {Object} ctx
 * @param {Object} ctx.blocks getBlocks() 的结果：块 id → 块定义
 * @param {Object} ctx.editor  vue-flow 的 editor 实例
 * @param {Function} ctx.onCanvasChanged 画布变了要通知宿主（标未保存）
 * @param {Function} ctx.newId 生成节点 id
 * @param {Object} params
 * @param {string} params.blockId 块 id，例如 javascript-code
 * @param {Object} [params.data] 要覆盖的块字段，例如 { code: '...' }
 * @param {number} [params.x]
 * @param {number} [params.y]
 * @returns {Promise<Object>}
 */
/**
 * 参数校验失败的错误信息：带上「实际收到了什么」。
 *
 * 只说「nodeId 不能为空」模型无法一步自纠——它经常把 add_block 的
 * blockId 和 update_block 的 nodeId 混用（dump 实测一轮连错 6 次）。
 * 回显收到的顶层键 + 截断的值，模型看一眼就知道该改哪个键。
 *
 * @param {string} missing 缺哪个参数
 * @param {Object} params 工具实际收到的参数
 * @param {string} hint 正确用法的一句话提示
 * @returns {string}
 */
function missingParamError(missing, params, hint) {
  let received = '(什么都没收到)';

  try {
    const keys = params ? Object.keys(params) : [];

    if (keys.length) {
      received = JSON.stringify(params, (_k, v) =>
        typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '…' : v
      );
    }
  } catch (e) {
    received = '(参数无法序列化)';
  }

  return `${missing} 不能为空。收到参数: ${received}。${hint}`;
}

export async function addBlock(ctx, params) {
  const { blocks, editor, onCanvasChanged, newId } = ctx;
  const { blockId } = params;

  if (!blockId) {
    return {
      status: 'error',
      payload: missingParamError(
        'blockId',
        params,
        '本工具是 add_block，用 blockId 指定要加哪种块；update_block 才用 nodeId。'
      ),
    };
  }

  const def = blocks && blocks[blockId];

  if (!def) {
    return {
      status: 'error',
      payload: `没有名为 ${blockId} 的块。可用的块 id：${listBlockIds(
        blocks
      ).join('、')}`,
    };
  }

  if (!editor) return { status: 'error', payload: '画布还没准备好。' };

  const pos = nextFreePosition(editor);
  const node = {
    id: newId(),
    position: {
      x: typeof params.x === 'number' ? params.x : pos.x,
      y: typeof params.y === 'number' ? params.y : pos.y,
    },
    // label 用块 id：编辑器就是靠它决定渲染哪个块组件
    label: blockId,
    type: def.component,
    // 先铺块的默认字段，再盖上模型给的。默认值必须带上，
    // 否则块组件会因为读不到自己的字段而报错。
    data: { ...def.data, ...(params.data || {}) },
  };

  editor.addNodes([node]);
  if (onCanvasChanged) onCanvasChanged();

  return {
    status: 'ok',
    payload: [
      `已添加块 ${blockId}（节点 id ${node.id}），位置 (${Math.round(
        node.position.x
      )}, ${Math.round(node.position.y)})。`,
      '画布已改但**没有保存**，请用户自己检查后再保存。',
    ].join('\n'),
  };
}

/**
 * 改一个已存在节点的字段。agent 修 JS 时最常用：先加一个空块，再往里填代码。
 *
 * @param {Object} ctx 同 addBlock
 * @param {Object} params
 * @param {string} params.nodeId
 * @param {Object} params.data 要合并进去的字段
 * @returns {Promise<Object>}
 */
export async function updateBlock(ctx, params) {
  const { editor, onCanvasChanged } = ctx;
  const { nodeId } = params;

  if (!editor) return { status: 'error', payload: '画布还没准备好。' };
  if (!nodeId) {
    return {
      status: 'error',
      payload: missingParamError(
        'nodeId',
        params,
        '本工具是 update_block，用 nodeId 指定要改哪个已存在的节点；add_block 才用 blockId。'
      ),
    };
  }

  const node = editor.getNodes.value.find((n) => n.id === nodeId);

  if (!node) {
    const ids = editor.getNodes.value.map((n) => n.id);

    return {
      status: 'error',
      payload: `画布上没有 id 为 ${nodeId} 的节点。现有节点：${
        ids.join('、') || '(空画布)'
      }`,
    };
  }

  const patch = params.data || {};

  node.data = { ...node.data, ...patch };
  if (onCanvasChanged) onCanvasChanged();

  // 顺带报一下写入后的字符串长度（T-91 D 项）：模型据此核对有没有写半截，
  // 比让它再调一次 read_block 便宜得多。
  const sizes = Object.keys(patch)
    .filter(
      (k) => typeof node.data[k] === 'string' && node.data[k].length > 200
    )
    .map((k) => `${k} 现在 ${node.data[k].length} 字符`);

  return {
    status: 'ok',
    payload:
      `已更新节点 ${nodeId}（${node.label}）：改了 ${Object.keys(patch).join(
        '、'
      )}。没有保存。` + (sizes.length ? `\n（${sizes.join('；')}）` : ''),
  };
}

/** 清单里短字段值的直出上限：超过就只报长度，不报内容。 */
export const FIELD_PREVIEW_CHARS = 40;

/** code 字段特殊照顾：模型最常要读的就是它，给一段摘要而不是干巴巴一个长度。 */
export const CODE_PREVIEW_CHARS = 200;

/**
 * 把单个字段渲染成清单里的一行。
 *
 * 铁律（T-91）：**长值只报长度，绝不静默截断**。
 * 旧实现是 `code.slice(0, 200)` 且不带任何标记，模型拿到 200 字符当全文用，
 * 改出来的 JS 是半截的 —— 那正是本项目最忌讳的静默降级。
 * 因此这里要么给全值，要么明说「共 N 字符，已省略」并指路 read_block。
 *
 * @param {string} key 字段名
 * @param {*} value 字段值
 * @param {string} nodeId 所属节点，用于拼 read_block 的调用示例
 * @returns {string}
 */
export function renderField(key, value, nodeId) {
  const hint = `读全文用 read_block(nodeId="${nodeId}", field="${key}")`;

  if (typeof value === 'string') {
    if (key === 'code' && value.length > CODE_PREVIEW_CHARS) {
      return (
        `  ${key}: （共 ${value.length} 字符）\n` +
        `    前 ${CODE_PREVIEW_CHARS} 字符：${value.slice(
          0,
          CODE_PREVIEW_CHARS
        )}…\n` +
        `    **已截断**，${hint}`
      );
    }

    if (value.length > FIELD_PREVIEW_CHARS)
      return `  ${key}: （共 ${value.length} 字符，已省略）${hint}`;

    return `  ${key}: ${value}`;
  }

  if (value === null || value === undefined) return `  ${key}: (空)`;

  if (typeof value === 'object') {
    const json = safeJson(value);

    if (json.length > FIELD_PREVIEW_CHARS)
      return `  ${key}: （对象，共 ${json.length} 字符，已省略）${hint}`;

    return `  ${key}: ${json}`;
  }

  return `  ${key}: ${String(value)}`;
}

/**
 * 把节点渲染成清单里的一段：一行头 + 每个字段一行。
 *
 * @param {Object} n vue-flow 节点
 * @returns {string}
 */
export function renderNode(n) {
  const keys = n.data ? Object.keys(n.data) : [];
  const head = `- ${n.id} [${n.label}]`;

  if (!keys.length) return head + '\n  （该节点没有字段）';

  return [head, ...keys.map((k) => renderField(k, n.data[k], n.id))].join('\n');
}

/**
 * 从画布上读回当前节点，模型据此知道现在有什么、接着该接哪。
 *
 * 只给清单，不给全文 —— 画布上有十个 JS 块时，全文必然撞破观察值上限
 * （events.js 的 8000），到时候被砍的是排在后面的节点，比不给更难预测。
 * 要全文走 read_block。
 *
 * @param {Object} ctx
 * @param {Object} ctx.editor
 * @param {Object} params
 * @returns {Promise<Object>}
 */
export async function listCanvas(ctx) {
  const { editor } = ctx;

  if (!editor) return { status: 'error', payload: '画布还没准备好。' };

  const nodes = editor.getNodes.value;

  return {
    status: 'ok',
    payload: nodes.length ? nodes.map(renderNode).join('\n') : '(画布是空的)',
  };
}

/** read_block 单次取字符的下限。低于它没意义：字段往往更短，直接给全值就行。 */
export const MIN_FIELD_CHARS = 200;

/**
 * read_block 单次取字符的上限。
 *
 * 刻意比 events.js 的观察值硬上限（8000）低 1000：分页头、脚注与
 * untrusted 包装标签本身都占字符，顶到 8000 会被 wrapObservation 二次截断
 * —— 模型传了 limit=8000 却只拿到 7900，正是本条要消灭的那种静默降级。
 */
export const MAX_FIELD_CHARS = 7000;

/**
 * 归一化 read_block 的 offset / limit。
 *
 * 超范围一律报错，不静默夹取 —— 与 page.js 的 maxChars 同款哲学：
 * 模型以为自己申请的是某个值，实际拿到另一个，比报错更糟。
 *
 * @param {Object} args
 * @returns {{offset: number, limit: number}|{error: string}}
 */
export function normalizeReadBlockRange(args) {
  const raw = args || {};
  const offsetRaw =
    raw.offset === undefined || raw.offset === null ? 0 : raw.offset;
  const limitRaw =
    raw.limit === undefined || raw.limit === null ? MAX_FIELD_CHARS : raw.limit;

  const offset = Number(offsetRaw);
  const limit = Number(limitRaw);

  if (!Number.isFinite(offset) || offset < 0 || !Number.isInteger(offset))
    return {
      error: `offset 必须是不小于 0 的整数，收到 ${JSON.stringify(
        raw.offset
      )}。`,
    };

  if (!Number.isFinite(limit) || !Number.isInteger(limit))
    return { error: `limit 必须是整数，收到 ${JSON.stringify(raw.limit)}。` };

  if (limit < MIN_FIELD_CHARS || limit > MAX_FIELD_CHARS)
    return {
      error:
        `limit 必须是 ${MIN_FIELD_CHARS}–${MAX_FIELD_CHARS} 之间的整数，收到 ${limit}` +
        `（上限留了 1000 字符余量：观察值硬上限 8000，顶到它会连同分页头一起被截断）。`,
    };

  return { offset, limit };
}

/**
 * 读画布上某个节点的某个字段的**全文**。
 *
 * list_canvas 只能给清单（理由见它自己的注释），要逐字读 JS 就走这里：
 * 一次只取一个节点的一个字段，天然撞不破观察值上限；再长也能靠
 * offset/limit 分几次读完。
 *
 * @param {Object} ctx
 * @param {Object} ctx.editor
 * @param {Object} params
 * @param {string} params.nodeId
 * @param {string} [params.field] 字段名。不给就返回该节点的字段清单。
 * @param {number} [params.offset] 起始字符偏移，默认 0
 * @param {number} [params.limit] 本次最多取几个字符，默认 MAX_FIELD_CHARS
 * @returns {Promise<Object>}
 */
export async function readBlock(ctx, params) {
  const { editor } = ctx;

  if (!editor) return { status: 'error', payload: '画布还没准备好。' };

  const { nodeId, field } = params;

  if (!nodeId) {
    return {
      status: 'error',
      payload: missingParamError(
        'nodeId',
        params,
        'read_block 用 nodeId 指定读哪个节点，先用 list_canvas 查 id。'
      ),
    };
  }

  const node = editor.getNodes.value.find((n) => n.id === nodeId);

  if (!node) {
    const ids = editor.getNodes.value.map((n) => n.id);

    return {
      status: 'error',
      payload: `画布上没有 id 为 ${nodeId} 的节点。现有节点：${
        ids.join('、') || '(空画布)'
      }`,
    };
  }

  const data = node.data || {};

  // 不指定字段：给这个节点的字段清单（与 list_canvas 同一套渲染，口径一致）
  if (!field) return { status: 'ok', payload: renderNode(node) };

  if (!Object.prototype.hasOwnProperty.call(data, field)) {
    return {
      status: 'error',
      payload: `节点 ${nodeId}（${node.label}）没有字段 ${field}。它有的字段：${
        Object.keys(data).join('、') || '(无字段)'
      }`,
    };
  }

  const range = normalizeReadBlockRange(params);
  if (range.error) return { status: 'error', payload: range.error };

  const raw = String(data[field] ?? '');
  const { offset, limit } = range;

  if (offset >= raw.length && raw.length > 0)
    return {
      status: 'error',
      payload: `offset ${offset} 超出字段长度：${field} 只有 ${raw.length} 字符。`,
    };

  const chunk = raw.slice(offset, offset + limit);
  const end = offset + chunk.length;
  const rest = raw.length - end;

  const head =
    `节点 ${nodeId}（${node.label}）字段 ${field}：共 ${raw.length} 字符，` +
    `本次返回 ${offset}–${end}` +
    (rest > 0 ? `（后面还有 ${rest} 字符）。` : '（到这里就是全文）。');

  const tail =
    rest > 0
      ? `\n[未读完：还有 ${rest} 字符，用 read_block(nodeId="${nodeId}", field="${field}", offset=${end}) 继续。]`
      : '';

  return { status: 'ok', payload: `${head}\n\n${chunk}${tail}` };
}

/**
 * 找一个不跟现有节点打架的落点。
 *
 * 不这么做的话，agent 连加三个块会全叠在同一个点上，用户根本点不中。
 */
function nextFreePosition(editor) {
  const nodes = editor.getNodes.value;

  if (nodes.length === 0) return { x: 100, y: 100 };

  const maxX = nodes.reduce(
    (m, n) => Math.max(m, n.position.x + (n.width || 220)),
    0
  );

  return { x: maxX + 60, y: 100 };
}

function listBlockIds(blocks) {
  return Object.keys(blocks || {});
}

/**
 * 把「用户在放行什么」的画布 diff 摘要整形出来 —— 两个写类工具的
 * confirmDetail 共用（T-83）。
 */
function canvasConfirmDetail(action, idKey, args) {
  const id = args && args[idKey] ? String(args[idKey]) : '';
  const data =
    args &&
    args.data &&
    typeof args.data === 'object' &&
    !Array.isArray(args.data)
      ? args.data
      : {};

  return {
    kind: 'canvas',
    action,
    [idKey]: id,
    detail: joinLines(
      id && idKey + ': ' + id,
      Object.keys(data).length > 0 && safeJson(data)
    ),
  };
}

/**
 * 工具定义。
 */
export const addBlockTool = {
  name: 'add_block',
  class: 'write',
  group: 'canvas',
  ctx: ['blocks', 'editor', 'newId', 'onCanvasChanged'],
  confirmDetail(args) {
    return canvasConfirmDetail('add', 'blockId', args);
  },
  description:
    '往当前工作流画布上加一个块。改完不会自动保存，用户自己检查后保存。' +
    '先用 get_block_schema 看块有哪些字段。',
  parameters: {
    type: 'object',
    properties: {
      blockId: {
        type: 'string',
        description:
          '块的 id，例如 javascript-code、blocks-groups-loop-elements。',
      },
      data: {
        type: 'object',
        description:
          '要设的块字段，会盖在该块的默认值之上。例：{ code: "..." }。',
      },
      x: { type: 'number', description: '可选，横坐标。不填就自动找空位。' },
      y: { type: 'number', description: '可选，纵坐标。' },
    },
    required: ['blockId'],
  },
  async execute(args, ctx) {
    return addBlock(ctx, args || {});
  },
};

export const updateBlockTool = {
  name: 'update_block',
  class: 'write',
  group: 'canvas',
  ctx: ['editor', 'onCanvasChanged'],
  confirmDetail(args) {
    return canvasConfirmDetail('update', 'nodeId', args);
  },
  description:
    '改画布上某个已存在节点的字段（最常用是往里填代码）。不会自动保存。',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: '节点 id，用 list_canvas 查。' },
      data: { type: 'object', description: '要合并进去的字段。' },
    },
    required: ['nodeId', 'data'],
  },
  async execute(args, ctx) {
    return updateBlock(ctx, args || {});
  },
};

export const listCanvasTool = {
  name: 'list_canvas',
  class: 'read',
  group: 'canvas',
  ctx: ['editor'],
  description:
    '列出当前画布上有哪些节点、各自 id 与字段名。改画布前先看一眼。' +
    '**只给清单不给全文**：长字段只报字符数，要逐字读某个字段的全文用 read_block。',
  parameters: { type: 'object', properties: {} },
  async execute(args, ctx) {
    return listCanvas(ctx, args || {});
  },
};

export const readBlockTool = {
  name: 'read_block',
  class: 'read',
  group: 'canvas',
  ctx: ['editor'],
  description:
    '读画布上某个节点某个字段的**全文**（最常用：读 javascript-code 块的 code）。' +
    '一次只取一个字段，超长时用 offset/limit 分几次读完，返回值会告诉你后面还剩多少字符。' +
    'list_canvas 只给清单，要逐字读代码就用这个。',
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: '节点 id，用 list_canvas 查。' },
      field: {
        type: 'string',
        description:
          '字段名，如 code、description、selector。不给则返回该节点的字段清单。',
      },
      offset: {
        type: 'number',
        description: '从第几个字符开始读，默认 0。接着上一次读完的地方继续。',
      },
      limit: {
        type: 'number',
        description: `本次最多读几个字符，默认 ${MAX_FIELD_CHARS}（范围 ${MIN_FIELD_CHARS}–${MAX_FIELD_CHARS}）。`,
      },
    },
    required: ['nodeId'],
  },
  async execute(args, ctx) {
    return readBlock(ctx, args || {});
  },
};
