/**
 * offline 构建的 manifest CSP 收紧（纯函数，可测）。
 *
 * 为什么单独成文件：这段逻辑原先内联在 `webpack.config.js` 的 CopyWebpackPlugin
 * transform 里 —— 那里跑不到、也断言不了。于是它是「安全加固 + 无测试」的组合，
 * 且用的是 `String.replace` 的**精确匹配**：目标串一改（换引号、加属性、调空格），
 * replace 会静默返回原串，offline 构建就带着 loosened CSP 发出去，而构建日志、
 * lint、测试全绿。抽成纯函数后，那个「静默 no-op」变成可断言的失败（T-194）。
 *
 * 作用范围说明（为什么只对 Firefox 有效，且这是对的）：
 *   `'unsafe-inline' https:` 只出现在 `src/manifest.firefox.json`（MV2 默认较松）；
 *   `src/manifest.chrome.json` 是 MV3，压根不声明 content_security_policy ——
 *   MV3 不声明时用最严默认值（script-src 'self'），本就没有可收紧的东西。
 *   所以「Chrome 走不到这个分支」不是遗漏，是正确分流。
 *
 * 未声明 CSP 的 manifest（Chrome MV3）原样返回，不做任何事。
 */

/** CSP 里要抠掉的那一段。改动它必须同步改测试，测试就是防它悄悄失效的闸。 */
const CSP_REMOTE_SNIPPET = " 'unsafe-inline' https:";

/**
 * 按 offline 与否处理 manifest 对象的 CSP。
 *
 * @param {Object} manifestObj 已 JSON.parse 的 manifest（会被就地修改）
 * @param {boolean} isOffline 是否 offline 构建（webpack 侧传 OFFLINE_MODE === '1'）
 * @returns {Object} 同一个 manifestObj（就地改，方便链接）
 * @throws {Error} offline 且 manifest 声明了 CSP、但目标串找不到时 —— 宁可构建期
 *   炸掉，也不要静默放行一个未被收紧的 CSP
 */
function applyOfflineCsp(manifestObj, isOffline) {
  if (!isOffline) return manifestObj;

  const csp = manifestObj && manifestObj.content_security_policy;

  // 没声明 CSP：MV3 的默认值已经够严，无需处理（见文件头）。
  if (!csp) return manifestObj;

  if (csp.indexOf(CSP_REMOTE_SNIPPET) === -1) {
    throw new Error(
      `applyOfflineCsp: manifest 声明了 content_security_policy，但找不到要移除的片段 ${JSON.stringify(
        CSP_REMOTE_SNIPPET
      )}。当前值：${JSON.stringify(
        csp
      )} —— 说明 manifest 的 CSP 措辞变了。请同步更新 CSP_REMOTE_SNIPPET，否则 offline 构建会静默带着允许内联/远程脚本的 CSP 发布（T-194）。`
    );
  }

  manifestObj.content_security_policy = csp.replace(CSP_REMOTE_SNIPPET, '');
  return manifestObj;
}

module.exports = { applyOfflineCsp, CSP_REMOTE_SNIPPET };
