/**
 * Agent 配置。
 *
 * 纯逻辑与 IO 分离：加解密与 storage 都从外部注入，因此本文件可被 node --test 覆盖，
 * 也不会在 import 期碰到 browser / crypto-js。
 *
 * ## 形状（v2）
 *
 * 一份配置里有**多条连接**，每条连接带自己的 baseUrl / 密钥 / 模型列表；全局另有
 * 「当前连接 + 当前模型」两个标量。运行时只认当前那一条 —— `resolveActiveConfig()`
 * 把它摊平成与 v1 **完全相同**的扁平结构，于是 provider.js / loop.js / compaction.js
 * 一行都不用改。风险因此被完整关在这一层里。
 *
 * ## 两套 apiKey 字段，别混
 *
 * - `providers[].apiKey`：**存储态是密文**（沿用 v1 的落盘约定，迁移才能原样搬）。
 *   表单态被 `loadConfigDoc` 清空，只装用户当场敲进来的明文。
 * - `providers[].encryptedKey`：只活在表单里，装着从存储读来的那段密文，
 *   供「用户没动这个 Key」时原样写回。**UI 任何时候都不该渲染它。**
 *
 * 有效密钥 = `apiKey` 明文优先，否则 `encryptedKey`。这就是「没动密钥就别把空串
 * 写回去，否则会把已存的密钥清掉」（T-97）在配置层的落点。
 *
 * 密钥用项目既有的 credentialUtil（AES + HMAC，passKey 来自 getPassKey）加密，
 * 不另造加密方案 —— 两套加密并存只会让「到底哪套是当前有效的」变得无法回答。
 */

export const STORAGE_KEY = 'automaAgentConfig';
export const CONFIG_VERSION = 2;

/**
 * 厂商模板：**只**出现在「新建连接」的下拉里，点一下预填 baseUrl / 常用模型 / 建议窗口。
 *
 * 它们不是配置项，也不约束用户 —— 配置里存的是连接，不是厂商。同一个厂商建三条
 * 连接（三个 Key、两套反代）是完全合法的，所以 `validateConfig` 不再检查
 * provider 是否在枚举里。
 *
 * `contextWindow` 是**建议值**：BYOK 场景下 OpenAI 兼容协议不暴露模型窗口，只能按
 * 官方公开标称值预填，用户随时可改；同一模板下个别模型不同时用 `modelWindows` 覆盖。
 * 填小了提前压缩（多花一次摘要请求），填大了压缩不触发、只剩溢出恢复兜底 —— 两个
 * 方向都不致命，所以敢预填。查不到的（openrouter / 自定义端点 / 手填模型名）回落
 * `DEFAULT_CONFIG.contextWindow`，宁可按保守值提前压缩，也不要假装有数。
 */
export const PROVIDER_TEMPLATES = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
    contextWindow: 128000,
  },
  {
    id: 'modelscope',
    label: 'ModelScope 魔搭',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    // 免费额度限流很紧，429 是常态 —— 所以默认给个小模型先跑通
    models: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'],
    contextWindow: 32768,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat'],
    contextWindow: 65536,
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-32k'],
    contextWindow: 32768,
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-plus'],
    contextWindow: 131072,
  },
  {
    id: 'aliyun',
    label: '阿里百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo'],
    contextWindow: 131072,
  },
  {
    // 模型名由用户自填，没有表可查 —— 不预填，回落默认
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [],
  },
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', models: [] },
];

/**
 * 运行时看到的**未配置**形态，同时兜住 v1 遗留字段的缺省值。
 *
 * `apiKey: ''` 是「没配好」的**唯一**信号：`index.js` 的 send 开头与
 * `AgentPanel.vue` 的 `configured` 都只看这一个字段，所以连接被删空时，
 * 那两处的现有检查不用改就会接管。contextWindow 200K 是查不到建议值时的回落值
 * （compactionThresholds 的 reserve 上限 16384，所以触发点是 183616 估算 token）。
 */
export const DEFAULT_CONFIG = {
  provider: 'custom',
  baseUrl: '',
  model: '',
  temperature: 0.2,
  contextWindow: 200000,
  maxTokens: 0,
  apiKey: '',
};

const byTemplateId = (id) => PROVIDER_TEMPLATES.find((t) => t.id === id);

/**
 * 按模板/模型取上下文窗口的**建议值**。
 *
 * @param {string} templateId 建这条连接时用的模板
 * @param {string=} model
 * @returns {number}
 */
export function resolveContextWindow(templateId, model) {
  const preset = byTemplateId(templateId);
  if (!preset) return DEFAULT_CONFIG.contextWindow;
  const perModel =
    preset.modelWindows && model ? preset.modelWindows[model] : undefined;
  return perModel || preset.contextWindow || DEFAULT_CONFIG.contextWindow;
}

/**
 * 新建连接时用的 id。只在本地生成，不进任何网络请求。
 *
 * 直接用全局 `crypto`（浏览器与 node --test 都有），不写 `globalThis.crypto`：
 * 本项目 eslint 的 env 只声明了 browser，那种写法过不了 no-undef。
 *
 * 这个 id 只需要在同一份配置里不重复，不承担安全职责 —— 所以没有
 * randomUUID 时的兜底也用不着那么讲究。
 */
export function newProviderId() {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return 'p_' + crypto.randomUUID();
  }

  return (
    'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  );
}

function label(p, index) {
  const name = String(p.name || '').trim();

  return name ? `「${name}」` : `第 ${index + 1} 条`;
}

/**
 * 校验并补全一个模型条目。
 *
 * @param {Object} raw
 * @param {string} ctx 出错时用的前缀（`<连接名> 的模型 <n>`）
 * @returns {{errors: string[], model: Object}}
 */
function cleanModel(raw, ctx) {
  const src = raw || {};
  const errors = [];
  const id = String(src.id || '').trim();

  if (!id) errors.push(`${ctx}：缺少模型名`);

  let { contextWindow } = src;
  if (
    contextWindow === undefined ||
    contextWindow === null ||
    contextWindow === ''
  ) {
    contextWindow = DEFAULT_CONFIG.contextWindow;
  } else {
    contextWindow = Number(contextWindow);
    if (!Number.isFinite(contextWindow) || contextWindow < 1024) {
      errors.push(`${ctx}：上下文窗口必须是不小于 1024 的数字`);
    }
  }

  // maxTokens：留空 / 0 = 不限制（把上限交给端点默认）。一旦填了就要是个像样的数 ——
  // 太小的上限等于把「回答说到一半没了」变成常态（T-96②：真截断时 loop 会发
  // SYSTEM_NOTICE，用户看得见，不是静默）。
  let { maxTokens } = src;
  if (
    maxTokens === undefined ||
    maxTokens === null ||
    maxTokens === '' ||
    maxTokens === 0
  ) {
    maxTokens = DEFAULT_CONFIG.maxTokens;
  } else {
    maxTokens = Number(maxTokens);
    if (!Number.isFinite(maxTokens) || maxTokens < 256) {
      errors.push(
        `${ctx}：单次回复上限必须是不小于 256 的数字，留空表示不限制`
      );
    }
  }

  return { errors, model: { id, contextWindow, maxTokens } };
}

/**
 * 接口地址是不是一个我们真能发请求的 http(s) 端点。
 *
 * T-66：`/^https?:\/\//` 这个判断原本只长在 `cleanProvider`（保存路径）里，
 * 于是存储里的坏值能绕过它 —— `loadConfig` 不跑 `validateConfig`，
 * `ftp://`、`file://`、`javascript:` 原样进 `buildModel` 再交给 pi 请求层。
 * 抽成谓词让保存路径与运行时解析共用一份判断。
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isHttpUrl(value) {
  return /^https?:\/\//.test(String(value || '').trim());
}

/** 「测试连接」探针的超时（15s）。卡死的端点不能把设置页按钮一起拖住。 */
export const PROBE_TIMEOUT_MS = 15000;

/** 探针只验证「能不能通」，16 token 够模型回一句话，省流量也省用户的钱。 */
export const PROBE_MAX_TOKENS = 16;

/**
 * 「测试连接」的结果分类（纯函数，node --test 钉死）。
 *
 * 术语与设置页「获取可用模型」的那套刻意保持一致 —— 同一类失败在两处必须
 * 说同一句话，否则用户会以为遇到了两种毛病（`fetch` 那块的注释同理）。
 * 分类只认状态码、超时与网络异常，不碰响应正文，所以是确定性的。
 *
 * @param {{status?: number, ok?: boolean, hasChoices?: boolean,
 *          timedOut?: boolean, error?: *}} input
 * @returns {{ok: true} | {ok: false, errorKey: string, status?: number}}
 */
export function classifyProbeResult({
  status,
  ok,
  hasChoices,
  timedOut,
  error,
} = {}) {
  if (timedOut) return { ok: false, errorKey: 'timeout' };
  if (error) return { ok: false, errorKey: 'network' };
  if (status === 401 || status === 403) {
    return { ok: false, errorKey: 'keyRejected', status };
  }
  if (status === 429) return { ok: false, errorKey: 'rateLimited', status };
  if (status === 404 || status === 405) {
    return { ok: false, errorKey: 'notFound', status };
  }
  if (!ok) return { ok: false, errorKey: 'httpError', status };
  if (!hasChoices) return { ok: false, errorKey: 'unknownShape' };
  return { ok: true };
}

/**
 * 真发一次 chat 请求，验证这条连接能不能用（A2 的「测试连接」）。
 *
 * **为什么不能只测 `/models`**：很多端点不实现它（所以「获取可用模型」永远
 * 留着手填入口），而且列表能拉 ≠ chat 能通。这里打的是**生产同一条路** ——
 * 同一个 baseUrl、同一个模型、同一种 Bearer 鉴权，所以测出来的错就是用户
 * 真用时会看到的错，不会出现「测试通过、真用报错」。
 *
 * fetch 与 AbortController 都可注入，测试不碰真网络。
 *
 * @param {Object} input
 * @param {string} input.baseUrl
 * @param {string} input.apiKey
 * @param {string} input.model
 * @param {Function=} input.fetchFn
 * @param {number=} input.timeoutMs
 * @returns {Promise<{ok: boolean, errorKey?: string, status?: number, message?: string}>}
 */
export async function probeConnection({
  baseUrl,
  apiKey,
  model,
  fetchFn = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const url = String(baseUrl || '').trim();
  if (!isHttpUrl(url)) return { ok: false, errorKey: 'badUrl' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(`${url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: PROBE_MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
    });

    // 正文解析失败不单独成一类：能连上但返回体认不出，与「没有 choices」
    // 是同一件事，都走 unknownShape。
    const data = await res.json().catch(() => null);
    const hasChoices = Boolean(
      data && Array.isArray(data.choices) && data.choices.length
    );

    return classifyProbeResult({ status: res.status, ok: res.ok, hasChoices });
  } catch (err) {
    const result = classifyProbeResult({
      timedOut: Boolean(err && err.name === 'AbortError'),
      error: err,
    });
    // 网络层失败的原因（地址错、证书、CORS）各不相同，原样带出去让 UI 说清楚，
    // 不要塌成一句「连不上」。
    if (result.errorKey === 'network') {
      result.message = err && err.message ? err.message : String(err);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** * 校验并补全一条连接。
 *
 * @param {Object} raw
 * @param {number} index 在列表里的位置，只用于报错时称呼
 * @returns {{errors: string[], provider: Object}}
 */
function cleanProvider(raw, index) {
  const src = raw || {};
  const errors = [];
  const name = String(src.name || '').trim();
  const tag = label(src, index);
  const baseUrl = String(src.baseUrl || '').trim();

  if (!baseUrl) {
    errors.push(`${tag}：缺少接口地址`);
  } else if (!isHttpUrl(baseUrl)) {
    errors.push(`${tag}：接口地址必须以 http:// 或 https:// 开头`);
  }

  // 表单里新敲的明文与存储里的密文**分开留着**：揉成一个字段的话，
  // saveConfig 分不清手上是明文还是密文，会把密文再加密一次（enc:enc:sk-…）。
  const apiKey = String(src.apiKey || '').trim();
  const encryptedKey = String(src.encryptedKey || '');

  if (!apiKey && !encryptedKey) errors.push(`${tag}：缺少 API Key`);

  const models = [];
  const seen = new Set();

  (Array.isArray(src.models) ? src.models : []).forEach((m, i) => {
    const r = cleanModel(m, `${tag} 的第 ${i + 1} 个模型`);

    errors.push(...r.errors);
    // 同一条连接里挂两份同名模型只会在列表里让人以为有两个，其实删哪个都一样
    if (r.model.id && seen.has(r.model.id)) {
      errors.push(`${tag}：模型「${r.model.id}」重复了`);
    }
    seen.add(r.model.id);
    models.push(r.model);
  });

  if (models.length === 0) {
    errors.push(`${tag}：至少添加一个模型，否则这条连接用不了`);
  }

  return {
    errors,
    provider: {
      // id 缺失只可能来自手改存储。补一个，别让整份配置因为一个 id 就加载不出来。
      id: String(src.id || '') || newProviderId(),
      name,
      templateId: String(src.templateId || 'custom'),
      baseUrl,
      apiKey,
      encryptedKey,
      hasKey: Boolean(apiKey || encryptedKey),
      models,
    },
  };
}

/**
 * 校验并补全整份配置。
 *
 * 空列表**合法**：用户被允许删掉最后一条连接（助手随即进入「未配置」态并给出提示），
 * 所以「没有任何连接」不能是一条校验错误。
 *
 * @param {Object} input
 * @returns {{ok: boolean, config: Object, errors: string[]}}
 */
export function validateConfig(input) {
  const raw = input || {};
  const errors = [];

  const temperature =
    typeof raw.temperature === 'number'
      ? raw.temperature
      : DEFAULT_CONFIG.temperature;
  if (typeof temperature !== 'number' || temperature < 0 || temperature > 2) {
    errors.push('temperature 必须在 0 到 2 之间');
  }

  const providers = [];
  const seenNames = new Map();

  (Array.isArray(raw.providers) ? raw.providers : []).forEach((p, i) => {
    const r = cleanProvider(p, i);

    errors.push(...r.errors);

    // 列表里靠名字认人，重名会让「删的是哪条」变得没法回答
    if (r.provider.name) {
      const key = r.provider.name.toLowerCase();
      if (seenNames.has(key)) {
        errors.push(
          `连接名「${r.provider.name}」重复了（另一条在第 ${
            seenNames.get(key) + 1
          } 位）`
        );
      } else {
        seenNames.set(key, i);
      }
    }
    providers.push(r.provider);
  });

  const activeProviderId = pickActive(providers, raw.activeProviderId);

  return {
    ok: errors.length === 0,
    errors,
    config: {
      version: CONFIG_VERSION,
      providers,
      activeProviderId,
      activeModelId: pickModelId(
        providers,
        activeProviderId,
        raw.activeModelId
      ),
      temperature,
    },
  };
}

/**
 * 当前连接的自愈：指向的不在了就退回第一条，绝不因此让整份配置加载不出来。
 *
 * 这不是「静默降级」——它兜的是 UI 产生不出来的状态（手改存储、旧版本残留），
 * 而报错只会让用户看着一份自己没碰过的配置发愣。
 *
 * @param {Object[]} providers
 * @param {string} wanted
 * @returns {string}
 */
function pickActive(providers, wanted) {
  const key = String(wanted || '');

  if (providers.length === 0) return '';
  if (providers.some((p) => p.id === key)) return key;

  return providers[0].id;
}

/**
 * 当前模型的自愈，**只看当前连接底下那几条**。
 *
 * 范围必须收在当前连接内：另一条连接里的同名模型对当前连接毫无意义，留着会让
 * 「当前用的哪个」这件事出现两个真相（Q10：全局只有一个真相）。
 *
 * @param {Object[]} providers
 * @param {string} providerId
 * @param {string} wanted
 * @returns {string}
 */
function pickModelId(providers, providerId, wanted) {
  const provider = providers.find((p) => p.id === providerId);
  const models = (provider && provider.models) || [];
  const key = String(wanted || '');

  if (models.length === 0) return '';
  if (models.some((m) => m.id === key)) return key;

  return models[0].id;
}

/**
 * v1（单条）-> v2（多条）的迁移。
 *
 * 只搬，不猜：连接名直接用旧的 provider id（预设的 label 表不进这里 —— 为一次迁移
 * 留一张只服务迁移的映射，几个月后没人说得清它为什么还在）。模型窗口按旧值原样搬；
 * 旧值不存在才回落默认。**旧结构不存在时返回空文档**（一个字段都没有就别硬造一条）。
 *
 * @param {Object} raw
 * @returns {Object} v2 文档（存储态：apiKey 仍是密文）
 */
export function migrateLegacy(raw) {
  const src = raw || {};
  const templateId = String(src.provider || 'custom');
  const template = byTemplateId(templateId);
  const baseUrl = String(
    src.baseUrl || (template && template.baseUrl) || ''
  ).trim();
  const model = String(
    src.model || (template && template.models[0]) || ''
  ).trim();
  const key = String(src.apiKey || '');

  // 一个可用字段都没有 —— 那不是一条配置，别凭空造一条出来
  if (!baseUrl && !model && !key) {
    return {
      version: CONFIG_VERSION,
      providers: [],
      activeProviderId: '',
      activeModelId: '',
      temperature:
        typeof src.temperature === 'number'
          ? src.temperature
          : DEFAULT_CONFIG.temperature,
    };
  }

  const id = 'p_legacy';
  const contextWindow =
    src.contextWindow === undefined ||
    src.contextWindow === null ||
    src.contextWindow === ''
      ? resolveContextWindow(templateId, model)
      : Number(src.contextWindow);

  return {
    version: CONFIG_VERSION,
    providers: [
      {
        id,
        name: templateId,
        templateId,
        baseUrl,
        apiKey: key,
        models: model
          ? [
              {
                id: model,
                contextWindow,
                maxTokens: Number(src.maxTokens) || 0,
              },
            ]
          : [],
      },
    ],
    activeProviderId: id,
    activeModelId: model,
    temperature:
      typeof src.temperature === 'number'
        ? src.temperature
        : DEFAULT_CONFIG.temperature,
  };
}

/**
 * 存储里的原始值 -> 规范的 v2 文档。**纯函数**，不碰 IO、不加解密。
 *
 * 迁移只在这里发生一次视图层；落盘留给下一次保存，避免读路径带副作用。
 *
 * @param {Object} raw
 * @returns {Object} v2 文档（存储态）
 */
export function normalizeDoc(raw) {
  const src = raw || {};
  const base = Array.isArray(src.providers) ? src : migrateLegacy(src);
  const providers = (base.providers || []).map((p) => ({
    id: String(p.id || ''),
    name: String(p.name || ''),
    templateId: String(p.templateId || 'custom'),
    baseUrl: String(p.baseUrl || ''),
    apiKey: String(p.apiKey || ''),
    // 缺省在这里补齐而不是等到用：contextWindow 若是 undefined 进了
    // compactionThresholds，阈值会算成 NaN，压缩就静默不触发了
    models: (Array.isArray(p.models) ? p.models : []).map((m) => ({
      id: String(m.id || ''),
      contextWindow:
        m.contextWindow === undefined ||
        m.contextWindow === null ||
        m.contextWindow === ''
          ? DEFAULT_CONFIG.contextWindow
          : Number(m.contextWindow),
      maxTokens: Number(m.maxTokens) || 0,
    })),
  }));

  return {
    version: CONFIG_VERSION,
    providers,
    activeProviderId: String(base.activeProviderId || ''),
    activeModelId: String(base.activeModelId || ''),
    temperature:
      typeof base.temperature === 'number'
        ? base.temperature
        : DEFAULT_CONFIG.temperature,
  };
}

/**
 * 把 v2 文档摊平成运行时要的扁平结构（与 v1 一模一样的形状）。
 *
 * 没有可用连接时返回 `DEFAULT_CONFIG`（`apiKey: ''`）—— 这正是
 * `index.js` send 开头与 `AgentPanel.vue` 判定「没配好」所依赖的信号。
 *
 * @param {Object} doc v2 文档（已过 validateConfig）
 * @param {string=} apiKey 当前连接的密钥明文
 * @returns {Object} 扁平配置
 */
export function resolveActiveConfig(doc, apiKey) {
  const src = doc || {};
  const providers = Array.isArray(src.providers) ? src.providers : [];

  if (providers.length === 0) return { ...DEFAULT_CONFIG };

  let provider =
    providers.find((p) => p.id === src.activeProviderId) || providers[0];
  const model =
    (provider.models || []).find((m) => m.id === src.activeModelId) ||
    (provider.models || [])[0];

  if (!provider.baseUrl || !model) return { ...DEFAULT_CONFIG };

  // T-66：协议也要在这一层把关。存储里的值可能来自旧版本、手改、或者别的
  // 设备同步过来的 —— `loadConfig` 不跑 validateConfig，保存时那道协议检查
  // 管不到这里，坏端点会原样交给 pi。
  //
  // 刻意**只清 baseUrl**，不整份退回 DEFAULT_CONFIG：清空后 send 处的 isHttpUrl
  // 检查会给出带具体值的错误（「必须以 http:// 或 https:// 开头（当前：ftp://…）」）。
  // 整份退回会把 apiKey 一起清掉，用户看到的就是「请先配置 API Key」——
  // 而他明明填过密钥，那样比 provider 的 400 还指不到真因。
  if (!isHttpUrl(provider.baseUrl)) {
    // 原值留在 baseUrlInvalid 上：报错时要能说出「你填的是 ftp://…」，
    // 只说「地址非法」等于让用户回去自己猜。
    provider = {
      ...provider,
      baseUrl: '',
      baseUrlInvalid: String(provider.baseUrl),
    };
  }

  return {
    provider: provider.id,
    baseUrl: provider.baseUrl,
    // 仅当上面清洗过才有值：报错时要说出用户原本填的那个串
    ...(provider.baseUrlInvalid
      ? { baseUrlInvalid: provider.baseUrlInvalid }
      : {}),
    model: model.id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    temperature:
      typeof src.temperature === 'number'
        ? src.temperature
        : DEFAULT_CONFIG.temperature,
    apiKey: String(apiKey || ''),
  };
}

/**
 * 日志/上报用：把密钥抹掉。
 *
 * @param {Object} config
 * @returns {Object}
 */
export function redactConfig(config) {
  if (!config) return config;
  const key = config.apiKey || '';
  return {
    ...config,
    apiKey: key ? '***(' + key.slice(-4) + ')' : '',
  };
}

/**
 * 读取配置并解析成运行时形状。apiKey 在内存里始终是明文，出了这个函数就是密文。
 *
 * 只解密**当前那一条**的密钥：解密 N 条既没意义（设置页要的是 hasKey，不是明文），
 * 也让「打开一次面板」不至于把整串密钥都摊在内存里。
 *
 * @param {{get: Function, decrypt: Function}} io
 * @returns {Promise<Object>}
 */
export async function loadConfig(io) {
  const doc = normalizeDoc(await io.get(STORAGE_KEY));

  const provider = doc.providers.find((p) => p.id === doc.activeProviderId);
  // 解密实现当前是同步的，但 await 一个非 Promise 没有代价。不写 await 的话，
  // 哪天有人换成异步实现，apiKey 会变成一个 Promise，然后被当成 Bearer token
  // 发出去 —— 而且不报错，只是鉴权失败。
  const plainKey =
    provider && provider.apiKey ? await io.decrypt(provider.apiKey) : '';

  return resolveActiveConfig(doc, plainKey);
}

/**
 * 设置页要用的整份文档。
 *
 * 每条连接的 `apiKey` 被**清空**，密文挪到 `encryptedKey`（UI 不可渲染它），
 * 另给一个 `hasKey` 供占位文案用。这样设置页永远拿不到它没被用户敲进来的明文，
 * 「没动密钥就别写回空串」也就成了形状上的必然。
 *
 * @param {{get: Function}} io
 * @returns {Promise<Object>}
 */
export async function loadConfigDoc(io) {
  const doc = normalizeDoc(await io.get(STORAGE_KEY));

  return {
    ...doc,
    providers: doc.providers.map((p) => ({
      ...p,
      apiKey: '',
      encryptedKey: p.apiKey,
      hasKey: Boolean(p.apiKey),
    })),
  };
}

/**
 * 按需解开某条连接的密钥。
 *
 * 只在「抓可用模型」那一刻调用 —— 那是一次真实的网络请求，本来就该用这条连接
 * 自己的钥匙。密钥不写回表单，也不进 DOM。
 *
 * @param {{get: Function, decrypt: Function}} io
 * @param {string} providerId
 * @returns {Promise<string>} 明文；没有这条连接或没存过密钥则返回空串
 */
export async function revealApiKey(io, providerId) {
  const doc = normalizeDoc(await io.get(STORAGE_KEY));
  const provider = doc.providers.find((p) => p.id === providerId);

  if (!provider || !provider.apiKey) return '';
  return io.decrypt(provider.apiKey);
}

/**
 * 校验并保存（密钥加密后落盘）。校验不过就不写盘。
 *
 * @param {{set: Function, encrypt: Function}} io
 * @param {Object} input v2 文档（表单态）
 * @returns {Promise<{ok: boolean, errors: string[]}>}
 */
export async function saveConfig(io, input) {
  const { ok, errors, config: clean } = validateConfig(input);
  if (!ok) return { ok: false, errors };

  await io.set(STORAGE_KEY, {
    version: CONFIG_VERSION,
    providers: clean.providers.map((p) => ({
      id: p.id,
      name: p.name,
      templateId: p.templateId,
      baseUrl: p.baseUrl,
      // 用户没动这个 Key 时原样写回存储里那段密文；动了才重新加密
      apiKey: p.apiKey ? io.encrypt(p.apiKey) : p.encryptedKey,
      models: p.models,
    })),
    activeProviderId: clean.activeProviderId,
    activeModelId: clean.activeModelId,
    temperature: clean.temperature,
  });

  return { ok: true, errors: [] };
}
