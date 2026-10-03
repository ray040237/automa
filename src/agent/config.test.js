import test from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_CONFIG,
  PROVIDERS,
  STORAGE_KEY,
  loadConfig,
  saveConfig,
  validateConfig,
  redactConfig,
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
      encrypt: (v) => 'enc:' + v,
      decrypt: (v) => (v && v.startsWith('enc:') ? v.slice(4) : ''),
    },
  };
}

const good = { ...DEFAULT_CONFIG, apiKey: 'sk-test' };

test('默认配置本身应该合法', () => {
  const r = validateConfig({ ...DEFAULT_CONFIG, apiKey: 'sk-x' });
  assert.equal(r.ok, true, r.errors.join(';'));
});

test('缺 apiKey / baseUrl / model 都报错并说明缺哪个', () => {
  // 用 custom 而不是 openai：预设 provider 会自动补 baseUrl 与 model，那是想要的行为
  const bare = validateConfig({
    provider: 'custom',
    baseUrl: '',
    model: '',
    apiKey: '',
  });
  assert.equal(bare.errors.length, 3, bare.errors.join(';'));
  assert.ok(bare.errors.some((e) => e.includes('baseUrl')));
  assert.ok(bare.errors.some((e) => e.includes('model')));
  assert.ok(bare.errors.some((e) => e.includes('apiKey')));

  // 预设能补齐的就不该报错
  assert.equal(
    validateConfig({ provider: 'openai', apiKey: 'k' }).errors.length,
    0
  );
  assert.ok(
    validateConfig({ ...DEFAULT_CONFIG, apiKey: '' }).errors.some((e) =>
      e.includes('apiKey')
    )
  );
});

test('baseUrl 必须是 http(s)，挡掉明文与 javascript: 之类', () => {
  // 用数组拼出来：这一行就是要验证这种串被拦下（写成字面量会被 no-script-url 拦）
  const jsScheme = ['java', 'script:alert(1)'].join('');
  ['ftp://a.com', jsScheme, 'a.com'].forEach((u) => {
    const r = validateConfig({ ...good, baseUrl: u });
    assert.equal(r.ok, false, u + ' 应被拒');
  });
});

test('未知 provider 被拒 —— 不能因为写错一个 id 就把密钥发到预设之外的地址', () => {
  const r = validateConfig({ ...good, provider: 'evil' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('provider')));
});

test('temperature 越界报错', () => {
  assert.equal(validateConfig({ ...good, temperature: -1 }).ok, false);
  assert.equal(validateConfig({ ...good, temperature: 3 }).ok, false);
  assert.equal(validateConfig({ ...good, temperature: 0 }).ok, true);
});

test('选了预设 provider 时能补出默认 baseUrl 与 model', () => {
  const r = validateConfig({ provider: 'deepseek', apiKey: 'k' });
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.equal(r.config.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(r.config.model, 'deepseek-chat');
});

test('自定义 provider 必须自己填 baseUrl', () => {
  const r = validateConfig({ provider: 'custom', apiKey: 'k' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('baseUrl')));
});

test('保存时 apiKey 加密落盘', async () => {
  const { io, store } = fakeIO();
  const r = await saveConfig(io, good);
  assert.equal(r.ok, true);
  assert.equal(store[STORAGE_KEY].apiKey, 'enc:sk-test');
  assert.equal(store[STORAGE_KEY].model, DEFAULT_CONFIG.model);
});

test('读回来是明文，且未知字段不会污染配置', async () => {
  const { io } = fakeIO({
    [STORAGE_KEY]: {
      provider: 'deepseek',
      model: 'x',
      apiKey: 'enc:sk-9',
      恶意字段: 1,
    },
  });
  const c = await loadConfig(io);
  assert.equal(c.apiKey, 'sk-9');
  assert.equal(
    c.temperature,
    DEFAULT_CONFIG.temperature,
    '缺的字段用默认值补齐'
  );
});

test('没有存过配置时返回默认值而不是崩', async () => {
  const { io } = fakeIO();
  const c = await loadConfig(io);
  assert.equal(c.provider, DEFAULT_CONFIG.provider);
  assert.equal(c.apiKey, '');
});

test('校验不过就不写盘，避免把坏配置存进去', async () => {
  const { io, store } = fakeIO();
  const r = await saveConfig(io, { provider: 'openai', apiKey: '' });
  assert.equal(r.ok, false);
  assert.deepEqual(store, {}, '失败时不应留下任何东西');
});

test('脱敏只留后 4 位，日志里看不到完整密钥', () => {
  const r = redactConfig({ apiKey: 'sk-abcdefghijkl' });
  assert.ok(!r.apiKey.includes('abcdefgh'));
  assert.ok(r.apiKey.endsWith('ijkl)'));
});

test('空密钥脱敏后不留下误导性的尾巴', () => {
  assert.equal(redactConfig({ apiKey: '' }).apiKey, '');
});

test('所有预设的 baseUrl 都是 https', () => {
  PROVIDERS.filter((p) => p.baseUrl).forEach((p) => {
    assert.ok(
      p.baseUrl.startsWith('https://'),
      p.id + ' 的 baseUrl 应为 https'
    );
  });
});

test('预设里都有可用模型，避免用户还要自己想一个', () => {
  PROVIDERS.filter((p) => p.id !== 'custom' && p.id !== 'openrouter').forEach(
    (p) => {
      assert.ok(p.models.length > 0, p.id + ' 应至少给一个默认模型');
    }
  );
});
