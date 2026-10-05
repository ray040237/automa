/**
 * Agent 配置。
 *
 * 纯逻辑与 IO 分离：加解密与 storage 都从外部注入，因此本文件可被 node --test 覆盖，
 * 也不会在 import 期碰到 browser / crypto-js。
 *
 * 密钥用项目既有的 credentialUtil（AES + HMAC，passKey 来自 getPassKey）加密，
 * 不另造加密方案 —— 两套加密并存只会让「到底哪套是当前有效的」变得无法回答。
 */

export const STORAGE_KEY = 'automaAgentConfig';

/**
 * 支持的 provider。都是 OpenAI 兼容端点，走同一个 provider 实现。
 *
 * `contextWindow` 是**建议值**（T-94）：BYOK 场景下 OpenAI 兼容协议不暴露模型
 * 窗口，只能按官方公开标称值预填，用户随时可改；同一 provider 下个别模型不同
 * 时用 `modelWindows` 覆盖。填小了提前压缩（多花一次摘要请求），填大了压缩不
 * 触发、只剩溢出恢复兜底 —— 两个方向都不致命，所以敢预填。
 */
export const PROVIDERS = [
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

export const DEFAULT_CONFIG = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  temperature: 0.2,
  // 驱动 T-76 压缩阈值（compaction.js 的 compactionThresholds）：阈值 =
  // contextWindow - reserve。设置页按 provider/model 预填建议值（见下面
  // resolveContextWindow），用户可改；< 4096 视为压缩不可用。
  contextWindow: 32000,
  // 单次回复的输出上限（T-96）。0 = 不传，交给端点默认 —— 写死一个数字会让
  // 长回答被静默截断在半句（provider.js 里记着「曾为 4096」的教训）。
  maxTokens: 0,
  apiKey: '',
};

const byId = (id) => PROVIDERS.find((p) => p.id === id);

/**
 * 按 provider/model 取上下文窗口的**建议值**（T-94）。
 *
 * 只是预填用的建议，不是真相：同一模型不同版本/账号档位窗口可能不同，用户
 * 随时能在设置页改。查不到（openrouter / 自定义端点 / 手填模型名）就回落
 * DEFAULT_CONFIG.contextWindow —— 宁可按保守值提前压缩，也不要假装有数。
 *
 * @param {string} providerId
 * @param {string=} model
 * @returns {number}
 */
export function resolveContextWindow(providerId, model) {
  const preset = byId(providerId);
  if (!preset) return DEFAULT_CONFIG.contextWindow;
  const perModel =
    preset.modelWindows && model ? preset.modelWindows[model] : undefined;
  return perModel || preset.contextWindow || DEFAULT_CONFIG.contextWindow;
}

/**
 * 校验并补全配置。
 *
 * @param {Object} input
 * @returns {{ok: boolean, config: Object, errors: string[]}}
 */
export function validateConfig(input) {
  const raw = input || {};
  const errors = [];

  const provider = raw.provider || DEFAULT_CONFIG.provider;
  if (!byId(provider)) errors.push('未知的 provider: ' + provider);

  const preset = byId(provider);
  const baseUrl = (raw.baseUrl || (preset && preset.baseUrl) || '').trim();
  if (!baseUrl) {
    errors.push('缺少 baseUrl');
  } else if (!/^https?:\/\//.test(baseUrl)) {
    errors.push('baseUrl 必须以 http:// 或 https:// 开头');
  }

  const model = (raw.model || (preset && preset.models[0]) || '').trim();
  if (!model) errors.push('缺少 model');

  const apiKey = (raw.apiKey || '').trim();
  if (!apiKey) errors.push('缺少 apiKey');

  const temperature =
    typeof raw.temperature === 'number'
      ? raw.temperature
      : DEFAULT_CONFIG.temperature;
  if (typeof temperature !== 'number' || temperature < 0 || temperature > 2) {
    errors.push('temperature 必须在 0 到 2 之间');
  }

  let { contextWindow } = raw;
  if (
    contextWindow === undefined ||
    contextWindow === null ||
    contextWindow === ''
  ) {
    contextWindow = DEFAULT_CONFIG.contextWindow;
  } else {
    contextWindow = Number(contextWindow);
    if (!Number.isFinite(contextWindow) || contextWindow < 1024) {
      errors.push('contextWindow 必须是不小于 1024 的数字');
    }
  }

  // maxTokens：留空 / 0 = 不限制（把上限交给端点默认）。一旦填了就要是个
  // 像样的数 —— 太小的上限等于把「回答说到一半没了」变成常态（配套 T-96②：
  // 真截断时 loop 会发 SYSTEM_NOTICE，用户看得见，不是静默）。
  let { maxTokens } = raw;
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
      errors.push('maxTokens 必须是不小于 256 的数字，留空表示不限制');
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    config: {
      provider,
      baseUrl,
      model,
      temperature,
      contextWindow,
      maxTokens,
      apiKey,
    },
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
 * 读取配置。apiKey 在内存里始终是明文，出了这个函数就是密文。
 *
 * @param {{get: Function, decrypt: Function}} io
 * @returns {Promise<Object>}
 */
export async function loadConfig(io) {
  const raw = (await io.get(STORAGE_KEY)) || {};

  // 解密实现当前是同步的，但 await 一个非 Promise 没有代价。
  // 不写 await 的话，哪天有人换成异步实现，apiKey 会变成一个 Promise，
  // 然后被当成 Bearer token 发出去 —— 而且不报错，只是鉴权失败。
  const plainKey = raw.apiKey ? await io.decrypt(raw.apiKey) : '';

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    apiKey: plainKey,
  };
}

/**
 * 忘掉已保存的密钥。
 *
 * 单独开一个函数而不是复用 saveConfig：validateConfig 要求 apiKey 非空，
 * 而「删除密钥」恰恰要传空值 —— 走保存那条路根本删不掉。
 * 用户想撤回授权时必须真的能删干净。
 *
 * @param {{remove: Function}} io
 * @returns {Promise<void>}
 */
export async function clearApiKey(io) {
  await io.remove(STORAGE_KEY);
}

/**
 * 校验并保存（密钥加密后落盘）。校验不过就不写盘。
 *
 * @param {Object} io
 * @param {Object} config
 * @returns {Promise<{ok: boolean, errors: string[]}>}
 */
export async function saveConfig(io, config) {
  const { ok, errors, config: clean } = validateConfig(config);
  if (!ok) return { ok: false, errors };

  await io.set(STORAGE_KEY, {
    ...clean,
    apiKey: io.encrypt(clean.apiKey),
  });

  return { ok: true, errors: [] };
}
