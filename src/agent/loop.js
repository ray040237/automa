/**
 * Agent 主循环 —— 基于 pi-agent-core（票 01~08 已完成，见 docs/agent-core-migration-spec.md）。
 *
 * 不变式（方案 G5 + ADR 0004）：本文件与 tools/* 只 import src/agent 下的纯模块，
 * 浏览器能力一律通过 deps 注入；不碰 webextension-polyfill、不碰 @/ 别名，
 * 更不能碰 workflowStore.update / saveWorkflow / registerWorkflowTrigger ——
 * agent 可以改画布，但永远不能落盘保存。
 * 唯一的 import 例外是 pi 包（@earendil-works/pi-*，ADR 0004 决策的一部分）：
 * 内核与 provider 层都来自它，npm 安装、实测无 node:/process. 依赖，浏览器可跑
 * （ensurePiAgent 里的动态 import 就是在等它）。
 *
 * 两层东西不要混：
 *   provider 事件 —— pi-ai 产出的流内部事件，只在 streamFn 与本文件之间流动；
 *   agent 事件    —— {kind:'agent:*'} 事件，既给 UI 消费，也是唯一的记账。
 * pi 的对话状态（transcript）由 pi 自己持有，我们不 own 一份；本文件只维护
 * 一份事件历史（history），UI 从它派生，不重复记账。
 *
 * provider 参数（messages / tools / temperature / 重试）全部由 pi 从 transcript
 * 生成，我们不再现算 —— 旧的自建消息层已随票 08 删除（ADR 0004）。
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
import { findTool, requiresConfirmation } from './tools';
// fromPiEvent 是无 deps 的纯导出函数，pi 自产结果的补包装（T-70）只能走模块级
// import；createAgent 里那份是注入的 deps.wrapUntrusted，两者是同一个实现但
// 生命周期不同，别名以免遮蔽。
import { wrapUntrusted as wrapUntrustedTag } from './untrusted';
import { noopLog } from './log';
// T-76 上下文压缩：机制与切点规则见 compaction.js 头注与 docs/agent-compaction-spec.md。
// 纯函数在这里做投影（historyToPiMessages）与规划（runCompaction），
// LLM 调用走本文件的 streamFnWithRetry——compaction.js 自己不碰 streamFn。
import {
  SUMMARIZATION_SYSTEM_PROMPT,
  buildCompactionEvent,
  buildSummaryUserPrompt,
  dropTrailingPartialAssistant,
  estimateHistoryTokens,
  isContextOverflowMessage,
  planCompaction,
  projectAfterLastCompaction,
  serializeForSummary,
  shouldCompact,
} from './compaction';

/** 溢出恢复时给用户与模型的说明（T-76）。进事件流（用户可见）也进 transcript。 */
const RECOVERY_NOTICE =
  '上下文超出模型窗口：早期对话已自动压缩为摘要，正在从未完成的进度继续。';

/**
 * 回复被输出长度上限截断时的说明（T-96②）。
 *
 * 为什么必须有它：pi 把 length 当成正常收尾（不是 error），fromPiEvent 原本
 * 对它 emitsNothing —— 于是「回答说到一半没了」在界面上完全无声，这正是
 * provider.js 里记着的那个坑（曾写死 maxTokens=4096 导致静默截断）。既然
 * 允许用户设 maxTokens（T-96），截断就必须看得见，否则等于把静默降级开放
 * 出去。走 SYSTEM_NOTICE：UI 是琥珀色提示条，且进 transcript 让模型知道
 * 上一次是被截断的。
 */
const TRUNCATED_NOTICE =
  '本次回复达到输出长度上限被截断。若设置了单次回复上限（maxTokens），可调大或留空；否则是模型自身的输出上限。';

/**
 * 把**agent 事件历史**（我们的持久格式）还原成 pi 的消息 transcript。
 *
 * 为什么需要它：ticket 07 之前，`initialHistory` 只进了 `history`（给 UI 渲染），
 * 模型跨会话续接时那段历史**并没有进 transcript** —— 那会让「重开会话」变成
 * 只传首条 user 消息过去。本函数负责翻译，是 ticket 07 的接缝。
 *
 * 规则要点：
 * - user 消息直接进 transcript，content 用事件里已存好的包装文本
 *   （promptText 字段；票 08 前的旧持久化记录叫 wire，兼容读）。
 * - 连续的 TEXT_DELTA 视为同一次 assistant 回复（UI 是增量发，但真值是拼接）。
 * - TOOL_CALL 事件先攒着，等 TOOL_RESULT 一起发成一条 assistant（含 toolCall 块）
 *   + 一条 toolResult，因为 pi 要求工具调用与结果成对。
 * - SYSTEM_NOTICE / 插话走 role:'user'（红线第 1 条）。
 * - COMPACTION（T-76）投影为一条 user 消息：摘要是页面正文/工具返回/用户输入
 *   的派生物，包 untrusted_compaction_summary（红线 2），「这是背景摘要」的
 *   语义由外面那句可信前缀传达。
 * - 投影只认**最后一条** COMPACTION：它之前的老事件已被摘要取代，不再进 transcript
 *   （原始事件留在历史里给 UI，append-only）。
 * - ERROR / DONE / START / TARGET_TAB 不入 transcript（它们是事件信号，不是内容）。
 *
 * @param {Array<Object>} events
 * @returns {Array<Object>} pi 的 Message[]
 */
export function historyToPiMessages(events) {
  const out = [];
  const source = projectAfterLastCompaction(events);

  // 攒一个 assistant 消息：连续 TEXT_DELTA 归并，TOOL_CALL 暂存到同一消息的 toolCall 块里
  let textParts = [];
  let toolCalls = [];

  /**
   * 取事件的 prompt 包装文本。缺了就抛错，不许回落 ev.text —— 那是未包装的
   * 原始文本，回落即裸文本直达模型（T-56/T-63：包装缺失必须炸出来）。
   * 旧持久化记录的字段名叫 wire（票 08 前的命名），续接老会话时兼容读（T-67）。
   */
  const promptTextOf = (ev, label) => {
    const packed = ev.promptText || ev.wire;
    if (!packed) {
      throw new Error(
        `${label} 事件缺 promptText（未包装文本不得进 transcript）：${JSON.stringify(
          String(ev.text || '')
        ).slice(0, 80)}`
      );
    }
    return packed;
  };

  const flushAssistant = () => {
    if (!textParts.length && !toolCalls.length) return;

    const content = [];
    if (textParts.length) {
      content.push({ type: 'text', text: textParts.join('') });
    }
    content.push(...toolCalls);

    out.push({
      role: 'assistant',
      content,
      api: 'openai-completions',
      // provider/model 只是 pi 消息形状要求的非空占位：这条消息是从事件历史
      // 重放的，不是真的来自某次请求，usage 也全部按 0 记（T-73）。
      provider: 'replay',
      model: 'replayed-history',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      },
      stopReason: toolCalls.length ? 'toolUse' : 'stop',
      timestamp: Date.now(),
    });

    textParts = [];
    toolCalls = [];
  };

  for (const ev of source) {
    switch (ev && ev.kind) {
      case AGENT_EVENTS.USER_MESSAGE:
        flushAssistant();
        out.push({
          role: 'user',
          content: promptTextOf(ev, 'USER_MESSAGE'),
          timestamp: Date.now(),
        });
        break;

      case AGENT_EVENTS.SYSTEM_NOTICE:
        flushAssistant();
        out.push({
          role: 'user',
          content: promptTextOf(ev, 'SYSTEM_NOTICE'),
          timestamp: Date.now(),
        });
        break;

      case AGENT_EVENTS.TEXT_DELTA:
        if (ev.text) textParts.push(ev.text);
        break;

      case AGENT_EVENTS.THINKING:
        // thinking 在 pi 里是 content 里的独立块类型；简单起见并入文本。
        if (ev.text) textParts.push(ev.text);
        break;

      case AGENT_EVENTS.TOOL_CALL: {
        // 新格式（T-74 方案 B）：一条事件一个调用，走顶层字段。
        // 旧持久化记录：一条事件装全部并行调用（calls[]），按数组展开 ——
        // 曾经只取第一个，其余调用在跨会话上下文里整个丢失（探针实测）。
        const callList =
          Array.isArray(ev.calls) && ev.calls.length
            ? ev.calls
            : [{ name: ev.name, args: ev.args, toolCallId: ev.toolCallId }];
        for (const c of callList) {
          toolCalls.push({
            type: 'toolCall',
            id: c.toolCallId,
            name: c.name,
            arguments: c.args || {},
          });
        }
        break;
      }

      case AGENT_EVENTS.TOOL_RESULT:
        flushAssistant();
        out.push({
          role: 'toolResult',
          toolCallId: ev.toolCallId,
          toolName: ev.name,
          content: [
            {
              type: 'text',
              // observation 在 fromPiEvent 里已包装好（T-70）。「|| details」
              // 只为兼容修复前的旧持久化记录（那时 end 事件的 observation 是
              // 空占位）—— 新事件不会走到。
              text:
                ev.observation ||
                (ev.details && JSON.stringify(ev.details)) ||
                '',
            },
          ],
          isError:
            ev.status === TOOL_STATUS.ERROR ||
            ev.status === TOOL_STATUS.REJECTED,
          timestamp: Date.now(),
        });
        break;

      case AGENT_EVENTS.COMPACTION:
        flushAssistant();
        out.push({
          role: 'user',
          content:
            '[此前对话已压缩为摘要，更早的消息不再逐条出现]\n' +
            wrapUntrustedTag('untrusted_compaction_summary', ev.summary || ''),
          timestamp: Date.now(),
        });
        break;

      case AGENT_EVENTS.ERROR:
      case AGENT_EVENTS.DONE:
      case AGENT_EVENTS.START:
      case AGENT_EVENTS.TARGET_TAB:
        flushAssistant();
        break;

      default:
        // 未知 agent 事件：炸出来，不能静默丢 —— 与 fromPiEvent 对未知
        // pi 事件的策略一致（T-71）。现有 AGENT_EVENTS 全集已被上面的
        // 分支覆盖；走到这里说明有新事件类型漏了登记。
        throw new Error(
          `historyToPiMessages: 未知的 agent 事件类型 ${JSON.stringify(
            ev && ev.kind
          )}`
        );
    }
  }

  flushAssistant();
  return out;
}

/**
 * 从 pi 的错误信息里提取「对我们的六类分类最该给什么」。
 *
 * 为什么不能只拿 stopReason：它永远是 'error'|'aborted'，分不清
 * 「配置问题」「401 key 无效」「429 限流」「网络断了」。而 UI 要靠 kind
 * 决定文案与建议动作。pi 没有直接暴露结构化 status，但它的 errorMessage
 * 里习惯性带状态码（实测格式：`429: {...}` / `429 Rate limit reached` /
 * `OpenAI API error (429): ...`）；网络类错误是固定文案（`Connection error.`）。
 * 这比手写六十条正则类的维护成本低得多——只匹配「状态码前缀」一类。
 *
 * 反推规则（任一命中即返回对应 kind）：
 *   - `Connection error.` / `fetch failed` / `ECONNREFUSED` / `ENOTFOUND` /
 *     `ETIMEDOUT` / `socket hang up` → NETWORK
 *   - 以 3 位数字开头或包含 `(nnn)` 的 → PROVIDER + httpStatus 数字
 *   - 其余 → PROVIDER（没有状态码）
 */
export function classifyPiErrorMessage(message) {
  const msg = String(message || '');

  if (
    /connection error|fetch failed|econnrefused|enotfound|etimedout|socket hang up|networkerror/i.test(
      msg
    )
  ) {
    return { errorKind: ERROR_KIND.NETWORK };
  }

  const statusMatch = msg.match(/^(\d{3})[:\s]/) || msg.match(/\((\d{3})\)/);
  if (statusMatch) {
    return {
      errorKind: ERROR_KIND.PROVIDER,
      httpStatus: Number(statusMatch[1]),
    };
  }

  return { errorKind: ERROR_KIND.PROVIDER };
}

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
        const { errorKind, httpStatus } = classifyPiErrorMessage(
          message.errorMessage
        );
        return errorEvent({
          message: message.errorMessage || '未知错误',
          errorKind,
          ...(httpStatus !== undefined && { httpStatus }),
        });
      }
      if (message.stopReason === 'aborted') return { emitsNothing: true };

      // 长度截断：pi 当正常收尾，但对用户是「话说到一半没了」——必须留痕
      // （T-96②）。包 untrusted 是为了满足 SYSTEM_NOTICE 进 transcript 的
      // 契约（promptTextOf 缺包装就抛错），与 RECOVERY_NOTICE 同款处理。
      if (message.stopReason === 'length') {
        return {
          kind: AGENT_EVENTS.SYSTEM_NOTICE,
          text: TRUNCATED_NOTICE,
          promptText: wrapUntrustedTag(
            'untrusted_system_notice',
            TRUNCATED_NOTICE
          ),
        };
      }

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

    case 'tool_execution_end': {
      // 观察值从结果里提取（T-70，替代曾经的空占位）：adapter 产出的结果
      // 已在 toToolResult 里包装好（单 text 块，首部即 <untrusted_*> 标签），
      // 原样透传；pi 自产的结果（未知工具短路、输出截断、参数校验失败）没
      // 经过 adapter，必须在这里补包装 —— 红线第 2 条：工具返回一律 untrusted。
      // 这份文本同时是 UI 工具卡的正文与跨会话续接时进 transcript 的内容。
      const resultText = Array.isArray(event.result && event.result.content)
        ? event.result.content
            .map((c) => (c && c.type === 'text' ? c.text : ''))
            .join('\n')
        : '';
      const observation =
        resultText && resultText.startsWith('<untrusted_')
          ? resultText
          : wrapUntrustedTag('untrusted_tool_result', resultText);
      return {
        kind: AGENT_EVENTS.TOOL_RESULT,
        toolCallId: event.toolCallId,
        name: event.toolName,
        status: event.isError ? TOOL_STATUS.ERROR : TOOL_STATUS.OK,
        observation,
        details: event.result,
      };
    }

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
 * @param {Function} deps.buildUserMessage 必填（prompt.js 的，缺了装配期抛，T-84）
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
    // T-84：buildUserMessage 不再有缺省兜底——旧默认 ({userText}) => userText
    // 会静默丢 targetTab/workflowContext（模型失去目标页锚点），与 T-55 的
    // wrapUntrusted 同哲学：缺注入直接炸，不给静默降级留门。
    buildUserMessage,
    // 票 04：写类/未知工具的确认门，默认拒绝（得显式调用方放行才过）
    requestConfirmation = async () => ({ approved: false }),
    toolCtx = {},
    // 票 06：预检通知与插话队列。注入点是 transformContext（每次请求前
    // 调用，产物只用于当次请求、不写回 transcript）。
    preStepNotice,
    drainInstructions,
    systemPromptOverride,
    // T-76：上下文窗口（config.contextWindow）。0/缺省 = 压缩关闭，
    // 纯估算超阈值才会触发压缩，不影响任何既有路径。
    contextWindow = 0,
    log = noopLog,
  } = deps;

  if (!streamFn) {
    throw new Error(
      'createAgent: 缺streamFn。provider 层由 pi 提供，' +
        'streamFn 是唯一必需的模型依赖。'
    );
  }
  if (!model) {
    throw new Error(
      'createAgent: 缺 model。pi 的模型对象由装配层从config 构造。'
    );
  }
  if (typeof wrapUntrusted !== 'function') {
    // 缺注入必须炸：静默用一个不逃逸的兜底等于零防护且无任何报警（T-55）。
    // 校验原本挂在 adapter 的同名形参上（T-69 删除），真正的消费点在这里：
    // 用户消息回显、预检通知、插话与 pi 自产工具结果的包装全靠它。
    throw new Error(
      'createAgent: 缺 wrapUntrusted。用户输入回显与工具返回必须经不可信' +
        '包装 —— 不要传兜底实现，直接抛。'
    );
  }
  if (typeof buildUserMessage !== 'function') {
    // T-84：与 wrapUntrusted 同款校验。缺省兜底会静默丢 targetTab 元数据。
    throw new Error(
      'createAgent: 缺 buildUserMessage。用户消息的包装与目标页元数据由' +
        '装配层组装（prompt.js 的 buildUserMessage）—— 不要传兜底实现，直接抛。'
    );
  }

  // 票 05：重试显式开启。pi 的 Agent 不转发 maxRetries（provider-retry 里
  // 默认 `options.maxRetries ?? 0`，即完全不重试），所以把 streamFn 包一层
  // 显式注入。这里是「可重试失败会重试」的落点，不可静默降级成不重试。
  const streamFnWithRetry = (modelArg, context, options = {}) =>
    streamFn(modelArg, context, { maxRetries: 3, ...options });

  // pi Agent 实例：每个 createAgent 一个，跨轮复用（它持有对话状态）
  let piAgent = null;

  /** 事件历史：UI 的唯一消费来源，也是唯一的记账 */
  let history = [];
  /** 本轮中止控制器 */
  let controller = null;

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

  /** 本轮的事件回调。pi 的 subscribe 在Agent 构造时绑定，所以用闭包变量传。 */
  let currentEmit = null;

  // T-76：usage 收割的全局去重集。piAgent 跨轮复用、transcript 累积（无
  // initialHistory 时上一轮消息原样留着），每轮只准收割**新出现的** assistant
  // 消息——按消息对象身份记账，跨轮持久。
  const countedUsage = new Set();
  /** 把 piAgent 里还没计过费的 assistant 消息收进 target。 */
  const harvestUsage = (target) => {
    for (const m of piAgent ? piAgent.state.messages : []) {
      if (m && m.role === 'assistant' && m.usage && !countedUsage.has(m)) {
        countedUsage.add(m);
        target.input += m.usage.input || 0;
        target.output += m.usage.output || 0;
      }
    }
  };

  /**
   * 「入史 + 发外」的单一入口（T-72）：事件历史与 UI 看到的必须是同一份，
   * 新增事件发射点只准走这里 —— 漏一半（只入史 UI 缺行 / 只发外续接丢数据）
   * 这种错误从结构上堵死。doneEv 是例外（见 send 末尾：只发外）。
   */
  const emitAndRecord = (ev) => {
    history.push(ev);
    if (currentEmit) currentEmit(ev);
  };

  /**
   * 同上，但事件**插队**到指定下标而不是 push 到尾（T-76 专用）：压缩摘要
   * 事件必须落在切点处——它上面的老事件归摘要管，下面的保留窗原样进
   * transcript。追加到尾部会让投影把保留窗一起「摘要掉」。
   */
  const emitAndRecordAt = (ev, index) => {
    history.splice(index, 0, ev);
    if (currentEmit) currentEmit(ev);
  };

  /**
   * T-76：独立小请求生成摘要（与 index.js generateTitleAsync 同一条路径形状）。
   * 失败 / 输出被 maxTokens 截断 / 输出为空一律抛错——失败的摘要绝不落库
   * （pi 同款：宁可没摘要，不要错的摘要），由调用方决定降级方式。
   */
  const requestSummary = async ({ serialized, previousSummary, maxTokens }) => {
    // streamFn 允许异步实现（测试桩是 async）：await 一个非 Promise 是零代价，
    // 不 await 的话异步实现会拿到 Promise 本体，stream.result 直接不存在。
    const stream = await streamFnWithRetry(
      model,
      {
        systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: buildSummaryUserPrompt({ serialized, previousSummary }),
            timestamp: Date.now(),
          },
        ],
      },
      { maxTokens }
    );
    const result = await stream.result();
    if (result.stopReason === 'error') {
      throw new Error(result.errorMessage || '摘要请求失败');
    }
    if (result.stopReason === 'length') {
      throw new Error('摘要输出被 maxTokens 截断');
    }
    const text = (result.content || [])
      .filter((c) => c && c.type === 'text')
      .map((c) => c.text)
      .join('')
      .trim();
    if (!text) throw new Error('摘要输出为空');
    return text;
  };

  /**
   * T-76：执行一次压缩，返回 `{ev, insertAt}`（ev 插到 history[insertAt]），
   * 或 null（不该压）。history 是闭包状态——调用前必须已填好（send 在重置
   * history 之后调用）。force=true（溢出恢复）跳过阈值判断，只看切点。
   */
  const runCompaction = async ({ systemPrompt, force = false }) => {
    if (!contextWindow) return null;

    const estimated = estimateHistoryTokens({
      events: history,
      systemPrompt,
      tools,
    });
    if (!force && !shouldCompact(estimated, contextWindow)) return null;

    const plan = planCompaction(history, contextWindow);
    if (!plan) return null;

    // 带上 maxTokens 再抛（T-93②）：调用方只 log.warn 一句 message，没有它
    // 就分不清「摘要 maxTokens 超过了模型输出上限」和「模型真的写太长」。
    let summary;
    try {
      summary = await requestSummary({
        serialized: serializeForSummary(history.slice(0, plan.cutIndex)),
        previousSummary: plan.previousSummary,
        maxTokens: plan.summaryMaxTokens,
      });
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      throw new Error(
        `摘要请求失败（summaryMaxTokens=${plan.summaryMaxTokens}，估算 ${estimated} token）：${reason}`
      );
    }

    return {
      ev: buildCompactionEvent({
        summary,
        tokensBefore: estimated,
        summarizedTurns: plan.summarizedTurns,
      }),
      insertAt: plan.cutIndex,
    };
  };

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
      emitAndRecord(ev);
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

    // T-74 方案 B：TOOL_CALL 按调用拆开发射 —— 一条 TOOL_CALL 事件配一条
    // TOOL_RESULT 事件，事件流里不再有 calls[] 字段，事件形状只有「单调用」
    // 一种。fromPiEvent 产出的合装事件（含 calls[]）只是翻译层内部形状，
    // 到这个唯一的发射点必须拆开，否则并行调用的第 2..N 个会从消费方眼前消失。
    if (mapped.kind === AGENT_EVENTS.TOOL_CALL) {
      const calls =
        Array.isArray(mapped.calls) && mapped.calls.length
          ? mapped.calls
          : [
              {
                name: mapped.name,
                args: mapped.args,
                toolCallId: mapped.toolCallId,
              },
            ];
      for (const c of calls) {
        emitAndRecord({
          kind: AGENT_EVENTS.TOOL_CALL,
          name: c.name,
          args: c.args,
          toolCallId: c.toolCallId,
        });
      }
      return;
    }

    emitAndRecord(mapped);
  }

  async function ensurePiAgent(systemPrompt) {
    if (piAgent) return piAgent;
    const { Agent } = await import('@earendil-works/pi-agent-core');
    piAgent = new Agent({
      initialState: {
        systemPrompt,
        model,
        // 票 02：工具经适配层注册。票 04：确认门在 beforeToolCall 接。
        tools: toAgentTools(tools, { toolCtx }),
      },
      streamFn: streamFnWithRetry,
      // 票 06：预检通知与插话队列。注入点选 transformContext ——
      // pi 每次 LLM 请求前调用它，产物只用于当次请求、**不写回 transcript**。
      // 这样通知期后模型能看到，但不会进持久历史（persist 的只是用户/助手/工具消息），
      // 与迁移前「通知进消息层不进持久历史」的语义一致。
      //
      // 红线：注入的通知**必须是 user 角色**，绝不能用 system ——
      // pi 在 OpenAI 兼容端点上默认把后续 system 消息并进 system prompt 首部，
      // 那会把不可信内容永久提升为可信系统指令。
      transformContext: async (messages) => {
        const extra = [];

        if (preStepNotice) {
          try {
            // T-84：不再传 {step}——实现侧（index.js）用内容键判重，从不读
            // step，这个参数从第一天起就是死的。
            const notice = await preStepNotice();
            if (notice) {
              const wrapped = wrapUntrusted('untrusted_system_notice', notice);
              const ev = {
                kind: AGENT_EVENTS.SYSTEM_NOTICE,
                text: notice,
                promptText: wrapped,
              };
              emitAndRecord(ev);
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
                promptText: wrapped,
              };
              emitAndRecord(ev);
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
        // read 免确认，write 一律要确认。判定收在 requiresConfirmation ——
        // ADR 0002 点名的执行者，未知工具保守确认（实际到不了：pi 对未知
        // 工具内部短路，B9 第 4 项）。
        const tool = findTool(toolCall.name, tools);
        if (!requiresConfirmation(toolCall.name, tools)) return undefined;

        log('tool.confirm.ask', { name: toolCall.name, args });
        let approved = false;
        try {
          // tool 随载荷带给宿主 → confirm.js 的 buildConfirmation 调工具
          // 自带的 confirmDetail 取「用户在放行什么」（T-83）。
          const answer = await requestConfirmation({
            name: toolCall.name,
            args,
            tool,
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
     * onEvent 可选（headless 使用不被排除），但宿主必须传：focus_tab 改目标页
     * 的 UI 同步（agent:target-tab 事件）只走它，缺了就静默丢（T-84 评估结论：
     * 行为保留，契约写明）。
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
        emitAndRecord(ev);
      }

      const system =
        params.system || systemPromptOverride || buildSystemPrompt(facts);

      // 跨轮续接：历史重置为调用方给的上轮历史
      history = [...(params.initialHistory || [])];
      // 本轮事件的起点。轮末的「本轮是否出错」判定只准扫这之后的事件：
      // initialHistory 里可能带着上一轮落盘的旧 ERROR（T-61），扫全量会把
      // 本轮的成功误判成失败、不发 DONE。
      const turnHistoryStart = history.length;

      // T-76 预压缩：提交前估算，越过阈值先把保留窗外的老轮次压成摘要。
      // 摘要事件插在切点处（上面的归摘要、下面的保留窗原样进 transcript）。
      // 压缩失败不杀轮——摘要只是优化，真撞上限还有溢出恢复兜底（不静默：
      // log.warn 如实记）。
      try {
        const compaction = await runCompaction({ systemPrompt: system });
        if (compaction) emitAndRecordAt(compaction.ev, compaction.insertAt);
      } catch (err) {
        log.warn('compaction.skip', {
          message: err && err.message ? err.message : String(err),
        });
      }
      // transcript 重建用这份快照：含刚插入的压缩事件、不含本轮的 START/USER
      const carryOverEvents = history.slice();

      const startEv = { kind: AGENT_EVENTS.START };
      emitAndRecord(startEv);

      const userEv = {
        kind: AGENT_EVENTS.USER_MESSAGE,
        text: userText,
        promptText: buildUserMessage(
          { userText, targetTab, workflowContext },
          wrapUntrusted
        ),
      };
      emitAndRecord(userEv);

      if (targetTab) {
        const tabEv = { kind: AGENT_EVENTS.TARGET_TAB, tab: targetTab };
        emitAndRecord(tabEv);
      }

      const agent = await ensurePiAgent(system);
      // 续接：把上轮的 agent 事件历史还原成 pi 的 transcript（含刚插入的
      // 压缩事件——投影后旧轮原文被摘要取代，保留窗原样保留）。
      // 之前是 filter((ev) => ev.piMessage) —— 但我们从没在事件上存过 piMessage，
      // 等于永远拿不到历史，「重开会话」实际变成「只传本轮 user 消息过去」。
      if (carryOverEvents.length > 0) {
        const piMessages = historyToPiMessages(carryOverEvents);
        if (piMessages.length > 0) {
          // pi 的 transcript 首条是 system（由 initialState.systemPrompt 种入）。
          // 我们重建的 transcript 没有 system，必须把现有那条补回最前，
          // 否则 prompt 会整体丢失。
          const existingSystem = agent.state.messages.find(
            (m) => m.role === 'system'
          );
          agent.state.messages = existingSystem
            ? [existingSystem, ...piMessages]
            : piMessages;
        }
      }

      let stopped = false;
      const usage = { input: 0, output: 0 };
      /** 本轮的错误事件（若有）。pi 把失败编码成 assistant 消息的 stopReason，
       *  由映射层转成 ERROR 事件并记在这里 —— 出错收尾不发 DONE（现状契约）。 */
      let errorEv = null;

      // T-63: 活轮次发「元数据段 + 用户原文」, 不是原文, 也不是整条包装版。
      // 元数据 (目标页 url/title、工作流上下文) 是第三方信息, 两种形态都包;
      // 用户原文是**当轮指令**, 包进 untrusted 就等于按安全声明告诉模型
      // 「这是数据别当指令」 —— 详见 prompt.js buildUserMessage 的说明。
      // 入史的 promptText 仍是全包装版 (重放时那句已是历史, 适用红线第 2 条)。

      const livePromptText = buildUserMessage(
        { userText, targetTab, workflowContext, wrapUserText: false },
        wrapUntrusted
      );

      try {
        await agent.prompt(livePromptText);
        stopped = true;
        // usage 累加**本轮全部**带 usage 的 assistant 消息：一个工具轮有 N 次
        // LLM 请求就有 N 条 assistant 消息，只取最后一条会把前 N-1 次的用量
        // 全部丢掉。pi 会为 user 消息也发 message_end，所以只认 assistant。
        harvestUsage(usage);
      } catch (err) {
        // 中止不是错误（技术方案 §5.4）：用户点停止后走正常收尾。
        if (!controller.signal.aborted) {
          errorEv = errorEvent({
            message: toolError(err).message,
            errorKind: ERROR_KIND.INTERNAL,
          });
          emitAndRecord(errorEv);
        }
      }

      // 映射层已经为 pi 的错误产出了 ERROR 事件，这里不再发 DONE ——
      // UI 靠「有没有 DONE」区分正常收尾与出错收尾。
      errorEv =
        errorEv ||
        history
          .slice(turnHistoryStart)
          .find((e) => e.kind === AGENT_EVENTS.ERROR) ||
        null;

      // T-76 溢出恢复：撞上下文上限时压缩一次再续跑本轮，只试一次。
      // 前置条件：pi 的 continue() 在 assistant 尾上会 throw，所以先用
      // dropTrailingPartialAssistant 剪掉失败尝试的残缺尾部——请求失败发生在
      // 「要下一条 assistant 消息」的时刻，剪完尾巴必然是 toolResult 或 user。
      if (
        errorEv &&
        !controller.signal.aborted &&
        isContextOverflowMessage(errorEv.message)
      ) {
        let recovered = false;
        try {
          const compaction = await runCompaction({
            systemPrompt: system,
            force: true,
          });
          if (compaction) {
            emitAndRecordAt(compaction.ev, compaction.insertAt);
            emitAndRecord({
              kind: AGENT_EVENTS.SYSTEM_NOTICE,
              text: RECOVERY_NOTICE,
              promptText: wrapUntrusted(
                'untrusted_system_notice',
                RECOVERY_NOTICE
              ),
            });
            const rebuilt = historyToPiMessages(
              dropTrailingPartialAssistant(history)
            );
            if (rebuilt.length > 0) {
              const existingSystem = agent.state.messages.find(
                (m) => m.role === 'system'
              );
              agent.state.messages = existingSystem
                ? [existingSystem, ...rebuilt]
                : rebuilt;
            }
            // 只认恢复点之后的错误：旧 ERROR 已随压缩消化，不能拿它否定恢复
            const recoveryScanStart = history.length;
            await agent.continue();
            harvestUsage(usage);
            stopped = true;
            errorEv =
              history
                .slice(recoveryScanStart)
                .find((e) => e.kind === AGENT_EVENTS.ERROR) || null;
            recovered = !errorEv;
          }
        } catch (err) {
          if (!controller.signal.aborted) {
            log.warn('compaction.recover.fail', {
              message: err && err.message ? err.message : String(err),
            });
          }
        }
        if (controller.signal.aborted) errorEv = null; // 恢复期间被中止 → 走 aborted 收尾
        if (recovered) errorEv = null;
      }

      if (errorEv) {
        stopped = false;
        log.error('turn.error', {
          kind: errorEv.errorKind,
          message: errorEv.message,
        });
        return errorEv;
      }

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
