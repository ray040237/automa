/**
 * 目标页账本（T-224）：createAgentRuntime 里摊着的 7 个目标页闭包变量
 * （targetTab / pins / focusedTabId / lastNoticeKey / lastRead / fpNoticeKey /
 * fpCheckPending）加跨会话锁，整本收进这一个 module。
 *
 * interface 的三条契约（T-224 grilling 敲定）：
 *  1. **无副作用出口**：focusTab / pickTab / setTarget 只改账本并返回结果，
 *     不发事件 —— `agent:target-tab` 由装配层（index.js）拿返回值后发，
 *     「轮内通道开着才发」的时序留在那边。
 *  2. **严格等价**：从 index.js 平移时连两个已知怪癖一起搬（见
 *     `resetForNewSession` / `restoreFromRecord` 的注释），修不修是
 *     T-224 批准后的另一个裁决，不在这里顺手改。
 *  3. **browser 只经注入进来**：browserApi（tabs.get）与 readPage（指纹
 *     probe 的读页）都是参数 —— 本文件不 import webextension-polyfill，
 *     node --test 直跑（与 tab.js 同一纪律）。
 *
 * 跨会话锁：`tabLocks` / `runtimeSeq` 刻意留在**模块作用域** —— 锁的本意就是
 * 同一个 JS 上下文里跨 runtime 共享（两个宿主同住一个 newtab 页），搬进工厂
 * 闭包就失效了。这是 UX 防误伤，不是安全边界（pie 的 R7 收窄语义）。
 *
 * 纯判定与文案仍在 `targetState.js`（有单测）；本文件只持状态、去重键、
 * latch 与 IO 编排 ——「纯函数核 + 有状态壳」的分界与 T-43 当初的拆法一致。
 */

import { normalize, originOf } from './tab';
import {
  fingerprintChangedNotice,
  fingerprintKey,
  initialPinsFromTab,
  originDriftKey,
  originDriftNotice,
  restoredTarget,
  tabClosedNotice,
  upsertPin,
} from './targetState';

/** tabId -> 锁持有者 id；模块级单例，跨 runtime 共享（见头注）。 */
const tabLocks = new Map();
let runtimeSeq = 0;

/**
 * @param {Object} deps
 * @param {Object} deps.browserApi 只用 `tabs.get`；由装配层注入（index.js
 *   是唯一 import polyfill 的文件）
 * @param {(tab: Object, params: Object) => Promise<{text: string, fingerprint: (string|null)}|{ok: false, error: string}|string>} deps.readPage
 *   指纹 probe 用的读页实现（browserAdapter 的 readPageFromTab）。
 *   失败形状 {ok:false, error} 没有 fingerprint —— probe 与 recordRead
 *   只认 fingerprint，天然跳过（T-225，有测试钉住）。
 * @param {Object=} deps.initialTab 装配时宿主已解析出的目标页快照
 * @returns {Object} 账本：current / setTarget / pickTab / unpin / addPin /
 *   focusTab / getPins / getFocusedTabId / recordRead / preStepNotice /
 *   restoreFromRecord / captureInitialPin / acquireLocks / releaseLocks /
 *   isLockedByOther / prepareTurn / clearNoticeDedup / resetForNewSession /
 *   restoreTarget
 */
export function createTargetPageLedger({
  browserApi,
  readPage,
  initialTab = null,
}) {
  let targetTab = initialTab;
  // 会话 pin（P2 标签页定位）：{tabId, origin, title?} 列表。
  // pin 必须带 origin——Chrome 会复用已关闭 tab 的 id，裸信 tabId 会操作到
  // 复用后的陌生页面。pin 在会话内持续存在，首轮 send 自动捕获、
  // open_url/用户选择追加，删除会话即清空。
  let pins = [];
  let focusedTabId = null;
  // 同一条 notice 不逐条重复刷：只在内容变化时再次注入
  let lastNoticeKey = '';
  // 模型最后一次 read_page 看到的页面指纹（{tabId, fingerprint}）。
  // 只有它非空才说明「模型的结论依赖过某个页面状态」，才有比对的必要。
  let lastRead = null;
  // 指纹比对结果的去重键：页面变了提示一次，模型没重读不逐轮重复刷
  let fpNoticeKey = '';
  // 每轮 send 开头做一次轻量 probe（advisory，不进 prompt，每轮最多一次）
  let fpCheckPending = false;
  // 本账本（≈一个 runtime）的锁持有者 id
  const lockId = `rt_${(runtimeSeq += 1)}`;

  /** 当前目标页快照。 */
  const current = () => targetTab;

  const setTarget = (tab) => {
    targetTab = tab;
    return targetTab;
  };

  /**
   * 用户手动选定目标页（TabPicker）：设焦点、并入 pin。
   * 用户的意图是「以后就用这个页」，所以 pin 一起更新。
   * id<0 是浏览器会话恢复/分离页的假 tab，只换目标、不入 pin。
   */
  const pickTab = (tab) => {
    targetTab = tab;
    if (tab && typeof tab.id === 'number' && tab.id >= 0) {
      pins = [
        ...pins.filter((p) => p.tabId !== tab.id),
        { tabId: tab.id, origin: originOf(tab.url), title: tab.title },
      ];
      focusedTabId = tab.id;
    }
    return targetTab;
  };

  /**
   * 解除固定（T-164）：语义是「**取消固定 → 回到自动跟随**」，不是「变成
   * 无目标」。清空整份 pins 而不是只摘当前一个：pins 里还可能躺着模型
   * open_url 追加的页，只摘一个的话下一轮解析仍会命中 pins[0]。
   *
   * @returns {boolean} 之前确实有 pin（false = 本来就是自动态，宿主无需重解析）
   */
  const unpin = () => {
    const had = pins.length > 0;
    pins = [];
    focusedTabId = null;
    return had;
  };

  /** 追加 pin（按 tabId 去重）并设为焦点。 */
  const addPin = (pin) => {
    pins = upsertPin(pins, pin);
    focusedTabId = pin.tabId;
  };

  /**
   * 切换焦点：经 browserApi 取「这一刻」的新快照（标题/URL 可能已变），
   * 换目标 + 记焦点。返回新快照；事件（UI 同步）由调用方发。
   */
  const focusTab = async (tabId) => {
    const fresh = normalize(await browserApi.tabs.get(tabId));
    targetTab = fresh;
    focusedTabId = tabId;
    return fresh;
  };

  /** 工具侧的活值 getter 底座：工具要读到「这一刻」的 pin 列表。 */
  const getPins = () => pins;
  const getFocusedTabId = () => focusedTabId;

  /**
   * 模型 read_page 后记基线指纹（按 tabId 记，切页不串味）。下一轮 send
   * 开头拿它和一次轻量 probe 比，变了才提示重读（设计稿 §6.4）。
   */
  const recordRead = (res) => {
    if (res && typeof res === 'object' && res.fingerprint && targetTab)
      lastRead = { tabId: targetTab.id, fingerprint: res.fingerprint };
  };

  /**
   * 每步预检（advisory，由 loop 在每步开头调用）：
   *   - 焦点 tab 被关 → 通知模型
   *   - origin 与 pin 记录不一致（用户导航/重定向）→ 通知模型，由它决定去留
   * 顺带把快照刷新成「这一刻」的 url/title。
   */
  const preStepNotice = async () => {
    if (!targetTab || typeof targetTab.id !== 'number') return null;

    let tab;
    try {
      tab = await browserApi.tabs.get(targetTab.id);
    } catch {
      return tabClosedNotice(targetTab.id);
    }

    targetTab = normalize(tab);

    const pin = pins.find((p) => p.tabId === tab.id);
    const expected = pin ? pin.origin : '';
    const actual = originOf(tab.url);

    const drift = originDriftNotice({
      expected,
      actual,
      url: tab.url,
    });
    if (drift) {
      const key = originDriftKey(expected, actual);
      if (key === lastNoticeKey) return null;
      lastNoticeKey = key;
      return drift;
    }

    // 指纹比对（设计稿 §6.4）：advisory，runtime 不替模型决定读不读。
    // 每轮最多一次 probe；模型从没读过页就没有基线，跳过省一次 content 往返。
    if (fpCheckPending) {
      fpCheckPending = false;

      if (lastRead && lastRead.tabId === tab.id) {
        const res = await readPage(targetTab, {
          detail: 'probe',
          frame: 'top',
        });
        // 失败形状（{ok:false,error}，T-225）没有 fingerprint → fp 为 null，
        // 比对自然跳过：读不到页 ≠ 页面没变，不许产生假「没变」结论
        const fp = res && typeof res === 'object' ? res.fingerprint : null;

        if (fp && fp !== lastRead.fingerprint) {
          const notice = fingerprintChangedNotice({
            before: lastRead.fingerprint,
            after: fp,
          });
          if (notice) {
            const key = fingerprintKey(lastRead.fingerprint, fp);
            if (key !== fpNoticeKey) {
              fpNoticeKey = key;
              return notice;
            }
          }
        }
      }
    }

    return null;
  };

  /**
   * 从会话记录恢复 pins 与焦点（send 续接 / openSession 共用）。
   * 刻意不清 lastRead / fpNoticeKey —— 严格等价怪癖（T-224）：
   * lastRead 是全账本唯一切会话不重置的变量，跨会话残留指纹（今天无害：
   * probe 要求 tabId 匹配才触发）。
   */
  const restoreFromRecord = (recordPins, recordFocusedTabId) => {
    pins = recordPins || [];
    focusedTabId = recordFocusedTabId || null;
  };

  /** pin 的首轮自动捕获：pins 为空且目标页是真 tab 时收进来并设焦点。 */
  const captureInitialPin = () => {
    const initial = initialPinsFromTab(pins, targetTab, originOf);
    if (initial) {
      pins = initial;
      focusedTabId = targetTab.id;
    }
  };

  /** 在途锁：本轮期间占住全部 pin，别让另一个面板会话把页从脚底下抽走。 */
  const acquireLocks = () => {
    pins.forEach((p) => {
      if (!tabLocks.has(p.tabId)) tabLocks.set(p.tabId, lockId);
    });
  };

  /** 只释放自己持有的锁 —— 先占者优先，别人的锁不波及。 */
  const releaseLocks = () => {
    [...tabLocks.entries()].forEach(([tabId, owner]) => {
      if (owner === lockId) tabLocks.delete(tabId);
    });
  };

  /** 目标 tab 被另一个 runtime 的在途会话占住时为 true（守卫据此拒写）。 */
  const isLockedByOther = (tabId) => {
    const owner = tabId != null ? tabLocks.get(tabId) : null;
    return Boolean(owner && owner !== lockId);
  };

  /** 每轮 send 开头：重置漂移去重键 + 按基线指纹决定要不要 probe。 */
  const prepareTurn = () => {
    lastNoticeKey = '';
    // 只有模型读过页才值得花一次 probe 去比指纹（没有基线就无从比起）。
    // fpNoticeKey 故意不在每轮重置：页面变了提示一次，模型没重读就别逐轮刷屏。
    fpCheckPending = Boolean(lastRead);
  };

  /** 只清漂移去重键（openSession 用；prepareTurn 是「清键 + 开 latch」）。 */
  const clearNoticeDedup = () => {
    lastNoticeKey = '';
  };

  /**
   * 开新会话：清 pins / 焦点 / 漂移键。**不清** lastRead / fpNoticeKey /
   * targetTab —— 严格等价怪癖（T-224）：与重构前逐字一致，修不修另裁决。
   */
  const resetForNewSession = () => {
    pins = [];
    focusedTabId = null;
    lastNoticeKey = '';
  };

  /**
   * 打开已有会话时按 pins 还原目标页：focusedTabId 命中优先，否则首个 pin；
   * 活页恢复成当前目标，「页已关」给兜底快照 + closed 判定（T-197）。
   * 判定本体在 targetState.restoredTarget（纯函数、有单测）。
   */
  const restoreTarget = async () => {
    const pin = pins.find((p) => p.tabId === focusedTabId) || pins[0] || null;
    let liveTab = null;
    if (pin) {
      try {
        liveTab = normalize(await browserApi.tabs.get(pin.tabId));
      } catch {
        liveTab = null;
      }
    }

    const restored = restoredTarget(pin, liveTab);
    if (restored.tab) targetTab = restored.tab;
    return restored;
  };

  return {
    current,
    setTarget,
    pickTab,
    unpin,
    addPin,
    focusTab,
    getPins,
    getFocusedTabId,
    recordRead,
    preStepNotice,
    restoreFromRecord,
    captureInitialPin,
    acquireLocks,
    releaseLocks,
    isLockedByOther,
    prepareTurn,
    clearNoticeDedup,
    resetForNewSession,
    restoreTarget,
  };
}
