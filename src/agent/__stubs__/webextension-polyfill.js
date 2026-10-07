/**
 * webextension-polyfill 的测试桩。
 *
 * 只实现 agent 真正用到的那几个面（storage / tabs / runtime），
 * 并且都可被测试改写 —— 这样能覆盖「配置读不到」「标签页消息失败」这类分支。
 */
const store = new Map();

export const state = {
  tabs: [],
  sendMessageThrows: null,
  frames: null, // null = 未 mock；测试按需设成 [{frameId:0},{frameId:3},...]
  sendMessageByFrame: null, // null = 单实现；设成 (tabId,msg,frameId)=>response 覆盖
  // runtime 通道（装配层 toBackground 走 utils/message → 这里）。
  // null = 单实现，返回 undefined；设成 (payload)=>response 覆盖返回值。
  runtimeSendMessage: null,
  runtimeSendMessageThrows: null,
};

function area(storeObj) {
  return {
    async get(key) {
      if (key === null || key === undefined)
        return Object.fromEntries(storeObj);

      const out = {};

      for (const k of Array.isArray(key) ? key : [key]) {
        if (storeObj.has(k)) out[k] = storeObj.get(k);
      }

      return out;
    },
    async set(obj) {
      Object.entries(obj || {}).forEach(([k, v]) => storeObj.set(k, v));
    },
    async remove(key) {
      (Array.isArray(key) ? key : [key]).forEach((k) => storeObj.delete(k));
    },
    async clear() {
      storeObj.clear();
    },
  };
}

const browser = {
  storage: {
    local: area(store),
    sync: area(new Map()),
  },
  tabs: {
    async query() {
      return state.tabs;
    },
    async sendMessage(tabId, msg, options) {
      if (state.sendMessageThrows) throw state.sendMessageThrows;
      if (state.sendMessageByFrame)
        return state.sendMessageByFrame(tabId, msg, options && options.frameId);

      return { ok: true, tabId, msg };
    },
  },
  webNavigation: {
    async getAllFrames() {
      return state.frames || [{ frameId: 0 }];
    },
  },
  runtime: {
    getURL: (p) => `chrome-extension://stub/${p}`,
    getManifest: () => ({ version: '0.0.0-test' }),
    async sendMessage(payload) {
      if (state.runtimeSendMessageThrows) throw state.runtimeSendMessageThrows;
      if (state.runtimeSendMessage) return state.runtimeSendMessage(payload);

      return undefined;
    },
  },
};

export function resetBrowser() {
  store.clear();
  state.tabs = [];
  state.sendMessageThrows = null;
  state.frames = null;
  state.sendMessageByFrame = null;
  state.runtimeSendMessage = null;
  state.runtimeSendMessageThrows = null;
}

export default browser;
