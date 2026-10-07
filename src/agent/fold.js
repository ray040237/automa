/**
 * 事件流 -> 渲染槽位的折叠层（纯逻辑，**不碰 Vue、不碰 i18n 实例**）。
 *
 * 为什么从 AgentTranscript.vue 里搬出来：这段是全仓分支最多的 UI 逻辑 —— 8 个事件
 * 分支、tool 卡按 toolCallId 配对合并、换会话整表重放、同类型 delta 并槽，90 行全在
 * 一个 SFC 的 script setup 里。而本仓此前**挂不上组件测试**，这些分支一条都测不到
 * （T-53 登记时的证据：27 个测试文件全在 src/agent/ 下，.vue 相关 0 个）。
 * 现在有三层了：静态守卫（panelUi.test.js）看接线、渲染测试（panelRender.test.js，
 * T-128①）看 DOM，而**折叠规则本身**由本文件与 fold.test.js 钉住。
 *
 * 为什么是 createFolder() 增量式而不是 foldEvents(events) 纯函数：纯函数版每来一个
 * delta 都要把整段历史重折一遍，是 T-14 已登记的 O(n²) 问题。这里保留游标语义：
 * 同一个事件数组只处理游标之后的新事件，换数组（换会话）才整表重放。
 *
 * 命名红线：CONTEXT.md 废弃 transcript 一词，本模块不沿用。
 */
import { AGENT_EVENTS, TOOL_STATUS } from './events';

/**
 * 建一个折叠器。
 *
 * @param {Object} [opts]
 * @param {any[]} [opts.items] 目标数组。组件传 reactive([])（这样 push/并槽的改动
 *   能被 Vue 追踪），测试传普通数组即可。
 * @param {(key: string) => string} [opts.t] 翻译函数。**只有一处**用到：错误事件没有
 *   message 时兜底成「出了点问题」。默认原样返回键名 —— 折叠层不做文案决策。
 */
export function createFolder(opts = {}) {
  const items = opts.items ?? [];
  const t = typeof opts.t === 'function' ? opts.t : (key) => key;

  let cursor = 0;
  let previousSource = null;
  let seed = 0;

  function push(item) {
    seed += 1;
    item.key = seed;
    items.push(item);
  }

  /** 同类型的连续 delta 追加到同一个槽位，不另起一块 */
  function appendDelta(type, text) {
    const last = items[items.length - 1];
    if (last && last.type === type) {
      last.raw += text;
      return;
    }
    push({ type, raw: text, open: false });
  }

  /**
   * 「重试」用哪条问题：出错这一轮之前最近的一条用户消息。找不着就返回空串 ——
   * 组件据此不给「重试」按钮。
   */
  function lastUserText() {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i].type === 'user') return items[i].text || '';
    }
    return '';
  }

  /**
   * 同一张工具卡按 toolCallId 配对（call 与 result 合并）。
   *
   * 旧键是 name+step：同名并行调用（一条消息里两次 read_page）会互相覆盖参数与
   * 观察值；事件流已按调用拆开（T-74 方案 B），这里按 id **从后往前**找归属卡 ——
   * 并行时事件交错，归属卡不一定就是最后一张。
   *
   * @returns {object|null} 命中的槽位 step，未命中返回 null（调用方自己 push）
   */
  function findToolStep(toolCallId) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (it.type === 'tool' && it.step.toolCallId === toolCallId) {
        return it.step;
      }
    }
    return null;
  }

  function apply(ev) {
    if (!ev) return;

    switch (ev.kind) {
      // T-09：START 折成一条轮次分隔线（以前一律落 default 被丢弃，长会话回看时
      // 分不清哪段是哪一轮）。at 由 loop 发事件时就带上 —— 回看历史会话时必须是
      // 真实发生时刻，用渲染时刻会显示成「打开的时间」。
      case AGENT_EVENTS.START:
        push({ type: 'turn', at: ev.at || 0 });
        return;
      case AGENT_EVENTS.TEXT_DELTA:
        appendDelta('text', ev.text || '');
        return;
      case AGENT_EVENTS.THINKING:
        appendDelta('thinking', ev.text || '');
        return;
      case AGENT_EVENTS.USER_MESSAGE:
        push({ type: 'user', text: ev.text || '' });
        return;
      case AGENT_EVENTS.SYSTEM_NOTICE:
        push({ type: 'notice', text: ev.text || '' });
        return;
      case AGENT_EVENTS.COMPACTION:
        push({
          type: 'compaction',
          raw: ev.summary || '',
          turns: ev.summarizedTurns || 0,
          open: false,
        });
        return;
      case AGENT_EVENTS.ERROR:
        // T-04：单独一类 'error'，不再混进 notice 的琥珀通道
        push({
          type: 'error',
          text: ev.message || t('workflow.agent.error'),
          kind: ev.errorKind || '',
          ...(ev.httpStatus !== undefined ? { httpStatus: ev.httpStatus } : {}),
          // 「重试」拿出错这一轮之前最近的那条用户消息
          retryText: lastUserText(),
        });
        return;
      case AGENT_EVENTS.TOOL_CALL:
      case AGENT_EVENTS.TOOL_RESULT: {
        const step = {
          name: ev.name,
          step: ev.step,
          toolCallId: ev.toolCallId,
          args: ev.args,
          status: ev.status || TOOL_STATUS.RUNNING,
          observation: ev.observation,
        };
        const target = findToolStep(ev.toolCallId);
        if (target) {
          // 合并进已有的卡。字段「有才覆盖」：result 事件不带 args，直接赋值会把
          // call 阶段记下的参数抹成 undefined。
          Object.assign(target, {
            status: step.status,
            observation:
              ev.observation !== undefined
                ? ev.observation
                : target.observation,
            args: ev.args !== undefined ? ev.args : target.args,
          });
        } else {
          push({ type: 'tool', step });
        }
        // break 而不是 return：no-fallthrough 认不出块级声明里最后一个 return
        break;
      }
      default:
      // done / target-tab 不产生对话内容
    }
  }

  /**
   * 吃进一个事件数组。同一数组只处理游标之后的新事件；换了数组（换会话）整表重放。
   *
   * @param {any[]} source 事件数组
   * @returns {number} 折完后的槽位总数
   */
  function sync(source) {
    const list = source || [];
    if (list !== previousSource) {
      items.length = 0;
      cursor = 0;
      previousSource = list;
    }
    for (; cursor < list.length; cursor += 1) {
      apply(list[cursor]);
    }
    return items.length;
  }

  /** 清空并把游标归零（换会话、宿主重置时用） */
  function reset() {
    items.length = 0;
    cursor = 0;
    previousSource = null;
    seed = 0;
  }

  return {
    items,
    apply,
    sync,
    reset,
    lastUserText,
    cursor: () => cursor,
  };
}
