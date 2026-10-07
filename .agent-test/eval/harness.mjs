/**
 * eval 集合的共用脚手架。
 *
 * 收掉旧脚本各抄一份的东西：事件提取、`ok/bad` 计数、agent / 装配层的构造。
 * 判据分两级（见 `makeCheck`）：
 *
 * - `hard` —— 硬断言，不符即失败（工具没被调用、401 文案不对、跨页没切过去）。
 * - `soft` —— 措辞类断言，不符只记 WARN 不影响退出码。模型换个说法不该算回归，
 *   这正是手测改自动回归最容易翻车的地方。
 * - `skip` —— 本轮没验证（如撞上限流），不是失败。
 *
 * 静态 import 只碰 loop 层那几个模块 —— 它们的依赖链不读构建期全局（`IS_OFFLINE`
 * 等），所以能在 `installGlobals()` 之前安全求值。装配层的 `index.js` / `shared.js`
 * 必须在 `prepare()` 之后动态导入，见那里的注释。
 */

import { createAgent, classifyPiErrorMessage } from '../../src/agent/loop.js';
import { createPiProvider, toPiContext } from '../../src/agent/provider.js';
import { wrapUntrusted } from '../../src/agent/untrusted.js';
import { buildUserMessage } from '../../src/agent/prompt.js';
import { AGENT_EVENTS, ERROR_KIND, TOOL_STATUS } from '../../src/agent/events.js';

export { AGENT_EVENTS, ERROR_KIND, TOOL_STATUS };
// 转出去让任务只从本文件 import，避免每任务各写一遍 `../../../src/...` 深路径。
// `streamChat` 已随 ADR 0004 消失（`src/agent/llm/` 整个目录被删）—— provider 由
// `createPiProvider(config)` 现造，返回 `{model, streamFn}`。
export {
  createAgent,
  createPiProvider,
  toPiContext,
  wrapUntrusted,
  buildUserMessage,
  classifyPiErrorMessage,
};

export const textOf = (events) =>
  events
    .filter((e) => e.kind === AGENT_EVENTS.TEXT_DELTA)
    .map((e) => e.text)
    .join('');

export const toolResultsOf = (events) =>
  events.filter((e) => e.kind === AGENT_EVENTS.TOOL_RESULT);

export const toolCallNames = (events) => toolResultsOf(events).map((r) => r.name);

/** 判据收集器：任务只往里塞结论，pass/fail/warn 的归并由 runner 算。 */
export function makeCheck() {
  const results = [];

  return {
    results,
    hard(cond, msg) {
      results.push({ level: 'hard', ok: Boolean(cond), msg });
    },
    soft(cond, msg) {
      results.push({ level: 'soft', ok: Boolean(cond), msg });
    },
    skip(msg) {
      results.push({ level: 'skip', msg });
    },
  };
}

/**
 * 撞上额度限制/限流就记 SKIP 并返回 true —— 免费额度下 429 是常态，它不是回归。
 *
 * 传 agent 的收尾事件（`{httpStatus, message}`）或 pi 的 AssistantMessage
 * （`{errorMessage}`）都行。**只有明确判成 429/quota 才 skip**：别的错误照旧让
 * 任务按 hard 失败处理，不能把「真的坏了」也吞成 skip（AGENTS.md 不静默降级）。
 */
export function skipIfRateLimited(check, info) {
  const src = info || {};
  const message = String(src.message || src.errorMessage || '');
  const status =
    src.httpStatus !== undefined
      ? src.httpStatus
      : classifyPiErrorMessage(message).httpStatus;

  if (status === 429 || /429|insufficient_quota|rate limit|限流|额度/i.test(message)) {
    check.skip(`撞上额度/限流（429），本轮未验证：${message.slice(0, 80)}`);

    return true;
  }

  return false;
}

/**
 * 注（ADR 0004）：原来这里有个 `toolCallShards(rawChunks)`，用于观察 provider
 * 原始 tool-call 分片。pi 迁移后分片解析归 pi 内部，我们侧不再持有
 * `tool-call-delta` 观察对象 —— 该诊断及其 `tee` 通路一并删除。
 */

/** 把 `promptFacts` 里那一段工具索引按 tools 数组生成（旧脚本手抄的那份）。 */
export function defaultFacts(tools) {
  return {
    automaFuncs: [],
    templatingFns: [],
    blockCount: 0,
    tools: tools.map((t) => ({
      name: t.name,
      class: t.class,
      group: t.group,
      description: t.description,
    })),
  };
}

/**
 * 建一个 loop 层「生产同款」的 agent。
 *
 * **async**：provider 由 `createPiProvider(runConfig)` 现造（ADR 0004）——
 * 它要动态 import pi 包，故必须 await。
 *
 * `configOver` 用于单条任务换 key/model（如 401 任务用假 key），其余照走 `config`。
 */
export async function makeAgent({
  config,
  tools = [],
  toolCtx = {},
  facts,
  requestConfirmation,
  drainInstructions,
  configOver,
} = {}) {
  const runConfig = configOver ? { ...config, ...configOver } : config;
  const { model, streamFn } = await createPiProvider(runConfig);

  const agent = createAgent({
    model,
    streamFn,
    promptFacts: () => facts || defaultFacts(tools),
    tools,
    toolCtx,
    wrapUntrusted,
    buildUserMessage,
    // T-76：上下文窗口驱动压缩阈值，任务里传同一份 config 的字段
    contextWindow: runConfig.contextWindow,
    ...(requestConfirmation ? { requestConfirmation } : {}),
    ...(drainInstructions ? { drainInstructions } : {}),
  });

  return { agent, model, streamFn };
}

// ------------------------------------------------------------------ 装配层

let prepared = false;
let assembly = null;

/**
 * 必须先跑：补上 webpack DefinePlugin 在 node 里不存在的全局，再加载 `shared.js`。
 *
 * 用动态 import 是刻意的 —— 静态 import 会被提升到 `installGlobals()` 之前求值，
 * 于是 `shared.js` 一读 `IS_OFFLINE` 就 ReferenceError。这是本仓既有的写法
 * （见 `src/agent/facts.test.js`）。
 */
export async function prepare() {
  if (prepared) return;

  const { installGlobals } = await import('../../src/agent/__stubs__/globals.js');

  installGlobals();
  await import('../../src/utils/shared.js');
  prepared = true;
}

/**
 * 装配层一次性搭好：写配置、接好假浏览器、给出 `makeRuntime`。
 *
 * `doc` 是 v2 配置文档（`env.mjs` 的 `configDoc()`）—— `saveConfig` 从 T-97 起
 * 收 `{providers[], activeProviderId, ...}`，不收旧的扁平配置。写盘后
 * `loadConfig` 再把它 resolve 回扁平配置喂给 runtime。
 * `pageText` 是假 content script 的应答（生产的 `read_page` 要求是 string）；
 * `tabs` 是假标签页列表，`tabs[0]` 当默认 targetTab。
 */
export async function setupAssembly({ doc, tabs, pageText }) {
  await prepare();

  if (!assembly) {
    assembly = {
      polyfill: await import('../../src/agent/__stubs__/webextension-polyfill.js'),
      index: await import('../../src/agent/index.js'),
    };
  }

  const { polyfill, index } = assembly;
  const { state, default: browser } = polyfill;

  state.tabs = tabs;
  browser.tabs.sendMessage = async () => pageText;
  // 桩原本没有 tabs.get —— 生产的 preStepNotice / openSession 都要它。
  // 缺了它，预检会把「目标页已关闭」当成系统提示每一步喂给模型。
  browser.tabs.get = async (id) => {
    const hit = state.tabs.find((t) => t.id === id);

    if (!hit) throw new Error('no tab ' + id);

    return hit;
  };

  const saved = await index.saveConfig(index.configIO, doc);

  return {
    saved,
    index,
    state,
    browser,
    configIO: index.configIO,
    sessionStore: index.sessionStore,
    loadConfig: index.loadConfig,
    makeRuntime: (over = {}) =>
      index.createAgentRuntime({
        getConfig: () => index.loadConfig(index.configIO),
        // 宿主必须注入 getVariables（缺了 createAgentRuntime 直接抛）。eval 没有
        // 工作流可读，按契约给 `{bound:false}`——「没有变量」是真实答案，不是假答案。
        getVariables: async () => ({ bound: false }),
        targetTab: tabs[0],
        enabledGroups: ['page', 'context', 'tab'],
        sessionStore: index.sessionStore,
        getWorkflowId: () => null,
        requestConfirmation: async () => ({ approved: true }),
        ...over,
      }),
  };
}