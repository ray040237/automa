/**
 * 工具适配层的测试（票 02）。
 *
 * 这一层承载**红线第 3 条**：工具返回值必须显式给出 `content` 与 `isError`。
 * 违反的后果全是静默失败：
 *   - 缺 `content` → pi 兜成 `"(no tool output)"`，正文与不可信标记一起消失
 *   - 缺 `isError` → 模型把失败当成功读
 * 所以每条都有专门的测试钉住，**不能靠「看起来对」过关**。
 */

import test from 'node:test';
import assert from 'node:assert';
import { toAgentTools, toToolResult } from './adapter';
import { TOOL_CLASSES } from './index';

/** 收集注册进来的 AgentTool，供断言形状用 */
const registry = (tools, deps) => toAgentTools(tools, deps);
const find = (list, name) => list.find((t) => t.name === name);

/* ---------------- toToolResult：返回值形状 ---------------- */

test('裸字符串返回值产出单个文本块', () => {
  const r = toToolResult('hello');
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, 'text');
  assert.equal(r.content[0].text, 'hello');
  assert.equal(r.isError, false);
});

test('非字符串裸值被 JSON 化，仍是单个文本块', () => {
  const r = toToolResult({ a: 1 });
  assert.equal(r.content.length, 1);
  assert.deepEqual(JSON.parse(r.content[0].text), { a: 1 });
});

test('undefined 返回值也产出内容块，不让 pi 兜成 "(no tool output)"', () => {
  // 这是红线第 3 条：pi 对空 content 会发 "(no tool output)"，
  // 那会把「工具确实返回了空」变成「工具没说话」，模型无从分辨。
  const r = toToolResult(undefined);
  assert.ok(Array.isArray(r.content));
  assert.equal(r.content.length, 1, 'content 必须有一个块，不能是空数组');
  assert.equal(r.content[0].text, '');
});

test('信封的 payload 当正文，不再套一层 JSON', () => {
  // 现状行为（实测 +59% 字符）：{status:'ok', payload:'63 字符'} 若整体
  // JSON 化会给模型多看一层机器话。
  const r = toToolResult({ status: 'ok', payload: '正文只有 63 字符' });
  assert.equal(r.content[0].text, '正文只有 63 字符');
  assert.ok(!r.content[0].text.includes('"status"'));
  assert.equal(r.isError, false);
});

test('信封的 error status 升级成 isError，且正文是人话', () => {
  const r = toToolResult({ status: 'error', payload: '选择器不合法：bad [' });
  assert.equal(r.isError, true, '内层 error 必须升级，否则模型把失败读成成功');
  assert.ok(r.content[0].text.includes('工具未成功执行'));
  assert.ok(r.content[0].text.includes('选择器不合法'));
});

test('信封的 rejected status 也算失败', () => {
  const r = toToolResult({ status: 'rejected', payload: '用户拒绝了' });
  assert.equal(r.isError, true);
});

test('信封的 meta 上提到 details，不进正文', () => {
  const r = toToolResult({ payload: '地址正文', pageFingerprint: '9f2c1a4e' });
  assert.equal(r.details.pageFingerprint, '9f2c1a4e', 'meta 必须能被结构化读');
  assert.ok(!r.content[0].text.includes('9f2c1a4e'), 'meta 不给模型看');
});

test('已是 AgentToolResult 形状的值原样放行，不认识的结构不猜', () => {
  const input = {
    content: [{ type: 'text', text: 'x' }],
    details: { k: 1 },
    isError: true,
  };
  const r = toToolResult(input);
  assert.deepEqual(r.details, { k: 1 });
  assert.equal(r.isError, true);
});

test('已折好的结果缺 isError 时补false，不留undefined', () => {
  // isError: undefined 会让下游 `if (result.isError)` 走到false 分支，
  // 但语义上「没声明」与「明确不失败」应该分开，故显式补 false。
  const r = toToolResult({
    content: [{ type: 'text', text: 'x' }],
    details: {},
  });
  assert.equal(r.isError, false);
});

/* ---------------- toAgentTools：注册与形状 ---------------- */

const sampleTools = () => [
  {
    name: 'echo',
    class: 'read',
    group: 'context',
    description: '回显参数',
    parameters: { type: 'object', properties: { a: { type: 'number' } } },
    execute: async (args) => ({ payload: 'echo:' + JSON.stringify(args) }),
  },
  {
    name: 'boom',
    class: 'read',
    group: 'context',
    description: '总是抛错',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      throw new Error('tool exploded');
    },
  },
  {
    name: 'do_write',
    class: 'write',
    group: 'canvas',
    description: '写东西',
    parameters: { type: 'object', properties: {} },
    execute: async () => '已写入',
  },
];

test('每个工具都补上了 pi 要求的 label', () => {
  const list = registry(sampleTools());
  list.forEach((t) => {
    assert.equal(typeof t.label, 'string', `${t.name} 缺 label`);
    assert.ok(t.label.length > 0, `${t.name} 的 label 不能为空`);
  });
});

test('class 与 group 原样挂在注册结果上，没有被藏进闭包', () => {
  // 票 03/04 要用它们：class 决定确认门，group 决定不可信标签。
  // 藏起来的话那两票就得反查工具表。
  const list = registry(sampleTools());
  assert.equal(find(list, 'do_write').class, 'write');
  assert.equal(find(list, 'do_write').group, 'canvas');
  assert.equal(find(list, 'echo').class, 'read');
});

test('只有 read|write 两个 class，多一档就抛（ADR 0002）', () => {
  assert.deepEqual(TOOL_CLASSES, ['read', 'write']);
  assert.throws(
    () => registry([{ ...sampleTools()[0], class: 'soft-write' }]),
    /class/,
    '第三档分类必须抛错，不能静默降级成免确认'
  );
});

test('缺 class 的工具在注册期就抛，不给免确认留后门', () => {
  const bad = sampleTools()[0];
  delete bad.class;
  assert.throws(() => registry([bad]), /class/, '缺 class 必须抛');
});

test('适配层把 pi 的 (toolCallId, params, signal) 翻译成工具的 (args, ctx)', async () => {
  // 工具本体**故意不改签名**：它们有自己的一批测试，改签名会让那批跟着改，
  // 而它们测的是「工具做什么」不是「工具怎么描述给模型」。翻译在这一层做。
  const seen = [];
  const ctrl = new AbortController();
  const list = registry([
    {
      ...sampleTools()[0],
      execute: async (...args) => {
        seen.push(args);
        return 'ok';
      },
    },
  ]);
  await find(list, 'echo').execute('call-1', { a: 1 }, ctrl.signal);

  assert.equal(seen.length, 1);
  assert.deepEqual(
    seen[0][0],
    { a: 1 },
    '工具收到的第一个参数是参数，不是 toolCallId'
  );
  assert.equal(seen[0][1].signal, ctrl.signal, '中止信号进 ctx');
  assert.equal(seen[0].length, 2, '工具只收 (args, ctx) 两个参数');
});

test('工具抛错转成 isError 结果，不往上抛', () => {
  // 重抛会让 pi 打断整个 run ——「错误即观察值」要求模型能看到并自纠。
  const list = registry(sampleTools());
  return find(list, 'boom')
    .execute('c1', {})
    .then((r) => {
      assert.equal(r.isError, true);
      assert.ok(r.content[0].text.includes('tool exploded'));
    });
});

test('工具拿到的 ctx 带上了注入的执行上下文与中止信号', async () => {
  let seenCtx = null;
  const list = registry(
    [
      {
        ...sampleTools()[0],
        execute: async (args, ctx) => {
          seenCtx = ctx;
          return 'ok';
        },
      },
    ],
    { toolCtx: { sendMessage: () => {} } }
  );
  const ctrl = new AbortController();
  await find(list, 'echo').execute('c1', {}, ctrl.signal);
  assert.equal(typeof seenCtx.sendMessage, 'function', '注入的执行上下文要在');
  assert.equal(seenCtx.signal, ctrl.signal, '中止信号要透传');
});

test('tools 参数不是数组时抛错，不回落全量TOOLS', () => {
  // 现状行为（T-45）：findTool/requiresConfirmation 都要求显式传 tools，
  // 默认回落全量会泄露画布工具给无画布的宿主。
  assert.throws(() => toAgentTools(null), /tools|数组|必填/);
});
