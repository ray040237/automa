/**
 * OpenAI-compatible Chat Completions 流式适配。
 *
 * P0/P1 只注册这一个 provider（技术方案 §5.1）。事件流对 loop 做了抽象，
 * loop 不感知任何 provider 细节。
 *
 * 保留的方言 quirk（每一条都有真实网关触发，**修之前必须先验证上游已修复**）：
 *
 *  1. [DONE] 到达但仍有未收尾的 tool_calls —— 智谱 open.bigmodel.cn、
 *     阿里百炼 dashscope.aliyuncs.com 已知行为。收尾时先 flush，
 *     再按 stopReason='tool_calls' 结束（否则本轮被当成"模型说完了"，
 *     工具永远不执行，agent 静默卡死）。
 *  2. tool_calls 的 arguments 分片流式下发 —— DeepSeek 官方、ModelScope
 *     实测形态：首包带 id+name+空参数，随后每个 chunk 只带 index + 一段参数
 *     片段（如 '{'、'"msg": "窗前'）。必须在这里按 index 累积、流收尾时
 *     每个调用只 emit 一次完整 JSON：loop 对每条 tool-call-delta 直接
 *     JSON.parse，半截 JSON 会在那里炸掉整轮对话。
 *  3. tool_calls[].index 用于多工具并行对齐；缺失时按数组下标兜底。
 *  4. finish_reason 映射 stop->end / tool_calls->tool_calls / length->length。
 *
 * 另外白捡支持：delta.reasoning_content（DeepSeek-R1 等）-> thinking-delta。
 *
 * 刻意不用 @/utils/api 的 fetchApi：它在 IS_OFFLINE 时直接抛错，而用户自带
 * baseURL + apiKey 不是 Automa 云端，离线版应当可用（技术方案 §5.5）。
 */

import { readSSELines, SSE_DONE } from '../sse';

/**
 * @typedef {Object} StreamEvent
 * @property {'text-delta'|'thinking-delta'|'tool-call-delta'|'done'|'error'} type
 * @property {string=} text
 * @property {number=} index
 * @property {string=} id
 * @property {string=} name
 * @property {string=} argsDelta
 * @property {'end'|'tool_calls'|'length'=} stopReason
 * @property {string=} kind
 * @property {string=} message
 * @property {number=} status
 */

/**
 * 按 baseUrl 形态拼出 endpoint。用户既可能填 https://api.openai.com/v1，
 * 也可能填 https://api.openai.com —— 后者要补 /v1。
 *
 * @param {string} baseUrl
 * @returns {string}
 */
export function buildEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('缺少 baseUrl');
  return /\/v\d+$/.test(base)
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
}

/**
 * 内部消息 -> wire 消息。
 *
 * @param {Array<Object>} messages
 * @returns {Array<Object>}
 */
export function toWireMessages(messages) {
  return messages.map((m) => {
    if (
      m.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0
    ) {
      return {
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.tool_calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: {
            name: c.function?.name,
            arguments: c.function?.arguments || '{}',
          },
        })),
      };
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.tool_call_id,
        content: m.content || '',
      };
    }
    return { role: m.role, content: m.content || '' };
  });
}

/**
 * 把失败归一成**唯一**的错误 chunk 形状。
 *
 * 为什么要有这个函数：
 * 之前 provider 产出 {type:'error', kind, message}，而 loop 读的是 chunk.error，
 * 两者对不上 —— 于是 streamError 一直是 undefined，
 * 服务端说的「触发限流」被整个吞掉，用户只看到助手不吭声。
 * 更糟的是测试夹具照着**消费方**写的形状，于是 226 条测试一条都没发现。
 *
 * 所以形状只在这里定义一次：产出方必须走这个函数，消费方直接用 chunk。
 *
 * @param {Object} payload
 * @param {string} payload.kind network | provider | stream
 * @param {string} payload.message 给人看的，能直接显示
 * @param {number=} payload.status
 * @param {boolean=} payload.retryable 真限流为 true（退避后可重试）；
 *   配额/额度不足为 false —— 这种重试一万次也是一样的结果，别浪费用户时间
 * @returns {{type: 'error', kind: string, message: string, status: (number|undefined), retryable: (boolean|undefined)}}
 */
export function errorChunk({ kind, message, status, retryable }) {
  return {
    type: 'error',
    kind,
    // message 必填：它就是用户唯一能看到的东西
    message: String(message || '未知错误'),
    ...(status !== undefined ? { status } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  };
}

/**
 * 把 HTTP 失败翻译成带 kind 的错误事件（技术方案 §5.4）。
 *
 * @param {Response} response
 * @returns {Promise<Object>}
 */
async function classifyHttpError(response) {
  const body = await response.text().catch(() => '');
  const { status } = response;

  if (status === 401 || status === 403) {
    return {
      kind: 'provider',
      message: 'API Key 无效或无权限，请检查配置里的 apiKey。',
      status,
    };
  }
  if (status === 404) {
    return {
      kind: 'provider',
      message: '接口路径不存在，请检查 Base URL 是否已包含 /v1。',
      status,
    };
  }
  if (status === 429) {
    // 429 是个大杂烩：真限流、免费额度用尽、配额不足都可能挂在这个码上，
    // 而且**同一家网关会用两种措辞随机报同一种情况**（ModelScope 实测：
    // `insufficient balance` 与 `We have to rate limit you` 在同一类请求上交替）。
    // 只看状态码 + retry-after（多数网关不给这个 header）会把真因整个吞掉，
    // 用户只看到一句「触发限流」，既不知道该等还是该充值，也不知道该找谁。
    // 所以 body 必须读——它就在上面，不读等于白读。
    const after = response.headers.get('retry-after');
    const low = body.toLowerCase();
    const quota = /insufficient balance|quota|credits?|balance|额度|余额/.test(
      low
    );

    let message;
    if (quota) {
      message =
        '接口返回 429：配额或额度不足（服务端原文：' +
        body.slice(0, 200).replace(/\s+/g, ' ') +
        '）。这通常不是代码问题，请检查服务商的免费额度/余额，或换一个模型与服务商。';
    } else if (after) {
      message = `触发限流，服务端建议 ${after}s 后重试。`;
    } else if (/rate ?limit|too many requests|限流/.test(low)) {
      message =
        '触发限流（服务端原文：' +
        body.slice(0, 200).replace(/\s+/g, ' ') +
        '）。稍等几秒重试通常即可恢复。';
    } else {
      message = `请求被限流（429）：${body.slice(0, 300).replace(/\s+/g, ' ')}`;
    }

    return { kind: 'provider', message, status, retryable: !quota };
  }
  if (status === 400) {
    // 附截断 body —— 400 最常见的原因是 prompt 超窗或模型不支持 function calling
    return {
      kind: 'provider',
      message: `请求被拒绝（400）：${body.slice(0, 500)}`,
      status,
    };
  }
  if (status >= 500) {
    return { kind: 'provider', message: `服务端错误（${status}）。`, status };
  }

  return {
    kind: 'provider',
    message: `请求失败（${status}）：${body.slice(0, 500)}`,
    status,
  };
}

/**
 * 可重试失败的默认退避表（毫秒）。
 *
 * 数值是实测定的：ModelScope 的真限流等 2s 就恢复 200，所以第一次 1s 够快，
 * 后面给到 3s、8s 覆盖更长的窗口。三次取尽仍未恢复就放弃 ——
 * 再拖下去用户只会以为界面卡死。
 */
export const DEFAULT_RETRY_DELAYS = [1000, 3000, 8000];

/**
 * 流式对话。
 *
 * @param {Object} params
 * @param {Array<Object>} params.messages
 * @param {Array<Object>=} params.tools
 * @param {{baseUrl: string, apiKey: string, model: string, temperature?: number}} params.config
 * @param {AbortSignal=} params.signal
 * @param {Function=} params.fetchImpl 注入用，便于测试
 * @param {number[]=} params.retryDelays 注入用：可重试失败的退避表（毫秒），
 *   逐次取用、取尽即放弃。测试传 [] 可立刻拿到错误而不必真等
 * @returns {AsyncGenerator<StreamEvent, void, void>}
 */
export async function* streamChat({
  messages,
  tools,
  config,
  signal,
  fetchImpl,
  retryDelays,
}) {
  const doFetch = fetchImpl || fetch;
  const url = buildEndpoint(config.baseUrl);

  const body = {
    model: config.model,
    messages: toWireMessages(messages),
    stream: true,
    ...(config.temperature !== undefined && {
      temperature: config.temperature,
    }),
  };

  if (tools && tools.length > 0) {
    // tools 进来时**已经是 wire 形状**（toWireTools 的产出：
    // {type:'function', function:{name,...}}），直接原样发送。
    //
    // 这里曾经又包了一层，拿 t.name 去填 —— 而 t 本身就是包装过的对象，
    // t.name 是 undefined，于是 JSON.stringify 把 undefined 全丢掉，
    // 服务端收到 9 个 function:{}，报「'name' is a required property」。
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  let response;

  // 真限流（服务端明确说的是 rate limit）等一会儿就能恢复 —— 实测 2s 后即 200，
  // 但一次 429 就把整轮对话打死，等于把可自愈的瞬时故障变成功能性故障。
  // 配额/额度不足不进这个循环：那种重试一万次也是一样的结果。
  // 退避表可注入（与 fetchImpl 同一理由）：不注入的话测试要真的等 12 秒。
  const delays = Array.isArray(retryDelays)
    ? retryDelays
    : DEFAULT_RETRY_DELAYS;

  const sleep = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      }
    });

  // eslint-disable-next-line no-constant-condition
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // apiKey 只走 header，绝不进 prompt / transcript / console
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) return;
      yield errorChunk({
        kind: 'network',
        message: `无法连接 ${url}：${
          e?.message || e
        }。请检查网络与 Base URL（企业代理也可能拦截）。`,
      });
      return;
    }

    if (response.ok) break;

    const failure = await classifyHttpError(response);
    // classifyHttpError 只对 429 给出 retryable；其余状态按「服务端错误可重试」兜底
    const retryable =
      failure.retryable !== undefined
        ? failure.retryable
        : response.status >= 500 || response.status === 408;

    if (!retryable || attempt >= delays.length) {
      yield errorChunk(failure);
      return;
    }

    await sleep(delays[attempt]);
    if (signal?.aborted) return;
  }

  // index -> 累积中的工具调用（quirk 2）。Map 保持插入序，flush 按 index 升序。
  const pendingCalls = new Map();

  const flushCalls = () =>
    [...pendingCalls.keys()]
      .sort((a, b) => a - b)
      .map((index) => {
        const call = pendingCalls.get(index);
        return {
          type: 'tool-call-delta',
          index,
          ...(call.id ? { id: call.id } : {}),
          ...(call.name ? { name: call.name } : {}),
          argsDelta: call.args,
        };
      });

  for await (const sse of readSSELines(response, signal)) {
    if (signal?.aborted) return;

    // —— quirk 1：[DONE] 早于 tool_calls 收尾 ——
    if (sse.data.trim() === SSE_DONE) {
      const flushed = flushCalls();
      for (const ev of flushed) {
        yield ev;
      }

      yield {
        type: 'done',
        stopReason: flushed.length > 0 ? 'tool_calls' : 'end',
      };
      return;
    }

    let chunk;
    try {
      chunk = JSON.parse(sse.data);
    } catch {
      continue; // 网关噪声行
    }

    // —— 用量统计（P3）：部分网关在流末尾附带 usage chunk ——
    // 刻意不主动请求 stream_options.include_usage：个别严格的兼容网关
    // 会对未知字段直接 400，宁可少统计也不能让请求挂掉。
    if (chunk.usage && typeof chunk.usage === 'object') {
      yield {
        type: 'usage',
        input: Number(chunk.usage.prompt_tokens) || 0,
        output: Number(chunk.usage.completion_tokens) || 0,
      };
    }

    const choice = chunk?.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta || {};

    if (delta.reasoning_content) {
      yield { type: 'thinking-delta', text: delta.reasoning_content };
    }

    if (delta.content) {
      yield { type: 'text-delta', text: delta.content };
    }

    if (Array.isArray(delta.tool_calls)) {
      // 必须用 for...of 而不是 forEach —— yield 不能出现在箭头函数里
      for (
        let arrayIdx = 0;
        arrayIdx < delta.tool_calls.length;
        arrayIdx += 1
      ) {
        const tc = delta.tool_calls[arrayIdx];
        // —— quirk 3：index 缺失时退回数组下标 ——
        const index = Number.isInteger(tc.index) ? tc.index : arrayIdx;

        // id / name 只随首包到，后续分片没有 —— 先到先得
        const call = pendingCalls.get(index) || { id: '', name: '', args: '' };
        call.id = call.id || tc.id || '';
        call.name = call.name || (tc.function && tc.function.name) || '';
        call.args += (tc.function && tc.function.arguments) || '';
        pendingCalls.set(index, call);
      }
    }

    // —— quirk 4：finish_reason 映射 ——
    if (choice.finish_reason) {
      const map = { stop: 'end', tool_calls: 'tool_calls', length: 'length' };
      const stopReason = map[choice.finish_reason];
      if (stopReason) {
        for (const ev of flushCalls()) {
          yield ev;
        }
        yield { type: 'done', stopReason };
        return;
      }
    }
  }

  // —— 兜底：有些网关既不发 finish_reason 也不发 [DONE] 就直接断流 ——
  // 攒到的调用照样吐出去，别让它们跟着连接一起消失；并补一个 done 收尾，
  // 保证「每条流必以 done 结束」这条契约对 loop 成立。
  const flushed = flushCalls();
  for (const ev of flushed) {
    yield ev;
  }
  yield {
    type: 'done',
    stopReason: flushed.length > 0 ? 'tool_calls' : 'end',
  };
}
