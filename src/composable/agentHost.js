/**
 * 助手宿主共用接线。
 *
 * 三个宿主（浏览器侧栏 / Firefox 主面板助手页 / 工作流编辑器侧栏）面对的是
 * 同一个 runtime 契约（src/agent/index.js 的 createAgentRuntime）和同一块
 * 面板（AgentPanel.vue，收单个 :host 对象 —— T-90）。
 *
 * **两层结构（T-227）**：
 *   - `createAgentHost(deps, ui)` —— 纯接线工厂。IO（browser 与 @/agent 桶的
 *     八项）全部参数注入，UI 侧能力（t / toast / dialog / routerPush）作为
 *     回调传入；工厂自身不 import browser 与 @/agent 桶，node --test 传全套
 *     fake 直接覆盖它（agentHost.test.js）。守卫顺序、监听对称、会话切换、
 *     确认门失效点全在这层。
 *   - `useAgentHost(deps)` —— 薄壳，**生产装配点**。在组件 setup 里取 Vue
 *     上下文（useI18n/useToast/useRouter/useDialog）、补生产 IO 缺省、递给
 *     工厂并挂 dispose。缺省必须有人补（T-228）：工厂只认注入，测试传 fake，
 *     而三个生产宿主谁都不传 —— 没有这层兜底，deps.browser 是 undefined，
 *     setup 里当场抛「Cannot read properties of undefined (reading 'tabs')」。
 *     宿主传入的项覆盖缺省（保持注入测试口）。
 *     Vue 本身不是 seam 的主题，不做替身、不建组件测试基建。
 *   - `usePageAgentHost({ layout, onOpenSettings? })` —— 「全局会话、无画布、
 *     面向当前网页」宿主的唯一 profile（原先两个入口逐字复制的那 4 行）。
 *
 * 三个陷阱，改这里之前先读：
 *
 * 1. agent 必须是 reactive 而不是 shallowReactive —— events 是靠 push 增长的，
 *    浅响应下数组内新增不会触发渲染，transcript 会「发了消息但屏幕不动」。
 * 2. 卸载前必须把挂着的确认门放行（否）：loop 那侧一直在 await 这个 promise，
 *    宿主没了它永远不会结束（CONTEXT.md「确认门」条）。走 `dismissPendingConfirm`
 *    单一出口（T-227），三个失效点共用。
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
  loadConfigDoc,
  resolveTarget,
  saveConfig,
  sessionStore,
} from '@/agent';
import { buildConfirmation, createSessionAuth } from '@/agent/confirm';
import { targetFollowPlan, targetHealth } from '@/agent/tab';
import { AGENT_EVENTS, ERROR_KIND, errorEvent } from '@/agent/events';
import { getActiveInstructionsFrom } from '@/agent/customizations';
import { capabilityGroups } from '@/agent/examples';
import { getSkillIndexFrom } from '@/agent/skills';

/**
 * 纯接线工厂（T-227）：全部宿主接线逻辑，IO 与 UI 能力都走参数。
 *
 * @param {Object} deps
 * @param {Array<string>|(() => Array<string>)} deps.enabledGroups 该宿主开放的工具组；
 *   传函数时 runtime 每次 send 求值（T-135：响应式权限不被冻结）
 * @param {() => (string|null)} deps.getWorkflowId 会话归属的工作流 id；独立页恒为 null。
 *   会话**写入**（turnRecord 的 workflowId）与**列表过滤**（listIndex）都用它 ——
 *   一个事实来源，填岔了「存到 A 列表在 B 找」的静默错乱在结构上不可能（T-224）。
 * @param {Object=} deps.canvas 画布句柄，给了并且工具组里有 canvas，助手才能改画布
 * @param {Object} deps.canvas.blocks getBlocks() 的结果
 * @param {() => Object} deps.canvas.getEditor vue-flow 实例（ref，$ 晚于 runtime 就绪）
 * @param {() => string} deps.canvas.newId 节点 id 生成器
 * @param {() => void} deps.canvas.onCanvasChanged 只准标脏，绝不准落盘
 * @param {Object} deps.browser webextension-polyfill（注入，node --test 传 fake）
 * @param {Object} deps.configIO
 * @param {Object} deps.sessionStore
 * @param {Function} deps.listTabs
 * @param {Function} deps.resolveTarget
 * @param {Function} deps.loadConfig
 * @param {Function} deps.loadConfigDoc
 * @param {Function} deps.saveConfig
 * @param {Function} deps.createAgentRuntime
 * @param {Object} ui Vue 侧能力的回调形态（薄壳负责从 setup 里取）
 * @param {(key: string, params?: Object) => string} ui.t
 * @param {{success: Function, error: Function}} ui.toast
 * @param {{confirm: Function}} ui.dialog
 * @param {(loc: Object) => Promise} ui.routerPush
 * @returns {Object} 面板直接绑在这个对象上；自带 dispose()（卸载钩子，T-227）
 */
export function createAgentHost(deps, ui) {
  const { t, toast, dialog, routerPush } = ui;

  // T-84：装配期必填校验。漏传 enabledGroups 会被 runtime 按「未过滤」处理
  // （canvas 组泄露给无画布宿主，T-45 同款事故）；漏传 getWorkflowId 会让
  // 会话归属静默落成全局列表，按工作流过滤的宿主永远看不到自己的历史。
  if (
    !Array.isArray(deps.enabledGroups) &&
    typeof deps.enabledGroups !== 'function'
  ) {
    throw new Error(
      'useAgentHost: deps.enabledGroups 必填（数组或 () => 数组，' +
        '后者供响应式权限用，见 T-135）。'
    );
  }
  if (typeof deps.getWorkflowId !== 'function') {
    throw new Error(
      'useAgentHost: deps.getWorkflowId 必填（() => workflowId 或 ' +
        '() => null）——缺了会话归属静默变全局，编辑器侧看不到自己的历史。'
    );
  }
  // T-50：getVariables 同样必填。漏传时 runtime 曾有个 `async () => ({})` 兜底，
  // 于是任何漏注入的宿主都拿到「变量为空」—— 模型据此写模板引用必然引用到
  // 不存在的变量名，而且没有任何报错。**没有工作流可读**的宿主要显式传
  // `async () => ({ bound: false })`，那是与「空」不同的结论。
  if (typeof deps.getVariables !== 'function') {
    throw new Error(
      'useAgentHost: deps.getVariables 必填（() => Promise<{bound, variables, globals}>）' +
        '——缺了 get_variables 永远返回「（空）」，模型会据此编出不存在的变量名。' +
        '没有工作流可读时传 async () => ({ bound: false })。'
    );
  }
  // getWorkflowContext 可选：没有工作流上下文的宿主不传即可（返回 null）。
  if (
    deps.getWorkflowContext !== undefined &&
    typeof deps.getWorkflowContext !== 'function'
  ) {
    throw new Error(
      'useAgentHost: deps.getWorkflowContext 若传必须是函数（() => 摘要字符串 | null）'
    );
  }

  const agent = reactive({
    events: [],
    config: {},
    /**
     * T-201/T-213：模型选择器要枚举「有哪些连接、各自的模型」，而
     * `config`（= resolveActiveConfig）只暴露**当前生效**的那一条
     * （provider id + model id），拿不到候选列表 —— 那份数据在存储的 doc 上
     * （`providers[].models`）。
     *
     * 这里另开一格存**脱敏后的 doc**（loadConfigDoc：apiKey 清空、密文挪到
     * encryptedKey），绝不能让明文密钥进响应式对象 —— 它会被挂到组件实例上、
     * 出现在 Vue devtools 里、也可能被某个 v-bind 带进 DOM。
     * 只有 `providers[].models` 这一段是选择器要用的。
     */
    modelCatalog: [],
    targetTab: null,
    // T-08：目标页的健康状态与来源。targetState 取值见 targetHealth()：
    //   'ok' 正常 / 'closed' 页被关掉 / 'drift' 同一个 tab 跳到了别的 origin / 'none' 还没有目标页
    // targetPinned 表示这一页是**用户手选固定**的（false = 运行时自动解析出来的）。
    targetState: 'none',
    targetPinned: false,
    /**
     * T-169：宿主形态。'narrow'（320px 侧栏，历史走**视图切换**）｜
     * 'wide'（独立助手页，历史是**左栏常驻**）。
     *
     * 必须由宿主声明，**不许用窗口宽度断点判**：侧栏能拖宽（`[id].vue:431`
     * 下限 360、只能拖宽），独立助手页的窗口也能拖很窄 —— 面板宽度取决于宿主，
     * 不取决于视口。写 `md:` 断点会在「拖宽的侧栏」上错误地切成左栏布局。
     */
    layout: deps.layout === 'wide' ? 'wide' : 'narrow',
    /* T-213：删掉 T-212 的 host.shell。
       它当初的作用是让面板根在侧栏宿主下改用 bg-shell、与 chrome 同色。
       实测下来这个"续成一整块"的收益不抵代价：面板底色家族被劈成两套，
       顶栏降层之后又多出一层过渡。现在面板根统一 bg-canvas，由 :root.dark
       接管暗色，宿主不必再声明底色分档。 */
    busy: false,
    runtime: null,
    sessions: [],
    sessionId: null,
    usage: null,
    pendingConfirm: null,
    // T-12：已入队但还没送达模型的插话条数。面板常驻显示它 —— 原来唯一的确认
    // 是事件流里一条「已排队」的 notice，点完插话输入框就空了，用户会怀疑
    // 消息丢了。值每次入队后、以及每个事件到达时从运行时重新读（队列在
    // loop 的每步开工处被排空，面板收不到「排空了」这个信号，见 syncPending）。
    pendingInterjections: 0,
    // T-10：宿主开放的工具组徽标。**直接从 deps.enabledGroups 推导**，
    // 不让各宿主自己写一份清单 —— 写死的清单迟早与真实开放项对不上，
    // 而「面板说有画布、其实没有」比不说更糟。与 runtime 同一份值：
    // 传函数时每次求值，团队权限变化下一轮生效（T-135）。
    groups: capabilityGroups(deps.enabledGroups),
  });

  /**
   * 目标页「三件套」的唯一写入点（T-195~T-198）。
   *
   * 面板上那个目标页 chip 只是这套状态的显示器：`targetTab`（指向哪一页）、
   * `targetPinned`（固定来源 / 自动解析）、`targetState`（ok/closed/drift/none）。
   * 以前六个入口（init / pickTab / unpinTab / target-tab 事件 / openSession /
   * newSession）各自零散地改其中一两个字段，其余留着旧值，于是 chip 与 runtime
   * 经常各说各话。现在一律走这里，一次写全。
   *
   * 定义在 markTargetHealth 之前是有意的：下面那个监听函数要用它，而本文件
   * 的 lint 规则不允许「先用后定义」。
   *
   * @param {Object|null} tab 目标页快照
   * @param {{pinned?: boolean, state?: string}=} opts
   */
  function syncTarget(tab, { pinned = false, state } = {}) {
    agent.targetTab = tab || null;
    agent.targetPinned = Boolean(pinned);
    agent.targetState = state || (tab ? 'ok' : 'none');
  }

  /**
   * 目标页失效的监听（T-08）。
   *
   * 运行时每步开工前的 preStepNotice 已经判过「tab 没了 / origin 漂了」，但它的
   * 结果只作为 system-notice 发给模型（index.js:511），面板这边看不到 —— 于是头
   * 那一行一直显示着旧标题旧 URL，用户以为助手还在看原页面。
   *
   * 这里在**页面侧**自己判，不新增事件种类、不动事件历史（AGENTS.md 的 seam 约束）：
   * 面板本来就有 browser.tabs 全权（listTabs 就是这么来的），onRemoved / onUpdated
   * 是这两条事实的自然来源。判定逻辑放在 tab.js 的 targetHealth()，纯函数有单测。
   *
   * 只标记状态，不自动换页 —— 目标页是「这一轮结论的前提」，悄悄换成另一个页
   * 比明着报警更糟（CONTEXT.md「pin」条：origin 才是真身份）。
   */
  function markTargetHealth(liveTab) {
    // 只改健康状态这一路（不换页、不动 pinned）：仍走 syncTarget 这个唯一写入点，
    // 把当前 pinned 原样带过去，避免出现第二处直接改 targetState 的写法。
    syncTarget(agent.targetTab, {
      pinned: agent.targetPinned,
      state: targetHealth(liveTab, agent.targetTab),
    });
  }

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

  /**
   * 确认门的「必须放行（否）」单一出口（T-227）。
   *
   * CONTEXT.md「确认门」条：卡片变得不可达就必须 resolve(false)，三个失效点
   * ——切会话（guardAgentSwitch）、宿主卸载（dispose）、面板自身被卸载
   * （AgentPanel.vue 的 onBeforeUnmount，三处 v-if 真卸载）——原先各手抄一份
   * 判空 + resolve(false)，靠注释「写成同一形状」维持。现在都走这里；
   * 内部经 answerConfirm（判空安全），重复发也无害。
   */
  function dismissPendingConfirm() {
    answerConfirm(false);
  }

  /** 刷新会话列表：按 deps.getWorkflowId() 过滤（与写入侧同一个事实来源，T-224）。 */
  async function refreshAgentSessions() {
    agent.sessions = await deps.sessionStore.listIndex(deps.getWorkflowId());
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

    // 判的是 reactive 上的 pendingConfirm，不是 plan.rejectPending —— 后者判的
    // 是状态机内部的 pending，两个字段目前同生同灭但没有代码保证（T-191）。
    // 放行走 dismissPendingConfirm 单一出口（T-227），与两个卸载路径同一形状。
    dismissPendingConfirm();
    sessionAuth.invalidate();
    return true;
  }

  /**
   * 回到自动跟随：按降级链重新解析一次目标页，并把结果**同时**写进 runtime 与面板
   * （T-195 / T-198）。
   *
   * 为什么必须回写 runtime：工具执行读的是 runtime 闭包里的 `targetTab`
   * （index.js 的 `get targetTab()`），只改面板会让 chip 显示新页、模型仍操作旧页。
   * 用 `setTargetTab`（只改当前目标、不重新 addPin）而不是 `pickTab` ——
   * 「回到自动跟随」的语义就是没有 pin 参与解析，语义见 index.js 的 unpinTab。
   *
   * 取不到窗口就退化（与 init / 历史行为一致），不因此让调用失败。
   *
   * @returns {Promise<Object|null>} 新解析出的目标页
   */
  async function resetTargetToAuto() {
    let windowId;
    try {
      const currentWindow = await deps.browser.windows.getCurrent();
      windowId = currentWindow ? currentWindow.id : undefined;
    } catch (err) {
      windowId = undefined;
    }

    const next = await deps.resolveTarget({ windowId });
    if (agent.runtime) agent.runtime.setTargetTab(next);
    syncTarget(next, { pinned: false, state: next ? 'ok' : 'none' });

    return next;
  }

  /**
   * 三个标签页事件监听（T-08 健康 + T-215 跟随）。
   *
   * T-215 之前只有 removed / updated 两条、且都只判健康 —— 用户切换标签页时
   * 没有任何监听者在听，「跟随态」实际是「解除那一刻的页面快照」（用户实测
   * 「切换到跟随态但是实际上无法跟随」）。现在三个事件统一问
   * `targetFollowPlan`（tab.js 纯函数，有单测）拿动作：
   *   'skip'      → 什么都不做
   *   'reresolve' → resetTargetToAuto()：重解析 + 回写 runtime + syncTarget
   *   'health'    → markTargetHealth()：只判 closed / drift
   *
   * 定义在 resetTargetToAuto 之后是本文件 lint 规则（no-use-before-define）
   * 的要求 —— 见 syncTarget 注释同款约束。
   *
   * 重解析是异步的，监听器本身保持同步 —— fire 后挂 .catch 兜底（tabs 查询
   * 失败时跟随静默失败一拍，下一事件还会再来；不能让扩展后台报未捕获拒绝）。
   */
  const followOrHealth = (plan) => {
    if (plan === 'reresolve') {
      resetTargetToAuto().catch(() => {});
      return true;
    }
    return false;
  };

  const onTabRemoved = (tabId) => {
    if (!agent.targetTab || tabId !== agent.targetTab.id) return;
    const plan = targetFollowPlan({
      pinned: agent.targetPinned,
      event: 'removed',
    });
    if (followOrHealth(plan)) return;
    markTargetHealth(null);
  };

  const onTabActivated = ({ tabId } = {}) => {
    const plan = targetFollowPlan({
      pinned: agent.targetPinned,
      targetTabId: agent.targetTab && agent.targetTab.id,
      event: 'activated',
      eventTabId: tabId,
    });
    followOrHealth(plan);
  };

  const onTabUpdated = (tabId, changeInfo, tab) => {
    if (!agent.targetTab || tabId !== agent.targetTab.id) return;
    // changeInfo 多数时候只有 favIconUrl / title；url 变了才算导航，交给
    // targetFollowPlan 分流（自动态：页签内导航 = 跟随的一部分 → 重解析；
    // 固定态：照旧 markTargetHealth 判 drift）。
    if (!tab && !changeInfo) return;
    const plan = targetFollowPlan({
      pinned: agent.targetPinned,
      targetTabId: agent.targetTab.id,
      event: 'updated',
      urlChanged: Boolean(changeInfo && changeInfo.url),
    });
    if (followOrHealth(plan)) return;
    markTargetHealth(tab || null);
  };

  deps.browser.tabs.onRemoved.addListener(onTabRemoved);
  deps.browser.tabs.onUpdated.addListener(onTabUpdated);
  deps.browser.tabs.onActivated.addListener(onTabActivated);

  async function openAgentSession(id) {
    // id 为空是下拉里的占位项，不是一次切换 —— 交给它会把 runtime 的
    // 会话 id 置空但不清 pins/插话队列，落到一个不新不旧的状态。
    if (!id || !guardAgentSwitch() || !agent.runtime) return;

    const { events, targetTab, targetPinned, targetState, usage } =
      await agent.runtime.openSession(id);
    agent.sessionId = id;
    agent.events = events || [];
    agent.usage = usage || null;
    // T-196 / T-197：runtime 一次性给全三件套（pinned 来源 + 健康状态）。
    if (targetTab) {
      syncTarget(targetTab, { pinned: targetPinned, state: targetState });
    } else {
      // 这条会话没有 pin：保留当前自动解析出的页，但把来源明确成「自动」，
      // 避免沿用上一个会话的 pinned 徽标。
      syncTarget(agent.targetTab, { pinned: false });
    }
  }

  async function newAgentSession() {
    if (!guardAgentSwitch() || !agent.runtime) return;

    agent.runtime.newSession();
    agent.sessionId = null;
    agent.events = [];
    agent.usage = null;
    // T-195：runtime.newSession 清空了 pins，面板的目标页三件套必须跟着归零并
    // 回到自动跟随，否则 chip 还会显示旧 session 固定过的页 + 「已固定」徽标。
    await resetTargetToAuto();
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
    // 就是「以后就用这个页」的意图）、面板上显示的那一行。
    // T-08：用户手选 = 固定；新选的页此刻必然是活的（列表就是从 tabs.query 拉的）
    agent.runtime.pickTab(tab);
    syncTarget(tab, { pinned: true, state: tab ? 'ok' : 'none' });
  }

  /**
   * 取消固定目标页（T-164 / T-198）。
   *
   * 立刻按降级链重新解析一次 —— chip 不能闪成空：用户按 X 之后看到的应当是
   * 「自动 + 解析出来的那一页」，而不是先空一下再填上。重解析同时回写 runtime
   * （T-198），否则 chip 已切到新页、模型还在操作旧 pin 的页。
   * `unpinTab` 返回 false 说明本来就是自动态，这时不用（也不该）重解析：解析结果
   * 不会变，白白多一次 tabs 查询。
   */
  async function onUnpinTab() {
    if (!agent.runtime) return;
    if (!agent.runtime.unpinTab()) return;

    await resetTargetToAuto();

    // T-214：解除后 chip 从实底退成轻底 —— 一句话确认"没有丢目标页"，
    // 只是回到了自动跟随；也防误触徽标后不知所措（设计稿 §7 拍板项）。
    toast.success(t('workflow.agent.pickTab.unpinToast'));
  }

  /**
   * 换模型 / 换连接（T-201 / T-213）。
   *
   * **生效时机是「下一轮」**，这不是实现偷懒，是结构上的必然：
   * runtime 的 send() 每次都现读 `getConfig()`（index.js:488），当前这一轮
   * 早就拿着旧 config 在跑了。所以写盘之后不必重启任何东西 —— 下一轮自然读新的。
   * 弹层底部那句「换模型后从下一轮开始生效，当前会话不重放」正是照实说。
   *
   * 走 saveConfig（而不是直接写存储）是为了复用它的校验：activeModelId 必须
   * 真的在那个 provider 的 models 列表里，否则 resolveActiveConfig 会在
   * `!model` 时整份退回 DEFAULT_CONFIG，用户看到的就成了「请先配置 API Key」——
   * 一个指不到真因的错误。校验失败就把 errors 抛出来，别静默。
   */
  async function onSetModel({ providerId, modelId }) {
    if (agent.busy) return;
    if (!providerId || !modelId) return;

    const doc = await deps.loadConfigDoc(deps.configIO);
    const result = await deps.saveConfig(deps.configIO, {
      ...doc,
      activeProviderId: providerId,
      activeModelId: modelId,
    });

    if (!result.ok) {
      toast.error(t('workflow.agent.model.switchFailed'));
      return;
    }

    // 面板上那两处（模型芯片、上下文窗口）都要跟着变。
    // resolveActiveConfig 会顺带把新模型的 contextWindow 解出来 —— 所以
    // config 整体重读一次，不必自己拼。
    agent.config = await deps.loadConfig(deps.configIO);
  }

  /**
   * 「去配置 API Key」的落点（T-199 / T-219）。
   *
   * 默认走主面板路由 —— 编辑器侧栏宿主就在 newtab 里，`router.push` 是自然的。
   * 但**浏览器侧边栏宿主不在 newtab 里、没有 router**：它的设置页在另一个页面
   * （`newtab.html#/agent`），必须由宿主自己决定怎么过去（开 dashboard）。
   * 所以做成可注入：`deps.onOpenSettings` 给了就用它，没给才退回 router。
   *
   * T-219：路由是 `/agent` 而不是 `/settings/agent` —— `router.js:120-127` 把
   * `/settings` 的子路由写成了**绝对路径**（`{ path: '/agent' }` 等），Vue Router 4
   * 把以 `/` 开头的子路径当根路径，所以真实 URL 是 `/agent`（`Settings.vue:52`
   * 的菜单项也用它）。早先这里写 `/settings/agent`，实测 `router.resolve` 匹配
   * 0 条 → 落到空白页。
   */
  async function goToAgentSettings() {
    if (typeof deps.onOpenSettings === 'function') {
      await deps.onOpenSettings();

      return;
    }

    routerPush({ path: '/agent' });
  }

  /**
   * 用户点停止：只发中止信号，收尾由 loop 以 DONE(aborted) 完成。
   * 中止同时作废会话授权（技术方案 §8.2：abort 即失效）。
   */
  function abort() {
    if (agent.runtime) agent.runtime.abort();
    // T-12：中止后队列不该还挂着计数（轮已死，插话不会送达了）
    agent.pendingInterjections = 0;
    sessionAuth.invalidate();
  }

  /**
   * 把运行时插话队列的长度同步到面板状态（T-12）。
   *
   * 为什么每次都重新读而不是入队时 +1：队列在 `loop.js` 的每步开工处被排空，
   * 那一侧不发事件，面板没有「送达」的信号。借事件到达的时机读一次长度，
   * 是零新增事件种类就能跟上进度的办法（AGENTS.md 的 seam 约束：不新增事件种类，
   * 面板本来就有读运行时的全权）。读不到运行时（未初始化 / 已销毁）就归零。
   */
  function syncPendingInterjections() {
    const { runtime } = agent;
    agent.pendingInterjections = runtime
      ? runtime.pendingInstructionCount()
      : 0;
  }

  async function send(userText) {
    // T-67：runtime 还没建好就点发送，原来两个分支都答非所问 ——
    //   busy（插话）分支在 try 之外裸调 enqueueInstruction，TypeError 直接把
    //   整个 send 的 promise reject 掉，面板什么都收不到；
    //   非 busy 分支被 catch 包成 error 事件，文案是一句
    //   「Cannot read properties of null」。
    // 说清真实原因（助手还在初始化），而不是把内部形状漏给用户。
    // 风险窗口是真实存在的：编辑器侧惰性 init（打开侧栏才建）+ loadConfig
    // 慢，用户完全可能在这段时间里点发送。
    if (!agent.runtime) {
      agent.events.push(
        errorEvent({ message: t('workflow.agent.initializing') })
      );
      return;
    }
    // busy 时不打断任务，把输入送进插话队列，下一步开工前送达模型
    if (agent.busy) {
      const queued = agent.runtime.enqueueInstruction(userText);
      syncPendingInterjections();
      if (queued) {
        agent.events.push({
          kind: 'agent:system-notice',
          text: t('workflow.agent.queued'),
        });
      }
      return;
    }

    agent.busy = true;

    // T-50：工作流上下文每轮现取（用户可能刚改过），空则不带这一段。
    // buildUserMessage 会把它包进 untrusted_workflow_context —— 它是宿主里的
    // 只读摘要，属第三方信息。
    const workflowContext = deps.getWorkflowContext
      ? await deps.getWorkflowContext()
      : null;

    try {
      // 用户消息由 runtime 以 agent:user-message 事件入史并回显
      const result = await agent.runtime.send({
        userText,
        ...(workflowContext ? { workflowContext } : {}),
        onEvent: (ev) => {
          if (ev && ev.kind === 'agent:target-tab') {
            // T-08：只有 focus_tab 会发这个事件（index.js:500）—— 模型明确指定了
            // 这一页，等同于「以后就用它」，与用户手选同级；快照刚从 tabs.get
            // 拿到，此刻必然是活的，失效状态顺手清掉。
            syncTarget(ev.tab || agent.targetTab, { pinned: true });
            return;
          }
          if (ev) agent.events.push(ev);
          // 插话队列在 loop 的每步开工处被排空，没有「排空了」事件 —— 借每个
          // 事件到达的机会读一次长度，面板上的计数就能跟着送达走（T-12）。
          syncPendingInterjections();

          // T-11（与 B7 同一条通道）：中止回执。
          //
          // loop 收尾时 DONE 事件带着 aborted（loop.js:1037），但 done 在
          // transcript 里不渲染任何东西（`default:` 分支只丢弃、不产出内容）——
          // 于是用户点停止后只能靠「按钮不转了」猜已经停住，缺一条明说的回执。
          //
          // 插一条 system-notice，与入队提示（workflow.agent.queued）同一个做法：
          // 事件数组就是 runtime 自己的那份，所以这条会随会话一起落盘，
          // 重开会话时仍能看到「上一轮是被我停掉的」。B7 那侧（重开页面发现
          // 未收尾事件）要判的是另一个触发源，尚未实现，不在这里假装已经做了。
          if (ev && ev.kind === AGENT_EVENTS.DONE && ev.aborted) {
            agent.events.push({
              kind: AGENT_EVENTS.SYSTEM_NOTICE,
              text: t('workflow.agent.aborted'),
            });
          }
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
      // T-66：标了 specific 的配置错误自带可读文案（比如「接口地址必须以
      // http:// 开头（当前：ftp://…）」），比通用那句「请先配置 API Key」
      // 有用得多；没标的（apiKey 空）仍旧走 i18n 文案。
      const useErrMessage = isConfig && !!err.specific && err.message;
      // 三档优先级写成 if 而不是嵌套三元：
      // ① 自带具体文案（specific）② 配置错误回落到 i18n ③ 原样带出 err.message
      let message;
      if (useErrMessage) message = err.message;
      else if (isConfig) message = t('workflow.agent.notConfigured');
      else message = (err && err.message) || String(err);

      agent.events.push(
        errorEvent({
          message,
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

    agent.config = await deps.loadConfig(deps.configIO);
    // T-201/T-213：模型选择器的候选列表。**只取 provider id/label + 模型 id**
    // —— loadConfigDoc 已经把明文密钥清空，但这里再显式挑一次字段，
    // 让"密钥不进这一格"成为形状上的必然，而不是依赖上游那一次的清洗。
    try {
      const doc = await deps.loadConfigDoc(deps.configIO);
      agent.modelCatalog = (doc.providers || [])
        .filter((p) => p.id)
        .map((p) => ({
          id: p.id,
          label: p.label || p.id,
          hasKey: Boolean(p.hasKey),
          models: (p.models || []).map((m) => m.id).filter(Boolean),
        }));
    } catch (e) {
      // 读不到候选列表不该拦住面板启动：设置页能改配置，选择器退化成
      // 「只显示当前模型名、点开是空的」也不会误报 —— 但要说得出为什么。
      agent.modelCatalog = [];
      console.warn('[agent] load model catalog failed:', e);
    }

    // 没有可注入的页面就别硬撑：agent 一开就报「读到的是编辑器自己」，比晚点报错更让人困惑。
    // windowId 显式取当前窗口 —— 早先是写死的 window.id（扩展页上没有这个属性），
    // 于是「当前窗口优先」那一级永远匹配不上，退化成了全浏览器最近访问的那个页。
    // 取不到窗口就退化到原来的行为，不因此让整个 init 失败。
    //
    // T-08：resolveTargetTab 是从 tabs.query 的结果里挑的，拿到就是活的；
    // 且这一页是自动解析的（用户没选），所以 pinned=false。统一走 resetTargetToAuto
    // ——此处 runtime 还没建，函数内的 `if (agent.runtime)` 是安全的空操作，
    // 下面 createAgentRuntime 会带上刚解析出的 targetTab。
    await resetTargetToAuto();

    // markRaw：runtime 是满是闭包/getter 的对象，塞进 reactive 会被深层代理
    // —— 方法碰巧不被包装才没炸（T-90）。零成本保险。
    agent.runtime = markRaw(
      deps.createAgentRuntime({
        getConfig: () => deps.loadConfig(deps.configIO),
        // 自定义指令（T-81a）：每轮 send 由 runtime 现读，改完下一轮生效。
        // 读取失败的降级在 runtime 侧（warn + 空串），这里不重复包。
        getInstructions: () => getActiveInstructionsFrom(deps.configIO),
        // 技能索引（T-81b）：同一模式。read_skill 工具的查找走 runtime 缺省实现
        // （也读 configIO），这里不用传。
        getSkillIndex: () => getSkillIndexFrom(deps.configIO),
        targetTab: agent.targetTab,
        enabledGroups: deps.enabledGroups,
        // T-50：变量数据源由宿主注入（runtime 不再兜底成空）。
        getVariables: deps.getVariables,
        sessionStore: deps.sessionStore,
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

  /**
   * 卸载钩子（T-227 起由薄壳交给 onBeforeUnmount）。
   *
   * 宿主没了但 loop 还在 await 确认门 → 那个工具调用永远悬着，这一轮的会话
   * 也再不会保存。必须显式放行（否），让 loop 拿 error 观察值收尾 —— 走
   * dismissPendingConfirm 单一出口。会话级授权随闭包一起消失，不用另置 false
   * （技术方案 §8.2：面板卸载即失效）。
   *
   * T-08：这三个监听挂在 browser 上，不是组件上 —— 不摘就是泄漏，
   * 面板反复开关后同一个 tab 的事件会被处理多次。
   */
  function dispose() {
    dismissPendingConfirm();

    deps.browser.tabs.onRemoved.removeListener(onTabRemoved);
    deps.browser.tabs.onUpdated.removeListener(onTabUpdated);
    deps.browser.tabs.onActivated.removeListener(onTabActivated);
  }

  return Object.assign(agent, {
    init,
    send,
    abort,
    pickTab: onPickTab,
    // T-164：解除固定 —— 回到自动跟随，不是变成无目标
    unpinTab: onUnpinTab,
    answerConfirm,
    // T-227：确认门失效点的单一出口（guardAgentSwitch / dispose / 面板卸载共用）
    dismissPendingConfirm,
    // 面板的标签页选择数据源（T-90：从两宿主各自的直连 import 收归 seam）
    listTabs: deps.listTabs,
    noTarget: () => toast.error(t('workflow.agent.noTarget')),
    goToSettings: goToAgentSettings,
    openSession: openAgentSession,
    newSession: newAgentSession,
    deleteSession: deleteAgentSession,
    // T-201/T-213：换模型
    setModel: onSetModel,
    // T-227：薄壳把它挂到 onBeforeUnmount；测试直接调
    dispose,
  });
}

/**
 * 薄壳（T-227）：setup 里取 Vue 上下文，递给纯工厂并挂卸载钩子。
 * 接线逻辑一个字都不在这层 —— 那是工厂的事。
 *
 * 但**生产 IO 缺省在这层补**（T-228 回归修复）：工厂只认注入、测试传 fake，
 * 三个生产宿主谁都不传这些 deps —— 这里不兜底，deps.browser 就是 undefined，
 * 宿主 setup 里当场抛「reading 'tabs'」。展开顺序是缺省在前、...deps 在后，
 * 宿主显式传入的项照旧覆盖缺省（注入测试口不闭死）。
 */
export function useAgentHost(deps) {
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const dialog = useDialog();

  const host = createAgentHost(
    {
      browser,
      configIO,
      sessionStore,
      listTabs,
      resolveTarget,
      loadConfig,
      loadConfigDoc,
      saveConfig,
      createAgentRuntime,
      ...deps,
    },
    {
      t,
      toast,
      dialog,
      routerPush: (loc) => router.push(loc),
    }
  );

  onBeforeUnmount(host.dispose);

  return host;
}

/**
 * 「全局会话、无画布、面向当前网页」宿主的唯一 profile（T-227）。
 *
 * 侧栏（App.vue）与 Firefox 主面板助手页（Agent.vue）共用：原先同一份
 * 4 行缺省值（enabledGroups / getWorkflowId / getVariables / getWorkflowContext）
 * 在两个入口逐字复制，漏传的静默事故（T-45/T-50）各挡过一次。现在这四句
 * 只在这里说一次；宿主只声明真正属于自己的两件事 —— 形态与设置页落点。
 */
export function usePageAgentHost({ layout, onOpenSettings } = {}) {
  return useAgentHost({
    layout,
    enabledGroups: ['page', 'context', 'tab'],
    // 侧栏/助手页的会话是全局的，不绑定工作流
    getWorkflowId: () => null,
    // T-50：没有工作流可读必须显式说 bound:false —— 与「变量为空」是
    // 两个不同的结论，混了模型会凭空编变量名。
    getVariables: async () => ({ bound: false }),
    // 没有工作流就没有工作流上下文段（prompt 里那一段直接不出现）
    getWorkflowContext: () => null,
    ...(onOpenSettings ? { onOpenSettings } : {}),
  });
}
