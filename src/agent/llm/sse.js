/**
 * SSE（Server-Sent Events）读取。
 *
 * 分帧交给 eventsource-parser，不再自己手搓：
 * 之前那个逐行切分的实现要自己处理分包、CRLF、结尾 flush、多行 data ——
 * 这些恰恰是 SSE 规范里最容易漏的边界，而漏了不会报错，只会静默丢消息。
 *
 * 保留的一层薄壳：把回调式 parser 接到 AsyncGenerator 上，
 * 因为 openai-compat 的 for-await 用法比回调顺手。
 */
import { createParser } from 'eventsource-parser';

/**
 * @typedef {Object} SSEMessage
 * @property {string=} event
 * @property {string} data
 */

/**
 * 逐条产出 SSE 消息。调用方负责 data 的业务语义。
 *
 * @param {Response} response
 * @param {AbortSignal=} signal
 * @returns {AsyncGenerator<SSEMessage, void, void>}
 */
export async function* readSSELines(response, signal) {
  const { body } = response;

  if (!body) throw new Error('response has no body');

  const reader = body.getReader();
  const decoder = new TextDecoder();

  const queue = [];
  let notify = null;

  const push = (msg) => {
    queue.push(msg);

    if (notify) {
      const wake = notify;

      notify = null;
      wake();
    }
  };

  // 记录自上一个事件边界以来的原文。
  // eventsource-parser 对「结尾没有空行」的残流不发事件（实测：
  // feed('data: x\n') 后 feed 与 reset({consume:true}) 都不产出），
  // 而网关并不总是规规矩矩补上结尾空行。
  // 所以收尾时自己补一个边界，把残流逼出来 —— 分帧仍然全部由库负责。
  let sinceBoundary = '';

  // 等待「下一批数据」的 promise。
  // 提到循环外定义：循环内建闭包既触发 no-loop-func，读起来也不如一句话清楚。
  const nextBatch = () =>
    new Promise((resolve) => {
      notify = resolve;
    });

  const parser = createParser({
    onEvent: (msg) => push({ event: msg.event, data: msg.data }),
  });

  // 读网络与产出并发跑。串行写会把流式卡成批处理 ——
  // 第一个 token 要等整个回答结束才出现。
  const pump = (async () => {
    try {
      for (;;) {
        if (signal?.aborted) break;

        const { done, value } = await reader.read();

        if (done) {
          // 补一个事件边界，逼 parser 把残流吐出来。
          // 已经吐过（末尾有空行）时 sinceBoundary 为空，这次 feed 是空操作。
          if (sinceBoundary.trim()) parser.feed('\n\n');

          parser.reset({ consume: true });
          break;
        }

        const text = decoder.decode(value, { stream: true });

        sinceBoundary += text;
        parser.feed(text);

        const cut = sinceBoundary.lastIndexOf('\n\n');

        if (cut !== -1) sinceBoundary = sinceBoundary.slice(cut + 2);
      }
    } catch (err) {
      push({ __error: err });
    } finally {
      reader.releaseLock();
      push({ __done: true });
    }
  })();

  try {
    for (;;) {
      if (queue.length === 0) {
        if (signal?.aborted) return;

        // eslint-disable-next-line no-await-in-loop
        await nextBatch();
      }

      while (queue.length > 0) {
        const msg = queue.shift();

        if (msg.__error) throw msg.__error;
        if (msg.__done) return;

        yield msg;
      }
    }
  } finally {
    // 消费者提前退出（出错、被中断）时别让 pump 一直挂着
    try {
      await reader.cancel();
    } catch {
      // 已经结束就无所谓
    }

    await pump;
  }
}

/** OpenAI 兼容流式的结束标记 */
export const SSE_DONE = '[DONE]';

/**
 * 把 SSE 流转成已解析的 JSON 对象，自动跳过 [DONE] 与无法解析的行。
 *
 * @param {Response} response
 * @param {AbortSignal=} signal
 * @returns {AsyncGenerator<Object, void, void>}
 */
export async function* readSSEJSON(response, signal) {
  for await (const msg of readSSELines(response, signal)) {
    const data = (msg.data || '').trim();

    if (!data || data === SSE_DONE) continue;

    try {
      yield JSON.parse(data);
    } catch {
      // 网关偶尔混进非 JSON 的噪声行，跳过而不是让整个流炸掉
    }
  }
}
