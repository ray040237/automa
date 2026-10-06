import test from 'node:test';
import assert from 'node:assert';
import {
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  PROVIDER_TEMPLATES,
  STORAGE_KEY,
  loadConfig,
  loadConfigDoc,
  migrateLegacy,
  newProviderId,
  normalizeDoc,
  redactConfig,
  resolveActiveConfig,
  resolveContextWindow,
  revealApiKey,
  saveConfig,
  validateConfig,
} from './config';

/** 假 storage + 可逆的假加密（够验证调用关系，不必真的做密码学） */
function fakeIO(initial = {}) {
  const store = { ...initial };
  return {
    store,
    io: {
      get: async (k) => store[k],
      set: async (k, v) => {
        store[k] = v;
      },
      remove: async (k) => {
        delete store[k];
      },
      // 假加密必须**看不出原文**（base64），否则「落盘里搜不到明文」这条断言
      // 会被 'enc:sk-x' 这种前缀骗过 —— 密文里明明就含着明文当子串。
      encrypt: (v) =>
        'enc:' + Buffer.from(String(v), 'utf8').toString('base64'),
      decrypt: (v) =>
        v && v.startsWith('enc:')
          ? Buffer.from(v.slice(4), 'base64').toString('utf8')
          : '',
    },
  };
}

/** 一条能过校验的连接，改哪句改哪句 */
function provider(over = {}) {
  return {
    id: 'p_1',
    name: '测试连接',
    templateId: 'custom',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    models: [{ id: 'm1', contextWindow: 65536, maxTokens: 0 }],
    ...over,
  };
}

function doc(over = {}) {
  return {
    version: CONFIG_VERSION,
    providers: [provider()],
    activeProviderId: 'p_1',
    activeModelId: 'm1',
    temperature: 0.2,
    ...over,
  };
}

// ---------------------------------------------------------------- 模板表

test('模板表里所有 baseUrl 都是 https', () => {
  PROVIDER_TEMPLATES.filter((t) => t.baseUrl).forEach((t) => {
    assert.ok(
      t.baseUrl.startsWith('https://'),
      t.id + ' 的 baseUrl 应为 https'
    );
  });
});

test('模板表里除自定义端点外都有默认模型，避免用户还要自己想一个', () => {
  PROVIDER_TEMPLATES.filter(
    (t) => t.id !== 'custom' && t.id !== 'openrouter'
  ).forEach((t) => {
    assert.ok(t.models.length > 0, t.id + ' 应至少给一个默认模型');
  });
});

test('模板建议的窗口本身够大，不会让压缩被判为不可用', () => {
  PROVIDER_TEMPLATES.filter((t) => t.contextWindow).forEach((t) => {
    assert.ok(
      t.contextWindow >= 4096,
      t.id + ' 的建议窗口 < 4096 会让压缩直接关闭'
    );
  });
});

test('resolveContextWindow：按模板预填，查不到回落 64K 默认值', () => {
  assert.equal(resolveContextWindow('openai', 'gpt-4o-mini'), 128000);
  assert.equal(resolveContextWindow('deepseek', 'deepseek-chat'), 65536);
  // openrouter / 自定义端点没有表可查 —— 回落默认，不假装知道
  assert.equal(
    resolveContextWindow('openrouter', 'whatever'),
    DEFAULT_CONFIG.contextWindow
  );
  assert.equal(
    resolveContextWindow('不存在的模板', 'x'),
    DEFAULT_CONFIG.contextWindow
  );
  assert.equal(DEFAULT_CONFIG.contextWindow, 200000, '回落默认按 200K');
});

// ---------------------------------------------------------------- 连接级校验

test('一条填全的连接应该合法', () => {
  const r = validateConfig(doc());
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.equal(r.config.activeProviderId, 'p_1');
  assert.equal(r.config.activeModelId, 'm1');
});

test('缺接口地址 / 缺 Key / 零模型都报错，且点名是哪一条', () => {
  const r = validateConfig(
    doc({
      providers: [
        provider({ name: '公司反代', baseUrl: '', apiKey: '' }),
        provider({ id: 'p_2', name: '本地推理', models: [] }),
      ],
    })
  );

  assert.equal(r.ok, false);
  const joined = r.errors.join('\n');
  assert.ok(joined.includes('公司反代'), joined);
  assert.ok(joined.includes('缺少接口地址'), joined);
  assert.ok(joined.includes('缺少 API Key'), joined);
  assert.ok(joined.includes('本地推理'), joined);
  assert.ok(joined.includes('至少添加一个模型'), joined);
});

test('接口地址必须是 http(s)，挡掉明文与 javascript: 之类', () => {
  // 用数组拼出来：这一行就是要验证这种串被拦下（写成字面量会被 no-script-url 拦）
  const jsScheme = ['java', 'script:alert(1)'].join('');

  ['ftp://a.com', jsScheme, 'a.com'].forEach((u) => {
    const r = validateConfig(doc({ providers: [provider({ baseUrl: u })] }));
    assert.equal(r.ok, false, u + ' 应被拒');
  });
});

test('连接名重复被拒 —— 列表里靠名字认人，重名就没法说清删的是哪条', () => {
  const r = validateConfig(
    doc({
      providers: [
        provider({ id: 'p_1', name: 'OpenAI' }),
        provider({ id: 'p_2', name: 'openai' }),
      ],
    })
  );

  assert.equal(r.ok, false);
  assert.ok(r.errors.join().includes('重复'), r.errors.join(';'));
});

test('同一条连接里同名模型被拒 —— 那只会让人以为有两个', () => {
  const r = validateConfig(
    doc({
      providers: [
        provider({
          models: [
            { id: 'gpt-4o', contextWindow: 128000 },
            { id: 'gpt-4o', contextWindow: 65536 },
          ],
        }),
      ],
    })
  );

  assert.equal(r.ok, false);
  assert.ok(r.errors.join().includes('重复'), r.errors.join(';'));
});

test('删掉最后一条连接是合法的 —— 空列表不是错误', () => {
  const r = validateConfig(
    doc({ providers: [], activeProviderId: '', activeModelId: '' })
  );

  assert.equal(r.ok, true, r.errors.join(';'));
  assert.equal(r.config.activeProviderId, '');
  assert.equal(r.config.activeModelId, '');
});

test('temperature 越界报错', () => {
  assert.equal(validateConfig(doc({ temperature: -1 })).ok, false);
  assert.equal(validateConfig(doc({ temperature: 3 })).ok, false);
  assert.equal(validateConfig(doc({ temperature: 0 })).ok, true);
});

test('maxTokens：留空/0 = 不限制，填了必须够大（T-96）', () => {
  const withModel = (maxTokens) =>
    validateConfig(
      doc({
        providers: [
          provider({ models: [{ id: 'm', contextWindow: 65536, maxTokens }] }),
        ],
      })
    ).config.providers[0].models[0].maxTokens;

  assert.equal(withModel(undefined), 0);
  assert.equal(withModel(''), 0);
  assert.equal(withModel(0), 0);
  assert.equal(withModel(2048), 2048);

  const tooSmall = validateConfig(
    doc({
      providers: [
        provider({
          models: [{ id: 'm', contextWindow: 65536, maxTokens: 100 }],
        }),
      ],
    })
  );
  assert.equal(tooSmall.ok, false);
  assert.ok(tooSmall.errors.some((e) => e.includes('单次回复上限')));

  const notNumber = validateConfig(
    doc({
      providers: [
        provider({
          models: [{ id: 'm', contextWindow: 65536, maxTokens: 'abc' }],
        }),
      ],
    })
  );
  assert.equal(notNumber.ok, false);
});

test('上下文窗口小于 1024 被拒 —— 填小了会让压缩提前触发到没法用', () => {
  const r = validateConfig(
    doc({
      providers: [
        provider({ models: [{ id: 'm', contextWindow: 512, maxTokens: 0 }] }),
      ],
    })
  );

  assert.equal(r.ok, false);
  assert.ok(r.errors.join().includes('上下文窗口'), r.errors.join(';'));
});

test('没填上下文窗口就回落默认，而不是存一个 undefined 进压缩公式', () => {
  const r = validateConfig(
    doc({ providers: [provider({ models: [{ id: 'm', maxTokens: 0 }] })] })
  );

  assert.equal(r.ok, true, r.errors.join(';'));
  assert.equal(
    r.config.providers[0].models[0].contextWindow,
    DEFAULT_CONFIG.contextWindow
  );
});

// ---------------------------------------------------------------- 选中项自愈

test('当前连接/模型指向不存在的东西时自愈到第一条，而不是让整份配置加载不出来', () => {
  const r = validateConfig(
    doc({
      providers: [
        provider({
          id: 'p_1',
          name: 'A',
          models: [{ id: 'a1', contextWindow: 65536 }],
        }),
        provider({
          id: 'p_2',
          name: 'B',
          models: [{ id: 'b1', contextWindow: 65536 }],
        }),
      ],
      activeProviderId: 'p_deleted',
      activeModelId: 'also_deleted',
    })
  );

  assert.equal(r.config.activeProviderId, 'p_1');
  assert.equal(r.config.activeModelId, 'a1');
});

test('当前模型只在当前连接底下找 —— 别的连接的同名模型与当前连接无关', () => {
  const r = validateConfig(
    doc({
      providers: [
        provider({
          id: 'p_1',
          name: 'A',
          models: [{ id: 'shared', contextWindow: 65536 }],
        }),
        provider({
          id: 'p_2',
          name: 'B',
          models: [
            { id: 'shared', contextWindow: 128000 },
            { id: 'b2', contextWindow: 65536 },
          ],
        }),
      ],
      activeProviderId: 'p_2',
      activeModelId: 'shared',
    })
  );

  // 命中的是 p_2 底下那个 shared，不是 p_1 的
  assert.equal(r.config.activeModelId, 'shared');
  assert.equal(r.config.activeProviderId, 'p_2');

  const wrong = validateConfig(
    doc({
      providers: [
        provider({
          id: 'p_1',
          name: 'A',
          models: [{ id: 'only-in-a', contextWidth: 1, contextWindow: 65536 }],
        }),
        provider({
          id: 'p_2',
          name: 'B',
          models: [{ id: 'only-in-a', contextWindow: 65536 }],
        }),
      ],
      activeProviderId: 'p_2',
      activeModelId: 'only-in-a',
    })
  );
  // 名字在 p_2 底下也有 —— 但如果只有 p_1 有，就必须退回 p_2 的第一个
  const onlyA = validateConfig(
    doc({
      providers: [
        provider({
          id: 'p_1',
          name: 'A',
          models: [{ id: 'only-a', contextWindow: 65536 }],
        }),
        provider({
          id: 'p_2',
          name: 'B',
          models: [{ id: 'b1', contextWindow: 65536 }],
        }),
      ],
      activeProviderId: 'p_2',
      activeModelId: 'only-a',
    })
  );
  assert.equal(onlyA.config.activeModelId, 'b1', '不能选中别的连接里的模型');
  assert.equal(wrong.config.activeModelId, 'only-in-a');
});

// ---------------------------------------------------------------- v1 迁移

test('v1 单条配置自动迁移成第 1 条连接，密文原样搬、名字用旧 id', () => {
  const d = migrateLegacy({
    provider: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    contextWindow: 131072,
    maxTokens: 0,
    apiKey: 'enc:sk-old',
    temperature: 0.4,
  });

  assert.equal(d.version, CONFIG_VERSION);
  assert.equal(d.providers.length, 1);
  const p = d.providers[0];
  assert.equal(p.name, 'zhipu', '连接名直接用旧 provider id');
  assert.equal(p.templateId, 'zhipu');
  assert.equal(p.apiKey, 'enc:sk-old', '密文原样搬，不重新加密也不解密');
  assert.equal(p.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(p.models.length, 1);
  assert.equal(p.models[0].id, 'glm-4-flash');
  assert.equal(p.models[0].contextWindow, 131072);
  assert.equal(d.activeProviderId, p.id);
  assert.equal(d.activeModelId, 'glm-4-flash');
  assert.equal(d.temperature, 0.4);
});

test('迁移时旧结构没填的窗口按模板建议值补，不留 undefined', () => {
  const d = migrateLegacy({
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'enc:k',
  });

  assert.equal(d.providers[0].models[0].contextWindow, 128000);
  assert.equal(d.providers[0].baseUrl, 'https://api.openai.com/v1');
});

test('一个可用字段都没有的旧结构不硬造连接出来', () => {
  const d = migrateLegacy({});

  assert.deepEqual(d.providers, []);
  assert.equal(d.activeProviderId, '');
});

test('已经是 v2 的存储不再被迁移（providers 数组是判据）', () => {
  const d = normalizeDoc(doc());

  assert.equal(d.providers.length, 1);
  assert.equal(d.providers[0].name, '测试连接');
});

test('存储里的未知字段不会流进规范化文档', () => {
  const d = normalizeDoc({
    ...doc(),
    恶意字段: 1,
    providers: [{ ...provider(), 另一个脏字段: 'x' }],
  });

  assert.equal(d.恶意字段, undefined);
  assert.equal(d.providers[0].另一个脏字段, undefined);
});

// ---------------------------------------------------------------- 运行时摊平

test('摊平后的形状与 v1 一模一样，provider 用连接 id', () => {
  const flat = resolveActiveConfig(validateConfig(doc()).config, 'sk-plain');

  assert.deepEqual(Object.keys(flat).sort(), [
    'apiKey',
    'baseUrl',
    'contextWindow',
    'maxTokens',
    'model',
    'provider',
    'temperature',
  ]);
  assert.equal(flat.model, 'm1');
  assert.equal(flat.provider, 'p_1');
  assert.equal(flat.baseUrl, 'https://api.example.com/v1');
  assert.equal(flat.apiKey, 'sk-plain');
});

test('没有连接时摊平成「未配置」，apiKey 为空串是唯一信号', () => {
  const flat = resolveActiveConfig(
    validateConfig(
      doc({ providers: [], activeProviderId: '', activeModelId: '' })
    ).config,
    ''
  );

  assert.equal(flat.apiKey, '');
  assert.deepEqual(flat, DEFAULT_CONFIG);
});

// ---------------------------------------------------------------- 读写

test('保存后能原样读回，且任何一条连接的密钥在落盘里都不是明文', async () => {
  const { io, store } = fakeIO();
  const input = doc({
    providers: [
      provider({ id: 'p_1', name: '公司反代', apiKey: 'sk-secret-one' }),
      provider({
        id: 'p_2',
        name: '个人号',
        apiKey: 'sk-secret-two',
        models: [{ id: 'm2', contextWindow: 32768 }],
      }),
    ],
    activeProviderId: 'p_2',
    activeModelId: 'm2',
  });

  const r = await saveConfig(io, input);

  assert.ok(r.ok, r.errors.join(';'));

  const dumped = JSON.stringify(store[STORAGE_KEY]);

  assert.ok(!dumped.includes('sk-secret-one'), '第一条的密钥落盘不能是明文');
  assert.ok(!dumped.includes('sk-secret-two'), '第二条的密钥落盘不能是明文');

  const back = await loadConfig(io);

  assert.equal(back.apiKey, 'sk-secret-two');
  assert.equal(back.model, 'm2');
  assert.equal(back.contextWindow, 32768);
  assert.equal(back.provider, 'p_2');
});

test('没动密钥时原样写回，不会把已存的密钥清掉', async () => {
  const { io, store } = fakeIO();
  const input = doc();

  await saveConfig(io, input);
  const before = store[STORAGE_KEY].providers[0].apiKey;

  // 模拟「用户只改了模型名，没碰密钥」：apiKey 空，encryptedKey 是存储里那段
  const cipher = before;
  await saveConfig(io, {
    ...doc(),
    providers: [
      {
        ...provider(),
        apiKey: '',
        encryptedKey: cipher,
        models: [{ id: 'gpt-4o', contextWindow: 65536 }],
      },
    ],
  });

  assert.equal(
    store[STORAGE_KEY].providers[0].apiKey,
    cipher,
    '密文应原样还在'
  );
  const back = await loadConfig(io);

  assert.equal(back.apiKey, 'sk-test');
  assert.equal(back.model, 'gpt-4o');
});

test('读回来是明文，且缺省字段用默认值补齐', async () => {
  const { io } = fakeIO({
    [STORAGE_KEY]: {
      providers: [
        {
          id: 'p_1',
          name: 'x',
          baseUrl: 'https://a.example.com/v1',
          // 存储态的 apiKey 是密文：必须用 fakeIO 同一套假加密，否则 loadConfig 解不开
          apiKey: 'enc:' + Buffer.from('sk-9', 'utf8').toString('base64'),
          models: [{ id: 'mm' }],
        },
      ],
      activeProviderId: 'p_1',
      activeModelId: 'mm',
    },
  });

  const c = await loadConfig(io);

  assert.equal(c.apiKey, 'sk-9');
  assert.equal(
    c.contextWindow,
    DEFAULT_CONFIG.contextWindow,
    '缺的窗口用默认补齐'
  );
  assert.equal(c.temperature, DEFAULT_CONFIG.temperature);
});

test('v1 存储经 loadConfig 直接可用，不经过任何一次保存', async () => {
  const { io } = fakeIO({
    [STORAGE_KEY]: {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      contextWindow: 65536,
      maxTokens: 0,
      apiKey: 'enc:' + Buffer.from('sk-legacy', 'utf8').toString('base64'),
    },
  });

  const c = await loadConfig(io);

  assert.equal(c.apiKey, 'sk-legacy');
  assert.equal(c.model, 'deepseek-chat');
  assert.equal(c.baseUrl, 'https://api.deepseek.com/v1');
});

test('校验不过就不写盘，避免把坏配置存进去', async () => {
  const { io, store } = fakeIO();
  const r = await saveConfig(
    io,
    doc({ providers: [provider({ baseUrl: '' })] })
  );

  assert.equal(r.ok, false);
  assert.deepEqual(store, {}, '失败时不应留下任何东西');
});

test('没有存过配置时返回未配置形态而不是崩', async () => {
  const { io } = fakeIO();
  const c = await loadConfig(io);

  assert.equal(c.apiKey, '');
  assert.deepEqual(c, DEFAULT_CONFIG);
});

// ---------------------------------------------------------------- 设置页读文档

test('设置页拿到的文档里 apiKey 是空的，密文挪进 encryptedKey', async () => {
  const { io } = fakeIO();
  await saveConfig(io, doc());

  const d = await loadConfigDoc(io);

  assert.equal(d.providers[0].apiKey, '', '设置页不该拿到明文');
  assert.equal(d.providers[0].hasKey, true);
  assert.equal(d.providers[0].encryptedKey, io.encrypt('sk-test'));
});

test('revealApiKey 只解开点名的那一条，且不写回任何地方', async () => {
  const { io, store } = fakeIO();
  await saveConfig(
    io,
    doc({
      providers: [
        provider({ id: 'p_1', name: 'A', apiKey: 'sk-one' }),
        provider({ id: 'p_2', name: 'B', apiKey: 'sk-two' }),
      ],
      activeProviderId: 'p_2',
      activeModelId: 'm1',
    })
  );

  const before = JSON.stringify(store[STORAGE_KEY]);

  assert.equal(await revealApiKey(io, 'p_1'), 'sk-one');
  assert.equal(await revealApiKey(io, 'p_2'), 'sk-two');
  assert.equal(await revealApiKey(io, '不存在'), '');
  assert.equal(JSON.stringify(store[STORAGE_KEY]), before, '只读，不许写');
});

test('落盘的文档不含表单专用字段（encryptedKey / hasKey）', async () => {
  const { io, store } = fakeIO();
  await saveConfig(
    io,
    doc({
      providers: [{ ...provider(), encryptedKey: 'enc:stale', hasKey: true }],
    })
  );

  const dumped = JSON.stringify(store[STORAGE_KEY]);

  assert.ok(!dumped.includes('encryptedKey'), '表单字段不该进存储');
  assert.ok(!dumped.includes('hasKey'), '派生字段不该进存储');
});

// ---------------------------------------------------------------- 杂项

test('新建连接的 id 互不重复', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newProviderId()));

  assert.equal(ids.size, 50);
  ids.forEach((id) => assert.ok(id.startsWith('p_'), id));
});

test('脱敏只留后 4 位，日志里看不到完整密钥', () => {
  const r = redactConfig({ apiKey: 'sk-abcdefghijkl' });
  assert.ok(!r.apiKey.includes('abcdefgh'));
  assert.ok(r.apiKey.endsWith('ijkl)'));
});

test('空密钥脱敏后不留下误导性的尾巴', () => {
  assert.equal(redactConfig({ apiKey: '' }).apiKey, '');
});
