/**
 * 助手宿主共用接线。
 *
 * 两个宿主（主面板的独立助手页 / 工作流编辑器侧栏）面对的是同一个 runtime 契约
 * （src/agent/index.js 的 createAgentRuntime）和同一块面板（AgentPanel.vue，
 * 收单个 :host 对象 —— T-90）。实测依赖差分：独立页传 enabledGroups +
 * getWorkflowId(=> null)；编辑器侧多传 sessionWorkflowId、canvas 四句柄，
 * 且 enabledGroups 以 getter 传（T-69，响应式权限不被冻结）。宿主本身除了
 * 接线没有别的逻辑，所以接线放这里，避免两份各自漂移。
 *
 * 三个陷阱，改这里之前先读：
 *
 * 1. agent 必须是 reactive 而不是 shallowReactive —— events 是靠 push 增长的，
 *    浅响应下数组内新增不会触发渲染，transcript 会「发了消息但屏幕不动」。
 * 2. 卸载前必须把挂着的确认门放行（否）：loop 那侧一直在 await 这个 promise，
 *    宿主没了它永远不会结束（CONTEXT.md「确认门」条）。见文件末尾。
 * 3. 会话级授权（test_js 的「本会话允许试跑代码」）只有三个失效点：abort、
 *    切会话/新建（planSwitch）、面板卸载。状态机在 `confirm.js` 的
 *    `createSessionAuth`（T-90，纯函数、有测试），本文件只做副作用执行；
 *    失效点全部走它的 invalidate / planSwitch，别在闭包里另设标志位。
 */

import { markRaw, onBeforeUnmount, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useToast } from 'vue-toastification';
import browser from 'webextension-polyfill';
import { useDialog } from '@/composable/dialog';
import {
  configIO,
  createAgentRuntime,
  listTabs,
  loadConfig,
  resolveTarget,
  sessionStore,
} from '@/agent';
import { buildConfirmation, createSessionAuth } from '@/agent/confirm';
import { ERROR_KIND, errorEvent } from '@/agent/events';

/**
 * @param {Object} deps
 * @param {Array<string>|(() => Array<string>)} deps.enabledGroups 该宿主开放的工具组；
 *   传函数时 runtime 每次 send 求值（T-69：响应式权限不被冻结）
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
  // T-84：装配期必填校验。漏传 enabledGroups 会被 runtime 按「未过滤」处理
  // （canvas 组泄露给无画布宿主，T-45 同款事故）；漏传 getWorkflowId 会让
  // 会话归属静默落成全局列表，按工作流过滤的宿主永远看不到自己的历史。
  if (
    !Array.isArray(deps.enabledGroups) &&
    typeof deps.enabledGroups !== 'function'
  ) {
    throw new Error(
      'useAgentHost: deps.enabledGroups 必填（数组或 () => 数组，' +
        '后者供响应式权限用，见 T-69）。'
    );
  }
  if (typeof deps.getWorkflowId !== 'function') {
    throw new Error(
      'useAgentHost: deps.getWorkflowId 必填（() => workflowId 或 ' +
        '() => null）——缺了会话归属静默变全局，编辑器侧看不到自己的历史。'
    );
  }

  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const dialog = useDialog();

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
   * 会话级授权 + 挂起确认的状态机（T-90，confirm.js 纯函数，有测试）。
   * 「本会话允许试跑代码」只在内存里，三个失效点见 createSessionAuth 注释。
   */
  const sessionAuth = createSessionAuth({
    // 载荷在这里组装（targetTitle 是 agent 的知识）；状态机只管授权与挂起。
    buildPayload: (req) =>
      buildConfirmation(req, {
        targetTitle: agent.targetTab ? agent.targetTab.title || '' : '',
      }),
  });

  /**
   * 写类工具的确认门。
   *
   * 把 promise 存在 pendingConfirm 上，卡片点「执行」时再 resolve ——
   * loop 那一侧会一直 await 住，不会超时也不会偷偷放行。
   *
   * 载荷是结构化的（`src/agent/confirm.js`）：loop 传的是 `{ name, args }`，
   * 没有顶层 `code`，早先这里读 `req.code` 恒为 `''`，卡片上那个代码框一直是
   * 空的 —— 用户在盲批（docs/backlog.md T-27）。
   */
  function askAgentConfirmation(req) {
    // 已授权的 test_js 由状态机直接放行；其余挂起，载荷从状态机取
    // （T-90：授权判定与记录都在 createSessionAuth，这里只挂 reactive）。
    if (sessionAuth.ask(req).skip) {
      return Promise.resolve({ approved: true });
    }

    return new Promise((resolve) => {
      agent.pendingConfirm = {
        ...sessionAuth.pending,
        resolve: (answer) => {
          const out = sessionAuth.answer(answer);
          agent.pendingConfirm = null;
          resolve(out);
        },
      };
    });
  }

  /**
   * 卡片的应答入口。pendingConfirm 可能已被切会话/卸载路径清掉，先判空 ——
   * 直接 `agent.pendingConfirm.resolve(...)` 会在那次点击上抛 TypeError。
   */
  function answerConfirm(answer) {
    if (agent.pendingConfirm) agent.pendingConfirm.resolve(answer);
  }

  /** 刷新会话列表。有 deps.sessionWorkflowId 时只列该工作流的会话。 */
  async function refreshAgentSessions() {
    agent.sessions = await sessionStore.listIndex(deps.sessionWorkflowId);
  }

  /**
   * 切会话前的共同守卫：busy 时不能切；挂着待确认的写操作时必须先拒绝，
   * 否则旧会话的 loop 会永远 await 下去（确认门 promise 挂在 runtime 闭包上）。
   *
   * 顺带把会话级授权作废：授权的文案是「本会话允许」，换会话就不该还作数。
   * 动作与顺序由状态机的 planSwitch 给出（先拒挂起再失效，T-90），这里只执行。
   */
  function guardAgentSwitch() {
    const plan = sessionAuth.planSwitch({ busy: agent.busy });
    if (!plan.allow) return false;

    if (plan.rejectPending) agent.pendingConfirm.resolve(false);
    sessionAuth.invalidate();
    return true;
  }

  async function openAgentSession(id) {
    // id 为空是下拉里的占位项，不是一次切换 —— 交给它会把 runtime 的
    // 会话 id 置空但不清 pins/插话队列，落到一个不新不旧的状态。
    if (!id || !guardAgentSwitch() || !agent.runtime) return;

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

  /**
   * 删除会话。targetId 为空时删当前会话（列表每项带删除按钮后一般不再走这条）。
   *
   * 二次确认不能省：会话是唯一的历史载体，一次误触就是整段对话与工具执行记录
   * 没了、且不可撤销。弹窗正文回显标题，避免「删错了那条」。
   *
   * 确认回调里的复核是「该会话仍存在」而不是「仍是当前会话」：按项删除时用户
   * 完全可以删一条非当前会话，拿「还是不是当前」去卡会把合法操作直接否掉。
   * busy 仍然要卡 —— 删在途会话会在收尾时被那一轮 save 回写成「幽灵会话」，
   * 比不删更让人困惑。
   */
  function deleteAgentSession(targetId) {
    const id = targetId || agent.sessionId;
    if (!id || !guardAgentSwitch() || !agent.runtime) return;

    const entry = agent.sessions.find((s) => s.id === id);
    const title =
      (entry && entry.title) || t('workflow.agent.session.untitled');

    dialog.confirm({
      title: t('workflow.agent.session.deleteConfirmTitle'),
      body: t('workflow.agent.session.deleteConfirmBody', { title }),
      okText: t('common.delete'),
      okVariant: 'danger',
      async: true,
      onConfirm: async () => {
        if (agent.busy) return false;
        if (!agent.sessions.some((s) => s.id === id)) return false;

        await agent.runtime.deleteSession(id);
        // 只有删掉的正是当前会话才回到新会话状态；删的是别的会话，当前上下文要留着
        if (agent.sessionId === id) {
          agent.sessionId = null;
          agent.events = [];
          agent.usage = null;
        }
        await refreshAgentSessions();

        return true;
      },
    });
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

  /**
   * 用户点停止：只发中止信号，收尾由 loop 以 DONE(aborted) 完成。
   * 中止同时作废会话授权（技术方案 §8.2：abort 即失效）。
   */
  function abort() {
    if (agent.runtime) agent.runtime.abort();
    sessionAuth.invalidate();
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
      // 宿主侧兜的错也走同一份形状（T-40）：这里原先是裸写的
      // { kind: 'agent:error', message }，绕过了 AGENT_EVENTS 常量表。
      const isConfig = !!err && err.kind === 'config';
      agent.events.push(
        errorEvent({
          message: isConfig
            ? t('workflow.agent.notConfigured')
            : (err && err.message) || String(err),
          errorKind: isConfig ? ERROR_KIND.CONFIG : undefined,
        })
      );
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

    // markRaw：runtime 是满是闭包/getter 的对象，塞进 reactive 会被深层代理
    // —— 方法碰巧不被包装才没炸（T-90）。零成本保险。
    agent.runtime = markRaw(
      createAgentRuntime({
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
      })
    );

    // 打开最近的一个会话（没有就是新会话，首轮 send 后才落盘）
    await refreshAgentSessions();
    const [latest] = agent.sessions;
    if (latest) await openAgentSession(latest.id);
  }

  onBeforeUnmount(() => {
    // 宿主没了但 loop 还在 await 确认门 → 那个工具调用永远悬着，这一轮的会话也再
    // 不会保存。必须显式放行（否），让 loop 拿 error 观察值收尾。
    // 会话级授权随闭包一起消失，不用另置 false（技术方案 §8.2：面板卸载即失效）。
    if (agent.pendingConfirm) agent.pendingConfirm.resolve(false);
  });

  return Object.assign(agent, {
    init,
    send,
    abort,
    pickTab: onPickTab,
    answerConfirm,
    // 面板的标签页选择数据源（T-90：从两宿主各自的直连 import 收归 seam）
    listTabs,
    noTarget: () => toast.error(t('workflow.agent.noTarget')),
    goToSettings: goToAgentSettings,
    openSession: openAgentSession,
    newSession: newAgentSession,
    deleteSession: deleteAgentSession,
  });
}
