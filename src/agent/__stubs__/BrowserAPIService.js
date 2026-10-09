/**
 * `@/service/browser-api/BrowserAPIService` 的测试桩。
 *
 * 真身经 webextension-polyfill 读浏览器 API，Node 里起不来。`src/utils/api.js`
 * 只用到 `storage.local.get/set`，且 offline 分支在调用它们之前就返回/抛错了 ——
 * 所以一个内存 Map 就够。给出「读不到任何键」的默认行为（get 返回 {}），
 * 与真实浏览器里 storage 为空时一致。
 */
const store = new Map();

const BrowserAPIService = {
  storage: {
    local: {
      async get(keys) {
        const out = {};
        if (typeof keys === 'string') {
          if (store.has(keys)) out[keys] = store.get(keys);
        }
        return out;
      },
      async set(obj) {
        Object.entries(obj || {}).forEach(([k, v]) => store.set(k, v));
      },
    },
  },
};

export default BrowserAPIService;
