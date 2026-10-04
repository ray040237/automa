/**
 * 把事件流折成真正发给模型的 wire 消息。
 *
 * 为什么不能直接用 transcript.js：那份是**给 UI 看的展示 transcript**，
 * 它的行是 agent-step / target-tab 这种展示角色；toWireMessages 遇到
 * 它们只会原样带过去，而 OpenAI 不认识 agent-step 这个 role。
 * 更要命的是 agent-step 一行里同时装着 call 和 result，拆不成 tool_calls + tool。
 *
 * 这里按 OpenAI 的硬约束重建：
 *   1. 带 tool_calls 的 assistant 后面必须紧跟同数量的 tool 消息，
 *   2. tool 消息必须带 tool_call_id 且 id 唯一；
 *   3. assistant 内容为空但有 tool_calls 时 content 传空串（不能省略字段）。
 *
 * 配对净化：多会话续接后，历史里可能出现「tool-call 之后没有 result」的
 * 悬空调用（上一轮被中断/abort）。悬空 tool_calls 发出去直接 400，
 * 所以收拢时对没有结果的调用合成一条中断占位 tool 消息。
 * 合成只发生在 flush 内、且结果按 id 匹配，正常路径（call → result）
 * 不会产生重复 id。
 */

/**
 * @param {Array<Object>} events
 * @param {{system?: string}=} options
 * @returns {Array<Object>} OpenAI chat messages
 */
export function buildWireMessages(events, options = {}) {
  const out = [];

  if (options.system) out.push({ role: 'system', content: options.system });

  // 同一轮的 call 与 result 攒在一起，flush 时按 id 配对补全
  let pending = null;
  const ensurePending = () => {
    if (!pending) pending = { content: '', calls: [], results: [] };
    return pending;
  };

  const flush = () => {
    if (!pending) return;

    const { content, calls, results } = pending;
    pending = null;

    if (content.trim() === '' && calls.length === 0) return;

    const msg = { role: 'assistant', content };
    if (calls.length > 0) {
      msg.tool_calls = calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.args },
      }));
    }
    out.push(msg);

    if (calls.length === 0) return;

    // 有 call 必须有 tool：没结果的（被中断）合成占位，孤儿 result 丢弃
    const byId = new Map();
    results.forEach((r) => byId.set(r.id, r.content));
    calls.forEach((c) => {
      out.push({
        role: 'tool',
        tool_call_id: c.id,
        content: byId.has(c.id)
          ? byId.get(c.id)
          : '该工具调用被中断，没有返回结果。请基于已有信息继续或重新调用。',
      });
    });
  };

  (events || []).forEach((ev) => {
    switch (ev.kind) {
      case 'agent:text-delta':
        // 已有攒着的 call-result 组再来的正文属于下一个 assistant 组
        if (pending && pending.results.length > 0) flush();
        ensurePending().content += ev.text || '';
        break;

      case 'agent:thinking':
        // 推理内容不进 wire：多数兼容端点不认 thinking/reasoning 字段，
        // 混进去会被当成普通正文展示给用户
        break;

      case 'agent:tool-call':
        if (!ev.toolCallId) break;
        // 并行调用连续到达时归入同一 assistant；但上一组已经有结果了
        // 就说明这是新一轮调用，先收拢再开组
        if (pending && pending.results.length > 0) flush();
        ensurePending().calls.push({
          id: ev.toolCallId,
          name: ev.name,
          args: JSON.stringify(ev.args ?? {}),
        });
        break;

      case 'agent:tool-result':
        // 关键：result 攒进 pending，与 call 在同一次 flush 里按 id 配对；
        // 不能先 flush 再 push，否则悬空补全会和真结果产生重复 id
        if (!ev.toolCallId || !pending) break;
        pending.results.push({
          id: ev.toolCallId,
          content: ev.observation || '',
        });
        break;

      case 'agent:user-message':
        flush();
        out.push({ role: 'user', content: ev.wire || ev.text || '' });
        break;

      case 'agent:system-notice':
        // 系统提示（pin 漂移、tab 关闭等）用 user 角色注入：
        // 多数兼容端点对「多个 system 消息」支持参差，user 是最稳的通道
        flush();
        out.push({ role: 'user', content: ev.wire || ev.text || '' });
        break;

      case 'agent:done':
      case 'agent:error':
        flush();
        break;

      default:
        // target-tab / start 等展示事件不进 wire
        break;
    }
  });

  flush();
  return out;
}
