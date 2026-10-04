/**
 * 目标页身份状态机的纯函数核。
 *
 * T-43 第①步：preStepNotice 那三条 advisory 文案原本写死在 index.js 的闭包里
 * （大段字符串拼接 + 去重键判断混在一起），这里把「判定」与「文案」拆成
 * 纯函数返回值，runtime 只剩 IO 与去重键的存取：
 *   - tabClosedNotice / originDriftNotice / fingerprintChangedNotice
 *     判定是否该提示、提示什么；返回 null 即「不提示」。
 *   - originDriftKey / fingerprintKey：去重键构造。调用方按 lastNoticeKey /
 *     fpNoticeKey 比较决定是否抑制，语义与「同一事实只提示一次」一致。
 *   - initialPinsFromTab / upsertPin：pin 的两处写入点（首轮自动捕获、
 *     addPin 追加），都是纯数据变换，照搬进测试即可。
 *
 * 不变量：全部纯函数，不碰浏览器 API——index.js 是唯一持有 browser 的文件。
 */

/**
 * 焦点 tab 已关闭（browser.tabs.get 抛错即 tab gone）。
 *
 * @param {number} tabId
 * @returns {string}
 */
export function tabClosedNotice(tabId) {
  return (
    '系统提示：目标页（id ' +
    tabId +
    '）已经关闭。如需继续操作网页，请用 list_tabs 查看现有标签页并 focus_tab 切换，或用 open_url 打开新页面；也可以直接基于已有信息回答。'
  );
}

/**
 * origin 漂移判定：pin 记录的 origin 与当前 tab 实际 origin 不一致
 * （用户导航 / 重定向）才提示；任一侧缺失或不变时返回 null——
 * 宁可漏报也不误报，advisory 的信任度靠它维持。
 *
 * @param {{expected?: string, actual?: string, url?: string}} input
 * @returns {string|null}
 */
export function originDriftNotice({ expected, actual, url } = {}) {
  if (!expected || !actual || expected === actual) return null;
  return (
    '系统提示：目标页从 ' +
    expected +
    ' 导航到了 ' +
    actual +
    '（当前 URL: ' +
    url +
    '）。如果这不是你预期的跳转，此前基于旧页面做出的选择器/结论可能已失效，请重新 read_page 确认。'
  );
}

/** origin 漂移的去重键：同一组「从 X 到 Y」只提示一次。 */
export function originDriftKey(expected, actual) {
  return 'origin:' + expected + '>' + actual;
}

/**
 * 指纹变化判定：模型上次 read_page 见到的指纹与当前 probe 不一致才提示。
 *
 * @param {{before?: string, after?: string}} input
 * @returns {string|null}
 */
export function fingerprintChangedNotice({ before, after } = {}) {
  if (!before || !after || before === after) return null;
  return (
    '系统提示：目标页内容已变化（指纹 ' +
    before +
    ' → ' +
    after +
    '）。此前基于该页得出的选择器/结论可能已失效，请重新 read_page 确认；' +
    '如果页面没变，沿用上次结论即可，不要重复读页。'
  );
}

/** 指纹变化的去重键：同一组「前 → 后」只提示一次。 */
export function fingerprintKey(before, after) {
  return 'fp:' + before + '>' + after;
}

/**
 * 首轮 send 的 pin 自动捕获：pins 为空且目标页是一个真实 tab（id >= 0，
 * id<0 是浏览器会话恢复/分离页的假 tab，绝不能当 pin 身份）时，
 * 返回 [新 pin]，否则返回 null（表示「别动 pins」）。
 *
 * @param {Array} pins 当前 pin 列表
 * @param {Object|null} targetTab
 * @param {(url: string) => string} originOf 调用方注入，产出 URL 的 origin
 * @returns {Array|null}
 */
export function initialPinsFromTab(pins, targetTab, originOf) {
  if (pins && pins.length > 0) return null;
  if (!targetTab || typeof targetTab.id !== 'number' || targetTab.id < 0) {
    return null;
  }
  return [
    {
      tabId: targetTab.id,
      origin: originOf(targetTab.url),
      title: targetTab.title,
    },
  ];
}

/**
 * addPin 的纯数据版：按 tabId 去重追加。已存在时原样返回原数组引用
 * （调用方可以据此跳过「变了」的后续动作）。
 *
 * @param {Array} pins
 * @param {{tabId: number, origin?: string, title?: string}} pin
 * @returns {Array} 新数组或原引用
 */
export function upsertPin(pins, pin) {
  const list = pins || [];
  if (list.some((p) => p.tabId === pin.tabId)) return list;
  return [...list, pin];
}
