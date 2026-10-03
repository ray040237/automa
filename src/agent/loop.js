/**
 * Agent 主循环。
 *
 * 不变式（方案 G5）：本文件与 tools/* 只能 import src/agent 下的纯模块，
 * 一律通过 deps 拿浏览器能力；不碰 webextension-polyfill、不碰 @/ 别名，
 * 更不能碰 workflowStore.update / saveWorkflow / registerWorkflowTrigger ——
 * agent 可以改画布，但永远不能落盘保存。
 *
 * 三层东西不要混：
 *   provider 事件 —— openai-compat 产出的 {type:'text-delta'} 等，流内部用；
 *   agent 事件    —— {kind:'agent:text-delta'}，既给 UI 消费，也是唯一的记账；
 *   wire 消息     —— 由 wire.js 从事件历史现算，只为发给模型。
 * 本文件只维护一份事件历史（history），UI 与 wire 都从它派生，不重复记账。
 */

import { buildSystemPrompt } from './prompt';
import { applyTokenBudget } from './window';
import { buildWireMessages } from './wire';
import {
  AGENT_EVENTS,
  TOOL_STATUS,
  toolError,
  wrapObservation,
} from './events';

import { toWireTools, requiresConfirmation } from './tools';
import { streamChat } from './llm/providers/openai-compat';

/** 一轮里最多来回多少次工具调用，防止模型卡在工具循环里。 */
export const MAX_STEPS = 12;

/** 半截参数 JSON 不炸调用方：解析失败按空参数处理。 */
function safeParseArgs(argsDelta) {
  if (!argsDelta) return {};
  try {
    return JSON.parse(argsDelta);
  } catch {
    return {};
  }
}

/**
 * provider 事件 -> agent 事件。
 *
 * @param {Object} chunk
 * @returns {Object|null} null 表示这条不需要对外发
 */
export function toAgentEvent(chunk) {
  switch (chunk.type) {
    case 'text-delta':
      return { kind: AGENT_EVENTS.TEXT_DELTA, text: chunk.text };
    case 'thinking-delta':
      return { kind: AGENT_EVENTS.THINKING, text: chunk.text };
    case 'tool-call-delta':
      return {
        kind: AGENT_EVENTS.TOOL_CALL,
        step: chunk.index,
        name: chunk.name,
        args: safeParseArgs(chunk.argsDelta),
        toolCallId: chunk.id,
      };
    case 'done':
      return { kind: AGENT_EVENTS.DONE, stopReason: chunk.stopReason };
    case 'error':
      // chunk 自己就是错误载荷（见 openai-compat 的 errorChunk），
      // 别再去找 chunk.error —— 那个字段从来没被任何产出方写过。
      return {
        kind: AGENT_EVENTS.ERROR,
        status: TOOL_STATUS.ERROR,
        message: String(chunk.message || '未知错误'),
        errorKind: chunk.kind,
        ...(chunk.status !== undefined ? { httpStatus: chunk.status } : {}),
        wrap: 'untrusted_tool_result',
      };
    default:
      return null;
  }
}

/** 工具结果事件。page 组的结果用 untrusted_page_content 包装，其余用 tool_result。 */
function resultEvent(call, tool, status, observation) {
  return {
    kind: AGENT_EVENTS.TOOL_RESULT,
    step: call.step,
    name: call.name,
    toolCallId: call.toolCallId,
    status,
    observation: wrapObservation({
      status,
      payload: observation,
      wrap:
        tool && tool.group === 'page'
          ? 'untrusted_page_content'
          : 'untrusted_tool_result',
    }),
  };
}

/** 失败结果事件。 */
function failEvent(call, status, message) {
  return {
    kind: AGENT_EVENTS.TOOL_RESULT,
    step: call.step,
    name: call.name,
    toolCallId: call.toolCallId,
    status,
    observation: wrapObservation({ status, message }),
  };
}

async function executeCall({ call, tools, requestConfirmation, toolCtx }) {
  const tool = tools.find((t) => t.name === call.name);

  if (!tool) {
    return [
      failEvent(
        call,
        TOOL_STATUS.ERROR,
        '没有名为 ' +
          call.name +
          ' 的工具。可用工具: ' +
          tools.map((t) => t.name).join('、')
      ),
    ];
  }

  // running 事件必须在确认门之前发：用户看确认卡时界面上就该有
  // 「正在调用 X」的卡；而且拒绝路径的结果也挂在同一个调用卡上，
  // wire 侧 tool 消息永远有配对的 tool_calls（孤儿 tool 消息会 400）
  const runningEv = {
    kind: AGENT_EVENTS.TOOL_CALL,
    step: call.step,
    name: call.name,
    toolCallId: call.toolCallId,
    status: TOOL_STATUS.RUNNING,
  };

  if (requiresConfirmation(call.name, tools)) {
    const answer = await requestConfirmation({
      ...call,
    });

    if (!answer || answer.approved === false) {
      return [
        runningEv,
        failEvent(
          call,
          TOOL_STATUS.REJECTED,
          '用户拒绝了这次调用。没有拿到结果，请基于已有信息回答，或换一种做法。'
        ),
      ];
    }
  }

  try {
    const observation = await tool.execute(call.args || {}, toolCtx);
    return [runningEv, resultEvent(call, tool, TOOL_STATUS.OK, observation)];
  } catch (err) {
    return [
      runningEv,
      failEvent(call, TOOL_STATUS.ERROR, toolError(err).message),
    ];
  }
}

/**
 * 创建 agent 主循环。
 *
 * @param {Object} deps
 * @param {Function=} deps.streamChat
 * @param {() => Object=} deps.promptFacts
 * @param {Array<Object>=} deps.tools
 * @param {Function=} deps.wrapUntrusted
 * @param {Function=} deps.buildUserMessage
 * @param {Function=} deps.requestConfirmation
 * @param {Object=} deps.toolCtx
 * @param {string=} deps.model
 * @param {number=} deps.contextWindow 上下文窗口（token），传给预算裁剪；
 *   缺省用 window.js 的 DEFAULT_CONTEXT_WINDOW
 */
export function createAgent(deps) {
  const {
    streamChat: streamChatImpl = streamChat,
    promptFacts = () => ({}),
    tools = [],
    wrapUntrusted = (tag, body) => '<' + tag + '>' + body + '</' + tag + '>',
    buildUserMessage = ({ userText }) => userText,
    requestConfirmation = async () => ({ approved: false }),
    // 每步开头的预检钩子（P2 标签页定位）：返回 notice 文本则作为
    // system-notice 注入 wire 让模型自决；返回 null 表示一切正常。
    // hook 抛错不挡轮——预检是 advisory，不是闸门。
    preStepNotice,
    // 每步开头抽取的插话队列（P3）：busy 期间用户补充的指令，
    // 返回字符串数组（调用方负责清空），逐条作为 user 消息注入本轮 wire。
    drainInstructions,
    toolCtx = {},
    model = 'gpt-4o-mini',
    contextWindow,
  } = deps;

  let controller = null;
  // 跨轮续接的记忆：send 时用 initialHistory 重置，收尾后 getHistory() 读回。
  // 提到 agent 级而不是 send 局部，是为了让 runtime 在 send 返回后还能拿到。
  let history = [];

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
      const emit = (ev) => {
        if (onEvent) onEvent(ev);
      };

      controller = new AbortController();

      // promptFacts 以前是裸调用：事实表一旦构建失败，整个 send 直接抛，
      // 用户看到的是一个来路不明的 TypeError。
      // 工具执行有 try/catch 兜着，这里却没有 —— 而这里每轮都跑，
      // 所以一处写错就是「第一次发消息整个功能死掉」。
      // 这里降级成空事实：模型少知道一点，但还能继续对话。
      let facts = {};

      try {
        facts = promptFacts() || {};
      } catch (err) {
        facts = {};

        emit({
          kind: AGENT_EVENTS.ERROR,
          error:
            '提示词事实表构建失败，本次按空表继续：' + toolError(err).message,
        });
      }

      const system = params.system || buildSystemPrompt(facts);

      // 只维护一份事件历史：UI 靠它渲染，wire 消息由 buildWireMessages 现算。
      // 不要再叠一层 transcript —— 那份是给 UI 折展示行的，
      // 直接拿来发给模型会把工具结果整条丢掉（见 wire.js 顶部说明）。
      // 多会话：initialHistory 是上一轮留下的历史，本轮从它续接。
      history = [...(params.initialHistory || [])];

      // 用户消息本身也进历史（wire 形态存进 ev.wire）：
      // 没有它，下一轮续接时模型只知道助手说过什么、不知道用户问过什么。
      // 注意 buildUserMessage 只在这里对「新消息」做 untrusted 包装，
      // 历史里的旧 user 行原样进 wire，不能二次包装。
      const startEv = { kind: AGENT_EVENTS.START };
      history.push(startEv);
      emit(startEv);

      const userEv = {
        kind: AGENT_EVENTS.USER_MESSAGE,
        text: userText,
        wire: buildUserMessage(
          { userText, targetTab, workflowContext },
          wrapUntrusted
        ),
      };
      history.push(userEv);
      emit(userEv);

      const tabEv = { kind: AGENT_EVENTS.TARGET_TAB, tab: targetTab };
      history.push(tabEv);
      emit(tabEv);

      // 入史 + 对外发是同一动作的两面，只允许通过这一个入口记账
      const record = (ev) => {
        history.push(ev);
        emit(ev);
      };

      let stopped = false;
      // 本轮 token 用量（网关附带 usage chunk 时才有数）
      const usage = { input: 0, output: 0 };

      for (let step = 0; step < MAX_STEPS; step += 1) {
        // 每步开工前做一次环境预检（tab 是否还在、origin 是否漂移）。
        // notice 是观察值不是错误：模型看到后自己决定继续、换页还是收手。
        if (preStepNotice) {
          try {
            const notice = await preStepNotice({ step });
            if (notice) {
              record({
                kind: AGENT_EVENTS.SYSTEM_NOTICE,
                text: notice,
                wire: wrapUntrusted('untrusted_system_notice', notice),
              });
            }
          } catch {
            // 预检失败不能杀掉整轮 —— 与 promptFacts 降级同一原则
          }
        }

        // 任务中插话（P3）：busy 期间用户补充的指令在下一步开工前送达。
        // 放在预检之后、发请求之前，模型这一步就能看到。
        if (drainInstructions) {
          try {
            (drainInstructions() || []).forEach((t) => {
              const text = String(t || '').trim();
              if (!text) return;
              record({
                kind: AGENT_EVENTS.USER_MESSAGE,
                text,
                wire: wrapUntrusted(
                  'untrusted_user_message',
                  '[用户在任务进行中插话] ' + text
                ),
              });
            });
          } catch {
            // 插话通道坏了也一样不能挡轮
          }
        }

        const { messages } = applyTokenBudget(
          buildWireMessages(history, { system }),
          { contextWindow }
        );

        const pendingToolCalls = [];
        let streamError = null;

        const stream = streamChatImpl({
          messages,
          tools: toWireTools(tools),
          config: { model },
          signal: controller.signal,
        });

        // eslint-disable-next-line no-restricted-syntax
        try {
          for await (const chunk of stream) {
            if (chunk.type === 'error') {
              // 整块都是错误载荷，不是 chunk.error
              streamError = chunk;
              break;
            }

            if (chunk.type === 'tool-call-delta') {
              pendingToolCalls.push(chunk);
              continue;
            }

            if (chunk.type === 'usage') {
              usage.input += Number(chunk.input) || 0;
              usage.output += Number(chunk.output) || 0;
              continue;
            }

            const ev = toAgentEvent(chunk);
            if (!ev) continue;
            if (ev.kind === AGENT_EVENTS.DONE) continue; // 收尾统一发

            history.push(ev);
            emit(ev);
          }
        } catch (err) {
          // 中止不是错误（技术方案 §5.4）：用户点停止后走正常收尾，
          // 已说的半截话也留在历史里。其余异常原样上抛给宿主。
          if (controller.signal.aborted) {
            stopped = true;
            break;
          }
          throw err;
        }

        if (streamError) {
          // 错误形状只在 toAgentEvent 定义一次，这里直接复用
          const errEv = toAgentEvent(streamError);
          // 错误也要入史：否则会话重开后，用户看到助手话说一半就没了下文
          history.push(errEv);
          emit(errEv);
          return errEv;
        }

        if (pendingToolCalls.length === 0) {
          stopped = true;
          break;
        }

        // eslint-disable-next-line no-restricted-syntax
        for (const chunk of pendingToolCalls) {
          // 有些厂商会先发一个空的 tool-call 块占位再补内容，跳过
          if (!chunk.id) continue;

          const call = {
            step: chunk.index,
            name: chunk.name,
            toolCallId: chunk.id,
          };

          let args;
          try {
            args = chunk.argsDelta ? JSON.parse(chunk.argsDelta) : {};
          } catch (err) {
            // 参数 JSON 没拼完整就到了（网关方言）。转成 error 观察值让模型
            // 重新发起调用 —— 把 SyntaxError 抛上去只会炸掉整轮对话。
            record(
              failEvent(
                call,
                TOOL_STATUS.ERROR,
                '工具参数不是合法 JSON（收到: ' +
                  String(chunk.argsDelta).slice(0, 100) +
                  '）。请重新调用该工具，参数必须是完整的 JSON。'
              )
            );
            continue;
          }

          call.args = args;

          const results = await executeCall({
            call,
            tools,
            requestConfirmation,
            toolCtx,
          });
          results.forEach(record);
        }
      }

      const doneEv = {
        kind: AGENT_EVENTS.DONE,
        stopped,
        aborted: controller.signal.aborted,
        usage,
      };
      emit(doneEv);
      return doneEv;
    },

    /** 中断当前这轮。 */
    abort() {
      if (controller) controller.abort();
    },

    /** 本轮收尾后的完整事件历史（含 initialHistory），供 runtime 持久化。 */
    getHistory() {
      return history;
    },
  };
}
