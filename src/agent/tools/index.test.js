import test from 'node:test';
import assert from 'node:assert';
import {
  TOOLS,
  TOOL_CLASSES,
  validateTools,
  toWireTools,
  findTool,
  requiresConfirmation,
} from './index';
import { readPage, getVariables, getBlockSchema } from './page';

const ok = (extra = {}) => ({
  name: 'x',
  class: 'read',
  group: 'g',
  description: 'd',
  parameters: { type: 'object', properties: {} },
  execute: async () => 'ok',
  ...extra,
});

test('真实工具表全部通过校验', () => {
  assert.equal(validateTools(TOOLS), true);
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    [
      'read_page',
      'get_variables',
      'get_block_schema',
      'query_elements',
      'highlight_selector',
      'test_js',
      'list_canvas',
      'add_block',
      'update_block',
      'list_tabs',
      'focus_tab',
      'open_url',
    ]
  );
});

test('漏写 class 必须抛错，不能默认放行', () => {
  const bad = ok();
  delete bad.class;
  assert.throws(() => validateTools([bad]), /没有声明 class/);
});

test('class 取值非法必须抛错', () => {
  assert.throws(() => validateTools([ok({ class: 'dangerous' })]), /只允许/);
  assert.throws(() => validateTools([ok({ class: 'readwrite' })]), /只允许/);
});

test('缺 name / execute / description / parameters / group 都抛错', () => {
  ['name', 'execute', 'description', 'parameters', 'group'].forEach((k) => {
    const bad = ok();
    delete bad[k];
    assert.throws(
      () => validateTools([bad]),
      new RegExp(k),
      '缺 ' + k + ' 应抛错'
    );
  });
});

test('工具名重复抛错', () => {
  assert.throws(() => validateTools([ok(), ok()]), /工具名重复/);
});

test('TOOL_CLASSES 只有 read / write —— 新增分类必须显式讨论', () => {
  assert.deepEqual(TOOL_CLASSES, ['read', 'write']);
});

test('未知工具一律要确认（fail-closed）', () => {
  assert.equal(requiresConfirmation('read_page'), false);
  assert.equal(requiresConfirmation('totally_unknown'), true);
  assert.equal(requiresConfirmation(undefined), true);
});

test('转 wire 定义时只暴露 OpenAI 认识的字段', () => {
  const [w] = toWireTools(TOOLS);
  assert.deepEqual(Object.keys(w), ['type', 'function']);
  assert.deepEqual(Object.keys(w.function), [
    'name',
    'description',
    'parameters',
  ]);
  assert.equal(w.type, 'function');
  // 绝不能把 execute 函数漏进请求体
  assert.equal(JSON.stringify(w).includes('execute'), false);
});

test('findTool 找不到返回 null 而不是抛错', () => {
  assert.equal(findTool('read_page'), readPage);
  assert.equal(findTool('nope'), null);
});

/* ---------------- execute 行为 ---------------- */

test('read_page 默认 auto，且把 detail 透传给 ctx', async () => {
  const calls = [];
  const ctx = {
    readPage: async (d) => {
      calls.push(d);
      return 'PAGE:' + d;
    },
  };
  assert.equal(await readPage.execute({}, ctx), 'PAGE:auto');
  assert.equal(
    await readPage.execute({ detail: 'interactive' }, ctx),
    'PAGE:interactive'
  );
  assert.deepEqual(calls, ['auto', 'interactive']);
});

test('read_page 参数里 detail 只能是枚举内的值', () => {
  assert.deepEqual(readPage.parameters.properties.detail.enum, [
    'auto',
    'summary',
    'interactive',
    'full',
  ]);
});

test('get_variables 渲染出变量与全局变量', async () => {
  const ctx = {
    getVariables: async () => ({
      variables: { kw: 'selenium', n: 3 },
      globals: { site: 'e.com' },
      workflowId: 'wf-1',
    }),
  };
  const out = await getVariables.execute({}, ctx);
  assert.ok(out.includes('- kw = "selenium"'));
  assert.ok(out.includes('- n = 3'));
  assert.ok(out.includes('- site = "e.com"'));
  assert.ok(out.includes('当前工作流 id: wf-1'));
});

test('get_variables 空值不炸，且明确标出是空的', async () => {
  const out = await getVariables.execute(
    {},
    { getVariables: async () => ({}) }
  );
  assert.ok(out.includes('工作流变量:'));
  assert.ok(out.includes('（空）'));
  assert.ok(out.includes('全局变量:'));
});

test('get_block_schema 命中时要给出字段清单 —— 只给名字模型没法填 data', async () => {
  const ctx = {
    getBlockSchema: async (n) => ({
      id: 'javascript-code',
      name: n,
      description: '执行一段 JS',
      category: 'data',
      refDataKeys: ['variable', 'globalVar'],
      data: { code: '', timeout: 30000, description: '' },
    }),
  };

  const out = await getBlockSchema.execute({ name: 'JavaScript' }, ctx);

  assert.match(out, /JavaScript/, '要有块名');
  assert.match(out, /javascript-code/, '要给出块 id，add_block 靠它');
  assert.match(out, /code/, '必须列出字段，否则模型只能瞎猜 data');
  assert.match(out, /timeout/);
  assert.match(out, /variable/, '可用的数据引用也要给');
});

test('get_block_schema 的清单模式同时给 id 和块名', async () => {
  const ctx = {
    getBlockSchema: async (n) =>
      n === '*' ? [{ id: 'javascript-code', name: 'JavaScript' }] : null,
  };

  const out = await getBlockSchema.execute({ name: '查不到的块' }, ctx);

  assert.match(out, /javascript-code/);
  assert.match(out, /JavaScript/);
});

test('get_block_schema 猜错块名时列出全部可用块名，不做模糊匹配', async () => {
  const ctx = {
    getBlockSchema: async (n) =>
      n === '*'
        ? [
            { id: 'search-query', name: 'Search Query' },
            { id: 'javascript-code', name: 'JavaScript' },
          ]
        : null,
  };
  const out = await getBlockSchema.execute({ name: 'serch-query' }, ctx);

  assert.match(out, /没有名为 serch-query 的块/);
  // id 是 add_block 真正要用的，必须列出来
  assert.match(out, /search-query/);
  assert.match(out, /javascript-code/);
  assert.match(out, /Search Query/, '块名也要给');
});

test('get_block_schema 缺参数时给出可操作的提示', async () => {
  const out = await getBlockSchema.execute(
    {},
    { getBlockSchema: async () => null }
  );
  assert.equal(out, '请提供块名。');
});

test('required 字段在 wire 上保留', () => {
  assert.deepEqual(getBlockSchema.parameters.required, ['name']);
});

test('没有工具的 description 是空的 —— 空描述会让模型完全不调这个工具', () => {
  TOOLS.forEach((tl) => {
    assert.ok(
      tl.description && tl.description.length > 20,
      tl.name + ' 的描述过短'
    );
  });
});

test('每个能改动页面的工具都必须自己声明成 write', () => {
  // P1 加了 test_js。它会真的在页面里跑代码，必须走确认门；
  // 一旦有人把它改成 read，等于给任意代码执行开了一条免确认的路子。
  const WRITE_TOOLS = ['test_js'];

  WRITE_TOOLS.forEach((name) => {
    const t = TOOLS.find((x) => x.name === name);

    assert.ok(t, name + ' 应存在');
    assert.equal(t.class, 'write', name + ' 必须是 write');
    assert.equal(
      requiresConfirmation(t.name),
      true,
      name + ' 必须需要用户确认'
    );
  });
});

test('query_elements 不被当成写操作：它只查询，不改页面', () => {
  const t = TOOLS.find((x) => x.name === 'query_elements');

  assert.equal(t.class, 'read');
  assert.equal(requiresConfirmation(t.name), false);
});
