/**
 * 防注入转义：把要放进 <untrusted_*> 标签内部的第三方数据洗掉所有
 * "看起来像闭合标签" 的字面量，避免内层内容提前闭合外层包装并注入指令。
 *
 * 移植自 pie-ai-agent/src/lib/agent/untrusted-wrappers.ts（去 TS 类型），
 * 按本方案裁剪：20 个标签 -> 本项目实际使用的 6 个。
 *
 * 攻击面覆盖（原实现的全部，改动会显著削弱防护）：
 *   1. 纯 ASCII 闭合     </untrusted_page_content>
 *   2. Unicode 混淆括号  ‹/untrusted_page_content›      (U+2039 / U+203A)
 *   3. 全角括号          ＜/untrusted_page_content＞    (U+FF1C / U+FF1E)
 *   4. 数学尖括号        ⟨/untrusted_page_content⟩      (U+2329 / U+232A)
 *   5. CJK 尖括号        〈/untrusted_page_content〉      (U+3008 / U+3009)
 *   6. 零宽字符注入      </untrusted_page_content>      (U+200B-200F / U+2060 / U+FEFF)
 *   7. 带属性闭合        </untrusted_page_content foo=bar>
 *   8. 多斜杠闭合        <//untrusted_page_content>      (U+2044 / U+2215)
 *
 * 策略：先剥零宽字符（否则可以藏在标签名中间），再匹配
 * "类左尖括号 + 0..3 个斜杠变体 + 已知标签名 + 最多 200 字符非右括号载荷 + 类右尖括号"，
 * 改写成 ASCII HTML 实体。选实体而非 Unicode 形近字符，是因为攻击者可以预先用形近字符污染内容，
 * 而实体在任何标记语法里都不可能是标签。
 *
 * 诚实说明：这是纵深防御，不是完备防御。它能挡住"字面量逃逸"这一类注入，
 * 但不承诺 100% 阻断 prompt 注入。真正的兜底是写操作必须由人点确认。
 */

export const UNTRUSTED_WRAPPER_TAGS = [
  'untrusted_page_content',
  'untrusted_tab_metadata',
  'untrusted_workflow_context',
  'untrusted_user_message',
  'untrusted_tool_result',
  'untrusted_compacted_steps',
  'untrusted_system_notice',
];

// 零宽 / 不可见字符：U+200B..U+200F（零宽空格/ZWNJ/ZWJ/LRM/RLM）、U+2060（word joiner）、U+FEFF（BOM）
const ZERO_WIDTH_RE = /[\u200B-\u200F\u2060\uFEFF]/g; // 必须用 \u 转义而非字面量：不可见字符在源码里不可 review，一次复制粘贴就会静默丢失

const LT_CLASS = '[\u003c\u2039\u2329\u3008\uff1c]';
const GT_CLASS = '[\u003e\u203a\u232a\u3009\uff1e]';
const NOT_GT_CLASS = '[^\u003e\u203a\u232a\u3009\uff1e]';
// 斜杠变体：ASCII /、U+2044 分数斜杠、U+2215 除法斜杠。0..3 个容忍 <tag> / </tag> / <//tag>
const SLASH_CLASS = '[\u002f\u2044\u2215]';

const TAG_ALT = UNTRUSTED_WRAPPER_TAGS.join('|');

const WRAPPER_RE = new RegExp(
  `${LT_CLASS}\\s*${SLASH_CLASS}{0,3}\\s*(?:${TAG_ALT})${NOT_GT_CLASS}{0,200}${GT_CLASS}`,
  'gi'
);

/**
 * 洗掉内容里所有能构成 <untrusted_*> 标签的字面量。
 * @param {*} text 任意值，非字符串按空串处理
 * @returns {string}
 */
export function escapeUntrustedWrappers(text) {
  if (!text || typeof text !== 'string') return '';
  const noZeroWidth = text.replace(ZERO_WIDTH_RE, '');
  return noZeroWidth.replace(WRAPPER_RE, (match) => {
    const inner = match.slice(1, -1);
    return `&lt;${inner}&gt;`;
  });
}

/**
 * 洗掉开标签属性值里的 < > "，防 "?>x="><fake..." 终止属性后伪造新标签边界。
 * 只用于开标签的属性，闭合标签与标签体由 escapeUntrustedWrappers 负责。
 */
export function escapeWrapperAttribute(value) {
  if (!value || typeof value !== 'string') return '';
  return value
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 构造完整的 untrusted 包装。attrs 的值会自动过 escapeWrapperAttribute。
 *
 * @param {string} tag     UNTRUSTED_WRAPPER_TAGS 之一
 * @param {*} content      第三方数据，内部会被 escapeUntrustedWrappers 清洗
 * @param {object=} attrs  开标签属性，如 { url, title }
 * @returns {string}
 */
export function wrapUntrusted(tag, content, attrs) {
  if (!UNTRUSTED_WRAPPER_TAGS.includes(tag)) {
    throw new Error(`unknown untrusted wrapper tag: ${tag}`);
  }

  const attrStr = Object.entries(attrs || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${escapeWrapperAttribute(String(v))}"`)
    .join('');

  const body = content === undefined || content === null ? '' : String(content);

  return `<${tag}${attrStr}>\n${escapeUntrustedWrappers(body)}\n</${tag}>`;
}
