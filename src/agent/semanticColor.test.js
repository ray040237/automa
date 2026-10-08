/**
 * 面板的「一种颜色只能表示一件事」守卫（T-172）。
 *
 * 为什么需要这个文件：T-152 与 T-154 这两条待办能存在，根因不是「当初没改」，
 * 而是**当年没有守卫**。琥珀被四种语义共用是一步步长出来的 ——
 * T-04 修掉了「error 与 notice 共用琥珀」，但确认门和未配置横幅漏网；
 * 漏网之后没有任何东西拦着，于是工具「被拒绝」又加了第四处。
 * 所以本文件盯的不是某几个 class，而是「色相 ↔ 语义」的**一一对应**。
 *
 * 两句判据：
 *   ① 琥珀/黄只允许表示一件事 —— 工具被用户拒绝。多一处就红。
 *   ② 语义不同的两张卡，class 不能逐字相同（T-154 就是这么来的）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const AGENT_DIR = join(ROOT, 'src/components/newtab/workflow/agent');
const CSS = join(ROOT, 'build/newtab.css');

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * 剥掉注释再断言。血的教训（T-171）：说明性注释里常写着 class 字面量
 * （「配色仍是黄」、`bg-amber-500/10`），不剥的话守卫会去查注释而不是代码，
 * 而且改注释就能让守卫变色，等于守卫盯着错的东西。
 * 用等长空白顶掉，保持偏移不变。
 */
const strip = (src) =>
  src
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

const agentFiles = () =>
  readdirSync(AGENT_DIR)
    .filter((f) => f.endsWith('.vue'))
    .map((f) => ({
      name: f,
      src: strip(readFileSync(join(AGENT_DIR, f), 'utf8')),
    }));

// —— ① 琥珀/黄只允许表示「工具被拒绝」——
test('T-172：琥珀/黄在面板里只能出现在「工具被拒」一处', () => {
  const hits = [];
  for (const f of agentFiles()) {
    // 逐行找 amber-/yellow- 的颜色类。只看 class 属性里的，不看脚本。
    for (const line of f.src.split('\n')) {
      if (!/amber-|yellow-/.test(line)) continue;
      // UiCheckbox/UiButton 等组件自身的 tag 里不会写色；这里只关心模板里的类。
      hits.push({ file: f.name, line: line.trim().slice(0, 110) });
    }
  }

  // 唯一允许的落点：AgentToolStep 的 REJECTED 状态色。
  const allowed = hits.filter(
    (h) => h.file === 'AgentToolStep.vue' && h.line.includes('REJECTED')
  );
  const others = hits.filter(
    (h) => !(h.file === 'AgentToolStep.vue' && h.line.includes('REJECTED'))
  );

  assert.ok(
    allowed.length === 1,
    `AgentToolStep 的 REJECTED 状态色应该正好一条，实际 ${allowed.length} 条 —— ` +
      '它现在是琥珀在本面板的唯一语义（「工具被你拒绝了」），弄丢了就该重新想一想'
  );
  assert.deepEqual(
    others.map((h) => `${h.file}: ${h.line}`),
    [],
    '琥珀在本面板只表示一件事「工具被用户拒绝」。新增琥珀处会让它退回「一种颜色' +
      '代表多件事」的老问题（T-152）。要表达 advisory 用中性灰、阻塞用红、' +
      '需要用户裁决用 accent —— 三者都不加新色相。'
  );
});

// —— ② 四张语义卡的配色必须互不相同 ——
test('T-172：notice / 确认门 / 未配置横幅 / 工具被拒，四者配色两两不同', () => {
  /**
   * 取出某个语义点用的那串 class。
   *
   * 两种落点都要支持：模板里是 `class="..."`；脚本里的状态色映射是
   * `[TOOL_STATUS.REJECTED]: 'bg-amber-500/15 …'`（对象字面量的字符串值）。
   * 第一版只找 class=，于是 REJECTED 那条直接报「附近没有 class」——
   * 守卫自己的 bug，不是代码的 bug。
   */
  const paletteOf = (file, marker) => {
    const src = strip(read(join('src/components/newtab/workflow/agent', file)));
    const i = src.indexOf(marker);
    assert.ok(i >= 0, `${file} 里找不到标记 ${marker}，守卫要重写`);
    const seg = src.slice(i, i + 500);
    const m = seg.match(/class="([^"]*)"/) || seg.match(/'([^']*)'/);
    assert.ok(m, `${file} 的 ${marker} 附近既没有 class 也没有字符串字面量`);
    return m[1];
  };

  const notice = paletteOf('AgentTranscript.vue', "item.type === 'notice'");
  const confirm = paletteOf('AgentConfirmCard.vue', 'class="rounded border');
  const unset = paletteOf('AgentPanel.vue', 'v-if="!configured"');
  const rejected = paletteOf('AgentToolStep.vue', 'TOOL_STATUS.REJECTED');

  // 按「色相」归类。accent 在本仓=近黑/近白（--color-accent: 24 24 27 /
  // 244 244 245），不算加了新色相，但它是一个独立语义档位，所以单独列。
  const scheme = (c) =>
    ['amber', 'yellow', 'red', 'green', 'accent', 'gray'].find((n) =>
      new RegExp(`(?:bg|border|text)-${n}`).test(c)
    ) || 'none';

  const got = {
    notice: scheme(notice),
    confirm: scheme(confirm),
    unset: scheme(unset),
    rejected: scheme(rejected),
  };

  // advisory 不需要颜色 → 中性灰；要用户裁决 → accent；阻塞 → 红；被拒 → 琥珀。
  assert.deepEqual(
    got,
    { notice: 'gray', confirm: 'accent', unset: 'red', rejected: 'amber' },
    '四种语义的配色发生了漂移。当前约定：advisory=灰、需裁决=accent、' +
      '阻塞=红、被拒=琥珀。改动是允许的，但必须是有意的 —— ' +
      `实测 ${JSON.stringify(got)}`
  );

  // 再加一条：四者两两不同（防止又退化回共用）
  const values = Object.values(got);
  assert.equal(
    new Set(values).size,
    values.length,
    '有语义共用了同一个色相：' + JSON.stringify(got)
  );
});

// —— ③ 两个折叠卡不能长得一样（T-154）——
test('T-154：thinking 卡与 compaction 卡的区分点必须还在', () => {
  const src = strip(
    read('src/components/newtab/workflow/agent/AgentTranscript.vue')
  );

  const blockOf = (marker) => {
    const i = src.indexOf(marker);
    assert.ok(i >= 0, `找不到 ${marker}`);
    return src.slice(i, i + 1400);
  };

  const thinking = blockOf("item.type === 'thinking'");
  const compaction = blockOf("item.type === 'compaction'");

  // ① 虚线 vs 实线
  assert.ok(
    /border-dashed/.test(compaction),
    'compaction 卡要用虚线边框 —— 这是它与 thinking 卡最一眼可见的区别'
  );
  assert.ok(
    !/border-dashed/.test(thinking),
    'thinking 卡不该用虚线，否则两者又混了'
  );

  // ② 灰底深一档
  assert.ok(
    /bg-gray-100/.test(compaction) && !/bg-gray-100/.test(thinking),
    'compaction 卡要比 thinking 卡的 bg-gray-50 深一档'
  );

  // ③ 档案图标在前 + 箭头移到右侧
  assert.ok(
    /riHistoryLine/.test(compaction),
    'compaction 卡要有前置的档案图标（白名单里的 riHistoryLine）'
  );
  assert.ok(
    /ml-auto/.test(compaction),
    'compaction 卡的展开箭头要移到右侧 —— thinking 卡是左箭头，位置本身也是区分'
  );

  // 反向自查：两张卡的 class 字符串不能还相同（这正是 T-154 的原始症状）
  const clsOf = (block) => (block.match(/class="([^"]*)"/) || ['', ''])[1];
  assert.notEqual(
    clsOf(thinking),
    clsOf(compaction),
    '两张卡的 class 又变得逐字相同了 —— T-154 说的就是这个'
  );
});

// —— ④ 用到的语义色 class 必须真的产出到构建 CSS ——
test('T-172：语义色 class 必须真的存在于构建 CSS（别写了个空的）', (t) => {
  if (!existsSync(CSS)) {
    t.skip('build/newtab.css 不存在，先跑一次 npm run build');
    return;
  }
  const css = readFileSync(CSS, 'utf8');

  // T-171 的教训：写了不等于生效。这里挑的是本项目**首次使用**的组合
  // （accent 带透明度此前一次都没用过，旧 CSS 里连 bg-accent/10 都没有），
  // 最容易出现「Tailwind 没生成、样式静默消失」。
  const need = [
    'bg-accent\\/5',
    'border-accent\\/40',
    'bg-accent\\/15',
    'text-accent',
    'bg-gray-500\\/5',
    'border-red-300',
    'bg-gray-100',
  ];
  const missing = need.filter((esc) => !css.includes('.' + esc + ' {'));
  assert.deepEqual(
    missing.map((m) => m.replace(/\\/g, '')),
    [],
    '这些类没产出到构建 CSS，说明写了个空的（样式会静默失效）。' +
      'accent 带透明度的写法本仓此前没用过，若 Tailwind 不生成，' +
      '就改用 text-accent / border-accent 这种已验证存在的形式。'
  );
});
