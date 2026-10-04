import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals } from './__stubs__/globals';

installGlobals();

// shared.js 用了构建期全局，必须在动态 import 之前注入。
// 真实 tasks 是这轮要验的对象，所以这里加载的是真的，不是桩。
await import('../utils/shared');

const {
  collectPromptFacts,
  configIO,
  createAgentRuntime,
  loadConfig,
  saveConfig,
} = await import('./index');
const { createSessionStore } = await import('./sessions');
const { AGENT_EVENTS } = await import('./events');

const TAB = { id: 7, url: 'https://shop.example.com/list', title: '商品列表' };

function deps(over = {}) {
  return {
    getConfig: async () => ({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      temperature: 0.2,
      apiKey: 'sk-test',
    }),
    requestConfirmation: async () => true,
    targetTab: TAB,
    ...over,
  };
}

describe('collectPromptFacts —— 装配层这一段的回归', () => {
  test('用真实 tasks 不抛，且块数是对的', () => {
    // 用户报的崩溃就在这里：tasks 是对象，裸 .reduce 直接 TypeError。
    const f = collectPromptFacts();

    assert.equal(typeof f.blockCount, 'number');
    assert.ok(f.blockCount > 50, `块数应远大于 0，实际 ${f.blockCount}`);
  });

  test('剔掉运行时没注入的 automaExecWorkflow', () => {
    const f = collectPromptFacts();

    assert.ok(!f.automaFuncs.includes('automaExecWorkflow'));
    assert.ok(f.automaFuncs.length > 0);
  });

  test('工具表完整带上来了', () => {
    const names = collectPromptFacts().tools.map((t) => t.name);

    assert.ok(names.includes('read_page'));
    assert.ok(names.includes('add_block'));
    assert.ok(names.includes('highlight_selector'));
  });
});

describe('createAgentRuntime', () => {
  test('没配 apiKey 时抛的是带 kind 的可识别错误', async () => {
    const rt = createAgentRuntime(
      deps({ getConfig: async () => ({ model: 'm', apiKey: '' }) })
    );

    await assert.rejects(
      () => rt.send({ userText: '你好', onEvent: () => {} }),
      (err) => {
        assert.equal(err.message, 'agent-not-configured');
        assert.equal(err.kind, 'config');

        return true;
      }
    );
  });

  test('setTargetTab 必须同时换掉 toolCtx 里的快照', () => {
    const rt = createAgentRuntime(deps());
    const next = { id: 9, url: 'https://other.example.com' };

    assert.equal(rt.setTargetTab(next), next);
    assert.equal(rt.getTargetTab(), next);
  });

  test('editor 惰性 getter：宿主 ref 未就绪时创建 runtime 不能炸', () => {
    let editor = null;
    const rt = createAgentRuntime(deps({ getEditor: () => editor }));

    editor = { nodes: [] };

    assert.ok(rt);
    assert.equal(rt.getTargetTab(), TAB);
  });
});

/**
 * 会话切换 / 删除 —— 面板上那两个入口背后的 runtime 契约。
 * 这里刻意用内存版会话仓库：要验的是切换语义，不是存储层（后者见 sessions.test.js）。
 */
describe('会话切换与删除', () => {
  const user = (text) => ({
    kind: AGENT_EVENTS.USER_MESSAGE,
    text,
    wire: text,
  });

  function memoryIO() {
    const data = new Map();
    return {
      data,
      get: async (k) => data.get(k),
      set: async (k, v) => data.set(k, v),
      remove: async (k) => data.delete(k),
    };
  }

  async function seededStore() {
    const store = createSessionStore(memoryIO());

    await store.save({
      id: 's-a',
      workflowId: null,
      status: 'active',
      createdAt: 1,
      lastAccessedAt: 1,
      events: [user('A')],
    });
    await store.save({
      id: 's-b',
      workflowId: null,
      status: 'active',
      createdAt: 2,
      lastAccessedAt: 2,
      events: [user('B1'), user('B2')],
    });

    return store;
  }

  test('openSession 读回历史，切换后 id 与事件都跟着换', async () => {
    const rt = createAgentRuntime(deps({ sessionStore: await seededStore() }));

    const a = await rt.openSession('s-a');
    assert.equal(rt.getSessionId(), 's-a');
    assert.deepEqual(
      a.events.map((e) => e.text),
      ['A']
    );

    const b = await rt.openSession('s-b');
    assert.equal(rt.getSessionId(), 's-b');
    assert.deepEqual(
      b.events.map((e) => e.text),
      ['B1', 'B2'],
      '切过去的必须是目标会话自己的历史，不能是上一个会话的残留'
    );
  });

  test('切到不存在的会话不炸：空历史收下，不继承上一个会话的事件', async () => {
    const rt = createAgentRuntime(deps({ sessionStore: await seededStore() }));
    await rt.openSession('s-a');

    const missing = await rt.openSession('not-there');

    assert.deepEqual(missing.events, []);
    assert.equal(missing.targetTab, null);
  });

  test('删除当前会话：存储清掉、回到未选态，别的会话不被殃及', async () => {
    const store = await seededStore();
    const rt = createAgentRuntime(deps({ sessionStore: store }));
    await rt.openSession('s-a');

    await rt.deleteSession('s-a');

    assert.equal(rt.getSessionId(), null, '删完必须回到「还没有会话」的状态');
    assert.equal(await store.load('s-a'), null, '本体要真的删掉');
    assert.deepEqual(
      (await store.listIndex()).map((e) => e.id),
      ['s-b']
    );
  });

  test('删的不是当前会话时，当前会话原样不动', async () => {
    const store = await seededStore();
    const rt = createAgentRuntime(deps({ sessionStore: store }));
    await rt.openSession('s-b');

    await rt.deleteSession('s-a');

    assert.equal(rt.getSessionId(), 's-b', '删别的会话不能顺手把当前会话切走');
    assert.equal(await store.load('s-a'), null);
    assert.ok(await store.load('s-b'), '当前会话必须还在');
  });

  test('newSession 回到未选态，之后还能正常切回历史会话', async () => {
    const store = await seededStore();
    const rt = createAgentRuntime(deps({ sessionStore: store }));
    await rt.openSession('s-a');

    rt.newSession();
    assert.equal(rt.getSessionId(), null);

    const again = await rt.openSession('s-b');
    assert.deepEqual(
      again.events.map((e) => e.text),
      ['B1', 'B2']
    );
  });
});

describe('配置读写往返（走 credentialUtil）', () => {
  beforeEach(async () => {
    const mod = await import('./__stubs__/webextension-polyfill');

    mod.resetBrowser();
  });

  test('保存后能原样读回，且落盘里看不到明文 key', async () => {
    const r = await saveConfig(configIO, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-super-secret-value',
    });

    assert.ok(r.ok, r.errors && r.errors.join());

    const raw = await configIO.get('automaAgentConfig');

    assert.ok(
      !JSON.stringify(raw).includes('sk-super-secret-value'),
      '落盘不能是明文'
    );

    const back = await loadConfig(configIO);

    assert.equal(back.apiKey, 'sk-super-secret-value');
    assert.equal(back.model, 'gpt-4o-mini');
  });

  test('apiKey 为空白时校验失败且不写盘', async () => {
    const r = await saveConfig(configIO, {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: '   ',
    });

    assert.equal(r.ok, false);

    const back = await loadConfig(configIO);

    assert.equal(back.apiKey, '', '校验不过就不能留下任何东西');
  });

  test('baseUrl 不是 http(s) 时拒绝写盘', async () => {
    const r = await saveConfig(configIO, {
      provider: 'custom',
      baseUrl: 'ftp://bad.example.com',
      model: 'm',
      apiKey: 'sk-x',
    });

    assert.equal(r.ok, false);
    assert.match(r.errors.join(), /baseUrl/);
  });
});
