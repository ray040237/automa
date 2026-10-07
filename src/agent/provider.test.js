import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { API_ID, buildModel, createPiProvider, toPiContext } from './provider';

/**
 * 票 08：provider 接线的测试。
 *
 * 这里测的是**形状翻译**，不是 pi 本身的行为。「pi 收到这个 Model 会怎样」
 * 是上游的测试责任；我们要钉的是「我们的 config 有没有如实翻过去」——
 * 翻错的代价是静默的：字段缺失不会崩，只会让请求带错参数或者不带凭据。
 *
 * 因此这里**不 import真的 pi**（会把 openai SDK 拖进 node --test），
 * 而是注入一个记录型的假 pi。
 */

const CONFIG = {
  provider: 'modelscope',
  baseUrl: 'https://api-inference.modelscope.cn/v1',
  model: 'Qwen/Qwen2.5-7B-Instruct',
  temperature: 0.2,
  contextWindow: 32000,
  apiKey: 'sk-test',
};

/** 记录型假 pi：把 createProvider 的入参抓下来，够断言接线用。 */
function fakePi() {
  const seen = { provider: null, models: null, streamCalls: [] };
  const provider = {
    id: 'x',
    streamSimple(model, context, options) {
      seen.streamCalls.push({ model, context, options });
      return { result: async () => ({ content: [] }) };
    },
  };
  return {
    seen,
    pi: {
      createProvider: (input) => {
        seen.provider = input;
        return provider;
      },
      createModels: () => ({
        setProvider: (p) => {
          seen.models = p;
        },
        streamSimple: (model, context, options) => {
          seen.streamCalls.push({ model, context, options });
          return { result: async () => ({ content: [] }) };
        },
      }),
      openAICompletionsApi: () => ({ id: 'openai-completions-fake' }),
    },
  };
}

test('buildModel 把 config 如实翻成 pi 的 Model 形状', () => {
  const m = buildModel(CONFIG);

  assert.equal(m.api, API_ID, 'api 必须是 openai-completions');
  assert.equal(m.id, CONFIG.model, 'id 是模型名');
  assert.equal(m.provider, CONFIG.provider, 'provider 来自配置，不写死');
  assert.equal(m.baseUrl, CONFIG.baseUrl);
  assert.equal(m.contextWindow, CONFIG.contextWindow, '窗口来自用户配置');
});

test('buildModel 的 cost 全 0 —— 编假单价会让 usage 面板显示错花费', () => {
  const m = buildModel(CONFIG);
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    assert.equal(m.cost[k], 0, `cost.${k} 必须是 0，实际 ${m.cost[k]}`);
  }
});

test('buildModel 的 maxTokens：0 = 不设，填了才传（T-96）', () => {
  // 默认不设 —— 把上限交给端点默认，写死会让长回答被截断在半句
  assert.equal(buildModel(CONFIG).maxTokens, 0);
  assert.equal(buildModel({ ...CONFIG, maxTokens: undefined }).maxTokens, 0);
  assert.equal(buildModel({ ...CONFIG, maxTokens: 'x' }).maxTokens, 0);
  assert.equal(buildModel({ ...CONFIG, maxTokens: 4096 }).maxTokens, 4096);
});

test('buildModel 在 provider 缺失时落到 custom，不留 undefined', () => {
  // 留undefined 会让 pi 按 provider 分组时拿到一个匿名项，
  // 日志与错误归类都对不上 —— 比错一个名字更难查。
  const m = buildModel({ ...CONFIG, provider: undefined });
  assert.equal(m.provider, 'custom');
});

test('createPiProvider 把 apiKey 放进 provider 的 auth.resolve', async () => {
  const { pi, seen } = fakePi();
  await createPiProvider(CONFIG, { loadPi: async () => pi });

  assert.ok(seen.provider, '必须真的建provider');
  const { auth } = seen.provider;
  assert.ok(auth && auth.apiKey, '必须有 apiKey 鉴权通道');

  // resolve 真能给出 key：扩展没有 .env，这条路径不通就是静默 401。
  const resolved = await auth.apiKey.resolve({});
  assert.equal(resolved.auth.apiKey, CONFIG.apiKey);
});

test('createPiProvider 的 baseUrl 与模型都取自配置', async () => {
  const { pi, seen } = fakePi();
  const { model } = await createPiProvider(CONFIG, { loadPi: async () => pi });

  assert.equal(seen.provider.baseUrl, CONFIG.baseUrl);
  assert.equal(seen.provider.id, CONFIG.provider);
  assert.deepEqual(
    seen.provider.models,
    [model],
    'provider 登记的就是这个模型'
  );
});

test('streamFn 注入 temperature —— pi 的 Agent 不转发它', async () => {
  // 实测：Agent.createLoopConfig() 里没有 temperature，streamFn 收到的 options 不带。
  // 不在这里注入，设置页调的温度就是静默失效的。
  const { pi, seen } = fakePi();
  const { model, streamFn } = await createPiProvider(CONFIG, {
    loadPi: async () => pi,
  });

  streamFn(model, { messages: [] });
  assert.equal(seen.streamCalls.length, 1);
  assert.equal(
    seen.streamCalls[0].options.temperature,
    CONFIG.temperature,
    'temperature 必须被注入'
  );
});

test('streamFn 把调用方的 options 透传（maxRetries 不被覆盖掉）', async () => {
  const { pi, seen } = fakePi();
  const { model, streamFn } = await createPiProvider(CONFIG, {
    loadPi: async () => pi,
  });

  // loop.js 的 streamFnWithRetry 注入 maxRetries: 3，两者必须叠加而不是互相覆盖。
  streamFn(model, { messages: [] }, { maxRetries: 3, signal: 'SIG' });
  const opts = seen.streamCalls[0].options;
  assert.equal(opts.maxRetries, 3, '调用方的 maxRetries 不能丢');
  assert.equal(opts.signal, 'SIG', 'abort 信号必须透传');
});

test('toPiContext 把 system 提到 systemPrompt，其余消息补 timestamp', () => {
  // pi 的 UserMessage 要求 timestamp，缺了在 provider 层才炸。
  const ctx = toPiContext([
    { role: 'system', content: '起个标题' },
    { role: 'user', content: '帮我抓列表' },
  ]);

  assert.equal(ctx.systemPrompt, '起个标题');
  assert.equal(ctx.messages.length, 1);
  assert.equal(ctx.messages[0].role, 'user');
  assert.equal(ctx.messages[0].content, '帮我抓列表');
  assert.equal(typeof ctx.messages[0].timestamp, 'number');
});

test('toPiContext 没有 system 消息时给空串，不留 undefined', () => {
  const ctx = toPiContext([{ role: 'user', content: 'hi' }]);
  assert.equal(ctx.systemPrompt, '');
});

test('toPiContext 空输入不炸', () => {
  const ctx = toPiContext(undefined);
  assert.equal(ctx.systemPrompt, '');
  assert.deepEqual(ctx.messages, []);
});

test('T-64：provider 头注对 contextWindow 的说法必须与压缩代码一致', () => {
  // 这条注释曾经写「本版不做上下文裁剪，我们侧没有任何代码读它做预算」——
  // 而 loop.js 的 runCompaction 恰恰是拿它算阈值的。注释错了比没有更糟：
  // 维护者会据此以为压缩是 pi 的责任，改配置时也不知道会影响什么。
  const src = readFileSync(new URL('./provider.js', import.meta.url), 'utf8');
  const loopSrc = readFileSync(new URL('./loop.js', import.meta.url), 'utf8');

  const header = src.slice(0, src.indexOf('*/') + 2);

  assert.ok(
    !header.includes('没有任何代码读它做预算'),
    '头注还在否认压缩预算，但 loop.js 的 runCompaction 就在用它'
  );
  assert.ok(
    !header.includes('本版不做上下文裁剪'),
    '头注还在说本版不做压缩 —— 压缩已落地（compaction.js + loop.js）'
  );
  // 反向钉住：注释提到的那些符号必须真的在 loop.js 里被调用
  assert.ok(
    /shouldCompact\(/.test(loopSrc) && /planCompaction\(/.test(loopSrc),
    'loop.js 应当真的按 contextWindow 算压缩阈值与切点'
  );
  // 头注点名了压缩链路上的那两个文件，它们必须真实存在 —— 否则
  // 「与代码一致」只是注释自己说了算。（头注里另有 wire.js / openai-compat.js
  // 这类历史提及，那些文件确实早被票 08 删了，不在核对范围内。）
  for (const name of ['compaction.js', 'loop.js']) {
    assert.ok(header.includes(name), '头注应当点名 ' + name + '，便于按名核对');
    assert.doesNotThrow(
      () => readFileSync(new URL('./' + name, import.meta.url)),
      '头注提到的 ' + name + ' 不存在 —— 这条注释已经不可核对'
    );
  }
});
