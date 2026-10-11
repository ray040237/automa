/**
 * agentHost 接线工厂的行为测试（T-227）。
 *
 * agentHost.js 在 T-227 之前是全仓唯一零测试的 agent 模块：test glob 不收
 * src/composable/**、文件顶部硬 import browser 与 @/agent 桶，唯一的「守卫」
 * 是 panelUi.test.js 抓源码正则。拆成 `createAgentHost(deps, ui)` 纯工厂之后，
 * 下面这些接线行为第一次可以直接断言 —— 每一组都对应一类真实事故
 * （T-02 确认门挂死 / T-08 监听泄漏 / T-67 判空 / T-12 计数 / T-195~198
 * syncTarget 单写入点）。
 *
 * 覆盖边界：只测工厂（纯接线）；Vue 薄壳（useAgentHost）与宿主入口
 * （usePageAgentHost / useHostBootstrap）不在 node --test 的能力范围，
 * 它们的形状由 panelUi.test.js 的源码守卫与构建验证兜着。
 */
import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installGlobals } from '../agent/__stubs__/globals';

// T-228：薄壳补生产缺省后 agentHost.js 重新 import @/agent 桶，链条拉进
// shared.js —— 它顶层读构建期全局（webpack DefinePlugin）。静态 import 在
// 任何用户代码之前求值，全局来不及注入就 ReferenceError。必须先 installGlobals
// 再**动态** import（与 assembly.test.js 同款模式，同一条注释的理由）。
installGlobals();

const { AGENT_EVENTS } = await import('@/agent/events');
const { createAgentHost } = await import('./agentHost');

/* ───────────────────────── 夹具 ───────────────────────── */

function makeBrowser() {
  const listeners = { onRemoved: [], onUpdated: [], onActivated: [] };
  const reg = (name) => ({
    addListener: (f) => listeners[name].push(f),
    removeListener: (f) => {
      const at = listeners[name].indexOf(f);
      if (at !== -1) listeners[name].splice(at, 1);
    },
  });

  return {
    tabs: {
      onRemoved: reg('onRemoved'),
      onUpdated: reg('onUpdated'),
      onActivated: reg('onActivated'),
    },
    windows: {
      getCurrent: async () => ({ id: 9 }),
    },
    __listeners: listeners,
    __emit(channel, ...args) {
      listeners[channel].slice().forEach((f) => f(...args));
    },
  };
}

/**
 * IO 全家桶的 fake。createAgentRuntime 产一个可观察的假 runtime，
 * send/openSession/newSession 等动作都留痕。
 */
function makeIo(over = {}) {
  const browser = over.browser || makeBrowser();
  const created = [];
  const calls = {
    listIndex: 0,
    resolveTarget: [],
    openSession: [],
    loadConfig: 0,
  };

  const io = {
    browser,
    configIO: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
    },
    sessionStore: {
      listIndex: async () => {
        calls.listIndex += 1;
        return over.sessions || [];
      },
      load: async () => null,
      save: async () => {},
      remove: async () => {},
      patchTitle: async () => null,
    },
    listTabs: async () => [],
    resolveTarget: async (opts) => {
      calls.resolveTarget.push(opts);
      return over.resolvedTab === undefined
        ? { id: 1, url: 'https://a.com/x', title: 'A', windowId: 9 }
        : over.resolvedTab;
    },
    loadConfig: async () => {
      calls.loadConfig += 1;
      return (
        over.config || {
          model: 'm',
          apiKey: 'k',
          baseUrl: 'https://api.test/v1',
        }
      );
    },
    loadConfigDoc: async () =>
      over.doc === undefined ? { providers: [] } : over.doc,
    saveConfig: async () => ({ ok: true }),
    createAgentRuntime: (deps) => {
      const rt = {
        deps,
        newSessionCalls: 0,
        lastSetTarget: undefined,
        sendArgs: null,
        // send 的默认实现：记下 onEvent 供测试驱动事件，返回最小结果
        send: over.send
          ? over.send
          : async (args) => {
              rt.sendArgs = args;
              if (over.emitOnSend) over.emitOnSend(args, rt);
              return { sessionId: 's1', usage: { input: 1, output: 2 } };
            },
        openSession: async (id) => {
          calls.openSession.push(id);
          return (
            over.openSessionResult || {
              events: [],
              targetTab: null,
              targetPinned: false,
              targetState: 'none',
            }
          );
        },
        newSession: () => {
          rt.newSessionCalls += 1;
        },
        deleteSession: async () => {},
        abort: () => {},
        enqueueInstruction: () => {
          rt.enqueued = (rt.enqueued || 0) + 1;
          return true;
        },
        pendingInstructionCount: () => rt.enqueued || 0,
        getSessionId: () => null,
        setTargetTab: (tab) => {
          rt.lastSetTarget = tab;
        },
        pickTab: () => {},
        unpinTab: () => false,
      };
      created.push(rt);
      return rt;
    },
    __created: created,
    __calls: calls,
  };
  return io;
}

const makeUi = () => ({
  t: (key) => key,
  toast: { success: () => {}, error: () => {} },
  dialog: { confirm: () => {} },
  routerPush: async () => {},
});

function makeHost(io, over = {}) {
  return createAgentHost(
    {
      browser: io.browser,
      configIO: io.configIO,
      sessionStore: io.sessionStore,
      listTabs: io.listTabs,
      resolveTarget: io.resolveTarget,
      loadConfig: io.loadConfig,
      loadConfigDoc: io.loadConfigDoc,
      saveConfig: io.saveConfig,
      createAgentRuntime: io.createAgentRuntime,
      enabledGroups: ['page', 'context', 'tab'],
      getWorkflowId: () => null,
      getVariables: async () => ({ bound: false }),
      ...over,
    },
    makeUi()
  );
}

const lastRuntime = (io) => io.__created[io.__created.length - 1];

beforeEach(() => {});

/* ───────────────────── ① 装配期校验（行为化，替源码正则） ───────────────────── */

describe('装配期必填校验', () => {
  test('缺 getVariables 直接抛（T-50：不给「变量为空」的兜底）', () => {
    const io = makeIo();
    assert.throws(
      () => makeHost(io, { getVariables: undefined }),
      /deps\.getVariables 必填/
    );
  });

  test('缺 enabledGroups / getWorkflowId 同样装配期炸', () => {
    const io = makeIo();
    assert.throws(
      () =>
        createAgentHost(
          {
            browser: io.browser,
            configIO: io.configIO,
            sessionStore: io.sessionStore,
            listTabs: io.listTabs,
            resolveTarget: io.resolveTarget,
            loadConfig: io.loadConfig,
            loadConfigDoc: io.loadConfigDoc,
            saveConfig: io.saveConfig,
            createAgentRuntime: io.createAgentRuntime,
            getWorkflowId: () => null,
            getVariables: async () => ({ bound: false }),
          },
          makeUi()
        ),
      /deps\.enabledGroups 必填/
    );
    assert.throws(
      () => makeHost(io, { getWorkflowId: undefined }),
      /deps\.getWorkflowId 必填/
    );
  });
});

/* ───────────────────── ② guardAgentSwitch 的顺序 ───────────────────── */

describe('会话切换守卫（T-02 的执行层）', () => {
  test('busy 时不能切：newSession 不生效', async () => {
    const io = makeIo();
    const host = makeHost(io);
    await host.init();

    host.busy = true;
    await host.newSession();

    assert.equal(lastRuntime(io).newSessionCalls, 0, 'busy 否决');
    assert.equal(host.busy, true);
  });

  test('挂着确认门时切换：先 resolve(false) 再继续（顺序 = planSwitch）', async () => {
    const io = makeIo();
    const host = makeHost(io);
    await host.init();

    let resolvedWith;
    // 与生产 resolve 闭包同形：应答时清挂起（agentHost askAgentConfirmation）
    host.pendingConfirm = {
      resolve: (v) => {
        resolvedWith = v;
        host.pendingConfirm = null;
      },
    };
    host.events.push({ kind: 'agent:text-delta', text: '历史' });

    await host.newSession();

    assert.equal(resolvedWith, false, '挂起的确认门必须被放行（否）');
    assert.equal(host.pendingConfirm, null);
    assert.equal(lastRuntime(io).newSessionCalls, 1, '否掉之后照常切');
    assert.deepEqual(host.events, [], '新会话清空事件');
  });

  test('dismissPendingConfirm：无挂起时安全空转，有挂起时发否', () => {
    const io = makeIo();
    const host = makeHost(io);

    assert.doesNotThrow(() => host.dismissPendingConfirm(), '判空安全');

    let resolvedWith;
    host.pendingConfirm = {
      resolve: (v) => {
        resolvedWith = v;
      },
    };
    host.dismissPendingConfirm();
    assert.equal(resolvedWith, false);
  });

  test('dispose：先放行确认门，再成对摘掉三个监听器（T-08）', () => {
    const io = makeIo();
    const b = io.browser;
    const host = makeHost(io);

    assert.equal(b.__listeners.onRemoved.length, 1);
    assert.equal(b.__listeners.onUpdated.length, 1);
    assert.equal(b.__listeners.onActivated.length, 1);

    let resolvedWith;
    host.pendingConfirm = {
      resolve: (v) => {
        resolvedWith = v;
      },
    };

    host.dispose();

    assert.equal(resolvedWith, false, '卸载前放行确认门');
    assert.equal(b.__listeners.onRemoved.length, 0, 'removeListener 成对');
    assert.equal(b.__listeners.onUpdated.length, 0);
    assert.equal(b.__listeners.onActivated.length, 0);
  });
});

/* ───────────────────── ③ 监听器的事件分发（T-08/T-215 的执行层） ───────────────────── */

describe('标签页监听分发', () => {
  test('监听器在装配时就挂上（不等 init）', () => {
    const io = makeIo();
    makeHost(io);
    assert.equal(io.browser.__listeners.onRemoved.length, 1);
  });

  test('未初始化时事件不炸（agent.targetTab 为 null 走早退）', () => {
    const io = makeIo();
    makeHost(io);
    assert.doesNotThrow(() => {
      io.browser.__emit('onRemoved', 5);
      io.browser.__emit('onUpdated', 5, { url: true }, null);
      io.browser.__emit('onActivated', { tabId: 5 });
    });
  });

  test('固定目标页被关：只标健康态 closed，不换页', async () => {
    const io = makeIo();
    const host = makeHost(io);
    await host.init();

    host.targetTab = { id: 5, url: 'https://a.com/x', title: 'A' };
    host.targetPinned = true;
    host.targetState = 'ok';

    io.browser.__emit('onRemoved', 5);

    assert.equal(host.targetState, 'closed', '红色失效态（T-08）');
    assert.equal(host.targetTab.id, 5, '只标状态，不自动换页');
    assert.equal(host.targetPinned, true);
  });

  test('自动态下页面导航：重解析并回写 runtime + syncTarget（T-195~198 单写入点）', async () => {
    const io = makeIo({
      resolvedTab: { id: 8, url: 'https://b.com/y', title: 'B', windowId: 9 },
    });
    const host = makeHost(io);
    await host.init();

    host.targetTab = { id: 7, url: 'https://a.com/x', title: 'A' };
    host.targetPinned = false;

    io.browser.__emit('onUpdated', 7, { url: 'https://b.com/y' }, { id: 7 });
    // followOrHealth 里 resetTargetToAuto 是 fire-and-forget —— flush 微任务
    await new Promise((r) => {
      setTimeout(r, 0);
    });

    assert.equal(host.targetTab.id, 8, 'chip 跟到新页');
    assert.equal(host.targetPinned, false, '自动态来源');
    assert.equal(host.targetState, 'ok');
    assert.equal(
      lastRuntime(io).lastSetTarget.id,
      8,
      '模型操作同一页（T-198）'
    );
    assert.equal(io.__calls.resolveTarget.length, 2, 'init 一次 + 重解析一次');
  });
});

/* ───────────────────── ④ resetTargetToAuto 兜底链 ───────────────────── */

describe('回到自动跟随', () => {
  test('newSession 后重解析：windowId 来自当前窗口，回写 runtime 与面板', async () => {
    const io = makeIo();
    const host = makeHost(io);
    await host.init();

    host.targetTab = { id: 5, url: 'https://old.com/x', title: '旧' };
    host.targetPinned = true;

    await host.newSession();

    assert.deepEqual(
      io.__calls.resolveTarget.at(-1),
      { windowId: 9 },
      'windowId 显式取当前窗口'
    );
    assert.equal(host.targetPinned, false, '新会话回自动态');
    assert.equal(host.targetState, 'ok');
    assert.equal(lastRuntime(io).lastSetTarget.url, 'https://a.com/x');
  });

  test('windows.getCurrent 抛错也照常重解析（windowId 退化 undefined）', async () => {
    const io = makeIo();
    io.browser.windows.getCurrent = async () => {
      throw new Error('no window');
    };
    const host = makeHost(io);
    await host.init();

    const before = io.__calls.resolveTarget.length;
    await host.newSession();

    assert.deepEqual(io.__calls.resolveTarget.at(-1), { windowId: undefined });
    assert.equal(io.__calls.resolveTarget.length, before + 1);
  });
});

/* ───────────────────── ⑤ init 序列 ───────────────────── */

describe('惰性初始化', () => {
  test('runtime 只建一次；config/modelCatalog 按形状注入', async () => {
    const io = makeIo({
      doc: {
        providers: [
          {
            id: 'p1',
            label: 'P1',
            hasKey: true,
            models: [{ id: 'm1' }, { id: '' }],
          },
          { id: '', models: [] },
        ],
      },
    });
    const host = makeHost(io);

    await host.init();
    await host.init();

    assert.equal(io.__created.length, 1, 'init 幂等');
    const rt = lastRuntime(io);
    assert.equal(
      typeof rt.deps.getVariables,
      'function',
      'getVariables 原样透传'
    );
    assert.equal(typeof rt.deps.getConfig, 'function');
    assert.equal(typeof rt.deps.getInstructions, 'function');
    assert.equal(typeof rt.deps.getSkillIndex, 'function');
    assert.equal(rt.deps.sessionStore, io.sessionStore, '注入的是同一个仓库');
    assert.deepEqual(
      host.modelCatalog,
      [{ id: 'p1', label: 'P1', hasKey: true, models: ['m1'] }],
      '只取 id/label/hasKey/models，模型 id 过滤空值'
    );
  });

  test('modelCatalog 读失败不拦启动：退化成空数组', async () => {
    const io = makeIo();
    io.loadConfigDoc = async () => {
      throw new Error('storage broken');
    };
    const host = makeHost(io);

    await host.init();

    assert.deepEqual(host.modelCatalog, []);
    assert.ok(host.runtime, 'runtime 照常建立');
  });

  test('初始化完打开最近的会话', async () => {
    const io = makeIo({ sessions: [{ id: 's-new' }, { id: 's-old' }] });
    const host = makeHost(io);

    await host.init();

    assert.deepEqual(io.__calls.openSession, ['s-new'], '列表首个 = 最近');
    assert.equal(host.sessionId, 's-new');
  });
});

/* ───────────────────── ⑥ send 路径 ───────────────────── */

describe('send 接线', () => {
  test('runtime 未就绪时给一句人话，不抛 TypeError（T-67）', async () => {
    const io = makeIo();
    const host = makeHost(io);

    await host.send('hi');

    const last = host.events.at(-1);
    assert.equal(last.kind, AGENT_EVENTS.ERROR);
    assert.match(last.message, /initializing/);
    assert.equal(host.busy, false);
  });

  test('busy 时入队插话并给常驻反馈，计数随事件同步（T-12）', async () => {
    const io = makeIo();
    const host = makeHost(io);
    await host.init();
    lastRuntime(io).pendingInstructionCount = () => 2;

    host.busy = true;
    await host.send('先等等');

    assert.equal(lastRuntime(io).enqueued, 1);
    const last = host.events.at(-1);
    assert.equal(last.kind, AGENT_EVENTS.SYSTEM_NOTICE);
    assert.match(last.text, /queued/);
    assert.equal(host.busy, true, 'busy 不被打断');
    // 入队/送达没有专属事件，面板计数借事件到达的时机重读运行时真实队列长度
    assert.equal(host.pendingInterjections, 2);
  });

  test('正常发送：userText 直达 runtime，收尾同步 sessionId/usage 并刷新列表', async () => {
    const io = makeIo();
    const host = makeHost(io);
    await host.init();
    const listCalls = io.__calls.listIndex;

    await host.send('你好');

    assert.equal(lastRuntime(io).sendArgs.userText, '你好');
    assert.equal(host.sessionId, 's1');
    assert.deepEqual(host.usage, { input: 1, output: 2 });
    assert.equal(host.busy, false);
    assert.ok(io.__calls.listIndex > listCalls, 'finally 里刷新会话列表');
  });

  test('DONE(aborted) 补一条中止回执（T-11）', async () => {
    const io = makeIo({
      emitOnSend: (args) => {
        args.onEvent({ kind: AGENT_EVENTS.DONE, aborted: true });
      },
    });
    const host = makeHost(io);
    await host.init();

    await host.send('你好');

    const last = host.events.at(-1);
    assert.equal(last.kind, AGENT_EVENTS.SYSTEM_NOTICE);
    assert.match(last.text, /aborted/);
  });

  test('配置错误：specific 文案优先（T-66 三档优先级）', async () => {
    const io = makeIo({
      send: async () => {
        const err = new Error('接口地址必须以 http:// 开头（当前：ftp://x）');
        err.kind = 'config';
        err.specific = true;
        throw err;
      },
    });
    const host = makeHost(io);
    await host.init();

    await host.send('hi');

    const last = host.events.at(-1);
    assert.equal(last.kind, AGENT_EVENTS.ERROR);
    assert.match(last.message, /ftp:\/\/x/, 'specific 错误带用户填的值');
  });
});

/* ───────────────────── ⑦ 设置页落点（T-219 的执行层） ───────────────────── */

describe('goToAgentSettings 注入优先级', () => {
  test('宿主给了 onOpenSettings 就不走路由', async () => {
    const io = makeIo();
    const opened = [];
    const ui = {
      ...makeUi(),
      routerPush: async () => {
        throw new Error('不该走路由');
      },
    };
    const host = createAgentHost(
      {
        browser: io.browser,
        configIO: io.configIO,
        sessionStore: io.sessionStore,
        listTabs: io.listTabs,
        resolveTarget: io.resolveTarget,
        loadConfig: io.loadConfig,
        loadConfigDoc: io.loadConfigDoc,
        saveConfig: io.saveConfig,
        createAgentRuntime: io.createAgentRuntime,
        enabledGroups: ['page', 'context', 'tab'],
        getWorkflowId: () => null,
        getVariables: async () => ({ bound: false }),
        onOpenSettings: async () => {
          opened.push(true);
        },
      },
      ui
    );

    await host.goToSettings();
    assert.deepEqual(opened, [true]);
  });

  test('没给 onOpenSettings 时回退路由 /agent（不是 /settings/agent，T-219）', async () => {
    const io = makeIo();
    const pushed = [];
    const ui = {
      ...makeUi(),
      routerPush: async (loc) => pushed.push(loc),
    };
    const host = createAgentHost(
      {
        browser: io.browser,
        configIO: io.configIO,
        sessionStore: io.sessionStore,
        listTabs: io.listTabs,
        resolveTarget: io.resolveTarget,
        loadConfig: io.loadConfig,
        loadConfigDoc: io.loadConfigDoc,
        saveConfig: io.saveConfig,
        createAgentRuntime: io.createAgentRuntime,
        enabledGroups: ['page', 'context', 'tab'],
        getWorkflowId: () => null,
        getVariables: async () => ({ bound: false }),
      },
      ui
    );

    await host.goToSettings();
    assert.deepEqual(pushed, [{ path: '/agent' }]);
  });
});

/* ───────────────────── ⑧ 薄壳的生产缺省（T-228 源码守卫） ───────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * T-228 回归守卫。这次事故的类别正是「薄壳没有测试」：工厂只认注入、测试
 * 传全套 fake，生产缺省薄壳不补的话，三个宿主 setup 里当场 TypeError，而
 * 本文件 22 条行为测试全绿 —— node --test 看不见生产装配点。薄壳又不能在
 * node 里真调（要 Vue setup 上下文），所以只能源码守卫钉形状：
 * 九项 IO 缺省一项不能少，且 `...deps` 必须排在缺省**之后**（顺序反了，
 * 宿主的覆盖口就被缺省顶掉 —— enabledGroups 等声明会静默失效）。
 */
describe('薄壳的生产缺省（T-228）', () => {
  const SHELL_DEFAULTS = [
    'browser',
    'configIO',
    'sessionStore',
    'listTabs',
    'resolveTarget',
    'loadConfig',
    'loadConfigDoc',
    'saveConfig',
    'createAgentRuntime',
  ];

  function shellBody() {
    const src = readFileSync(join(HERE, 'agentHost.js'), 'utf8');
    const start = src.indexOf('export function useAgentHost');
    const end = src.indexOf('onBeforeUnmount(host.dispose)', start);

    assert.ok(start !== -1 && end !== -1, '薄壳锚点找不到，守卫本身失效');
    return src.slice(start, end);
  }

  test('九项生产 IO 缺省一项不能少', () => {
    const body = shellBody();

    for (const key of SHELL_DEFAULTS) {
      assert.ok(
        body.includes(`\n      ${key},`),
        `薄壳缺生产缺省 ${key} —— 漏了它，宿主 setup 里就是 undefined（T-228 同款事故）`
      );
    }
  });

  test('...deps 在缺省之后展开（宿主覆盖口不能被缺省顶掉）', () => {
    const body = shellBody();
    const lastDefault = Math.max(
      ...SHELL_DEFAULTS.map((key) => body.indexOf(`\n      ${key},`))
    );
    const spread = body.indexOf('...deps');

    assert.ok(spread !== -1, '薄壳必须展开 ...deps（宿主显式传入才有覆盖口）');
    assert.ok(
      spread > lastDefault,
      '...deps 必须在九项缺省之后 —— 在前的话宿主传的项会被缺省覆盖，声明静默失效'
    );
  });
});
