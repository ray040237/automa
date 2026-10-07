/**
 * `src/agent/index.js`（装配层）的**行为**刻画测试 —— backlog T-126。
 *
 * 为什么需要它：这个 1137 行的文件是全仓唯一没有专属测试文件的生产模块，
 * 仓库为它建了三套补偿机制（`utils/test-resolver.mjs` 的别名钩子、
 * `__stubs__/` 5 个桩、`assembly.test.js` 里 17 处 `readFileSync` 后的源码正则）。
 * 那三套东西本身就是「这里测不到」的证据。
 *
 * 本文件**不是**断言「应该怎样」，而是断言「**现在实际怎样**」——
 * 目的是在 T-126 真的动手拆它之前，把现有行为钉住。重构时哪条红了，
 * 就是行为变了；绿的就说明可以安全搬走。
 *
 * 为什么不早就有：基建其实**早就齐了**。`utils/test-resolver.mjs` 的头注写着
 * 「后两条是为了让装配层 src/agent/index.js 也能进测试」，
 * `__stubs__/globals.js` 备好了 `installGlobals()` —— 但没有任何测试真的
 * import 过它。下面第 1 组测试就是这件事本身的证据。
 *
 * 覆盖范围刻意收窄在「拆文件时最容易悄悄改掉」的三处：
 *   ① 超时契约（`raceTimeout` / `toBackground` / `readPageFromTab`）——
 *      不 reject 而返回兜底值，是 AGENTS.md「不静默降级」红线的落点；
 *   ② 超时嵌套关系（10s → 15s → 20s）—— T-126 的注明确要求它「由同一个
 *      module 保证」，但至今零断言；
 *   ③ 导出面 —— interface 宽度是 T-126 的核心诊断，先留一份基线。
 *
 * **没覆盖**：会话编排（`createAgentRuntime` 的 send/openSession 主体）、
 * 检查点落盘、toolCtx 的 17 个字段。这些需要构造完整宿主依赖与 pi provider，
 * 属于「该在拆出独立模块之后各自建测试」的范围，不在本文件的角色里。
 * 别把这里的绿灯当成「index.js 已被测透」—— 它只钉住了上面三处。
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installGlobals } from './__stubs__/globals';
import browser, {
  resetBrowser,
  state,
} from './__stubs__/webextension-polyfill';

// index.js 的静态 import 链会走到 @/utils/shared 与 @/utils/message，
// 两者都用 webpack DefinePlugin 注入的全局（IS_OFFLINE / BROWSER_TYPE）。
// 静态 import 会被提升到注入之前执行，所以必须动态 import（与 facts.test.js 同理）。
installGlobals();

const index = await import('./index');
const { raceTimeout } = await import('./agentEvalInPage');

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

beforeEach(() => resetBrowser());

/* ───────────────────── ① 导出面基线 ───────────────────── */

describe('导出面（T-126 的 interface 宽度基线）', () => {
  test('装配层对外就是这 16 个导出 —— 多一个少一个都该是一次显式决定', () => {
    const EXPECTED = [
      'BACKGROUND_CHANNEL_TIMEOUT_MS',
      'PHANTOM_AUTOMA_FUNCS',
      'TAB_CHANNEL_TIMEOUT_MS',
      'agentLog',
      'collectPromptFacts',
      'configIO',
      'createAgentRuntime',
      'listTabs',
      'loadConfig',
      'lookupBlockSchema',
      'readPageFromTab',
      'resolveTarget',
      'saveConfig',
      'sessionIO',
      'sessionStore',
      'toBackground',
    ].sort();

    assert.deepEqual(
      Object.keys(index).sort(),
      EXPECTED,
      '导出面变了。T-126 记录过：全仓只有 agentHost.js 消费这里的 6 个' +
        '（configIO/createAgentRuntime/listTabs/loadConfig/resolveTarget/sessionStore），' +
        '其余 10 个 prod 侧 0 引用。增删导出时请连带更新 T-126 的证据。'
    );
  });

  test('消费面就那 6 个 —— 本文件的存在意义就是替它们兜住回归', () => {
    // 这 6 个是 agentHost.js 真正 import 的。守卫它们的形状，
    // 免得「为了测试能 import」这类理由把导出面重新撑大。
    const OBJECT_LIKE = {
      configIO: ['get', 'set', 'remove'],
      sessionStore: ['listIndex', 'load', 'save', 'patchTitle', 'remove'],
    };
    const CALLABLE = [
      'createAgentRuntime',
      'listTabs',
      'loadConfig',
      'resolveTarget',
    ];

    Object.entries(OBJECT_LIKE).forEach(([name, methods]) => {
      assert.equal(typeof index[name], 'object', `${name} 必须是对象`);
      methods.forEach((m) => {
        assert.equal(
          typeof index[name][m],
          'function',
          `${name}.${m} 没了 —— agentHost.js 直接调它，缺了就是运行期 TypeError`
        );
      });
    });

    CALLABLE.forEach((name) => {
      assert.equal(typeof index[name], 'function', `${name} 必须是函数`);
    });
  });
});

/* ───────────────────── ② 超时契约 ───────────────────── */

describe('raceTimeout：超时不 reject，返回兜底值', () => {
  test('promise 永不 settle 时按兜底值 resolve，不是 reject', async () => {
    const never = new Promise(() => {});
    const out = await raceTimeout(never, 5, { ok: false, __timeout: true });

    assert.deepEqual(out, { ok: false, __timeout: true });
  });

  test('正常值先到时原样返回，不被兜底值覆盖', async () => {
    const out = await raceTimeout(Promise.resolve('real'), 50, 'fallback');

    assert.equal(out, 'real');
  });

  test('谁先 settle 都要撤掉定时器 —— 漏掉的代价是 node 进程多活 20s', async () => {
    // 头注记着实测数字：一个 20s 定时器让进程多活 20009ms。
    // 这条不设长定时器（那会让整个测试进程挂住），而是直接看句柄数。
    const countTimers = () =>
      process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const beforeCount = countTimers();

    await raceTimeout(Promise.resolve(1), 5000, 'x');

    const afterCount = countTimers();

    assert.ok(
      afterCount <= beforeCount,
      `raceTimeout 返回后不该残留定时器：调用前 ${beforeCount} 个 Timeout，之后 ${afterCount} 个`
    );
  });

  test('底层 promise 超时后再 reject 也不能炸 unhandledRejection', async () => {
    // 挂在 raceTimeout 之前就已经 reject 的 promise：
    // 如果没挂空 catch，本进程会因 unhandledRejection 直接退出。
    const late = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('late boom'));
      }, 10);
    });
    const out = await raceTimeout(late, 5, 'timeout-value');

    assert.equal(out, 'timeout-value');
    await new Promise((r) => {
      setTimeout(r, 40); // 让那个 reject 真的发生
    });
    // 能走到这里且进程没崩，就是断言通过
  });
});

describe('toBackground：工具 → background 的唯一通道', () => {
  test('协议翻译：{type, ...payload} → {name: "background--<type>", data}', async () => {
    let seen = null;
    state.runtimeSendMessage = (payload) => {
      seen = payload;
      return { ok: true };
    };

    const res = await index.toBackground({ type: 'query', keyword: 'abc' });

    assert.deepEqual(seen, {
      name: 'background--query',
      data: { keyword: 'abc' },
    });
    assert.deepEqual(res, { ok: true });
  });

  test('超时回 {ok:false, error} 给模型，且 __timeout 不进观察值', async () => {
    // __timeout 是内部标记 —— 露给模型等于泄露实现细节。
    state.runtimeSendMessage = () => new Promise(() => {});

    const res = await index.toBackground({ type: 'query' }, { timeoutMs: 5 });

    assert.equal(res.ok, false);
    assert.ok(!('__timeout' in res), '__timeout 是内部标记，不能进观察值');
    assert.match(res.error, /background 通道无响应/);
    // 如实说不确定 + 给下一步动作，否则模型会原地重复同一调用（T-33）
    assert.match(res.error, /是否已执行无法确认/);
    assert.match(res.error, /不要直接重复同一调用/);
  });

  test('真的 send 失败（端口不存在）仍然 reject —— 与超时是两回事', async () => {
    state.runtimeSendMessageThrows = new Error(
      'Could not establish connection'
    );

    await assert.rejects(
      () => index.toBackground({ type: 'query' }, { timeoutMs: 50 }),
      /Could not establish connection/,
      'send 失败必须走 reject 交给 channel.fail，不能伪装成超时兜底值'
    );
  });

  test('默认超时常量是 20s（不能用 options 覆盖成别的值就悄悄变了）', () => {
    assert.equal(index.BACKGROUND_CHANNEL_TIMEOUT_MS, 20000);
  });
});

describe('readPageFromTab：读页失败要给人话，不抛栈', () => {
  test('没有目标页时返回一句可行动的说明', async () => {
    const out = await index.readPageFromTab(null, {});

    assert.equal(typeof out, 'string');
    assert.match(out, /没有确定目标页/);
  });

  test('页面不应答时给「换页」的动作，而不是让模型原地重试', async () => {
    state.sendMessageByFrame = () => new Promise(() => {});

    const out = await index.readPageFromTab({ id: 7 }, { timeoutMs: 5 });

    assert.equal(typeof out, 'string');
    assert.match(out, /页面无响应/);
    assert.match(out, /focus_tab/);
  });

  test('content 侧返回 {text, fingerprint} 时指纹必须原样带回', async () => {
    // 指纹是「页面变没变」的唯一判据，设计稿 §6.2 —— 塞进文本会被
    // 陈旧快照剔除抹掉，所以它是独立字段而不是正文的一部分。
    state.sendMessageByFrame = () => ({
      text: '<page>正文</page>',
      fingerprint: 'fp-123',
    });

    const out = await index.readPageFromTab({ id: 7 }, { detail: 'addresses' });

    assert.deepEqual(out, { text: '<page>正文</page>', fingerprint: 'fp-123' });
  });

  test('sendMessage 抛错时降级成中文说明，不把栈抛给模型', async () => {
    state.sendMessageThrows = new Error('Receiving end does not exist');

    const out = await index.readPageFromTab({ id: 7 }, { timeoutMs: 50 });

    assert.equal(typeof out, 'string');
    assert.match(out, /读取目标页失败/);
  });

  test('默认超时常量是 15s', () => {
    assert.equal(index.TAB_CHANNEL_TIMEOUT_MS, 15000);
  });
});

/* ─────────── ③ 超时嵌套关系（T-126 的注：零断言） ─────────── */

describe('超时嵌套关系：外层必须大于内层', () => {
  // 这组常量分属两个文件（页内 10s 在 agentEvalInPage.js、
  // 页内执行 15s 在 src/background/index.js、tabs 15s 与 background 20s 在本文件），
  // 没有任何一处代码保证它们的相对大小。T-126 的注写着「这个关系只有同一个
  // 模块持有才守得住」—— 但在拆出 adapter 之前，它是纯靠人的。
  test('10s（页内执行）< 15s（页内执行通道 / tabs 通道）< 20s（background 通道）', () => {
    const evalSrc = read('src/agent/agentEvalInPage.js');
    const bgSrc = read('src/background/index.js');

    const inPage = Number(
      (evalSrc.match(
        /setTimeout\(\(\) => reject\(new Error\('执行超时（(\d+)s）'\)\), (\d+)\)/
      ) || [])[2]
    );
    const pageChannel = Number(
      (bgSrc.match(/AGENT_PAGE_TIMEOUT_MS\s*=\s*(\d+)/) || [])[1]
    );

    assert.ok(
      Number.isFinite(inPage),
      '没在 agentEvalInPage.js 里抓到页内执行的 10s'
    );
    assert.ok(
      Number.isFinite(pageChannel),
      '没在 background/index.js 里抓到 AGENT_PAGE_TIMEOUT_MS'
    );

    assert.ok(
      inPage <= pageChannel,
      `页内执行 ${inPage}ms 必须 <= 页内执行通道 ${pageChannel}ms`
    );
    assert.ok(
      pageChannel <= index.TAB_CHANNEL_TIMEOUT_MS,
      `页内执行通道 ${pageChannel}ms 必须 <= tabs 通道 ${index.TAB_CHANNEL_TIMEOUT_MS}ms`
    );
    assert.ok(
      index.TAB_CHANNEL_TIMEOUT_MS < index.BACKGROUND_CHANNEL_TIMEOUT_MS,
      `tabs 通道 ${index.TAB_CHANNEL_TIMEOUT_MS}ms 必须 < background 通道 ${index.BACKGROUND_CHANNEL_TIMEOUT_MS}ms` +
        '（background 那条的兜底在 background 内部，SW 被回收时只有它能救）'
    );
  });
});

/* ───────────────────── ④ G5 的运行时侧 ───────────────────── */

describe('装配层不得触碰落盘入口', () => {
  test('index.js 全文无落盘符号（G5 的 import 纪律那层）', () => {
    // 文本守卫。真正的运行时守护在 tools/canvas.test.js 的 describe('G5')，
    // 那里守的是注入块与 agentHost —— 覆盖面更靠外一层。
    ['saveWorkflow', 'workflowStore.update', 'workflowStore.save'].forEach(
      (sym) => {
        assert.ok(
          !read('src/agent/index.js').includes(sym),
          `index.js 里不该出现 ${sym}：装配层一旦能落盘，agent 就越过了 G5`
        );
      }
    );
  });

  test('browser 桩确实被用上了 —— 守卫不是空转', () => {
    // 防止上面那条守卫在「模块压根没加载」的情况下也绿。
    assert.equal(typeof index.toBackground, 'function');
    assert.equal(typeof browser.runtime.sendMessage, 'function');
  });
});
