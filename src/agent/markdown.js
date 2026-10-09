/**
 * agent 正文的 markdown 渲染。
 *
 * 分工（T-176 换库时定下，改之前先读）：
 *   - **解析**交给 marked：块结构、嵌套列表、任务列表、表格、行内强调的配对、
 *     反引号转义这些最容易写错的规则，用成熟库取代原来那份手搓正则。
 *     手搓版实测有真 bug：`1. step` 换行 `   - bullet` 会被当列表续行**吞掉**；
 *     嵌套列表 depth 被 `Math.min(1, …)` 截成一层；任务列表不认；有序起始号丢失。
 *   - **渲染**仍留在自己手里：marked 只做词法（`Lexer.lex` / `Lexer.lexInline`
 *     拿 token 树），HTML 由本模块逐个 token 自己拼。
 *
 * 为什么不直接 `marked.parse()` 吐 HTML（安全底线，改之前先读）：
 *   正文全部来自模型，是不可信输入。marked 默认**原样透传**源码里的 HTML，
 *   所以要安全就得再过一道 DOMPurify —— 那是「先渲染、再过滤掉已知的坏」，
 *   比「结构上不可能注入」弱一档。自己渲染则能维持这条不变量：白名单以外的
 *   token（含源码里手写的 `<script>` / `<img onerror>`）一律按纯文本转义。
 *   顺带还拿到两样 marked 的 HTML 串给不了的东西：代码块原文（挂复制按钮）
 *   与表格结构（委托给 AgentTable）。
 *
 * 流式友好：围栏未闭合、表格缺分隔行等情况按「还没写完」处理，不抛异常
 * （marked 的词法器本身也不抛，实测过 `'```'`、`'| a |\n|'`、`'[未闭合](https://'`）。
 */

import { Lexer } from 'marked';

const HTML_ESCAPE = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;

/**
 * gfm  —— 表格、任务列表、删除线、裸 URL 自动成链（换库前手搓版已覆盖的部分）。
 * breaks —— 软换行按 `<br>` 渲染。换库前的实现是把段落/引用的连续行
 *   `join('<br>')`，所以这里保持一致，前端观感零变化（也免得正文里的换行
 *   被 HTML 折叠成空格）。
 */
const MD_OPTIONS = { gfm: true, breaks: true };

const CODE_CLASS = 'rounded bg-gray-100 px-1 py-0.5 dark:bg-gray-800';

// 只服务于 advanceCut 的切点判定（找围栏行），不参与渲染 —— 渲染全是 marked 的事。
const FENCE_OPEN = /^\s*(?:```|~~~)\s*([\w+#.-]*)\s*$/;
const FENCE_CLOSE = /^\s*(?:```|~~~)\s*$/;

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]);
}

/** 只放行不会执行脚本的协议；其余返回空串，由调用方降级处理。 */
export function safeHref(raw) {
  const href = String(raw ?? '').trim();
  return SAFE_URL.test(href) ? href : '';
}

/**
 * 单个 token → HTML 片段。
 *
 * 白名单之外**一律按纯文本转义**（宁可多转义，不肯漏）—— 这就是「转义优先」
 * 不变量的落点：marked 只负责把源码切成 token，任何来自源码的 `html`
 * （`<script>`、带 `onerror` 的 `<img>`…）到这儿都还只是字符串，被 escapeHtml。
 */
function emitToken(tok) {
  const { text = '', tokens = null, href = '', raw = '' } = tok;

  switch (tok.type) {
    case 'text':
    case 'escape':
      // marked 的 text token 有时自带子 token（例如被软换行切开的那半段）
      return tokens && tokens.length ? emitTokens(tokens) : escapeHtml(text);

    case 'codespan':
      return `<code class="${CODE_CLASS}">${escapeHtml(text)}</code>`;

    case 'br':
      return '<br>';

    // 任务列表的勾选框：**不是内容**，是列表项的一个 UI 附属，由模板画成
    // 真正的 <input type="checkbox">（勾选态来自 item.checked）。
    // marked v16 会把 `[ ] ` 直接从 item.tokens 里剥掉，v18 起则留下一个
    // `checkbox` token —— 不显式吃掉它，v18 上正文就会多出一段字面的 "[ ] "。
    // （跨版本差异靠这条 + markdown.test.js 的任务列表断言兜住。）
    case 'checkbox':
      return '';

    case 'strong':
      return `<strong>${emitTokens(tokens)}</strong>`;

    case 'em':
      return `<em>${emitTokens(tokens)}</em>`;

    case 'del':
      return `<del>${emitTokens(tokens)}</del>`;

    // 裸 URL / 自动链接 / [label](href) 在 marked 里都是 link token
    case 'link':
    case 'url': {
      const label = emitTokens(tokens) || escapeHtml(text);
      const safe = safeHref(href);
      // 危险协议降级成可读文本：留 label 让用户看懂这句写的是什么，
      // 但不把 javascript: 原样甩出去
      if (!safe) return label;
      return `<a href="${escapeHtml(
        safe
      )}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
    }

    case 'image':
      // 图片一律降级成 alt 文本：正文里的外链图既不可控，也不该自动发起请求
      return escapeHtml(text);

    default:
      // 'html'（源码里手写的标签）以及任何不认识的 token
      if (tokens && tokens.length) return emitTokens(tokens);
      return escapeHtml(text || raw);
  }
}

function emitTokens(tokens, out = []) {
  for (const tok of tokens || []) {
    if (tok) out.push(emitToken(tok));
  }
  return out.join('');
}

/** 行内渲染的公开入口：粗体、斜体、删除线、行内代码、链接、裸 URL、转义。 */
export function renderInline(text) {
  const src = String(text ?? '');
  return src ? emitTokens(Lexer.lexInline(src, MD_OPTIONS)) : '';
}

/**
 * 列表项里的行内内容。子列表（nested `list` token）在这里**跳过** ——
 * 它由 listItems 递归展开成带 depth 的独立项，不能混进父项的文字里。
 */
function itemInline(item) {
  const out = [];
  for (const tok of item.tokens || []) {
    if (!tok || tok.type === 'list') continue;
    // 松散列表项里的段落分隔，按换行处理
    out.push(tok.type === 'space' ? { type: 'br' } : tok);
  }
  return out;
}

/**
 * 把 marked 的嵌套 list token 拍平成「带 depth 的项数组」。
 *
 * 拍平而不是渲染成嵌套的 <ul>：模板里一个 v-for 就能画完，且深度直接变成
 * 缩进、每项自带 marker（有序/无序可以在同一个列表里混）。
 * 有序项的序号按「同层计数」推：marked 只在 list 上给 start，不给每项序号。
 */
function listItems(list, depth, out) {
  const { items = [], ordered = false, start = 1 } = list;
  let n = ordered ? (Number(start) || 1) - 1 : 0;

  for (const item of items) {
    if (!item) continue;
    if (ordered) n += 1;

    out.push({
      html: emitTokens(itemInline(item)),
      depth,
      ordered,
      marker: ordered ? `${n}.` : '•',
      task: Boolean(item.task),
      checked: Boolean(item.checked),
    });

    for (const child of item.tokens || []) {
      if (child && child.type === 'list') listItems(child, depth + 1, out);
    }
  }

  return out;
}

/** 引用块：内部块（段落/列表/…）拍成一段带 <br> 的文本。 */
function quoteHtml(tokens) {
  const parts = [];

  for (const tok of tokens || []) {
    if (!tok || tok.type === 'space' || tok.type === 'table') continue;

    if (tok.type === 'list') {
      for (const item of tok.items || []) {
        parts.push(emitTokens(itemInline(item)));
      }
      continue;
    }

    const { tokens: inner = null, text = '' } = tok;
    if (inner && inner.length) parts.push(emitTokens(inner));
    else if (typeof text === 'string' && text) parts.push(escapeHtml(text));
  }

  return parts.filter(Boolean).join('<br>');
}

/**
 * 正文切成渲染块。
 *
 * @returns {Array<{
 *   type: 'p'|'heading'|'code'|'quote'|'list'|'table'|'hr',
 *   html?: string, lang?: string, code?: string, level?: number,
 *   ordered?: boolean,
 *   items?: Array<{html: string, depth: number, ordered: boolean,
 *                  marker: string, task: boolean, checked: boolean}>,
 *   head?: string[], align?: string[], rows?: string[][]
 * }>}
 */
export function markdownToBlocks(raw) {
  const src = String(raw ?? '');
  if (!src.trim()) return [];

  const blocks = [];

  for (const tok of Lexer.lex(src, MD_OPTIONS)) {
    if (!tok) continue;
    const { type } = tok;

    if (type === 'space') continue;

    if (type === 'heading') {
      const { depth = 1, tokens } = tok;
      blocks.push({
        type: 'heading',
        level: Math.min(6, Math.max(1, depth)),
        html: emitTokens(tokens),
      });
      continue;
    }

    if (type === 'paragraph') {
      const html = emitTokens(tok.tokens);
      if (html) blocks.push({ type: 'p', html });
      continue;
    }

    if (type === 'code') {
      const { lang = '', text = '' } = tok;
      blocks.push({
        type: 'code',
        lang: String(lang).trim().split(/\s+/)[0],
        code: text,
      });
      continue;
    }

    if (type === 'blockquote') {
      blocks.push({ type: 'quote', html: quoteHtml(tok.tokens) });
      continue;
    }

    if (type === 'hr') {
      blocks.push({ type: 'hr' });
      continue;
    }

    if (type === 'list') {
      const { ordered = false } = tok;
      const items = [];
      listItems(tok, 0, items);
      if (items.length) blocks.push({ type: 'list', ordered, items });
      continue;
    }

    if (type === 'table') {
      const { header = [], align = [], rows = [] } = tok;
      blocks.push({
        type: 'table',
        head: header.map((cell) => emitTokens(cell.tokens)),
        align: align.map((a) => a || ''),
        rows: rows.map((row) => row.map((cell) => emitTokens(cell.tokens))),
      });
      continue;
    }

    if (type === 'html') {
      const { text = '', raw: rawText = '' } = tok;
      // 源码里手写的 HTML 块：按纯文本转义后当段落渲染
      const html = escapeHtml(text || rawText).replace(/\s+$/, '');
      if (html.trim()) blocks.push({ type: 'p', html });
      continue;
    }

    // 其余块类型（def/list_item 等）在 gfm 默认配置下不会出现在顶层；
    // 真出现的话按段落兜底，不静默丢内容。
    if (tok.tokens) {
      const html = emitTokens(tok.tokens);
      if (html) blocks.push({ type: 'p', html });
    }
  }

  return blocks;
}

/**
 * 围栏外的一个空行就是块边界 —— 上面每个块都收在空行或块起始处，
 * 所以按空行切开后分段解析的结果与整段解析一致。唯一的例外是代码围栏：
 * 围栏里的空行是代码内容，不能切。切点判定必须与解析器对「围栏行」的
 * 认定一致，否则会切出半截围栏（下面 advanceCut 就是这么做的）。
 */
function advanceCut(text, from) {
  let fence = false;
  let lineStart = from;
  let safe = from;

  while (lineStart < text.length) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd);

    if (fence) {
      if (FENCE_CLOSE.test(line)) fence = false;
    } else if (FENCE_OPEN.test(line)) {
      fence = true;
    } else if (!line.trim() && nl !== -1) {
      // nl !== -1 是硬条件：这个空行必须**已经被换行终止**才算切点。
      // delta 是按 token 来的，会切在一行中间 —— 此时看到的「空行」可能只是
      // 下一行的前缀（两个空格 + 后面还要来的「补充：…」）。提前切掉的话，
      // 解析器会把后续内容当成新块，而整段解析会把它并进上一条列表项：
      // 列表续行规则要求的正是「缩进 + 非空」。
      safe = lineEnd + 1;
    }

    if (nl === -1) break;
    lineStart = lineEnd + 1;
  }

  return Math.min(safe, text.length);
}

/**
 * 流式增量解析（T-14）。
 *
 * 问题：`blocks = computed(() => markdownToBlocks(raw))`，而 raw 每来一个 delta 就变一次，
 * 于是整段被反复重解析，累计成本随回答长度**平方**增长。
 *
 * 手法与换库前一致：已确定完成的块缓存起来，只重解析「最后一个还没写完的块」。
 * 换库只动了 `parse` 的实现（marked 词法），切点策略不变 —— 所以
 * markdownStream.test.js 那套「随机切分的结果必须与整段解析完全一致」的
 * 等价性断言继续有效，也是这次换库最重要的回归网。
 *
 * 实测（本机 node，2026-10-09 改用 marked 后重测，样本是重复的「标题+段落+
 * 列表+代码块+表格」单元）：
 *   单次整段解析 2K 字 2.5ms / 10K 字 5.2ms / 40K 字 15ms —— 比手搓版慢约
 *   6~7 倍（marked 的词法本身重得多），但绝对值仍是毫秒级，不在掉帧量级；
 *   真正贵的是**累计**：20K 字按 40 字一个 delta，缓存式累计 **47ms**，
 *   不做缓存（每轮整段重解析）**1926ms**，约 **41 倍**。
 *   渲染侧（浏览器里的 DOM patch）仍未实测 —— 这里只按可测的解析成本下判断。
 *
 * 契约：`push(text)` 接整段文本（不是增量片段），内部自己算差量；返回当前全部块。
 *   text 不是已收文本的追加（换了会话 / 组件复用）时自动整体重来。
 *   `parsed()` 是累计交给 markdownToBlocks 的字符数，给测试断言「缓存真的在生效」。
 */
export function createMarkdownStream() {
  let raw = '';
  let cut = 0;
  let done = [];
  let parsed = 0;

  const parse = (text) => {
    parsed += text.length;
    return markdownToBlocks(text);
  };

  const all = () => done.concat(parse(raw.slice(cut)));

  return {
    blocks: all,
    push(text) {
      const next = String(text ?? '');
      if (next !== raw && !next.startsWith(raw)) {
        raw = next;
        cut = 0;
        done = [];
        parsed = 0;
      } else {
        raw = next;
      }

      const nextCut = advanceCut(raw, cut);
      if (nextCut > cut) {
        done = done.concat(parse(raw.slice(cut, nextCut)));
        cut = nextCut;
      }

      return all();
    },
    reset() {
      raw = '';
      cut = 0;
      done = [];
      parsed = 0;
    },
    parsed: () => parsed,
    text: () => raw.length,
  };
}
