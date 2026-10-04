import test from 'node:test';
import assert from 'node:assert';
import { TOOLS, toWireTools } from '../../tools';
import { streamChat, buildEndpoint, toWireMessages } from './openai-compat';

const CONFIG = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'm',
};

/** 用给定 chunk 序列造一个流式 Response */
function sseResponse(chunks, { status = 200, headers = {} } = {}) {
  const body =
    chunks.map((c) => `data: ${c}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(
    new ReadableStream({
      start(c) {
        // 每个 SSE 事件单独一包，最大化触发分包路径
        body
          .split(/(?<=\n\n)/)
          .forEach((p) => c.enqueue(new TextEncoder().encode(p)));
        c.close();
      },
    }),
    { status, headers }
  );
}

async function collect(gen) {
  const out = [];
  for await (const v of gen) out.push(v);
  return out;
}

function run(chunks, opts = {}) {
  const seen = { url: null, init: null };
  const fetchImpl = async (url, init) => {
    seen.url = url;
    seen.init = init;
    return sseResponse(chunks, opts);
  };
  return collect(
    streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      config: CONFIG,
      fetchImpl,
    })
  ).then((ev) => ({ events: ev, seen }));
}

const chunk = (o) => JSON.stringify(o);

test('endpoint 拼接：已带 /v1 不重复补', () => {
  assert.equal(
    buildEndpoint('https://a.com/v1'),
    'https://a.com/v1/chat/completions'
  );
  assert.equal(
    buildEndpoint('https://a.com/v1/'),
    'https://a.com/v1/chat/completions'
  );
  assert.equal(
    buildEndpoint('https://a.com/v1///'),
    'https://a.com/v1/chat/completions'
  );
});

test('endpoint 拼接：未带版本号则补 /v1', () => {
  assert.equal(
    buildEndpoint('https://a.com'),
    'https://a.com/v1/chat/completions'
  );
  assert.equal(
    buildEndpoint('https://a.com/openai'),
    'https://a.com/openai/v1/chat/completions'
  );
});

test('纯文本流：内容按序拼接并以 stop->end 收尾', async () => {
  const { events } = await run([
    chunk({ choices: [{ delta: { content: '你' } }] }),
    chunk({ choices: [{ delta: { content: '好' } }] }),
    chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ]);
  assert.deepEqual(
    events.filter((e) => e.type === 'text-delta').map((e) => e.text),
    ['你', '好']
  );
  assert.equal(events[events.length - 1].type, 'done');
  assert.equal(events[events.length - 1].stopReason, 'end');
});

test('apiKey 只出现在 Authorization 头，不出现在 body', async () => {
  const { seen } = await run([
    chunk({ choices: [{ delta: { content: 'x' } }] }),
  ]);
  assert.equal(seen.init.headers.Authorization, 'Bearer sk-test');
  assert.ok(!JSON.stringify(JSON.parse(seen.init.body)).includes('sk-test'));
});

test('reasoning_content 映射成 thinking-delta', async () => {
  const { events } = await run([
    chunk({ choices: [{ delta: { reasoning_content: '让我想想' } }] }),
    chunk({ choices: [{ delta: { content: '答案' } }] }),
  ]);
  assert.deepEqual(
    events.filter((e) => e.type === 'thinking-delta').map((e) => e.text),
    ['让我想想']
  );
});

test('tool_calls 分片聚合：按 index 对齐', async () => {
  const { events } = await run([
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'c1',
                function: { name: 'read_page', arguments: '{"det' },
              },
            ],
          },
        },
      ],
    }),
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: 'ail":"auto"}' } }],
          },
        },
      ],
    }),
    chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ]);
  const calls = events.filter((e) => e.type === 'tool-call-delta');
  assert.equal(calls[0].id, 'c1');
  assert.equal(calls[0].name, 'read_page');
  assert.equal(calls.map((e) => e.argsDelta).join(''), '{"detail":"auto"}');
  assert.equal(events[events.length - 1].stopReason, 'tool_calls');
});

test('quirk 2：首包带齐 id+name+arguments 时立即 emit（零参工具也不丢）', async () => {
  const { events } = await run([
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'c1', function: { name: 'get_variables' } },
            ],
          },
        },
      ],
    }),
  ]);
  const calls = events.filter((e) => e.type === 'tool-call-delta');
  assert.equal(calls.length >= 1, true, '零参工具必须至少 emit 一次');
  assert.equal(calls[0].name, 'get_variables');
  assert.equal(events[events.length - 1].stopReason, 'tool_calls');
});

test('quirk 1：[DONE] 早到但有未收尾 tool_calls 时按 tool_calls 收尾', async () => {
  const { events } = await run([
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'c1',
                function: { name: 'read_page', arguments: '{}' },
              },
            ],
          },
        },
      ],
    }),
  ]);
  const done = events[events.length - 1];
  assert.equal(done.type, 'done');
  assert.equal(done.stopReason, 'tool_calls', '不能当成 end，否则工具永不执行');
  const flushed = events.filter((e) => e.type === 'tool-call-delta');
  assert.equal(flushed.length, 1, '[DONE] 收尾时 flush 恰好一次完整调用');
  assert.equal(
    flushed[0].id,
    'c1',
    'flush 出来的调用必须带 id，否则 loop 会跳过'
  );
  assert.equal(flushed[0].argsDelta, '{}', 'flush 带累积后的完整参数');
});

test('quirk 3：index 缺失时按数组下标兜底', async () => {
  const { events } = await run([
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [
              { id: 'a', function: { name: 'f', arguments: '{}' } },
              { id: 'b', function: { name: 'g', arguments: '{}' } },
            ],
          },
        },
      ],
    }),
  ]);
  // 首包两条；随后 [DONE] 因 quirk 1 会再 flush 一遍（argsDelta 为空），所以只断言前两条
  const first = events.filter((e) => e.type === 'tool-call-delta').slice(0, 2);
  assert.deepEqual(
    first.map((e) => e.index),
    [0, 1]
  );
  assert.deepEqual(
    first.map((e) => e.id),
    ['a', 'b']
  );
});

test('两个并行工具各自独立聚合', async () => {
  const { events } = await run([
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'a',
                function: { name: 'x', arguments: '{"p":' },
              },
            ],
          },
        },
      ],
    }),
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 1,
                id: 'b',
                function: { name: 'y', arguments: '{"q":' },
              },
            ],
          },
        },
      ],
    }),
    chunk({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
        },
      ],
    }),
    chunk({
      choices: [
        {
          delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }] },
        },
      ],
    }),
    chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ]);
  const calls = events.filter((e) => e.type === 'tool-call-delta');
  assert.equal(
    calls
      .filter((e) => e.index === 0)
      .map((e) => e.argsDelta)
      .join(''),
    '{"p":1}'
  );
  assert.equal(
    calls
      .filter((e) => e.index === 1)
      .map((e) => e.argsDelta)
      .join(''),
    '{"q":2}'
  );
});

test('finish_reason=length 映射为 length', async () => {
  const { events } = await run([
    chunk({ choices: [{ delta: {}, finish_reason: 'length' }] }),
  ]);
  assert.equal(events[events.length - 1].stopReason, 'length');
});

test('非 JSON 噪声行被跳过而不炸流', async () => {
  const { events } = await run([
    'this is not json',
    chunk({ choices: [{ delta: { content: 'ok' } }] }),
  ]);
  assert.ok(events.some((e) => e.type === 'text-delta' && e.text === 'ok'));
});

test('错误分类：401/403/404/429/400/5xx', async () => {
  const cases = [
    [401, 'provider', /API Key/],
    [404, 'provider', /\/v1/],
    [429, 'provider', /限流/],
    [400, 'provider', /400/],
    [503, 'provider', /服务端/],
  ];
  for (const [status, kind, re] of cases) {
    const fetchImpl = async () =>
      new Response('{"error":1}', { status, headers: { 'retry-after': '3' } });
    const events = await collect(
      // retryDelays: [] —— 这里只验错误分类，不验重试；否则每个 429/5xx 都要真等
      streamChat({ messages: [], config: CONFIG, fetchImpl, retryDelays: [] })
    );
    const err = events.find((e) => e.type === 'error');
    assert.ok(err, `status ${status} 应产出 error`);
    assert.equal(err.kind, kind);
    assert.match(err.message, re);
  }
});

test('429 的提示带 retry-after', async () => {
  const fetchImpl = async () =>
    new Response('', { status: 429, headers: { 'retry-after': '7' } });
  const events = await collect(
    streamChat({ messages: [], config: CONFIG, fetchImpl, retryDelays: [] })
  );
  assert.match(events[0].message, /7s/);
});

test('429 把服务端原文带出来 —— 不再一律说成「触发限流」', async () => {
  // 回归背景：429 分支曾经只读 retry-after（多数网关不给这个 header），
  // 于是「余额/配额不足」被翻译成一句「触发限流」，真因整个被吞掉。
  const fetchImpl = async () =>
    new Response('{"error":{"message":"insufficient balance"}}', {
      status: 429,
    });
  const events = await collect(
    streamChat({ messages: [], config: CONFIG, fetchImpl, retryDelays: [] })
  );
  const err = events[0];
  assert.equal(err.type, 'error');
  assert.match(err.message, /insufficient balance/);
  assert.match(err.message, /配额|额度/);
  assert.equal(err.retryable, false, '配额不足重试无意义');
});

test('真限流会按退避表重试，恢复后正常出流', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls <= 2) {
      return new Response(
        '{"error":{"message":"We have to rate limit you for model m."}}',
        { status: 429 }
      );
    }
    return sseResponse([chunk({ choices: [{ delta: { content: 'ok' } }] })]);
  };

  const events = await collect(
    streamChat({
      messages: [],
      config: CONFIG,
      fetchImpl,
      retryDelays: [0, 0],
    })
  );

  assert.equal(calls, 3, '两次 429 后应重试并成功');
  assert.ok(!events.some((e) => e.type === 'error'), '重试成功后不该有 error');
  assert.ok(events.some((e) => e.type === 'text-delta' && e.text === 'ok'));
});

test('退避表取尽仍失败时如实报错，且仍标记为可重试', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('rate limit exceeded', { status: 429 });
  };

  const events = await collect(
    streamChat({
      messages: [],
      config: CONFIG,
      fetchImpl,
      retryDelays: [0, 0],
    })
  );

  assert.equal(calls, 3, '1 次原始 + 2 次重试');
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].retryable, true);
  assert.match(events[0].message, /限流/);
});

test('网络异常归为 network 且不抛错', async () => {
  const fetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
  const events = await collect(
    streamChat({ messages: [], config: CONFIG, fetchImpl })
  );
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].kind, 'network');
  assert.match(events[0].message, /Failed to fetch/);
});

test('wire 消息映射：tool 消息带 tool_call_id', () => {
  const wire = toWireMessages([
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'obs' },
  ]);
  assert.equal(wire[2].tool_calls[0].function.arguments, '{"a":1}');
  assert.equal(wire[3].tool_call_id, 'c1');
  assert.equal(wire[3].role, 'tool');
});

test('tools 完整落进请求体 —— 用真实链路，不手写形状', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = JSON.parse(init.body);
    return sseResponse([chunk({ choices: [{ delta: {} }] })]);
  };

  // 关键：走真正的 toWireTools(TOOLS)，不要手写夹具。
  // 这一条测试之前传的是裸定义 {name, description, parameters}，
  // 而 openai-compat 当时正好在做一次多余的包装 —— 两边错得一模一样，
  // 所以它绿着，还顺手给 bug 做了背书。
  await collect(
    streamChat({
      messages: [{ role: 'user', content: 'x' }],
      tools: toWireTools(TOOLS),
      config: CONFIG,
      fetchImpl,
    })
  );

  assert.equal(captured.tools.length, TOOLS.length);

  // JSON.stringify 会丢掉 undefined —— 所以必须断言真值，
  // 不能只断言键存在。服务端收到 function:{} 时报的正是缺 name。
  captured.tools.forEach((t, i) => {
    assert.ok(t.type === 'function', `tools.${i}.type`);
    assert.equal(
      typeof t.function.name,
      'string',
      `tools.${i}.function.name 丢了`
    );
    assert.ok(t.function.name.length > 0, `tools.${i}.function.name 为空`);
    assert.ok(t.function.description, `tools.${i}.function.description 丢了`);
    assert.equal(
      t.function.parameters && t.function.parameters.type,
      'object',
      `tools.${i}.function.parameters 丢了`
    );
  });

  // 断言「顺序与注册表一致」而不是写死下标：注册表加一个工具就挪位的断言是噪音
  assert.deepEqual(
    captured.tools.map((t) => t.function.name),
    TOOLS.map((t) => t.name)
  );
  assert.equal(captured.tool_choice, 'auto');
  assert.equal(captured.stream, true);
});

test('模拟双重包装会把 name 抹掉 —— 正是刚修掉的那个 bug', () => {
  // 反向守卫：确认上面那组断言真的能拦住「发了空工具」这种事故。
  const wire = toWireTools(TOOLS);

  // 模拟双重包装：把每个工具再裹一层，name 就丢了
  const broken = wire.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const dropped = JSON.parse(JSON.stringify(broken));

  assert.equal(typeof dropped[8].function.name, 'undefined');
});

/* ---------------- 分片 args 回归（2026-10 实测 P0） ---------------- */

test('quirk 2（实测回归）：分片 args 只在收尾 emit 一次完整调用 —— ModelScope 形态', async () => {
  // 实测 api-inference.modelscope.cn：首包 id+name+空参数，之后每个 chunk
  // 只带 index + 一段参数片段。旧行为逐片 emit，loop 对半截 JSON 直接
  // JSON.parse 会把整轮对话炸掉。
  const { events } = await run([
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_x',
                function: { name: 'echo', arguments: '' },
              },
            ],
          },
        },
      ],
    }),
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '{"msg": "窗前' } },
            ],
          },
        },
      ],
    }),
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '明月光"}' } }],
          },
        },
      ],
    }),
    chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ]);

  const calls = events.filter((e) => e.type === 'tool-call-delta');
  assert.equal(calls.length, 1, '每个调用只 emit 一次');
  assert.equal(calls[0].id, 'call_x', 'emit 时必须带 id，否则 loop 会跳过');
  assert.equal(calls[0].name, 'echo');
  assert.deepEqual(JSON.parse(calls[0].argsDelta), { msg: '窗前明月光' });
  assert.equal(events[events.length - 1].stopReason, 'tool_calls');
});

test('网关不发 finish_reason 也不发 [DONE] 就断流：照样 flush 攒到的调用', async () => {
  const fetchImpl = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          const line =
            'data: ' +
            chunk({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'c9',
                        function: { name: 'f', arguments: '{"a":1}' },
                      },
                    ],
                  },
                },
              ],
            }) +
            '\n\n';
          c.enqueue(new TextEncoder().encode(line));
          c.close();
        },
      }),
      { status: 200 }
    );

  const events = await collect(
    streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      config: CONFIG,
      fetchImpl,
    })
  );

  const calls = events.filter((e) => e.type === 'tool-call-delta');
  assert.equal(calls.length, 1, '断流也要把攒到的调用吐出来');
  assert.equal(calls[0].id, 'c9');
  assert.equal(events[events.length - 1].type, 'done');
});

test('usage chunk 转成 usage 事件（choices 为空的收尾包也能过）', async () => {
  const { events } = await run([
    chunk({ choices: [{ delta: { content: 'x' } }] }),
    chunk({ usage: { prompt_tokens: 120, completion_tokens: 7 }, choices: [] }),
    chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ]);
  const usage = events.filter((e) => e.type === 'usage');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].input, 120);
  assert.equal(usage[0].output, 7);
  assert.equal(events[events.length - 1].stopReason, 'end');
});
