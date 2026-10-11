/**
 * 助手「去设置页」入口的接线守卫（T-219 / T-220 / T-221）。
 *
 * 本仓没有组件测试基建（backlog T-26/T-53），退而钉住源码接线：入口的落点
 * 路径、开页方式、主题跟随。这三处任一被改回旧写法都会立刻红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * 去掉注释再断言 —— 否则解释性注释里的 `browser.tabs.create` / `/settings/agent`
 * 会被当成代码命中，把「改坏代码」和「改了注释」混为一谈（同 panelUi.test.js 的教训）。
 */
const stripComments = (src) =>
  src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('T-219 守卫：设置落点是 /agent，不许再出现无效路由 /settings/agent', () => {
  // router.js:120-127 把 /settings 的子路由写成绝对路径 → 真实路由是 /agent；
  // /settings/agent 实测 router.resolve 匹配 0 条 → 落到空白页。
  const host = stripComments(read('src/composable/agentHost.js'));

  assert.match(
    host,
    /routerPush\(\{\s*path:\s*'\/agent'\s*\}\)/,
    'goToAgentSettings 默认落点必须是 /agent（/settings/agent 不是有效路由）；' +
      'T-227 起路由经 ui.routerPush 回调注入，断言随调用形状更新'
  );
  assert.doesNotMatch(
    host,
    /path:\s*'\/settings\/agent'/,
    'agentHost 不许再把 /settings/agent 当落点（无效路由）'
  );

  const side = stripComments(read('src/sidepanel/App.vue'));

  assert.ok(side.includes("'/agent'"), '侧栏设置落点必须是 /agent');
  assert.doesNotMatch(
    side,
    /newtab\.html#\/settings\/agent/,
    '侧栏不许再指向 newtab.html#/settings/agent（无效路由）'
  );
});

test('T-220 守卫：侧栏开设置页走 open:dashboard 通道，不用裸 tabs.create', () => {
  // 裸 tabs.create 在普通窗口开 newtab.html 会被 newtab/App.vue:331-339 删掉。
  const side = stripComments(read('src/sidepanel/App.vue'));

  assert.match(
    side,
    /sendMessage\(\s*'open:dashboard'\s*,\s*'\/agent'\s*,\s*'background'\s*\)/,
    '侧栏必须走 open:dashboard 通道（后台 → BackgroundUtils.openDashboard → popup 窗口）'
  );
  assert.doesNotMatch(
    side,
    /browser\.tabs\.create/,
    '侧栏不许用裸 browser.tabs.create 开 newtab.html（新标签页会被 App.vue 删掉）'
  );
});

test('T-221 守卫：侧栏必须跟随主题（启动链调 useTheme().init()）', () => {
  // 侧栏是独立 HTML 入口，不吃 newtab 的启动链；不调 theme.init() 就恒亮色。
  // T-227 起主题初始化在 useHostBootstrap（启动链收单点）—— 守卫跟着搬：
  // 侧栏必须用 helper，helper 必须真的调 useTheme().init()。
  const side = stripComments(read('src/sidepanel/App.vue'));
  const bootstrap = stripComments(read('src/composable/hostBootstrap.js'));

  assert.match(
    side,
    /useHostBootstrap\(\)/,
    '侧栏必须走 useHostBootstrap 启动链（语言包/主题的顺序知识收单点）'
  );
  assert.match(
    bootstrap,
    /useTheme\(\)\.init\(\)/,
    '启动链必须调 theme.init() 把 <html> 的 dark 类挂上，否则主题恒亮'
  );
});
