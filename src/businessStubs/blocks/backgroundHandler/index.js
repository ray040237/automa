/**
 * `@business/blocks/backgroundHandler` 的空实现占位 —— 返回空对象。
 *
 * 契约：调用方写 `...customHandlers()`，直接展开，所以**必须**返回对象，
 * 返回 undefined 会抛错。背景见 `src/businessStubs/index.js` 顶部注释。
 */
export default function () {
  return {};
}
