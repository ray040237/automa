/**
 * 补上 webpack DefinePlugin 在构建时注入的全局。
 *
 * 不这么做的话，装配层一 import 就 ReferenceError —— 这类失败很误导人，
 * 看起来像代码写错了，其实是测试环境缺了构建期常量。
 *
 * 对应 webpack.config.js:148 的 BROWSER_TYPE，
 * 以及 utils/build.js 注释里提到的 IS_OFFLINE。
 */
export function installGlobals({
  browserType = 'chrome',
  offline = false,
} = {}) {
  globalThis.BROWSER_TYPE = browserType;
  globalThis.IS_OFFLINE = offline;
}
