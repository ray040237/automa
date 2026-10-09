/**
 * markdown 渲染链路守卫（T-176：解析改用 marked）。
 *
 * 背景：`src/agent/markdown.js` 原来是手搓的（正文里写着「本机装不上 npm 依赖」）。
 * 实跑常见语法后确认有真缺口 —— 嵌套列表被拍成一层、有序里套无序会把子项
 * **并进父项改写内容**、任务列表不认、有序起始号丢失、行内反引号解析崩。
 * 于是换成 marked 做**词法**，渲染仍留在自己手里。
 *
 * 这条守卫钉四件事：
 *   ① 解析确实走 marked（Lexer.lex / Lexer.lexInline），手搓块级解析已删除；
 *   ② **没有**退化成 `marked.parse()` 直接吐 HTML —— 那会把「转义优先」这条
 *      安全不变量降档成「渲染完再过滤」（还没引 DOMPurify，等于不设防）；
 *   ③ 五个公开导出一个不少（AgentMarkdown.vue 与 panelUi 的流式守卫都挂在这上面）；
 *   ④ 列表模板真的渲染出 depth 缩进 / 每项 marker / 任务勾选，
 *      且用到的类确实产出了 CSS（没构建就 skip，不假绿）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MD = 'src/agent/markdown.js';
const VIEW = 'src/components/newtab/workflow/agent/AgentMarkdown.vue';
const CSS = join(ROOT, 'build/newtab.css');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * 把注释整体抹成空白（保留换行）。必须剥 —— markdown.js 的头注里就写着
 * `marked.parse()` / `DOMPurify` 这些字样，不剥的话守卫是对着注释自说自话。
 */
const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

// —— ① 解析交给 marked，手搓的块级解析已删除 ——
test('T-176：块级与行内解析都走 marked 的词法器', () => {
  const src = strip(read(MD));

  assert.ok(
    /import\s*\{\s*Lexer\s*\}\s*from\s*'marked'/.test(src),
    'markdown.js 必须从 marked 引入词法器 —— 换库的意义就在这儿'
  );
  assert.ok(/Lexer\.lex\(/.test(src), '块级解析必须走 Lexer.lex');
  assert.ok(/Lexer\.lexInline\(/.test(src), '行内解析必须走 Lexer.lexInline');

  // 手搓版的标志性写法必须消失，否则说明有人又把解析写回了自己手里
  assert.ok(
    !/TABLE_DIVIDER|splitRow|alignOf/.test(src),
    '手搓的表格切分（分隔行正则 / splitRow / alignOf）应已删除'
  );
  assert.ok(
    !/Math\.min\(1,\s*Math\.floor/.test(src),
    '嵌套列表的 depth 不许再被 Math.min(1,…) 拍成一层'
  );
});

// —— ② 渲染仍自己产出，不许退化成 marked.parse + v-html ——
test('T-176：HTML 仍由自己逐 token 产出，没退化成 marked.parse', () => {
  const src = strip(read(MD));

  assert.ok(
    !/marked\.parse\s*\(/.test(src),
    '不许用 marked.parse 直接吐 HTML —— 它默认原样透传源码里的标签，' +
      '那条路会丢掉「转义优先」这条安全不变量'
  );
  assert.ok(
    !/['"]dompurify['"]/i.test(src),
    '本模块不引 DOMPurify：不把不可信 HTML 交给浏览器渲染，就不需要它'
  );
  assert.ok(
    /emitToken\(|emitTokens\(/.test(src),
    'HTML 必须由自己的 token 发射器产出'
  );
  assert.ok(/escapeHtml\(/.test(src), '文本必须过 escapeHtml');
  assert.ok(/safeHref\(/.test(src), '链接必须过 safeHref 协议白名单');
});

// —— ③ 公开 API 一个不少 ——
test('T-176：五个公开导出一个都不能少', () => {
  const src = read(MD);

  for (const name of [
    'escapeHtml',
    'safeHref',
    'renderInline',
    'markdownToBlocks',
    'createMarkdownStream',
  ]) {
    assert.ok(
      new RegExp(`export function ${name}\\(`).test(src),
      `markdown.js 少了导出 ${name} —— AgentMarkdown.vue 与 panelUi 的流式守卫都挂在这上面`
    );
  }
});

// —— ④ 列表模板：真实缩进 + 每项 marker + 任务勾选 ——
test('T-176：列表模板渲染真实 depth 缩进、每项 marker 与任务勾选', () => {
  const src = strip(read(VIEW));

  assert.ok(
    /item\.depth\s*\*\s*14/.test(src),
    '缩进要按 depth 算，不能只区分「有没有缩进」—— 那样三层嵌套看着还是一层'
  );
  assert.ok(
    /v-text="item\.marker"/.test(src),
    '每一项要画自己的 marker（有序/无序可以混在同一个列表里）'
  );
  assert.ok(
    /v-if="item\.task"/.test(src) && /:checked="item\.checked"/.test(src),
    '任务列表要渲染勾选态'
  );
  assert.ok(/type="checkbox"/.test(src), '任务项要真的画出 checkbox');
  assert.ok(
    !/list-decimal|list-disc/.test(src),
    '不再用 ol/ul 的原生 marker —— 混合嵌套时它画不出两种记号'
  );
});

// —— CSS 产出检查：模板里新用到的类必须真产出到构建产物 ——
test('T-176：列表新用到的类都产出了 CSS（没构建则跳过）', (t) => {
  if (!existsSync(CSS)) {
    // 没构建过就跳过而不是假绿 —— 假绿比红更坏。
    t.skip('build/newtab.css 不存在，先跑一次 npm run build');
    return;
  }
  const css = readFileSync(CSS, 'utf8');

  for (const cls of [
    'list-none',
    'select-none',
    'items-start',
    'shrink-0',
    'flex-1',
    'min-w-0',
  ]) {
    assert.notEqual(
      css.indexOf(`.${cls} {`),
      -1,
      `构建产物里没有 .${cls} 规则`
    );
  }

  // 任意值类要确认 JIT 真的扫到了（选择器带转义）
  assert.ok(
    css.includes('.mt-\\[3px\\]'),
    '构建产物里没有 .mt-[3px] —— arbitrary value 没被扫到'
  );
  assert.ok(
    css.includes('overflow-wrap: anywhere'),
    '构建产物里没有 overflow-wrap:anywhere'
  );
});
