/**
 * `@business/blocks/contentHandler` 的空实现占位 —— 返回空对象。
 *
 * 契约：调用方写 `...(customHandlers() || {})`，所以返回对象最安全
 * （返回 undefined 虽有 `|| {}` 兜底，但别依赖兜底）。
 * 背景见 `src/businessStubs/index.js` 顶部注释。
 */
export default function () {
  return {};
}
