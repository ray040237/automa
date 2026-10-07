/**
 * agent 页面执行的注入函数与超时守卫（纯模块，无浏览器依赖）。
 *
 * ⚠️ agentEvalInPage 会被 chrome.scripting.executeScript 序列化后注入目标页的
 * MAIN world：函数体里只允许出现 JS 内建全局，不能 import、不能引用模块级
 * 变量或闭包 —— 序列化出去的源码在页面里孤立执行，任何外部引用都是
 * ReferenceError。改它之前先跑 agentEvalInPage.test.js 和真机探针。
 *
 * 求值形态：表达式优先、语句回退（见 agentEvalInPage 的 JSDoc）——
 * 表达式（对象字面量、IIFE、fetch(...)）原样求值；const/let 语句序列
 * 也能跑（数据用 return 带回，没 return 会拿到带指引的 undefined）。
 */

/**
 * 在目标页 MAIN world 里求值一段代码。
 *
 * 接受两种形式（backlog T-38：模型抓数据时最自然写法是语句形式，
 * 只收表达式会让它首试必败）：
 *   1. 表达式（原契约）：`(function(){ return (src) })` —— 对象字面量、
 *      IIFE、fetch(...) 都行；
 *   2. 语句（表达式编译失败时回退）：`(async function(){ src })` ——
 *      const/let 语句序列可用，顶层 await 可用，数据用 `return` 带回。
 *
 * 回退只在 **SyntaxError**（编译期错误，代码从未执行）时发生，运行期错误
 * 绝不回退——那会把副作用执行两遍。
 *
 * async 求值 + 10s 超时（技术方案 §7.4 的轻量版）：模型经常写出返回
 * Promise 的代码（忘了 await），同步求值会把结果变成 "[object Promise]"；
 * fetch 之类也确实需要异步。注意这个 10s 靠页面自己的 setTimeout，
 * 页面主线程被同步代码占死时它不会触发 —— 那层由 runInPage 的
 * raceTimeout 在 background 侧兜底。
 *
 * @param {string} src
 * @returns {Promise<{ok: boolean, value?: string, json?: boolean, error?: string}>}
 */
export async function agentEvalInPage(src) {
  let value;
  let usedStatementForm = false;

  // 编译：表达式优先；表达式 SyntaxError 才回退语句形式。
  let fn;
  try {
    /* eslint-disable-next-line no-new-func */
    fn = new Function(`return (function(){ return (${src}) })`);
  } catch (exprSynErr) {
    try {
      /* eslint-disable-next-line no-new-func */
      fn = new Function(`return (async function(){\n${src}\n})`);
      usedStatementForm = true;
    } catch (stmtSynErr) {
      const msg = (stmtSynErr && stmtSynErr.message) || String(stmtSynErr);

      return {
        ok: false,
        error:
          `代码执行出错：表达式与语句两种形式都无法解析：${msg}。` +
          '请检查语法；数据用 return 带回。',
      };
    }
  }

  try {
    /* eslint-disable-next-line no-async-promise-executor */
    value = await Promise.race([
      Promise.resolve(fn()()),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('执行超时（10s）')), 10000);
      }),
    ]);
  } catch (err) {
    const msg = (err && err.message) || String(err);

    return { ok: false, error: `代码执行出错：${msg}` };
  }

  if (value === undefined) {
    // 语句形式跑完没 return 是最常见的「白跑」：当场把怎么拿数据告诉模型，
    // 免得它再猜一次。
    if (usedStatementForm) {
      return {
        ok: true,
        value:
          'undefined（代码已按语句形式执行完毕，但没有返回值——要拿到数据，' +
          '请在代码末尾加 return，或把整段包成 IIFE：(() => { … })()）',
        json: false,
      };
    }

    return { ok: true, value: 'undefined', json: true };
  }

  // 模型给的代码可能返回 DOM 节点、循环引用或函数，直接回传会序列化失败
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return { ok: true, value: json, json: true };
  } catch (e) {
    // 序列化失败就退回字符串
  }

  return { ok: true, value: String(value), json: false };
}

/**
 * 给一个可能永不 settle 的 promise 加硬超时。
 *
 * 不 reject —— 超时是「拿不到结果」而不是「通道坏了」，返回调用方给的
 * 兜底值（runInPage 用它返回 {ok:false, error}），loop 那侧才能照常收尾。
 * 底下的 promise 超时后仍可能 reject，这里挂一个空 catch 免得炸
 * unhandledrejection。
 *
 * 谁先 settle 都要把定时器撤掉：`Promise.race` 不会替你取消它。漏掉的
 * 代价是实测过的 —— 一个 20s 定时器让 node 进程多活 20009ms（T-39 的
 * `toBackground` 每次工具调用都要过这里，页面/SW 里同理白攒定时器）。
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} timeoutValue
 * @returns {Promise<T>}
 */
export function raceTimeout(promise, ms, timeoutValue) {
  let timer = null;
  const fallback = new Promise((resolve) => {
    timer = setTimeout(() => resolve(timeoutValue), ms);
  });

  promise.catch(() => {});

  return Promise.race([promise, fallback]).finally(() => clearTimeout(timer));
}

/* ───────────────── CSP 拦截识别（backlog B6） ─────────────────
 *
 * 只能在**模块级**做：agentEvalInPage 会被序列化注入页面，函数体里引用
 * 这些导出会是 ReferenceError。所以判定交给 background 侧，对它的返回值
 * 做一次 CSP 判别，再决定要不要降级到 chrome.debugger。
 *
 * 背景：严格 CSP 页面（缺 unsafe-eval）会拦掉 MAIN world 的 new Function /
 * eval，V8 抛的是 EvalError，消息形如
 *   Refused to evaluate a string as JavaScript because 'unsafe-eval' is not
 *   an allowed source of script in the following Content Security Policy ...
 * 而 agentEvalInPage 的编译 catch 把它当成 SyntaxError，回执成「表达式与
 * 语句两种形式都无法解析」——模型会以为是语法错，换着写法无限重试。
 * 这里把它认出来，好换成「不是语法问题」的清晰文案，并触发降级。
 */

/**
 * 一段错误（Error 或字符串）是不是「页面 CSP 拦掉了 eval」。
 * @param {unknown} err
 * @returns {boolean}
 */
export function isCspEvalBlock(err) {
  if (!err) return false;
  const msg = typeof err === 'string' ? err : err.message || String(err);

  return (
    /unsafe-eval/i.test(msg) ||
    /Refused to evaluate/i.test(msg) ||
    /Content Security Policy/i.test(msg)
  );
}

/**
 * runInPage 的返回值是不是一次「被 CSP 拦掉」的失败。
 * 只认 ok:false —— 成功结果一律放行，绝不误触发降级。
 * @param {unknown} res
 * @returns {boolean}
 */
export function isCspBlockedResult(res) {
  if (!res || typeof res !== 'object' || res.ok !== false) return false;

  return isCspEvalBlock(res.error);
}

/**
 * CSP 拦截后给模型看的说明。刻意点明「不是语法问题」并给出替代动作，
 * 免得模型像收到语法错那样反复改写同一段代码。
 * @param {boolean} isFirefox
 * @returns {string}
 */
export function cspBlockedMessage(isFirefox) {
  const tail = isFirefox
    ? 'Firefox 不支持用调试器绕过页面 CSP。'
    : '调试器降级也没有成功。';

  return (
    '页面 CSP 禁止 eval（unsafe-eval），这段代码没能在目标页执行。' +
    '这不是代码语法问题 —— ' +
    tail +
    '请改用 read_page / find_text 等只读工具取数据，或换一个页面再试。'
  );
}
