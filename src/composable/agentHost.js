/**
 * 助手宿主共用接线。
 *
 * 两个宿主（主面板的独立助手页 / 工作流编辑器侧栏）面对的是同一个 runtime 契约
 * （src/agent/index.js 的 createAgentRuntime）和同一块面板（AgentPanel.vue），
 * 差别只有两处：开放哪些工具组、有没有画布句柄。宿主本身除了接线没有别的逻辑，
 * 所以接线放这里，避免两份各自漂移。
 *
 * 两个陷阱，改这里之前先读：
 *
 * 1. agent 必须是 reactive 而不是 shallowReactive —— events 是靠 push 增长的，
 *    浅响应下数组内新增不会触发渲染，transcript 会「发了消息但屏幕不动」。
 * 2. 卸载前必须把挂着的确认门放行（否）：loop 那侧一直在 await 这个 promise，
 *    宿主没了它永远不会结束（CONTEXT.md「确认门」条）。见文件末尾。
 */

import { onBeforeUnmount, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useToast } from 'vue-toastification';
import browser from 'webextension-polyfill';
import {
  configIO,
  createAgentRuntime,
  loadConfig,
  resolveTarget,
  sessionStore,
} from '@/agent';

/**
 * @param {Object} deps
 * @param {Array<string>} deps.enabledGroups 该宿主开放的工具组
 * @param {() => (string|null)} deps.getWorkflowId 会话归属的工作流 id；独立页恒为 null
 * @param {string=} deps.sessionWorkflowId 会话列表按哪个工作流过滤；不传就是全局列表
 * @param {Object=} deps.canvas 画布句柄，给了并且工具组里有 canvas，助手才能改画布
 * @param {Object} deps.canvas.blocks getBlocks() 的结果
 * @param {() => Object} deps.canvas.getEditor vue-flow 实例（ref，$ 晚于 runtime 就绪）
 * @param {() => string} deps.canvas.newId 节点 id 生成器
 * @param {() => void} deps.canvas.onCanvasChanged 只准标脏，绝不准落盘
 * @returns {Object} 面板直接绑在这个对象上
 */
export function useAgentHost(deps) {
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();

  const agent = reactive({
    events: [],
    config: {},
    targetTab: null,
    busy: false,
    runtime: null,
    sessions: [],
    sessionId: null,
    usage: null,
    pendingConfirm: null,
  });

  /**
   * 写类工具的确认门。
   *
   * 把 promise 存在 pendingConfirm 上，卡片点「允许」时再 resolve ——
   * loop 那一侧会一直 await 住，不会超时也不会偷偷放行。
   */
  function askAgentConfirmation(req) {
    return new Promise((resolve) => {
      agent.pendingConfirm = {
        code: (req && req.code) || '',
        resolve: (approved) => {
          agent.pendingConfirm = null;
          resolve({ approved });
        },
      };
    });
  }

  /** 刷新会话列表。有 deps.sessionWorkflowId 时只列该工作流的会话。 */
  async function refreshAgentSessions() {
    agent.sessions = await sessionStore.listIndex(deps.sessionWorkflowId);
  }

  /**
   * 切会话前的共同守卫：busy 时不能切；挂着待确认的写操作时必须先拒绝，
   * 否则旧会话的 loop 会永远 await 下去（确认门 promise 挂在 runtime 闭包上）。
   */
  function guardAgentSwitch() {
    if (agent.busy) return false;
    if (agent.pendingConfirm) {
      agent.pendingConfirm.resolve(false);
    }
    return true;
  }

  async function openAgentSession(id) {
    if (!guardAgentSwitch() || !agent.runtime) return;

    const { events, targetTab, usage } = await agent.runtime.openSession(id);
    agent.sessionId = id;
    agent.events = events || [];
    agent.usage = usage || null;
    if (targetTab) agent.targetTab = targetTab;
  }

  async function newAgentSession() {
    if (!guardAgentSwitch() || !agent.runtime) return;

    agent.runtime.newSession();
    agent.sessionId = null;
    agent.events = [];
    agent.usage = null;
  }

  async function deleteAgentSession() {
    if (!guardAgentSwitch() || !agent.runtime || !agent.sessionId) return;

    await agent.runtime.deleteSession(agent.sessionId);
    agent.sessionId = null;
    agent.events = [];
    agent.usage = null;
    await refreshAgentSessions();
  }

  function onPickTab(tab) {
    // 目标页变了要同步三处：runtime 的闭包快照、会话 pin（用户选的页
    // 就是「以后就用这个页」的意图）、面板上显示的那一行
    agent.runtime.pickTab(tab);
    agent.targetTab = tab;
  }

  function goToAgentSettings() {
    router.push({ path: '/settings', hash: '#agent' });
  }

  /** 用户点停止：只发中止信号，收尾由 loop 以 DONE(aborted) 完成。 */
  function abort() {
    if (agent.runtime) agent.runtime.abort();
  }

  async function send(userText) {
    // busy 时不打断任务，把输入送进插话队列，下一步开工前送达模型
    if (agent.busy) {
      const queued = agent.runtime.enqueueInstruction(userText);
      if (queued) {
        agent.events.push({
          kind: 'agent:system-notice',
          text: t('workflow.agent.queued'),
        });
      }
      return;
    }

    agent.busy = true;

    try {
      // 用户消息由 runtime 以 agent:user-message 事件入史并回显
      const result = await agent.runtime.send({
        userText,
        onEvent: (ev) => {
          if (ev && ev.kind === 'agent:target-tab') {
            agent.targetTab = ev.tab || agent.targetTab;
            return;
          }
          if (ev) agent.events.push(ev);
        },
      });

      if (result && result.sessionId && result.sessionId !== agent.sessionId) {
        agent.sessionId = result.sessionId;
      }
      if (result && result.usage) {
        agent.usage = result.usage;
      }
    } catch (err) {
      agent.events.push({
        kind: 'agent:error',
        message:
          err && err.kind === 'config'
            ? t('workflow.agent.notConfigured')
            : (err && err.message) || String(err),
      });
    } finally {
      agent.busy = false;
      // 标题/时间在首轮 send 后才生成，刷新列表让切换器立即可见
      await refreshAgentSessions();
    }
  }

  let inited = false;

  /** 惰性建 runtime：编辑器里只有真正打开侧栏才读配置、探目标页。 */
  async function init() {
    if (inited) return;
    inited = true;

    agent.config = await loadConfig(configIO);

    // 没有可注入的页面就别硬撑：agent 一开就报「读到的是编辑器自己」，比晚点报错更让人困惑。
    // windowId 显式取当前窗口 —— 早先是写死的 window.id（扩展页上没有这个属性），
    // 于是「当前窗口优先」那一级永远匹配不上，退化成了全浏览器最近访问的那个页。
    // 取不到窗口就退化到原来的行为，不因此让整个 init 失败。
    let windowId;
    try {
      const currentWindow = await browser.windows.getCurrent();
      windowId = currentWindow ? currentWindow.id : undefined;
    } catch (err) {
      windowId = undefined;
    }

    agent.targetTab = await resolveTarget({ windowId });

    agent.runtime = createAgentRuntime({
      getConfig: () => loadConfig(configIO),
      targetTab: agent.targetTab,
      enabledGroups: deps.enabledGroups,
      sessionStore,
      getWorkflowId: deps.getWorkflowId,
      ...(deps.canvas || {}),
      // LLM 标题异步生成完成后刷新面板上的会话列表
      onSessionsChanged: () => {
        refreshAgentSessions();
      },
      requestConfirmation: askAgentConfirmation,
    });

    // 打开最近的一个会话（没有就是新会话，首轮 send 后才落盘）
    await refreshAgentSessions();
    const [latest] = agent.sessions;
    if (latest) await openAgentSession(latest.id);
  }

  onBeforeUnmount(() => {
    // 宿主没了但 loop 还在 await 确认门 → 那个工具调用永远悬着，这一轮的会话也再
    // 不会保存。必须显式放行（否），让 loop 拿 error 观察值收尾。
    if (agent.pendingConfirm) agent.pendingConfirm.resolve(false);
  });

  return Object.assign(agent, {
    init,
    send,
    abort,
    pickTab: onPickTab,
    noTarget: () => toast.error(t('workflow.agent.noTarget')),
    goToSettings: goToAgentSettings,
    openSession: openAgentSession,
    newSession: newAgentSession,
    deleteSession: deleteAgentSession,
  });
}
