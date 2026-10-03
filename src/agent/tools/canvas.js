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
export async function addBlock(ctx, params) {
  const { blocks, editor, onCanvasChanged, newId } = ctx;
  const { blockId } = params;

  if (!blockId) return { status: 'error', payload: 'blockId 不能为空。' };

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
  if (!nodeId) return { status: 'error', payload: 'nodeId 不能为空。' };

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

  node.data = { ...node.data, ...(params.data || {}) };
  if (onCanvasChanged) onCanvasChanged();

  return {
    status: 'ok',
    payload: `已更新节点 ${nodeId}（${node.label}）：改了 ${Object.keys(
      params.data || {}
    ).join('、')}。没有保存。`,
  };
}

/**
 * 从画布上读回当前节点，模型据此知道现在有什么、接着该接哪。
 *
 * @param {Object} ctx
 * @param {Object} ctx.editor
 * @param {Object} params
 * @returns {Promise<Object>}
 */
export async function listCanvas(ctx) {
  const { editor } = ctx;

  if (!editor) return { status: 'error', payload: '画布还没准备好。' };

  const nodes = editor.getNodes.value.map((n) =>
    [
      '- ' + n.id + ' [' + n.label + ']',
      n.data && n.data.code
        ? '\n  代码：' + String(n.data.code).slice(0, 200)
        : '',
      n.data && n.data.description ? '\n  描述：' + n.data.description : '',
    ].join('')
  );

  return {
    status: 'ok',
    payload: nodes.length ? nodes.join('\n') : '(画布是空的)',
  };
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
 * 工具定义。
 */
export const addBlockTool = {
  name: 'add_block',
  class: 'write',
  group: 'canvas',
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
  description:
    '读当前画布上有哪些节点、各自的 id 与主要字段。改画布前先看一眼。',
  parameters: { type: 'object', properties: {} },
  async execute(args, ctx) {
    return listCanvas(ctx, args || {});
  },
};
