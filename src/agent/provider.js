/**
 * pi provider 接线：我们的 BYOK 配置 -> pi 的 Model + streamFn。
 *
 * 这一模块是票 08 的产物，替掉了原来的 `llm/providers/openai-compat.js`（430 行）
 * 与 `wire.js`（事件历史 -> OpenAI wire messages）。现在 provider 参数由 pi 从
 * transcript 自己生成，我们这一层只剩一件事：**把 config.js 的配置形状翻成
 * pi 的形状**，翻完就交出控制权。
 *
 * 三件事必须在这里显式写出来，不能靠默认值兜：
 *
 * 1. **apiKey 走 provider 的 auth.resolve，不靠环境变量。** 扩展没有 .env，
 *    也没有用户 shell。凭据 resolve 失败会让 Models 拿不到 key，
 *    而失败是**静默**的（请求带空 Bearer，401 从 provider 侧才可见）。
 * 2. **contextWindow 来自用户配置，不是模型目录。** BYOK 场景枚举不到模型元数据，
 *    用户在设置页手填。它作为模型元数据喂给 pi；本版不做上下文裁剪
 *    （B9 第 1 项），我们侧没有任何代码读它做预算。
 * 3. **temperature 由我们注入。** 实测 pi 的 Agent **不转发 temperature** ——
 *    `createLoopConfig()` 里没有这个字段，`streamFn` 收到的 options 也不带。
 *    不在这里注入，用户在设置页调的温度就是静默失效的。
 *
 * 不变式：本文件只 import src/agent 下的纯模块与 pi 包，
 * 不碰 webextension-polyfill、不碰 @/ 别名。
 */

/** pi 的 api id。我们只支持 OpenAI 兼容端点（config.js 的 PROVIDERS 全是）。 */
export const API_ID = 'openai-completions';

/**
 * 真的去 import pi。单独抽出来是为了让 `deps.loadPi` 能整体替换掉它——
 * 测试要覆盖「配置翻成pi 形状」这件事，但不该为此把 openai SDK 拖进node --test。
 */
async function loadPi() {
  /* eslint-disable import/no-unresolved, import/extensions --
   * 这两条 lint 报的不是真问题：eslint-import-resolver-webpack 用的是
   * enhanced-resolve 0.9（2016 年），它**不认识 package.json 的 exports 字段**，
   * 而 pi-ai 只在 exports 里声明了子路径。webpack 5 自带的 enhanced-resolve 5
   * 实测能解析这两个路径（见 provider.js 完成记录），所以是 lint 工具链旧，
   * 不是引用写错。
   *
   * 不改成裸 `@earendil-works/pi-ai` 的原因：那个入口会把 typebox、
   * faux provider 等全家桶一起拖进 bundle。PoC 步骤 6 实测过这个差别，
   * 换不回来。
   */
  const modelsMod = await import('@earendil-works/pi-ai/models');
  const apiMod = await import(
    /* eslint-disable-next-line import/no-unresolved */
    '@earendil-works/pi-ai/api/openai-completions.lazy'
  );
  return {
    createModels: modelsMod.createModels,
    createProvider: modelsMod.createProvider,
    openAICompletionsApi: apiMod.openAICompletionsApi,
  };
}

/**
 * 构一个 pi 的 Model 对象。
 *
 * 纯函数（不 import pi），所以能直接被 node --test 覆盖 ——
 * 「模型对象字段填错」这类问题最容易在真发请求时才暴露，而那时只能看到 400。
 *
 * @param {Object} config config.js 的配置（已过validateConfig）
 * @returns {Object} pi 的 Model
 */
export function buildModel(config) {
  return {
    id: config.model,
    name: config.model,
    api: API_ID,
    // provider id 用配置里的那一份：日志与错误信息按它归类，
    // 用固定字符串会让所有会话看起来来自同一个 provider。
    provider: config.provider || 'custom',
    baseUrl: config.baseUrl,
    input: ['text'],
    // BYOK 场景我们不知道价格，全 0 —— pi 只在 cost 为 0 时不算钱，
    // 编一个假单价会让 usage 面板显示错的花费。
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: config.contextWindow,
    // T-96：0 = 不设，把输出上限交给端点默认 —— 写死一个数字（曾为 4096）
    // 会让长回答被静默截断在半句（stopReason=length）。用户显式填了才传，
    // 且配套 T-96②：真截断时 fromPiEvent 会发 SYSTEM_NOTICE，不再无声无息。
    // 摘要请求不走这里 —— 它用自己的 maxTokens（compaction.js 的
    // summaryMaxTokens），不会因为用户填了个小值就让压缩整体跳过。
    maxTokens: Number(config.maxTokens) || 0,
  };
}

/**
 * 组装 pi 的 Models 集合，返回可直接交给 Agent 的 streamFn 与 model。
 *
 * **动态 import 是刻意的**：pi-ai 的 index 会把 typebox、faux provider 等
 * 全家桶拖进来；`/models` 子路径只含 createModels/createProvider 与鉴权解析。
 * 体积差在打包时是几百 KB（PoC 步骤 6 实测），不能图省事。
 *
 * @param {Object} config config.js 的配置
 * @param {Object=} deps 注入点（测试用）
 * @param {() => Promise<Object>=} deps.loadPi 返回 {createModels, createProvider,
 *   openAICompletionsApi}。不传则真去import pi。
 * @returns {Promise<{model: Object, streamFn: Function, models: Object}>}
 */
export async function createPiProvider(config, deps = {}) {
  const pi = await (deps.loadPi || loadPi)();

  const model = buildModel(config);
  const providerId = model.provider;

  const provider = pi.createProvider({
    id: providerId,
    name: providerId,
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: 'API key',
        // 每次解析都重新闭包捕获当前 config：设置页改了key 之后
        // 已在跑的 runtime 不该继续用旧值，但下一次 send 会重建本函数。
        resolve: async () => ({
          auth: { apiKey: config.apiKey },
          source: 'agent-config',
        }),
      },
    },
    models: [model],
    api: pi.openAICompletionsApi(),
  });

  const models = pi.createModels();
  models.setProvider(provider);

  const streamFn = (piModel, context, options = {}) =>
    models.streamSimple(piModel, context, {
      // temperature 由这里注入 —— 见文件头第 3 条。
      ...(config.temperature !== undefined && {
        temperature: config.temperature,
      }),
      ...options,
    });

  return { model, streamFn, models };
}

/**
 * 我们旧的消息形状（`[{role, content}]`）-> pi 的 Context。
 *
 * 只在标题生成那条路上用：那里本来就是一个独立小请求，没有工具、没有
 * transcript，用不着整套 Agent。**不要**把它当成通用的消息转换 ——
 * 正经的对话消息由 pi 从 transcript 自己生成（票 08 删掉了 wire.js）。
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {{systemPrompt: string, messages: Array<Object>}}
 */
export function toPiContext(messages) {
  const system = (messages || []).find((m) => m.role === 'system');
  const rest = (messages || [])
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role,
      content: m.content,
      // pi 的 UserMessage 要求 timestamp，缺了会在 provider 层炸。
      timestamp: Date.now(),
    }));

  return { systemPrompt: system ? system.content : '', messages: rest };
}
