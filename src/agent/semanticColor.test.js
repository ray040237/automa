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
test('T-172：notice / 确认门 / 未配置入口 / 工具被拒，四者配色两两不同', () => {
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
  // T-200：圆角换成了语义名（rounded-card），标记跟着改。找的是「卡片那串
  // class」，不是某个圆角值 —— 值变了不该让守卫失去锚点。
  const confirm = paletteOf(
    'AgentConfirmCard.vue',
    'class="rounded-card border'
  );
  // T-207：未配置态从「一条红横幅」改成了「整页引导」。
  // 语义没变（仍然是阻塞：不配 Key 就发不出话），但承载它的不再是一块
  // 红底，而是一整页占位 + 一个 accent 主按钮 —— 红被收掉了。
  // 守卫锚到那个主按钮（它带 text-accent），而不是引导页容器（容器刻意
  // 无彩色）。这一改是**有意的**：它正好记录了「阻塞红 → 引导页」这个
  // 视觉语言的迁移，不是偷偷放宽。
  const unset = paletteOf('AgentPanel.vue', 'data-test="not-configured-cta"');
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

  // advisory 不需要颜色 → 中性灰；要用户裁决 → accent；入口阻塞 → accent 主按钮；
  // 被拒 → 琥珀。未配置与确认门同为 accent，靠**形态**（整页占位 vs 卡内分档）
  // 区分，而不是靠再加一个色相 —— 这正是「一种颜色只能表示一件事」的背面：
  // 一个语义也不该被迫多占一个色相。
  assert.deepEqual(
    got,
    { notice: 'gray', confirm: 'accent', unset: 'accent', rejected: 'amber' },
    '四种语义的配色发生了漂移。当前约定：advisory=灰、需裁决=accent、' +
      '未配置入口=accent（靠整页形态区分，不再用红）、被拒=琥珀。' +
      '改动是允许的，但必须是有意的 —— ' +
      `实测 ${JSON.stringify(got)}`
  );

  // 再加一条：四个语义里，唯一允许共用色相的是 accent（confirm 与 unset），
  // 且它们必须靠形态区分，不能都长成一张卡。其余色相仍然一一对应。
  const values = Object.values(got);
  assert.equal(
    new Set(values).size,
    values.length - 1,
    '除 confirm/unset 这两个 accent 形态外，不该再有语义共用色相：' +
      JSON.stringify(got)
  );
  assert.equal(
    values.filter((v) => v === 'red').length,
    0,
    '阻塞态已经不再用红：未配置走整页引导（accent），别把红加回来 —— ' +
      '红在本面板没有语义位置了'
  );
});

// —— ②b 确认卡内部的影响面分档（T-200）——
test('T-200：确认卡按影响面分 local / browser 两档，且不引入第二个色相', () => {
  const src = strip(
    read('src/components/newtab/workflow/agent/AgentConfirmCard.vue')
  );

  // ① 判定必须住在纯函数模块里（.vue 里的分支一条都测不到）
  assert.match(
    src,
    /confirmScope\(kind\.value\)/,
    '作用域判定要调 @/agent/confirm 的 confirmScope，不能就地 switch'
  );

  // ② 两档的 class 串必须不一样，否则「分档」只是个没落地的变量
  const local = (src.match(/'!border-accent[^']*'/) || [])[0];
  assert.ok(
    local,
    'local 档的加强类不见了（border-accent 实色 + 深一档的底）—— 两档退回一档'
  );
  assert.ok(
    /border-accent/.test(local) && /bg-accent/.test(local),
    `local 档要同时加强边框与底色，实际：${local}`
  );
  // 加强串里不许出现别的色相 —— accent 是本档唯一允许的颜色
  for (const hue of ['amber', 'yellow', 'red', 'green']) {
    assert.ok(
      !new RegExp(`(?:bg|border|text)-${hue}`).test(local),
      `local 档出现了 ${hue}：琥珀已归「工具被拒」、红归「阻塞」、绿归「成功」，` +
        '确认卡内部的分档只能走 accent 的强度差（T-172 的纪律）'
    );
  }

  // ③ 两个图标必须不同 —— 色觉障碍用户靠图标与文案分档，颜色不是唯一通道
  const icons = [...src.matchAll(/'(ri[A-Za-z0-9]+)'/g)].map((m) => m[1]);
  assert.ok(
    icons.length >= 2 && new Set(icons).size === icons.length,
    `两档的图标要各不相同，实际：${icons.join(', ')}`
  );

  // ④ 徽标文案两种语言都得有，否则界面上显示裸 key
  for (const lang of ['zh', 'en']) {
    const { confirm } = JSON.parse(read(`src/locales/${lang}/newtab.json`))
      .workflow.agent;

    for (const key of ['scopeLocal', 'scopeBrowser']) {
      assert.equal(
        typeof confirm[key],
        'string',
        `${lang}/newtab.json 缺 workflow.agent.confirm.${key}`
      );
    }
  }
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

  // ② 底色分层（T-208 后从 gray-50/gray-100 改走语义面）
  //
  // 原来钉的是「compaction 比 thinking 深一档」（bg-gray-50 → bg-gray-100）。
  // T-208 把这两张卡换成语义面：thinking = surface（浮起，最亮），
  // compaction = field（凹陷，深一档）。**不变量没变**（compaction 更深），
  // 但具体的 class 名变了 —— 所以改成钉语义名，并把「两者不同面」也钉上。
  assert.ok(
    /bg-field/.test(compaction),
    'compaction 卡用 field 面（比 thinking 的 surface 深一档）—— 这是两卡的底色区分'
  );
  assert.ok(
    /bg-surface/.test(thinking) && !/bg-field/.test(thinking),
    'thinking 卡用 surface 面；若它也用 field，两张卡底色就一样了（T-154 的原始症状）'
  );
  assert.ok(
    !/bg-field/.test(thinking),
    'thinking 与 compaction 必须落在不同的面上'
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
    // T-200：语义圆角名是新加的 borderRadius 档位。写了名字但 Tailwind 没产出，
    // 表现是元素变直角 —— 与 T-171 同一类「静默失效」，必须钉在产物上。
    'rounded-chip',
    'rounded-control',
    'rounded-card',
    // T-208：三层底色 + 分隔线是本轮新增的语义色 token（走 CSS 变量）。与圆角
    // 同理 —— 写了名字但 Tailwind 没产出，表现是「元素没有底色 / 线消失」，
    // 属于 T-171 那类静默失效，必须钉在产物上。
    'bg-canvas',
    'bg-surface',
    'bg-field',
    'border-line',
    // T-209：composer 输入区改成 `!bg-field`（带 ! 的 importance 变体）。Tailwind
    // 对带 ! 的类产出的是 `.\!bg-field`，与不带 ! 的 `bg-field` 是两个不同的
    // 类名 —— 写了 `!bg-field` 而上游没产出，输入区就退回透明（静默失效）。
    '\\!bg-field',
    // T-211：三档语义文字色。写了 text-fg-2 而 Tailwind 没产出，表现是文字
    // 继承父级色（通常太深或太浅），与 T-171 同类静默失效。
    'text-fg-1',
    'text-fg-2',
    'text-fg-3',
    // T-213：危险/警戒两档语义色。这里是**第二次**踩到同一类坑：本票起初
    // 写的是 `bg-danger/12`，而 12 不在 Tailwind 默认的透明度刻度里
    // （默认只有 0/5/10/15/20/25…）。结果是 class 静默失效 ——
    // 标签页失效态与删除按钮的 hover 底色整块不见了，且**不报任何错**。
    // 所以语义色的**每一个用到的组合**都必须钉在产物上，不能只钉 token 名。
    'text-danger',
    'text-warn',
    'bg-danger\\/15',
    'hover\\:bg-danger\\/15',
    'hover\\:text-danger',
    // T-213：composer 卡片凹陷 + 聚焦时描边提亮。同样是首次使用的组合。
    'focus-within\\:border-accent',
    // T-213：两行头部里，左列（历史列表）的头部要钉到与右列同高，
    // 靠的就是这个任意值高度。写错了不会报错，只会「两列头顶不齐」。
    // （2026-10-10「太挤」反馈后 74px → 82px。）
    'min-h-\\[82px\\]',
    // 2026-10-10「输入框留得太大」反馈：composer 未激活收一行、激活撑回
    // 56px，靠动态切 min-h + 过渡。transition-[min-height] 是新引入的
    // 任意值工具类 —— 同样属于「写了但没产出就静默失效」家族（没产出的
    // 表现是塌/撑瞬间跳变，没有过渡）。带 `!` 是因为 UiTextarea 自带裸
    // `transition`（cssSpecificity 守卫抓出来的：不加强调会被它整组吃掉）。
    '\\!transition-\\[min-height\\]',
    '\\!duration-base',
    '\\!ease-panel',
    'min-h-\\[56px\\]',
  ];
  // 带变体的类（hover: / focus-within: / peer-hover: …）在产物里长的是
  // `.hover\:bg-danger\/15:hover {` —— 选择器后面跟的是伪类，不是空格。
  // 原来只认 `'.' + esc + ' {'`，于是所有带变体的项都会被误判成「没产出」。
  // 这里放宽到「后面跟 { 或 :」两种形态；仍然要求**选择器开头**精确匹配，
  // 所以 `bg-danger\/15` 不会因为 `hover:bg-danger\/15` 存在而被误认为通过。
  const emitted = (esc) =>
    css.includes('.' + esc + ' {') || css.includes('.' + esc + ':');
  const missing = need.filter((esc) => !emitted(esc));
  assert.deepEqual(
    missing.map((m) => m.replace(/\\/g, '')),
    [],
    '这些类没产出到构建 CSS，说明写了个空的（样式会静默失效）。' +
      'accent 带透明度的写法本仓此前没用过，若 Tailwind 不生成，' +
      '就改用 text-accent / border-accent 这种已验证存在的形式。'
  );
});
