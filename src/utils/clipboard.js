/**
 * 写剪贴板。
 *
 * 唯一的坑，也是这个模块存在的理由：`navigator.clipboard` 带 `[SecureContext]`
 * 标记 —— **http 页面（localhost 除外）上这个属性根本不存在**。此时
 * `navigator.clipboard.writeText(...)` 在读 `writeText` 这一步就同步抛
 * `TypeError: Cannot read properties of undefined (reading 'writeText')`，
 * Promise 压根没生成，后面挂的 `.catch()` 连执行机会都没有，兜底形同虚设
 * （T-250：元素选择器面板在企业内网 http 站点上，点复制必崩）。
 * 所以必须先判存在性，再决定走哪条路。
 *
 * 本模块刻意不 import 任何扩展 API —— content script（elementSelector 面板，
 * 注入到用户正在浏览的页面里）也要用它，不能把 `workflowEngine/helper.js`
 * 那串依赖（BrowserAPIService / webextension-polyfill）拖进内容脚本产物。
 */

/** 老办法：临时 textarea + execCommand。非安全上下文下唯一能用的写入路径。 */
export function fallbackCopyTextToClipboard(text) {
  const textArea = document.createElement('textarea');
  textArea.value = text;

  // Avoid scrolling to bottom
  textArea.style.top = '0';
  textArea.style.left = '0';
  textArea.style.position = 'fixed';

  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    document.execCommand('copy');
  } catch (err) {
    console.error('Fallback: Oops, unable to copy', err);
  }

  document.body.removeChild(textArea);
}

/**
 * 复制文本。返回 Promise<boolean>。
 *
 * `writeText` 本身失败（无焦点、权限被拒）时**照旧 reject** —— 调用方
 * `handlerClipboard` 靠这个 reject 让工作流块报错，这里不能替它吞掉。
 */
export function copyTextToClipboard(text) {
  return new Promise((resolve, reject) => {
    if (!navigator.clipboard) {
      fallbackCopyTextToClipboard(text);
      resolve(true);
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => {
        resolve(true);
      })
      .catch((error) => {
        reject(error);
      });
  });
}
