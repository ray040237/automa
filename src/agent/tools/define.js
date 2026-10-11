/**
 * 工具定义的唯一构造器（T-127）+ 回话契约的唯一出口（T-226）。
 *
 * 为什么要有它：那份形状契约原先靠人记。15 个生产工具里 `label` 一个都没有
 * （`adapter.js` 用 `tool.label || tool.name` 兜底），而 `loop.test.js` 的
 * 夹具**全都显式写了 label** —— 夹具与生产不同形，于是「主循环默认回归
 * 路径」验的从来不是生产形状：默认路径的 `tool.name` 兜底分支从没被真正
 * 跑过。`tools/index.test.js` 里那张手抄的 `ctx` 对照表是同一个病的症状
 * （它的注释自己写着「改任何工具的 ctx 依赖都必须有意识地更新这张表」）。
 *
 * **为什么单独成文件而不放进 `index.js`**：`index.js` 装配全部工具
 * （`import { readPage } from './page'`），各工具文件反过来 import
 * `defineTool` 就是循环依赖。单独成文件让两侧都能无环地引它。
 *
 * 构造器只做**形状归一**，不新增语义：
 *   - `label` 缺省填 `name`（pi 要求非空字符串，见 `adapter.test.js`）
 *   - 必填字段缺一个就在**定义时**抛，而不是等装配期 `validateTools`
 *   - `class` 仍然必须显式声明，**不给默认值**（ADR 0002：缺 class 一律走
 *     确认门，fail-closed）
 *
 * T-226 起本文件同时是**工具回话契约的家**：`{status, payload}` 信封以前
 * 只活在 adapter.js 的注释里、~54 处手抄，错形（如 `{error:'x'}`）会静默
 * 变成成功观察值。现在：
 *   - `toolOk` / `toolError` 是产出信封的**唯一**正道（新工具不许手写
 *     `{status:...}` 字面量，validateTools 之外靠 review 守）；
 *   - `noTargetTabError` / `callChannel` / `errText` 把三份逐字复制的壳
 *     （无目标页守卫、通道 try/catch、错误消息提取）收成一处。
 *
 * 不做的事：不校验 `description` / `parameters` 的**内容**（那是
 * `validateTools` 的职责）；不在这里跑 `validateTools`（会与 index.js 成环）。
 * `validateTools` 仍在 `index.js`，`index.js` 在模块加载期照旧跑一遍 ——
 * 两道关卡职责不同：这里挡「写法漂移」，那里挡「装配层漏传」。
 */

import { TOOL_STATUS } from '../events';

/** 所有允许的工具分类。新增分类必须同时想清楚「需不需要用户确认」。 */
export const TOOL_CLASSES = ['read', 'write'];

/** 定义时必须显式给出的字段。`ctx` 单独查（零依赖要写 `ctx: []`）。 */
const REQUIRED = [
  'name',
  'class',
  'group',
  'description',
  'parameters',
  'execute',
];

/* ─────────────── 回话契约（T-226）：信封只能从这里出 ─────────────── */

/**
 * 成功观察值。`meta` 里的键（如 read_page 的 pageFingerprint、read_skill 的
 * maxChars）会被 adapter 上提到 details / 观察值预算，不再手写 `{status:'ok'}`。
 *
 * @param {*} payload 给模型看的正文（字符串直出，其余 JSON 化）
 * @param {Object=} [meta] 附加结构化字段
 * @returns {{status: string, payload: *}}
 */
export function toolOk(payload, meta) {
  return { status: TOOL_STATUS.OK, payload, ...(meta || {}) };
}

/**
 * 失败观察值。adapter 会加「工具未成功执行：」前缀并把 isError 置真 ——
 * 模型据此知道这步没成，而不是拿错误文本当数据用。
 *
 * @param {*} payload 失败原因（给人话，别给栈）
 * @returns {{status: string, payload: *}}
 */
export function toolError(payload) {
  return { status: TOOL_STATUS.ERROR, payload };
}

/**
 * 无目标页守卫的统一出口。原先三个工具各抄一遍同一句话（T-226 事实清单），
 * 第 4 处漂移在 browserAdapter（T-225 另案）。
 *
 * @returns {{status: string, payload: string}}
 */
export function noTargetTabError() {
  return toolError('没有确定目标页。');
}

/**
 * 从错误对象提取人话消息。原先工具内 6 处手抄（还有 `|| err` 的漂移变体）。
 *
 * @param {*} err
 * @returns {string}
 */
export function errText(err) {
  return (err && err.message) || String(err);
}

/**
 * 走 background 通道的共用壳（原先 3 份逐字复制）：
 * 发送 → `!res.ok` 取人话原因 → 抛错转「前缀 + 人话」。
 *
 * 成功时返回 `{ok: true, res}`，由调用方继续拼自己的正文；
 * 失败时返回 `{ok: false, error}`，调用方直接 `toolError(out.error)`。
 *
 * @param {Function} sendMessage ctx 里的通道函数
 * @param {Object} payload 发给通道的载荷
 * @param {Object} opts
 * @param {string} opts.fallback 通道应答但没带 error 时的人话兜底
 * @param {string} opts.errorPrefix 通道抛错时的前缀（如「查询失败：」）
 * @returns {Promise<{ok: boolean, res?: Object, error?: string}>}
 */
export async function callChannel(
  sendMessage,
  payload,
  { fallback, errorPrefix }
) {
  try {
    const res = await sendMessage(payload);

    if (!res || !res.ok) {
      return { ok: false, error: (res && res.error) || fallback };
    }

    return { ok: true, res };
  } catch (err) {
    return { ok: false, error: errorPrefix + errText(err) };
  }
}

/**
 * 产出一个工具定义。返回值与旧的对象字面量**同构** —— 只多一个 `label`
 * 键（原先由 `adapter.js` 的 `|| tool.name` 在运行时补，现在提前补）。
 *
 * @param {Object} spec
 * @param {string} spec.name
 * @param {'read'|'write'} spec.class **必填**，不给默认值
 * @param {string} spec.group
 * @param {string[]} spec.ctx execute 需要的 toolCtx 键，零依赖也要写 `[]`
 * @param {string} spec.description
 * @param {Object} spec.parameters JSON Schema
 * @param {Function} spec.execute
 * @param {Function} [spec.confirmDetail] write 类必填
 * @param {boolean} [spec.rememberable] write 类专用：用户可勾「本会话不再问」
 *   （ADR 0002 / B5，现值只有 test_js）
 * @returns {Object}
 * @throws {Error} 缺必填字段 / 缺 ctx 声明 / write 类缺 confirmDetail /
 *   read 类声明 rememberable
 */
export function defineTool(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('defineTool: 必须传工具定义对象');
  }

  const who = spec.name || '(无名)';

  REQUIRED.forEach((key) => {
    if (spec[key] === undefined || spec[key] === null) {
      throw new Error('defineTool: ' + who + ' 缺少 ' + key);
    }
  });

  if (!Array.isArray(spec.ctx)) {
    throw new Error(
      'defineTool: ' +
        who +
        ' 缺少 ctx 声明。' +
        'ctx 列出 execute 需要的 toolCtx 键，是工具与装配层的 interface 契约' +
        '（T-133）。零依赖也要显式写 ctx: []。'
    );
  }

  if (spec.ctx.some((k) => typeof k !== 'string' || !k)) {
    throw new Error(
      'defineTool: ' + who + ' 的 ctx 声明必须是非空字符串数组。'
    );
  }

  if (spec.class === 'write' && typeof spec.confirmDetail !== 'function') {
    throw new Error(
      'defineTool: ' +
        who +
        ' 是 write 类但缺少 confirmDetail(args)。' +
        '确认卡要展示用户到底在放行什么，这段事实必须由工具自带（T-134）。'
    );
  }

  // T-226：「本会话不再问」的授权语义只对写类工具有意义（ADR 0002 / B5）。
  // read 工具免确认门，无从授权 —— 声明了就是定义期写法漂移。
  if (spec.rememberable === true && spec.class !== 'write') {
    throw new Error(
      'defineTool: ' +
        who +
        ' 是 ' +
        spec.class +
        ' 类却声明了 rememberable。会话授权只对要过确认门的 write 工具有意义。'
    );
  }

  return {
    ...spec,
    // pi 要 label（必须是非空字符串）。生产工具以前都不写它，靠 adapter
    // 在运行时兜底 —— 现在统一在这里补齐，夹具与生产同形。
    label: spec.label || spec.name,
  };
}
