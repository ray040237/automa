/**
 * 工具适配层：把我们的工具定义翻译成 pi 的 AgentTool。
 *
 * 为什么不直接改 13 个工具：工具本体（`page.js` / `canvas.js` / …）有它自己
 * 的一批测试，改形状会让那批测试跟着改，而它们测的是「工具做什么」不是
 * 「工具怎么描述给模型」。所以**形状转换全部收在这里**——一个模块、一个入口。
 *
 * 它解决的**红线第 3 条**：工具返回值必须显式给出 `content` 与 `isError`。
 * pi 的循环在结果缺 `content` 时会兜成空数组，provider 随后发出
 * `"(no tool output)"`——正文与不可信标记一起消失，不报错、不降级，
 * 模型只是「看不到东西」。沿用 `{status:'error'}` 而不设 `isError` 的话，
 * 模型会把失败当成功读。两条都是静默失败，所以各有测试钉住。
 *
 * 不变式（方案 G5）：本文件只 import 同目录与 src/agent 下的纯模块，
 * 不碰 webextension-polyfill、不碰 @/ 别名，更不能碰 workflowStore.update。
 */

import { TOOL_STATUS } from '../events';
import { validateTools } from './index';

/**
 * 工具返回值 → pi 的 AgentToolResult。
 *
 * 我们的工具返回三种形状，这里都要接住：
 *   1. 裸字符串/ 值（`get_variables`、`get_block_schema` 的多个出口）
 *   2. 信封 `{payload, status?, ...meta}`（`page.js` 等）
 *   3. 已经折好的 AgentToolResult（其他适配器或后续票产出）
 *
 * **不做二次包装** —— 观察值的不可信包装在票 03 落，这里只保证 `content`
 * 非空且 `isError` 明确。理由：包装点拆成两处就多一个能拆错的地方。
 *
 * @param {*} raw 工具 execute 的原始返回值
 * @returns {{content: Array, details: Object, isError: boolean}}
 */
export function toToolResult(raw) {
  // 已经是 AgentToolResult 形状 —— 原样放行，不认识的结构不猜
  if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray(raw.content) &&
    'details' in raw
  ) {
    return { ...raw, isError: raw.isError === true };
  }

  const isEnvelope =
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    Object.prototype.hasOwnProperty.call(raw, 'payload');

  if (!isEnvelope) {
    // 裸值：字符串直接给，别的 JSON 化。
    // ⚠️ 空字符串也要产出**一个**内容块：pi 把空 content 兜成
    // `"(no tool output)"`，那会把「工具确实返回了空」变成「工具没说话」。
    let text;
    if (typeof raw === 'string') text = raw;
    else if (raw === undefined) text = '';
    else text = JSON.stringify(raw ?? null, null, 2);
    return { content: [{ type: 'text', text }], details: {}, isError: false };
  }

  const { payload, status, ...meta } = raw;
  const failed =
    status === TOOL_STATUS.ERROR || status === TOOL_STATUS.REJECTED;
  let body;
  if (failed) body = `工具未成功执行：${payload ?? '未知原因'}`;
  else if (typeof payload === 'string') body = payload;
  else body = JSON.stringify(payload ?? null, null, 2);

  return {
    content: [{ type: 'text', text: body }],
    // meta 上提到 details：观察值文本可能被陈旧快照剔除换成占位符，
    // runtime 判断页面变没变只能读结构化字段，不能读文本。
    details: meta,
    isError: failed,
  };
}

/**
 * 一组工具定义 → pi 的 AgentTool 数组。
 *
 * `class` 与 `group` 不是 pi 的字段，但对我们的逻辑必需：
 * `class` 决定要不要过确认门（票 04），`group` 决定观察值用哪个
 * 不可信标签（票 03）。它们原样挂在返回对象上，**在这里显式保留，
 * 不靠闭包藏** —— 藏起来的话票 03/04 就得反查工具表。
 *
 * @param {Array<Object>} tools 我们的工具定义
 * @param {Object} deps
 * @param {Object} deps.toolCtx 工具执行上下文（读页、发消息等）
 * @param {Object=} deps.signalRegistry 中止信号注册表：按 toolCallId 存
 * @returns {Array<Object>} pi 的 AgentTool[]
 */
export function toAgentTools(tools, deps = {}) {
  // tools 必须显式传：默认回落全量 TOOLS 会把画布工具泄露给无画布的宿主（T-45）。
  if (!Array.isArray(tools)) {
    throw new Error(
      'toAgentTools: tools 必须是数组且必填（T-45）—— ' +
        '默认回落全量 TOOLS 会泄露画布工具给无画布的宿主'
    );
  }
  // 模块期校验不能丢 —— pi 不会替我们炸。缺 class 就等于给写操作免确认，
  // 直接违反 ADR 0002。
  validateTools(tools);

  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label || tool.name,
    description: tool.description,
    parameters: tool.parameters,
    class: tool.class,
    group: tool.group,
    async execute(toolCallId, params, signal) {
      const ctx = {
        ...deps.toolCtx,
        // 中止信号按调用传下去：工具有后台任务时必须能被取消
        ...(signal ? { signal } : {}),
      };
      try {
        return toToolResult(await tool.execute(params || {}, ctx));
      } catch (err) {
        // 工具抛错不终止循环（技术方案 §4.1「错误即观察值」）。
        // 这里返回 isError 而不重抛 —— 重抛会让 pi 把整个 run 打断。
        return {
          content: [{ type: 'text', text: `工具未成功执行：${err.message}` }],
          details: {},
          isError: true,
        };
      }
    },
  }));
}
