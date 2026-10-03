/**
 * 目标页解析。
 *
 * 为什么不能直接用 @/utils/helper 的 getActiveTab()（技术方案 R-1）：
 * 它按 url 通配模式（任意 scheme + 任意 host + 任意 path，外加 file:）过滤，
 * 叠加 active:true 与 getLastFocused() 查询。
 *
 * ⚠ 注意：写这类注释时不要把含星号的通配 URL 模式原样贴进来 —— 模式里那种
 * 「星号紧跟斜杠」的序列会提前闭合块注释，把后面整段变成语法错误。
 * agent 场景下用户几乎总在编辑器里，于是：
 *   - dashboard 是普通标签页 -> 返回 dashboard 自己（chrome-extension://…），
 *     content script 没注入到扩展页，之后每次工具调用都报
 *     "Could not establish connection"
 *   - dashboard 在 popup 窗口  -> getLastFocused 排除 popup 窗口（windowTypes:['normal']），
 *     拿到的是另一个窗口的标签页，与用户眼前的页面无关
 * 所以这里按四级优先级显式解析，并让用户在面板里手动改。
 *
 * browser API 通过参数注入（不 import webextension-polyfill），这样本文件
 * 可以被 node --test 直接跑。
 */

/** 无 content script、无法注入的 URL 前缀 */
const NON_INJECTABLE_PREFIXES = [
  'chrome://',
  'edge://',
  'about:',
  'moz-extension://',
  'chrome-extension://',
  'devtools://',
  'view-source:',
  'data:',
];

/** Chrome / Edge 扩展商店（即使有 content script 也禁止注入） */
const STORE_HOSTS = [
  'chromewebstore.google.com',
  'chrome.google.com',
  'microsoftedge.microsoft.com',
  'addons.mozilla.org',
];

/**
 * 该标签页能不能作为 agent 的目标页。
 *
 * @param {{url?: string}=} tab
 * @returns {boolean}
 */
export function isTargetable(tab) {
  const url = tab?.url;
  if (!url || typeof url !== 'string') return false;

  if (NON_INJECTABLE_PREFIXES.some((p) => url.startsWith(p))) return false;

  try {
    const { hostname } = new URL(url);
    if (STORE_HOSTS.includes(hostname)) return false;
    // 扩展商店在部分区域是 /detail/xxx 形式，上面已按 hostname 兜住
  } catch {
    return false; // 不是合法 URL
  }

  return true;
}

/**
 * 解析目标页。四级优先级（技术方案 §3.2）：
 *   1. 用户手选的 pinned tab（pinned 由面板维护，不存在则跳过）
 *   2. 最近访问过的可注入标签页（lastAccessed）
 *   3. 当前窗口里最近访问的可注入标签页
 *   4. 其他窗口里最近访问的可注入标签页
 *   -> 都没有则返回 null，由上层报 no-target-tab
 *
 * @param {Object} browserApi  需提供 tabs.query / windows.getAll
 * @param {{pinnedTabId?: number, windowId?: number}=} options
 * @returns {Promise<{id: number, url: string, title: string, windowId: number}|null>}
 */
export async function resolveTargetTab(browserApi, options = {}) {
  const { tabs } = browserApi;

  // —— 1. pinned ——
  if (options.pinnedTabId) {
    try {
      const tab = await tabs.get(options.pinnedTabId);
      if (isTargetable(tab)) return normalize(tab);
    } catch {
      // pinned 已被关掉，落到下一级
    }
  }

  const all = await tabs.query({});

  // lastAccessed 高的通常是用户刚看过的那个
  const candidates = [...all].sort(
    (a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)
  );

  // —— 2/3. 当前窗口优先 ——
  const inCurrent = candidates.find(
    (t) => t.windowId === options.windowId && isTargetable(t)
  );
  if (inCurrent) return normalize(inCurrent);

  // —— 4. 其他窗口 ——
  const elsewhere = candidates.find((t) => isTargetable(t));
  if (elsewhere) return normalize(elsewhere);

  return null;
}

/**
 * 当前窗口里所有可注入的标签页，供面板的下拉选择器使用。
 * 按窗口分组，最近访问的排前面。
 *
 * @param {Object} browserApi
 * @returns {Promise<Array<{windowId: number, tabs: Array<Object>}>>}
 */
export async function listTargetableTabs(browserApi) {
  const all = await browserApi.tabs.query({});
  const targetable = all
    .filter(isTargetable)
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));

  const byWindow = new Map();
  targetable.forEach((t) => {
    if (!byWindow.has(t.windowId)) byWindow.set(t.windowId, []);
    byWindow.get(t.windowId).push(t);
  });

  return [...byWindow.entries()].map(([windowId, tabs]) => ({
    windowId,
    tabs,
  }));
}

/**
 * 取 URL 的 origin。受限页（chrome:// 等）或解析不了的一律返回 ''——
 * 与 isTargetable 的口径一致：'' 是合法的 pin 身份（pin 栏要有东西可显示），
 * 但永远不等于任何真实 origin，所以不会误判「没有漂移」。
 *
 * @param {string=} url
 * @returns {string}
 */
export function originOf(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const { origin } = new URL(url);
    return origin && origin !== 'null' ? origin : '';
  } catch {
    return '';
  }
}

/**
 * 浏览器 tab 对象 -> runtime 内部快照。三处使用，导出共用。
 */
export function normalize(tab) {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title || tab.url,
    windowId: tab.windowId,
  };
}
