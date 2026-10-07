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

import { TOOL_STATUS, wrapObservation } from '../events';
import { raceTimeout } from '../agentEvalInPage';
import { validateTools } from './index';

/**
 * 工具返回值 → pi 的 AgentToolResult。
 *
 * 我们的工具返回两种形状，这里都要接住：
 *   1. 裸字符串/ 值（`get_variables`、`get_block_schema` 的多个出口）
 *   2. 信封 `{payload, status?, ...meta}`（`page.js` 等）
 *
 * **第三种「已经折好的 AgentToolResult」曾在这里原样放行，T-65 已删**：
 * 那个分支不做 escape、不截断、不补 untrusted 标签，等于给红线第 2 条开了个
 * 暗门 —— 任何工具将来返回这个形状，内容就对模型裸奔，且没有任何测试会红。
 * 现在这类值走「裸值」路径：JSON 化之后照常 escape + 截断 + 包装，
 * 宁可让工具作者看到一段 JSON，也不要静默丢掉不可信边界（T-65）。
 *
 * **不做二次包装** —— 观察值的不可信包装由 `wrapObservation`（events.js，
 * 内部走 untrusted.js）在这里一次完成。曾经还有一个必填的 `wrapUntrusted`
 * 形参，但它从未被调用过（T-69）——包装点只准有一个，多余的依赖只会误导。
 *
 * @param {*} raw 工具 execute 的原始返回值
 * @returns {{content: Array, details: Object, isError: boolean}}
 */
export function toToolResult(raw, opts = {}) {
  const wrapTag = opts.tag || 'untrusted_tool_result';

  const isEnvelope =
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    Object.prototype.hasOwnProperty.call(raw, 'payload');

  let body;
  let details = {};
  let failed = false;
  // 信封可带 maxChars 覆盖观察值预算（read_skill 用，其余工具走 8K 默认）
  let observationMaxChars;

  if (!isEnvelope) {
    // 裸值：字符串直接给，别的 JSON 化。
    // ⚠️ 空字符串也要产出**一个**内容块：pi 把空 content 兜成
    // `"(no tool output)"`，那会把「工具确实返回了空」变成「工具没说话」。
    if (typeof raw === 'string') body = raw;
    else if (raw === undefined) body = '';
    else body = JSON.stringify(raw ?? null, null, 2);
  } else {
    const { payload, status, maxChars, ...meta } = raw;
    failed = status === TOOL_STATUS.ERROR || status === TOOL_STATUS.REJECTED;
    // meta 上提到 details：观察值文本可能被陈旧快照剔除换成占位符，
    // runtime 判断页面变没变只能读结构化字段，不能读文本。
    // maxChars 单独拎出来 —— 它是观察值预算的覆盖（如 read_skill 的 32K），
    // 混进 details 会变成一个没人读的暗字段。
    details = meta;
    if (failed) body = `工具未成功执行：${payload ?? '未知原因'}`;
    else if (typeof payload === 'string') body = payload;
    else body = JSON.stringify(payload ?? null, null, 2);

    observationMaxChars = maxChars;
  }

  return {
    // 截断在包装**之前**（wrapObservation 的既有约定）：先包装后截断会把
    // 闭合标签砍掉，剩下半个标签暴露出去。
    // ⚠️ wrapObservation 的错误分支读的是 `message`，成功分支读 `payload` ——
    // 传错键名会让错误原因变成「未知原因」（实测踩过）。
    content: [
      {
        type: 'text',
        text: wrapObservation(
          failed
            ? { status: TOOL_STATUS.ERROR, message: body, wrap: wrapTag }
            : { payload: body, wrap: wrapTag, maxChars: observationMaxChars }
        ),
      },
    ],
    details,
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
 * @param {number} [deps.toolTimeoutMs] 工具级硬超时毫秒数，缺省 60000
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

  /**
   * 工具级硬超时。
   *
   * 每个工具内部的通道超时（`toBackground` 20s、`readPageFromTab` 15s、
   * `runInPage` 的 10s）是各家保的，**但没有任何一个模块钉住「整轮最长能等
   * 多少」** —— 一旦 canvas、`browser.tabs.create` 等工具的 execute 永不
   * settle，loop 就会一直 `await`，那一轮不收尾、不落盘（T-123）。
   *
   * 60s 的依据：页内执行最长 10s + `toBackground` 20s + 回程，正常路径 ≈
   * 30s。留 2x 余量，不截胡正常长任务；同时不会让「整轮卡死」变成「等 5
   * 分钟才报错」。
   *
   * 不 reject —— 超时返回 error 观察值，loop 照常收尾。语义与
   * `raceTimeout`（`agentEvalInPage.js`）一致：拿不到结果 ≠ 通道坏了。
   */
  const toolTimeoutMs =
    Number.isFinite(deps.toolTimeoutMs) && deps.toolTimeoutMs >= 0
      ? deps.toolTimeoutMs
      : 60000;
  // 模块期校验不能丢 —— pi 不会替我们炸。缺 class 就等于给写操作免确认，
  // 直接违反 ADR 0002。
  validateTools(tools);

  // 键绑定校验（T-133）：工具声明了的 ctx 键必须在 toolCtx 里真实存在。
  // 宿主漏传依赖（比如 canvas 组开着却没给画布句柄）在这里炸出人话——
  // 点名哪个工具缺哪个键，而不是等工具执行时才静默退化成一句观察值。
  const ctxKeys = deps.toolCtx || {};
  const missing = [];
  tools.forEach((tool) => {
    tool.ctx.forEach((key) => {
      if (!(key in ctxKeys)) missing.push(tool.name + ' ← ctx.' + key);
    });
  });
  if (missing.length) {
    throw new Error(
      'toAgentTools: 以下工具声明的 ctx 键在 toolCtx 里不存在（装配层漏传依赖）：\n' +
        missing.join('\n')
    );
  }

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
      // group 决定不可信标签：页面类内容用 page_content，其余用 tool_result。
      // 这个判定以前在 loop 里（靠 tool.group === 'page'），搬到这里是因为
      // 包装必须与产出内容同处，否则要包两次。
      const tag =
        tool.group === 'page'
          ? 'untrusted_page_content'
          : 'untrusted_tool_result';
      try {
        return toToolResult(
          await raceTimeout(
            tool.execute(params || {}, ctx),
            toolTimeoutMs,
            // 超时返回 error 观察值（不是 reject），loop 照常收尾并把这条写
            // 进历史——与通道层超时（index.js toBackground / readPageFromTab）
            // 的语义对齐：拿不到结果 ≠ 通道坏了。
            {
              status: TOOL_STATUS.ERROR,
              payload: `工具执行超过 ${toolTimeoutMs}ms 未返回。停止对当前会话的下一步推断，改用 read_block / read_page 等只读工具看一眼状态再继续。`,
            }
          ),
          { tag }
        );
      } catch (err) {
        // 工具抛错不终止循环（技术方案 §4.1「错误即观察值」）。
        // 这里返回 isError 而不重抛 —— 重抛会让 pi 把整个 run 打断。
        return toToolResult(
          { status: TOOL_STATUS.ERROR, payload: err.message },
          { tag }
        );
      }
    },
  }));
}
