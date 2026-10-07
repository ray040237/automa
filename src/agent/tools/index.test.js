import test from 'node:test';
import assert from 'node:assert';
import {
  TOOLS,
  TOOL_CLASSES,
  validateTools,
  findTool,
  requiresConfirmation,
} from './index';
import { defineTool } from './define';
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
  ctx: [],
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
      'read_skill',
      'query_elements',
      'highlight_selector',
      'test_js',
      'list_canvas',
      'read_block',
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

test('缺 ctx 声明必须抛错 —— ctx 是工具与装配层的 interface 契约（T-133）', () => {
  const bad = ok();
  delete bad.ctx;
  assert.throws(() => validateTools([bad]), /缺少 ctx 声明/);
});

test('ctx 声明必须是字符串数组（允许空数组 = 零依赖）', () => {
  assert.throws(() => validateTools([ok({ ctx: 'targetTab' })]), /ctx 声明/);
  assert.throws(() => validateTools([ok({ ctx: [1] })]), /ctx 声明/);
  assert.throws(() => validateTools([ok({ ctx: [''] })]), /ctx 声明/);
  assert.doesNotThrow(() => validateTools([ok({ ctx: [] })]));
});

test('每个真实工具的 ctx 声明与其实现用的键一一对应（T-133）', () => {
  // 改任何工具的 ctx 依赖（或新增工具）都必须有意识地更新这张表 ——
  // 它就是「工具声明什么、装配层给什么」这份契约的测试面。
  const expected = {
    read_page: ['readPage'],
    find_text: ['findText'],
    get_variables: ['getVariables'],
    get_block_schema: ['getBlockSchema'],
    read_skill: ['readSkill'],
    query_elements: ['targetTab', 'sendMessage'],
    highlight_selector: ['targetTab', 'sendMessage'],
    test_js: ['targetTab', 'sendMessage'],
    list_canvas: ['editor'],
    read_block: ['editor'],
    add_block: ['blocks', 'editor', 'newId', 'onCanvasChanged'],
    update_block: ['editor', 'onCanvasChanged'],
    list_tabs: ['listTabs'],
    focus_tab: ['pins', 'getTab', 'addPin', 'focusTab'],
    open_url: ['createTab', 'addPin', 'focusTab'],
  };
  TOOLS.forEach((t) => assert.deepEqual(t.ctx, expected[t.name], t.name));
});

/* ---------------- T-127：defineTool 构造器 ---------------- */

test('T-127：15 个生产工具全部经 defineTool 产出，且都带 label', () => {
  // 这条是本条的核心断言：生产工具的形状由构造器统一归一，不再靠
  // `adapter.js` 的 `tool.label || tool.name` 在运行时兜底。
  TOOLS.forEach((t) => {
    assert.equal(
      t.label,
      t.name,
      t.name + ' 的 label 必须是 name（构造器补的）'
    );
  });
  assert.equal(TOOLS.length, 15);
});

test('T-127：缺 label 时构造器补 name，显式给了就保留', () => {
  const bare = defineTool(ok());
  assert.equal(bare.label, 'x', '缺省填 name');

  const named = defineTool(ok({ label: '自定义' }));
  assert.equal(named.label, '自定义', '显式 label 不被覆盖');
});

test('T-127：缺必填字段在定义时就抛，不等装配期', () => {
  ['name', 'class', 'group', 'description', 'parameters', 'execute'].forEach(
    (key) => {
      const bad = ok();
      delete bad[key];
      assert.throws(() => defineTool(bad), new RegExp(key), '缺 ' + key);
    }
  );
});

test('T-127：class 不给默认值（ADR 0002 fail-closed）', () => {
  // 关键红线：绝不能 `class = spec.class || 'read'`。
  // 那会让漏写 class 的写工具静默变成免确认。
  const bad = ok();
  delete bad.class;
  assert.throws(() => defineTool(bad), /class/);
});

test('T-127：write 类缺 confirmDetail 在定义时就抛（T-134）', () => {
  assert.throws(() => defineTool(ok({ class: 'write' })), /confirmDetail/);
});

test('T-127：ctx 必须是字符串数组，零依赖也要显式写 ctx: []', () => {
  assert.throws(() => defineTool(ok({ ctx: 'targetTab' })), /ctx/);
  assert.throws(() => defineTool(ok({ ctx: [1] })), /ctx/);
  assert.throws(() => defineTool(ok({ ctx: [''] })), /ctx/);
  const noCtx = ok();
  delete noCtx.ctx;
  assert.throws(() => defineTool(noCtx), /ctx/);
  assert.doesNotThrow(() => defineTool(ok({ ctx: [] })));
});

test('T-127：构造器不吞未知键，参数对象原样透出', () => {
  const t = defineTool(ok({ group: 'canvas' }));
  assert.equal(t.group, 'canvas', '不能因为走构造器就把字段吃掉');
});

test('TOOL_CLASSES 只有 read / write —— 新增分类必须显式讨论', () => {
  assert.deepEqual(TOOL_CLASSES, ['read', 'write']);
});

test('未知工具一律要确认（fail-closed）—— loop 的闸现在真的调它（T-134）', () => {
  assert.equal(requiresConfirmation('read_page', TOOLS), false);
  assert.equal(requiresConfirmation('totally_unknown', TOOLS), true);
  assert.equal(requiresConfirmation(undefined, TOOLS), true);
});

test('write 类工具必须自带 confirmDetail，缺了加载期就抛（T-134）', () => {
  const bad = ok({ class: 'write' });
  delete bad.confirmDetail;
  assert.throws(() => validateTools([bad]), /confirmDetail/);

  // read 类没有此要求（不过闸）
  assert.doesNotThrow(() => validateTools([ok()]));

  // 真实注册表里的每个 write 工具都带了
  TOOLS.filter((t) => t.class === 'write').forEach((t) => {
    assert.equal(
      typeof t.confirmDetail,
      'function',
      t.name + ' 缺 confirmDetail'
    );
  });
});

test('每个 write 工具的 confirmDetail 都能产出合法 kind', () => {
  const KINDS = ['code', 'selector', 'url', 'canvas'];

  TOOLS.filter((t) => t.class === 'write').forEach((t) => {
    const mine = t.confirmDetail({});
    assert.ok(KINDS.includes(mine.kind), t.name + ' 的 kind=' + mine.kind);
    assert.equal(typeof mine.detail, 'string', t.name + ' 缺 detail');
  });
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

test('T-50：未绑定工作流时说的是「没有工作流可读」，不是「变量为空」', async () => {
  // 这两种结论对模型完全不同：前者是「你得换个工作流页」，
  // 后者是「这个工作流确实没定义变量」。混起来模型就会凭空编一个变量名。
  const out = await getVariables.execute(
    {},
    { getVariables: async () => ({ bound: false }) }
  );

  assert.ok(out.includes('未绑定工作流'), out);
  assert.ok(!out.includes('（空）'), '未绑定绝不能渲染成「（空）」：' + out);
  assert.ok(!out.includes('工作流变量:'), '未绑定时不列变量段：' + out);
});

test('T-50：getVariables 返回 undefined 也不炸，且按未绑定处理', async () => {
  const out = await getVariables.execute(
    {},
    { getVariables: async () => undefined }
  );
  assert.ok(out.includes('未绑定工作流'), out);
});
test('T-113：每行变量都带类型标注（string/number/array/null/…）', async () => {
  // description 承诺「含值与类型」，实现曾经只打印值。Automa 模板里字符串要引号、
  // 数字不要 —— 类型恰恰是模型最容易写错的一处，缺了它就没有纠偏依据。
  const out = await getVariables.execute(
    {},
    {
      getVariables: async () => ({
        bound: true,
        workflowId: 'wf-1',
        variables: {
          username: 'alice',
          retries: 3,
          tags: ['a'],
          nothing: null,
        },
        globals: { site: 'e.com' },
      }),
    }
  );

  assert.ok(out.includes('- username = "alice"（string）'), out);
  assert.ok(out.includes('- retries = 3（number）'), out);
  // typeof 对数组/null 都只说 object，标注必须把它们分开
  assert.ok(out.includes('- tags = ["a"]（array）'), out);
  assert.ok(out.includes('- nothing = null（null）'), out);
  assert.ok(out.includes('- site = "e.com"（string）'), out);
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
