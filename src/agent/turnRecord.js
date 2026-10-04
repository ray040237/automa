/**
 * 会话收尾：把「一轮 send 的结果」折叠成单一份 save 对象。
 *
 * T-43 抽取。原来这段活写死在 index.js 的 send 尾巴里（usage 累加、剪 THINKING、
 * 拼 save 对象），四个要点散落无人守护：
 *   ① usage 累加——result.usage 可能整个缺席（provider 不回 usage 字段）；
 *   ② THINKING 是流式碎片、不进 wire，落盘前必须剪掉否则历史无限膨胀；
 *   ③ save 对象的键集合只有这里定义一次——T-35/B1 之前同一份形状在 index.js
 *      里抄了两遍（常规收尾 + 标题回写），改一个字段漏掉另一个就是幽灵会话。
 *      标题回写现在走 sessions.js 的 patchTitle（见 T-35/B1 结论），但「收尾
 *      要有一个 record 构造入口」依然成立，T-34（转中节流落盘）的检查点
 *      save 将来也必须从这里出同一形状，不能各写各的。
 *   ④ 不变量：返回的对象是新对象，入参数组不被改写（测试夹具复用安全）。
 */

import { AGENT_EVENTS } from './events';

/**
 * 落盘前的事件清洗：剪掉流式碎片（THINKING）。
 * push 顺序保持不变，其余事件原样保留——wire 不吃 THINKING，历史里留它只会让
 * 每轮落盘体积翻倍且无人消费。
 *
 * @param {Array<Object>} events agent.getHistory() 的原始事件
 * @returns {Array<Object>} 新数组
 */
export function pruneEphemeralEvents(events) {
  return (events || []).filter((ev) => ev && ev.kind !== AGENT_EVENTS.THINKING);
}

/**
 * 累加 usage。resultUsage 可能是 undefined/部分字段缺失（provider 不保证回 usage），
 * 一律按 0 视。返回新对象，不改写入参（usageBefore 还要给返回值里用）。
 *
 * @param {{input?: number, output?: number}} usageBefore
 * @param {{input?: number, output?: number}} [resultUsage]
 * @returns {{input: number, output: number}}
 */
export function accumulateUsage(usageBefore, resultUsage) {
  const base = usageBefore || {};
  const delta = resultUsage || {};
  return {
    input: (base.input || 0) + (delta.input || 0),
    output: (base.output || 0) + (delta.output || 0),
  };
}

/**
 * 构造单一份会话 save 对象。键集合在这里钉死：
 * id / workflowId / status / createdAt / lastAccessedAt / events / pins /
 * focusedTabId / usage。title 不在这里给——新会话由 sessionStore.save 用
 * titleFromEvents 兜底，已有会话的 title 由 patchTitle 单独改写。
 *
 * @param {Object} input
 * @returns {Object}
 */
export function buildTurnRecord({
  id,
  workflowId,
  createdAt,
  events,
  pins,
  focusedTabId,
  usage,
  now,
} = {}) {
  const ts = typeof now === 'number' ? now : Date.now();
  return {
    id,
    workflowId,
    status: 'active',
    createdAt: createdAt || ts,
    lastAccessedAt: ts,
    events: events || [],
    pins: pins || [],
    focusedTabId: focusedTabId ?? null,
    usage: usage || { input: 0, output: 0 },
  };
}
