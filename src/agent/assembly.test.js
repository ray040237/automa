import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installGlobals } from './__stubs__/globals';

installGlobals();

// shared.js 用了构建期全局，必须在动态 import 之前注入。
// 真实 tasks 是这轮要验的对象，所以这里加载的是真的，不是桩。
await import('../utils/shared');
const { TOOLS } = await import('./tools');

const {
  collectPromptFacts,
  configIO,
  createAgentRuntime,
  loadConfig,
  saveConfig,
  toBackground,
  lookupBlockSchema,
  readPageFromTab,
  agentLog,
} = await import('./index');
const { createSessionStore } = await import('./sessions');
const { AGENT_EVENTS } = await import('./events');
const { tasks } = await import('../utils/shared');

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

describe('T-34 转中检查点落盘', () => {
  test('send 有在途检查点，且收尾前取消在途调度', () => {
    const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');

    assert.ok(
      src.includes('createCheckpointSaver('),
      'index.js 必须接 createCheckpointSaver（turnRecord.js）'
    );
    assert.ok(
      src.includes('checkpoints.schedule();'),
      '事件入史后要调度检查点'
    );

    const cancelAt = src.indexOf('checkpoints.cancel();');
    const finalSaveAt = src.indexOf('await sessionStore.save(');
    assert.ok(cancelAt > 0, '收尾前必须 cancel 在途调度');
    assert.ok(
      finalSaveAt > cancelAt,
      '迟到的旧检查点不能覆盖最终记录——cancel 必须先于最终 save'
    );
  });
});

describe('collectPromptFacts —— 装配层这一段的回归', () => {
  test('用真实 tasks 不抛，且块数是对的', () => {
    // 用户报的崩溃就在这里：tasks 是对象，裸 .reduce 直接 TypeError。
    const f = collectPromptFacts(TOOLS);

    assert.equal(typeof f.blockCount, 'number');
    assert.ok(f.blockCount > 50, `块数应远大于 0，实际 ${f.blockCount}`);
  });

  test('剔掉运行时没注入的 automaExecWorkflow', () => {
    const f = collectPromptFacts(TOOLS);

    assert.ok(!f.automaFuncs.includes('automaExecWorkflow'));
    assert.ok(f.automaFuncs.length > 0);
  });

  test('工具表完整带上来了', () => {
    const names = collectPromptFacts(TOOLS).tools.map((t) => t.name);

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

/**
 * 工具 → background 的路由契约（backlog T-28）。
 *
 * 之前 toolCtx 裸发 browser.runtime.sendMessage({type,...})，而 background 的
 * MessageListener 只按 {name: 'background--<type>', data} 查表 —— 三个页面工具
 * （test_js / query_elements / highlight_selector）在真实浏览器里全部打不通，
 * 只回一句指不到真因的 Unhandled Background Error。工具单测注入假 sendMessage
 * 测不出这条断链，所以这里必须走真的：toBackground 的产物喂进真实
 * MessageListener('background')，handler 必须收到参数、返回值必须原路带回。
 */
describe('toBackground —— 到 background 的路由契约', () => {
  async function wireRealRouting() {
    const stub = await import('./__stubs__/webextension-polyfill');
    const { MessageListener } = await import('../utils/message');

    const ml = new MessageListener('background');
    const received = {};

    // 注册名与 src/background/index.js:603/656/721 一致
    ml.on('agent:run-js', (data) => {
      received['agent:run-js'] = data;
      return { ok: true, value: '"done"', json: true };
    });
    ml.on('agent:query', (data) => {
      received['agent:query'] = data;
      return { ok: true, count: 1, sample: [] };
    });
    ml.on('agent:highlight', (data) => {
      received['agent:highlight'] = data;
      return { ok: true, highlighted: 1 };
    });

    stub.default.runtime.sendMessage = (payload) => ml.listener(payload);

    return received;
  }

  test('test_js 的载荷必须路由到 agent:run-js，参数原样到达、返回原路带回', async () => {
    const received = await wireRealRouting();

    // 与 page-write.js:29-33 实际发出的形状一致
    const res = await toBackground({
      type: 'agent:run-js',
      tabId: 7,
      code: 'document.title',
    });

    assert.deepEqual(received['agent:run-js'], {
      tabId: 7,
      code: 'document.title',
    });
    assert.deepEqual(res, { ok: true, value: '"done"', json: true });
  });

  test('query_elements 与 highlight_selector 的载荷同样要能路由', async () => {
    const received = await wireRealRouting();

    await toBackground({
      type: 'agent:query',
      tabId: 7,
      selector: 'a',
      limit: 5,
    });
    await toBackground({
      type: 'agent:highlight',
      tabId: 7,
      selector: 'a',
      limit: 10,
      durationMs: 4000,
    });

    assert.deepEqual(received['agent:query'], {
      tabId: 7,
      selector: 'a',
      limit: 5,
    });
    assert.deepEqual(received['agent:highlight'], {
      tabId: 7,
      selector: 'a',
      limit: 10,
      durationMs: 4000,
    });
  });
});

/**
 * 发送侧硬超时（backlog T-39）。
 *
 * background 内部有 15s 页内执行兜底（T-30）、tabs 通道有 15s（T-33），
 * 但那两层都在**别的进程/通道**里：回程丢了（SW 被回收 / 浏览器把响应
 * 弄丢）时发送方的 promise 永不 settle，用户真机日志里 `channel.send`
 * 之后既无 reply 也无 fail，整轮 agent 挂死。这里钉的是最后一层：
 * 无论回程发生什么，`toBackground` 都必须 settle。
 */
describe('toBackground —— 发送侧硬超时（T-39）', () => {
  test('background 永不回应时回人话 error，整轮不再挂死', async () => {
    const stub = await import('./__stubs__/webextension-polyfill');
    const original = stub.default.runtime.sendMessage;
    stub.default.runtime.sendMessage = () => new Promise(() => {});

    try {
      const res = await toBackground(
        { type: 'agent:run-js', tabId: 7, code: '1+1' },
        { timeoutMs: 20 }
      );

      assert.equal(res.ok, false, '超时必须回 ok:false 的观察值形状');
      assert.match(res.error, /background 通道无响应/);
      assert.match(
        res.error,
        /无法确认/,
        '必须说清执没执行是未知的，否则模型会原地重复同一调用'
      );
      assert.equal('__timeout' in res, false, '内部标记不许泄进观察值');
    } finally {
      stub.default.runtime.sendMessage = original;
    }
  });

  test('超时打 channel.timeout（带耗时），正常回程的 reply 也带耗时', async () => {
    const stub = await import('./__stubs__/webextension-polyfill');
    const original = stub.default.runtime.sendMessage;

    try {
      // 超时路径
      const markTimeout = agentLog.ring.length;
      stub.default.runtime.sendMessage = () => new Promise(() => {});
      await toBackground({ type: 'agent:run-js', tabId: 7 }, { timeoutMs: 20 });

      const timeoutLogs = agentLog.ring
        .slice(markTimeout)
        .filter((e) => e.event === 'channel.timeout');
      assert.equal(timeoutLogs.length, 1, '超时必须留下 channel.timeout 打点');
      assert.equal(typeof timeoutLogs[0].data.ms, 'number', '耗时是定位的关键');
      assert.equal(timeoutLogs[0].data.timeoutMs, 20);

      // 健康路径：reply 也带耗时，且不能被误判成超时
      const markReply = agentLog.ring.length;
      stub.default.runtime.sendMessage = async () => ({
        ok: true,
        value: '"1"',
      });
      const res = await toBackground(
        { type: 'agent:run-js', tabId: 7, code: '1' },
        { timeoutMs: 500 }
      );

      const replyLogs = agentLog.ring
        .slice(markReply)
        .filter((e) => e.event === 'channel.reply');
      assert.deepEqual(res, { ok: true, value: '"1"' });
      assert.equal(replyLogs.length, 1);
      assert.equal(typeof replyLogs[0].data.ms, 'number');
      assert.equal(
        agentLog.ring
          .slice(markReply)
          .filter((e) => e.event === 'channel.timeout').length,
        0,
        '健康回程不许打超时点'
      );
    } finally {
      stub.default.runtime.sendMessage = original;
    }
  });

  test('send 真失败仍照旧 reject —— 超时兜底不能吞掉真错误', async () => {
    const stub = await import('./__stubs__/webextension-polyfill');
    const original = stub.default.runtime.sendMessage;
    stub.default.runtime.sendMessage = async () => {
      throw new Error('boom');
    };

    try {
      await assert.rejects(() =>
        toBackground({ type: 'agent:run-js', tabId: 7 }, { timeoutMs: 500 })
      );
    } finally {
      stub.default.runtime.sendMessage = original;
    }
  });
});

/**
 * get_block_schema 的真实现（backlog T-32）：此前 runtime 默认 `async () => null`
 * 且无宿主接线，任何查询都回「可用块（一个都没有）」，与事实表「61 个块」矛盾，
 * 模型陷进 read_page ↔ get_block_schema 死循环。这里直接对真目录断言。
 */
describe('lookupBlockSchema —— 块目录查询（T-32）', () => {
  test('按 id 查 javascript-code：拿到块名与 data 字段清单', async () => {
    const s = await lookupBlockSchema('javascript-code');

    assert.equal(s.id, 'javascript-code');
    assert.equal(s.name, 'JavaScript code');
    assert.ok(s.data && 'code' in s.data, 'data 里必须有 code 字段');
  });

  test('按块名查（get_block_schema 两种写法都认）', async () => {
    const s = await lookupBlockSchema('JavaScript code');

    assert.equal(s.id, 'javascript-code');
  });

  test("'*' 镜像真实目录：条数与 tasks 一致，且含 javascript-code", async () => {
    const all = await lookupBlockSchema('*');

    assert.ok(Array.isArray(all));
    assert.equal(all.length, Object.keys(tasks).length);
    assert.ok(
      all.some((b) => b.id === 'javascript-code'),
      '全量列表必须包含 javascript-code'
    );
    assert.ok(
      all.every((b) => b.id && b.name),
      '每条都要有 id 和 name'
    );
  });

  test('查不到的块名返回 null（工具据此回可用块列表）', async () => {
    assert.equal(await lookupBlockSchema('no-such-block'), null);
    assert.equal(await lookupBlockSchema(''), null);
  });

  test('工具层防御：目录为空 = 接线断了，必须说破而不是「一个都没有」', async () => {
    const tool = TOOLS.find((t) => t.name === 'get_block_schema');

    assert.ok(tool, 'TOOLS 里必须有 get_block_schema');

    const broken = await tool.execute(
      { name: 'javascript-code' },
      { getBlockSchema: async () => [] }
    );

    assert.match(
      broken,
      /没接上线/,
      '空目录要说人话，不能渲染成「一个都没有」'
    );

    // 对照：桩回 null（查不到 + 全量也 null）才是旧形态，走「一个都没有」分支
    const legacyNull = await tool.execute(
      { name: 'javascript-code' },
      { getBlockSchema: async () => null }
    );

    assert.match(legacyNull, /一个都没有/);
  });

  test('工具走真实现端到端：javascript-code 返回字段清单', async () => {
    const tool = TOOLS.find((t) => t.name === 'get_block_schema');

    const out = await tool.execute(
      { name: 'javascript-code' },
      { getBlockSchema: lookupBlockSchema }
    );

    assert.match(out, /## JavaScript code/);
    assert.match(out, /code/, '字段清单里必须出现 code');
  });
});

/**
 * tabs 通道的硬超时（backlog T-33）。
 *
 * test_js 注入的代码把目标页主线程占死后，同进程的 content script 无法应答，
 * tabs.sendMessage 的 promise 永不 settle —— read_page / 指纹 probe 全走这条
 * 通道，没有超时就是「同意执行后整个 agent 卡死」。探针 t33-probe.mjs 已在
 * 真机复现；这里用永不 settle 的桩把超时分支钉住。
 */
describe('readPageFromTab —— tabs 通道超时兜底（T-33）', () => {
  test('页面无应答时按 timeoutMs 返回人话，而不是永久挂起', async () => {
    const stub = await import('./__stubs__/webextension-polyfill');
    const original = stub.default.tabs.sendMessage;
    stub.default.tabs.sendMessage = () => new Promise(() => {});

    try {
      const out = await readPageFromTab(
        { id: 7 },
        { detail: 'summary', timeoutMs: 20 }
      );

      assert.match(out, /页面无响应/);
      assert.match(out, /刷新|换一个标签页/, '必须给模型一句能行动的话');
    } finally {
      stub.default.tabs.sendMessage = original;
    }
  });

  test('健康通道照常返回，不被超时分支干扰', async () => {
    const stub = await import('./__stubs__/webextension-polyfill');
    const original = stub.default.tabs.sendMessage;
    stub.default.tabs.sendMessage = async () => ({
      text: '页面正文',
      fingerprint: 'abc',
    });

    try {
      const out = await readPageFromTab(
        { id: 7 },
        { detail: 'summary', timeoutMs: 500 }
      );

      assert.deepEqual(out, { text: '页面正文', fingerprint: 'abc' });
    } finally {
      stub.default.tabs.sendMessage = original;
    }
  });
});

describe('agentLog —— 关键事件打点（接线回归）', () => {
  test('toBackground 每次调用都留下 channel.send / channel.reply', async () => {
    const stub = await import('./__stubs__/webextension-polyfill');
    const { MessageListener } = await import('../utils/message');

    const ml = new MessageListener('background');
    ml.on('agent:run-js', () => ({ ok: true, value: '"1"' }));
    stub.default.runtime.sendMessage = (payload) => ml.listener(payload);

    const before = agentLog.ring.length;
    await toBackground({ type: 'agent:run-js', tabId: 7, code: '1' });

    const fresh = agentLog.ring.slice(before);
    assert.ok(
      fresh.some((e) => e.event === 'channel.send'),
      'send 打点缺失'
    );
    assert.ok(
      fresh.some(
        (e) => e.event === 'channel.reply' && e.data && e.data.ok === true
      ),
      'reply 打点缺失或 ok 不符'
    );
  });

  test('通道失败走 channel.fail 且不吞异常', async () => {
    const stub = await import('./__stubs__/webextension-polyfill');
    stub.default.runtime.sendMessage = async () => {
      throw new Error('boom');
    };

    await assert.rejects(() =>
      toBackground({ type: 'agent:run-js', tabId: 7, code: '1' })
    );
    assert.ok(
      agentLog.ring.some(
        (e) =>
          e.event === 'channel.fail' &&
          e.data &&
          String(e.data.message).includes('boom')
      )
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

/**
 * T-35 + B1 接线守卫：标题回写是几秒之后才跑的 fire-and-forget 回调，
 * 它不能再用「resolve 那一刻」的外层状态 —— 那时用户可能已经点了新建会话
 * （currentSessionId 变 null → 落出 agent_session_null 幽灵会话），也可能
 * 已经发出了第二轮（整记录 save 把首轮 events 快照盖回去）。
 *
 * generateTitleAsync 直接吃模块级 streamChat、不吃 deps 注入，本仓没有能把
 * 这条回调跑到 resolve 的测试基建 —— 所以退而钉住源码接线（同 T-02 的做法）：
 * id 在发起时捕获、回写走 patchTitle、then 里不许再出现拿外层 id 的整记录 save。
 */
test('T-35/B1 接线守卫：标题回写在发起时捕获 id，且只 patch title', () => {
  const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');

  const thenAt = src.indexOf('.then(async (title) => {');
  assert.ok(thenAt > 0, '回写回调还在吗');
  assert.equal(
    src.indexOf('.then(async (title) => {', thenAt + 1),
    -1,
    '标题回写回调应该只有一处'
  );

  const captureAt = src.lastIndexOf(
    'const titleSessionId = currentSessionId;',
    thenAt
  );
  assert.ok(captureAt > 0, 'id 必须在发起标题请求前捕获一次');

  const callAt = src.indexOf(
    'generateTitleAsync(config, userText, events)',
    captureAt
  );
  assert.ok(
    callAt > captureAt && callAt < thenAt,
    '顺序必须是「捕获 id → 发起请求」—— 拿 resolve 时的 currentSessionId 会读到用户刚切走后的 null'
  );

  const catchAt = src.indexOf('.catch((err) => {', thenAt);
  const block = src.slice(thenAt, catchAt > thenAt ? catchAt : thenAt + 800);

  assert.match(
    block,
    /patchTitle\(\s*titleSessionId/,
    '必须走 patchTitle，只改标题这一个字段'
  );
  assert.ok(
    !/id:\s*currentSessionId/.test(block),
    'then 里不许再拿 resolve 时的 currentSessionId 当 id —— 那正是 agent_session_null 的来源'
  );
  assert.ok(
    !/\b(events|pins|focusedTabId|usage),/.test(block),
    'then 里不许把首轮快照整记录写回 —— 会盖掉第二轮 events（B1）'
  );
});
