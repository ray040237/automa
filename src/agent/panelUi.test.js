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

  // ① agent:error 不能再走 notice 通道
  const errorCase = transcript.match(
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
  const transcript = stripComments(
    read('src/components/newtab/workflow/agent/AgentTranscript.vue')
  );
  assert.match(
    transcript,
    /args:\s*ev\.args\s*!==\s*undefined\s*\?\s*ev\.args\s*:\s*target\.args/,
    '合并卡片的逻辑必须保留 TOOL_CALL 带进来的 args（ev.args 缺席时回落 target）'
  );

  // ③ 渲染层：args 非空即渲染参数块
  const step = stripComments(
    read('src/components/newtab/workflow/agent/AgentToolStep.vue')
  );
  assert.match(step, /const prettyArgs = computed/, '工具卡必须有 prettyArgs');
  assert.match(
    step,
    /<pre v-if="prettyArgs"/,
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
