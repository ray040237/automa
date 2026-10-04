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
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} timeoutValue
 * @returns {Promise<T>}
 */
export function raceTimeout(promise, ms, timeoutValue) {
  const timer = new Promise((resolve) => {
    setTimeout(() => resolve(timeoutValue), ms);
  });

  promise.catch(() => {});

  return Promise.race([promise, timer]);
}
