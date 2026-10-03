import test from 'node:test';
import assert from 'node:assert';
import { readSSELines, readSSEJSON, SSE_DONE } from './sse';

/** 把字符串切成若干片，喂成 ReadableStream，用来模拟真实的 TCP 分包 */
function chunked(text, size) {
  const parts = [];
  for (let i = 0; i < text.length; i += size)
    parts.push(text.slice(i, i + size));
  return new Response(
    new ReadableStream({
      start(c) {
        parts.forEach((p) => c.enqueue(new TextEncoder().encode(p)));
        c.close();
      },
    })
  );
}

async function collect(gen) {
  const out = [];
  for await (const v of gen) out.push(v);
  return out;
}

test('基本解析：data 行与空行边界', async () => {
  const res = chunked('data: {"a":1}\n\ndata: {"a":2}\n\n', 1024);
  assert.deepEqual(await collect(readSSELines(res)), [
    { event: undefined, data: '{"a":1}' },
    { event: undefined, data: '{"a":2}' },
  ]);
});

test('半包：一个事件被切成 1 字节一片也能正确重组', async () => {
  const body = 'data: {"long":"' + 'x'.repeat(200) + '"}\n\n';
  const res = chunked(body, 1);
  const out = await collect(readSSELines(res));
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0].data).long.length, 200);
});

test('\\r\\n 行尾被正确处理', async () => {
  const res = chunked('data: {"a":1}\r\n\r\n', 1024);
  const out = await collect(readSSELines(res));
  assert.equal(out.length, 1);
  assert.equal(out[0].data, '{"a":1}');
});

test('CRLF 被拆在两个 chunk 中间也能正确处理', async () => {
  const res = chunked('data: {"a":1}\r\n\r\n', 9); // 切断在 \r 与 \n 之间
  const out = await collect(readSSELines(res));
  assert.equal(out.length, 1);
  assert.equal(out[0].data, '{"a":1}');
});

test('event: 字段被采集', async () => {
  const res = chunked('event: done\ndata: {}\n\n', 1024);
  const out = await collect(readSSELines(res));
  assert.equal(out[0].event, 'done');
});

test('多行 data 用换行拼接', async () => {
  const res = chunked('data: line1\ndata: line2\n\n', 1024);
  const out = await collect(readSSELines(res));
  assert.equal(out[0].data, 'line1\nline2');
});

test('注释行被忽略', async () => {
  const res = chunked(': this is a ping\ndata: {"a":1}\n\n', 1024);
  const out = await collect(readSSELines(res));
  assert.equal(out.length, 1);
  assert.equal(out[0].data, '{"a":1}');
});

test('结尾无空行时 flush 残余数据', async () => {
  const res = chunked('data: {"a":1}\n', 1024); // 没有结尾空行
  const out = await collect(readSSELines(res));
  assert.equal(out.length, 1);
  assert.equal(out[0].data, '{"a":1}');
});

test('abort 时提前停止且不抛错', async () => {
  const ac = new AbortController();
  ac.abort();
  const res = chunked('data: {"a":1}\n\ndata: {"a":2}\n\n', 1024);
  const out = await collect(readSSELines(res, ac.signal));
  assert.equal(out.length, 0);
});

test('readSSEJSON 跳过 [DONE] 与非 JSON 噪声行', async () => {
  const body =
    'data: {"n":1}\n\n' +
    'data: this is not json\n\n' +
    `data: ${SSE_DONE}\n\n` +
    'data: {"n":2}\n\n';
  const out = await collect(readSSEJSON(chunked(body, 1024)));
  assert.deepEqual(out, [{ n: 1 }, { n: 2 }]);
});

test('无 body 的 response 明确报错而不是静默产出空流', async () => {
  const res = { body: null };
  await assert.rejects(() => collect(readSSELines(res)), /no body/);
});
