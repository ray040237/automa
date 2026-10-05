/**
 * 助手面板外壳的接线守卫。
 *
 * 本仓没有组件测试基建（backlog T-26/T-53 已登记），所以这里退而钉住源码接线：
 * 断言写在源文本上，少任何一环下面这些 bug 就会回来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

test('T-61 回归守卫：面板里不得再出现 UiButton 不认识的 variant="text"', () => {
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

test('T-61 守卫：UiButton 对未知 variant 会告警，不静默渲染成无样式', () => {
  const src = stripComments(read('src/components/ui/UiButton.vue'));

  assert.match(src, /unknown variant/, 'UiButton 必须对未知 variant 发出告警');
  assert.match(
    src,
    /variants\[props\.btnType\]/,
    '告警必须基于真实的 variants 表取，而不是写死一份名单（否则表改了守卫会说谎）'
  );
});

test('T-62 回归守卫：面板的滚动容器必须用项目现成的 .scroll 约定', () => {
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

test('布局守卫：会话管理在 header，目标页 chip 在输入区上方', () => {
  const src = stripComments(readFileSync(panelPath, 'utf8'));

  // 方案 C：会话 chip + 新建构成 header（删除收进会话下拉）
  assert.match(
    src,
    /<agent-session-list/,
    '会话列表必须挂在面板上（header 的会话 chip 打开它）'
  );
  // T-90：面板收 host 对象后，入口直调 host 方法（原来断言的是 emit 形状）
  assert.match(src, /host\.newSession\(\)/, '新建会话入口必须保留');
  assert.match(
    src,
    /host\.deleteSession\(id\)/,
    '删除会话入口必须保留，且要把要删的会话 id 传下去'
  );
  // 「⋯」溢出菜单已被用户否掉（为两个功能多加一层菜单，删除还要点两次）。
  // 删除现在是会话下拉里的一行，见下面 session-list 那条守卫。
  assert.doesNotMatch(src, /session\.more/, 'header 不该再有「更多」溢出菜单');
  assert.doesNotMatch(src, /riMore2Fill/, 'header 不该再有「更多」按钮');

  // chip 必须在输入 form 之前 —— 即贴着输入区，而不是漂在面板顶上
  const chipAt = src.indexOf('<agent-tab-picker');
  const formAt = src.indexOf('<form');
  assert.ok(chipAt > 0, '必须有目标页 chip');
  assert.ok(
    chipAt < formAt,
    '目标页 chip 必须排在输入 form 之前（贴着输入区），否则它又变成 header 那一行'
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
  assert.match(
    dd,
    /\btext-gray-\d+/,
    '下拉必须显式给浅色字，否则菜单项会跟着父级继承成「与底色同色」而看不见'
  );
  assert.match(
    dd,
    /\bdark:text-gray-\d+/,
    '下拉必须显式给深色模式的字色（底色是 dark:bg-gray-800）'
  );
});

test('回归守卫：贴在面板底部的 chip 必须向上展开', () => {
  // chip 在输入区顶上，往下展开在矮窗口里会被视口截断。
  const src = stripComments(
    read('src/components/newtab/workflow/agent/AgentTabPicker.vue')
  );
  assert.match(
    src,
    /<agent-dropdown[^>]*side="top"/s,
    '标签页 chip 的下拉必须 side="top"（向上展开）'
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
  // 但「必须存在红色信号」这条不放宽 —— 浅色模式与深色模式各要一个。
  assert.match(
    list,
    /(?:^|\s)hover:text-red-\d+|(?:^|\s)text-red-\d+/,
    '删除是破坏性操作，要有破坏性配色与「切换会话」区分开'
  );
  assert.match(
    list,
    /hover:text-red-\d+/,
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
  const panel = stripComments(readFileSync(panelPath, 'utf8'));
  const chipAt = panel.indexOf('<agent-dropdown');
  const chipEnd = panel.indexOf('</agent-dropdown>');
  assert.ok(chipAt > 0 && chipEnd > chipAt, '会话下拉必须存在');
  assert.match(
    panel.slice(chipAt, chipEnd),
    /bg-box-transparent/,
    '会话 chip 的触发器必须有底色，否则看不出能点'
  );
  assert.match(
    panel,
    /bg-box-transparent[^>]*>[\s\S]{0,600}riAddLine/,
    '新建会话按钮必须有底色'
  );
  assert.match(
    stripComments(
      read('src/components/newtab/workflow/agent/AgentTabPicker.vue')
    ),
    /bg-box-transparent/,
    '标签页 chip 的触发器必须有底色'
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
