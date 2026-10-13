/**
 * 往当前文档里挂元素。
 *
 * 为什么不能直接 `document.body.appendChild`：**SVG 文档**（`image/svg+xml`，
 * 含页面里 `<embed>`/`<object>` 内嵌的 SVG frame）里 `document.body` 与
 * `document.head` **都是 null**，只有 `documentElement` 在 —— 实测（T-251）：
 * ```
 * doc.svg → head: "null", body: "null", documentElement: "ok"
 * ```
 * 在这种文档上裸调 `document.body.appendChild(x)` 会抛
 * `TypeError: Cannot read properties of null (reading 'appendChild')` ——
 * 和 T-250 的 clipboard 那次是同一种错误形状：读属性即炸，同步 throw。
 *
 * content script 是 `<all_urls>` + `all_frames` 注入的，SVG 文档在射程内，
 * 而选择器/命令面板正是用户主动唤起的 —— 「在这个页面上按快捷键毫无反应」
 * 就是这么来的。`documentElement` 在 SVG 里存在，作为兜底挂载点；
 * `<style>` 也是 SVG 的合法子元素，所以样式照样生效。
 *
 * 本模块零依赖，content script 可以放心引。
 */

/** 返回可用的挂载点：优先 body，缺失时退回 documentElement。 */
export function getDocumentMount() {
  return document.body || document.documentElement;
}

/** 挂载元素并返回它。body 缺失时不会抛。 */
export function appendToDocument(element) {
  getDocumentMount().appendChild(element);

  return element;
}
