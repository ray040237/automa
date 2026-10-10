/**
 * AI 助手设置页的接线守卫（T-217 / T-218）。
 *
 * 本仓没有组件测试基建（backlog T-26/T-53），所以这里退而钉住源码接线：
 * 断言写在源文本上，把这两处修复钉死，回归即红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('T-217 守卫：助手设置页空态引用的 settings.agent.empty 两种语言都得在', () => {
  // 2026-10-10 实测：SettingsAgent.vue:28 引用 settings.agent.empty，但 en/zh
  // newtab.json 的 settings.agent 段都没有这个键 —— 空态渲染成裸 key。
  // check:i18n 只报中英「不一致」，两边同缺不算漂移，所以它拦不住这一条。
  const src = read('src/newtab/pages/settings/SettingsAgent.vue');

  assert.ok(
    src.includes("t('settings.agent.empty')"),
    '空态没有引用 settings.agent.empty（键在 locale 里，但不是死键就是白留）'
  );

  for (const lang of ['zh', 'en']) {
    const locale = JSON.parse(read(`src/locales/${lang}/newtab.json`));
    assert.equal(
      typeof locale.settings.agent.empty,
      'string',
      `${lang}/newtab.json 缺 settings.agent.empty，空态会渲染成裸 key`
    );
    assert.ok(
      locale.settings.agent.empty.trim().length > 0,
      `${lang}/newtab.json 的 settings.agent.empty 是空串`
    );
  }
});

test('T-218 守卫：常规设置页不再重复助手设置入口，goto 死键已清', () => {
  // 2026-10-10：常规页底部还留着「AI 助手 + 打开助手设置」块（T-98 落地侧栏
  // 独立菜单项后残留的过渡入口）。删掉入口后 settings.agent.goto 成了死键，
  // 必须一并从 locale 清掉，否则 check:i18n 报键悬空。这条守卫把「入口不复活」
  // 与「死键不复活」一起钉住。
  const src = read('src/newtab/pages/settings/SettingsIndex.vue');

  assert.ok(
    !src.includes("t('settings.agent.title')"),
    '常规页不该再出现助手设置的区块标题（入口已删除，见 T-218）'
  );
  assert.ok(
    !src.includes("'/agent'"),
    '常规页不该再有跳转到 /agent 的入口按钮（入口已删除，见 T-218）'
  );

  for (const lang of ['zh', 'en']) {
    const locale = JSON.parse(read(`src/locales/${lang}/newtab.json`));
    assert.equal(
      typeof locale.settings.agent.goto,
      'undefined',
      `${lang}/newtab.json 的 settings.agent.goto 应已删除（无引用点即死键）`
    );
    // title 仍被 SettingsAgent.vue:3 引用，不能跟着 goto 一起删
    assert.equal(
      typeof locale.settings.agent.title,
      'string',
      `${lang}/newtab.json 的 settings.agent.title 不能删（SettingsAgent.vue 还在用）`
    );
  }
});
