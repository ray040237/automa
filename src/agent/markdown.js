/**
 * agent 正文的极简 markdown 渲染。
 *
 * 为什么自己写：本机装不上 npm 依赖，仓库里也没有 markdown 库可复用。
 * 为什么输出 token 数组而不是一整串 HTML：代码块要在 UI 上单独挂复制按钮，
 * 塞进 HTML 里就只能用 JS 事后补，不如一开始就把结构交出去。
 *
 * 安全底线（改之前先读）：
 * 正文全部来自模型，是不可信输入。流程是「先转义 → 再做行内替换」，
 * 任何情况下模型写进来的 script 标签、带 onerror 的 img 都只会落成可见文本。
 * 代码围栏里的内容保持原始字符串不转义，由 UI 用插值渲染（Vue 自带转义）。
 * 链接只允许 http/https/mailto，其余协议（javascript:、data:、vbscript:）
 * 一律降级成纯文本。
 *
 * 流式友好：围栏未闭合、表格缺分隔行等情况按「还没写完」处理，不抛异常。
 */

const HTML_ESCAPE = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]);
}

/** 只放行不会执行脚本的协议；其余返回空串，由调用方降级处理。 */
export function safeHref(raw) {
  const href = String(raw ?? '').trim();
  return SAFE_URL.test(href) ? href : '';
}

/**
 * 行内渲染：粗体、斜体、删除线、行内代码、链接、裸 URL。
 *
 * 输入是未转义的原文，输出可安全交给 v-html。行内代码先摘出来占位，
 * 免得代码块里的星号被当成强调符号再解析一遍。
 */
export function renderInline(text) {
  const codes = [];
  let source = escapeHtml(text);

  source = source.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `@@CODE${codes.length - 1}@@`;
  });

  source = source
    .replace(
      /!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g,
      (whole, label, href) => {
        const safe = safeHref(href);
        // 危险协议降级成可读文本：留 label 让用户还能看懂这句写的是什么，
        // 但不能把 javascript: 这种原样甩出去吓人
        if (!safe) return label || '';
        if (whole.startsWith('!')) return label || '';
        return `<a href="${safe}" target="_blank" rel="noopener noreferrer nofollow">${
          label || safe
        }</a>`;
      }
    )
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, '<em>$1</em>')
    // 裸 URL 自动成链。前面限定是行首或空白，避免二次匹配我们刚生成的 href="..."
    .replace(
      /(^|[\s(])((?:https?:\/\/)[^\s<>"']+)/g,
      (_, lead, url) =>
        `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`
    );

  return source.replace(/@@CODE(\d+)@@/g, (_, index) => {
    return `<code class="rounded bg-gray-100 px-1 py-0.5 dark:bg-gray-800">${
      codes[Number(index)] ?? ''
    }</code>`;
  });
}

const FENCE_OPEN = /^\s*(?:```|~~~)\s*([\w+#.-]*)\s*$/;
const FENCE_CLOSE = /^\s*(?:```|~~~)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function alignOf(spec) {
  if (/^:.*:$/.test(spec)) return 'center';
  if (/:$/.test(spec)) return 'right';
  if (/^:/.test(spec)) return 'left';
  return '';
}

function isBreakAhead(line) {
  return (
    FENCE_OPEN.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  );
}

/**
 * 正文切成渲染块。
 *
 * @returns {Array<{
 *   type: 'p'|'heading'|'code'|'quote'|'list'|'table'|'hr',
 *   html?: string, lang?: string, code?: string, level?: number,
 *   ordered?: boolean, items?: Array<{html: string, depth: number}>,
 *   head?: string[], align?: string[], rows?: string[][]
 * }>}
 */
export function markdownToBlocks(raw) {
  const blocks = [];
  const lines = String(raw ?? '').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      // 没闭合（流式输出中）也要把已收到的部分渲染出来，尾部的反引号下一轮会补上
      if (i < lines.length) i += 1;
      blocks.push({
        type: 'code',
        lang: fence[1] || '',
        code: body.join('\n'),
      });
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        html: renderInline(heading[2]),
      });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(lines[i].replace(QUOTE, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', html: body.map(renderInline).join('<br>') });
      continue;
    }

    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      TABLE_DIVIDER.test(lines[i + 1])
    ) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({
        type: 'table',
        head: head.map(renderInline),
        align,
        rows: rows.map((row) => row.map(renderInline)),
      });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line);
      const items = [];
      while (i < lines.length) {
        const item = ordered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i]);
        if (item) {
          const indent = item[1].replace(/\t/g, '  ').length;
          items.push({
            text: item[3],
            depth: Math.min(1, Math.floor(indent / 2)),
          });
          i += 1;
          continue;
        }
        // 缩进的续行并入上一项，不另起一块
        if (items.length && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1].text += ` ${lines[i].trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({
        type: 'list',
        ordered,
        items: items.map((item) => ({
          html: renderInline(item.text),
          depth: item.depth,
        })),
      });
      continue;
    }

    const body = [];
    while (i < lines.length && lines[i].trim() && !isBreakAhead(lines[i])) {
      body.push(lines[i]);
      i += 1;
    }
    if (body.length) {
      blocks.push({ type: 'p', html: body.map(renderInline).join('<br>') });
    }
  }

  return blocks;
}
