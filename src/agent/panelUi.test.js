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

  // T-166：chip 搬进了 composer 卡片 —— 现在是「表单内、输入框之前」，
  // 而不再是「表单之前的一行」。它仍紧贴输入框（中间只隔 mb-1），
  // 但归属变成了输入区的一部分：目标页是**这条消息的附件**，不是面板上
  // 又一个控件。守卫跟着改判据，否则会把这次改动误判成回归。
  const chipAt = src.indexOf('<agent-tab-picker');
  const formAt = src.indexOf('<form');
  const taAt = src.indexOf('<ui-textarea');
  assert.ok(chipAt > 0, '必须有目标页 chip');
  assert.ok(
    chipAt > formAt && chipAt < taAt,
    '目标页 chip 必须在 form 内、且在输入框之前 —— 它是 composer 的顶行，不是表单外的独立一行'
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
  // T-168：会话 chip 不再是下拉的 trigger，而是「进历史视图」的按钮。
  // 判据跟着改 —— 盯的是「这个可点控件有没有底色」，不是「它是不是 dropdown」。
  const panel = stripComments(readFileSync(panelPath, 'utf8'));
  const chipAt = panel.indexOf('data-test="open-history"');
  assert.ok(chipAt > 0, '会话 chip 必须存在（它是进历史视图的入口）');
  assert.match(
    panel.slice(Math.max(0, chipAt - 400), chipAt),
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

test('T-08 守卫：目标页条要显示失效态，且监听必须成对摘掉', () => {
  // 三件不能省的东西：① chip 渲染 state/pinned 并有失效分支；
  // ② 宿主注册了 tabs.onRemoved/onUpdated；③ 卸载时 removeListener ——
  // 监听挂在 browser 上不是组件上，漏摘就是泄漏（面板反复开关后重复处理）。
  const picker = stripComments(
    read('src/components/newtab/workflow/agent/AgentTabPicker.vue')
  );
  assert.match(picker, /stale/, 'chip 没有失效态分支');
  assert.match(picker, /staleClosed/, 'chip 没有「目标页已关闭」的文案分支');
  assert.match(picker, /staleDrift/, 'chip 没有「目标页已跳转」的文案分支');
  assert.match(picker, /pickTab\.pinned/, 'chip 没有「固定 / 自动」的来源徽标');
  assert.match(picker, /favIconUrl/, 'chip 没有站点图标');

  const host = stripComments(
    readFileSync(join(ROOT, 'src/composable/agentHost.js'), 'utf8')
  );
  for (const ev of ['onRemoved', 'onUpdated']) {
    assert.match(
      host,
      new RegExp(`tabs\\.${ev}\\.addListener`),
      `宿主没有注册 tabs.${ev}`
    );
    assert.match(
      host,
      new RegExp(`tabs\\.${ev}\\.removeListener`),
      `宿主卸载时没有摘掉 tabs.${ev}（挂在 browser 上，漏摘就是泄漏）`
    );
  }
  assert.match(host, /targetHealth/, '宿主没有用 targetHealth 判失效');
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

test('T-11 守卫：busy 时禁用态要给理由，中止要有回执', () => {
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

  // ② 中止回执：宿主必须看 DONE.aborted 并插一条 system-notice
  const host = stripComments(
    readFileSync(join(ROOT, 'src/composable/agentHost.js'), 'utf8')
  );
  assert.match(
    host,
    /AGENT_EVENTS\.DONE\s*&&\s*ev\.aborted/,
    '宿主没有读 DONE.aborted —— 中止后没有任何回执'
  );
  assert.match(
    host,
    /kind:\s*AGENT_EVENTS\.SYSTEM_NOTICE/,
    '中止回执必须走 system-notice 通道（与入队提示同一条）'
  );
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

test('T-67：send 必须在碰 runtime 之前判空，且给出可读提示', () => {
  const hostSrc = read('src/composable/agentHost.js');

  const start = hostSrc.indexOf('async function send(userText)');
  assert.ok(start > 0, 'agentHost 里的 send 找不到了');
  const body = hostSrc.slice(
    start,
    hostSrc.indexOf('\n  async function init(', start)
  );

  const guardAt = body.indexOf('if (!agent.runtime)');
  const firstUse = body.indexOf('agent.runtime.');

  assert.ok(guardAt > 0, 'send 开头必须判 !agent.runtime');
  assert.ok(
    guardAt < firstUse,
    [
      '判空必须排在第一次用 agent.runtime 之前，否则 busy 插话分支仍然是裸调：',
      'guard@' + guardAt + ' firstUse@' + firstUse,
    ].join('\n')
  );
  // 提示语要走 i18n，且说的是「还在初始化」而不是内部形状
  assert.ok(
    body.includes("t('workflow.agent.initializing')"),
    'runtime 未就绪要说清是初始化中，不能把 TypeError 文案漏给用户'
  );
});

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
test('T-66：specific 配置错误用自带文案，其余配置错误仍走 i18n', () => {
  // 错在这里用户看到的是「请先配置 API Key」，而他明明填过密钥、
  // 填的是 ftp:// —— 两句话都指不到真因。
  const hostSrc = read('src/composable/agentHost.js');

  assert.ok(
    hostSrc.includes('useErrMessage'),
    'agentHost 必须区分「有具体文案的配置错误」与「回落到 i18n 的配置错误」'
  );
  assert.ok(
    hostSrc.includes('err.specific && err.message'),
    '具体文案只在 specific 标记下生效，apiKey 空的老路径不能被改掉'
  );
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
  // 送达方向也要有：队列在每步开工处被排空，面板收不到「排空了」事件，
  // 所以必须在事件到达时重新读长度，否则计数只会涨不会落。
  //
  // **必须是位置断言**：只查「文件里出现过 syncPendingInterjections」会被函数
  // 定义本身满足，删掉调用照样绿（变异 4 实测）。所以切到 onEvent 回调体里查。
  const onEventAt = hostSrc.indexOf('onEvent: (ev) => {');
  assert.ok(onEventAt > 0, 'send 里找不到 onEvent 回调');
  const onEventBody = hostSrc.slice(
    onEventAt,
    hostSrc.indexOf('\n      };', onEventAt)
  );
  assert.ok(
    /syncPendingInterjections\(\)/.test(onEventBody),
    'onEvent 里要调 syncPendingInterjections，否则送达后计数不会落（只有函数定义不算）'
  );
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
  const rootAt = src.indexOf('<div class="group relative');
  assert.ok(
    rootAt > 0,
    'markdown 根容器要带 relative group，按钮的 absolute 才有参照、hover 才认整条消息'
  );
  assert.ok(
    src.indexOf('@click="copy(props.raw)"') > rootAt,
    '复制按钮要挂在根容器内部'
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

test('T-164：目标页的解除键只在「用户固定且未失效」时出现', () => {
  // X 挂在 agent-dropdown 的 trigger slot 里，而 slot 在渲染桩里根本不渲染
  // （utils/sfc-render.mjs 的 GLOBAL_STUBS），所以这一条只能靠源码守卫 ——
  // 与同文件其它静态守卫同一档，不是偷懒。
  const picker = read(
    'src/components/newtab/workflow/agent/AgentTabPicker.vue'
  );
  const panel = read('src/components/newtab/workflow/agent/AgentPanel.vue');

  assert.match(
    picker,
    /v-if="showUnpin"/,
    '解除键要由 showUnpin 控制 —— 不能无条件渲染（自动态没有可解除的东西）'
  );
  assert.match(
    picker,
    /showUnpin = computed\([\s\S]{0,80}?props\.pinned && !stale/,
    'showUnpin 必须是 pinned && !stale：失效态该做的是重选，不是解除'
  );
  assert.match(
    picker,
    /@click\.stop/,
    '点解除必须 stopPropagation —— dropdown 靠父 div 的 @click 开合，不拦会顺手把列表也打开'
  );
  assert.match(
    picker,
    /data-test="unpin-target"/,
    '解除键要有 data-test —— 后续补交互测试（test:dom）时靠它定位'
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
  }
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
  assert.match(
    panel,
    /data-test="open-history"/,
    '窄宿主的「进历史」chip 要留着 —— 它那条路还没被左栏取代'
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

  // ④ 宽宿主的正文区永远是对话：chip 不出现、composer 不隐藏
  assert.match(
    panel,
    /!wide && view === 'chat'/,
    '「进历史」chip 只在窄宿主出现 —— 宽宿主点它等于跳到一个已经显示在屏幕上的列表'
  );
  assert.match(
    panel,
    /inHistory = computed\([\s\S]{0,80}?!wide\.value/,
    'inHistory 必须在宽宿主恒为 false —— 正文区永远是对话，composer 永远在'
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
  const MUST_OVERRIDE = [
    ['px-4', '!px-1'],
    ['py-2', '!py-1'],
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

  // 输入框必须 flush：UiTextarea 根节点自带 rounded-lg，不中和掉就会在 composer
  // 卡片里又套一层圆角框 —— 与设计稿「一条边框包住整个输入区」冲突，且正是 T-171
  // 同型的「边框里又有框」（只是这回是圆角不是底色）。与上面 px/py/bg 三项同一手法：
  // 一律带 `!`（T-174 复查时 cssSpecificity 守卫把无 `!` 的 rounded-none 判成冲突）。
  assert.ok(
    cls.includes('!rounded-none'),
    '输入框必须 !rounded-none —— UiTextarea 自带的 rounded-lg 会在 composer 卡片里再裹一层圆角，' +
      '与设计稿「一条边框包住整个输入区」冲突'
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
  assert.ok(
    src.includes('class="shrink-0 p-2 pt-0"'),
    'composer 表单必须 shrink-0 —— 窄宿主下输入框要常驻底部、不能被压没'
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
