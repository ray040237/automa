import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ui 组件 a11y 守卫（T-178）。
 *
 * UiTabs/UiTab 曾把角色写成 `aria-role` —— WAI-ARIA 里没有这个属性
 * （角色走 `role`，`aria-*` 只承载状态/属性），浏览器当未知属性丢弃：
 * 21 个使用点的标签栏对读屏软件都是一排普通按钮，`UiTab` 里写对了的
 * `:aria-selected` 也因角色缺失被忽略。改名后这里钉三件事：
 *  ① 两个组件的角色属性必须是 `role`；
 *  ② `src/components` 全目录 `aria-role` 清零（防错拼在别处再冒头）；
 *  ③ `:aria-selected` 与 roving `:tabIndex` 仍在 —— 它们只在 tab 角色
 *     上才有意义，是「角色改对了」的旁证。
 *
 * 已知欠账（登记票 T-178 建议，单独立项）：aria-controls/tabpanel 的
 * 标签↔面板关联（动 21 个使用点）、Arrow/Home/End 键盘导航（roving
 * tabindex 已在而 Arrow 导航不在，纯键盘用户当前只能落在选中标签上）。
 */

const DIR = dirname(fileURLToPath(import.meta.url));
const COMPONENTS = join(DIR, '../components');

const readComponent = (name) =>
  readFileSync(join(COMPONENTS, 'ui', name), 'utf8');

function walkVueFiles(dir, out = []) {
  readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkVueFiles(p, out);
    else if (/\.vue$/.test(entry.name)) out.push(p);
  });
  return out;
}

test('T-178：UiTabs/UiTab 的角色必须写在 role 属性上', () => {
  const tabs = readComponent('UiTabs.vue');
  const tab = readComponent('UiTab.vue');

  assert.ok(
    /\srole="tablist"/.test(tabs),
    '容器必须是 role="tablist" —— aria-role 是不存在的属性'
  );
  assert.ok(
    /\srole="tab"/.test(tab),
    '标签必须是 role="tab" —— 缺角色时 :aria-selected 无处附着'
  );
  assert.ok(
    !tabs.includes('aria-role') && !tab.includes('aria-role'),
    'aria-role 不得回流 —— 它是浏览器丢弃的未知属性'
  );
});

test('T-178：tab 语义的配套属性仍在（角色改对后它们才真正生效）', () => {
  const tab = readComponent('UiTab.vue');

  assert.ok(
    /:aria-selected=/.test(tab),
    '选中态播报靠 :aria-selected —— 丢了它读屏只知道是 tab 不知道选没选'
  );
  assert.ok(
    /:tabIndex=/.test(tab),
    'roving tabindex 在 —— tab 模式的键盘焦点管理（Arrow 导航是已知欠账）'
  );
});

test('T-178：src/components 全目录不再出现 aria-role', () => {
  const files = walkVueFiles(COMPONENTS);
  assert.ok(files.length > 0, '应至少扫到一个组件文件');

  const offenders = files.filter((f) =>
    readFileSync(f, 'utf8').includes('aria-role')
  );
  assert.deepEqual(
    offenders,
    [],
    `aria-role 是无效属性，出现在: ${offenders.join(', ')}`
  );
});
