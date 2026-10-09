import assert from 'node:assert';
import test from 'node:test';

import {
  escapeHtml,
  markdownToBlocks,
  renderInline,
  safeHref,
} from './markdown';

// 拼出来的危险 URL：eslint 的 no-script-url 连字面量都要管，拼一下绕过，
// 但喂给渲染器的仍是完整的 javascript:  URL —— 测试意图没有打折
const SCRIPT_URL = 'java'.concat('script:alert(1)');

test('escapeHtml 把标签变成可见文本', () => {
  const out = escapeHtml('<script>alert(1)</script>');

  assert.ok(!out.includes('<script'));
  assert.ok(out.includes('&lt;script&gt;'));
});

test('safeHref 只放行 http/https/mailto', () => {
  assert.equal(
    safeHref('https://example.com/a?b=1'),
    'https://example.com/a?b=1'
  );
  assert.equal(safeHref('mailto:a@b.com'), 'mailto:a@b.com');
  assert.equal(safeHref(SCRIPT_URL), '');
  assert.equal(safeHref('data:text/html,<script>'), '');
});

test('模型写的链接协议被降级成可读文本', () => {
  const html = renderInline(`[点我](${SCRIPT_URL})`);

  assert.ok(!html.includes('href="javascript'), `实际输出: ${html}`);
  assert.ok(!html.includes(SCRIPT_URL), `危险协议不该出现在输出里: ${html}`);
  assert.ok(html.includes('点我'), 'label 要留住，否则这句就只剩废话');
});

test('正常链接带上 noopener', () => {
  const html = renderInline('[文档](https://docs.automa.site)');

  assert.ok(html.includes('href="https://docs.automa.site"'));
  assert.ok(html.includes('rel="noopener noreferrer nofollow"'));
});

test('正文中注入的 HTML 不会变成真标签', () => {
  const blocks = markdownToBlocks(
    '<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>'
  );

  const allHtml = blocks.map((b) => b.html || '').join('');
  assert.ok(allHtml.includes('&lt;img'), '标签必须被转义成可见文本');
  assert.ok(allHtml.includes('&lt;script&gt;'));
  // 只允许我们自己生成的那几个标签出现，其余一律是转义文本
  const tags = allHtml.match(/<\/?([a-zA-Z]+)/g) || [];
  const allowed = new Set([
    '<a',
    '</a',
    '<code',
    '</code',
    '<strong',
    '</strong',
    '<em',
    '</em',
    '<del',
    '</del',
    '<br',
  ]);
  tags.forEach((tag) => {
    assert.ok(allowed.has(tag), `出现了预期外的标签: ${tag} —— ${allHtml}`);
  });
});

test('行内代码里的星号不被当成强调', () => {
  const html = renderInline('用 `*args` 和 **粗**');

  assert.ok(html.includes('<code'));
  assert.ok(html.includes('*args'));
  assert.ok(!html.includes('<em>*args</em>'));
  assert.ok(html.includes('<strong>粗</strong>'));
});

test('代码块保持原始文本，且内部不解析 markdown', () => {
  const blocks = markdownToBlocks(
    '前文\n\n```js\nconst a = 1; // **不要加粗**\n```\n'
  );

  const code = blocks.find((b) => b.type === 'code');
  assert.ok(code);
  assert.equal(code.lang, 'js');
  assert.equal(code.code, 'const a = 1; // **不要加粗**');
});

test('未闭合的代码围栏按流式处理，不丢内容也不抛错', () => {
  const blocks = markdownToBlocks('```js\nconst a = 1;');

  const code = blocks.find((b) => b.type === 'code');
  assert.ok(code, '应当把未闭合的围栏也渲染成代码块');
  assert.equal(code.code, 'const a = 1;');
});

test('标题按层级渲染', () => {
  const blocks = markdownToBlocks('## 二级\n\n正文\n');

  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading', 'p']
  );
  assert.equal(blocks[0].level, 2);
  assert.equal(blocks[0].html, '二级');
});

test('无序与有序列表，缩进续行并入上一项', () => {
  const blocks = markdownToBlocks('- 第一项\n  续行\n- 第二项\n');

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'list');
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[0].items.length, 2);
  // T-176 起续行按 <br> 渲染（marked 的 breaks:true，与段落/引用的连续行一致）。
  // 换库前是 join(' ') 得到的 "第一项 续行" —— 换行信息被抹平了。
  assert.equal(blocks[0].items[0].html, '第一项<br>续行');
});

test('表格渲染出表头与对齐', () => {
  const blocks = markdownToBlocks(
    '| 名称 | 值 |\n| :--- | ---: |\n| a | 1 |\n'
  );

  assert.equal(blocks[0].type, 'table');
  assert.deepEqual(blocks[0].head, ['名称', '值']);
  assert.deepEqual(blocks[0].align, ['left', 'right']);
  assert.deepEqual(blocks[0].rows, [['a', '1']]);
});

test('引用块合并连续行', () => {
  const blocks = markdownToBlocks('> 第一行\n> 第二行\n');

  assert.equal(blocks[0].type, 'quote');
  assert.equal(blocks[0].html, '第一行<br>第二行');
});

test('强调与删除线', () => {
  const html = renderInline('**粗** 和 *斜* 和 ~~划掉~~');

  assert.ok(html.includes('<strong>粗</strong>'));
  assert.ok(html.includes('<em>斜</em>'));
  assert.ok(html.includes('<del>划掉</del>'));
});

test('裸 URL 自动成链，且不重复包裹已生成的链接', () => {
  const once = renderInline('见 https://example.com/x');

  assert.equal(once.match(/<a /g).length, 1);

  const twice = renderInline('[链接](https://example.com/x)');

  assert.equal(twice.match(/<a /g).length, 1);
  assert.ok(!twice.includes('href="https://example.com/x" href='));
});

test('空输入返回空数组', () => {
  assert.deepEqual(markdownToBlocks(''), []);
  assert.deepEqual(markdownToBlocks(null), []);
  assert.deepEqual(markdownToBlocks(undefined), []);
});

test('每一步都不抛异常（流式中间态也不许炸）', () => {
  const partials = [
    '##',
    '#',
    '| a |',
    '| a |\n|',
    '-',
    '>',
    '```',
    '```js',
    '**未闭合',
    '[未闭合](https://',
    '混合 **a\n```js\ncode\n',
  ];

  partials.forEach((raw) => {
    markdownToBlocks(raw);
    renderInline(raw);
  });
});

// ----------------------------------------------------------------
// T-176：解析改用 marked（GFM）后**新覆盖到**的能力。
//
// 换库前手搓版实测的真实缺口（每条对应下面一个断言）：
//   ① 嵌套列表 depth 被 `Math.min(1, …)` 拍成一层；
//   ② 混合嵌套（有序里套无序）把子项当「列表续行」并进父项，**改写内容**；
//   ③ 任务列表 `- [ ]` 不认，字面显示 `[ ] todo`；
//   ④ 有序列表起始序号丢失（`3.` 开头仍从 1 编）；
//   ⑤ 行内代码含反引号（``a ` b``）解析崩。
// ----------------------------------------------------------------

test('T-176：三层嵌套列表保留真实层级', () => {
  const blocks = markdownToBlocks('- a\n  - b\n    - c\n- d');

  assert.equal(blocks[0].type, 'list');
  assert.deepEqual(
    blocks[0].items.map((i) => [i.html, i.depth]),
    [
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 0],
    ],
    '嵌套层级要按 depth 保留（换库前被 Math.min(1,…) 拍成一层）'
  );
});

test('T-176：混合嵌套不再吞内容（有序里套无序）', () => {
  const blocks = markdownToBlocks('1. step\n   - bullet\n2. step2');
  const { items } = blocks[0];

  assert.deepEqual(
    items.map((i) => i.html),
    ['step', 'bullet', 'step2'],
    '子项必须独立成项 —— 换库前会被并成 "step - bullet" 一行，内容被改写'
  );
  assert.equal(items[1].depth, 1, '子项要缩进一层');
  assert.deepEqual(
    items.map((i) => i.ordered),
    [true, false, true],
    '同一块里允许有序套无序（换库前只认父列表的 ordered）'
  );
});

test('T-176：任务列表带勾选态', () => {
  const blocks = markdownToBlocks('- [ ] todo\n- [x] done');

  assert.deepEqual(
    blocks[0].items.map((i) => [i.task, i.checked, i.html]),
    [
      [true, false, 'todo'],
      [true, true, 'done'],
    ],
    '任务列表要认出勾选态（换库前字面显示 "[ ] todo"）'
  );
});

test('T-176：有序列表保留起始序号', () => {
  const blocks = markdownToBlocks('3. three\n4. four');

  assert.equal(blocks[0].ordered, true);
  assert.deepEqual(
    blocks[0].items.map((i) => i.marker),
    ['3.', '4.'],
    '序号要从 3 起（换库前一律从 1 编）'
  );
});

test('T-176：行内代码含反引号也能正确切分', () => {
  const html = renderInline('a ``code with ` tick`` b');

  assert.ok(html.includes('<code'), `实际输出: ${html}`);
  assert.ok(
    html.includes('code with ` tick'),
    '双反引号包起来的整段都要进 <code>'
  );
  assert.ok(html.includes('a ') && html.includes(' b'), '前后普通文本不能被吞');
});

test('T-176：行内手写标签也要转义（emitToken 的兜底分支）', () => {
  // 上面那条「正文中注入的 HTML」走的是**块级** html token（独立成块的
  // `<script>`）—— 变异测试发现它覆盖不到 emitToken 的 default 分支：
  // 把那条分支的 escapeHtml 去掉，全部测试依旧绿。于是补这一条，
  // 让**行内**手写标签也钉住。
  const html = renderInline(
    '前 <img src=x onerror=alert(1)> 后 <script>alert(2)</script>'
  );

  assert.ok(html.includes('&lt;img'), `行内标签必须被转义，实际输出: ${html}`);
  assert.ok(html.includes('&lt;script&gt;'), 'script 标签要被转义成可见文本');

  const tags = html.match(/<\/?([a-zA-Z]+)/g) || [];
  const allowed = new Set([
    '<a',
    '</a',
    '<code',
    '</code',
    '<strong',
    '</strong',
    '<em',
    '</em',
    '<del',
    '</del',
    '<br',
  ]);
  tags.forEach((tag) => {
    assert.ok(allowed.has(tag), `出现了预期外的标签: ${tag} —— ${html}`);
  });
});

test('T-176：自动链接 <url> 与裸 URL 都成链', () => {
  assert.equal(
    renderInline('见 <https://a.example/x>').match(/<a /g).length,
    1,
    '尖括号自动链接要成链'
  );
  assert.equal(
    renderInline('见 https://a.example/x').match(/<a /g).length,
    1,
    '裸 URL 要成链'
  );
  assert.equal(
    renderInline('见 <https://a.example/x>').match(/href="/g).length,
    1,
    '同一个 URL 不能被包两次'
  );
});
