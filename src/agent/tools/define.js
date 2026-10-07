/**
 * 工具定义的唯一构造器（T-127）。
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
 * 不做的事：不校验 `description` / `parameters` 的**内容**（那是
 * `validateTools` 的职责）；不在这里跑 `validateTools`（会与 index.js 成环）。
 * `validateTools` 仍在 `index.js`，`index.js` 在模块加载期照旧跑一遍 ——
 * 两道关卡职责不同：这里挡「写法漂移」，那里挡「装配层漏传」。
 */

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
 * @returns {Object}
 * @throws {Error} 缺必填字段 / 缺 ctx 声明 / write 类缺 confirmDetail
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

  return {
    ...spec,
    // pi 要 label（必须是非空字符串）。生产工具以前都不写它，靠 adapter
    // 在运行时兜底 —— 现在统一在这里补齐，夹具与生产同形。
    label: spec.label || spec.name,
  };
}
