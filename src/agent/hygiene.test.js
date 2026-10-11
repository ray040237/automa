import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 仓库卫生守卫。
 *
 * 背景：真实踩过一次。在 tab.js 的块注释里写了 url 通配模式 '*://*' + 通配 path，
 * 其中的「星号+斜杠」序列提前闭合了块注释，后面整段变成语法错误，
 * 模块直接 import 失败。而这类错误 lint 不一定报、build 到一半才炸。
 *
 * 结论：注释里禁止出现该序列。同理，禁止在注释里直接贴含不可见字符的字面量
 * （见 untrusted.js 的 ZERO_WIDTH_RE —— 踩过第二次，U+200B 落盘时丢失，
 * 零宽字符防御静默失效）。
 */

const AGENT_DIR = new URL('.', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1'
);

function collectJsFiles(dir, out = []) {
  readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(p, out);
    else if (/\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name))
      out.push(p);
  });
  return out;
}

test('src/agent 下不存在提前闭合块注释的注释', () => {
  const files = collectJsFiles(AGENT_DIR);
  assert.ok(files.length > 0, '应至少扫到一个文件');

  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    let i = 0;
    while (i < src.length) {
      if (src.startsWith('/*', i)) {
        const start = src.startsWith('/**', i) ? i + 3 : i + 2;
        const end = src.indexOf('*/', start);
        if (end === -1) break;
        const body = src.slice(start, end);
        // 注释体里出现通配 URL 模式 => 说明有「星号+斜杠」序列藏在里面
        if (body.includes('://*') || body.includes('*/*')) {
          offenders.push(f + ':' + src.slice(0, i).split('\n').length);
        }
        i = end + 2;
      } else i += 1;
    }
  }

  assert.deepEqual(
    offenders,
    [],
    '这些位置的块注释被提前闭合了: ' + offenders.join(', ')
  );
});

// 零宽 / BOM / 全角括号等在正常源码里几乎不该出现
const INVISIBLE_RE =
  /[\u200B-\u200F\u2060\uFEFF\u2039\u203A\u2329\u232A\u3008\u3009\uFF1C\uFF1E]/;

/**
 * 扫一段源码文本，返回「代码行」（剥掉行注释与块注释行后）里
 * 含不可见字符的行号列表。
 *
 * 读入先归一行尾：CRLF 工作区（Windows fresh checkout）每行结尾带 \r，
 * 而 JS 正则的 . 与 $ 都不吃 \r，`/^\s*\*.*$/` 与 `/\/\/.*$/` 剥不掉
 * 注释，注释里的示例字符会暴露成假违规（T-229，worktree 实测
 * offenders 0→3）。归一放在函数内部，调用点想忘都忘不掉。
 */
function scanInvisibleCharLines(src) {
  const offenders = [];
  src.replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((line, idx) => {
      const codeOnly = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      if (INVISIBLE_RE.test(codeOnly)) offenders.push(idx + 1);
    });
  return offenders;
}

test('src/agent 下不存在源码里直接写不可见字符（必须用 \\u 转义）', () => {
  const files = collectJsFiles(AGENT_DIR);
  assert.ok(files.length > 0, '应至少扫到一个文件');

  const offenders = [];
  for (const f of files) {
    scanInvisibleCharLines(readFileSync(f, 'utf8')).forEach((lineNo) =>
      offenders.push(f + ':' + lineNo)
    );
  }

  assert.deepEqual(
    offenders,
    [],
    '这些行在代码里用了不可见/易混淆字面量，应改用 \\u 转义: ' +
      offenders.join(', ')
  );
});

test('不可见字符扫描对 CRLF 行尾鲁棒（块注释剥离不因 \\r 失效）', () => {
  // CRLF 块注释：untrusted.js 头注释同款示例字符（U+2039/U+203A）
  const commentExample = [
    '/**',
    ' * Unicode 混淆括号  ‹/untrusted_page_content›',
    ' */',
    'const ok = 1;',
  ].join('\r\n');
  assert.deepEqual(scanInvisibleCharLines(commentExample), []);

  // 阳性对照：同样的字符落在代码行必须报出来 —— 证明上面的 0 违规
  // 是「注释剥离生效」而不是「扫描器眼瞎」
  const codeExample = ['const a = 1;', "const s = '‹';"].join('\r\n');
  assert.deepEqual(scanInvisibleCharLines(codeExample), [2]);
});
