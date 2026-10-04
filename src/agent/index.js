/**
 * 装配层。
 *
 * 这是整个 agent 里唯一允许碰浏览器 API 与项目别名（@/）的文件。
 * 下面所有模块（loop / tools / wire / prompt …）都保持纯函数，
 * 因此可以被 node --test 直接覆盖，也因此不会在 import 期就要求一个浏览器环境。
 *
 * 另外注意：这里用的是原生 fetch，不是 @/utils/api 的 fetchApi ——
 * fetchApi 在 IS_OFFLINE 下会直接抛错（离线版把云端能力整个剥掉），
 * 用它会让离线构建出来的扩展里 agent 直接不可用。
 */

import browser from 'webextension-polyfill';

import { automaFuncsSnippets } from '@/utils/codeEditorAutocomplete';
import templatingFunctions from '@/workflowEngine/templating/templatingFunctions';
import { tasks } from '@/utils/shared';
import credentialUtil from '@/utils/credentialUtil';
import { sendMessage as backgroundSend } from '@/utils/message';

import { buildFacts } from './facts';
import { createAgent } from './loop';
import { AGENT_EVENTS } from './events';
import { TOOLS } from './tools';
import { streamChat } from './llm/providers/openai-compat';
import { wrapUntrusted } from './untrusted';
import { buildUserMessage } from './prompt';
import {
  resolveTargetTab,
  listTargetableTabs,
  originOf,
  normalize,
} from './tab';
import { loadConfig, saveConfig } from './config';
import { createSessionId, createSessionStore } from './sessions';
import {
  accumulateUsage,
  buildTurnRecord,
  createCheckpointSaver,
  pruneEphemeralEvents,
} from './turnRecord';
import {
  fingerprintChangedNotice,
  fingerprintKey,
  initialPinsFromTab,
  originDriftKey,
  originDriftNotice,
  tabClosedNotice,
  upsertPin,
} from './targetState';
import { buildTitleMessages, cleanTitle } from './title';
import { raceTimeout } from './agentEvalInPage';
import { createAgentLog } from './log';

/** 全链路日志（控制台 + 环形缓冲）。排查卡死/异常时的现场，见 log.js 头注。 */
export const agentLog = createAgentLog();

// 环形缓冲暴露到页面：转中不落盘（T-34），页面卡死时刷新前还能从这里导出现场。
if (typeof window !== 'undefined') {
  window.__agentLogs = agentLog.ring;
  window.__agentLogDownload = () => {
    const data = JSON.stringify(window.__agentLogs, null, 1);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(
      new Blob([data], { type: 'application/json' })
    );
    a.download = 'agent-log.json';
    a.click();
  };
}

/**
 * 轻量跨会话锁（P2）：tabId -> 锁持有者 id。
 * 只在「会话正在跑一轮」的窗口内持有——空闲会话不挡人（pie 的 R7 收窄语义）。
 * 这是 UX 防误伤，不是安全边界：锁的双方都是同一个用户的 BYOK 扩展。
 */
const tabLocks = new Map();
let runtimeSeq = 0;

/**
 * 生成会话标题（fire-and-forget）：复用当轮的模型配置发一次小请求。
 * 任何失败都静默返回 —— 标题有消息前缀兜底，不值得为它报错。
 *
 * @param {Object} config getModel() 的结果
 * @param {string} userText 首条用户消息
 * @param {Array<Object>} events 首轮事件（取助手回答片段用）
 * @returns {Promise<string|null>} 生成的标题；失败为 null
 */
async function generateTitleAsync(config, userText, events) {
  const reply = events
    .filter((ev) => ev.kind === AGENT_EVENTS.TEXT_DELTA)
    .map((ev) => ev.text || '')
    .join('');

  let title = null;
  for await (const chunk of streamChat({
    messages: buildTitleMessages(userText, reply),
    config: {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      temperature: 0.3,
    },
  })) {
    if (chunk.type === 'text-delta') {
      title = (title || '') + chunk.text;
    }
  }

  const cleaned = cleanTitle(title);
  if (!cleaned) return null;

  return cleaned;
}

/**
 * 补全表里有、但 javascript-code 块运行时没注入的函数。
 *
 * automaExecWorkflow 只在「创建元素」块的 execute 里被塞进 sandbox；
 * javascript-code 块只有下面这 5 个。模型照补全列表写会得到一段必然报错的代码，
 * 所以领域知识表里要把它剔掉（prompt.js 里另有文字警告）。
 *
 * facts.guard.test.js 会读源码交叉验证这张名单，名单与上游脱节时测试直接红。
 */
export const PHANTOM_AUTOMA_FUNCS = ['automaExecWorkflow'];

/**
 * 组装喂给提示词的领域知识表。全部动态取自项目常量，不硬编码拷贝 ——
 * 块增删或改名时这里自动跟上。
 *
 * @param {Array<Object>} tools 必填（T-45）——旧的默认回落全量 TOOLS 会让
 *   「忘了传参」表现为系统提示里悄悄多出画布工具（违反 ADR-0001），现在缺参直接抛。
 * @returns {Object}
 */
export function collectPromptFacts(tools) {
  if (!Array.isArray(tools)) {
    throw new Error(
      'collectPromptFacts: tools 参数必填（传按 enabledGroups 过滤后的子集）'
    );
  }
  // 真正的计算在 facts.js：它没有浏览器依赖，所以能被测试直接跑到。
  // 这里只负责把浏览器侧的数据递进去 —— 别再内联一份，否则改一处会漏一处。
  return buildFacts({
    automaFuncs: automaFuncsSnippets,
    templatingFunctions,
    catalog: tasks,
    tools,
    excludeFuncs: PHANTOM_AUTOMA_FUNCS,
  });
}

/**
 * get_block_schema 工具的真实现：查块目录。
 *
 * 目录就是上面已经导入的 tasks（@/utils/shared），按块 id 或块名查；
 * '*' 返回全量 [{id, name}]。形状与 tools/page.js 的渲染约定对齐
 * （字段清单读 schema.data 的键）。此前这里是 `async () => null` 的默认桩
 * 且无任何宿主传入真实现 —— 工具永远回「可用块（一个都没有）」，与事实表
 * 「61 个块」自相矛盾，模型会陷进 read_page ↔ get_block_schema 的死循环
 * （backlog T-32）。
 *
 * @param {string} name 块 id、块名，或 '*' 表示全量
 * @returns {Promise<Object|Array|null>} 查不到返回 null
 */
export async function lookupBlockSchema(name) {
  if (!name || !tasks || typeof tasks !== 'object') return null;

  if (name === '*') {
    return Object.entries(tasks).map(([id, def]) => ({
      id,
      name: (def && def.name) || id,
    }));
  }

  const id = Object.keys(tasks).find(
    (k) => k === name || (tasks[k] && tasks[k].name) === name
  );

  if (!id) return null;

  const def = tasks[id];

  return {
    id,
    name: def.name,
    description: def.description,
    category: def.category,
    data: def.data || {},
  };
}

/**
 * runtime 通道（background）的发送侧硬超时。
 *
 * background 自己有 15s 的页内执行兜底（T-30），但那层在 background **内部**：
 * 若 SW 被回收 / 消息回程丢了，发送方的 promise 永不 settle，没有任何一层
 * 能救 —— 用户真机日志里 `channel.send` 之后既无 `channel.reply` 也无
 * `channel.fail`，整轮 agent 就挂死在那里（T-39；本机 t40-probe 三层全通，
 * 差异只剩真机的回程）。这里是最后一层，必须大于 background 的 15s，
 * 正常回程一定先到。
 */
export const BACKGROUND_CHANNEL_TIMEOUT_MS = 20000;

/**
 * 工具 → background 的唯一通道。
 *
 * 工具侧约定发 `{type, ...params}`，background 侧的 MessageListener 只认
 * `{name: 'background--<type>', data: params}` —— 两个协议在这是唯一交汇点。
 * 导出是为了让测试能拿真实 MessageListener 验路由（backlog T-28：协议对不上时
 * 报的是一句指不到真因的 Unhandled Background Error，只能靠契约测试钉住）。
 *
 * 整个 round trip 套了硬超时（T-39）：超时不 reject 而是回 `{ok:false, error}`
 * 的观察值形状，工具照常把它喂回模型 —— 通道慢/断不再等于「这轮卡死」。
 * 真正的 send 失败（如端口不存在）仍照旧 reject 走 channel.fail。
 *
 * @param {{type: string} & Object} msg
 * @param {{timeoutMs?: number}=} options timeoutMs 供测试缩短（默认 20s）
 * @returns {Promise<Object>}
 */
export function toBackground(msg, options = {}) {
  const { type, ...payload } = msg || {};
  const timeoutMs = options.timeoutMs || BACKGROUND_CHANNEL_TIMEOUT_MS;
  const startedAt = Date.now();

  agentLog('channel.send', { type });

  const roundTrip = raceTimeout(
    backgroundSend(type, payload, 'background'),
    timeoutMs,
    {
      ok: false,
      __timeout: true,
      // 模型需要知道「到底执没执行」——如实说不确定，并给下一步动作，
      // 否则它会原地重复同一调用（T-33 的教训）。
      error:
        `background 通道无响应（${Math.round(
          timeoutMs / 1000
        )}s 无应答）：这一步是否已执行无法确认` +
        '（background 可能被浏览器回收了）。请先用 read_page 看一眼当前' +
        '页面状态再决定要不要重试，不要直接重复同一调用。',
    }
  );

  return roundTrip.then(
    (res) => {
      const ms = Date.now() - startedAt;

      if (res && res.__timeout) {
        agentLog.error('channel.timeout', { type, ms, timeoutMs });

        const rest = { ...res };
        delete rest.__timeout; // 内部标记不进观察值
        return rest;
      }

      agentLog('channel.reply', {
        type,
        ok: Boolean(res && res.ok),
        error: res && res.error,
        ms,
      });
      return res;
    },
    (err) => {
      agentLog.error('channel.fail', {
        type,
        message: err && err.message ? err.message : String(err),
        ms: Date.now() - startedAt,
      });
      throw err;
    }
  );
}

/**
 * 读目标页 / 页内找文本。通过 content script 通道拿结构化观察值。
 *
 * 失败时回一句人话而不是抛异常：工具异常会被 loop 转成 error 观察值喂回模型，
 * 模型能据此换一种参数重试；把栈抛上去只会让它原地打转。
 *
 * @param {Object} tab
 * @param {{detail?: string, maxChars?: number, op?: string, keyword?: string, limit?: number}|string} params
 *   传字符串时按 detail 处理（兼容旧调用点）
 * @returns {Promise<string|{text: string, fingerprint: (string|null)}>}
 */
/**
 * tabs 消息通道的硬超时。
 *
 * 目标页主线程被注入代码占死时（test_js 的死循环/alert），同进程的
 * content script 无法应答，tabs.sendMessage 的 promise 永不 settle ——
 * executeScript 通道有 raceTimeout 兜底（background 侧 T-30），这条通道
 * 没有的话整轮 agent 就挂死在下一步的 probe / read_page 上（T-33，
 * 已在 t33-probe.mjs 实测复现：占死后 read_page 15s 仍无回应）。
 */
export const TAB_CHANNEL_TIMEOUT_MS = 15000;

export async function readPageFromTab(tab, params) {
  const options =
    typeof params === 'string' ? { detail: params } : params || {};

  if (!tab) return '没有确定目标页。请先让用户选一个标签页。';

  const timeoutMs = options.timeoutMs || TAB_CHANNEL_TIMEOUT_MS;

  try {
    const res = await raceTimeout(
      browser.tabs.sendMessage(tab.id, {
        type: 'agent:read-page',
        op: options.op || 'read',
        detail: options.detail,
        maxChars: options.maxChars,
        keyword: options.keyword,
        limit: options.limit,
      }),
      timeoutMs,
      {
        __timeout: true,
      }
    );

    // 页面无应答 ≠ 通道坏了：八成是之前注入的代码把页面占死了。
    // 必须给模型一句能行动的话（换页/让用户刷新），否则它会原地反复重试。
    if (res && res.__timeout) {
      agentLog.warn('page.timeout', { tabId: tab.id, timeoutMs });
      return (
        '页面无响应（' +
        Math.round(timeoutMs / 1000) +
        's 无应答）：页面可能被之前注入的代码占死了。请停止对本页的读页和执行操作，' +
        '让用户手动刷新或关闭该页，或用 focus_tab 换一个标签页。'
      );
    }

    // content 侧读页返回 {text, fingerprint}；指纹必须原样带回来 ——
    // 它是「页面变没变」的唯一判据，塞进文本会被陈旧快照剔除抹掉（设计稿 §6.2）
    if (res && typeof res === 'object' && typeof res.text === 'string') {
      agentLog('page.read', {
        tabId: tab.id,
        detail: options.detail || options.op || 'read',
        chars: res.text.length,
        fingerprint: res.fingerprint || null,
      });
      return { text: res.text, fingerprint: res.fingerprint || null };
    }

    if (typeof res === 'string' && res) {
      agentLog.warn('page.read.odd', { tabId: tab.id, res: res.slice(0, 80) });
      return res;
    }

    return (
      '这个页面读不到结构。常见原因：页面尚未加载完；这是一个扩展内置页' +
      '（chrome:// 与扩展自己的页面都没有注入 content script）；或站点未授予扩展权限。'
    );
  } catch (err) {
    agentLog.warn('page.read.fail', {
      tabId: tab.id,
      message: err && err.message ? err.message : String(err),
    });
    return (
      '读取目标页失败：' +
      (err && err.message ? err.message : String(err)) +
      '多半是该标签页没有注入 content script（扩展页、chrome:// 内置页、或还没加载完）。'
    );
  }
}

/**
 * 组装可用的 agent runtime。
 *
 * @param {Object} deps
 * @param {() => Promise<Object>} deps.getConfig
 * @param {(payload: Object) => Promise<Object>} deps.requestConfirmation
 * @param {() => Promise<Object>=} deps.getVariables
 * @param {(name: string) => Promise<Object|null>=} deps.getBlockSchema
 * @param {Object=} deps.targetTab
 * @param {Object=} deps.sessionStore sessions.js 的会话仓库；不传则无跨轮记忆
 * @param {() => string=} deps.getWorkflowId 会话归属的工作流 id
 * @returns {Object}
 */
export function createAgentRuntime(deps) {
  const {
    getConfig,
    requestConfirmation,
    getVariables = async () => ({}),
    getBlockSchema = lookupBlockSchema,
    sessionStore = null,
    getWorkflowId = () => null,
    enabledGroups = null,
  } = deps;

  let targetTab = deps.targetTab || null;

  // 会话 pin（P2 标签页定位）：{tabId, origin, title?} 列表。
  // pin 必须带 origin——Chrome 会复用已关闭 tab 的 id，裸信 tabId 会操作到
  // 复用后的陌生页面。pin 在会话内持续存在，首轮 send 自动捕获、
  // open_url/用户选择追加，删除会话即清空。
  let pins = [];
  let focusedTabId = null;
  // 同一条 notice 不逐条重复刷：只在内容变化时再次注入
  let lastNoticeKey = '';
  // 模型最后一次 read_page 看到的页面指纹（{tabId, fingerprint}）。
  // 只有它非空才说明「模型的结论依赖过某个页面状态」，才有比对的必要。
  let lastRead = null;
  // 指纹比对结果的去重键：页面变了提示一次，模型没重读不逐轮重复刷
  let fpNoticeKey = '';
  // 每轮 send 开头做一次轻量 probe（advisory，不进 prompt，每轮最多一次）
  let fpCheckPending = false;
  // 当前这轮的对外事件通道，focus_tab 等工具改目标页时用它同步 UI
  let currentOnEvent = null;
  const lockId = `rt_${(runtimeSeq += 1)}`;

  const toolCtx = {
    readPage: async (params) => {
      const res = await readPageFromTab(targetTab, params);
      // 记住模型最后一次真正看到的页面指纹（按 tabId 记，切页不串味）。
      // 下一轮 send 开头拿它和一次轻量 probe 比，变了才提示重读（设计稿 §6.4）。
      if (res && typeof res === 'object' && res.fingerprint && targetTab)
        lastRead = { tabId: targetTab.id, fingerprint: res.fingerprint };
      return res;
    },
    findText: (params) =>
      readPageFromTab(targetTab, { op: 'find-text', ...params }),
    getVariables,
    getBlockSchema,
    // 画布写工具要用的东西。宿主把 vue-flow 的 editor 实例传进来，
    // 这样 canvas.js 完全不需要认识 vue-flow。
    blocks: deps.blocks,
    // 用 getter 而不是提前求值：宿主里的 editor 是个 ref，
    // agent 可能在它建好之前就被调用，提前取值会拿到 null。
    get editor() {
      return deps.getEditor ? deps.getEditor() : deps.editor;
    },
    newId: deps.newId,
    // 只标「未保存」，绝不落盘 —— 这是 G5 唯一允许的副作用
    onCanvasChanged: deps.onCanvasChanged,
    // 写类工具（test_js）走 background 执行：要 scripting 权限且世界是 MAIN，
    // 那是 background 的活，content script 和 newtab 都做不了。
    // 工具发的是 {type, ...} 载荷，但 background 的 MessageListener 按
    // {name: 'background--<type>', data} 查表 —— 必须过这里的翻译，且要用
    // utils/message 的 sendMessage（Firefox 下它会把载荷 stringify 成字符串），
    // 裸 runtime.sendMessage 在 Firefox 会让 background 的 JSON.parse 炸掉。
    sendMessage: toBackground,
    // 工具执行时读到的是「这一刻」的目标页：
    // 工具是直接读 ctx.targetTab 的，所以这里放的是快照而不是闭包，
    // setTargetTab 必须同步把 toolCtx.targetTab 换掉，否则工具会一直用旧标签页。
    targetTab,

    // —— P2 标签页定位（tabs.js 工具用）——
    // getter：focus_tab 改的是内部数组，工具要读到最新值
    get pins() {
      return pins;
    },
    listTabs: () => listTargetableTabs(browser),
    getTab: (id) => browser.tabs.get(id),
    /** 开新页（不抢焦点）。tabs.create 在扩展页可直接调，不用过 background。 */
    createTab: (url) => browser.tabs.create({ url, active: false }),
    /** 追加 pin（按 tabId 去重）。 */
    addPin: async (pin) => {
      pins = upsertPin(pins, pin);
      focusedTabId = pin.tabId;
    },
  };

  const setTargetTab = (tab) => {
    targetTab = tab;
    toolCtx.targetTab = tab;

    return targetTab;
  };

  // focusTab 依赖 setTargetTab，在其定义之后挂到 ctx 上。
  // 切换焦点：刷新快照（标题/URL 可能已变）+ 记焦点 + 通知 UI。
  toolCtx.focusTab = async (tabId) => {
    const fresh = normalize(await browser.tabs.get(tabId));
    setTargetTab(fresh);
    focusedTabId = tabId;
    if (currentOnEvent) {
      currentOnEvent({ kind: AGENT_EVENTS.TARGET_TAB, tab: fresh });
    }
    return fresh;
  };

  // 初值也对齐一次，避免首次调用时 toolCtx.targetTab 是 undefined
  toolCtx.targetTab = targetTab;

  /**
   * 每步预检（advisory，由 loop 在每步开头调用）：
   *   - 焦点 tab 被关 → 通知模型
   *   - origin 与 pin 记录不一致（用户导航/重定向）→ 通知模型，由它决定去留
   * 顺带把快照刷新成「这一刻」的 url/title。
   */
  const preStepNotice = async () => {
    if (!targetTab || typeof targetTab.id !== 'number') return null;

    let tab;
    try {
      tab = await browser.tabs.get(targetTab.id);
    } catch {
      return tabClosedNotice(targetTab.id);
    }

    setTargetTab(normalize(tab));

    const pin = pins.find((p) => p.tabId === tab.id);
    const expected = pin ? pin.origin : '';
    const actual = originOf(tab.url);

    const drift = originDriftNotice({
      expected,
      actual,
      url: tab.url,
    });
    if (drift) {
      const key = originDriftKey(expected, actual);
      if (key === lastNoticeKey) return null;
      lastNoticeKey = key;
      return drift;
    }

    // 指纹比对（设计稿 §6.4）：advisory，runtime 不替模型决定读不读。
    // 每轮最多一次 probe；模型从没读过页就没有基线，跳过省一次 content 往返。
    if (fpCheckPending) {
      fpCheckPending = false;

      if (lastRead && lastRead.tabId === tab.id) {
        const res = await readPageFromTab(targetTab, { detail: 'probe' });
        const fp = res && typeof res === 'object' ? res.fingerprint : null;

        if (fp && fp !== lastRead.fingerprint) {
          const notice = fingerprintChangedNotice({
            before: lastRead.fingerprint,
            after: fp,
          });
          if (notice) {
            const key = fingerprintKey(lastRead.fingerprint, fp);
            if (key !== fpNoticeKey) {
              fpNoticeKey = key;
              return notice;
            }
          }
        }
      }
    }

    return null;
  };

  // 在途的 agent 实例（send 期间可被 abort() 中止）
  let activeAgent = null;

  // 当前会话 id。null = 还没落过盘的新会话，第一次 send 成功后才创建，
  // 空会话不占存储。
  let currentSessionId = null;

  // busy 期间用户补充的指令（P3 插话队列）。drainInstructions 每步清空一次；
  // 轮结束时没来得及 drain 的留下，下一轮 step 0 自动送达（loop 每步都会 drain）。
  // 切会话/新会话时清空——插话属于当时的会话上下文，带过去只会答非所问。
  const instructionQueue = [];

  /**
   * page 组写类工具（test_js / highlight_selector）加跨会话锁检查：
   * 目标 tab 被另一个 runtime 的在途会话占住时直接返回 error 观察值，
   * 模型能据此等待或换页。锁的登记/释放都在 send 的窗口里做。
   */
  const guardedTools = TOOLS.map((tool) => {
    if (tool.group !== 'page' || tool.class !== 'write') return tool;

    return {
      ...tool,
      execute: async (args, ctx) => {
        const tabId = ctx.targetTab && ctx.targetTab.id;
        const owner = tabId != null ? tabLocks.get(tabId) : null;

        if (owner && owner !== lockId) {
          return {
            status: 'error',
            payload:
              '目标页正被另一个助手会话使用。为避免两个会话互相干扰，本次写入被拒绝；请稍后再试或先和用户确认。',
          };
        }

        return tool.execute(args, ctx);
      },
    };
  });

  const send = async ({ userText, workflowContext, onEvent }) => {
    const config = await getConfig();

    if (!config || !config.apiKey) {
      const err = new Error('agent-not-configured');
      err.kind = 'config';
      throw err;
    }

    // 会话续接：每次 send 都从存储现读，不在 runtime 里另存一份副本 ——
    // 两份状态必然漂移。上一轮中断留下的悬空 tool_calls 由 wire 配对净化兜住。
    let initialHistory = [];
    let createdAt;
    let usageBefore = { input: 0, output: 0 };

    if (sessionStore && currentSessionId) {
      const rec = await sessionStore.load(currentSessionId);
      initialHistory = (rec && rec.events) || [];
      createdAt = rec && rec.createdAt;
      // 恢复本会话的 pin；首次 send 的捕获在拿到 targetTab 之后做
      pins = (rec && rec.pins) || [];
      focusedTabId = (rec && rec.focusedTabId) || null;
      usageBefore = (rec && rec.usage) || usageBefore;
    }

    // T-34：检查点落盘要求会话有 id。首轮在这给它（原来第一次 send 成功后才
    // 创建）——中途被卡死/刷新的轮次就能留下在途快照供事后诊断。
    if (sessionStore && !currentSessionId) {
      currentSessionId = createSessionId();
    }

    // pin 的首轮自动捕获（id<0 是浏览器会话恢复/分离页的假 tab，不能当 pin）
    const initial = initialPinsFromTab(pins, targetTab, originOf);
    if (initial) {
      pins = initial;
      focusedTabId = targetTab.id;
    }

    // 在途锁：本轮期间占住全部 pin，别让另一个面板会话把页从脚底下抽走
    pins.forEach((p) => {
      if (!tabLocks.has(p.tabId)) tabLocks.set(p.tabId, lockId);
    });

    // 按宿主声明过滤工具组：page/context/tab 通用，canvas 只在有画布的宿主启用
    const activeTools = enabledGroups
      ? guardedTools.filter((t) => enabledGroups.includes(t.group))
      : guardedTools;

    lastNoticeKey = '';
    // 只有模型读过页才值得花一次 probe 去比指纹（没有基线就无从比起）。
    // fpNoticeKey 故意不在每轮重置：页面变了提示一次，模型没重读就别逐轮刷屏。
    fpCheckPending = Boolean(lastRead);
    currentOnEvent = onEvent || null;

    const agent = createAgent({
      model: config.model,
      contextWindow: config.contextWindow,
      streamChat: (params) =>
        streamChat({
          ...params,
          config: {
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            model: config.model,
            temperature: config.temperature,
          },
        }),
      promptFacts: () => collectPromptFacts(activeTools),
      tools: activeTools,
      toolCtx,
      wrapUntrusted,
      buildUserMessage,
      requestConfirmation,
      preStepNotice,
      // busy 期间用户补充的指令，每步开工前送达模型（P3 插话队列）
      drainInstructions: () => instructionQueue.splice(0),
      log: agentLog,
    });

    activeAgent = agent;

    // T-34：转中检查点。每步事件入史后 debounce 一次落盘； usage 只记到上一轮
    // （本轮在途 usage 要等收尾才有），最终收尾 save 会整份覆盖它——形状一致。
    const checkpoints = createCheckpointSaver({
      buildRecord: () =>
        buildTurnRecord({
          id: currentSessionId,
          workflowId: getWorkflowId(),
          createdAt,
          events: pruneEphemeralEvents(agent.getHistory()),
          pins,
          focusedTabId,
          usage: usageBefore,
        }),
      save: (rec) =>
        sessionStore ? sessionStore.save(rec) : Promise.resolve(null),
      logWarn: (err) =>
        agentLog.warn('checkpoint.save.fail', {
          message: err && err.message ? err.message : String(err),
        }),
    });

    const onEventWithCheckpoint = (ev) => {
      if (onEvent) onEvent(ev);
      if (
        ev &&
        (ev.kind === AGENT_EVENTS.TOOL_RESULT ||
          ev.kind === AGENT_EVENTS.USER_MESSAGE ||
          ev.kind === AGENT_EVENTS.DONE)
      ) {
        checkpoints.schedule();
      }
    };

    try {
      agentLog('turn.start', {
        sessionId: currentSessionId,
        userLen: userText.length,
      });
      const result = await agent.send({
        userText,
        targetTab,
        workflowContext,
        onEvent: onEventWithCheckpoint,
        initialHistory,
      });

      // 先取消在途检查点，再写最终记录——迟到的旧快照不能覆盖最终态。
      checkpoints.cancel();

      // 收尾后把完整历史写回存储（getHistory 是唯一权威来源）。
      // 形状只在 turnRecord.js 构造一次——转中落盘（T-34）也从它出。
      const events = pruneEphemeralEvents(agent.getHistory());
      const usage = accumulateUsage(usageBefore, result.usage);

      if (sessionStore) {
        const isFirstTurn = !createdAt;
        await sessionStore.save(
          buildTurnRecord({
            id: currentSessionId,
            workflowId: getWorkflowId(),
            createdAt,
            events,
            pins,
            focusedTabId,
            usage,
          })
        );
        agentLog('turn.saved', {
          sessionId: currentSessionId,
          events: events.length,
        });

        // LLM 标题：只在首轮结束后生成一次，失败静默回退到消息前缀。
        // fire-and-forget，不拖住 send 的返回。
        //
        // 这个 then 要几秒后才跑，期间用户可能已经点了「新建会话」或发出了第二轮，
        // 所以两件事都不能用「那一刻」的外层状态（backlog T-35 + B1）：
        //  ① id 在**发起时**捕获 —— 拿 resolve 时的 currentSessionId（可能已是 null）
        //     当 id，会落出 agent_session_null 幽灵会话并写进索引；
        //  ② 只 patch title 一个字段 —— 整记录 save 会把首轮 events 快照盖到第二轮上。
        if (isFirstTurn) {
          const titleSessionId = currentSessionId;
          generateTitleAsync(config, userText, events)
            .then(async (title) => {
              if (!title || !sessionStore || !titleSessionId) return;
              const patched = await sessionStore.patchTitle(
                titleSessionId,
                title
              );
              if (!patched) {
                // 会话在生成期间被删：放弃，patchTitle 不会替它造记录
                agentLog('title.skip', {
                  sessionId: titleSessionId,
                  reason: 'session-gone',
                });
                return;
              }
              agentLog('title.saved', { sessionId: titleSessionId });
              if (deps.onSessionsChanged) deps.onSessionsChanged();
            })
            .catch((err) => {
              agentLog.warn('title.skip', {
                message: err && err.message ? err.message : String(err),
              });
            });
        }
      }

      return { ...result, sessionId: currentSessionId, usage };
    } finally {
      checkpoints.cancel();
      activeAgent = null;
      currentOnEvent = null;
      [...tabLocks.entries()].forEach(([tabId, owner]) => {
        if (owner === lockId) tabLocks.delete(tabId);
      });
    }
  };

  return {
    send,
    setTargetTab,
    getTargetTab: () => targetTab,

    /**
     * 用户手动选定目标页（TabPicker）：设焦点、并入 pin。
     * 用户的意图是「以后就用这个页」，所以 pin 一起更新。
     */
    pickTab(tab) {
      setTargetTab(tab);
      if (tab && typeof tab.id === 'number' && tab.id >= 0) {
        pins = [
          ...pins.filter((p) => p.tabId !== tab.id),
          { tabId: tab.id, origin: originOf(tab.url), title: tab.title },
        ];
        focusedTabId = tab.id;
      }
      return targetTab;
    },

    /** 打开已有会话：读回历史并按 pin 恢复目标页。 */
    async openSession(id) {
      currentSessionId = id || null;
      lastNoticeKey = '';

      if (!sessionStore || !id) return { events: [], targetTab: null };

      const rec = await sessionStore.load(id);
      const events = (rec && rec.events) || [];
      pins = (rec && rec.pins) || [];
      focusedTabId = (rec && rec.focusedTabId) || null;
      // 插话属于原会话的上下文，切走就丢
      instructionQueue.length = 0;

      // 目标页从 pin 恢复（focus_tab 会改 focusedTabId，比扫 TARGET_TAB
      // 事件更准）。纯显示用途——真实执行前预检会发现 tab 已关并报给模型
      let tab = null;
      const pin = pins.find((p) => p.tabId === focusedTabId) || pins[0] || null;
      if (pin) {
        try {
          tab = normalize(await browser.tabs.get(pin.tabId));
        } catch {
          tab = {
            id: pin.tabId,
            url: '',
            title: pin.title || '(页面可能已关闭)',
            windowId: -1,
          };
        }
        setTargetTab(tab);
      }

      return {
        events,
        targetTab: tab,
        usage: (rec && rec.usage) || null,
      };
    },

    /** 开新会话：下一次 send 成功后才落盘。 */
    newSession() {
      currentSessionId = null;
      pins = [];
      focusedTabId = null;
      lastNoticeKey = '';
      instructionQueue.length = 0;
    },

    getSessionId: () => currentSessionId,

    /** 中止当前在途的一轮（没有在途则空操作）。 */
    abort() {
      if (activeAgent) activeAgent.abort();
    },

    /**
     * busy 期间用户补充指令（P3 插话队列）。返回 false 表示当前不在跑，
     * 宿主应走正常 send。
     */
    enqueueInstruction(text) {
      const t = String(text || '').trim();
      if (!t) return false;
      instructionQueue.push(t);
      return true;
    },

    /** 删除会话；删的是当前会话时自动回到新会话状态。 */
    async deleteSession(id) {
      if (!sessionStore) return;
      await sessionStore.remove(id);
      if (id === currentSessionId) currentSessionId = null;
    },
  };
}

/** 解析目标页。 */
export const resolveTarget = (opts) => resolveTargetTab(browser, opts);

/** 列出可注入的标签页，按窗口分组。 */
export const listTabs = () => listTargetableTabs(browser);

/** 读写配置的 IO 适配：复用项目既有的 credentialUtil，不另造加密。 */
export const configIO = {
  get: (key) => browser.storage.local.get(key).then((r) => r[key]),
  set: (key, value) => browser.storage.local.set({ [key]: value }),
  remove: (key) => browser.storage.local.remove(key),
  encrypt: (v) => credentialUtil.encrypt(v),
  decrypt: (v) => credentialUtil.decrypt(v),
};

export { loadConfig, saveConfig };

/** 会话存储的 IO 适配与默认实例（键布局见 sessions.js 顶部注释）。 */
export const sessionIO = {
  get: (key) => browser.storage.local.get(key).then((r) => r[key]),
  set: (key, value) => browser.storage.local.set({ [key]: value }),
  remove: (key) => browser.storage.local.remove(key),
};

export const sessionStore = createSessionStore(sessionIO);
