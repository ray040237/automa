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
