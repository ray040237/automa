/**
 * 领域知识表的纯计算部分。
 *
 * 为什么要单独拆出来：装配层 index.js 要 import @/ 别名和 webextension-polyfill，
 * 所以它是整个 agent 里唯一测不到的文件。上一个 bug 就住在那里 ——
 * 对 tasks 直接 .reduce，而 tasks 其实是对象，一发消息就抛
 * 「tasks.reduce is not a function」。把计算挪到这里就能测了。
 *
 * 本文件只允许 import 同目录下的纯模块。
 */

/**
 * 数一块工作流里有多少个可用块。
 *
 * @param {Object} catalog 块 id → 块定义（shared.js 里的 tasks 就是这个形状）
 * @returns {number}
 */
export function countBlocks(catalog) {
  // 注意这里是对象不是数组。上游若改成数组，这里会静默少数 ——
  // 所以两边都用 Object.values 归一，数组和对象都吃得下。
  return Object.values(catalog || {}).reduce(
    (n, t) => n + Object.keys(t || {}).length,
    0
  );
}

/**
 * 组装喂给提示词的事实表。catalog 由调用方注入，方便测试换数据。
 *
 * @param {Object} params
 * @param {Object} params.automaFuncs 补全表
 * @param {Object} params.templatingFunctions 模板函数表
 * @param {Object} params.catalog 块目录
 * @param {Array<Object>} params.tools
 * @param {Array<string>} params.excludeFuncs 要剔掉的补全项（补全里有、运行时没注入的）
 * @param {string=} params.instructions 用户自定义指令（T-81a）；空串/缺省 = 未配置
 * @param {Array<{name: string, description: string}>=} params.skills
 *   技能索引（T-81b，只含启用的）；空数组/缺省 = 不拼索引区
 * @returns {Object}
 */
export function buildFacts({
  automaFuncs,
  templatingFunctions,
  catalog,
  tools,
  excludeFuncs = [],
  instructions = '',
  skills = [],
}) {
  return {
    automaFuncs: Object.keys(automaFuncs || {}).filter(
      (n) => excludeFuncs.indexOf(n) === -1
    ),
    templatingFns: Object.keys(templatingFunctions || {}),
    blockCount: countBlocks(catalog),
    tools: (tools || []).map((t) => ({
      name: t.name,
      class: t.class,
      group: t.group,
      description: t.description,
    })),
    instructions: String(instructions || ''),
    skills: Array.isArray(skills) ? skills : [],
  };
}
