/**
 * Agent 事件常量与观察值包装。
 *
 * 事件契约见技术方案 §3.5。loop 只通过这些事件对外说话，UI 只消费这些事件，
 * 两边互不认识。
 */

import { wrapUntrusted } from './untrusted';

/** 事件名 */
export const AGENT_EVENTS = {
  START: 'agent:start',
  USER_MESSAGE: 'agent:user-message',
  TEXT_DELTA: 'agent:text-delta',
  THINKING: 'agent:thinking',
  TOOL_CALL: 'agent:tool-call',
  TOOL_RESULT: 'agent:tool-result',
  TARGET_TAB: 'agent:target-tab',
  SYSTEM_NOTICE: 'agent:system-notice',
  // T-76 上下文压缩：历史摘要事件，append-only——它之前的老事件不进 transcript
  // （historyToPiMessages 投影），也不被会话存储的 20 轮修剪裁掉（cropToTurns 锚点）。
  COMPACTION: 'agent:compaction',
  DONE: 'agent:done',
  ERROR: 'agent:error',
};

/**
 * T-41：CONFIRM / PROPOSAL 已删。
 *
 * 它们全仓零产出零消费，是 transcript 时代的展示角色残留 —— 确认流程走
 * deps.requestConfirmation 直接回调宿主，根本不经过事件流。留着会让读事件表的人
 * 以为存在一个尚未接线的 seam。eventContract.test.js 现在会拦这类僵尸常量。
 */

/** 错误归类（技术方案 §5.4） */
export const ERROR_KIND = {
  CONFIG: 'config',
  NETWORK: 'network',
  PROVIDER: 'provider',
  TOOL: 'tool',
  NO_TARGET_TAB: 'no-target-tab',
  // T-40：本地装配出错（提示词事实表构建失败一类）。原先没有这一档，
  // 这类错误的 errorKind 只能空着，UI 侧分不清它和 provider 报错的区别。
  INTERNAL: 'internal',
};

/** 工具执行状态 */
export const TOOL_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  OK: 'ok',
  ERROR: 'error',
  REJECTED: 'rejected',
};

/**
 * 错误事件的唯一构造函数（T-40）。
 *
 * AGENT_EVENTS 是 loop 与 UI 之间唯一的 seam，CONTEXT.md 明文写着「两边互不认识」。
 * 不认识的两边各写一套字段名，编译期不拦、测试期不拦、运行期静默丢信息 ——
 * 实测踩过：loop 里一处写 `error:`、一处写 `message:`，而 UI 只读
 * `message`，「事实表构建失败」的详情就永远显示不出来（只剩一句兜底文案）。
 *
 * 规则：**错误事件只能从这里出**。想加字段就改这里，然后让契约测试盯着。
 *
 * @param {{message?: *, errorKind?: string, httpStatus?: number}} input
 * @returns {{kind: string, status: string, message: string,
 *   errorKind?: string, httpStatus?: number}}
 */
export function errorEvent({ message, errorKind, httpStatus } = {}) {
  const ev = {
    kind: AGENT_EVENTS.ERROR,
    status: TOOL_STATUS.ERROR,
    message: String(message ?? '未知错误'),
  };
  // 两个字段都是可选的：归类不了的错误不硬凑，HTTP 状态没有就不带键 ——
  // 带一个 httpStatus: undefined 的键会让下游的 JSON 序列化多出一个假字段。
  if (errorKind) ev.errorKind = errorKind;
  if (httpStatus !== undefined) ev.httpStatus = httpStatus;
  return ev;
}

/** 观察值硬截断上限（8K 字符）。原在 window.js，T-82 随死接口清理并入本文件。 */
export const MAX_OBSERVATION_CHARS = 8000;

/**
 * 截断单个工具观察值。
 *
 * 只在本文件的 wrapObservation 里调用：截断必须发生在 untrusted 包装**之前**
 * （先包装后截断会把闭合标签砍掉，剩下半个标签暴露出去）。
 *
 * @param {string} text
 * @param {number=} maxChars
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateObservation(text, maxChars = MAX_OBSERVATION_CHARS) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (s.length <= maxChars) return { text: s, truncated: false };

  return {
    text: `${s.slice(0, maxChars)}\n[truncated: 超出 ${maxChars} 字符，已截断]`,
    truncated: true,
  };
}

/**
 * 把工具执行结果包成可以喂给模型、且不可逃逸的观察值。
 *
 * 页面类内容用 <untrusted_page_content>，其余用 <untrusted_tool_result>。
 * 包之前先做 8K 截断 —— 截断必须在包装之前，否则被砍掉一半的闭合标签会让
 * 剩下的半个标签暴露出去（escapeUntrustedWrappers 仍然会洗，但那是在浪费预算）。
 *
 * @param {{status?: string, payload?: *, message?: string, wrap?: string}} outcome
 * @returns {string}
 */
export function wrapObservation(outcome) {
  if (!outcome || typeof outcome !== 'object') {
    return wrapUntrusted('untrusted_tool_result', String(outcome ?? ''));
  }

  const tag =
    outcome.wrap === 'untrusted_page_content'
      ? 'untrusted_page_content'
      : 'untrusted_tool_result';

  let body;
  if (
    outcome.status === TOOL_STATUS.ERROR ||
    outcome.status === TOOL_STATUS.REJECTED
  ) {
    body = `工具未成功执行：${outcome.message || '未知原因'}`;
  } else {
    const { payload } = outcome;
    body =
      typeof payload === 'string'
        ? payload
        : JSON.stringify(payload ?? null, null, 2);
  }

  const { text, truncated } = truncateObservation(body);

  return wrapUntrusted(
    tag,
    truncated
      ? `${text}
[note: 观察值超预算已截断，需要更细的信息请换更精确的参数重新调用。]`
      : text
  );
}

/**
 * 把错误包装成观察值 —— 工具抛错不终止循环，转成 status:'error' 让模型自纠
 * （技术方案 §4.1 "错误即观察值"）。
 *
 * @param {Error|*} error
 * @returns {{status: string, message: string, wrap: string}}
 */
export function toolError(error) {
  return {
    status: TOOL_STATUS.ERROR,
    message: String(error?.message || error),
    wrap: 'untrusted_tool_result',
  };
}
