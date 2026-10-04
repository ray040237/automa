/**
 * 上下文窗口管理：token 估算、单个观察值截断、陈旧观察值剔除、超预算裁剪。
 *
 * 移植并改造自 pie-ai-agent/src/lib/agent/window-token-budget.ts。
 *
 * 与原实现的三处必要差异：
 *  1. 保守口径：原 CHARS_PER_TOKEN 2.5 / CJK 1.2 在 agent 场景（HTML 属性、URL、
 *     JSON 标点这些 BPE 效率极低的内容占大头）系统性低估 40-47%。按技术方案
 *     §4.2 调为 1.5 / 0.7 —— 两个方向的代价不对称：低估会让压缩触发得太晚
 *     （真实已超窗、请求直接失败），高估只是多压一次。
 *  2. 裁剪单元改成 OpenAI 形状：原实现丢 (user, assistant) 对，但 OpenAI wire 里
 *     tool 消息必须与产生它的 assistant.tool_calls 成对出现，否则 400。
 *     这里丢的是 (user, assistant, 其后连续的 tool*) 整组。
 *  3. contextWindow 由配置项给定（BYOK 场景模型元数据枚举不到）。
 */

/**
 * 每 token 的字符数（安全上界，非精确估计）。
 * @see 顶部注释第 1 点
 */
export const CHARS_PER_TOKEN = 1.5;
export const CJK_CHARS_PER_TOKEN = 0.7;

/** 触发裁剪的阈值占 contextWindow 的比例 */
export const BUDGET_THRESHOLD_RATIO = 0.8;

/** 单个工具观察值的字符上限 */
export const MAX_OBSERVATION_CHARS = 8000;

/** BYOK 场景下的保守默认值，用户可在配置里按自己的模型调大 */
export const DEFAULT_CONTEXT_WINDOW = 32000;

/** 被剔除的陈旧页面观察值的占位文本 */
export const STALE_MARKER =
  '<untrusted_compacted_steps>此前的页面快照已被压缩，模型仍可继续基于最新一次观察行动。</untrusted_compacted_steps>';

// CJK 范围：统一表意文字、假名、扩展 A、谚文音节
const CJK_REGEX = /[\u4E00-\u9FFF\u3040-\u30FF\u3400-\u4DBF\uAC00-\uD7AF]/g;

/**
 * 估算一组消息的 token 数。
 *
 * CJK 比例在整个拼接文本上计算一次，保证混合语种的对话只用一套除数。
 *
 * @param {Array<{role: string, content: *}>} messages
 * @returns {number}
 */
export function estimateTokens(messages) {
  const combined = messages
    .map((m) => {
      const text = typeof m.content === 'string' ? m.content : '';
      // tool_calls 的参数也是 prompt 的一部分，且 assistant 的 content 恒为字符串
      // （哪怕是空串），所以不能因为 content 是字符串就提前返回。
      const args = (m.tool_calls || [])
        .map((c) => `${c.function?.name || ''}${c.function?.arguments || ''}`)
        .join('');
      return text + args;
    })
    .join('');

  const totalChars = combined.length;
  if (totalChars === 0) return 0;

  const cjkChars = combined.match(CJK_REGEX)?.length || 0;
  const divisor =
    cjkChars / totalChars > 0.5 ? CJK_CHARS_PER_TOKEN : CHARS_PER_TOKEN;

  return Math.ceil(totalChars / divisor);
}

/**
 * 截断单个工具观察值。
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
 * 剔除陈旧的页面观察值。
 *
 * 除最近一轮工具调用外，所有 role:'tool' 且内容以 <untrusted_page_content 开头的
 * 观察值，替换为占位符。必须保留 role/tool_call_id 本身 —— OpenAI wire 要求
 * 每条 assistant.tool_calls 都有对应的 tool 消息，删掉会直接 400。
 *
 * 不移植 pie 的 elide-stale-observations.ts：它绑定对方的 content-block 结构，
 * 这里用等价的简化实现。
 *
 * @param {Array<Object>} messages
 * @returns {Array<Object>}
 */
export function elideStaleObservations(messages) {
  // 找出最后一轮 assistant 发起的工具调用的位置
  let lastToolGroupStart = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'tool') {
      lastToolGroupStart = i;
    } else if (lastToolGroupStart !== -1) {
      break;
    }
  }

  return messages.map((m, i) => {
    if (m.role !== 'tool') return m;
    if (i >= lastToolGroupStart) return m;
    if (typeof m.content !== 'string') return m;
    if (!m.content.trimStart().startsWith('<untrusted_page_content')) return m;

    return { ...m, content: STALE_MARKER, elided: true };
  });
}

/**
 * 按预算裁剪历史。
 *
 * 丢弃单元是 (user, assistant, 其后连续的 tool*) 整组 —— 因为 OpenAI 要求
 * tool 消息与产生它的 tool_calls 配对。只丢一半会直接 400。
 *
 * 约束：永不丢 system；永不丢最后一轮 user。
 *
 * @param {Array<Object>} messages
 * @param {{contextWindow?: number}=} options
 * @returns {{ messages: Array<Object>, estimated: number, threshold: number, dropped: number }}
 */
export function applyTokenBudget(messages, options = {}) {
  const contextWindow = options.contextWindow || DEFAULT_CONTEXT_WINDOW;
  const threshold = contextWindow * BUDGET_THRESHOLD_RATIO;

  let result = messages;
  let dropped = 0;

  while (estimateTokens(result) > threshold) {
    const next = dropOldestTurn(result);
    if (!next) break;
    result = next;
    dropped += 1;
  }

  return {
    messages: result,
    estimated: estimateTokens(result),
    threshold,
    dropped,
  };
}

/**
 * 丢掉最旧的一整个对话轮，返回 null 表示已无可丢。
 *
 * 两级策略：
 *   1. 优先丢整组 (user, assistant, 其后连续的 tool*) —— 语义干净，整轮上下文一起消失；
 *   2. 整组法对不上任何候选时（典型：单轮 send 的 wire 里只有 index=1 一个 user，
 *      第一个候选就撞上 `i >= lastUserIdx` → break），退化成「在最后一轮内部
 *      从最旧的一组 assistant+tool* 开始丢」。没有第 2 级，一轮 12 步攒的
 *      12 份页面快照一条都丢不掉，applyTokenBudget 形同虚设（T-25）。
 *
 * @param {Array<Object>} messages
 * @returns {Array<Object>|null}
 */
function dropOldestTurn(messages) {
  const lastUserIdx = lastUserIndex(messages);

  for (let i = 1; i < messages.length; i += 1) {
    if (messages[i].role !== 'user') continue;
    if (i >= lastUserIdx) break; // 到当前任务为止，停下

    let end = i + 1;
    if (messages[end]?.role !== 'assistant') continue;
    end += 1;
    while (messages[end]?.role === 'tool') end += 1;

    return [...messages.slice(0, i), ...messages.slice(end)];
  }

  return dropOldestStepInLastTurn(messages, lastUserIdx);
}

/** 最后一条 user 消息的下标；没有返回 -1。 */
function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

/**
 * 单轮内降级：丢掉最后一轮里最旧的一组 (assistant, tool*)。
 *
 * 安全边界（每条都对应一个 wire 400）：
 *   - 只在最后一个 user **之后**找组 —— system 与任何 user 都不参与；
 *   - assistant 与其后连续的 tool 一起丢，绝不留孤儿 tool 消息；
 *   - 只剩一组时返回 null —— 最近那组是当前步骤的现场，丢了模型就没有行动依据，
 *     宁可如实超预算（交给 provider 报错）也不要交一份没有现场的上下文。
 *
 * @param {Array<Object>} messages
 * @param {number} lastUserIdx
 * @returns {Array<Object>|null}
 */
function dropOldestStepInLastTurn(messages, lastUserIdx) {
  const groups = [];

  for (let i = Math.max(lastUserIdx, -1) + 1; i < messages.length; i += 1) {
    if (messages[i].role !== 'assistant') continue;

    let end = i + 1;
    while (messages[end]?.role === 'tool') end += 1;

    groups.push([i, end]);
    i = end - 1;
  }

  if (groups.length <= 1) return null;

  const [start, end] = groups[0];

  return [...messages.slice(0, start), ...messages.slice(end)];
}
