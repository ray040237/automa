/**
 * Agent 事件常量与观察值包装。
 *
 * 事件契约见技术方案 §3.5。loop 只通过这些事件对外说话，UI 只消费这些事件，
 * 两边互不认识。
 */

import { wrapUntrusted } from './untrusted';
import { truncateObservation } from './window';

/** 事件名 */
export const AGENT_EVENTS = {
  START: 'agent:start',
  USER_MESSAGE: 'agent:user-message',
  TEXT_DELTA: 'agent:text-delta',
  THINKING: 'agent:thinking',
  TOOL_CALL: 'agent:tool-call',
  TOOL_RESULT: 'agent:tool-result',
  CONFIRM: 'agent:confirm',
  PROPOSAL: 'agent:proposal',
  TARGET_TAB: 'agent:target-tab',
  SYSTEM_NOTICE: 'agent:system-notice',
  DONE: 'agent:done',
  ERROR: 'agent:error',
};

/** 错误归类（技术方案 §5.4） */
export const ERROR_KIND = {
  CONFIG: 'config',
  NETWORK: 'network',
  PROVIDER: 'provider',
  TOOL: 'tool',
  NO_TARGET_TAB: 'no-target-tab',
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
