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

/**
 * 围栏外的一个空行就是块边界 —— 上面每个 while 循环都以「空行或块起始」收尾，
 * 所以按空行切开后分段解析的结果与整段解析完全一致。唯一的例外是代码围栏：
 * 围栏里的空行是代码内容，不能切。切点判定必须与 FENCE_OPEN/FENCE_CLOSE 用同一套
 * 正则，否则会和上面的解析器对不上（下面 advanceCut 就是这么做的）。
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
      // 列表续行规则 /\s{2,}\S/ 要求的正是「缩进 + 非空」。
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
 * 实测（本机 node，`src/agent/markdown.test.js` 同一份 markdown.js，2026-10-07）：
 *   单次解析是**线性**的，约 0.55 ms / 万字（5K 字 0.44ms、40K 字 2.26ms）——
 *   单帧最差 2.2ms，**不到掉帧**。真正贵的是累计：20K 字按 40 字一个 delta 累计
 *   **313ms**，按 10 字一个 delta 累计 **1.1s** 主线程时间。
 *   对照：只重解析最后一个未完成块，20K 字累计 **4ms**（约 70 倍）。
 *   渲染侧（SSR 渲染当代理指标，编译已剔除）每次 0.9~2.8ms，与解析同量级，
 *   所以本次只治可测的解析成本；**浏览器里的 DOM patch 成本未实测**。
 *
 * 做法：已确定完成的块缓存起来，只重解析「最后一个还没写完的块」。
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
