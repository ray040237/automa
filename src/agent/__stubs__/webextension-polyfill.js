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
    async sendMessage(tabId, msg) {
      if (state.sendMessageThrows) throw state.sendMessageThrows;

      return { ok: true, tabId, msg };
    },
  },
  runtime: {
    getURL: (p) => `chrome-extension://stub/${p}`,
    getManifest: () => ({ version: '0.0.0-test' }),
    sendMessage: async () => undefined,
  },
};

export function resetBrowser() {
  store.clear();
  state.tabs = [];
  state.sendMessageThrows = null;
}

export default browser;
