/**
 * 助手面板外壳的接线守卫。
 *
 * 本仓没有组件测试基建（backlog T-26/T-53 已登记），所以这里退而钉住源码接线：
 * 断言写在源文本上，少任何一环下面这些 bug 就会回来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const panelPath = join(
  ROOT,
  'src/components/newtab/workflow/agent/AgentPanel.vue'
);
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * 去掉注释再断言。
 *
 * 本文件第一版守卫就被这个坑咬了两次：把 `w-[32rem]` 和 `side="top"` 写进
 * 解释性注释里，守卫照样匹配 —— 于是「把真正的代码改坏」反而测不出来，
 * 守卫变成了对着注释自说自话。注释不是代码，断言前先剥掉。
 */
const stripComments = (src) =>
  src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('T-130 回归守卫：面板里不得再出现 UiButton 不认识的 variant="text"', () => {
  // variants 表只有 transparent/{default} 与 fill/{default,accent,primary,danger}；
  // 传 table 外的名字取到 undefined，Vue 不输出 class，按钮就完全没有样式 ——
  // 当时表现为「会话删除按钮不可见」。
  for (const f of [
    'src/components/newtab/workflow/agent/AgentPanel.vue',
    'src/components/newtab/workflow/agent/AgentTabPicker.vue',
    'src/components/newtab/workflow/agent/AgentSessionList.vue',
    'src/components/newtab/workflow/agent/AgentTabList.vue',
  ]) {
    assert.doesNotMatch(
      stripComments(read(f)),
      /variant=["']text["']/,
      `${f} 不该再用 variant="text"（UiButton 无此 variant）`
    );
  }
});

test('T-130 守卫：UiButton 对未知 variant 会告警，不静默渲染成无样式', () => {
  const src = stripComments(read('src/components/ui/UiButton.vue'));

  assert.match(src, /unknown variant/, 'UiButton 必须对未知 variant 发出告警');
  assert.match(
    src,
    /variants\[props\.btnType\]/,
    '告警必须基于真实的 variants 表取，而不是写死一份名单（否则表改了守卫会说谎）'
  );
});

test('T-131 回归守卫：面板的滚动容器必须用项目现成的 .scroll 约定', () => {
  // .scroll / .scroll-xs 定义在 src/assets/css/tailwind.css，全仓 30+ 处在用；
  // 漏加就是浏览器默认滚动条（约 17px 宽），在 320px 侧栏里挤的是对话正文。
  const transcript = read(
    'src/components/newtab/workflow/agent/AgentTranscript.vue'
  );
  assert.match(
    transcript,
    /class="[^"]*\bscroll\b[^"]*overflow-y-auto/,
    '事件流滚动容器必须带 scroll 类'
  );

  const tabList = stripComments(
    read('src/components/newtab/workflow/agent/AgentTabList.vue')
  );
  assert.match(
    tabList,
    /class="[^"]*\bscroll\b[^"]*overflow-y-auto/,
    '标签页列表滚动容器必须带 scroll 类'
  );
});

test('布局守卫：header 两行（会话/标题/新建 + 标签页），目标页 chip 在第 2 行', () => {
  const src = stripComments(readFileSync(panelPath, 'utf8'));

  // 方案 C：会话 chip + 新建构成 header（删除收进会话下拉）
  assert.match(
    src,
    /<agent-session-list/,
    '会话列表必须挂在面板上（标题下拉 + 左栏/历史视图用它）'
  );
  // T-90：面板收 host 对象后，入口直调 host 方法（原来断言的是 emit 形状）
  assert.match(src, /host\.newSession\(\)/, '新建会话入口必须保留');
  assert.match(
    src,
    /host\.deleteSession\(id\)/,
    '删除会话入口必须保留，且要把要删的会话 id 传下去'
  );
  // 「⋯」溢出菜单已被用户否掉（为两个功能多加一层菜单，删除还要点两次）。
  assert.doesNotMatch(src, /session\.more/, 'header 不该再有「更多」溢出菜单');
  assert.doesNotMatch(src, /riMore2Fill/, 'header 不该再有「更多」按钮');

  // T-213：header 拆成两行，chip 从 composer 卡片里搬到 header 的第 2 行。
  //
  // 归类的变化是本质的：T-166 把目标页当「这条消息的附件」（所以放进 composer
  // 卡片）；T-213 把它当「助手在看哪一页」这个**会话级状态**，那是 header 的
  // 事，与「这次要发什么」无关。副作用是 composer 少了一行（整行宽的 chip），
  // 而 header 多了一行 —— 总高度因此还能降（见设计稿 §6 的高度预算）。
  //
  // 判据跟着改：chip 必须**不在 form 内**（不再属于 composer），且在 header 的
  // 第二行容器里（`h-tabsrow` 那个 div 的位置 —— 这里用「form 之前」锚住）。
  const chipAt = src.indexOf('<agent-tab-picker');
  const formAt = src.indexOf('<form');
  assert.ok(chipAt > 0, '必须有目标页 chip');
  assert.ok(formAt > 0, '必须能找到 composer 的 <form>');
  assert.ok(
    chipAt < formAt,
    '目标页 chip 必须在 form **之前**（T-213 已把它从 composer 卡片搬到 header 第 2 行）'
  );
});

test('布局守卫：512px 的标签页弹窗不得复活', () => {
  // 宿主内容区只有 320px（sidebarCss.width 360 - padding 40），
  // w-[32rem] 的 modal 比宿主还宽。
  for (const f of [
    'src/components/newtab/workflow/agent/AgentTabPicker.vue',
    'src/components/newtab/workflow/agent/AgentPanel.vue',
  ]) {
    assert.doesNotMatch(
      stripComments(read(f)),
      /w-\[32rem\]/,
      `${f} 不该再用 w-[32rem] 的 512px 弹窗`
    );
    assert.doesNotMatch(
      stripComments(read(f)),
      /<ui-modal/,
      `${f} 标签页选择不该再走 ui-modal`
    );
  }
});

test('回归守卫：面板下拉必须留在本列、absolute 定位', () => {
  // 2026-10-05 用户装 build/ 实测踩到三条，同一个根因：用了 UiPopover（tippy 把内容
  // 挂到 document.body 上自行定位），内容脱离 320px 这道宽度约束 ——
  // ① 会话下拉顶出侧栏、压到右边新建/删除按钮；
  // ② 标签页 chip 点开后把整个面板撑开（内容参与了布局）；
  // ③ 删除项字色跟着父级继承成了底色，看不见。
  // 所以面板里一律用本文件夹的 AgentDropdown：absolute + 显式字色。
  for (const f of [
    'src/components/newtab/workflow/agent/AgentPanel.vue',
    'src/components/newtab/workflow/agent/AgentTabPicker.vue',
  ]) {
    assert.doesNotMatch(
      stripComments(read(f)),
      /<ui-popover/,
      `${f} 不该再用 UiPopover —— 它的内容会脱离本列定位`
    );
  }

  const dd = stripComments(
    read('src/components/newtab/workflow/agent/AgentDropdown.vue')
  );
  assert.match(
    dd,
    /class="absolute/,
    '下拉面板必须是 absolute —— absolute 才不参与布局，点开不会撑开面板'
  );
  // T-211：字色的**形态**从「text-gray-800 + dark:text-gray-100 双写」换成
  // 单一语义 token `text-fg-1`（跨主题）。钉的不变量没变 —— 仍然是
  // 「下拉必须显式给字色」，只是现在一个类就覆盖了亮暗两档。
  assert.match(
    dd,
    /\btext-fg-1\b/,
    '下拉必须显式给字色（text-fg-1），否则菜单项会跟着父级继承成「与底色同色」而看不见'
  );
});

test('回归守卫：弹层方向跟随所在位置 —— header 里向下弹，底行里向上弹', () => {
  // 原判据：「chip 在输入区顶上，必须 side="top" 向上展开」—— 那是标签页
  // chip 还住在 composer 顶部（面板底部）时的不变量。
  // T-213 把整格搬进 header 第 2 行（面板**顶部**）后方向翻转：往上弹会把
  // 列表顶出页面（2026-10-10 用户截图实证）。现在钉的是新不变量 ——
  // **方向由所在位置决定**，不逐个特调：
  //   header 里（标签页 chip、标题会话下拉）→ 向下（默认 side，不写 side="top"）
  //   底行里（模型芯片、圆环明细）           → side="top"
  const tab = stripComments(
    read('src/components/newtab/workflow/agent/AgentTabPicker.vue')
  );
  assert.doesNotMatch(
    tab,
    /<agent-dropdown[^>]*side="top"/s,
    '标签页 chip 在 header 里，下拉必须向下展开（写 side="top" 会把列表顶出页面）'
  );

  const model = stripComments(
    read('src/components/newtab/workflow/agent/AgentModelPicker.vue')
  );
  assert.match(
    model,
    /<agent-dropdown[^>]*side="top"/s,
    '模型芯片在 composer 底行（面板底部），必须 side="top" 向上展开，' +
      '否则矮窗口里会被视口截断'
  );

  // 标题会话下拉也在 header 里 —— 同样不许向上。
  const panel = stripComments(
    read('src/components/newtab/workflow/agent/AgentPanel.vue')
  );
  const titleAt = panel.indexOf('data-test="session-title"');
  assert.ok(titleAt > 0, '找不到标题会话下拉，守卫要重写');
  const ddEnd = panel.indexOf('</agent-dropdown>', titleAt);
  assert.ok(ddEnd > titleAt, '找不到下拉闭合标签，守卫要重写');
  assert.doesNotMatch(
    panel.slice(titleAt, ddEnd),
    /side="top"/,
    '标题会话下拉在 header 里，必须向下展开'
  );
});

test('回归守卫：底行弹层的横向对齐跟随触发器位置（T-246）', () => {
  // 弹层是 absolute + 固定宽度（w-72 = 288px），横向只由 `align` 决定的那一个
  // 边锚定，另一边随宽度往外长。所以 align 必须让**长的那一侧朝面板内部**：
  //   底行最左（模型芯片）  → align="left"，往右铺
  //   底行最右（水位环明细）→ align="right"，往左铺
  // 反了的话弹层整块落到侧栏外：模型芯片那处实测左溢出 79~171px（320px 侧栏，
  // 模型名 `deepseek-chat` 时最惨），压在工作流画布上。
  const model = stripComments(
    read('src/components/newtab/workflow/agent/AgentModelPicker.vue')
  );
  assert.match(
    model,
    /<agent-dropdown[^>]*align="left"/s,
    '模型芯片在底行最左，弹层必须左对齐（align="right" 会让它以芯片右缘为界往左铺出侧栏）'
  );

  // 水位环在底行最右 —— 那一处 align="right" 是对的，一并钉住防止被"统一"改坏。
  const panel = stripComments(
    read('src/components/newtab/workflow/agent/AgentPanel.vue')
  );
  const ringAt = panel.indexOf('agent-context-ring');
  assert.ok(ringAt > 0, '找不到水位环，守卫要重写');
  const ddStart = panel.lastIndexOf('<agent-dropdown', ringAt);
  assert.ok(ddStart > 0, '找不到包着水位环的下拉，守卫要重写');
  assert.match(
    panel.slice(ddStart, ringAt),
    /align="right"/,
    '水位环在底行最右，弹层必须右对齐（align="left" 会让它往右铺出侧栏）'
  );
});

test('守卫：删除在会话下拉里，且可点控件都有底色', () => {
  // 用户 2026-10-05 反馈：① 交互控件没有底色，与面板背景融为一体看不出能点；
  // ② 「⋯」溢出菜单纯属多余，删除应该在下拉列表里直接可点。
  const list = stripComments(
    read('src/components/newtab/workflow/agent/AgentSessionList.vue')
  );
  // 删除必须挂在**每一行**上并带上会话 id，不能是列表底部那个
  // 「删除当前会话」—— 那样想删一条旧会话就得先切过去（用户 2026-10-05 反馈）
  assert.match(
    list,
    /@click="emit\('delete', s\.id\)"/,
    '每行必须自带删除按钮，并把该行的会话 id 带上来'
  );
  // 行主体与删除是两个独立 button。取「删除按钮自己的那个 <button ... >」，
  // 它里面不能再出现 select 的 emit —— 否则点删除会连带切换会话。
  // （上一版写成「从 select 那行往后切 400 字符、再断言里面没有 select」，
  //  那段切片自己就以 select 开头，守卫在断言一件它自己制造的事。）
  const delAt = list.indexOf(`@click="emit('delete', s.id)"`);
  assert.ok(delAt > 0, '删除按钮必须存在');
  const delTag = list.slice(list.lastIndexOf('<button', delAt), delAt);
  assert.doesNotMatch(
    delTag,
    /emit\('select'/,
    '删除按钮不能复用行主体的点击处理（会连带切换会话）'
  );
  assert.doesNotMatch(
    delTag,
    /emit\('select'/,
    '删除按钮不能复用行主体的点击处理（会连带切换会话）'
  );
  // 删除按钮要有破坏性红信号。刻意接受 hover 才变红：满列表常红的垃圾桶
  // 很吵，而且这行的区分主要靠结构（独立按钮 + 垃圾桶图标 + 二次确认）而非颜色。
  // 但「必须存在红色信号」这条不放宽。
  // T-213：色从 `text-red-500 dark:text-red-400` 双声明换成单一语义 token
  // `text-danger`（跨主题）—— 与 fg-* 同一次迁移思路。判据因此同时接受两种形态。
  assert.match(
    list,
    /hover:(?:text-danger|text-red-\d+)|(?:^|\s)text-danger|(?:^|\s)text-red-\d+/,
    '删除是破坏性操作，要有破坏性配色与「切换会话」区分开'
  );
  assert.match(
    list,
    /hover:(?:text-danger|text-red-\d+)/,
    '删除按钮 hover 时要变红（常红太吵，但完全没有红信号也不行）'
  );

  // host 必须真的按 id 删，而不是恒定删当前会话
  const host = stripComments(
    readFileSync(join(ROOT, 'src/composable/agentHost.js'), 'utf8')
  );
  assert.match(
    host,
    /function deleteAgentSession\(targetId\)/,
    'deleteAgentSession 必须接受要删的会话 id'
  );
  assert.doesNotMatch(
    host,
    /agent\.sessionId !== id/,
    '确认回调不能再要求「仍是当前会话」—— 那会否掉删非当前会话的合法操作'
  );

  // 可点控件用项目通用的 bg-box-transparent（工作流块、Autocomplete、Packages
  // 等 46+ 处在用）。只有 hover 没有底色的控件会与面板背景糊在一起。
  // T-213：header 拆两行，标题与新建都是可点控件。
  // 2026-10-10：左侧的历史入口图标（session-chip）与它打开的历史视图一起
  // 撤掉 —— T-213 让标题成了会话下拉后两者是同一份列表的两张脸（用户实证）。
  // 可点控件只剩「标题（下拉触发器）」与「新建」两个。
  const panel = stripComments(readFileSync(panelPath, 'utf8'));
  assert.doesNotMatch(
    panel,
    /data-test="session-chip"/,
    '历史入口图标已随历史视图一起撤掉 —— 别把它加回来，下拉就是唯一入口'
  );
  assert.match(
    panel,
    /bg-box-transparent[^>]*>[\s\S]{0,900}riAddLine/,
    '新建会话按钮必须有底色'
  );
  // T-213：标题也是可点控件（点开 = 会话下拉），同样要有底色。
  const titleAt = panel.indexOf('data-test="session-title"');
  assert.ok(titleAt > 0, '标题必须存在（T-213 起它同时是会话下拉的触发器）');
  assert.match(
    panel.slice(Math.max(0, titleAt - 700), titleAt),
    /bg-box-transparent/,
    '标题（会话下拉触发器）必须有底色，否则看不出能点'
  );
  // T-213：标签页 chip 三态各有自己的"是个盒子"信号 —— 自动态用
  // bg-box-transparent（最轻），固定态用 bg-surface + border-line（最实）。
  // 两者都算数，只要它不是一个"裸文字行"。
  const picker = stripComments(
    read('src/components/newtab/workflow/agent/AgentTabPicker.vue')
  );
  assert.match(
    picker,
    /bg-box-transparent/,
    '标签页 chip 的自动态必须有底色（bg-box-transparent）'
  );
  assert.match(
    picker,
    /border-line bg-surface/,
    '标签页 chip 的固定态要有 surface + line 边 —— 这是三态里最重的一档'
  );
});

test('守卫：图标名必须存在于项目白名单 vRemixicon.js', () => {
  // T-87：agent 面板 5 个图标名在白名单里根本不存在，渲染成空 SVG 且不报错 ——
  // 用户看到的「删除按钮从头到尾不显示」就是这个。
  // 根因是本项目用的是**改名过的 fork**（删除图标叫 riDeleteBin7Line 而不是
  // 上游的 riDeleteBinLine），凭记忆拼 RemixIcon 名字必然踩空。
  const lib = stripComments(
    readFileSync(join(ROOT, 'src/lib/vRemixicon.js'), 'utf8')
  );
  const allowed = new Set(
    [...lib.matchAll(/\bri[A-Z][A-Za-z0-9]*/g)].map((m) => m[0])
  );
  assert.ok(allowed.size > 100, '白名单解析异常，守卫本身失效');

  const dir = join(ROOT, 'src/components/newtab/workflow/agent');
  const bad = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.vue')) continue;
    const src = readFileSync(join(dir, f), 'utf8');
    // 静态 name="riX" 与动态 :name="'riA' : 'riB'" 都要扫 —— 折叠卡两处
    // riArrowDownSLine 死名当初就因动态绑定躲过了只扫静态的守卫（T-87 收尾补漏）。
    for (const m of stripComments(src).matchAll(/:?\bname="([^"]+)"/g)) {
      for (const icon of m[1].matchAll(/\bri[A-Z][A-Za-z0-9]*/g)) {
        if (!allowed.has(icon[0])) bad.push(`${f}: ${icon[0]}`);
      }
    }
  }
  assert.deepEqual(
    bad,
    [],
    `这些图标名不在 src/lib/vRemixicon.js 白名单里，会渲染成空 SVG：\n${bad.join(
      '\n'
    )}`
  );
});

test('守卫：从 v-remixicon import 的图标名都必须是上游真有的', () => {
  // 本地白名单只证明「我们 import 了它」，**不证明上游有这个图标**。
  // v-remixicon@0.1.4 的图标集比记忆里的 RemixIcon 旧：riSparklingLine /
  // riCheckCircleLine 都不在里面，但只要在 src/lib/vRemixicon.js 里写上一行
  // import，v-remixicon 照样安静地把它们渲染成空 SVG（控制台只有一条
  // 「name of the icon is incorrect」）。上一个守卫（.vue 引用 ⊆ 本地白名单）
  // 对这个洞**完全无感** —— 两处一拼就放行了。这是 2026-10-06 真踩的一次。
  //
  // 只查 import 块：icons 映射里还有一批**内联手抄的 SVG path**（riKey、
  // mdi*），它们本来就不来自上游，全文件扫会把它们误报成「上游没有」。
  const lib = stripComments(
    readFileSync(join(ROOT, 'src/lib/vRemixicon.js'), 'utf8')
  );
  const importBlock = lib.match(
    /import\s*\{([\s\S]*?)\}\s*from\s*'v-remixicon\/icons'/
  );

  assert.ok(importBlock, '没找到 v-remixicon/icons 的 import 块，守卫本身失效');

  const declared = new Set(
    [...importBlock[1].matchAll(/\bri[A-Z][A-Za-z0-9]*/g)].map((m) => m[0])
  );
  assert.ok(declared.size > 100, 'import 块解析异常，守卫本身失效');

  const upstream = stripComments(
    readFileSync(join(ROOT, 'node_modules/v-remixicon/icons.js'), 'utf8')
  );
  const exists = new Set(
    [...upstream.matchAll(/export const (ri[A-Za-z0-9]+)/g)].map((m) => m[1])
  );
  assert.ok(exists.size > 500, '上游 icons.js 解析异常，守卫本身失效');

  const missing = [...declared].filter((n) => !exists.has(n));

  assert.deepEqual(
    missing,
    [],
    [
      '这些名字在 src/lib/vRemixicon.js 里 import 了，但 v-remixicon 上游没有，加了也只会渲染成空 SVG：',
      ...missing,
    ].join('\n')
  );
});

test('守卫：全仓 .vue 引用的图标名必须在白名单里', () => {
  // T-87/T-88：先用 agent 局部守卫不够 —— 全仓另有 3 处引用了没被 provide 的图标
  // （riSparklingLine ×2 / riDragMoveLine / riListUnordered），局部守卫完全看不到。
  // 这个断言覆盖 src 下全部 .vue，凡是「引用了但没 import」就失败并列出位置。
  const lib = stripComments(
    readFileSync(join(ROOT, 'src/lib/vRemixicon.js'), 'utf8')
  );
  const allowed = new Set(
    [...lib.matchAll(/\bri[A-Z][A-Za-z0-9]*/g)].map((m) => m[0])
  );
  assert.ok(allowed.size > 100, '白名单解析异常，守卫本身失效');

  const walk = (dir) => {
    const acc = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) acc.push(...walk(full));
      else if (e.name.endsWith('.vue')) acc.push(full);
    }
    return acc;
  };

  const bad = [];
  for (const f of walk(join(ROOT, 'src'))) {
    const src = stripComments(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/name="(ri[A-Za-z0-9]+)"/g)) {
      if (!allowed.has(m[1])) bad.push(`${f.replace(ROOT, '')}: ${m[1]}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    `这些图标名没在 src/lib/vRemixicon.js 里 import，会静默渲染成空 SVG：\n${bad.join(
      '\n'
    )}`
  );
});

test('守卫：面板只能读 agentHost 真实暴露的字段', () => {
  // 用户 2026-10-06 报：下拉选中会话后，header chip 仍显示占位文案。
  // 根因是字段名对不上 —— host 上叫 `sessionId`，面板读的是 `currentSessionId`，
  // 于是 `sessions.find(s => s.id === undefined)` 恒为 undefined，永远落回占位符。
  // 同一个错还让下拉里当前会话的高亮/勾选一起失效（同一个 undefined）。
  //
  // 这个断言从 agentHost 的 reactive({...}) 与 Object.assign(agent, {...}) 两处
  // 解析出**真实暴露**的字段名，面板读任何一个不在其中的字段就失败。
  const host = stripComments(
    readFileSync(join(ROOT, 'src/composable/agentHost.js'), 'utf8')
  );
  const exposed = new Set();
  const rs = host.indexOf('reactive({');
  const re = host.indexOf('});', rs);
  for (const m of host.slice(rs, re).matchAll(/^\s{4}([A-Za-z]\w*):/gm))
    exposed.add(m[1]);
  const os = host.indexOf('return Object.assign(agent, {');
  const oe = host.indexOf('});', os);
  for (const m of host.slice(os, oe).matchAll(/^\s{4}([A-Za-z]\w*)[,:]/gm))
    exposed.add(m[1]);

  assert.ok(exposed.has('sessionId'), '没解析出 sessionId，守卫本身失效');
  assert.ok(exposed.size > 10, '暴露字段数异常，守卫本身失效');

  const panel = stripComments(
    read('src/components/newtab/workflow/agent/AgentPanel.vue')
  );
  const bad = [
    ...new Set([...panel.matchAll(/host\.([A-Za-z]\w*)/g)].map((m) => m[1])),
  ].filter((f) => !exposed.has(f));
  assert.deepEqual(
    bad,
    [],
    'AgentPanel 读了 agentHost 不存在的字段（运行时恒为 undefined）：' +
      bad.join(', ')
  );
});

// —— T-81a：/ 模板菜单的接线守卫 ——

test('T-81a 守卫：面板的 / 菜单必须走 customizations 的纯函数，不许就地重写解析', () => {
  const src = stripComments(
    read('src/components/newtab/workflow/agent/AgentPanel.vue')
  );

  assert.match(
    src,
    /import\s*\{[^}]*parseSlashDraft[^}]*\}\s*from\s*'@\/agent\/customizations'/,
    '触发解析必须用 parseSlashDraft（有单测），在面板里手写正则会漂移'
  );
  assert.match(
    src,
    /filterCommands/,
    '过滤必须用 filterCommands（只回 enabled 且有正文的项）'
  );
  assert.match(src, /loadCommands/, '菜单数据来自存储的模板列表');
});

test('T-81a 守卫：菜单开着时回车必须被路由给菜单，不能直达 send', () => {
  const src = stripComments(
    read('src/components/newtab/workflow/agent/AgentPanel.vue')
  );

  // 回归形状：只绑 @keydown.enter.exact.prevent="send" 的话，
  // 菜单开着按回车会把 "/rev" 当消息发出去，选中操作永远无效。
  assert.doesNotMatch(
    src,
    /@keydown\.enter[^>]+onDraftKeydown|@keydown\.enter\.exact\.prevent="send"/,
    '回车必须经 onDraftKeydown 统一路由（菜单开 = 选中，菜单关 = 发送）'
  );
  assert.match(src, /@keydown="onDraftKeydown"/);
  assert.match(src, /pickCommand/);
  assert.match(
    src,
    /slashDismissed/,
    'Esc 关闭后必须能保持关闭（关了又弹等于关不掉）'
  );
});

test('T-81a 守卫：选中模板后整框替换 draft', () => {
  const src = stripComments(
    read('src/components/newtab/workflow/agent/AgentPanel.vue')
  );

  assert.match(
    src,
    /draft\.value\s*=\s*c\.body/,
    '选定模板的语义是「整框替换」，不是追加（追加会留下 /xxx 前缀）'
  );
});

test('T-109 守卫：事件流必须有空态，用的文案键两种语言都得在', () => {
  // 2026-10-06 实测：T-103 删设置页说明段落时把 workflow.agent.empty 一起删掉了，
  // 键留在 locale 里却没有引用点 —— 新会话的正文区整个空白，连一句提示都没有。
  const src = stripComments(
    read('src/components/newtab/workflow/agent/AgentTranscript.vue')
  );

  assert.match(
    src,
    /v-if="items\.length === 0"/,
    '没有空态分支：items 为空时事件流什么都不渲染，正文区一片空白'
  );
  assert.match(
    src,
    /t\('workflow\.agent\.empty'\)/,
    '空态没有引用 workflow.agent.empty（键在 locale 里，但不是死键就是白留）'
  );

  // 键必须两种语言都在，否则空态渲染出来是裸 key
  for (const lang of ['zh', 'en']) {
    const locale = JSON.parse(read(`src/locales/${lang}/newtab.json`));
    assert.equal(
      typeof locale.workflow.agent.empty,
      'string',
      `${lang}/newtab.json 缺 workflow.agent.empty，空态会渲染成裸 key`
    );
    assert.ok(
      locale.workflow.agent.empty.trim().length > 0,
      `${lang}/newtab.json 的 workflow.agent.empty 是空串`
    );
  }
});

test('T-13 守卫：事件流是 log 活区，折叠控件都带 aria-expanded', () => {
  // 2026-10-06 实测：滚动容器只有 class，没有 role / aria-live ——
  // 读屏软件完全听不到助手新到的回答与工具结果。
  const src = stripComments(
    read('src/components/newtab/workflow/agent/AgentTranscript.vue')
  );

  for (const attr of [
    'role="log"',
    'aria-live="polite"',
    'aria-relevant="additions"',
  ]) {
    assert.ok(
      src.includes(attr),
      `滚动容器缺 ${attr}：事件流对屏幕阅读器不再是活区`
    );
  }

  // 两个折叠卡（思考过程 / 压缩摘要）都由 open 状态驱动，必须报出展开与否
  const expanded = src.match(/:aria-expanded="item\.open"/g) || [];
  assert.equal(
    expanded.length,
    2,
    '折叠按钮必须恰好两处带 :aria-expanded="item.open"（思考卡 + 压缩摘要卡）'
  );

  const tool = stripComments(
    read('src/components/newtab/workflow/agent/AgentToolStep.vue')
  );
  assert.match(
    tool,
    /:aria-expanded="expanded"/,
    '工具卡的展开按钮没报 aria-expanded'
  );
});

test('T-13 守卫：工具状态不能只靠颜色 —— 每个状态都得有图标', () => {
  // 红/绿/琥珀对色觉障碍用户是一条通道；失败（✕）与被拒（⊗）最容易混，
  // 状态表里的每个取值都必须映射到一个图标。
  const tool = stripComments(
    read('src/components/newtab/workflow/agent/AgentToolStep.vue')
  );
  const events = read('src/agent/events.js');

  const statusBlock = /export const TOOL_STATUS = \{([\s\S]*?)\n\};/.exec(
    events
  );
  assert.ok(statusBlock, '没解析出 TOOL_STATUS，守卫本身失效');
  const pairs = [...statusBlock[1].matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [
    m[1],
    m[2],
  ]);
  assert.ok(
    pairs.length >= 5,
    `TOOL_STATUS 只解析出 ${pairs.length} 个，守卫本身失效`
  );

  const iconBlock = /const STATUS_ICON = \{([\s\S]*?)\n\};/.exec(tool);
  assert.ok(
    iconBlock,
    'AgentToolStep 里没有 STATUS_ICON 表（状态又退回纯色了）'
  );
  const icons = new Set(
    [...iconBlock[1].matchAll(/TOOL_STATUS\.(\w+)\s*\]/g)].map((m) => m[1])
  );

  for (const [key] of pairs) {
    assert.ok(icons.has(key), `状态 ${key} 没有图标，只剩颜色一条区分通道`);
  }

  // 图标必须真的渲染出来，而不是定义了表不用
  assert.match(
    tool,
    /v-remixicon\s+:name="statusIcon"/,
    '模板里没渲染 statusIcon'
  );
});

test('T-07 守卫：工具卡渲染的是剥过标签的观察值，不是原始 observation', () => {
  // untrusted_* 标签与 note 截断注记是写给模型看的，直接摊给用户会被当成乱码/漏洞。
  // 守卫盯两件事：模板绑的是剥离后的 computed，且没有哪处又把原始值绑回去。
  const tool = stripComments(
    read('src/components/newtab/workflow/agent/AgentToolStep.vue')
  );

  assert.match(
    tool,
    /stripUntrustedForDisplay\(/,
    '工具卡没有调用 stripUntrustedForDisplay（untrusted 标签会原样摊给用户）'
  );
  assert.match(
    tool,
    /displayObservation/,
    '模板里没有 displayObservation：剥离结果没被用上'
  );
  assert.ok(
    !/\{\{\s*step\.observation\s*\}\}/.test(tool),
    '模板里仍直接渲染 step.observation —— 等于没剥'
  );
});

test('T-08 守卫：目标页条要显示失效态', () => {
  // chip 渲染 state/pinned 并有失效分支（视图层，组件测试够不着所以钉源码）。
  // 监听成对摘除 + 健康态判定已随 T-227 行为化：agentHost.test.js 的
  // dispose 对称测试与「固定目标页被关」分发测试接棒，这里不再抓宿主源码。
  const picker = stripComments(
    read('src/components/newtab/workflow/agent/AgentTabPicker.vue')
  );
  assert.match(picker, /stale/, 'chip 没有失效态分支');
  assert.match(picker, /staleClosed/, 'chip 没有「目标页已关闭」的文案分支');
  assert.match(picker, /staleDrift/, 'chip 没有「目标页已跳转」的文案分支');
  assert.match(picker, /pickTab\.pinned/, 'chip 没有「固定 / 自动」的来源徽标');
  assert.match(picker, /favIconUrl/, 'chip 没有站点图标');
});

test('T-04 守卫：错误独立成类，重试与复制详情都要有，且每个 errorKind 都有文案', () => {
  const transcript = stripComments(
    read('src/components/newtab/workflow/agent/AgentTranscript.vue')
  );
  // T-53：折叠分支搬到 fold.js，断言随之改锚（留在 .vue 上会永远为真）
  const fold = stripComments(read('src/agent/fold.js'));

  // ① agent:error 不能再走 notice 通道
  const errorCase = fold.match(
    /case AGENT_EVENTS\.ERROR:[\s\S]{0,400}?return;/
  );
  assert.ok(errorCase, '没解析出 ERROR 分支，守卫本身失效');
  assert.ok(
    /type:\s*'error'/.test(errorCase[0]),
    'agent:error 仍被 push 成 notice —— 错误又和预检提示同色了'
  );
  assert.ok(
    !/type:\s*'notice'/.test(errorCase[0]),
    'ERROR 分支里不该再出现 notice'
  );

  // ② 三件套：错误图标 / 重试 / 复制详情
  assert.match(transcript, /riErrorWarningLine/, '错误卡没有图标');
  assert.match(transcript, /emit\('retry'/, '没有把重试交回宿主');
  assert.match(transcript, /clipboard\.writeText/, '没有复制详情');

  // ③ events.js 的 ERROR_KIND 每新增一档都得有文案
  const eventsSrc = readFileSync(join(ROOT, 'src/agent/events.js'), 'utf8');
  const kindBlock = eventsSrc.match(/ERROR_KIND = \{([\s\S]*?)\n\};/);
  assert.ok(kindBlock, '没解析出 ERROR_KIND，守卫本身失效');
  const kinds = [...kindBlock[1].matchAll(/(\w+):\s*'([^']+)'/g)].map(
    (m) => m[2]
  );
  assert.ok(
    kinds.length >= 6,
    `ERROR_KIND 只解析出 ${kinds.length} 个，守卫本身失效`
  );
  const labelBlock = transcript.match(/ERROR_KIND_LABEL = \{([\s\S]*?)\n\};/);
  assert.ok(labelBlock, '没解析出 ERROR_KIND_LABEL');
  const mapped = [...labelBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const missing = kinds.filter((k) => !mapped.includes(k));
  assert.deepEqual(
    missing,
    [],
    '这些 errorKind 没有文案，界面上会退成兜底文案：' + missing.join(',')
  );
});

test('T-11 守卫：busy 时禁用态要给理由', () => {
  // ① 三个禁用控件都必须在 busy 时把 title 换成「为什么点不动」
  const panel = stripComments(
    read('src/components/newtab/workflow/agent/AgentPanel.vue')
  );
  assert.match(
    panel,
    /host\.busy[\s\S]{0,200}session\.busyHint/,
    '新建按钮 busy 时没换 title —— 禁用态仍然没有理由'
  );

  const list = stripComments(
    read('src/components/newtab/workflow/agent/AgentSessionList.vue')
  );
  // 按 :disabled="disabled" 切段：**每一个**禁用控件后面都得紧跟 busyHint。
  // 数字写死成 3（行主体 + 删除按钮 + 行容器另算）是刻意的 —— 新增禁用控件时
  // 守卫会失败，逼着同时补上「为什么点不动」。
  const afterDisabled = list.split(':disabled="disabled"').slice(1);
  assert.equal(
    afterDisabled.length,
    2,
    `禁用控件数变成 ${afterDisabled.length} 个了，新增禁用控件要一并补 busyHint 理由`
  );
  for (const seg of afterDisabled) {
    assert.match(
      seg.slice(0, 400),
      /session\.busyHint/,
      '有一个 disabled 控件在 busy 时没给理由'
    );
  }

  // ② 中止回执已随 T-227 行为化：agentHost.test.js 的
  // 「DONE(aborted) 补一条中止回执」接棒，这里不再抓宿主源码。
});

test('T-52 守卫：工具卡的参数三段链路不许断（事件带 args → 合并保留 → 渲染）', () => {
  // 这条 bug 的真实成因是**链路**断在中间：事件不带 args 时，卡片里的
  // <pre> 永远不渲染，而现象只是「参数区是空的」，看着像组件没写。
  // T-74 方案 B 已经把 args 放进 TOOL_CALL 事件（loop.test.js 钉着），
  // 但「面板合并时保留 args」与「prettyArgs 非空即渲染」这两段从没有守卫 ——
  // 少了任一段，卡片又会空回去且没有任何测试变红。

  // ① 事件层：message_end 映射出 TOOL_CALL 时必须带 args
  const loop = stripComments(read('src/agent/loop.js'));
  assert.match(
    loop,
    /AGENT_EVENTS\.TOOL_CALL[\s\S]{0,120}?args:\s*calls\[0\]\.arguments/,
    'loop.js 的 TOOL_CALL 映射必须带 args —— 少了它卡片参数恒空'
  );

  // ② 合并层：TOOL_RESULT 事件本身没有 args，合并时不能把已有 args 抹掉
  // （T-53：合并逻辑已搬到 fold.js）
  const fold = stripComments(read('src/agent/fold.js'));
  assert.match(
    fold,
    /args:\s*ev\.args\s*!==\s*undefined\s*\?\s*ev\.args\s*:\s*target\.args/,
    '合并卡片的逻辑必须保留 TOOL_CALL 带进来的 args（ev.args 缺席时回落 target）'
  );

  // ③ 渲染层：args 非空即渲染参数块
  //
  // T-161 附注：`[\s\S]{0,80}?` 是刻意的 —— 原来写死 `<pre v-if="prettyArgs"`，
  // 一给 <pre> 加 class 导致 prettier 把属性换行，守卫就误报「链路断了」（实测：
  // T-157 加 break-words 后这条立刻假红）。守卫钉的是**语义**（参数块由
  // prettyArgs 驱动），不是缩进格式，所以容忍换行；把 v-if 改成别的仍然会红。
  const step = stripComments(
    read('src/components/newtab/workflow/agent/AgentToolStep.vue')
  );
  assert.match(step, /const prettyArgs = computed/, '工具卡必须有 prettyArgs');
  assert.match(
    step,
    /<pre[\s\S]{0,80}?v-if="prettyArgs"/,
    '参数块必须由 prettyArgs 驱动渲染，否则 args 到了也不显示'
  );
});

test('守卫：import 清单必须全部注册进 icons 表（半截接线不许存在）', () => {
  // T-108/T-31：`import` 了但没进 `export const icons` 表，是**半截接线** ——
  // 组件走 injectIcons[name] === undefined 分支，只在控制台打一行 error 就渲染
  // 空 SVG（用户看到的是「图标没了」），而两个方向的老守卫都看不见：
  // ① 「.vue 引用 ⊆ import 清单」看到名字在清单里，放行；
  // ② 「import ⊆ 上游」也放行。症状恰好是 ESLint 的 no-unused-vars，
  // 也就是「lint 红了但没人当回事」—— 宁可让 lint 真绿，也不要它长期当摆设。
  const lib = stripComments(
    readFileSync(join(ROOT, 'src/lib/vRemixicon.js'), 'utf8')
  );
  const importBlock = lib.match(
    /import\s*\{([\s\S]*?)\}\s*from\s*'v-remixicon\/icons'/
  );
  const mapBlock = lib.match(/export const icons = \{([\s\S]*?)\n\};/);

  assert.ok(importBlock, '没找到 import 块，守卫本身失效');
  assert.ok(mapBlock, '没找到 icons 注册表，守卫本身失效');

  const names = (src) =>
    new Set([...src.matchAll(/\bri[A-Z][A-Za-z0-9]*/g)].map((m) => m[0]));
  const declared = names(importBlock[1]);
  const registered = names(mapBlock[1]);
  assert.ok(declared.size > 100, 'import 块解析异常，守卫本身失效');
  assert.ok(registered.size > 50, 'icons 表解析异常，守卫本身失效');

  const missing = [...declared].filter((n) => !registered.has(n));
  assert.deepEqual(
    missing,
    [],
    [
      '这些图标 import 了但没注册进 export const icons —— 会静默渲染成空 SVG：',
      ...missing,
    ].join('\n')
  );
});

// T-67（send 判空顺序）与 T-66（specific 文案三档）已随 T-227 行为化：
// agentHost.test.js 的「runtime 未就绪时给一句人话」「配置错误：specific 文案优先」
// 直接驱动真工厂断言行为，源码正则守卫退役。

test('T-68：窗口分组一律显示「窗口 N」，不许特判 id === 1 当主窗口', () => {
  const listSrc = read('src/components/newtab/workflow/agent/AgentTabList.vue');

  const fnAt = listSrc.indexOf('function windowLabel(id)');
  assert.ok(fnAt > 0, 'AgentTabList 里的 windowLabel 找不到了');
  const body = listSrc.slice(fnAt, listSrc.indexOf('\n}', fnAt));

  assert.ok(
    !/id\s*===\s*1/.test(body),
    'Chrome 的窗口 id 不保证是 1，特判会把标签标错：' + body
  );
  assert.ok(
    !body.includes('mainWindow'),
    '不再有「主窗口」这个概念，locale 键也应一并删掉'
  );
  assert.ok(
    body.includes("t('workflow.agent.pickTab.window', { n: id })"),
    '窗口标签必须是带 id 的通用形式'
  );
});

test('T-68：mainWindow 这把 locale 键不能留成孤儿', () => {
  const listSrc = read('src/components/newtab/workflow/agent/AgentTabList.vue');

  for (const lang of ['zh', 'en']) {
    const locale = read(`src/locales/${lang}/newtab.json`);
    if (!locale.includes('"mainWindow"')) continue;

    assert.fail(
      `src/locales/${lang}/newtab.json 还留着 mainWindow，但代码里已无人引用（孤儿键）`
    );
  }
  assert.ok(!listSrc.includes('mainWindow'), '组件侧也不该再提这个词');
});
// —— T-12：输入框 autoresize + 插话入队的常驻反馈 ——

test('T-12：面板输入框开 autoresize，且有 max-h 兜底（320px 侧栏不能被撑破）', () => {
  // 先剥注释：说明文字里提到 rows="3" 是在讲「原来钉死了」，不是属性本身。
  // 不剥的话这条守卫会被自己的注释判红（第一次跑就是这么红的）。
  const panelSrc = stripComments(
    read('src/components/newtab/workflow/agent/AgentPanel.vue')
  );

  const at = panelSrc.indexOf('<ui-textarea');
  assert.ok(at > 0, '面板里找不到 ui-textarea');
  const tag = panelSrc.slice(at, panelSrc.indexOf('/>', at));

  // 只认**裸属性** autoresize —— `:autoresize="false"` 里也有这五个字母，
  // 用 \bautoresize\b 分不开（第一次变异就栽在这：改成 false 后守卫照样绿）。
  assert.ok(
    /(^|\s)autoresize(\s|=|\/>|$)/.test(tag) && !/:autoresize/.test(tag),
    '输入框必须开 autoresize（且不能是 :autoresize="false"），否则长指令只能在固定三行里滚'
  );
  assert.ok(
    !/rows="3"/.test(tag),
    'rows="3" 与 autoresize 同时存在时，高度会被 rows 钉死'
  );
  assert.ok(
    /max-h-\[\d+px\]/.test(tag),
    'autoresize 必须配 max-h 兜底，否则长草稿会把对话正文挤没'
  );
  assert.ok(
    /overflow-y-auto/.test(tag),
    '超过 max-h 后要内部滚动，而不是把框继续撑高'
  );
});

test('T-12：UiTextarea 的 autoresize 要在打字与程序化改值时都重算', () => {
  const src = read('src/components/ui/UiTextarea.vue');

  // 窗口定位用「emitValue …… onMounted 之间」这段，而不是找固定缩进的收尾大
  // 括号 —— 那是脆弱写法：变异把收尾括号缩进改掉后窗口会一路越过函数尾，把
  // watch 里的调用算进来，守卫假绿（变异 7 实测）。惰性匹配 + 后置上下文
  // （后面必须紧跟 onMounted）保证匹配到的确实是 emitValue 的整个函数体。
  const body =
    /function emitValue[\s\S]*?\n\s*\}\s*\n\s*onMounted\(calcHeight\)/.exec(
      src
    );
  assert.ok(body, '定位不到 emitValue 的函数体（守卫窗口失效）');
  assert.ok(
    /nextTick\(calcHeight\)/.test(body[0]),
    'emitValue 里必须重算高度，否则只有 onMounted 那一次生效（这行曾被注释掉）'
  );
  assert.ok(
    /watch\([\s\S]*props\.modelValue/.test(src),
    '程序化改值（清空草稿、/ 模板填入）也要重算，否则框比内容慢一拍'
  );
});

test('T-12：插话入队要有常驻反馈，且计数来自运行时真实队列长度', () => {
  const panelSrc = read('src/components/newtab/workflow/agent/AgentPanel.vue');
  const hostSrc = read('src/composable/agentHost.js');
  const indexSrc = read('src/agent/index.js');

  assert.ok(
    /v-if="host\.busy && host\.pendingInterjections > 0"/.test(panelSrc),
    '面板要常驻显示已入队的插话条数（busy 且队列非空）'
  );
  assert.ok(
    panelSrc.includes("t('workflow.agent.queuedPending', {"),
    '提示语要走 i18n'
  );
  assert.ok(
    hostSrc.includes('pendingInstructionCount()'),
    '宿主必须从运行时读真实队列长度，不能自己 +1 猜'
  );
  assert.ok(
    indexSrc.includes('pendingInstructionCount() {'),
    '运行时要有 pendingInstructionCount 这个只读入口'
  );
  // 送达方向（onEvent 里重读长度）已随 T-227 行为化：agentHost.test.js 的
  // 「计数随事件同步」直接断言 host.pendingInterjections 等于运行时真实值，
  // 原先的 onEvent 位置断言退役。
});

test('T-12：queuedPending 键不能只在一边有（zh/en 都要）', () => {
  for (const lang of ['zh', 'en']) {
    const locale = JSON.parse(read(`src/locales/${lang}/newtab.json`));

    assert.equal(
      typeof locale.workflow.agent.queuedPending,
      'string',
      `${lang}/newtab.json 缺 workflow.agent.queuedPending`
    );
    assert.ok(
      locale.workflow.agent.queuedPending.includes('{n}'),
      `${lang} 的 queuedPending 少了 {n} 占位符，条数显示不出来`
    );
  }
});

// —— T-16：整条回答可复制（原来只有代码块能复制）——

test('T-16：assistant 回答要有整条复制入口，且复制的是原文', () => {
  const src = read('src/components/newtab/workflow/agent/AgentMarkdown.vue');
  const btnAt = src.indexOf('@click="copy(props.raw)"');
  assert.ok(
    btnAt > 0,
    '找不到「复制整条」的按钮 —— 现在只有代码块能复制，assistant 长回答搬不走'
  );
  // 复制原文而不是把 blocks 拼回去：拼回去会丢原文换行与标记
  assert.ok(
    /@click="copy\(props\.raw\)"/.test(src),
    '复制的内容必须是 props.raw（原始 markdown 全文）'
  );
  // 按钮得 hover/focus 都能显形，否则键盘用户永远看不到它。
  // 窗口要从 <button 开始而不是从 @click 开始 —— class 属性在 @click **之前**，
  // 只往后切会把 class 切出窗口（第一版就这么写的，守卫对着空窗口判红）。
  const tag = src.slice(
    src.lastIndexOf('<button', btnAt),
    src.indexOf('</button>', btnAt)
  );
  assert.ok(/group-hover:opacity-100/.test(tag), '复制按钮要 hover 才显形');
  assert.ok(
    /focus:opacity-100/.test(tag),
    '复制按钮要 focus 也显形（opacity-0 不影响 tab 顺序，但键盘用户看不到就等于没有）'
  );
});

test('T-16：整条复制的反馈与文案都要走 i18n', () => {
  const src = read('src/components/newtab/workflow/agent/AgentMarkdown.vue');

  assert.ok(src.includes("t('workflow.agent.copyAll')"), '按钮文案要走 i18n');
  assert.ok(
    src.includes('copied === props.raw'),
    '「已复制」反馈要认这条内容的身份，不能和代码块的 copied 串台'
  );
  for (const lang of ['zh', 'en']) {
    const locale = JSON.parse(read(`src/locales/${lang}/newtab.json`));
    assert.equal(
      typeof locale.workflow.agent.copyAll,
      'string',
      `${lang}/newtab.json 缺 workflow.agent.copyAll`
    );
    assert.ok(
      locale.workflow.agent.copyAll.trim().length > 0,
      `${lang} 的 copyAll 是空串`
    );
  }
});
// —— T-14：流式增量解析的组件接线 ——
//
// 为什么这条守卫是**静态**的：panelRender.test.js 走 SSR，而 SSR **不跑 watcher**
// （见 utils/sfc-render.mjs 的头注），所以「watcher 里到底调了什么」在 SSR 下
// 完全没有覆盖 —— 把 `blocks.value = stream.push(raw)` 换回 `markdownToBlocks(raw)`
// 渲染结果一模一样，变异测试实测 catch 不到。只能在这里钉住接线本身。

test('T-14：AgentMarkdown 要走增量流，且首屏/SSR 仍能整段解析', () => {
  const src = stripComments(
    read('src/components/newtab/workflow/agent/AgentMarkdown.vue')
  );

  assert.ok(
    /import\s*\{[^}]*createMarkdownStream[^}]*\}\s*from\s*'@\/agent\/markdown'/.test(
      src
    ),
    '没从 @/agent/markdown 引入 createMarkdownStream —— 流式又退回整段重解析'
  );
  assert.ok(
    /blocks\.value\s*=\s*stream\.push\(raw\)/.test(src),
    'watcher 里没有用 stream.push(raw) 填充 blocks'
  );
  assert.ok(
    /const blocks = ref\(markdownToBlocks\(props\.raw\)\)/.test(src),
    'blocks 的初值必须同步算出来：SSR 不跑 watcher，初值空的话首屏正文直接没了'
  );
  assert.ok(
    !/computed\(\(\)\s*=>\s*markdownToBlocks\(props\.raw\)\)/.test(src),
    'computed + 整段重解析就是 T-14 要治的那个写法，别改回去'
  );
});

test('T-16：整条复制的按钮必须在 markdown 根容器上（定位要相对整条，不是某个块）', () => {
  const src = read('src/components/newtab/workflow/agent/AgentMarkdown.vue');
  // 不写死属性顺序：ref / class 的先后由 vue/attributes-order 决定，
  // 守卫盯的是「根容器带 relative group」这件事，不是它第几个属性。
  const rootAt = src.search(/<div[^>]*class="group relative/);
  assert.ok(
    rootAt > 0,
    'markdown 根容器要带 relative group，按钮的 absolute 才有参照、hover 才认整条消息'
  );
  assert.ok(
    src.indexOf('@click="copy(props.raw)"') > rootAt,
    '复制按钮要挂在根容器内部'
  );
});

// —— T-206：悬停「复制全文」时高亮将被复制的范围 ——
//
// 参考实现 hover 复制按钮时会给被复制的内容加一层底色；本仓原来只给按钮自己
// 加底色，长对话里多条消息各带一个同款按钮，用户分不清会复制到哪一段。
//
// 关键：`peer-hover` 认的是**前面的兄弟**，所以按钮必须带 `peer` 且在内容
// **之前**。这条顺序一旦被谁调回去，高亮就静默失效（CSS 不报错）—— 必须钉死。
test('T-206：复制按钮带 peer、且在被复制的范围之前（顺序错了高亮会静默失效）', () => {
  const src = stripComments(
    read('src/components/newtab/workflow/agent/AgentMarkdown.vue')
  );

  const btnAt = src.indexOf('@click="copy(props.raw)"');
  assert.ok(btnAt > 0, '找不到整条复制的按钮');
  // 从按钮往前找它自己的起始标签（class 在 @click 之前）。
  const tagStart = src.lastIndexOf('<button', btnAt);
  const tag = src.slice(tagStart, btnAt);
  assert.match(
    tag,
    /\bpeer\b/,
    '复制按钮要带 peer —— 否则下面的 peer-hover 认不到它，高亮永远是空的'
  );

  const scopeAt = src.indexOf('data-test="copy-scope"');
  assert.ok(scopeAt > 0, '被复制范围（copy-scope）不见了');
  assert.ok(
    tagStart < scopeAt,
    '复制按钮必须在 copy-scope **之前**：peer 只认前面的兄弟，放后面高亮会静默失效'
  );
  // class 在 data-test 之前，从标记往回取这一整个开标签。
  const scopeTagStart = src.lastIndexOf('<div', scopeAt);
  const scopeTag = src.slice(scopeTagStart, scopeAt);
  assert.match(
    scopeTag,
    /peer-hover:bg-accent\/5/,
    'copy-scope 要挂 peer-hover:bg-accent/5，hover 按钮时整段才亮'
  );
  assert.match(
    scopeTag,
    /peer-focus:bg-accent\/5/,
    '键盘用户 tab 到按钮时同样要高亮（只做 hover 等于把键盘用户漏掉）'
  );
});

// —— T-205：长用户气泡自动折叠 ——
//
// 判定逻辑在 foldText.test.js（纯模块，边界都在那边钉）；这里只钉组件接线：
// 阈值必须来自纯模块（组件里再写一份 240 就又会两处各说各话）、必须真的量高度、
// 必须有渐隐与开关、文案必须两种语言都在。
test('T-205：长用户气泡折叠的组件接线（阈值来自纯模块 + 量高度 + 渐隐 + 开关）', () => {
  const src = stripComments(
    read('src/components/newtab/workflow/agent/AgentUserBubble.vue')
  );

  assert.ok(
    /import\s*\{[^}]*foldDecision[^}]*\}\s*from\s*'@\/agent\/foldText'/.test(
      src
    ),
    '折叠判定必须调 @/agent/foldText 的 foldDecision，不能在组件里就地写 if (h > 240)'
  );
  assert.ok(
    /USER_FOLD_MAX_PX/.test(src),
    '阈值要取自纯模块的 USER_FOLD_MAX_PX —— 组件里再写一份数字就会与单测脱节'
  );
  assert.ok(
    /scrollHeight/.test(src),
    '必须量 scrollHeight：折叠态外层被 max-height 夹住，offsetHeight 永远等于阈值，量不出真高'
  );
  assert.ok(
    /maxHeight/.test(src),
    '折叠要真的夹高度（max-height），否则「折叠」只是个没落地的变量'
  );
  assert.ok(
    /data-test="user-bubble-fade"/.test(src),
    '折叠态要有底部渐隐，提示「下面还有内容」'
  );
  assert.ok(
    /data-test="user-bubble-toggle"/.test(src) && /aria-expanded/.test(src),
    '展开/收起开关要在，且带 aria-expanded（键盘/读屏用户靠它知道当前状态）'
  );
  for (const lang of ['zh', 'en']) {
    const { agent } = JSON.parse(
      read(`src/locales/${lang}/newtab.json`)
    ).workflow;
    for (const key of ['expandUserMessage', 'collapseUserMessage']) {
      assert.equal(
        typeof agent[key],
        'string',
        `${lang}/newtab.json 缺 workflow.agent.${key}`
      );
    }
  }
});

// 反向自检：用户气泡那一支必须真的用了折叠组件，不能只写了组件没人用。
test('T-205：AgentTranscript 的用户气泡走 AgentUserBubble，旧的裸 div 不许回来', () => {
  const src = stripComments(
    read('src/components/newtab/workflow/agent/AgentTranscript.vue')
  );
  assert.match(
    src,
    /<agent-user-bubble[^>]*v-if="item\.type === 'user'"/,
    '用户气泡要换成 AgentUserBubble（T-205）—— 换回裸 div 等于折叠没了'
  );
});

// —— T-10：空态的示例问法与工具组徽标 ——

test('T-10：徽标与示例必须由宿主的 enabledGroups 推导，组件不许自己含能力知识', () => {
  const hostSrc = read('src/composable/agentHost.js');
  const panelSrc = read('src/components/newtab/workflow/agent/AgentPanel.vue');
  const transcriptSrc = read(
    'src/components/newtab/workflow/agent/AgentTranscript.vue'
  );

  assert.ok(
    hostSrc.includes('groups: capabilityGroups(deps.enabledGroups)'),
    '宿主要从 enabledGroups 推导 groups —— 各页自己写一份清单迟早对不上真实开放项'
  );
  // 「面板说有画布、其实没有」比不说更糟：组件里不许出现按组名的能力分支
  for (const group of ['canvas', 'page', 'context', 'tab']) {
    // 窗口要允许谓词里再出现括号：`groups.some((x) => x.id === 'canvas')`
    // 用 [^)]* 会在这第一层括号就断掉，测不出来（变异 2 实测）。上限 120 字符
    // 防止跨到文件别处误报。
    const branch = new RegExp(
      `groups\\.(some|find|filter|includes)\\([\\s\\S]{0,120}?${group}`
    );
    assert.ok(
      !branch.test(transcriptSrc),
      `AgentTranscript 里出现了对 '${group}' 的特判，能力知识跑到组件里了`
    );
  }
  assert.ok(
    panelSrc.includes('suggestExamples(props.host.groups)'),
    '示例问法要从 host.groups 推导，不能写死在面板里'
  );
});

test('T-10：示例点击只填入草稿，不自动发送', () => {
  const panelSrc = read('src/components/newtab/workflow/agent/AgentPanel.vue');
  const transcriptSrc = read(
    'src/components/newtab/workflow/agent/AgentTranscript.vue'
  );

  assert.ok(
    /@pick-example="draft = \$event"/.test(panelSrc),
    '面板要把 pick-example 接成「填入草稿」，不能接成 host.send（示例是猜的，要能先改）'
  );
  assert.ok(
    /emit\('pick-example', ex\.text\)/.test(transcriptSrc),
    '示例按钮要 emit 文本'
  );
});

test('T-10：空态仍要引用 workflow.agent.empty（T-109 回归）', () => {
  const transcriptSrc = read(
    'src/components/newtab/workflow/agent/AgentTranscript.vue'
  );
  assert.ok(
    /v-if="items\.length === 0"/.test(transcriptSrc),
    '空态分支不见了：items 为空时正文区一片空白'
  );
  assert.ok(
    transcriptSrc.includes("t('workflow.agent.empty')"),
    '空态原有的一句提示不能被示例替换掉 —— 示例可能一条都没有（limit=0）'
  );
});

test('T-10：四个工具组的徽标文案 zh/en 都要在', () => {
  for (const lang of ['zh', 'en']) {
    const locale = JSON.parse(read(`src/locales/${lang}/newtab.json`));
    for (const group of ['page', 'context', 'tab', 'canvas']) {
      assert.equal(
        typeof locale.workflow.agent.group[group],
        'string',
        `${lang}/newtab.json 缺 workflow.agent.group.${group}，徽标会渲染成裸 key`
      );
      assert.ok(
        locale.workflow.agent.group[group].trim().length > 0,
        `${lang} 的 group.${group} 是空串`
      );
    }
  }
});

// —— T-09：轮次分隔、模型名、上下文水位 ——

test('T-09：START 必须带 at 时间戳，且折叠层要有 turn 分支（原来一律丢弃）', () => {
  const loopSrc = read('src/agent/loop.js');
  const transcriptSrc = read(
    'src/components/newtab/workflow/agent/AgentTranscript.vue'
  );
  // T-53：折叠层已抽到 fold.js，分支断言随之改锚到那里 —— 留在 .vue 上会
  // 变成永远为真的假通过。
  const foldSrc = read('src/agent/fold.js');

  assert.ok(
    /kind: AGENT_EVENTS\.START, at: Date\.now\(\)/.test(loopSrc),
    'START 要带 at —— 分隔线上的时间必须是真实发生时刻，回看历史会话时不是「打开的时间」'
  );
  assert.ok(
    /case AGENT_EVENTS\.START:[\s\S]{0,200}?push\(\{ type: 'turn'/.test(
      foldSrc
    ),
    '折叠层必须有 START 分支并折成 turn 槽位（以前一律落 default 被丢弃）'
  );
  assert.ok(
    /v-else-if="item\.type === 'turn'"/.test(transcriptSrc),
    'turn 槽位要有渲染分支，否则折出来也没人画'
  );
});

test('T-09 / T-153：模型名与上下文水位要真的从 config 传下去', () => {
  const panelSrc = read('src/components/newtab/workflow/agent/AgentPanel.vue');
  const listSrc = read(
    'src/components/newtab/workflow/agent/AgentSessionList.vue'
  );
  const ringSrc = read(
    'src/components/newtab/workflow/agent/AgentContextRing.vue'
  );

  assert.ok(
    panelSrc.includes(':model="host.config.model"'),
    'config.model 以前只用来判 apiKey —— 换模型后无从确认答案是谁写的'
  );
  // 值断言而不是「有这个属性」：写成 :context-window="0" 也算有，传的却是常量
  // 0 —— 水位永远算不出来，整环不显示，而属性存在这条守卫照样绿（变异 5 实测）。
  assert.ok(
    /:context-window="[^"]*host\.config\.contextWindow[^"]*"/.test(panelSrc),
    'contextWindow 必须从 host.config 传下去，不能传常量 0（那会让水位永远不显示）'
  );
  // T-153：水位从会话下拉搬到了输入区的圆环，usage 必须跟着一起搬 ——
  // 只传 contextWindow 不传 usage，contextPercent 恒为 null，环永远不出现，
  // 而上面那条守卫照样绿。
  assert.ok(
    /:usage="host\.usage"/.test(panelSrc),
    'usage 必须传到圆环上 —— 少了它水位永远算不出来，环等于不存在'
  );
  // T-222：水位的分子是实测 contextTokens，不是计费 usage —— 组件内部
  // percent 只认 contextTokens；这条守卫钉住宿主侧的供数，防退回旧分子。
  assert.ok(
    /:context-tokens="host\.contextTokens"/.test(panelSrc),
    '实测上下文占用必须传到圆环上（T-222），少了它水位环拿不到分子'
  );
  assert.ok(
    ringSrc.includes('props.contextTokens'),
    '环的水位分子必须是 contextTokens —— 退回 usage.input 就是 T-222 的旧病复发'
  );
  assert.ok(listSrc.includes('data-test="model-name"'), '模型名要有渲染点');
  assert.ok(
    ringSrc.includes('data-test="context-meter"'),
    '水位要有渲染点 —— T-153 起它在输入区的圆环上，不在会话下拉里了'
  );
  // 水位判定必须在纯模块里：.vue 里的分支一条都测不到
  assert.ok(
    ringSrc.includes("from '@/agent/usage'"),
    '水位/时刻/缩写的判定要来自 @/agent/usage（那里有单测），不能留在组件里'
  );
});

test('T-155：下拉 a11y —— aria 上真实按钮、面板有角色、键盘导航在组件内单点实现', () => {
  // agentFile 是文件后段 describe 内的局部帮手，这里够不到——自建同款
  const agentFile = (n) => read(`src/components/newtab/workflow/agent/${n}`);
  const dd = stripComments(agentFile('AgentDropdown.vue'));

  // aria-expanded / aria-haspopup 经 scoped slot 交给消费方绑到 trigger 的
  // 真实按钮上 —— 挂在包装 div 上读屏软件不认
  assert.ok(
    dd.includes("'aria-expanded'"),
    'trigger aria 里要有 aria-expanded'
  );
  assert.ok(dd.includes("'aria-haspopup'"), 'menu 形态要有 aria-haspopup');
  assert.ok(
    dd.includes(':aria="triggerAria"'),
    'trigger slot 必须把 aria 作为 scoped prop 交给消费方（消费侧写法才是 #trigger）'
  );
  // 键盘导航（DOM 焦点、首末回绕）与收起行为。
  // Home/End 是 moves 映射的无引号键，断言按「键名+冒号」查。
  for (const key of ['ArrowDown', 'ArrowUp', 'Escape', 'Tab']) {
    assert.ok(dd.includes(`'${key}'`), `键盘导航缺 ${key}`);
  }
  for (const key of ['Home:', 'End:']) {
    assert.ok(dd.includes(key), `键盘导航缺 ${key}`);
  }
  assert.ok(
    dd.includes('focusTrigger()'),
    'Esc / 条目点击收起后焦点要送回 trigger（APG：菜单关闭焦点回触发器）'
  );

  // 消费方把 scoped aria 绑到自己的 trigger 按钮上
  for (const f of [
    'AgentPanel.vue',
    'AgentModelPicker.vue',
    'AgentTabPicker.vue',
  ]) {
    const src = agentFile(f);
    assert.ok(
      /#trigger="\{ aria \}"/.test(src),
      `${f} 的 trigger 必须接 scoped aria（T-155）`
    );
    assert.ok(
      /v-bind="aria"/.test(src),
      `${f} 必须把 aria 绑到 trigger 按钮上`
    );
  }

  // 圆环的 trigger 是它内部自己的按钮 —— aria 经 triggerAria prop 透传
  const ring = agentFile('AgentContextRing.vue');
  assert.ok(
    ring.includes('triggerAria') && ring.includes('v-bind="triggerAria"'),
    '圆环必须把 triggerAria 透传给内部按钮（trigger 不在面板模板里）'
  );

  // 纯列表型下拉的条目要 menuitem；会话列表 view 模式是整块历史视图，不挂
  assert.ok(
    agentFile('AgentTabList.vue').includes('role="menuitem"'),
    '标签页条目要 role="menuitem"'
  );
  assert.ok(
    agentFile('AgentModelPicker.vue').includes('role="menuitem"'),
    '模型条目要 role="menuitem"'
  );
  assert.ok(
    /mode === 'popover' \? 'menuitem' : undefined/.test(
      agentFile('AgentSessionList.vue')
    ),
    '会话条目的 menuitem 只在 popover 模式挂（view 模式不是菜单）'
  );
});

test('T-153：圆环 tooltip 复用既有文案键，不留孤儿键', () => {
  const ringSrc = read(
    'src/components/newtab/workflow/agent/AgentContextRing.vue'
  );

  // 水位搬走后，会话下拉不再引用这三个键。若圆环不接手，它们就成了 locale 里
  // 没人用的孤儿键（T-109 踩过：键还在、全仓零引用，check:i18n 查不出来）。
  for (const key of ['contextShort', 'contextHint', 'usage']) {
    assert.ok(
      ringSrc.includes(`workflow.agent.${key}`),
      `圆环要接手 workflow.agent.${key} —— 水位已从会话下拉搬走，没人引用它就成了孤儿键`
    );
  }

  // 估算说明必须仍在：分母是用户填的建议值，不写明等于假装百分比是准的
  // （contextHint 自带这句，这里钉的是「圆环用的是 contextHint 而不是自己拼」）
  assert.ok(
    ringSrc.includes('contextHint'),
    'tooltip 必须走 contextHint（里面写明是估算），不能自己拼一句没说明的百分比'
  );
});

test('T-164/T-214：解除动作只剩「点已固定徽标」一条路，且只在固定态出现', () => {
  // X 挂在 agent-dropdown 的 trigger slot 里，而 slot 在渲染桩里根本不渲染
  // （utils/sfc-render.mjs 的 GLOBAL_STUBS），所以这一条只能靠源码守卫 ——
  // 与同文件其它静态守卫同一档，不是偷懒。
  const picker = read(
    'src/components/newtab/workflow/agent/AgentTabPicker.vue'
  );
  const panel = read('src/components/newtab/workflow/agent/AgentPanel.vue');

  // T-214：独立的 unpin button 删除（与"徽标不可点"是三个同形状信号打架的
  // 根因），解除动作内联进固定态徽标。showUnpin / 独立按钮不许再回来。
  assert.doesNotMatch(
    picker,
    /showUnpin/,
    'showUnpin 已随 T-214 删除 —— 解除动作内联进「已固定 ✕」徽标，别再引回来'
  );

  // 徽标是三兄弟分支：v-if="stale"（红）→ v-else-if="pinned"（可点解除）
  // → v-else（跟随）。v-else-if="pinned" 天然排除失效态 —— 失效态该做的是
  // 重选，不是解除。
  assert.match(picker, /v-if="stale"/, '失效态徽标分支（红底只显示）不见了');
  assert.match(
    picker,
    /v-else-if="pinned"[\s\S]{0,400}?data-test="unpin-target"/,
    '「已固定 ✕」徽标必须是 button（内含 unpin-target）—— 解除动作只有这一条路'
  );
  assert.match(
    picker,
    /v-else[\s\S]{0,200}?pickTab\.followBadge/,
    '自动态要有「跟随」灰描边徽标（新键 followBadge）'
  );
  assert.match(
    picker,
    /@click\.stop/,
    '点解除必须 stopPropagation —— dropdown 靠父 div 的 @click 开合，不拦会顺手把列表也打开'
  );
  assert.match(
    panel,
    /@unpin="host\.unpinTab\(\)"/,
    '面板要把解除事件接到 host.unpinTab'
  );

  // 文案键：拼错会静默回退成键名，check:i18n 查不出来
  for (const lang of ['zh', 'en']) {
    const { agent } = JSON.parse(
      read(`src/locales/${lang}/newtab.json`)
    ).workflow;

    assert.equal(
      typeof agent.pickTab.unpin,
      'string',
      `${lang} 缺 workflow.agent.pickTab.unpin`
    );
    assert.equal(
      typeof agent.pickTab.followBadge,
      'string',
      `${lang} 缺 workflow.agent.pickTab.followBadge`
    );
    assert.equal(
      typeof agent.pickTab.unpinToast,
      'string',
      `${lang} 缺 workflow.agent.pickTab.unpinToast`
    );
    assert.equal(
      typeof agent.pickTab.tabsLabel,
      'string',
      `${lang} 缺 workflow.agent.pickTab.tabsLabel`
    );
    assert.equal(
      typeof agent.pickTab.reselect,
      'undefined',
      `${lang} 还留着 workflow.agent.pickTab.reselect —— 「重新选择」已随 T-214 删除`
    );
  }

  // T-214 §7：解除后要有一句「已回到自动跟随」的确认（chip 从实底退成轻底，
  // 一句话防误触后不知所措）
  const host = read('src/composable/agentHost.js');
  assert.match(
    host,
    /pickTab\.unpinToast/,
    '解除固定后要 toast「已回到自动跟随」—— 设计稿 §7 拍板项'
  );
});

test('T-177：换目标页只剩一个入口（composer 顶部的 chip），@ 整套不许回来', () => {
  const src = stripComments(
    read('src/components/newtab/workflow/agent/AgentPanel.vue')
  );

  // ① 换页入口有且仅有一处：composer 卡片里的 agent-tab-picker。
  //    @ 菜单（含底行那个 @ 按钮）做的是同一件事 —— 自带第二份列表、
  //    而「当前是哪一页」只有 chip 显示得出来。两处入口 = 半个界面在说谎。
  assert.equal(
    (src.match(/<agent-tab-picker/g) || []).length,
    1,
    '换页入口只能有一处 —— 两下并列的入口配两套列表，就是冗余'
  );

  for (const dead of [
    'atMenuOpen',
    'at-menu',
    'at-trigger',
    'parseAtDraft',
    'stripAtToken',
    'startAtMenu',
    'pickAtTab',
    '@/agent/at',
  ]) {
    assert.equal(
      src.includes(dead),
      false,
      `@ 换页那套（${dead}）已随 T-177 删除：换页只留 chip 下拉，别再引回来`
    );
  }

  // ② / 菜单的接线不受影响 —— 剥 @ 时别把它一起带走
  assert.match(src, /v-if="slashMenuOpen"/, '/ 模板菜单应当保留');
  assert.match(
    src,
    /pickCommand\(matchedCommands\.value\[highlightIndex\.value\]\)/,
    '/ 菜单选中要接上'
  );

  // ③ 输入法：组合期间的按键不是最终文本，中文输入法下 / 还在候选状态就判定会闪
  assert.match(
    src,
    /e\.isComposing/,
    '键盘路由必须先看 isComposing —— 中文输入法下菜单会闪一下再消失'
  );

  // ④ 文案键：attach 是底行那个 @ 按钮的 title，按钮没了它也不该留
  for (const lang of ['zh', 'en']) {
    const { agent } = JSON.parse(
      read(`src/locales/${lang}/newtab.json`)
    ).workflow;

    assert.equal(
      typeof agent.pickTab.attach,
      'undefined',
      `${lang} 还留着 workflow.agent.pickTab.attach —— 它的按钮已经删了`
    );
  }
});

test('T-209：模板里不许有孤立的 `>` / `<` 文本节点（会渲染成可见的乱码字符）', () => {
  // 症状：composer 卡片上沿浮着一个孤零零的「<」字符。成因是模板里多打了一个
  // `>` —— 它落在「已经闭合的标签」之后，被 Vue 当成**文本节点**渲染出来，
  // 不是标签、不报错、lint 也不拦（prettier 只把它当普通文本缩进）。
  //
  // 判定：某一行只含 `>`，且上一非空行本身已经以 `>` 结尾（说明上一个标签
  // 已经闭合）—— 那这一行的 `>` 就是多余的文本节点。合法的多行标签是
  // `<div\n  class="...">`，其 `>` 行前面是属性行，不以 `>` 结尾，不会被误判。
  const stray = [];
  for (const f of readdirSync(
    join(ROOT, 'src/components/newtab/workflow/agent')
  )) {
    if (!f.endsWith('.vue')) continue;
    const lines = stripComments(
      read(`src/components/newtab/workflow/agent/${f}`)
    ).split('\n');
    let prev = '';
    lines.forEach((line, i) => {
      if (/^\s*[<>]\s*$/.test(line) && />\s*$/.test(prev)) {
        stray.push(`${f}:${i + 1}`);
      }
      if (/\S/.test(line)) prev = line;
    });
  }

  assert.deepEqual(
    stray,
    [],
    '模板里出现孤立的 `>`/`<` 文本节点会渲染成可见乱码字符：' + stray.join('、')
  );
});

test('T-169：宽窄形态由宿主声明（host.layout），不许用视口断点判', () => {
  const panel = stripComments(
    read('src/components/newtab/workflow/agent/AgentPanel.vue')
  );
  const host = stripComments(read('src/composable/agentHost.js'));

  // ① 开关读的是 host.layout —— 不是 window.innerWidth / matchMedia / 断点
  assert.match(
    panel,
    /props\.host\.layout === 'wide'/,
    '形态必须由 host.layout 判定（宿主声明的事实），不是组件自己量宽度'
  );
  assert.doesNotMatch(
    panel,
    /innerWidth|matchMedia|ResizeObserver/,
    '面板不许自己量视口/容器宽度 —— 量出来的是窗口，而形态取决于宿主'
  );
  assert.doesNotMatch(
    panel,
    /(?:^|[\s"'])(?:sm|md|lg|xl|2xl):/,
    '不许用 Tailwind 响应式断点判形态：侧栏能拖宽（下限 360、只能拖宽），独立助手页的窗口也能拖窄 —— 断点会在拖宽的侧栏上错误地长出左栏'
  );

  // ② 两个分支各自的挂载点都在
  assert.match(
    panel,
    /v-if="wide"/,
    '左栏必须挂在 v-if="wide" 上（窄宿主 320px 里切 240px 给列表，对话区只剩 80px）'
  );
  assert.match(panel, /data-test="session-side"/, '左栏要有 data-test');
  // 2026-10-10：窄宿主的历史视图（session-chip 开关 + 整页列表）已撤——
  // 标题下拉就是唯一会话入口，不许再长出第二张脸。
  assert.doesNotMatch(
    panel,
    /data-test="session-chip"|data-test="open-all-sessions"/,
    '历史入口图标与「查看全部历史会话」已随历史视图一起撤掉，别加回来'
  );

  // ③ 左栏里挂的得是历史列表本身（渲染桩是通用桩，认不出组件名，只能守源码）
  const sideAt = panel.indexOf('data-test="session-side"');
  assert.ok(sideAt > 0, '没找到左栏，守卫本身失效');
  const rightAt = panel.indexOf('class="flex min-h-0 min-w-0 flex-1 flex-col"');
  assert.ok(rightAt > sideAt, '没找到右栏起点，守卫本身失效');
  assert.match(
    panel.slice(sideAt, rightAt),
    /<agent-session-list/,
    '左栏里必须挂 agent-session-list（只留一个空壳标题等于没做）'
  );

  // ④ 宽宿主的正文区永远是对话：composer 不隐藏，且不再有视图切换机制。
  // 2026-10-10：view / inHistory 整套撤掉（历史视图与标题下拉重复）。
  assert.doesNotMatch(
    panel,
    /\binHistory\b|view\.value\s*=\s*'history'|view = ref\('chat'\)/,
    '视图切换机制已撤：正文区恒为对话，会话浏览全走标题下拉 / 宽宿主左栏'
  );
  assert.doesNotMatch(
    panel,
    /v-if="!wide"/,
    '不该再有「只在窄宿主渲染」的会话入口 —— chip 已撤，两形态共用同一 header'
  );

  // ⑤ host 侧：宿主没声明时按 narrow 兜底
  assert.match(
    host,
    /layout: deps\.layout === 'wide' \? 'wide' : 'narrow'/,
    'layout 必须由宿主声明，缺省按 narrow（更保守：不占常驻横向空间）'
  );

  // ⑥ 两个宿主都要显式声明，且不许靠缺省
  assert.match(
    stripComments(read('src/newtab/pages/Agent.vue')),
    /layout: 'wide'/,
    "独立助手页必须显式声明 layout: 'wide'"
  );
  assert.match(
    stripComments(read('src/newtab/pages/workflows/[id].vue')),
    /layout: 'narrow'/,
    "编辑器侧栏必须显式声明 layout: 'narrow'"
  );
});

test('T-163：新增的五个文案键要在两个 locale 里都有人引用', () => {
  // 键名打错时 vue-i18n 会**静默回退成键名**（界面上显示一串
  // `workflow.agent.xxx`），既不会报错也不会被 check:i18n 拦下 ——
  // 所以「键存在」和「有人引用」这两件事都要钉住。
  const ringSrc = read(
    'src/components/newtab/workflow/agent/AgentContextRing.vue'
  );
  const panelSrc = read('src/components/newtab/workflow/agent/AgentPanel.vue');

  const owners = {
    // T-163：整句搬去点开的明细，行内只留两个字的短词 ——
    // 14 个字的整句会把底行挤换行（实测元信息行 24px → 46px）。
    contextCritical: panelSrc,
    contextCriticalShort: ringSrc,
    contextNewNote: panelSrc, // 展开面板里「新建会话」的副注
    inputHint: panelSrc, // 元信息行右侧
    interjectHint: panelSrc, // 忙碌态改说插话
  };

  for (const lang of ['zh', 'en']) {
    const { agent } = JSON.parse(
      read(`src/locales/${lang}/newtab.json`)
    ).workflow;

    for (const [key, src] of Object.entries(owners)) {
      assert.ok(typeof agent[key] === 'string', `${lang} 缺 ${key}`);
      assert.ok(
        src.includes(`workflow.agent.${key}`),
        `${key} 在 ${lang} 里存在却没人引用 —— 会变成孤儿键（T-109 踩过）`
      );
    }

    // 插话按钮已合并进同一个按钮位（插话改由 Enter），interject 键随按钮一起
    // 删掉了。留着键 = 孤儿，改回引用 = 界面上显示键名，两头都不许。
    assert.equal(
      agent.interject,
      undefined,
      `${lang} 的 interject 键应随插话按钮一起删除（插话语义现在由 ` +
        'interjectHint 承担），留着就是没人用的孤儿键'
    );
  }

  for (const src of [ringSrc, panelSrc]) {
    assert.equal(
      /workflow\.agent\.interject['"`]/.test(src),
      false,
      'interject 键已删除，引用它只会显示键名本身'
    );
  }
});

test('T-09：水位的 tooltip 必须写明是估算（分母是用户填的建议值）', () => {
  for (const lang of ['zh', 'en']) {
    const locale = JSON.parse(read(`src/locales/${lang}/newtab.json`));
    assert.ok(
      typeof locale.workflow.agent.contextHint === 'string',
      `${lang} 缺 contextHint`
    );
    assert.ok(
      /\{pct\}/.test(locale.workflow.agent.contextHint),
      `${lang} 的 contextHint 少了 {pct}`
    );
    assert.ok(
      /估算|estimate/i.test(locale.workflow.agent.contextHint),
      `${lang} 的 contextHint 没写明「估算」—— contextWindow 是用户填的建议值，` +
        '不写明就等于假装这个百分比是准的'
    );
  }
});

test('T-53：折叠逻辑只能住在 fold.js 里，组件只准留薄封装', () => {
  const transcriptSrc = read(
    'src/components/newtab/workflow/agent/AgentTranscript.vue'
  );

  assert.ok(
    transcriptSrc.includes("from '@/agent/fold'"),
    'AgentTranscript 要用 fold.js —— 不接的话折叠层等于搬走了却没人用'
  );
  assert.ok(
    /const folder = createFolder\(\{ items, t \}\)/.test(transcriptSrc),
    'folder 必须接组件自己的 reactive items（普通数组的改动 Vue 追踪不到）'
  );
  // 这条是变异测试逼出来的：把 reactive 换成普通数组，createFolder 那条照样
  // 通过（形状没变），丢响应式却没有任何断言拦得住。SSR 单次渲染也照样通过 ——
  // 只有真浏览器里新槽位不刷新才看得出来，而静态守卫必须能拦。
  assert.match(
    transcriptSrc,
    /const items = reactive\(\[\]\)/,
    '喂给 folder 的数组必须是 reactive([]) —— 普通数组的 push 与就地并槽 Vue 追踪不到，' +
      '表现是「模型在说话但面板不更新」'
  );
  // 组件里不该再出现折叠规则本体。这几条断言的形态是「**不在**」—— 所以逐条
  // 盯着具体形状，别写成一个宽泛的 includes 反面。
  const forbidden = [
    ["appendDelta('text'", 'delta 并槽逻辑回到了组件里'],
    ["push({ type: 'turn'", 'START 的 turn 分支回到了组件里'],
    ["push({ type: 'user'", '用户消息分支回到了组件里'],
    ['it.step.toolCallId ===', '工具卡按 toolCallId 配对的逻辑回到了组件里'],
    ['previousSource', '换会话重放的状态又写回组件里了'],
    ['let cursor = 0', '游标状态又写回组件里了'],
  ];
  for (const [needle, why] of forbidden) {
    assert.ok(
      !transcriptSrc.includes(needle),
      why + '（这些规则由 fold.test.js 钉住，留在 .vue 里等于两处各说各话）'
    );
  }
});

test('T-53：fold.js 不许碰 Vue 与浏览器全局（它得能在 node 里单测）', () => {
  // 剥掉注释再断言：fold.js 的头注里就写着「组件传 reactive([])」——
  // 不剥的话这条守卫会把说明文字当成代码（本条第一次跑就是这么红的）。
  const foldSrc = stripComments(read('src/agent/fold.js'));
  for (const needle of [
    "from 'vue'",
    'reactive(',
    'navigator',
    'document',
    'window.',
    "from 'vue-i18n'",
  ]) {
    assert.ok(
      !foldSrc.includes(needle),
      'fold.js 里出现了 ' +
        needle +
        ' —— 折叠层要能在 node 里跑，这些依赖会挡住单测'
    );
  }
  assert.ok(
    foldSrc.includes("from './events'"),
    '事件种类与工具状态要从 events.js 引，别复制一份常量（复制就会各说各话）'
  );
});

// —— T-171：Tailwind 静默覆盖 ——
//
// 现象：AgentPanel 给 <ui-textarea> 写了 px-1 py-1 bg-transparent 想把输入框
// 「贴到卡片边上、底色与卡片一致」，但这三项全部无效 —— UiTextarea 根节点自带
// px-4 py-2 bg-input，而 Tailwind 产出的 CSS 里：
//   .bg-transparent(96687) < .bg-input(110753)
//   .px-1(98187) < .px-4(98408)
//   .py-1(98577) < .py-2(98802)
// 同优先级（同为单类选择器）下后出现者赢，于是调用方的值被组件自身的值吃掉。
//
// 为什么值得单独立一条守卫：这类失效**没有任何运行时信号** —— 不报错、控制台干净、
// 单测全绿，只有量像素或者盯 CSS 字节偏移才发现。而且它会骗过设计评审：
// 读代码时 `px-1` 就在那里，看上去是生效的。
//
// 判据不写死偏移量，而是现读构建 CSS，谁排在后面谁赢；构造出来的偏移量若与真实
// CSS 矛盾（比如有人手工调整了 tailwind 输出顺序），本守卫会先红给你看。
const cssPath = join(ROOT, 'build/newtab.css');
const cssExists = existsSync(cssPath);
const cssText = cssExists ? readFileSync(cssPath, 'utf8') : '';

test('T-171：覆盖 UiTextarea 的工具类必须加 !，否则被组件自身的类静默吃掉', (t) => {
  if (!cssExists) {
    // 没构建过就没有字节偏移可读，跳过而不是假绿 —— 假绿比红更坏。
    t.skip('build/newtab.css 不存在，先跑一次 npm run build');
    return;
  }

  const panelSrc = read('src/components/newtab/workflow/agent/AgentPanel.vue');
  const taBlock = panelSrc.match(/<ui-textarea[\s\S]*?\/>/);
  assert.ok(
    taBlock,
    '面板里应该还有 <ui-textarea>，找不到说明结构变了，本守卫要重写'
  );
  const taClass = taBlock[0].match(/class="([^"]*)"/);
  assert.ok(taClass, '<ui-textarea> 上得有 class，工具类覆盖都写在这里');
  const cls = taClass[1].split(/\s+/).filter(Boolean);

  // 「组件根节点自带、面板必须显式盖掉」的清单。写成
  // [被盖掉的属性, 面板想给自己的值] —— 关键不是值，是面板那一侧必须带 !。
  // ui-textarea / ui-input 在整份 CSS 里没有任何规则（死类），不在清单里。
  //
  // base 那一项不是只用来拼错误消息的：下面会拿它去核对 UiTextarea 的**源码**。
  // 这个核对是必要的 —— 守卫读的是上一次构建的 CSS 快照，而源码改了没重新构建时，
  // 快照与源码会脱节；没有这道核对，一次「把 px-4 改成 px-3」的重构能悄悄
  // 让 MUST_OVERRIDE 变成一张过期的清单，从此再没人发现覆盖失效。
  //
  // T-209 有意迁移：面板给的值从 `!px-1 !py-1 !bg-transparent !rounded-none`
  // 改成 `!px-2 !py-1.5 !bg-field !rounded-control` —— 输入区从「透出卡片白」
  // 变成「凹陷的 field 面」。**被盖掉的 base（组件自带的那一侧）一个没变**，
  // 变的是面板想给自己的值。所以这里只更新 want 列，断言逻辑原样不动：
  // 它钉的是「必须带 ! 才能盖掉组件自身」这条不变量，不是某个具体的值。
  //
  // T-213 又迁移了一次，方向相反：凹陷感从**输入框自身**上移到了**卡片**上。
  // T-209 是 textarea 自己 `!bg-field`（输入框是凹的、卡片是白的）；
  // T-213 把 composer 整张卡改成 `bg-field` + `border-line`，于是 textarea
  // 必须重新变透明（`!bg-transparent`）才能把卡片的 field 面透出来 ——
  // 否则会在卡片里再叠一层同色底，看着像输入框没对齐。base 侧（bg-input）
  // 依然没变，所以仍然只动 want 列。
  const MUST_OVERRIDE = [
    ['px-4', '!px-2'],
    ['py-2', '!py-1.5'],
    ['bg-input', '!bg-transparent'],
  ];

  const offset = (name) => {
    // Tailwind 里 `.px-1\.5` 这种带点的类名要转义后再找；找不到返回 -1。
    const esc = name.replace(/[.[\]()%#]/g, (ch) => '\\' + ch);
    return cssText.indexOf('.' + esc + ' {');
  };

  // 清单 ↔ 源码 双向核对（只看根元素的 class，不看注释里提到的字面量）。
  const taRoot = stripComments(read('src/components/ui/UiTextarea.vue')).match(
    /<textarea[\s\S]*?class="([^"]*)"/
  );
  assert.ok(taRoot, 'UiTextarea 的根元素上得有 class');
  const baseCls = taRoot[1].split(/\s+/).filter(Boolean);
  for (const [base] of MUST_OVERRIDE) {
    assert.ok(
      baseCls.includes(base),
      `MUST_OVERRIDE 里写着 UiTextarea 自带 ${base}，但它的根 class ` +
        `[${baseCls.join(' ')}] 里没有这个类。要么组件改了（把清单里这一项` +
        '连同面板上对应的 ' +
        '! 前缀一起调整），要么清单已过期'
    );
  }

  for (const [base, want] of MUST_OVERRIDE) {
    assert.ok(
      cls.includes(want),
      `面板的 <ui-textarea> 上必须写 ${want} 来盖掉 UiTextarea 自带的 ${base}。` +
        `（CSS 里 .${base} 在偏移 ${offset(
          base
        )}，排在同名「想盖掉它」的那一类之后，` +
        '同优先级下后来者赢 —— 不加 ! 的话面板这条形同没写。' +
        '如果确实不再需要覆盖，请把本行从 MUST_OVERRIDE 里删掉，别留着假装覆盖了）'
    );
    assert.ok(
      !cls.includes(base),
      `面板的 <ui-textarea> 上出现了不带 ! 的 ${base}，它赢不了组件自身的同名类` +
        `（偏移 ${offset(base)}），是一条哑类 —— 删掉它，或改成 !${base}`
    );
  }

  // 通则：面板在这张 textarea 上的 padding / background 覆盖必须全部带 !。
  // 以后有人再加一条 `px-0` 想微调，这条会立刻拦住（它和 !px-1 一样是被吃的命）。
  const risky = cls.filter(
    (c) =>
      !c.startsWith('!') &&
      /^(px|py|p|pl|pr|pt|pb|bg)-/.test(c) &&
      // 这些属性 UiTextarea 根节点没带，同名不构成竞争，不该被这条误伤。
      !['p-0'].includes(c)
  );
  assert.deepEqual(
    risky,
    [],
    '这些 padding/bg 类不带 !，在 UiTextarea 上随时会被组件自身的同名类吃掉：' +
      risky.join(' ')
  );

  // 输入框的圆角必须由面板显式接管：UiTextarea 根节点自带 rounded-lg，
  // 不中和掉就会在 composer 卡片里套出第二层圆角框。
  // T-209 有意迁移：输入区从「透出卡片白、无自己的圆角」改成「凹陷的 field 面」，
  // 于是它现在**自己也该有**圆角 —— 从 `!rounded-none` 改成 `!rounded-control`。
  // 断言随之从「必须是 none」改成「必须是带 ! 的圆角类」：钉的仍是
  // 「圆角由面板一侧 `!` 接管」这条不变量，而不是某个具体档位。
  assert.ok(
    cls.some((c) => /^!rounded-/.test(c)),
    '输入框的圆角必须由面板一侧带 ! 接管（如 !rounded-control）—— ' +
      'UiTextarea 自带的 rounded-lg 不受控时会在 composer 卡片里裹出第二层圆角框'
  );
  assert.ok(
    !cls.includes('rounded-lg'),
    '面板的 <ui-textarea> 上出现了不带 ! 的 rounded-lg —— 它赢不了组件自身的同名类，是哑类'
  );
});

test('T-171b：面板高度必须被约束在侧栏内，否则窄宿主逼出整页滚动条', () => {
  // 窄宿主（编辑器 320px 侧栏）根容器是固定高度（calc(100vh-40px)），侧栏 stretch
  // 到这个高度。面板要老老实实待在里面、只有中部的 transcript 滚动，靠的是：
  //   ① 右栏（对话主体）min-h-0 —— flex 列里子项默认 min-height:auto，不带它，
  //      transcript 永远拿不到固定高度，整张面板随内容长高、溢出固定高度的侧栏；
  //   ② composer 表单 shrink-0 —— 面板矮时压缩的是 transcript，输入框顶在底部
  //      永远点得到，而不是被一起挤没。
  // 两条丢了任意一条，表现都是「输入框乱跑 / 整页滚动」，而这两种毛病都在真浏览器
  // 才看得出来，单测与 lint 完全无感 —— 所以钉在源码上。
  const src = stripComments(
    read('src/components/newtab/workflow/agent/AgentPanel.vue')
  );

  assert.match(
    src,
    /class="flex min-h-0 min-w-0 flex-1 flex-col"/,
    '右栏必须 min-h-0：否则中部展示区无法被高度约束，面板溢出侧栏、整页出现滚动条'
  );
  // T-204 给 form 加了 relative（渐隐层要以它为定位基准），钉的是
  // shrink-0 + 16px 横向起线这两件事，class 串里多一个 relative 不影响判据。
  assert.match(
    src,
    /<form class="[^"]*\bshrink-0\b[^"]*\bpx-4\b[^"]*\bpb-2\.5\b[^"]*\bpt-0\b/,
    'composer 表单必须 shrink-0 —— 窄宿主下输入框要常驻底部、不能被压没' +
      '（T-187 把 p-2 换成 px-4 pb-2.5 pt-0，钉的是 shrink-0 + 16px 横向起线）'
  );

  // T-204：渐隐层必须挂在 composer 上方且不吃鼠标事件
  const fadeAt = src.indexOf('data-test="composer-fade"');
  assert.ok(fadeAt > 0, 'composer 上方的渐隐层不见了（T-204）');
  const fade = src.slice(Math.max(0, fadeAt - 300), fadeAt + 120);
  assert.match(fade, /-top-5/, '渐隐层要悬在 composer 边界上方（负偏移）');
  assert.match(
    fade,
    /pointer-events-none/,
    '渐隐层必须 pointer-events-none —— 它盖在消息上，吃鼠标事件会挡滚动与文本选择'
  );
});

test('T-171：这个「后来者赢」的规律本身没变（守卫的前提不能悄悄失效）', (t) => {
  if (!cssExists) {
    t.skip('build/newtab.css 不存在，先跑一次 npm run build');
    return;
  }
  const at = (name) => {
    const esc = name.replace(/[.[\]()%#]/g, (ch) => '\\' + ch);
    return cssText.indexOf('.' + esc + ' {');
  };
  // 断言的是 tailwind 的排序规律本身：数值越大 = 刻度越大 = 排得越靠后。
  // 哪天升级 tailwind 改了排序（例如改成按使用顺序输出），本条会红，
  // 提醒重新审视每一个覆盖处到底还成不成立。
  assert.ok(
    at('px-4') > at('px-1') &&
      at('py-2') > at('py-1') &&
      at('bg-input') > at('bg-transparent'),
    'CSS 里这些类的先后顺序变了（「后来者赢」的推论要重新验证）：px-4=' +
      at('px-4') +
      ' px-1=' +
      at('px-1') +
      ' py-2=' +
      at('py-2') +
      ' py-1=' +
      at('py-1') +
      ' bg-input=' +
      at('bg-input') +
      ' bg-transparent=' +
      at('bg-transparent')
  );
});

// —— T-180 / T-181 / T-182 / T-183：工作流编辑器侧栏的入口与面板 ——
const editorPage = 'src/newtab/pages/workflows/[id].vue';

/**
 * 这里的守卫要比上面那些多剥一层：`//` 行注释。
 *
 * 本文件第一版守卫就被注释骗过 —— stripComments 只剥 HTML 注释与块注释，
 * 于是「在解释性注释里留一句 `toggleAgentPanel`」就能把「这个函数不许回来」的红灯糊弄过去。
 * T-180 那批守卫大多是「某样东西不许存在」，最怕的就是这个，所以单独剥干净。
 *
 * 顺带一个踩坑：写这段说明时别把块注释的结束符 `*` 加斜杠原样写进注释里，
 * 它会把注释提前闭合，后面半句就成了裸代码 —— 报出来的是
 * "Unexpected identifier"，跟真正出问题的那行八竿子打不着。
 */
const stripAll = (src) => stripComments(src).replace(/^\s*\/\/.*$/gm, '');

test('T-180：切面板的入口归侧栏所有，顶栏不许再有助手按钮', () => {
  const src = stripAll(read(editorPage));

  // ① 顶栏（ui-tabs 内）不再有助手入口。那个按钮做的是「换侧栏内容」，
  //    却坐在管「画布区域看什么」的 tab 组里，还自带一套不相干的选中态（药丸 vs 下边框）。
  const tabbar = src.slice(src.indexOf('<ui-tabs'), src.indexOf('</ui-tabs>'));

  // 自检：切片必须真的有内容。哪天 <ui-tabs> 改了写法，slice 会退化成空串，
  // 下面两条 `!includes` 就变成永真 —— 守卫看着绿，其实什么都没断言。
  assert.ok(
    tabbar.length > 200 && tabbar.includes('value="editor"'),
    '顶栏 tab 组的切法变了（<ui-tabs> 没找到或结构改了）—— 先更新本守卫再改模板'
  );

  assert.ok(
    !tabbar.includes('workflow.agent.tab'),
    '顶栏 tab 组里不许再出现助手入口 —— 切侧栏内容的控件归侧栏自己（见侧栏顶部那行 tab）'
  );
  assert.ok(
    !tabbar.includes('riMagicLine'),
    '顶栏不许再用魔法棒：同一个图标画布上的自动布局按钮也在用（T-182）'
  );

  // ② 侧栏里有且仅有一处切面板的控件
  assert.equal(
    (src.match(/setSidebarPanel\(/g) || []).length,
    2,
    '切面板只走 setSidebarPanel（定义 + 那行 tab 的调用）—— 两处入口就是 T-177 刚拆掉的那个坑'
  );
  assert.match(src, /const SIDEBAR_TABS = \[/, '侧栏那行 tab 的定义不许消失');
  for (const id of ['blocks', 'agent']) {
    assert.ok(
      src.includes(`id: '${id}'`),
      `侧栏 tab 少了 ${id} —— 缺 blocks 则块库进不来，缺 agent 则助手没了入口`
    );
  }

  // ③ tab 要是 tab：得有选中态语义，不能只有底色（对比 T-180 记录的旧按钮缺 aria）
  assert.match(src, /:aria-pressed="state\.sidebarPanel === tab\.id"/);

  // ④ 编辑卡期间整行 tab 不渲染 —— 这正是 T-179 自动消解的原因：
  //    入口点不到，正在编辑的块就不可能被静默丢弃
  assert.match(
    src,
    /<template v-if="!editState\.editing">/,
    '切面板那行必须挂在非编辑态上 —— 编辑中它连渲染都不渲染，才谈得上「点不到」'
  );
});

test('T-179 回归守卫：入口搬走后，「点助手顺手关掉正在编辑的块」这个动作不存在了', () => {
  const src = stripAll(read(editorPage));

  assert.equal(
    src.includes('toggleAgentPanel'),
    false,
    '旧入口 toggleAgentPanel 已随 T-180 删除。它内部无条件 `editState.editing = false`，' +
      '正是「点助手会静默丢弃正在编辑的块」的来源 —— 别把它连同副作用一起搬回来'
  );

  // setSidebarPanel 里也不许偷偷关编辑卡：那一行 tab 在编辑态压根不渲染，
  // 走到 setSidebarPanel 时按定义就不在编辑中。
  const fn = src.slice(
    src.indexOf('function setSidebarPanel'),
    src.indexOf('function initEditBlock')
  );
  assert.equal(
    fn.includes('editState.editing = false'),
    false,
    'setSidebarPanel 不许改 editState —— 它是切面板，不是关别人的编辑卡'
  );
});

test('T-181：侧栏面板不再持久化', () => {
  const src = stripAll(read(editorPage));

  assert.equal(
    src.includes('workflow:sidebarPanel'),
    false,
    'workflow:sidebarPanel 已删除：它是全局一个键，而会话按 workflowId 过滤 —— ' +
      '在 A 工作流用过助手，打开 B 工作流会直接撞上 B 的会话列表（T-181）'
  );
  assert.equal(
    src.includes("localStorage.setItem('workflow:sidebarPanel'"),
    false,
    '别只删读、留着写'
  );
});

test('T-187：侧栏外壳零内缩 —— 各面板自带 padding，且统一 16px', () => {
  // T-183 当初是反的：它让**外壳** padding 随面板切换（助手 0 / 块库 20），
  // 换来 40px 宽度，代价是切面板时整列内容左右各跳 20px、上下各跳 20px，
  // 并且造出两套内缩（块库 20+16=36，助手 8~12）。实测截图判定「切换像界面错位」。
  //
  // 现在的不变式：**外壳不带任何 padding**，内缩只由面板自己带，且都是 px-4。
  // 谁再想按面板切外壳 padding，这三条会红。

  const src = stripAll(read(editorPage));

  // ① 外壳不许再有 padding：内联 style 里没有、类名里也没有 py-6 之类的上下内缩。
  const sidebarTag = src.slice(
    src.indexOf('class="sidebar'),
    src.indexOf('>', src.indexOf('class="sidebar')) + 1
  );
  assert.ok(
    sidebarTag.length > 100 && sidebarTag.includes('w-80'),
    '侧栏根节点没找到或结构变了 —— 先更新本守卫再改模板'
  );
  assert.equal(
    /\bp-[xytrbl]?-\d|\bpx-\d|\bpy-\d/.test(sidebarTag),
    false,
    '侧栏外壳不许带任何 padding 工具类 —— 外壳一有 padding，切换时整列内容就会位移'
  );
  assert.equal(
    /padding:/.test(sidebarTag),
    false,
    '侧栏外壳的 :style 里也不许再有 padding（内联 style 同样会让外壳随面板变宽度）'
  );
  assert.equal(
    src.includes('sidebarPadding'),
    false,
    'sidebarPadding computed 已删除：外壳 padding 不再随 state.sidebarPanel 变化'
  );
  assert.equal(
    /padding:\s*['"]?\d/.test(src),
    false,
    '别把「侧栏外壳 padding」换个写法加回来 —— 它就是切换偏移的来源'
  );

  // ② 分段控件那一行本身按 16px 起 —— 它是这一列的标尺，下面所有块都得跟它对齐。
  assert.match(
    src,
    /class="border-b border-gray-100 px-4 py-2\.5 dark:border-gray-700"/,
    '切面板那行必须自带 px-4：外壳没有 padding 了，行自己不帶就会贴到边上'
  );
});

test('T-187：助手面板这一列的左边缘必须处处 16px（header/流/表单/确认卡/模板菜单）', () => {
  // 用户报的第二个症状：「组件和组件之间的留白不够完善」。
  // 实测是左边缘有 8 / 12 / 8 / 12 / 8 五个不同的值，竖着看参差不齐。
  // 钉住参与者的类串 —— 哪一个改回 px-2 就变红。
  const panel = stripAll(
    read('src/components/newtab/workflow/agent/AgentPanel.vue')
  );
  const transcript = stripAll(
    read('src/components/newtab/workflow/agent/AgentTranscript.vue')
  );
  const list = stripAll(
    read('src/components/newtab/workflow/agent/AgentSessionList.vue')
  );

  // 两个 header（宽宿主左栏 + 右栏）必须**同高**，否则两栏的 border-b 不在
  // 一条水平线上，错位一眼可见。
  //
  // T-213：右栏 header 拆成两行（行 1：会话/标题/新建；行 2：标签页
  // chip），总高 82px（2026-10-10「太挤」反馈后从 74px 放松：行 1 py-1.5
  // + 标题钮 py-2）。左栏没有第二行的东西可放（它就是「历史会话」四个字），
  // 所以用 min-h-[82px] 把高度对齐 —— 这条不变量从「同样的类串」变成了
  // 「同样的高度」，判据跟着换。
  assert.match(
    panel,
    /min-h-\[82px\][^>]*\bborder-b\b|\bborder-b\b[^>]*min-h-\[82px\]/,
    '左栏 header 要用 min-h-[82px] 对齐右栏两行 header 的总高'
  );

  // 左边缘仍统一 px-4（T-187 的不变量没变，只是容器变了）。
  const px4Count = (panel.match(/class="[^"]*\bpx-4\b[^"]*"/g) || []).length;
  assert.ok(
    px4Count >= 3,
    `header / transcript / form 几处都要 px-4，实际只有 ${px4Count} 处`
  );

  for (const [name, needle, why] of [
    [
      panel,
      'data-test="not-configured-guide"',
      '「未配置 Key」是整页引导，它要占满这一列（T-207 后不再是横幅）',
    ],
    [panel, 'class="mx-4 mb-3"', '确认卡'],
    // T-207：composer 表单加了 `relative`（为了挂顶部渐隐层）。针脚是
    // 完整类串，加一个布局类就会变红 —— 但这里保留精确匹配，因为
    // 「composer 的左边缘与 py 值」是 T-187 当初要钉死的东西，允许它
    // 悄悄漂移反而失去意义。改类串时必须同步改这一行，是刻意的摩擦。
    [panel, 'class="relative shrink-0 px-4 pb-2.5 pt-0"', 'composer 表单'],
    [transcript, 'overflow-y-auto px-4 py-3', 'transcript 滚动容器'],
    [
      list,
      '<div v-if="mode === \'view\'" class="px-4 pb-2">',
      '会话列表的搜索框',
    ],
  ]) {
    assert.ok(
      name.includes(needle),
      `${why}的横向内缩必须是 16px（px-4），实际没找到：${needle}`
    );
  }

  // 反向自检：mx-4 与 px-4 必须真的存在，否则上面那条 needle 匹配到的是别的东西。
  assert.ok(
    panel.includes('mx-4') && transcript.includes('px-4'),
    'px-4 / mx-4 在助手面板里必须真实存在 —— 上面几条 needle 若匹配到巧合，这道是兜底'
  );
});

test('T-180/T-183：侧栏那行 tab 与面板键两种语言都得齐', () => {
  for (const lang of ['zh', 'en']) {
    const { agent } = JSON.parse(
      read(`src/locales/${lang}/newtab.json`)
    ).workflow;

    for (const key of ['tab', 'sidebarBlocks']) {
      assert.equal(
        typeof agent[key],
        'string',
        `${lang} 缺 workflow.agent.${key}`
      );
    }
  }
});

test('T-182：助手入口的图标不许再与画布上的自动布局撞车', () => {
  const src = stripAll(read(editorPage));

  // 自动布局按钮保留魔法棒（那是它的本名），助手让开。
  // 同屏两个一模一样的小魔法棒，用户分不出点的是哪个。
  assert.equal(
    (src.match(/riMagicLine/g) || []).length,
    1,
    'riMagicLine 只能留给画布上的自动布局按钮 —— 助手入口已改用别的图标（T-182）'
  );
  assert.match(
    src,
    /id: 'agent'[\s\S]*?icon: 'riChat3Line'/,
    '助手 tab 用 riChat3Line（对话框），语义上比魔法棒准'
  );

  // T-186：魔法棒从此专属画布自动布局。设置页与列表页的「AI 助手」入口
  // 同样用对话气泡 —— 三处 AI 入口统一，「魔法棒 = AI」的旧约定退役。
  for (const f of [
    'src/newtab/pages/Settings.vue',
    'src/newtab/pages/Workflows.vue',
  ]) {
    const page = stripAll(read(f));
    assert.ok(
      page.includes('riChat3Line'),
      `${f} 的助手入口要用 riChat3Line（三处 AI 入口统一气泡，T-186）`
    );
    assert.doesNotMatch(
      page,
      /riMagicLine/,
      `${f} 里不许再出现 riMagicLine —— 它只属于画布自动布局（T-186）`
    );
  }
});

// T-195~T-198 的「三件套只能经 syncTarget 写入 + 六条入口」守卫已随 T-227 行为化：
// agentHost.test.js 直接驱动真工厂断言（固定页被关只标状态不换页 / 自动态导航
// 重解析并回写 runtime / newSession 回自动态），源码正则守卫退役。
// T-196/T-197 的 openSession 契约守卫仍在下方。

test('T-196/T-197 守卫：runtime.openSession 必须回 pinned 与 state 两个字段', () => {
  const src = read('src/agent/index.js').replace(/\/\*[\s\S]*?\*\//g, '');

  // openSession 的两个 return 都要带齐 targetPinned / targetState，否则
  // 面板侧解构出 undefined，退回「沿用旧值」的老问题。
  const pinReturns = src.match(/targetPinned:\s*restored\.pinned/g) || [];
  assert.ok(pinReturns.length >= 1, 'openSession 必须回 targetPinned');
  assert.match(
    src,
    /targetState:\s*restored\.state/,
    'openSession 必须回 targetState'
  );
  // T-224 起 restoredTarget 的调用收进了账本（targetPage.js）——
  // 守卫跟着搬：判定必须仍走那个有单测的纯函数，只是位置变了。
  const ledgerSrc = read('src/agent/targetPage.js');
  assert.match(
    ledgerSrc,
    /restoredTarget\(pin,\s*liveTab\)/,
    'restoreTarget 必须走 restoredTarget 纯函数判定（有单测）'
  );
});

// —— T-200：从参考实现 sidepanel 借鉴的四条（圆角语义名 / 两段式停止 / 富文本复制）——

test('T-200：面板圆角一律走 chip / control / card 语义名，不许回到刻度值', () => {
  const dir = join(ROOT, 'src/components/newtab/workflow/agent');
  const bad = [];

  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.vue')) continue;
    const src = stripComments(readFileSync(join(dir, f), 'utf8'));

    // sm / full 是两处特例，不在语义档的管辖内：
    //   rounded-sm  = favicon 那种 4px 小方角（不是"控件"，是图片裁切）
    //   rounded-full = 「回到底部」那种胶囊按钮
    for (const m of src.matchAll(/\brounded-(lg|md|xl|2xl|3xl)\b/g)) {
      bad.push(`${f}: rounded-${m[1]}`);
    }
  }

  assert.deepEqual(
    bad,
    [],
    '这些圆角用的是刻度名。语义名（chip=小贴块 / control=可点小卡 / card=整块容器）' +
      '是为了让「该用哪个」有名字可依据 —— 退回刻度名就又要靠手感选了。' +
      '若确实是不在上述三档内的特例，请显式说明理由并使用 rounded-sm / rounded-full。'
  );

  // 三档必须真的定义在 config 里 —— 写了语义名但没定义，Tailwind 会静默不产出，
  // 结果是元素变成直角（和 T-171 同一类「静默失效」）。
  const cfg = read('tailwind.config.js');
  for (const key of ['chip', 'control', 'card']) {
    assert.match(
      cfg,
      new RegExp(`${key}:\\s*'\\d+px'`),
      `tailwind.config.js 里没有定义 borderRadius.${key} —— 语义名会静默失效`
    );
  }
});

test('T-200：动效走统一曲线与时长 token，且 token 不是死定义', () => {
  const cfg = read('tailwind.config.js');
  const css = read('src/assets/css/tailwind.css');

  // ① 两个 token 都要定义
  assert.match(cfg, /panel:\s*'var\(--ease-panel/, '缺 ease-panel');
  for (const d of ['fast', 'base', 'slow']) {
    assert.match(
      cfg,
      new RegExp(`${d}:\\s*'var\\(--dur-${d}`),
      `缺 duration-${d}`
    );
  }
  assert.match(css, /--ease-panel:\s*cubic-bezier/, 'CSS 变量缺 --ease-panel');

  // ② 定义了必须有人用。Tailwind 只为**用到**的类产出 CSS，
  //    所以「token 存在但没人用」的表现不是报错，是**静默地什么都没发生**——
  //    与 T-171 同一类失效，没有运行时信号，只能在这儿钉。
  const dir = join(ROOT, 'src/components/newtab/workflow/agent');
  const users = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.vue')) continue;
    const src = stripComments(readFileSync(join(dir, f), 'utf8'));
    if (/duration-(fast|base|slow)/.test(src)) users.push(f);
  }
  assert.ok(
    users.length > 0,
    '面板里没有任何一处用 duration-fast/base/slow —— token 定义了却没落地，' +
      'Tailwind 不会为它产出 CSS，等于没做'
  );

  // ③ 系统级「减少动态效果」兜底必须在，且不能把加载转圈一起压掉
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)/,
    '缺 prefers-reduced-motion 兜底 —— 开了这个偏好的用户不该被界面追着动'
  );
  const block = css.slice(css.indexOf('prefers-reduced-motion'));
  assert.match(
    block,
    /animation-duration:\s*0\.01ms/,
    '压到 0.01ms 而不是 0 —— 0 会让 transitionend 不触发，依赖它收尾的逻辑会卡住'
  );
  assert.match(
    block,
    /\.animate-spin[\s\S]{0,160}?animation-iteration-count:\s*infinite/,
    '加载转圈是「还在跑」的唯一指示，一并压掉用户会以为界面卡死 —— 它要单独放回来'
  );
});

test('T-200：停止是两段式 —— 首触只 armed，窗口内二次才真的 abort', () => {
  const panel = stripComments(
    read('src/components/newtab/workflow/agent/AgentPanel.vue')
  );

  // ① 按钮走 requestStop，不许再直连 host.abort（直连 = 一段式）
  assert.match(panel, /@click="requestStop"/, '停止按钮必须走 requestStop');
  assert.doesNotMatch(
    panel,
    /@click="host\.abort\(\)"/,
    '停止按钮不许直连 host.abort —— 忙碌时它就在手指下面，一次点击就杀太便宜'
  );

  // ② 首触 armed 后必须 return，不能顺手把任务也杀了
  const fnAt = panel.indexOf('function requestStop()');
  assert.ok(fnAt > 0, 'requestStop 不见了，两段式保护等于没有');
  const body = panel.slice(fnAt, panel.indexOf('\n}', fnAt));
  assert.match(body, /stopArmed\.value = true/, '首触要置 armed');
  assert.match(body, /host\.abort\(\)/, 'armed 之后的第二次要真的 abort');
  assert.match(
    body,
    /stopArmed\.value\s*\)[\s\S]{0,80}?return;|return;[\s\S]{0,80}?host\.abort/,
    '首触分支必须 return（置完 armed 就退出，不 abort）'
  );

  // ③ armed 会过期：不自动解除的话按钮停在「看起来已确认过」的假状态
  assert.match(
    body,
    /setTimeout\(/,
    'armed 必须带超时自动解除 —— 过期不解除，按钮就成了假的已确认态'
  );

  // ④ 两个解除点：busy 结束（否则下一次忙碌直接开局 armed）与面板卸载
  assert.match(
    panel,
    /watch\(\s*\(\)\s*=>\s*props\.host\.busy/,
    'busy 结束时必须解除 armed —— 留着的话下一次忙碌会跳过第一段保护'
  );
  const unmountAt = panel.indexOf('onBeforeUnmount(() => {');
  assert.ok(unmountAt > 0, 'onBeforeUnmount 不见了');
  assert.match(
    panel.slice(unmountAt, unmountAt + 400),
    /disarmStop\(\)/,
    '卸载时必须清掉 armed 的 timer —— 它挂的是 setTimeout，不摘会对已卸载组件写 ref'
  );

  // ⑤ 文案键少一边就显示裸键名
  for (const lang of ['zh', 'en']) {
    const { agent } = JSON.parse(
      read(`src/locales/${lang}/newtab.json`)
    ).workflow;

    assert.equal(
      typeof agent.stopArmed,
      'string',
      `${lang}/newtab.json 缺 workflow.agent.stopArmed`
    );
  }
});

test('T-200：整条复制走双通道（text/html 富文本 + text/plain 原文）', () => {
  const md = stripComments(
    read('src/components/newtab/workflow/agent/AgentMarkdown.vue')
  );

  // ① 富文本通道：助手常产出表格与列表，纯文本粘到 Word/Notion 结构全散
  assert.match(md, /ClipboardItem/, '要走 ClipboardItem 才能一次写两个通道');
  assert.match(md, /'text\/html'/, '缺 text/html 通道');
  assert.match(
    md,
    /'text\/plain'/,
    '缺 text/plain 通道 —— 只写 html 的话粘到纯文本编辑器会变成空'
  );

  // ② plain 通道给的是 markdown 原文（T-16 的语义不许丢）：粘回聊天框/编辑器
  //    时保留标记比保留渲染结果有用。
  assert.match(
    md,
    /new Blob\(\[text\]/,
    'text/plain 必须是 props.raw 原文，不能换成渲染文本'
  );

  // ③ 克隆里要摘掉复制按钮 —— 它是 absolute 浮在首行上的，不摘会把
  //    「复制全文」四个字一起复制走
  assert.match(
    md,
    /querySelectorAll\('button'\)/,
    '取 innerHTML 前要克隆并摘掉按钮，否则按钮文字会被复制进去'
  );

  // ④ 降级：没有 ClipboardItem 时退回纯文本 —— 富文本是增强，不是依赖
  assert.match(
    md,
    /writeText\(text\)/,
    '没有 ClipboardItem 的环境（非安全上下文）必须退回纯文本复制'
  );

  // ⑤ 按钮调用点没变（T-16 的守卫钉的是这个形状）
  assert.match(md, /@click="copy\(props\.raw\)"/, '复制入口的形状不能变');
});

test('T-208：三层底色 token 必须在 tailwind.css 里成对定义（亮/暗各一套）', () => {
  const css = stripComments(read('src/assets/css/tailwind.css'));

  // ① 四个变量都要出现。它们是 RGB 三元组（`250 250 250` 这种），
  //    配合 tailwind.config.js 的 withOpacityValue 才能让 bg-canvas/80
  //    这类透明度写法仍然可用 —— 若有人改成 hex，透明度写法会静默失效。
  for (const v of [
    '--color-canvas',
    '--color-surface',
    '--color-field',
    '--color-line',
  ]) {
    const hits = css.match(new RegExp(v.replace(/-/g, '\\-') + ':', 'g')) || [];
    assert.equal(
      hits.length,
      2,
      `${v} 要在 :root 与 .dark 各定义一次，实际 ${hits.length} 次`
    );
  }

  // ② 值必须是空格分隔的 RGB 三元组（三条数字），不能是 hex —— hex 之下
  //    `bg-canvas/80` 不产出 CSS，是 T-171 那类静默失效。
  const triplets =
    css.match(/--color-(?:canvas|surface|field|line):\s*[^;]+;/g) || [];
  assert.equal(triplets.length, 8, '四个变量 × 亮暗两套 = 8 条定义');
  for (const decl of triplets) {
    assert.match(
      decl,
      /:\s*\d{1,3} \d{1,3} \d{1,3};/,
      `${decl} 必须是 "R G B" 三元组（供 withOpacityValue 用），不能是 hex/其它形式`
    );
  }
});

test('T-230：面板 canvas 底色必须与项目页面底色（gray-50 / dark:gray-900）同值', async (t) => {
  // 「面板底色和项目底色有差别」就是这么漂出来的：T-208 把 canvas 锚在参考
  // 实现 pie 上（亮 #FAFBFC / 暗 #0B0D10），而项目页面底走
  // `bg-gray-50 dark:bg-gray-900`（gray 别名 = zinc，#FAFAFA / #18181B）——
  // 两套灰互不相干，暗色下面板比整个应用明显更黑。这条守卫把整条链钉死：
  // 别名仍是 zinc → App 根仍是 gray-50/900 → canvas 与 zinc-50/900 同值。
  // 动其中任何一环，这里必须红，并顺手把 tailwind.css 的四档底色一起对齐
  // （surface/field/line 是面板内部的分层档，不钉值，允许后续单独调）。
  const { default: colors } = await import('tailwindcss/colors');

  const triplet = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return `${Math.floor(n / 65536) % 256} ${Math.floor(n / 256) % 256} ${
      n % 256
    }`;
  };

  // ① 取值源头没被动过：gray 仍指向 zinc（项目底色的「灰」就是它）。
  const configSrc = read('tailwind.config.js');
  assert.match(
    configSrc,
    /gray:\s*colors\.zinc/,
    'tailwind.config.js 的 gray 别名不再是 colors.zinc —— 项目底色的取值源头' +
      '变了，tailwind.css 的四档面板底色（canvas/surface/field/line）要跟着重新对齐'
  );

  // ② 项目底色的锚点还在：App 根布局仍是 bg-gray-50 dark:bg-gray-900。
  //    若底色定义挪了地方，把这里和 tailwind.css 的 canvas 一起搬到新锚点。
  const app = stripComments(read('src/newtab/App.vue'));
  assert.match(
    app,
    /@apply bg-gray-50 dark:bg-gray-900/,
    'App 根布局的 @apply bg-gray-50 dark:bg-gray-900 不在了 —— 项目页面底色' +
      '换定义了，tailwind.css 的 canvas（亮/暗两处）要与新的页面底色重新对齐'
  );

  // ③ canvas 与 zinc-50 / zinc-900 同值（亮暗各一处，:root 在前、.dark 在后）。
  const css = stripComments(read('src/assets/css/tailwind.css'));
  const canvasValues = [
    ...css.matchAll(/--color-canvas:\s*(\d+ \d+ \d+)\s*;/g),
  ].map((m) => m[1]);
  assert.equal(canvasValues.length, 2, 'canvas 要在 :root 与 .dark 各定义一次');
  assert.equal(
    canvasValues[0],
    triplet(colors.zinc[50]),
    `亮色 canvas (${canvasValues[0]}) 必须等于 gray-50 (${triplet(
      colors.zinc[50]
    )}) —— 面板底色要与项目页面底色统一（T-230）`
  );
  assert.equal(
    canvasValues[1],
    triplet(colors.zinc[900]),
    `暗色 canvas (${canvasValues[1]}) 必须等于 gray-900 (${triplet(
      colors.zinc[900]
    )}) —— 面板底色要与项目页面底色统一（T-230）`
  );

  // ④ 产物层：页面底色的 zinc 值要真的编译进 newtab.css。源码对齐 ≠ 产物
  //    对齐（T-171 家族的教训）；build 缺席时跳过，跑一次 npm run build 再来。
  const builtCss = join(ROOT, 'build/newtab.css');
  if (!existsSync(builtCss)) {
    t.skip('build/newtab.css 不存在，先跑一次 npm run build');
    return;
  }
  const cssOut = readFileSync(builtCss, 'utf8');
  for (const rgb of ['rgb(250 250 250', 'rgb(24 24 27']) {
    assert.ok(
      cssOut.includes(rgb),
      `构建 CSS 里找不到 ${rgb} —— 页面底色（gray-50/900）在产物里与 zinc 不符`
    );
  }
});

test('T-208：面板底壳必须换上三层底色，且不再靠 gray 边框分层', () => {
  const panel = stripComments(readFileSync(panelPath, 'utf8'));

  // ① 面板根统一吃 canvas。T-213 撤掉了 T-212 的「按宿主壳色切透明」——
  //    面板根不再读 host.shell，也不再透父级，自己画 bg-canvas。
  //    暗色由 :root.dark 接管，与宿主无关。回归迹象：写死 bg-shell，
  //    或又冒出第二个底色档把家族劈开。
  assert.match(
    panel,
    /\bbg-canvas\b/,
    '面板根节点必须带 bg-canvas（T-213 起统一，不再按宿主壳色切透明）'
  );
  assert.doesNotMatch(
    panel,
    /\bbg-shell\b/,
    '面板根不该再用 bg-shell（T-213 已删掉 shell 色阶）'
  );

  // ② 顶栏降到 canvas（T-213）。
  //    T-208 当初把顶栏抬到 surface，理由是「与正文区分」；但 T-213 又把面板根
  //    收回 canvas，于是 header(surface) 与 composer(field) 夹着正文(canvas)，
  //    顶底两头重、中间轻，层次反而读不出来。参考实现 pie 的 TopBar 就是
  //    bg-canvas + border-b —— header 是"容器的一部分"，靠一条 border-b 与
  //    正文分开，不靠抬升一档底色。
  //    这里钉的是「header 用 canvas 且带 border-b」：左栏会话头 + 右栏对话头。
  const canvasHeaders = (
    panel.match(/class="(?=[^"]*\bbg-canvas\b)(?=[^"]*\bborder-b\b)[^"]*"/g) ||
    []
  ).length;
  assert.ok(
    canvasHeaders >= 2,
    `左/右两处顶栏都要挂 bg-canvas + border-b，实际 ${canvasHeaders} 处`
  );
  // 反向：不该再有「surface + border-b」的顶栏（那是 T-213 之前的形态）
  const surfaceHeaders = (
    panel.match(/class="(?=[^"]*\bbg-surface\b)(?=[^"]*\bborder-b\b)[^"]*"/g) ||
    []
  ).length;
  assert.equal(
    surfaceHeaders,
    0,
    `顶栏不该再抬到 surface（T-213 已降回 canvas），实际 ${surfaceHeaders} 处`
  );

  // ③ 分隔线走 line，不再用 gray —— 三层底色 + 一根 line，才有派的分层感。
  //    这里只钉「根/顶栏/输入卡」这几个关键面，不遍历全文件：逐条锁死 class 串
  //    会把有意迁移也判成回归（T-208 就是一次有意迁移）。
  assert.match(panel, /border-r border-line/, '左栏右分隔线要走 border-line');
  assert.match(panel, /border-b border-line/, '顶栏下分隔线要走 border-line');

  // ④ 输入卡（composer）是**凹陷的场**（T-213 反向）。
  //    T-209/T-212 走「浮起」（surface 无边框）；T-213 改回凹陷：卡片 bg-field +
  //    border-line，输入区透明 —— 「输入区」不再是另一个矩形，而是凹陷面里的
  //    一块空处。这正是参考实现 pie 的 Composer 形态。
  assert.match(
    panel,
    /rounded-card border border-line bg-field/,
    'composer 卡要靠 bg-field + border-line 呈现凹陷面（T-213 反向）'
  );
  assert.doesNotMatch(
    panel,
    /rounded-card bg-surface(?:\s|\b)/,
    'composer 卡不该再是 bg-surface 浮起（T-213 已改成凹陷）'
  );
});

test('T-209：三层底色要贯彻到卡片与输入区，不许再散落 gray/white 面', () => {
  const read2 = (p) => stripComments(read(p));
  const agentFile = (f) => read2(`src/components/newtab/workflow/agent/${f}`);

  // ① composer 的输入区**透明**，凹陷由卡片整体提供 —— T-213 反向。
  //
  //    经历了一次完整的往返，值得写清为什么最后落在透明：
  //      T-209：卡片 surface（浮），输入区 !bg-field（凹）→ 白卡里挖一块灰
  //      T-213：卡片 bg-field（凹），输入区 !bg-transparent
  //    前者的观感是「两层实心矩形嵌套，视觉重量全压在底部」；后者是
  //    「一个凹进去的面，输入区是它里面的一块空处」。参考实现 pie 的 Composer
  //    是 `rounded-card border bg-field` + **透明** textarea，取的正是后一种。
  //    所以这里钉 `!bg-transparent`，并且反向钉住 `!bg-field` 不该再出现 ——
  //    两者同时存在就是「同一个面画了两次」，分层反而消失。
  const panel = readFileSync(panelPath, 'utf8');
  const ta = panel.match(/<ui-textarea[\s\S]*?\/>/);
  assert.ok(ta, '面板里应有 <ui-textarea>，找不到说明结构变了，守卫要重写');
  const taCls = (ta[0].match(/class="([^"]*)"/) || [])[1] || '';
  assert.match(
    taCls,
    /!bg-transparent/,
    'composer 输入区必须 !bg-transparent —— 凹陷由卡片的 bg-field 提供，' +
      '输入区再铺一层 field 等于同一个面画两次'
  );
  assert.doesNotMatch(
    taCls,
    /!bg-field/,
    'composer 输入区不该又是 !bg-field（那是 T-209 的旧形态，T-213 已反向）'
  );
  // 全局那条 `textarea:focus { ring-2 ring-accent }` 会与卡片的
  // focus-within 描边叠成两道线，所以 textarea 自己要把 ring 关掉。
  assert.match(
    taCls,
    /focus:!ring-0/,
    'textarea 自身要 focus:!ring-0 —— 否则与卡片的 focus-within 描边叠两道'
  );

  // ② 正文区里的卡片要落在 canvas/surface/field 家族里，不许再散落旧 gray 面。
  //    只钉「卡片的外壳 class」这一类，不遍历全文件的每个 className —— 逐条锁死
  //    会把有意迁移也判成回归（T-208/T-209 都是有意迁移）。
  //    thinking 卡 = surface（浮起）、compaction 卡 = field（凹陷），这是 T-154 的
  //    「两张卡必须在不同的面上」那条不变量在 token 时代的落点。
  const transcript = agentFile('AgentTranscript.vue');
  assert.match(
    transcript,
    /rounded-control border border-line bg-surface/,
    'thinking 卡要是 border-line + bg-surface 的浮起面'
  );
  assert.match(
    transcript,
    /rounded-control border border-dashed border-line bg-field/,
    'compaction 卡要是 border-dashed border-line + bg-field 的凹陷面'
  );

  // ③ 工具卡外壳改用 field —— T-212 观感迭代。
  //    工具卡是**元信息行**，不是独立卡片。三条工具并排时三个带边框的
  //    surface 卡在 canvas 底上像「表单错误列表」；用 field（最暗一档）作为
  //    「这一行和正文不一样」的信号——底色差本身就在分层，不必再画外框。
  //    bg-field 在 canvas 上是「淡灰斑」，三条并排时只是「这里有三条元信息行」，
  //    不再是「三个独立卡片」。
  const tool = agentFile('AgentToolStep.vue');
  assert.match(
    tool,
    /rounded-control bg-field/,
    '工具卡外壳要是 bg-field 凹陷面（不再 border-line + bg-surface）'
  );

  // ④ 工具状态徽标：去底色 + 去边框，只留字色 + 图标。
  //    原形态 `bg-green-500/15 text-green-700 rounded-chip` 配上色块 + 边框
  //    = 三个「完成/失败/完成」胶囊框并排像错误列表。
  //    语义**完全靠字色 + 图标**（绿=成功 / 红=失败 / 琥珀=拒绝 / 灰=进行中），
  //    色块是冗余通道。钉「不写 rounded-chip + 不写 bg-*/15 类」——任一回归
  //    都会让三条工具卡重新变「表单错误列表」。
  assert.doesNotMatch(
    tool,
    /rounded-chip[^"]*bg-(?:green|red|amber|gray)-\d+\/\d+/,
    '工具状态徽标不该用 rounded-chip + 透明底色（语义靠字色 + 图标）'
  );
  assert.match(
    tool,
    /text-green-\d+ dark:text-green-\d+/,
    '工具状态徽标：成功态用绿字'
  );
  assert.match(
    tool,
    /text-red-\d+ dark:text-red-\d+/,
    '工具状态徽标：失败态用红字'
  );

  // ⑤ 下拉菜单（会话/换页/设置等浮层）是 surface，不再 bg-white / dark:bg-gray-800
  const dropdown = agentFile('AgentDropdown.vue');
  assert.match(
    dropdown,
    /rounded-card border border-line bg-surface/,
    '下拉菜单面板要是 border-line + bg-surface'
  );

  // ⑥ markdown 代码块是**凹陷的 field 面**（与正文的 surface/canvas 相对）
  assert.match(
    agentFile('AgentMarkdown.vue'),
    /rounded-control bg-field/,
    '代码块要是 bg-field 的凹陷面'
  );
});

test('T-211：语义文字色 fg-1/2/3 必须在 tailwind.css 成对定义，且面板不再双写 gray', () => {
  const css = stripComments(read('src/assets/css/tailwind.css'));

  // ① 三档变量都要出现，且亮/暗各一次（成对）
  for (const v of ['--color-fg-1', '--color-fg-2', '--color-fg-3']) {
    const hits = css.match(new RegExp(v + ':', 'g')) || [];
    assert.equal(
      hits.length,
      2,
      `${v} 要在 :root 与 .dark 各定义一次，实际 ${hits.length} 次`
    );
  }

  // ② 值必须是 RGB 三元组（配 withOpacityValue 才能用 text-fg-2/70 这类写法）
  const triplets = css.match(/--color-fg-[123]:\s*[^;]+;/g) || [];
  assert.equal(triplets.length, 6, '三档 × 亮暗两套 = 6 条定义');
  for (const decl of triplets) {
    assert.match(
      decl,
      /:\s*\d{1,3} \d{1,3} \d{1,3};/,
      `${decl} 必须是 "R G B" 三元组（供 withOpacityValue 用）`
    );
  }

  // ③ 迁移后不许再有「次要/弱文字靠 text-gray-* + dark:text-gray-* 双写」——
  //    那正是这一步要消灭的（同一件事两处声明，漏一处就在某个主题下看不清）。
  //    只查 agent 目录；红/绿/accent 等语义色不受影响（它们不叫 text-gray-*）。
  const dir = join(ROOT, 'src/components/newtab/workflow/agent');
  const offenders = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.vue')) continue;
    const src = stripComments(
      read(`src/components/newtab/workflow/agent/${f}`)
    );
    // 只统计「文字色」双写：text-gray-N 与 dark:text-gray-M 出现在同一 class 串里。
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      const cls = m[1];
      if (/\btext-gray-\d/.test(cls) && /\bdark:text-gray-\d/.test(cls)) {
        offenders.push(`${f}: ${cls.slice(0, 60)}…`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些 class 串还在用 text-gray-* + dark:text-gray-* 双写次要/弱文字：\n' +
      offenders.join('\n') +
      '\n改用 text-fg-2（次要）/ text-fg-3（弱）—— 单类即可跨主题。'
  );
});

test('T-212/T-213：用户气泡用 accent 而不是蓝、composer 提示搬到顶、壳色机制已退场', () => {
  const panel = stripComments(readFileSync(panelPath, 'utf8'));
  const bubble = stripComments(
    read('src/components/newtab/workflow/agent/AgentUserBubble.vue')
  );
  const css = stripComments(read('src/assets/css/tailwind.css'));
  const agentHost = stripComments(read('src/composable/agentHost.js'));
  const sidepanel = stripComments(read('src/sidepanel/App.vue'));

  // ① 用户气泡 bg-accent/10 —— 不再 bg-blue-500/15。
  //    蓝色透明是「标签/通知」的语义色（错误横幅、未配 Key 提示、上下文将满），
  //    用户自己的提问用它就把"我说了什么"读成"系统提示"。
  //    accent 是项目里的语义色（确认门、配置按钮），用 accent/10 借底色系
  //    的灰蓝淡档，「我发的」与「系统提示」分得开。
  assert.match(
    bubble,
    /bg-accent\/10/,
    '用户气泡必须用 bg-accent/10（语义色淡档）而不是 bg-blue-500/15'
  );
  assert.doesNotMatch(
    bubble,
    /bg-blue-\d+\/\d+/,
    '用户气泡不该再用 bg-blue-* 透明色（那是「标签/通知」语义色）'
  );

  // ② T-213：composer 顶部那条提示行**被删掉了**。
  //    T-212 把它从底行搬到顶部（靠"与按钮视觉重量相当"这个理由）；
  //    T-213 发现它根本不该常驻 —— 那句话只在用户学会之前有用，占着 14px 的
  //    永久高度是浪费。整句并进发送键的 title（hover 才付费）。
  //    这条断言因此**反向**：那个 <p> 不该再存在。
  assert.doesNotMatch(
    panel,
    /data-test="composer-hint"/,
    'composer 顶部不该再有常驻提示行（T-213 已把它并进发送键 title）'
  );
  // 但它不能就这么消失 —— 那句话还得在，只是换了位置。
  // 钉的是「提示仍在 AgentPanel 里被引用」：从常驻行挪进 title 是一次
  // 位置变更，不是删除。少了这条，"顺手删掉"也能全绿。
  assert.match(
    panel,
    /workflow\.agent\.inputHint/,
    '快捷键提示仍要存在于面板里（现在挂在发送键的 title 上）'
  );
  assert.doesNotMatch(
    panel,
    /inputHint[\s\S]{0,200}<\/span>/,
    'composer 底行不该再渲染 inputHint 提示（它并进 title 了，不是同行 span）'
  );

  // ③④⑤⑥ T-213：撤掉 T-212 的「面板壳色」整套机制（host.shell /
  //        bg-shell / --color-shell）。当初引入它是为了让侧栏面板与 chrome
  //        同色、消除白卡浮在深壳上，代价是把底色家族劈成两套。现在统一回
  //        canvas/surface/field 三层，面板根自画 bg-canvas。
  //        这里钉「整套机制已彻底退场」—— 任一处残留都会让底色家族重新分裂。
  assert.doesNotMatch(
    panel,
    /host\.shell/,
    '面板根不该再读 host.shell（T-213 已废弃壳色分档）'
  );
  assert.doesNotMatch(
    agentHost,
    /deps\.shell/,
    'useAgentHost 不该再读 deps.shell（T-213 已废弃壳色分档）'
  );
  assert.doesNotMatch(
    sidepanel,
    /shell:\s*['"]dark['"]/,
    '浏览器侧栏宿主不该再声明 shell: "dark"（T-213 已废弃壳色分档）'
  );
  assert.doesNotMatch(
    sidepanel,
    /bg-shell/,
    '侧栏根容器不该再挂 bg-shell（T-213 统一走 bg-canvas）'
  );
  assert.match(
    sidepanel,
    /bg-canvas/,
    '侧栏根容器要走 bg-canvas，与面板根同色'
  );
  const shellHits =
    css.match(/--color-shell:\s*\d{1,3} \d{1,3} \d{1,3};/g) || [];
  assert.equal(
    shellHits.length,
    0,
    '--color-shell 必须彻底删掉（T-213 撤销了 T-212 的第五个底色），' +
      `实际还剩 ${shellHits.length} 次`
  );

  // ⑦ 工具状态徽标根 class 不再带 rounded-chip —— 钉「容器不带框」这一条
  //    不变量，与 STATUS_STYLE 内的颜色一起构成「徽标退到字色 + 图标」这一形态。
  const tool = stripComments(
    read('src/components/newtab/workflow/agent/AgentToolStep.vue')
  );
  // 找 statusTextClass 应用的那个 span，class 串里不该有 rounded-chip
  const badgeMatch = tool.match(
    /<span[^>]*class="[^"]*"[^>]*:class="statusTextClass"[^>]*>/
  );
  assert.ok(badgeMatch, '工具徽标 span 应存在（class 含 statusTextClass）');
  assert.doesNotMatch(
    badgeMatch[0],
    /rounded-chip/,
    '工具徽标不该再是 rounded-chip（去框退到字色 + 图标）'
  );
});
