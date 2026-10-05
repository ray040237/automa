/**
 * Agent 主循环 —— 基于 pi-agent-core（迁移中，票 01~08，见 docs/agent-core-migration-spec.md）。
 *
 * 不变式（方案 G5）：本文件与 tools/* 只能 import src/agent 下的纯模块，
 * 一律通过 deps 拿浏览器能力；不碰 webextension-polyfill、不碰 @/ 别名，
 * 更不能碰 workflowStore.update / saveWorkflow / registerWorkflowTrigger ——
 * agent 可以改画布，但永远不能落盘保存。
 *
 * 三层东西不要混：
 *   provider 事件 —— pi-ai 产出的流内部事件，只在 streamFn 与本文件之间流动；
 *   agent 事件    —— {kind:'agent:*'} 事件，既给 UI 消费，也是唯一的记账；
 *   transcript    —— pi 的对话状态，由 pi 持有；我们不own 一份。
 * 本文件只维护一份事件历史（history），UI 从它派生，不重复记账。
 *
 * ── 迁移期状态 ────────────────────────────────────────────────
 * 票 01：pi 运行时骨架，纯文本路径已通；工具/确认门/插话路径尚未接线，
 * 相应断言在 loop.test.js 里标skip 等后续票。**这个文件处于中间态。**
 */

import { buildSystemPrompt } from './prompt';
import {
  AGENT_EVENTS,
  ERROR_KIND,
  TOOL_STATUS,
  errorEvent,
  toolError,
} from './events';
import { noopLog } from './log';

/** 一轮里最多来回多少次工具调用，防止模型卡在工具循环里。 */
export const MAX_STEPS = 12;

/**
 * pi 的事件 -> 我们的 agent 事件。
 *
 * 这是**唯一**的翻译层（迁移前是 toAgentEvent，provider 层消失后本函数取而代之）。
 *
 * 规则：**映射不了必须抛错，不允许静默丢弃**。返回 null 表示
 * 「这条事件不需要对外发」（例如 pi 内部的状态事件）。
 *
 * @param {{type: string}} event pi 的 AgentEvent
 * @returns {{kind: string}|{emitsNothing: true}|null}
 */
export function fromPiEvent(event) {
  switch (event.type) {
    case 'message_start':
      return { emitsNothing: true };

    case 'message_update': {
      const inner = event.assistantMessageEvent;
      if (!inner) return { emitsNothing: true };

      // 文本增量：UI 要的是逐字增量，不是累积全文
      if (inner.type === 'text_delta') {
        return { kind: AGENT_EVENTS.TEXT_DELTA, text: inner.delta };
      }
      // 思考增量
      if (inner.type === 'thinking_delta') {
        return { kind: AGENT_EVENTS.THINKING, text: inner.delta };
      }
      return { emitsNothing: true };
    }

    case 'message_end': {
      const { message } = event;
      // pi 为 user 消息也发一对 message_start/message_end（实测），
      // 不按 role 过滤的话 UI 会把用户自己说的话显示成助手发言。
      if (!message || message.role !== 'assistant')
        return { emitsNothing: true };

      // 错误：pi 把失败编码成 assistant 消息的 errorMessage + stopReason。
      // 中止（aborted）不是错误 —— 用户点停止走正常收尾（技术方案 §5.4）。
      if (message.stopReason === 'error') {
        return errorEvent({
          message: message.errorMessage || '未知错误',
          errorKind: ERROR_KIND.PROVIDER,
        });
      }
      if (message.stopReason === 'aborted') return { emitsNothing: true };

      // 工具调用在 message_end 时才拿到完整参数（票 02 才有工具可执行，
      // 现在只发事件让 UI 显示「模型要调什么」）
      const calls = (message.content || []).filter(
        (c) => c.type === 'toolCall'
      );
      if (calls.length > 0) {
        return {
          kind: AGENT_EVENTS.TOOL_CALL,
          name: calls[0].name,
          args: calls[0].arguments,
          toolCallId: calls[0].id,
          calls: calls.map((c) => ({
            name: c.name,
            args: c.arguments,
            toolCallId: c.id,
          })),
        };
      }

      return { emitsNothing: true };
    }

    case 'tool_execution_start':
      return {
        kind: AGENT_EVENTS.TOOL_RESULT,
        toolCallId: event.toolCallId,
        name: event.toolName,
        status: TOOL_STATUS.RUNNING,
        observation: '',
        pending: true,
      };

    case 'tool_execution_end':
      // 票 02/03 会改成真正带观察值的结果；现在先发一个占位，
      // 保证 UI 有「工具结束了」的信号（票 04 要靠 end.isError 判定是否真执行）
      return {
        kind: AGENT_EVENTS.TOOL_RESULT,
        toolCallId: event.toolCallId,
        name: event.toolName,
        status: event.isError ? TOOL_STATUS.ERROR : TOOL_STATUS.OK,
        observation: '',
        details: event.result,
      };

    case 'agent_start':
    case 'turn_start':
    case 'turn_end':
    case 'agent_end':
    case 'tool_execution_update':
      return { emitsNothing: true };

    default:
      // 未知事件类型 = pi 出了我们没预料到的东西。抛出来，别吞。
      throw new Error(
        `fromPiEvent: 未映射的 pi 事件类型 "${event.type}"。` +
          '新事件必须显式处理，否则 UI 会静默少显示东西。'
      );
  }
}

/**
 * 创建 agent 主循环。
 *
 * @param {Object} deps
 * @param {Function=} deps.streamFn pi 的StreamFn 契约：(model, context, options) =>流
 * @param {Object=} deps.model pi 的 Model 对象
 * @param {() => Object=} deps.promptFacts
 * @param {Array<Object>=} deps.tools 票 02 才真正注册给pi
 * @param {Function=} deps.wrapUntrusted 缺省**不提供** —— 见 migration ADR：
 *   缺注入必须抛错而不是静默用一个不逃逸的版本（T-55）。
 * @param {Function=} deps.buildUserMessage
 * @param {Function=} deps.requestConfirmation 票 04 才接线
 * @param {Object=} deps.toolCtx 票 02 才接线
 * @param {Function=} deps.preStepNotice 票 06 才接线
 * @param {Function=} deps.drainInstructions 票 06 才接线
 * @param {string=} deps.systemPromptOverride
 * @param {Object=} deps.log 全链路日志（log.js）
 */
export function createAgent(deps) {
  const {
    streamFn,
    model,
    promptFacts = () => ({}),
    // 下面这些是后续票的接线点，票 01 只声明不消费 ——
    // 提前消费会让人以为工具路径已经通了（而它并没有）。
    // eslint-disable-next-line no-unused-vars
    tools = [],
    // wrapUntrusted 由装配层注入（import 自 untrusted.js）。
    // 迁移期若未注入，工具路径会因缺它而抛错 —— 这正是想要的行为（见 T-55）。
    wrapUntrusted,
    buildUserMessage = ({ userText }) => userText,
    // eslint-disable-next-line no-unused-vars
    requestConfirmation = async () => ({ approved: false }),
    // eslint-disable-next-line no-unused-vars
    toolCtx = {},
    // eslint-disable-next-line no-unused-vars
    preStepNotice,
    // eslint-disable-next-line no-unused-vars
    drainInstructions,
    systemPromptOverride,
    log = noopLog,
  } = deps;

  if (!streamFn) {
    throw new Error(
      'createAgent: 缺streamFn。迁移后provider 层由 pi 提供，' +
        'streamFn 是唯一必需的依赖（不再是可选的 streamChat）。'
    );
  }
  if (!model) {
    throw new Error(
      'createAgent: 缺 model。pi 的模型对象由装配层从config 构造。'
    );
  }

  // pi Agent 实例：每个 createAgent 一个，跨轮复用（它持有对话状态）
  let piAgent = null;
  let piMessages = [];

  /** 事件历史：UI 的唯一消费来源，也是唯一的记账 */
  let history = [];
  /** 本轮中止控制器 */
  let controller = null;

  const record = (ev) => {
    history.push(ev);
  };

  /** 本轮的事件回调。pi 的 subscribe 在Agent 构造时绑定，所以用闭包变量传。 */
  let currentEmit = null;

  function handlePiEvent(event) {
    let mapped;
    try {
      mapped = fromPiEvent(event);
    } catch (err) {
      // 映射失败是「pi 出了我们没预料到的东西」。记成internal 错误继续跑，
      // 但绝不能静默丢 —— 否则 UI 会少显示东西而没人知道。
      const ev = errorEvent({
        message: toolError(err).message,
        errorKind: ERROR_KIND.INTERNAL,
      });
      record(ev);
      if (currentEmit) currentEmit(ev);
      return;
    }
    if (!mapped || mapped.emitsNothing) return;
    record(mapped);
    if (currentEmit) currentEmit(mapped);
  }

  async function ensurePiAgent(systemPrompt) {
    if (piAgent) return piAgent;
    const { Agent } = await import('@earendil-works/pi-agent-core');
    piAgent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: [],
      },
      streamFn,
    });
    piAgent.subscribe(handlePiEvent);
    return piAgent;
  }

  return {
    /**
     * 发一轮对话。
     *
     * @param {{userText: string, system?: string, targetTab?: Object,
     *          workflowContext?: string, onEvent?: Function,
     *          initialHistory?: Array<Object>=}} params
     */
    async send(params) {
      const { userText, targetTab, workflowContext, onEvent } = params;
      currentEmit = onEvent || null;
      controller = new AbortController();

      // 事实表构建失败不能杀掉整轮 —— 降级成空事实继续对话。
      // 这条现状行为不能因换内核而丢。
      let facts = {};
      try {
        facts = promptFacts() || {};
      } catch (err) {
        const ev = errorEvent({
          message:
            '提示词事实表构建失败，本次按空表继续：' + toolError(err).message,
          errorKind: ERROR_KIND.INTERNAL,
        });
        record(ev);
        if (currentEmit) currentEmit(ev);
      }

      const system =
        params.system || systemPromptOverride || buildSystemPrompt(facts);

      // 跨轮续接：历史重置为调用方给的上轮历史
      history = [...(params.initialHistory || [])];

      const startEv = { kind: AGENT_EVENTS.START };
      record(startEv);
      if (currentEmit) currentEmit(startEv);

      const userEv = {
        kind: AGENT_EVENTS.USER_MESSAGE,
        text: userText,
        wire: buildUserMessage(
          { userText, targetTab, workflowContext },
          wrapUntrusted
        ),
      };
      record(userEv);
      if (currentEmit) currentEmit(userEv);

      if (targetTab) {
        const tabEv = { kind: AGENT_EVENTS.TARGET_TAB, tab: targetTab };
        record(tabEv);
        if (currentEmit) currentEmit(tabEv);
      }

      const agent = await ensurePiAgent(system);
      // 续接：把上轮的 pi 消息灌回去（票 07 负责真正的历史对接）
      if (params.initialHistory && params.initialHistory.length > 0) {
        piMessages = params.initialHistory
          .filter((ev) => ev.piMessage)
          .map((ev) => ev.piMessage);
        if (piMessages.length > 0) agent.state.messages = piMessages;
      }

      let stopped = false;
      const usage = { input: 0, output: 0 };
      /** 本轮的错误事件（若有）。pi 把失败编码成 assistant 消息的 stopReason，
       *  由映射层转成 ERROR 事件并记在这里 —— 出错收尾不发 DONE（现状契约）。 */
      let errorEv = null;

      try {
        await agent.prompt(userText);
        stopped = true;
        // 用量取**最后一条 assistant 消息**，不是最后一条消息 ——
        // pi 会为 user 消息也发 message_end，transcript 末条不一定是 assistant。
        for (let i = agent.state.messages.length - 1; i >= 0; i -= 1) {
          const m = agent.state.messages[i];
          if (m.role === 'assistant' && m.usage) {
            usage.input = m.usage.input || 0;
            usage.output = m.usage.output || 0;
            break;
          }
        }
      } catch (err) {
        // 中止不是错误（技术方案 §5.4）：用户点停止后走正常收尾。
        if (!controller.signal.aborted) {
          errorEv = errorEvent({
            message: toolError(err).message,
            errorKind: ERROR_KIND.INTERNAL,
          });
          record(errorEv);
          if (currentEmit) currentEmit(errorEv);
        }
      }

      // 映射层已经为 pi 的错误产出了 ERROR 事件，这里不再发 DONE ——
      // UI 靠「有没有 DONE」区分正常收尾与出错收尾。
      errorEv =
        errorEv || history.find((e) => e.kind === AGENT_EVENTS.ERROR) || null;
      if (errorEv) {
        stopped = false;
        log.error('turn.error', {
          kind: errorEv.errorKind,
          message: errorEv.message,
        });
        return errorEv;
      }

      // pi 侧的对话状态留给下一轮 / 票 07 的历史对接
      piMessages = agent.state.messages.slice();

      const doneEv = {
        kind: AGENT_EVENTS.DONE,
        stopped,
        aborted: controller.signal.aborted,
        usage,
      };
      log('turn.end', { stopped, aborted: controller.signal.aborted, usage });
      if (currentEmit) currentEmit(doneEv);
      return doneEv;
    },

    /** 中断当前这轮。 */
    abort() {
      if (controller) controller.abort();
      if (piAgent) piAgent.abort();
    },

    /** 读回本轮的事件历史（runtime 在 send 收尾时落盘）。 */
    getHistory() {
      return history;
    },
  };
}
