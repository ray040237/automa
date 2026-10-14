/**
 * `@business/blocks` 的空实现占位 —— 返回空对象。
 *
 * 契约：调用方用它合并自定义块（`{ ...tasks, ...customBlocks() }`），
 * 所以必须返回对象。背景见 `src/businessStubs/index.js` 顶部注释。
 */
export default function () {
  return {};
}
