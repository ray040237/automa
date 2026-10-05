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
  wrapObservation,
} from './events';
import { toAgentTools } from './tools/adapter';
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
    tools = [],
    // wrapUntrusted 由装配层注入（import 自 untrusted.js）。
    // 迁移期若未注入，工具路径会因缺它而抛错 —— 这正是想要的行为（见 T-55）。
    wrapUntrusted,
    buildUserMessage = ({ userText }) => userText,
    // 票 04：写类/未知工具的确认门，默认拒绝（得显式调用方放行才过）
    requestConfirmation = async () => ({ approved: false }),
    toolCtx = {},
    // 票 06：预检通知与插话队列。注入点是 transformContext（每次请求前
    // 调用，产物只用于当次请求、不写回 transcript）。
    preStepNotice,
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
  /** 本轮的请求序号，喂给 preStepNotice（它按 step 判重） */
  let stepCounter = 0;

  /**
   * 被确认门拒绝的工具调用：toolCallId -> 拒绝原因。
   *
   * 为什么需要这张表：pi 的 beforeToolCall 里返回 {block:true} 后，循环会
   * 产出一个 isError:true 的 tool_execution_end。而 UI 契约要求「用户拒绝」
   * 是独立于「工具失败」的状态（TOOL_STATUS.REJECTED）—— 同一个 isError:true
   * 无法区分两者。所以在前置钩子里记下「这是拒绝」，映射层收到对应的
   * tool_execution_end 时把状态改成 REJECTED。
   */
  const rejectedBy = new Map();

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

    // 确认门拒绝的工具调用：把pi 产出的「失败」重映射成「已拒绝」。
    // 语义不同、UI 展示不同（REJECTED 不显示成红色错误），且pi 不会告诉我们
    // 「这是用户拒的」—— 只有我们的钩子知道。
    if (
      event.type === 'tool_execution_end' &&
      rejectedBy.has(event.toolCallId)
    ) {
      const reason = rejectedBy.get(event.toolCallId);
      rejectedBy.delete(event.toolCallId);
      mapped = {
        ...mapped,
        status: TOOL_STATUS.REJECTED,
        // pi 在被拦的工具结果里已放了原因文本；我们的事件契约要求
        // observation 是包好的观察值，保持同一份内容（UI 与 history 共用）。
        observation: wrapObservation({
          status: TOOL_STATUS.REJECTED,
          message: reason || '用户拒绝了此次操作',
        }),
      };
    }

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
        // 票 02：工具经适配层注册。票 04：确认门在 beforeToolCall 接。
        tools: toAgentTools(tools, { toolCtx, wrapUntrusted }),
      },
      streamFn,
      // 票 06：预检通知与插话队列。注入点选 transformContext ——
      // pi 每次 LLM 请求前调用它，产物只用于当次请求、**不写回 transcript**。
      // 这样通知期后模型能看到，但不会进持久历史（persist 的只是用户/助手/工具消息），
      // 与现状「通知进 wire 不进 transcript」的语义一致。
      //
      // 红线：注入的通知**必须是 user 角色**，绝不能用 system ——
      // pi 在 OpenAI 兼容端点上默认把后续 system 消息并进 system prompt 首部，
      // 那会把不可信内容永久提升为可信系统指令。
      transformContext: async (messages) => {
        const step = stepCounter;
        stepCounter += 1;

        const extra = [];

        if (preStepNotice) {
          try {
            const notice = await preStepNotice({ step });
            if (notice) {
              const wrapped = wrapUntrusted('untrusted_system_notice', notice);
              const ev = {
                kind: AGENT_EVENTS.SYSTEM_NOTICE,
                text: notice,
                wire: wrapped,
              };
              record(ev);
              if (currentEmit) currentEmit(ev);
              extra.push({
                role: 'user',
                content: wrapped,
                timestamp: Date.now(),
              });
            }
          } catch {
            // 预检失败不能杀掉整轮 —— 与 promptFacts 降级同一原则
          }
        }

        if (drainInstructions) {
          try {
            (drainInstructions() || []).forEach((t) => {
              const text = String(t || '').trim();
              if (!text) return;
              const wrapped = wrapUntrusted(
                'untrusted_user_message',
                '[用户在任务进行中插话] ' + text
              );
              const ev = {
                kind: AGENT_EVENTS.USER_MESSAGE,
                text,
                wire: wrapped,
              };
              record(ev);
              if (currentEmit) currentEmit(ev);
              extra.push({
                role: 'user',
                content: wrapped,
                timestamp: Date.now(),
              });
            });
          } catch {
            // 插话通道坏了也一样不能挡轮
          }
        }

        return extra.length ? [...messages, ...extra] : messages;
      },
      beforeToolCall: async ({ toolCall, args }) => {
        // 红线第 3 条（ADR 0002 的闸）：class 决定要不要用户裁决。
        // read 免确认，write 一律要确认。
        // （未知工具 pi 内部走短路，不会到这 —— 已知退化，见票 04 完成记录）
        const tool = tools.find((t) => t.name === toolCall.name);
        if (tool && tool.class === 'read') return undefined;

        log('tool.confirm.ask', { name: toolCall.name, args });
        let approved = false;
        try {
          const answer = await requestConfirmation({
            name: toolCall.name,
            args,
          });
          approved = Boolean(answer && answer.approved);
        } catch {
          // 确认门本身的错误按「拒绝」处理，不让放行
          approved = false;
        }
        log('tool.confirm.answer', { name: toolCall.name, approved });

        if (!approved) {
          rejectedBy.set(
            toolCall.id,
            tool
              ? `用户在「${tool.class}」类工具「${tool.name}」上拒绝`
              : '未知工具'
          );
          return { block: true, reason: '用户拒绝了此次操作' };
        }
        return undefined;
      },
    });
    piAgent.subscribe(handlePiEvent);
    return piAgent;
  }

  return {
    /** pi Agent 的只读状态快照（票 02 起有用：票 04 的确认门要读 tools 上的 class）。 */
    getState() {
      return piAgent ? piAgent.state : null;
    },

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
      stepCounter = 0;

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
