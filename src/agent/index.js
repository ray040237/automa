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
import { buildTitleMessages, cleanTitle } from './title';

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
 * @param {Array<Object>=} tools
 * @returns {Object}
 */
export function collectPromptFacts(tools = TOOLS) {
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
export async function readPageFromTab(tab, params) {
  const options =
    typeof params === 'string' ? { detail: params } : params || {};

  if (!tab) return '没有确定目标页。请先让用户选一个标签页。';

  try {
    const res = await browser.tabs.sendMessage(tab.id, {
      type: 'agent:read-page',
      op: options.op || 'read',
      detail: options.detail,
      maxChars: options.maxChars,
      keyword: options.keyword,
      limit: options.limit,
    });

    // content 侧读页返回 {text, fingerprint}；指纹必须原样带回来 ——
    // 它是「页面变没变」的唯一判据，塞进文本会被陈旧快照剔除抹掉（设计稿 §6.2）
    if (res && typeof res === 'object' && typeof res.text === 'string')
      return { text: res.text, fingerprint: res.fingerprint || null };

    if (typeof res === 'string' && res) return res;

    return (
      '这个页面读不到结构。常见原因：页面尚未加载完；这是一个扩展内置页' +
      '（chrome:// 与扩展自己的页面都没有注入 content script）；或站点未授予扩展权限。'
    );
  } catch (err) {
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
    getBlockSchema = async () => null,
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
    // 那是 background 的活，content script 和 newtab 都做不了
    sendMessage: (msg) => browser.runtime.sendMessage(msg),
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
      if (!pins.some((p) => p.tabId === pin.tabId)) pins = [...pins, pin];
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
      return (
        '系统提示：目标页（id ' +
        targetTab.id +
        '）已经关闭。如需继续操作网页，请用 list_tabs 查看现有标签页并 focus_tab 切换，或用 open_url 打开新页面；也可以直接基于已有信息回答。'
      );
    }

    setTargetTab(normalize(tab));

    const pin = pins.find((p) => p.tabId === tab.id);
    const expected = pin ? pin.origin : '';
    const actual = originOf(tab.url);

    if (expected && actual && expected !== actual) {
      const key = 'origin:' + expected + '>' + actual;
      if (key === lastNoticeKey) return null;
      lastNoticeKey = key;
      return (
        '系统提示：目标页从 ' +
        expected +
        ' 导航到了 ' +
        actual +
        '（当前 URL: ' +
        tab.url +
        '）。如果这不是你预期的跳转，此前基于旧页面做出的选择器/结论可能已失效，请重新 read_page 确认。'
      );
    }

    // 指纹比对（设计稿 §6.4）：advisory，runtime 不替模型决定读不读。
    // 每轮最多一次 probe；模型从没读过页就没有基线，跳过省一次 content 往返。
    if (fpCheckPending) {
      fpCheckPending = false;

      if (lastRead && lastRead.tabId === tab.id) {
        const res = await readPageFromTab(targetTab, { detail: 'probe' });
        const fp = res && typeof res === 'object' ? res.fingerprint : null;

        if (fp && fp !== lastRead.fingerprint) {
          const key = 'fp:' + lastRead.fingerprint + '>' + fp;
          if (key !== fpNoticeKey) {
            fpNoticeKey = key;
            return (
              '系统提示：目标页内容已变化（指纹 ' +
              lastRead.fingerprint +
              ' → ' +
              fp +
              '）。此前基于该页得出的选择器/结论可能已失效，请重新 read_page 确认；' +
              '如果页面没变，沿用上次结论即可，不要重复读页。'
            );
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

    // id<0 是浏览器会话恢复/分离页的假 tab，绝不能当 pin 身份
    if (
      pins.length === 0 &&
      targetTab &&
      typeof targetTab.id === 'number' &&
      targetTab.id >= 0
    ) {
      pins = [
        {
          tabId: targetTab.id,
          origin: originOf(targetTab.url),
          title: targetTab.title,
        },
      ];
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
    });

    activeAgent = agent;

    try {
      const result = await agent.send({
        userText,
        targetTab,
        workflowContext,
        onEvent,
        initialHistory,
      });

      // 收尾后把完整历史写回存储（getHistory 是唯一权威来源）。
      // thinking 事件是流式碎片且不进 wire，落盘前剪掉，历史不膨胀。
      const events = agent
        .getHistory()
        .filter((ev) => ev.kind !== AGENT_EVENTS.THINKING);

      const usage = {
        input: usageBefore.input + (result.usage ? result.usage.input : 0),
        output: usageBefore.output + (result.usage ? result.usage.output : 0),
      };

      if (sessionStore) {
        const isFirstTurn = !createdAt;
        if (!currentSessionId) currentSessionId = createSessionId();
        await sessionStore.save({
          id: currentSessionId,
          workflowId: getWorkflowId(),
          status: 'active',
          createdAt: createdAt || Date.now(),
          lastAccessedAt: Date.now(),
          events,
          pins,
          focusedTabId,
          usage,
        });

        // LLM 标题：只在首轮结束后生成一次，失败静默回退到消息前缀。
        // fire-and-forget，不拖住 send 的返回。
        if (isFirstTurn) {
          generateTitleAsync(config, userText, events)
            .then(async (title) => {
              if (!title || !sessionStore) return;
              await sessionStore.save({
                id: currentSessionId,
                workflowId: getWorkflowId(),
                status: 'active',
                createdAt: createdAt || Date.now(),
                lastAccessedAt: Date.now(),
                events,
                pins,
                focusedTabId,
                usage,
                title,
              });
              if (deps.onSessionsChanged) deps.onSessionsChanged();
            })
            .catch(() => {});
        }
      }

      return { ...result, sessionId: currentSessionId, usage };
    } finally {
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
