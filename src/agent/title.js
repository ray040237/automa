/**
 * LLM 会话标题（P3）。
 *
 * 标题兜底是首条用户消息前缀（sessions.titleFromEvents），LLM 标题是锦上添花：
 * 生成失败/超时/限流都静默回退到兜底，绝不因为标题把对话拖住。
 * 首轮对话结束后才触发，每个会话只花一次小请求。
 */

const MAX_TITLE_CHARS = 24;
const MAX_SNIPPET = 200;

/**
 * 组装标题生成的消息（纯函数，测试直接跑）。
 *
 * @param {string} userText 用户首条消息
 * @param {string=} replyText 助手首轮回答（可选，帮助判断主题）
 * @returns {Array<{role: string, content: string}>}
 */
export function buildTitleMessages(userText, replyText) {
  return [
    {
      role: 'system',
      content:
        '为这段人机对话起一个简短标题。要求：不超过 16 个字；用用户的语言；' +
        '概括用户想做的是什么；只输出标题本身，不要引号、句号或任何解释。',
    },
    {
      role: 'user',
      content: [
        '用户: ' + String(userText || '').slice(0, MAX_SNIPPET),
        replyText ? '助手: ' + String(replyText).slice(0, MAX_SNIPPET) : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

/**
 * 清洗模型输出：去引号/空白/截断。不合法（空）返回 null。
 *
 * @param {string} raw
 * @returns {string|null}
 */
/**
 * 标题统一截断（24 字 + 省略号）。sessions.titleFromEvents 与 cleanTitle 共用，
 * 两处口径不一致会出现「列表里 24 字、重开又变 25 字」这种小漂移。
 *
 * @param {string} t 已清洗的标题
 * @returns {string}
 */
export function truncateTitle(t) {
  return t.length > MAX_TITLE_CHARS ? t.slice(0, MAX_TITLE_CHARS) + '…' : t;
}

export function cleanTitle(raw) {
  const t = String(raw || '')
    .split('\n')[0]
    .trim()
    .replace(/^["'「『《]+|["'」』》。]+$/g, '')
    .trim();

  if (!t) return null;
  return truncateTitle(t);
}
