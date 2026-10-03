/**
 * 极简 chrome.* 桩，只为让 build/ 里的 newtab 页能在普通 http 上跑起来。
 * webextension-polyfill 走的是「传 callback」的老式 API，所以方法必须是 callback 风格；
 * BrowserAPIEventHandler 在 import 期就会把所有 isEvent 的 api() 求值一遍，
 * 少一个命名空间整个 app 就起不来（曾卡在 webNavigation.onCreatedNavigationTarget）。
 */
(() => {
  const store = new Map();

  function ok(result, callback) {
    if (typeof callback === 'function') setTimeout(() => callback(result), 0);
    return undefined;
  }

  const noop = (...args) => ok(undefined, args[args.length - 1]);

  const event = () => ({
    addListener() {},
    removeListener() {},
    hasListener: () => false,
    hasListeners: () => false,
  });

  const action = () => ok({}, args_last(arguments));
  function args_last(a) {
    return a[a.length - 1];
  }

  window.chrome = {
    runtime: {
      id: 'repro-harness',
      lastError: null,
      getManifest: () => ({ version: '1.30.0', name: 'Automa', manifest_version: 3 }),
      getURL: (p) => new URL(p, location.origin).href,
      sendMessage: noop,
      connect: () => ({
        onMessage: event(),
        onDisconnect: event(),
        postMessage() {},
      }),
      onMessage: event(),
      onInstalled: event(),
      onConnect: event(),
    },
    storage: {
      onChanged: event(),
      local: {
        get: (keys, cb) => {
          const out = {};
          if (keys === null || keys === undefined) {
            store.forEach((v, k) => { out[k] = v; });
          } else if (typeof keys === 'string') {
            if (store.has(keys)) out[keys] = store.get(keys);
          } else if (Array.isArray(keys)) {
            keys.forEach((k) => { if (store.has(k)) out[k] = store.get(k); });
          } else if (typeof keys === 'object') {
            Object.keys(keys).forEach((k) => {
              out[k] = store.has(k) ? store.get(k) : keys[k];
            });
          }
          ok(out, cb);
        },
        set: (obj, cb) => {
          Object.entries(obj).forEach(([k, v]) => store.set(k, v));
          ok(undefined, cb);
        },
        remove: (keys, cb) => {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => store.delete(k));
          ok(undefined, cb);
        },
        clear: (cb) => { store.clear(); ok(undefined, cb); },
      },
      sync: { get: (k, cb) => ok({}, cb), set: noop, remove: noop, clear: noop },
    },
    tabs: {
      group: noop,
      get: (id, cb) => ok({ id, url: 'https://example.com/', title: 'Example', windowId: 1 }, cb),
      query: (q, cb) => ok(
        [{ id: 1, url: 'https://example.com/', title: 'Example', windowId: 1, active: true }],
        cb,
      ),
      sendMessage: noop,
      create: (o, cb) => ok({ id: 99, ...o }, cb),
      update: noop,
      remove: noop,
      reload: noop,
      goBack: noop,
      goForward: noop,
      setZoom: noop,
      captureTab: noop,
      captureVisibleTab: noop,
      onRemoved: event(),
      onUpdated: event(),
      onCreated: event(),
      onActivated: event(),
    },
    windows: {
      get: noop,
      update: noop,
      create: noop,
      remove: noop,
      getAll: (q, cb) => ok([{ id: 1, focused: true }], cb),
      getCurrent: (o, cb) => ok({ id: 1, focused: true }, cb),
      onRemoved: event(),
      WINDOW_ID_CURRENT: -2,
    },
    webNavigation: {
      onCreatedNavigationTarget: event(),
      onErrorOccurred: event(),
      getAllFrames: noop,
    },
    proxy: { settings: { clear: noop, set: noop, get: noop } },
    debugger: {
      onEvent: event(),
      attach: noop,
      detach: noop,
      sendCommand: noop,
      getTargets: noop,
    },
    permissions: { contains: noop, request: noop },
    cookies: { get: noop, getAll: noop, remove: noop, set: noop },
    downloads: { search: noop, download: noop, onCreated: event(), onChanged: event(), onDeterminingFilename: event() },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setIcon: noop },
    notifications: { create: noop },
    extension: { isAllowedFileSchemeAccess: noop, getURL: (p) => p },
    i18n: { getMessage: (k) => k, getUILanguage: () => 'en-US' },
    scripting: { executeScript: noop },
  };
})();
