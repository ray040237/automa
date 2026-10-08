/**
 * 窄侧栏表格横滑提示守卫（T-156）。
 *
 * 问题形态：markdown 表格容器是 `overflow-x-auto`，但编辑器侧栏只有 320px，
 * 表格常横向溢出，界面上却没有任何「可以横滑」的提示 —— 用户以为内容被截断。
 *
 * 这条守卫钉三件事：
 *   ① 表格渲染已收进独立的 AgentTable.vue，由它负责溢出提示
 *      （原来那块内联 table 既不看溢出、也不提示，且多表格会互相干扰）；
 *   ② 提示**只在确有溢出时出现**、滚到末列后渐隐 —— 不是常驻遮罩
 *      （常驻会让本就装得下的小表格也挂一条渐变，很吵）；
 *   ③ 提示文案走 i18n（tableScrollHint 两语齐备），且用到的渐变类真的产出了 CSS。
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

const strip = (src) =>
  src
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

const localeOf = (lang) =>
  JSON.parse(read(`src/locales/${lang}/newtab.json`)).workflow.agent;

// —— ① 表格渲染已委托给 AgentTable，且不再内联 overflow-x-auto 的裸表格 ——
test('T-156：AgentMarkdown 把表格交给 AgentTable，且自身不再内联可横滑表格', () => {
  const src = strip(read(`${AGENT}/AgentMarkdown.vue`));

  assert.ok(
    /import AgentTable from '\.\/AgentTable\.vue'/.test(src),
    'AgentMarkdown 必须 import AgentTable'
  );
  assert.ok(
    /<AgentTable[^>]*block="block"/.test(src),
    '模板里要改用 <AgentTable :block="block" /> 渲染表格'
  );
  // 原来那块「v-else-if table + 自己 overflow-x-auto」应已消失：
  // 现在溢出容器在 AgentTable 内部，AgentMarkdown 里不应再出现
  // 「table 分支 + overflow-x-auto」这种内联写法。
  assert.ok(
    !/v-else-if="block\.type === 'table'[\s\S]{0,400}?overflow-x-auto/.test(
      src
    ),
    'AgentMarkdown 不应再内联「table 分支 + overflow-x-auto」—— ' +
      '溢出提示的逻辑要收进 AgentTable'
  );
});

// —— ② 提示条件化：仅溢出时出现，且滚到末列渐隐 ——
test('T-156：AgentTable 的提示只在溢出时出现，且末列后渐隐', () => {
  const src = strip(read(`${AGENT}/AgentTable.vue`));

  // 容器本身是横向滚动的（这是提示存在的前提）
  assert.ok(
    /overflow-x-auto/.test(src),
    'AgentTable 的滚动容器要保留 overflow-x-auto'
  );

  // 渐变遮罩与角标都以 overflowing 为总开关
  assert.ok(
    /v-if="overflowing"/.test(src),
    '提示元素要包在 v-if="overflowing" 下 —— 不溢出就不该出现，' +
      '否则小表格也挂一条渐变，很吵'
  );

  // 角标还要「没到末列」才显示（atEnd 时 Hide）
  assert.ok(
    /v-if="overflowing && !atEnd"/.test(src),
    '角标要 v-if="overflowing && !atEnd" —— 滚到最后一列后还挂个' +
      '「可横滑」是错的'
  );

  // 末列后遮罩渐隐（opacity-0），而不是硬消失或硬留
  assert.ok(
    /:class="\{ 'opacity-0': atEnd \}"/.test(src),
    '遮罩在 atEnd 时要 opacity-0 渐隐，不要把末列压住'
  );

  // 两个提示元素都不能挡滚动
  assert.ok(
    (src.match(/pointer-events-none/g) || []).length >= 2,
    '渐变遮罩与角标都要 pointer-events-none，否则会挡住横向拖拽'
  );
});

// —— ③ 文案两语齐备 ——
test('T-156：tableScrollHint 在 zh 与 en 都在', () => {
  for (const lang of ['zh', 'en']) {
    const a = localeOf(lang);
    assert.equal(
      typeof a.tableScrollHint,
      'string',
      `${lang} 缺 workflow.agent.tableScrollHint`
    );
    assert.ok(
      a.tableScrollHint.length > 0,
      `${lang} 的 tableScrollHint 不能是空串`
    );
  }
});

// —— ④ 用到的渐变类必须真的产出到构建 CSS ——
test('T-156：渐变遮罩相关 class 必须真的存在于构建 CSS', (t) => {
  if (!existsSync(CSS)) {
    t.skip('build/newtab.css 不存在，先跑一次 npm run build');
    return;
  }
  const css = readFileSync(CSS, 'utf8');
  const need = [
    'bg-gradient-to-l',
    'from-gray-200\\/80',
    'bg-gray-700\\/80',
    'text-gray-100',
  ];
  const missing = need.filter((esc) => !css.includes('.' + esc + ' {'));
  assert.deepEqual(
    missing.map((m) => m.replace(/\\/g, '')),
    [],
    '表格滚动提示用到的渐变/底色类没产出到构建 CSS，样式会静默失效。' +
      '这些是本仓此前未在 Agent 面板用过的组合，若 Tailwind 没生成就改用已验证存在的形式。'
  );
  // dark 变体的 from-gray-700/80（Tailwind v3 生成 .dark\:from-gray-700\/80:is(.dark *)）
  const darkOk = css.includes('.dark\\:from-gray-700\\/80');
  assert.ok(
    darkOk,
    'dark 模式下的 from-gray-700/80 没产出，深色侧栏下遮罩会消失'
  );
});
