/**
 * `@business/parameters` 的空实现占位 —— 返回空对象。
 *
 * 契约：调用方用它展开自定义工作流参数（`{ ...workflowParameters() }`），
 * 所以必须返回对象，返回 `undefined` 会让展开报错。
 * 背景见 `src/businessStubs/index.js` 顶部注释。
 */
export default function () {
  return {};
}
