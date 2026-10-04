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
import {
  readPage,
  findText,
  normalizeReadPageArgs,
  getVariables,
  getBlockSchema,
} from './page';

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
      'find_text',
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
  assert.equal(requiresConfirmation('read_page', TOOLS), false);
  assert.equal(requiresConfirmation('totally_unknown', TOOLS), true);
  assert.equal(requiresConfirmation(undefined, TOOLS), true);
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
  assert.equal(findTool('read_page', TOOLS), readPage);
  assert.equal(findTool('nope', TOOLS), null);
});

/* ---------------- execute 行为 ---------------- */

test('read_page 默认 addresses，且把归一化后的参数透传给 ctx', async () => {
  const calls = [];
  const ctx = {
    readPage: async (p) => {
      calls.push(p);
      return 'PAGE:' + p.detail;
    },
  };
  const res = await readPage.execute({}, ctx);

  assert.equal(res.payload, 'PAGE:addresses');
  assert.deepEqual(calls, [{ detail: 'addresses', maxChars: undefined }]);

  await readPage.execute({ detail: 'content', maxChars: 2000 }, ctx);
  assert.deepEqual(calls[1], { detail: 'content', maxChars: 2000 });
});

test('read_page 的 detail 枚举是新口径的四档', () => {
  assert.deepEqual(readPage.parameters.properties.detail.enum, [
    'addresses',
    'probe',
    'content',
    'full',
  ]);
});

test('read_page 旧档位映射到新档位，不静默拒绝旧会话的参数', async () => {
  const norm = (d) => normalizeReadPageArgs({ detail: d });

  assert.equal(norm('auto').detail, 'addresses');
  assert.equal(norm('summary').detail, 'content');
  assert.equal(norm('interactive').detail, 'addresses');
  assert.equal(norm('full').detail, 'full');
  assert.equal(norm(undefined).detail, 'addresses');
});

test('read_page 未知 detail 报错而不是降级（T-18）', () => {
  const res = normalizeReadPageArgs({ detail: 'bogus' });
  assert.ok(res.error, '必须返回 error');
  assert.ok(res.error.includes('bogus'), '要指名道姓说是哪个值不对');
  assert.ok(res.error.includes('addresses'), '要把合法值列出来');
  assert.equal(res.detail, undefined, '有 error 时不得附带静默生效的档位');
});

test('read_page 的 maxChars 超出 400–8000 范围报错（T-23）', () => {
  assert.equal(normalizeReadPageArgs({ maxChars: 3000 }).maxChars, 3000);
  assert.ok(normalizeReadPageArgs({ maxChars: 100 }).error);
  assert.ok(normalizeReadPageArgs({ maxChars: 99999 }).error);
  assert.ok(normalizeReadPageArgs({ maxChars: 'abc' }).error);
  assert.equal(normalizeReadPageArgs({}).maxChars, undefined, '不传不校验');
});

test('read_page 把 content 侧的指纹上提到事件字段', async () => {
  const ctx = {
    readPage: async () => ({
      text: '<page…>正文</page>',
      fingerprint: '9f2c1a4e',
    }),
  };
  const res = await readPage.execute({ detail: 'probe' }, ctx);

  assert.equal(res.payload, '<page…>正文</page>');
  assert.equal(res.pageFingerprint, '9f2c1a4e', '指纹必须走 meta 而不是进正文');
  assert.ok(
    !res.payload.includes('9f2c1a4e'),
    '指纹不进观察值文本，否则会被 elide 抹掉'
  );
});

test('find_text：keyword 空时报错，正常时返回 content 侧文本', async () => {
  const seen = [];
  const ctx = {
    findText: async (p) => {
      seen.push(p);
      return 'HITS';
    },
  };

  const bad = await findText.execute({}, ctx);
  assert.equal(bad.status, 'error');
  assert.equal(seen.length, 0, '空 keyword 不该打到 content');

  const res = await findText.execute({ keyword: ' 运费 ', limit: 999 }, ctx);
  assert.equal(res.payload, 'HITS');
  assert.deepEqual(
    seen[0],
    { keyword: '运费', limit: 20 },
    'limit 要夹到上限 20'
  );
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
      requiresConfirmation(t.name, TOOLS),
      true,
      name + ' 必须需要用户确认'
    );
  });
});

test('query_elements 不被当成写操作：它只查询，不改页面', () => {
  const t = TOOLS.find((x) => x.name === 'query_elements');

  assert.equal(t.class, 'read');
  assert.equal(requiresConfirmation(t.name, TOOLS), false);
});
