/**
 * 剥掉 JS 源码里的注释，只留真正会被执行的代码。
 *
 * G5 守卫要用它：loop.js 里有一段注释明确写着「不许碰 saveWorkflow」，
 * 裸子串扫描会把这句话当成违规。
 *
 * 这里用 @babel/parser 做真正的解析，而不是自己写状态机：
 * 手写版本要自己处理转义、模板字符串插值、正则字面量里的斜杠、
 * JSX 之类一堆边界，漏了不报错，只是静默吃掉后面的真代码 ——
 * 对一个「守卫」来说，静默漏报比误报危险得多。
 * @babel/parser 本来就在依赖树里（@babel/core 带进来的），
 * 这里显式声明进 devDependencies 而不是蹭传递依赖。
 *
 * 只有测试用得到，所以放 devDependencies，不进运行时包。
 *
 * @param {string} src
 * @returns {string} 去掉注释后的源码；解析不了时原样返回（宁可漏剥也不误删）
 */
import { parse } from '@babel/parser';

const PARSER_OPTIONS = {
  // 模块化解析失败时退回 script，测试夹具里常有不完整的片段
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowSuperOutsideMethod: true,
  // 注释必须进 AST，否则没东西可剥
  attachComment: true,
  errorRecovery: true,
};

export function stripComments(src) {
  if (!src || typeof src !== 'string') return '';

  let ast;

  try {
    ast = parse(src, PARSER_OPTIONS);
  } catch {
    try {
      ast = parse(src, { ...PARSER_OPTIONS, sourceType: 'script' });
    } catch {
      // 解析不了就原样返回。
      // 这里的失败方向是「少剥注释」而不是「删掉代码」，所以是安全的：
      // 守卫最多误报一条，不会漏掉真正的违规调用。
      return src;
    }
  }

  // 先把所有注释区间收集起来，去重、排序，再一次性按序替换。
  //
  // 之前写成「递归遍历时顺手 drop」有两个问题，都实测踩到了：
  //  1. Babel 会把同一条注释同时挂到前一个节点的 trailingComments 和
  //     后一个节点的 leadingComments 上，于是删了两次，输出比输入还长；
  //  2. 遍历顺序不等于源码顺序，游标会倒退，行数直接对不上。
  const ranges = [];
  const seen = new Set();

  const collect = (node) => {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      node.forEach(collect);

      return;
    }

    const comments = []
      .concat(
        node.leadingComments || [],
        node.trailingComments || [],
        node.innerComments || []
      )
      .concat(node.comments || []);

    comments.forEach((c) => {
      if (!c || typeof c.start !== 'number' || typeof c.end !== 'number')
        return;
      if (c.start >= c.end) return;

      if (seen.has(c.start)) return;

      seen.add(c.start);
      ranges.push([c.start, c.end]);
    });

    Object.keys(node).forEach((k) => {
      if (k.endsWith('Comments')) return;

      collect(node[k]);
    });
  };

  collect(ast.program);
  ranges.sort((a, b) => a[0] - b[0]);

  // 按序拼接：注释区间换成等量空白（换行保留），行号与列位置都不移位。
  // 对守卫来说位置要能对上，否则报错指不到行。
  const out = [];
  let cursor = 0;

  ranges.forEach(([from, to]) => {
    if (from < cursor) return;

    out.push(src.slice(cursor, from));
    out.push(src.slice(from, to).replace(/[^\n]/g, ' '));
    cursor = to;
  });

  out.push(src.slice(cursor));

  return out.join('');
}
