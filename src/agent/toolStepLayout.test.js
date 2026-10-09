/**
 * 工具卡窄形态布局守卫（T-174）。
 *
 * 问题形态（用户实测，320px 侧栏）：展开工具卡后，观察值里的长无空格串
 * （`file:///…`、`https://…`、长 tabId）把**卡片本身**撑得比面板还宽，
 * 正文区出现左右滚动条；同时展开体量过大（max-h-80=320px，超过面板一半）。
 *
 * 根因两点，缺一不可：
 *   ① 工具卡在 transcript 的 flex 列里带 `self-start`（非 stretch），按 fit-content
 *      定宽，而 fit-content 的下界是内容的 min-content；
 *   ② `overflow-wrap: break-word`（Tailwind 的 `break-words`）**不参与 min-content
 *      计算** —— 它只在行盒排不下时断行，不会把长串的 min-content 变小。
 *   → 长串的 min-content > 面板宽，卡片被撑宽，叶子的 overflow-x-auto 救不了
 *     （被撑宽的是容器，不是叶子）。
 *
 * 本守卫钉四件事：
 *   ① 工具卡根节点带 `max-w-full min-w-0`（卡片永不比面板宽）；
 *   ② 参数/观察值 `<pre>` 用 `[overflow-wrap:anywhere]`（参与 min-content），
 *      且不再出现 `overflow-x-auto` / `break-words`（都是治标不治本的老写法）；
 *   ③ 展开体外层只允许纵向滚动（`overflow-y-auto overflow-x-hidden`），
 *      体量收敛（`max-h-56`，不再 `max-h-80`）；
 *   ④ 同型长串隐患收口：用户气泡与错误卡正文也用 `[overflow-wrap:anywhere]`。
 *
 * 另有一条 CSS 产出检查：上面这些类必须真的出现在构建产物里（按老规矩，
 * 没构建就 skip 而不是假绿）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const AGENT = 'src/components/newtab/workflow/agent';
const CSS = join(ROOT, 'build/newtab.css');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// 注释里会提到 `break-words` / `overflow-x-auto` / `[overflow-wrap:anywhere]`
// 这些字面量，必须剥掉再断言，否则守卫对着注释自说自话。剥成等长空格以保偏移。
const strip = (src) =>
  src
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

const stepSrc = () => strip(read(`${AGENT}/AgentToolStep.vue`));
const transcriptSrc = () => strip(read(`${AGENT}/AgentTranscript.vue`));

// —— ① 卡片根节点：永不比面板宽 ——
test('T-174：工具卡根节点带 max-w-full + min-w-0', () => {
  const src = stepSrc();
  assert.match(
    src,
    /class="[^"]*\bmax-w-full\b[^"]*\bmin-w-0\b/,
    '工具卡根节点缺 max-w-full/min-w-0 —— 长度观察值会把卡片撑得比 320px 面板宽'
  );
});

// —— ② 长串就地折断：anywhere 参与 min-content，break-word 不参与 ——
test('T-174：参数/观察值 <pre> 用 [overflow-wrap:anywhere]，不再靠 overflow-x-auto/break-words', () => {
  const src = stepSrc();

  const anywhere = (src.match(/\[overflow-wrap:anywhere\]/g) || []).length;
  assert.equal(
    anywhere,
    2,
    `应恰好两个 <pre>（参数 + 观察值）用 [overflow-wrap:anywhere]，实际 ${anywhere} 处`
  );

  assert.equal(
    /break-words/.test(src),
    false,
    'AgentToolStep 里不该再有 break-words —— overflow-wrap:break-word 不参与 ' +
      'min-content 计算，长串照样把卡片撑宽（这正是 T-174 的根因）'
  );
  assert.equal(
    /overflow-x-auto/.test(src),
    false,
    'AgentToolStep 里不该再有 overflow-x-auto —— 被撑宽的是容器不是叶子，' +
      '叶子的横向滚动条解决不了问题，反而把「看不见的内容」藏起来'
  );
});

// —— ③ 展开体：只纵向滚动 + 体量收敛 ——
test('T-174：展开体只纵向滚动且体量收敛（max-h-56，不再 max-h-80）', () => {
  const src = stepSrc();

  assert.match(
    src,
    /class="[^"]*\bmax-h-56\b[^"]*\boverflow-y-auto\b[^"]*\boverflow-x-hidden\b/,
    '展开体外层必须 max-h-56 + overflow-y-auto + overflow-x-hidden'
  );
  assert.equal(
    /max-h-80/.test(src),
    false,
    '展开体不该还是 max-h-80（320px）—— 超过 320px 面板的一半，体量过大'
  );
  // 「overflow-auto」会同时允许横向滚动，与「横向溢出必须靠断行解决」冲突。
  // 这里只禁裸的 overflow-auto（overflow-y-auto 是允许的，前缀不同不误伤）。
  assert.equal(
    /\boverflow-auto\b/.test(
      src.replace(/overflow-y-auto|overflow-x-auto/g, '')
    ),
    false,
    '展开体不该用裸 overflow-auto（它含横向滚动）—— 只要 overflow-y-auto'
  );
});

// —— ④ 同型长串隐患：用户气泡与错误卡正文 ——
test('T-174：用户气泡与错误卡正文也用 [overflow-wrap:anywhere]', () => {
  const src = transcriptSrc();

  assert.match(
    src,
    /class="[^"]*\bmax-w-full\b[^"]*\bself-end\b[^"]*\[overflow-wrap:anywhere\]/,
    '用户气泡可能贴进长 URL/路径，同样要 max-w-full + [overflow-wrap:anywhere]'
  );
  assert.match(
    src,
    /\[overflow-wrap:anywhere\][^"]*text-red-700/,
    '错误卡正文也要 [overflow-wrap:anywhere]（原来的 break-words 不收缩 min-content）'
  );
});

// —— 保留：工具卡仍走 self-start 紧凑形态（本稿没打算把它拉满整行）——
test('T-174：工具卡仍以 self-start 渲染（保持紧凑，不被顺手改成拉满整行）', () => {
  const src = transcriptSrc();
  assert.match(
    src,
    /<agent-tool-step[\s\S]{0,80}?class="self-start"/,
    '工具卡应继续 self-start：短则紧凑、长则换行、永不超过面板'
  );
});

// —— CSS 产出检查：上面的类必须真产出到构建产物 ——
test('T-174：用到的类都产出了 CSS（没构建则跳过）', (t) => {
  if (!existsSync(CSS)) {
    // 没构建过就跳过而不是假绿 —— 假绿比红更坏。
    t.skip('build/newtab.css 不存在，先跑一次 npm run build');
    return;
  }
  const css = readFileSync(CSS, 'utf8');
  const offset = (name) => {
    const esc = name.replace(/[.[\]()%#]/g, (ch) => '\\' + ch);
    return css.indexOf('.' + esc + ' {');
  };

  for (const cls of [
    'max-w-full',
    'min-w-0',
    'max-h-56',
    'overflow-y-auto',
    'overflow-x-hidden',
  ]) {
    assert.notEqual(offset(cls), -1, `构建产物里没有 .${cls} 规则`);
  }
  assert.ok(
    css.includes('overflow-wrap: anywhere'),
    '构建产物里没有 overflow-wrap:anywhere 规则（[overflow-wrap:anywhere] 没被 tailwind 产出）'
  );
});
