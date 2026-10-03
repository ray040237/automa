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

/** 支持的 provider。都是 OpenAI 兼容端点，走同一个 provider 实现。 */
export const PROVIDERS = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
  },
  {
    id: 'modelscope',
    label: 'ModelScope 魔搭',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    // 免费额度限流很紧，429 是常态 —— 所以默认给个小模型先跑通
    models: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat'],
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-32k'],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-plus'],
  },
  {
    id: 'aliyun',
    label: '阿里百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo'],
  },
  {
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
  // BYOK 模型窗口五花八门，按 window.js 的保守默认；多会话历史变长后，
  // 这个值直接决定旧轮次多快被裁掉，用户要能按自己的模型调大
  contextWindow: 32000,
  apiKey: '',
};

const byId = (id) => PROVIDERS.find((p) => p.id === id);

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

  return {
    ok: errors.length === 0,
    errors,
    config: {
      provider,
      baseUrl,
      model,
      temperature,
      contextWindow,
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
