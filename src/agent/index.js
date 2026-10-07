/**
 * 装配层。
 *
 * 这是整个 agent 里唯一允许碰浏览器 API 与项目别名（@/）的文件。
 * 下面所有模块（loop / tools / prompt / events …）都保持纯函数，
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

/**
 * 浏览器通道 adapter（T-126 第二步抽出去的）：两条超时常量 + `toBackground`
 * + `readPageFromTab` + 帧合并，约 300 行，单独一个模块了。
 *
 * 搬走的理由、以及「三条超时常量为什么必须跟着一起走」，都写在那边文件的头注里。
 *
 * **先 import 再单独 re-export 是刻意的过渡设计**：导出面一个不动，
 * `agentHost.js` 与 `assembly.test.js` 的 import 都不用改。什么时候可以删，
 * 取决于那些消费方有没有跟着改成从 `./browserAdapter` 直接引 —— 见 T-126
 * 第三步（本次明确不做）。
 *
 * 注意不能写成 `export {...} from './browserAdapter'`：那种写法只导出、
 * **不在本文件作用域里建立绑定**，而 `createAgentRuntime` 的 toolCtx 里要用
 * `sendMessage: toBackground`。
 */
import { toBackground, readPageFromTab } from './browserAdapter';

/**
 * 全链路日志（控制台 + 环形缓冲）。排查卡死/异常时的现场，见 log.js 头注。
 *
 * 实例本体搬到 `log.js` 了（同一次拆分）：`browserAdapter.js` 要写同一条日志
 * （`channel.send` / `channel.reply` / `channel.timeout`），而环形缓冲**必须
 * 只有一个** —— 拆成两个实例，页面卡死时从 `window.__agentLogs` 导出的现场就
 * 只剩一半。同样先 import 再 re-export，导出面不变。
 */
import { agentLog } from './log';

import { buildFacts } from './facts';
import { createAgent } from './loop';
import { AGENT_EVENTS } from './events';
import { TOOLS } from './tools';
import { createPiProvider, toPiContext } from './provider';
import { wrapUntrusted } from './untrusted';
import { buildUserMessage } from './prompt';
import { readSkillFrom } from './skills';
import {
  resolveTargetTab,
  listTargetableTabs,
  originOf,
  normalize,
} from './tab';
import { isHttpUrl, loadConfig, saveConfig } from './config';
import {
  createSessionId,
  createSessionStore,
  hasInterruptedTail,
  INTERRUPTED_TURN_NOTICE,
} from './sessions';
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

/** 见上（文件头的 adapter 注释）：过渡期的 re-export，导出面保持不变。 */
export { toBackground, readPageFromTab, agentLog };

// 两条超时常量的本体在 browserAdapter.js 了（它们「为什么会在一起」的理由写
// 在那边头注里 —— 那个才是这段代码真正的位置）。这里继续 re-export 只是为了
// 不动 index.test.js 的「16 个导出」基线断言；删掉它们等于顺手改那条断言的
// 口径，那是第三步的事。
export {
  BACKGROUND_CHANNEL_TIMEOUT_MS,
  TAB_CHANNEL_TIMEOUT_MS,
} from './browserAdapter';

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

  // 标题请求用固定的低温度，与主循环的 config.temperature 分开 ——
  // 主循环那个是给 agent 推理调的，0.2 对「起个标题」偏随机。
  const titleConfig = { ...config, temperature: 0.3 };
  const { model, streamFn } = await createPiProvider(titleConfig);

  const stream = streamFn(
    model,
    toPiContext(buildTitleMessages(userText, reply))
  );
  const result = await stream.result();

  // errorMessage 优先于正文：出错时 result.content 通常是空的，
  // 直接取会得到「标题为空」这个假象，掩盖真实原因。
  const title =
    result.stopReason === 'error'
      ? null
      : (result.content || [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('');

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
 * 组装可用的 agent runtime。
 *
 * @param {Object} deps
 * @param {() => Promise<Object>} deps.getConfig
 * @param {(payload: Object) => Promise<Object>} deps.requestConfirmation
 * @param {() => Promise<Object>=} deps.getVariables **必填**（T-50）。返回形状：
 *   绑定了工作流 `{bound:true, workflowId, variables:Object, globals:Object}`；
 *   没绑定（例如独立助手页）`{bound:false}`。两种形状在 get_variables 工具里渲染成
 *   完全不同的结论 —— 「没有变量」与「这里根本没有工作流可读」对模型是两回事，
 *   混成同一个「（空）」会让模型凭空编出一个空变量名。
 *   早先这里有个 `async () => ({})` 缺省兜底，等于任何漏注入的宿主都拿到
 *   「（空）」这个静默错误答案；已删，缺注入直接抛。
 * @param {(name: string) => Promise<Object|null>=} deps.getBlockSchema
 * @param {() => Promise<string>=} deps.getInstructions 用户自定义指令正文（T-81a），
 *   每轮 send 取一次；空串 = 未配置/关闭。缺省给空实现 —— 测试装配不必关心指令。
 * @param {() => Promise<Array>=} deps.getSkillIndex 技能索引清单（T-81b），
 *   每轮 send 取一次进 prompt；缺省空实现。
 * @param {(name: string) => Promise<{skill: Object|null, available: string[]}>=} deps.readSkill
 *   read_skill 工具的查找实现；缺省读 configIO 的技能库。
 * @param {Object=} deps.targetTab
 * @param {Object=} deps.sessionStore sessions.js 的会话仓库；不传则无跨轮记忆
 * @param {() => string=} deps.getWorkflowId 会话归属的工作流 id
 * @returns {Object}
 */
export function createAgentRuntime(deps) {
  const {
    getConfig,
    requestConfirmation,
    getVariables,
    getBlockSchema = lookupBlockSchema,
    getInstructions = async () => '',
    getSkillIndex = async () => [],
    readSkill = null,
    sessionStore = null,
    getWorkflowId = () => null,
    enabledGroups = null,
  } = deps;

  if (typeof getVariables !== 'function') {
    throw new Error(
      'createAgentRuntime: 缺 getVariables。变量数据来自宿主（工作流 globalData + 全局变量表），' +
        '装配层拿不到就等于「没有变量」—— 这个假答案会让模型编出不存在的变量名。' +
        '宿主必须注入；没有工作流可读时传 async () => ({ bound: false })。'
    );
  }

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
      readPageFromTab(targetTab, { op: 'find-text', frame: 'top', ...params }),
    getVariables,
    getBlockSchema,
    // read_skill 工具（T-81b）的查找实现：缺省读 configIO 里的技能库。
    // 每次调用现读存储 —— 设置页改完技能下一轮生效，与指令同一立场。
    // configIO 在模块底部才定义，运行时才走到这里 —— eslint 前置引用豁免
    // eslint-disable-next-line no-use-before-define
    readSkill: readSkill || readSkillFrom(configIO),
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
    // 工具执行时读到的是「这一刻」的目标页：getter 每次求值 —— adapter 每次
    // execute 都重新 spread（tools/adapter.js），工具拿到的就是本步执行时刻的
    // 快照。setTargetTab 只改闭包变量，不再需要手动回写 toolCtx（T-133）。
    get targetTab() {
      return targetTab;
    },

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
        const res = await readPageFromTab(targetTab, {
          detail: 'probe',
          frame: 'top',
        });
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

    // T-66：接口地址是空串或非 http(s) 时，在这儿停住。走到 buildModel 只会
    // 让 pi 抛一句指不到真因的 provider 报错（T-40：错误要能定位）。
    // 文案带上用户自己填的那个值（config.baseUrlInvalid —— resolveActiveConfig
    // 清洗时把原值留在了这个字段上）：「你填的是 ftp://…」比「接口地址非法」
    // 有用得多。
    if (!isHttpUrl(config.baseUrl)) {
      const err = new Error(
        '接口地址必须以 http:// 或 https:// 开头（当前：' +
          (config.baseUrlInvalid || config.baseUrl || '空') +
          '）'
      );
      err.kind = 'config';
      // 有具体文案就用它，没有的（apiKey 空）才回落到宿主那把 i18n 文案
      err.specific = true;
      throw err;
    }

    // 会话续接：每次 send 都从存储现读，不在 runtime 里另存一份副本 ——
    // 两份状态必然漂移。上一轮中断留下的悬空 tool_calls 由 pi 的消息净化
    // 兜住（为孤儿调用合成结果，见 ADR 0004）。
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
    // enabledGroups 支持数组或 () => 数组（T-135/T-84）：函数形式每次 send
    // 求值——团队权限（haveEditAccess）变化后下一轮生效，无需重建 runtime；
    // promptFacts 本来就 per-send 重建，事实表的工具清单自动跟上。
    const groups =
      typeof enabledGroups === 'function' ? enabledGroups() : enabledGroups;
    const activeTools = groups
      ? guardedTools.filter((t) => groups.includes(t.group))
      : guardedTools;

    lastNoticeKey = '';
    // 只有模型读过页才值得花一次 probe 去比指纹（没有基线就无从比起）。
    // fpNoticeKey 故意不在每轮重置：页面变了提示一次，模型没重读就别逐轮刷屏。
    fpCheckPending = Boolean(lastRead);
    currentOnEvent = onEvent || null;

    // 票 08：provider 层交给 pi。这里只把 config 翻成 pi 的 Model + streamFn，
    // 请求参数（messages / tools / temperature / 重试）此后全部由 pi 生成。
    const { model, streamFn } = await createPiProvider(config);

    // 自定义指令（T-81a）：读取失败不杀整轮 —— 与事实表构建失败同一原则
    // （降级成「无指令」继续对话），但必须留 warn，不静默。
    let instructions = '';
    try {
      instructions = await getInstructions();
    } catch (err) {
      agentLog.warn('instructions.load.fail', {
        message: err && err.message ? err.message : String(err),
      });
    }

    // 技能索引（T-81b）：与指令同一模式 —— 每轮现读进事实表，失败降级留痕。
    let skillIndex = [];
    try {
      skillIndex = await getSkillIndex();
    } catch (err) {
      agentLog.warn('skills.index.load.fail', {
        message: err && err.message ? err.message : String(err),
      });
    }

    const agent = createAgent({
      model,
      streamFn,
      // 用户自定义指令（T-81a）与技能索引（T-81b）每轮 send 取一次，盖进事实表
      // —— 与 enabledGroups 函数化同一立场：用户改完下一轮立即生效，无需重建。
      promptFacts: () => ({
        ...collectPromptFacts(activeTools),
        instructions,
        skills: skillIndex,
      }),
      tools: activeTools,
      toolCtx,
      wrapUntrusted,
      buildUserMessage,
      requestConfirmation,
      preStepNotice,
      // busy 期间用户补充的指令，每步开工前送达模型（P3 插话队列）
      drainInstructions: () => instructionQueue.splice(0),
      // T-76：上下文窗口驱动压缩阈值；用户在设置页按自己的模型调
      contextWindow: config.contextWindow,
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
      let events = (rec && rec.events) || [];
      pins = (rec && rec.pins) || [];
      focusedTabId = (rec && rec.focusedTabId) || null;
      // 插话属于原会话的上下文，切走就丢
      instructionQueue.length = 0;

      // B7：上一轮在收尾前被打断（页面被杀，loop 随闭包消失，没有 DONE/ERROR
      // 收尾信号）。补一条 system-notice 让用户知道，并**立即落盘** —— 幂等靠
      // 它：下次 openSession 在 tail 里看到这条就不再补（hasInterruptedTail）。
      // 落盘失败只留 warn、不拖垮「打开会话」这条读路径：提示本就是行有余力的
      // 告知，代价顶多是下次重开再提示一次。
      if (hasInterruptedTail(events)) {
        events = [
          ...events,
          {
            kind: AGENT_EVENTS.SYSTEM_NOTICE,
            text: INTERRUPTED_TURN_NOTICE,
            // SYSTEM_NOTICE 进 transcript 的契约（historyToPiMessages）：必须带
            // 包装文本，否则续接下一轮时 promptTextOf 直接抛错。
            promptText: wrapUntrusted(
              'untrusted_system_notice',
              INTERRUPTED_TURN_NOTICE
            ),
          },
        ];
        try {
          await sessionStore.save({ ...rec, events });
        } catch (err) {
          agentLog.warn('openSession.interruptNotice.save.fail', {
            message: err && err.message ? err.message : String(err),
          });
        }
      }

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

    /**
     * 还没送达模型的插话条数（T-12：面板常驻显示「已入队 N 条」）。
     *
     * 队列本身没有出队事件，所以调用方只能在收到别的信号时读一次长度 ——
     * 这就是它只是个 getter、不发事件的原因。
     */
    pendingInstructionCount() {
      return instructionQueue.length;
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
